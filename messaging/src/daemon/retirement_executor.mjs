// Process observation for endpoint custody: the one daemon module that may
// look at operating-system processes, and only through fixed `ps` probes.
// It never creates a resume request and never signals a process.
//
// Two passes share one liveness rule (owner_process_contract.mjs
// ownerProcessLiveness: same PID and same OS start identity is the same
// process; anything else means the recorded owner is gone):
//
//   - runEndpointRetirementExecutor decides pending retirements. A gone
//     owner makes the endpoint dead behind a terminated retirement, which
//     the resumer may follow with one headless successor. A LIVE owner
//     keeps its session (Joe's rule, 2026-09-29: an interactive session
//     with a live owner process only gets its work enqueued): the
//     retirement is cancelled and the endpoint returns to idle. Earlier
//     revisions sent SIGTERM/SIGKILL here; nothing does now.
//   - runOwnerProcessReconciliation (item 42 B/C) watches idle and busy
//     endpoints whose owner was recorded. When that owner exits without its
//     Stop hook reaching the daemon (a `codex exec` that exits, a closed
//     pane, a crash), a non_interactive endpoint becomes idle — resumable
//     with the runtime's resume command — and an interactive or
//     unknown-mode endpoint becomes dead with `owner_process_exited_at`,
//     the proof that lets the resumer continue it headlessly without ever
//     changing its launch mode.
import { execFileSync, spawnSync } from 'node:child_process';
import { withTransaction } from './db.mjs';
import {
  normalizeStartIdentity,
  ownerProcessLiveness,
  ownerProcessTupleIsComplete,
  ownerProcessTupleIssue,
  sameOwnerProcessTuple,
} from './owner_process_contract.mjs';
import { acquireClaim, releaseClaim, verifyClaimToken } from './ops/claims_shared.mjs';

const TYPE = 'endpoint_retirement';
const RETIREMENT_LEASE_MS = 30_000;

// `ps -o lstart=` is locale-formatted; the hook captured it under the C
// locale (src/cli/hook_identity.mjs), so every observation here does too.
function psEnvironment() {
  return { ...process.env, LC_ALL: 'C', LANG: 'C' };
}

/**
 * One process by PID: `{ pid, startIdentity, processGroupId }`, null when
 * the PID does not exist (or is a zombie), `{ unavailable: true }` when ps
 * itself cannot answer. `pgid`, never `pgrp`: macOS ps rejects `pgrp`.
 */
export function observeRetirementProcess(pid) {
  const result = spawnSync('ps', ['-o', 'pid=', '-o', 'lstart=', '-o', 'pgid=', '-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', env: psEnvironment() });
  if (result.error) return { unavailable: true };
  const raw = String(result.stdout ?? '');
  // Exit 1 with no row is "no such process"; exit 1 complaining about its
  // own arguments is ps failing, which must never read as an exited owner.
  if (result.status === 1 && raw.trim() === '' && !/unknown|invalid|keyword|option|usage/i.test(String(result.stderr ?? ''))) return null;
  if (result.status !== 0) return { unavailable: true };
  const match = /^\s*(\d+)\s+(.+?)\s+(\d+)\s+(\S+)\s*$/.exec(raw);
  if (!match || match[4].startsWith('Z')) return null;
  return { pid: Number(match[1]), startIdentity: normalizeStartIdentity(match[2]), processGroupId: Number(match[3]) };
}

/**
 * Every process in one `ps` call, as Map<pid, { pid, startIdentity }>, or
 * `{ unavailable: true }`. One snapshot per reconciliation pass keeps the
 * cost flat in the number of watched endpoints.
 */
export function snapshotProcesses() {
  let raw;
  try {
    raw = String(execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: psEnvironment(), maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return { unavailable: true };
  }
  const processes = new Map();
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) processes.set(Number(match[1]), { pid: Number(match[1]), startIdentity: normalizeStartIdentity(match[2]) });
  }
  if (processes.size === 0) return { unavailable: true };
  return processes;
}

function defaultProcesses() {
  return { inspect: observeRetirementProcess, snapshot: snapshotProcesses };
}

function current(db, id) {
  const row = db.prepare(
    `SELECT r.*, e.state endpoint_state, e.runtime, e.launch_mode, e.provider_session_id endpoint_provider_session_id,
            e.process_generation endpoint_process_generation, e.owner_epoch endpoint_owner_epoch, e.owner_launch_token endpoint_owner_launch_token,
            e.owner_process_pid endpoint_owner_process_pid, e.owner_process_start_identity endpoint_owner_process_start_identity,
            e.owner_process_group_id endpoint_owner_process_group_id, e.owner_process_capture_source endpoint_owner_process_capture_source,
            e.owner_process_generation endpoint_owner_process_generation,
            l.endpoint_id listener_endpoint_id, l.provider_session_id listener_provider_session_id, l.process_generation listener_process_generation,
            l.listener_generation current_listener_generation, l.state listener_state, l.terminal_reason listener_terminal_reason
       FROM endpoint_retirements r JOIN endpoints e ON e.id=r.endpoint_id JOIN listeners l ON l.id=r.listener_id
      WHERE r.id=? AND r.state='pending' AND r.cause IN ('park_expired', 'provider_admission_timeout')`,
  ).get(id);
  if (!row) return { row: null, reason: 'retirement_not_pending' };
  const endpointOwner = {
    owner_process_pid: row.endpoint_owner_process_pid, owner_process_start_identity: row.endpoint_owner_process_start_identity,
    owner_process_group_id: row.endpoint_owner_process_group_id, owner_process_capture_source: row.endpoint_owner_process_capture_source,
    owner_process_generation: row.endpoint_owner_process_generation,
  };
  const terminalReasonMatchesCause = (row.cause === 'park_expired' && row.listener_terminal_reason === 'park_expired') ||
    (row.cause === 'provider_admission_timeout' && ['acknowledged', 'provider_admission_timeout'].includes(row.listener_terminal_reason));
  const valid = row.endpoint_state === 'retiring' && row.launch_mode !== 'non_interactive' &&
    row.endpoint_process_generation === row.process_generation && row.listener_endpoint_id === row.endpoint_id &&
    row.listener_process_generation === row.process_generation && row.current_listener_generation === row.listener_generation &&
    row.listener_state === 'ended' && terminalReasonMatchesCause &&
    row.endpoint_provider_session_id === row.provider_session_id && row.listener_provider_session_id === row.provider_session_id &&
    row.endpoint_owner_epoch === row.owner_epoch && row.endpoint_owner_launch_token === row.owner_launch_token &&
    ownerProcessTupleIsComplete(row) && sameOwnerProcessTuple(row, endpointOwner) && ownerProcessTupleIssue(row, { runtime: row.runtime, processGeneration: row.process_generation }) === null;
  return { row, reason: valid ? null : 'retirement_fence_changed' };
}

function sameSnapshot(a, b) {
  return ['endpoint_id', 'process_generation', 'listener_id', 'listener_generation', 'provider_session_id', 'owner_epoch', 'owner_launch_token',
    'owner_process_pid', 'owner_process_start_identity', 'owner_process_group_id', 'owner_process_capture_source', 'owner_process_generation']
    .every((key) => a[key] === b[key]);
}

function finish(db, id, token, outcome, now) {
  const claim = verifyClaimToken(db, { resourceType: TYPE, resourceId: id, token, now: new Date(now) });
  if (!claim.alreadyResolved) releaseClaim(db, { row: claim.row, outcome, now: new Date(now) });
}

function close(db, id, token, state, reason, now) {
  db.prepare(`UPDATE endpoint_retirements SET state=?, failure_reason=?, confirmed_exit_at=CASE WHEN ?='terminated' THEN ? ELSE confirmed_exit_at END,
    confirmed_exit_reason=CASE WHEN ?='terminated' THEN ? ELSE confirmed_exit_reason END, updated_at=?, closed_at=? WHERE id=? AND state='pending'`)
    .run(state, state === 'failed' ? reason : null, state, now, state, reason, now, now, id);
  finish(db, id, token, state === 'failed' ? 'failed' : 'completed', now);
}

function finalDead(db, expected, token, reason, now) {
  const checked = current(db, expected.id);
  if (!checked.row || checked.reason || !sameSnapshot(checked.row, expected)) {
    close(db, expected.id, token, 'cancelled', 'retirement_fence_changed', now);
    return false;
  }
  const changed = db.prepare("UPDATE endpoints SET state='dead', updated_at=? WHERE id=? AND state='retiring' AND process_generation=? AND owner_epoch=? AND owner_launch_token IS ?")
    .run(now, expected.endpoint_id, expected.process_generation, expected.owner_epoch, expected.owner_launch_token).changes;
  if (changed !== 1) return false;
  close(db, expected.id, token, 'terminated', reason, now);
  return true;
}

// The owner is alive: the session keeps it. Cancel the retirement and give
// the endpoint back its ordinary idle custody, where routing enqueues work
// for the live owner (and a parked Stop presents it) instead of spawning a
// second process on the same transcript.
function keepLiveOwner(db, expected, token, now) {
  const checked = current(db, expected.id);
  if (!checked.row || checked.reason || !sameSnapshot(checked.row, expected)) {
    close(db, expected.id, token, 'cancelled', 'retirement_fence_changed', now);
    return false;
  }
  const changed = db.prepare("UPDATE endpoints SET state='idle' WHERE id=? AND state='retiring' AND process_generation=? AND owner_epoch=? AND owner_launch_token IS ?")
    .run(expected.endpoint_id, expected.process_generation, expected.owner_epoch, expected.owner_launch_token).changes;
  close(db, expected.id, token, 'cancelled', 'owner_alive', now);
  return changed === 1;
}

function logRetirementDecision(logger, row, decision, extra = {}) {
  logger?.info?.({
    event: 'endpoint_retirement_decided',
    params: { retirement_id: row.id, endpoint_id: row.endpoint_id, cause: row.cause, process_generation: row.process_generation, ...extra },
    result: decision,
    status: 'ok',
  });
}

async function executeOne(context, id, { now, processes, claimFn }) {
  let claim;
  try {
    claim = withTransaction(context.db, () => claimFn(context.db, { resourceType: TYPE, resourceId: id, leaseMs: RETIREMENT_LEASE_MS, now }));
  } catch (error) {
    if (error?.code === 'claim_held') return 'skipped';
    throw error;
  }
  const token = claim.token;
  const decide = (row, state, reason) => withTransaction(context.db, () => close(context.db, row.id, token, state, reason, new Date().toISOString()));
  const check = withTransaction(context.db, () => current(context.db, id));
  if (!check.row) { withTransaction(context.db, () => finish(context.db, id, token, 'completed', now.toISOString())); return 'skipped'; }
  if (check.reason) {
    decide(check.row, 'cancelled', 'retirement_fence_changed');
    logRetirementDecision(context.logger, check.row, 'cancelled', { reason: 'retirement_fence_changed' });
    return 'cancelled';
  }
  const liveness = ownerProcessLiveness(check.row, processes.inspect(check.row.owner_process_pid));
  if (liveness === 'unavailable') {
    decide(check.row, 'failed', 'process_identity_unobservable');
    logRetirementDecision(context.logger, check.row, 'failed', { reason: 'process_identity_unobservable' });
    return 'failed';
  }
  if (liveness === 'gone') {
    const terminated = withTransaction(context.db, () => finalDead(context.db, check.row, token, 'already_exited', new Date().toISOString()));
    logRetirementDecision(context.logger, check.row, terminated ? 'terminated' : 'cancelled', { reason: terminated ? 'owner_exited' : 'retirement_fence_changed' });
    return terminated ? 'terminated' : 'cancelled';
  }
  const restored = withTransaction(context.db, () => keepLiveOwner(context.db, check.row, token, new Date().toISOString()));
  logRetirementDecision(context.logger, check.row, 'cancelled', { reason: 'owner_alive', endpoint_restored_idle: restored });
  return 'cancelled';
}

export async function runEndpointRetirementExecutor(context, { now = new Date(), processes = defaultProcesses(), claimFn = acquireClaim } = {}) {
  const ids = context.db.prepare(
    `SELECT r.id
       FROM endpoint_retirements r
       JOIN listeners l ON l.id = r.listener_id
      WHERE r.state = 'pending'
        AND (
          r.cause = 'park_expired'
          OR (r.cause = 'provider_admission_timeout' AND l.state = 'ended' AND l.terminal_reason IN ('acknowledged', 'provider_admission_timeout'))
        )
      ORDER BY r.created_at, r.id`,
  ).all().map((row) => row.id);
  const summary = { candidates: ids.length, terminated: 0, cancelled: 0, failed: 0, skipped: 0 };
  for (const id of ids) summary[await executeOne(context, id, { now, processes, claimFn })] += 1;
  return summary;
}

// ---------------------------------------------------------------------
// Owner-exit reconciliation (item 42 B/C)
// ---------------------------------------------------------------------

// Watched: rows whose owner of the CURRENT generation was recorded and has
// not yet been seen to exit. `dead` is watched too: supervised custody loss
// (a headless successor exiting while it holds open work) marks the row dead
// without observing the process, and without the exit proof an interactive
// session could never be resumed headlessly again. Read BEFORE the process
// snapshot so an owner that registers after the read is never judged
// against a snapshot taken before it existed.
const WATCHED_ENDPOINTS = `
  SELECT id, state, runtime, launch_mode, process_generation, provider_session_id,
         owner_process_pid, owner_process_start_identity, owner_process_group_id,
         owner_process_capture_source, owner_process_generation
    FROM endpoints
   WHERE state IN ('idle', 'busy', 'dead')
     AND provider_session_id IS NOT NULL
     AND owner_process_pid IS NOT NULL
     AND owner_process_exited_at IS NULL
     AND owner_process_generation = process_generation`;

/**
 * One reconciliation pass. For every watched endpoint whose recorded owner
 * is gone, one CAS transaction (same state, generation, and owner tuple)
 * records the exit and moves custody:
 *
 *   non_interactive       busy -> idle (idle stays idle): the ordinary
 *                         resumable shape a Stop allow would have left,
 *                         which a `codex exec` that exits without its Stop
 *                         reaching the daemon never reaches today (42 B).
 *   interactive / NULL    idle|busy -> dead: the pane or process is gone, so
 *                         the session may be resumed headlessly (42 C). The
 *                         launch mode is never touched.
 *   already dead          stays dead; only the exit proof is recorded.
 *
 * `updated_at` is deliberately left alone: a process exit is not session
 * activity, and item 44's staleness window reads that column. Open work the
 * endpoint holds stays open with it — the headless successor continues the
 * same session; nothing here is death evidence for custody reconciliation.
 */
export function runOwnerProcessReconciliation(context, { now = new Date(), processes = defaultProcesses() } = {}) {
  const startedAt = Date.now();
  const db = context.db;
  const summary = { watched: 0, exited: 0, idled: 0, died: 0, proven: 0, alive: 0, fenced: 0, unavailable: false };
  const watched = db.prepare(WATCHED_ENDPOINTS).all()
    .filter((row) => ownerProcessTupleIssue(row, { runtime: row.runtime, processGeneration: row.process_generation }) === null);
  summary.watched = watched.length;
  if (watched.length === 0) return summary;

  const snapshot = processes.snapshot();
  if (snapshot?.unavailable) {
    summary.unavailable = true;
    context.logger?.warn?.({ event: 'owner_process_reconcile_unavailable', params: { watched: watched.length }, status: 'skipped', latency_ms: Date.now() - startedAt });
    return summary;
  }

  const exitedAt = now.toISOString();
  for (const row of watched) {
    if (ownerProcessLiveness(row, snapshot.get(row.owner_process_pid) ?? null) !== 'gone') {
      summary.alive += 1;
      continue;
    }
    const nonInteractive = row.launch_mode === 'non_interactive';
    const alreadyDead = row.state === 'dead';
    const nextState = alreadyDead ? 'dead' : nonInteractive ? 'idle' : 'dead';
    const changed = withTransaction(db, () => db.prepare(
      `UPDATE endpoints
          SET state = ?, owner_process_exited_at = ?
        WHERE id = ? AND state = ? AND process_generation = ? AND launch_mode IS ?
          AND owner_process_pid = ? AND owner_process_start_identity = ? AND owner_process_group_id = ?
          AND owner_process_capture_source = ? AND owner_process_generation = process_generation
          AND owner_process_exited_at IS NULL`,
    ).run(
      nextState, exitedAt, row.id, row.state, row.process_generation, row.launch_mode,
      row.owner_process_pid, row.owner_process_start_identity, row.owner_process_group_id, row.owner_process_capture_source,
    ).changes === 1);
    if (!changed) {
      summary.fenced += 1;
      continue;
    }
    summary.exited += 1;
    if (alreadyDead) summary.proven += 1;
    else if (nonInteractive) summary.idled += 1;
    else summary.died += 1;
    // One record per endpoint whose custody moved — a boundary decision,
    // never a per-tick heartbeat.
    context.logger?.info?.({
      event: 'owner_process_exit_reconciled',
      params: {
        endpoint_id: row.id,
        runtime: row.runtime,
        launch_mode: row.launch_mode,
        process_generation: row.process_generation,
        owner_process_pid: row.owner_process_pid,
        from_state: row.state,
      },
      result: {
        to_state: nextState,
        path: alreadyDead
          ? (nonInteractive ? 'noninteractive_dead_exit_recorded' : 'interactive_dead_headless_resumable')
          : nonInteractive ? 'noninteractive_idle_resumable' : 'interactive_dead_headless_resumable',
      },
      status: 'ok',
    });
  }
  if (summary.exited > 0 || summary.fenced > 0) {
    context.logger?.info?.({ event: 'owner_process_reconcile_pass', params: { watched: summary.watched }, result: summary, status: 'ok', latency_ms: Date.now() - startedAt });
  }
  return summary;
}
