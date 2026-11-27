// ac-jfv.161: a busy row whose recorded owner is already known exited has no
// watched owner. The owner-exit reconciler watches only owners not yet seen
// exited, the takeover retry claims only an idle or takeover_pending row, and
// the row's pending request blocks every successor wake: a relaunch that
// marked it busy and died (a Codex takeover replay keeps the dead owner)
// strands it for good, as rolo's end_da4953c2 on 2026-11-17. The owner-exit
// pass settles it as the exit would have (headless -> idle, interactive ->
// dead), unless a live launch claim or a live daemon child holds the
// endpoint, or a live agent process runs its session. Only daemon-launched
// custody (an owner launch token) is settled: a session reopened by hand may
// run without its id on the command line. A hosted Codex interactive turn may
// outlive its TUI (F34), so that shape is left alone. Generation, epoch,
// token and exit proof are untouched, so the pending request's next attempt
// runs; updated_at is stamped, so a row stranded for days is not stale to the
// next send. Mail that piled up while this dead holder was stranded is
// abandoned in the same transaction (see abandonStaleBacklog): never delivered
// late. Only this settle does so: the ordinary watched owner exit leaves mail.
//
// ac-jfv.170: the same pass also settles a takeover_pending row nobody will
// adopt (see orphaned_takeover.mjs), without abandoning its mail.
import { basename } from "node:path";

import { withArgv } from "./owner_activity.mjs";
import { liveResumeChildFor } from "./resumer.mjs";
import { withBacklogAbandon } from "./dead_holder_abandon.mjs";
import {
  LIVE_LAUNCH_CLAIM,
  ORPHANED_TAKEOVER,
  predecessorHolder,
  settleOrphanedTakeover,
} from "./orphaned_takeover.mjs";

export {
  DEAD_HOLDER_STALE_AFTER_MS,
  withBacklogAbandon,
} from "./dead_holder_abandon.mjs";

export const BUSY_OVER_EXITED_OWNER = `
  SELECT e.id, e.runtime, e.launch_mode, e.process_generation, e.provider_session_id,
         e.owner_launch_token, e.owner_process_pid, e.owner_process_exited_at, e.updated_at,
         'busy' AS from_state
    FROM endpoints e
   WHERE e.state = 'busy'
     AND e.provider_session_id IS NOT NULL AND length(e.provider_session_id) > 0
     AND e.owner_launch_token IS NOT NULL
     AND e.owner_process_pid IS NOT NULL
     AND e.owner_process_exited_at IS NOT NULL
     AND e.owner_process_generation = e.process_generation
     AND NOT (e.runtime = 'codex' AND e.launch_mode IS NOT 'non_interactive')
     AND NOT ${LIVE_LAUNCH_CLAIM}`;

// CAS on everything read: a restamp, a new busy mark, or a launch claim since the read fences it.
const SETTLE = `
  UPDATE endpoints AS e SET state = ?, updated_at = ?
   WHERE e.id = ? AND e.state = 'busy' AND e.process_generation = ? AND e.launch_mode IS ?
     AND e.owner_launch_token = ? AND e.owner_process_pid = ? AND e.owner_process_exited_at = ?
     AND e.updated_at IS ? AND e.owner_process_generation = e.process_generation
     AND NOT ${LIVE_LAUNCH_CLAIM}`;

// Per row kind (its from_state): the settle, the path it logs, and the holder only that kind has.
const KIND = {
  busy: {
    settle: settleBusy,
    path: "busy_over_exited_owner_settled",
    holder: () => null,
  },
  takeover_pending: {
    settle: settleOrphanedTakeover,
    path: "orphaned_takeover_settled",
    holder: predecessorHolder,
  },
};

// Agent processes only: an agent binary named anywhere before the session id
// (a node path with spaces, `sh .../academy ... --resume <sid>`), never a
// `tail -f .../<sid>.jsonl` or an editor on the transcript.
const AGENT_BEFORE_SESSION =
  /(?:^|\/)(node|claude|codex|copilot|academy)(?=\s|$)/;
const loggedHolds = new WeakMap(); // per daemon context: the holds logged by the last pass, so a hold that ends is forgotten

const loggedFailures = new WeakMap(); // per daemon context: failures of the last pass, by endpoint and message

// A deterministic failure repeats every pass: its stack is logged once, then one short line with a count.
function logSettleFailure(context, { row, error }, { previous, current }) {
  const key = `${row.id}:${error?.message}`;
  const count = (previous.get(key) ?? 0) + 1;
  current.set(key, count);
  const params = { endpoint_id: row.id };
  if (count === 1)
    context.logger?.error?.({
      event: "busy_over_exited_owner_settle_failed",
      params,
      error: { message: error?.message, stack: error?.stack },
      status: "error",
    });
  else
    context.logger?.warn?.({
      event: "busy_over_exited_owner_settle_failed_repeated",
      params,
      result: { count, message: error?.message },
      status: "error",
    });
}

function liveHolder(context, row, snapshot) {
  const child = liveResumeChildFor(context, row.id);
  if (child) return { kind: "resume_child", pid: child.pid ?? null };
  for (const entry of snapshot.values()) {
    const command = entry.command ?? "";
    const at = command.indexOf(row.provider_session_id);
    const agent =
      at < 0 ? null : AGENT_BEFORE_SESSION.exec(command.slice(0, at));
    if (agent)
      return { kind: "session_process", pid: entry.pid, basename: agent[1] };
  }
  return KIND[row.from_state].holder(row, snapshot);
}

// Once per (endpoint, holder): a held row is visible in the log, never logged every pass.
function logHold(context, { row, holder }, { previous, current }) {
  const key = `${row.id}:${holder.kind}:${holder.pid ?? ""}`;
  current.add(key);
  if (previous.has(key)) return;
  context.logger?.info?.({
    event: "busy_over_exited_owner_held",
    params: {
      endpoint_id: row.id,
      owner_process_exited_at: row.owner_process_exited_at,
    },
    result: {
      holder: holder.kind,
      pid: holder.pid ?? null,
      basename: holder.basename ?? null,
    },
    status: "skipped",
  });
}

function settleBusy(context, row, { nextState, nowIso }) {
  return withBacklogAbandon(
    context,
    { endpointId: row.id, nowIso },
    () =>
      context.db
        .prepare(SETTLE)
        .run(
          nextState,
          nowIso,
          row.id,
          row.process_generation,
          row.launch_mode,
          row.owner_launch_token,
          row.owner_process_pid,
          row.owner_process_exited_at,
          row.updated_at,
          nowIso,
        ).changes === 1,
  );
}

function settleOne(context, row, nowIso) {
  const nextState = row.launch_mode === "non_interactive" ? "idle" : "dead";
  const changed = KIND[row.from_state].settle(context, row, {
    nextState,
    nowIso,
  });
  if (!changed) return "fenced";
  context.logger?.info?.({
    event: "owner_process_exit_reconciled",
    params: {
      endpoint_id: row.id,
      runtime: row.runtime,
      launch_mode: row.launch_mode,
      process_generation: row.process_generation,
      owner_process_pid: row.owner_process_pid,
      from_state: row.from_state,
      owner_process_exited_at: row.owner_process_exited_at,
    },
    result: { to_state: nextState, path: KIND[row.from_state].path },
    status: "ok",
  });
  return nextState === "idle" ? "idled" : "died";
}

/** The rows this pass may settle, read before the process snapshot is taken. */
export function busyOverExitedOwnerRows(context, now) {
  const rows = [BUSY_OVER_EXITED_OWNER, ORPHANED_TAKEOVER].flatMap((sql) =>
    context.db.prepare(sql).all(now.toISOString()),
  );
  if (rows.length === 0) {
    // Nothing held or failing: a hold or failure that returns is logged again.
    loggedHolds.delete(context);
    loggedFailures.delete(context);
    argvCache.delete(context);
  }
  return rows;
}

// The snapshot holds each process's executable only (ac-srg29); argv is read
// for agent binaries and shells (an academy script wake runs under sh) alone,
// only on a pass that has rows to judge, and once per process: a held row
// costs no ps once its holder is known.
// shortcut: a process that rewrites its own argv keeps its first one here; no agent binary does.
const AGENT_COMM =
  /^-?(node(\d+(\.\d+)*)?|claude|codex|copilot|academy|sh|bash|zsh|dash)$/;
const argvCache = new WeakMap(); // per daemon context: pid -> { key, command }

function argvCandidates(snapshot, cache) {
  const known = new Map();
  const want = [];
  for (const entry of snapshot.values()) {
    if (!AGENT_COMM.test(basename(entry.comm ?? ""))) continue;
    const key = `${entry.startIdentity}|${entry.comm}`;
    const hit = cache.get(entry.pid);
    if (hit?.key === key) known.set(entry.pid, hit);
    else want.push({ pid: entry.pid, key });
  }
  return { known, want };
}

/** The snapshot with argv for every agent process, or null when argv could not be read. */
async function argvView(context, processes, snapshot) {
  if (!processes.argv) return null;
  const { known, want } = argvCandidates(
    snapshot,
    argvCache.get(context) ?? new Map(),
  );
  const argv = await processes.argv(want.map((entry) => entry.pid));
  if (!argv) return null;
  for (const { pid, key } of want)
    if (argv.has(pid)) known.set(pid, { key, command: argv.get(pid) });
  argvCache.set(context, known);
  return withArgv(
    snapshot,
    new Map([...known].map(([pid, hit]) => [pid, hit.command])),
  );
}

function logSkipped(context, rows, event) {
  context.logger?.warn?.({
    event,
    params: { busy_over_exited_owner: rows.length },
    status: "skipped",
  });
  return null;
}

/** The view to judge holders by, or null (logged) when argv is unknown or the snapshot aged past its bound. */
async function judgeableView(context, { rows, snapshot, processes, isStale }) {
  const view = await argvView(context, processes, snapshot);
  if (!view)
    return logSkipped(context, rows, "owner_process_reconcile_unavailable");
  if (isStale())
    return logSkipped(context, rows, "owner_process_reconcile_stale");
  return view;
}

/**
 * One pass, after the watched owners, over `rows` read before `snapshot`
 * started: a process that starts after the read is never judged against a
 * snapshot taken before it existed. A holder is judged by its argv; argv that
 * cannot be read, or a snapshot that aged past its bound, settles nothing.
 * Counts into the reconciler's `summary`.
 */
export async function settleBusyOverExitedOwner(
  context,
  { rows, snapshot, processes, now, summary, isStale = () => false },
) {
  if (rows.length === 0 || summary.stale) return;
  const view = await judgeableView(context, {
    rows,
    snapshot,
    processes,
    isStale,
  });
  if (view) settleRows(context, { rows, view, now, summary });
}

function settleRows(context, { rows, view, now, summary }) {
  const holds = {
    previous: loggedHolds.get(context) ?? new Set(),
    current: new Set(),
  };
  const failures = {
    previous: loggedFailures.get(context) ?? new Map(),
    current: new Map(),
  };
  const nowIso = now.toISOString();
  for (const row of rows) {
    try {
      const holder = liveHolder(context, row, view);
      if (holder) logHold(context, { row, holder }, holds);
      summary[holder ? "alive" : settleOne(context, row, nowIso)] += 1;
    } catch (error) {
      // One row's failure (its transaction rolled back whole) must not abort the pass.
      logSettleFailure(context, { row, error }, failures);
    }
  }
  loggedFailures.set(context, failures.current);
  loggedHolds.set(context, holds.current);
}
