// Daemon-tick pass over pending provider-run markers (see provider_run_outcome.mjs). One bad marker must never
// abort the tick or make the scope dispatch forever: each finalize is guarded, and a marker that keeps failing
// is quarantined (renamed aside; the `.json` filter then skips it).
import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isSameProcessAlive } from "./process_liveness.mjs";
import { readRunSessionOutcomeState } from "./run_session_outcome.mjs";
import {
  finalizeProviderRunOutcome,
  pendingDir,
  readMarker,
} from "./provider_run_outcome.mjs";

export const MAX_FAILED_FINALIZES = 3;

export function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function recordedOutcome(marker) {
  for (const cwd of marker.outcome_cwds || []) {
    const state = readRunSessionOutcomeState({
      cwd,
      jobId: marker.job_id,
      runId: marker.run_id,
    });
    if (state.kind === "valid") return state.outcome;
  }
  return null;
}

const TRANSIENT_FINALIZE = new Set(["job_update_deferred", "already_claimed"]);
const failuresPath = (path) => `${path}.failures`;

// ctx = {scope, marker}
function logEvent(event, { scope, marker }, fields = {}) {
  process.stderr.write(
    `[helm provider-outcome] ${JSON.stringify({ event, scope: scope.scope_id || "unknown", job: marker.job_id, run: marker.run_id, ...fields })}\n`,
  );
}

function clearFailures(path) {
  rmSync(failuresPath(path), { force: true });
}

// The failure count persists beside the marker: every tick is a fresh dispatch child.
function noteFailedFinalize(ctx, error) {
  const { path } = ctx;
  let failures = 1;
  try {
    failures +=
      Number.parseInt(readFileSync(failuresPath(path), "utf8"), 10) || 0;
  } catch {
    /* no sidecar yet */
  }
  try {
    writeFileSync(failuresPath(path), String(failures), "utf8");
  } catch {
    /* unwritable: the marker is retried every tick but still never aborts the sweep */
  }
  logEvent("provider_run_finalize_failed", ctx, { failures, error });
  if (failures < MAX_FAILED_FINALIZES) return;
  try {
    renameSync(path, `${path}.quarantined`);
    clearFailures(path);
    logEvent("provider_run_quarantined", ctx, { failures });
  } catch (err) {
    logEvent("provider_run_quarantine_failed", ctx, {
      error: err?.message || String(err),
    });
  }
}

// The session's outcome once it has ended: its record, or null (unrecorded) when pid and group are both gone.
// undefined = still running.
function endedOutcome(marker) {
  const recorded = recordedOutcome(marker);
  if (recorded) return recorded;
  const pidAlive = Number.isInteger(marker.pid)
    ? isSameProcessAlive(marker.pid, marker.pid_start_time || null)
    : false;
  if (pidAlive || groupAlive(marker.pgid)) return undefined;
  // Re-read: the boundary wrapper writes its record just before exiting.
  // Still nothing once the whole process group is gone: the run is lost
  // (SIGKILL, machine sleep or crash) and is closed as unrecorded.
  return recordedOutcome(marker);
}

// ctx = {scope, path, marker}; opts = {daemonInstanceId, metadataFor}. @returns {boolean} finalized
async function finalizeOne(ctx, { daemonInstanceId, metadataFor }) {
  const { scope, path, marker } = ctx;
  try {
    const outcome = endedOutcome(marker);
    if (outcome === undefined) return false;
    const closed = await finalizeProviderRunOutcome({
      scope,
      runId: marker.run_id,
      outcome,
      observedBy: "sweep",
      daemonInstanceId,
      metadata: metadataFor(marker.job_id),
    });
    if (closed.finalized) clearFailures(path);
    // Lease contention (job_update_deferred) or a live finalizer's fresh claim (already_claimed; stale ones are
    // taken over after STALE_CLAIM_MS) is transient: retried next tick, never quarantined.
    else if (!TRANSIENT_FINALIZE.has(closed.reason))
      noteFailedFinalize(ctx, closed.reason);
    return closed.finalized;
  } catch (err) {
    // Never touch the claim here: finalize releases or retires its own, and a claim seen here may be a live
    // finalizer's or a retired marker's (removing it would repeat records).
    noteFailedFinalize(ctx, err?.message || String(err));
    return false;
  }
}

/**
 * Daemon-tick pass: finalize every pending run whose session has ended.
 * Sessions still running are left alone. Never throws.
 */
export async function sweepProviderRunOutcomes(
  scope,
  { daemonInstanceId = null, metadataFor = () => null } = {},
) {
  const dir = pendingDir(scope);
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return { finalized: 0 };
  }
  let finalized = 0;
  for (const name of names) {
    const path = join(dir, name);
    const marker = readMarker(path);
    if (!marker) continue;
    const ctx = { scope, path, marker };
    // eslint-disable-next-line no-await-in-loop -- one marker at a time keeps job writes ordered
    const done = await finalizeOne(ctx, { daemonInstanceId, metadataFor });
    if (done) finalized += 1;
  }
  return { finalized };
}
