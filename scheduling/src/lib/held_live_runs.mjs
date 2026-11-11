// What may still be running for a held job (specs/plan-addendum.md "Held release state model", rule 4).
// A held slot's own run outlives the hold that was loaded: in this process (memory.inflight, from startHeldRun
// until its completion settles), as a handed-off session (pending provider-run marker, until its exit is
// finalized), or as a live ledger attempt in any process (a run-now, a restarted daemon's run).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { holdKey, memory } from "./held_release_core.mjs";
import { pendingDir, readMarker } from "./provider_run_outcome.mjs";
import { ledgerIdentityForJob } from "./runtime_ledger.mjs";
import { withRuntimeStore } from "./runtime_store.mjs";

/** Pending (not finalized) provider-run markers of `scope`. */
export function pendingProviderRuns(scope) {
  let names;
  try {
    names = readdirSync(pendingDir(scope)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => readMarker(join(pendingDir(scope), name)))
    .filter(Boolean);
}

/** @returns {Set<string>} ids of jobs in `scope` with a handed-off run not yet finalized */
export function jobsWithPendingProviderRun(scope, { exceptRunIds = [] } = {}) {
  const skip = new Set(exceptRunIds);
  return new Set(
    pendingProviderRuns(scope)
      .filter((marker) => !skip.has(marker.run_id))
      .map((marker) => marker.job_id),
  );
}

const LIVE_ATTEMPTS = `
  SELECT l.job_id, l.scheduled_at FROM run_attempts a
  JOIN logical_runs l ON l.logical_run_key = a.logical_run_key
  WHERE l.scope_id = ?
    AND (COALESCE(a.state, a.status) IN ('claimed', 'launching', 'running') OR a.status IN ('claimed', 'running'))`;

/** Live ledger attempts of `scope` as [{job_id, slot (ms)}]; null when the store cannot be read. */
export function liveLedgerAttempts(scope) {
  try {
    return withRuntimeStore({}, (db) =>
      db.prepare(LIVE_ATTEMPTS).all(scope.scope_id),
    ).map((row) => ({
      job_id: row.job_id,
      slot: Date.parse(row.scheduled_at),
    }));
  } catch {
    return null;
  }
}

/** One read per scope and tick: markers, active runs and live attempts. */
export function liveRunsOf(scope, activeRuns) {
  return {
    scope,
    activeRuns,
    markers: pendingProviderRuns(scope),
    attempts: liveLedgerAttempts(scope),
  };
}

// Another run of the same slot that is not the failed run the hold came from.
const sameSlot = (held) => (run) => run.slot === held.slot;

/** The hold's own release, or its completion, is still in flight (never give it up, never start it again). */
export function ownRunInFlight(live, job) {
  const held = job.state.held;
  if (memory.inflight.has(holdKey(live.scope, job))) return true;
  const ofJob = (run) => run.job_id === job.id;
  const markerSlots = live.markers
    .filter((m) => ofJob(m) && m.run_id !== held.run_id)
    .map((m) => ({ slot: Date.parse(m.scheduled_at) }));
  const attempts = (live.attempts ?? []).filter(ofJob);
  return [...markerSlots, ...attempts].some(sameSlot(held));
}

/** Why a due hold must not start now, or null. "in_flight" is the hold's own run (quiet: not a refusal). */
export function releaseBlocker(live, job) {
  const ofJob = (run) => run.job_id === job.id;
  const checks = [
    ["in_flight", () => ownRunInFlight(live, job)],
    ["active_run", () => Boolean(live.activeRuns[job.id])],
    // The run that produced a hold is finalized before it is held; its marker is only a crash leftover.
    [
      "handed_off_run",
      () =>
        live.markers.some(
          (m) => ofJob(m) && m.run_id !== job.state.held.run_id,
        ),
    ],
    ["ledger_unreadable", () => live.attempts === null],
    // A run-now (or a scheduled run) of this job is live in some process, perhaps before its spawn.
    ["live_attempt", () => live.attempts.some(ofJob)],
  ];
  return checks.find(([, hit]) => hit())?.[0] ?? null;
}

// last_run_id: the slot's latest attempt (attempt_id is the run id), so a tick can tell that a release of the
// hold ended without its outcome reaching the hold (fgp.52).
const SLOT_TERMINAL = `
  SELECT terminal_reason, terminal_source, status, finished_at,
    (SELECT attempt_id FROM run_attempts a WHERE a.logical_run_key = l.logical_run_key
      ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1) AS last_run_id
  FROM logical_runs l WHERE logical_run_key = ?`;

/** The held slot's own logical-run terminal {terminal_reason, terminal_source, status, finished_at, last_run_id}, found by the logical_run_key the
 * release claims (not the first row at that time: a re-registered schedule has its own). null when none;
 * {unreadable: true} when the store cannot be read (fgp.49). */
export function slotTerminal(scope, job, slot) {
  try {
    const key = ledgerIdentityForJob({
      scope,
      job,
      scheduledAt: new Date(slot).toISOString(),
    }).logical_run_key;
    return (
      withRuntimeStore({}, (db) => db.prepare(SLOT_TERMINAL).get(key)) ?? null
    );
  } catch {
    return { unreadable: true };
  }
}
