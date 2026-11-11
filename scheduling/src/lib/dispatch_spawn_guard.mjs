import { processStartEvidence } from "./process_liveness.mjs";
import { clearActiveRun } from "./store.mjs";

const log = (event, fields) =>
  process.stderr.write(
    `[helm dispatch] ${JSON.stringify({ event, ...fields })}\n`,
  );

// Opportunity #4: capture start-time evidence at spawn so the reaper can
// verify PID identity before any orphan decision or kill signal.
export function pidStartTimeOf(pid) {
  try {
    return processStartEvidence(pid).start_time;
  } catch {
    return null;
  }
}

// Read first in onSpawn, before any evidence write can throw (fgp.51).
export const spawnIdentity = (pid) => ({ pid, startTime: pidStartTimeOf(pid) });

// A dispatch throw after the spawn (onSpawn's evidence writes hit EACCES/ENOSPC) records the attempt as a
// failure, so its child must not keep running unsupervised (fgp.46). Returns true when the throw
// came after the spawn: the run must then not retry into a second child.
// A classic child may already be reaped and its pid reused (fgp.51): the group is signalled only
// when the leader's start time read now equals the one captured at onSpawn; unverifiable means no signal,
// and the existing give-up/reaper path owns any survivor.
export function stopSpawnedChild({ spawned, child, err, jobId, runId }) {
  if (!spawned) return false;
  const pid = child?.pid ?? null;
  const signal = killVerifiedGroup(pid, child?.startTime);
  log("post_spawn_throw", {
    job: jobId,
    run: runId,
    pid,
    signal,
    stopped: signal === "sent",
    error: err?.message || String(err),
    stack: err?.stack || null,
  });
  return true;
}

function killVerifiedGroup(pid, startTime) {
  const now =
    Number.isInteger(pid) && pid > 0 && startTime
      ? processStartEvidence(pid)
      : null;
  if (!now?.alive || now.start_time !== startTime)
    return now?.alive === false ? "not_alive" : "unverified";
  try {
    process.kill(-pid, "SIGKILL"); // our own group only, never kill(pid)
    return "sent";
  } catch (err) {
    return err?.code || "error";
  }
}

// The same fault usually fails the clear too; it must not escape and skip the run's finalize.
export function clearActiveRunBestEffort(scope, jobId, runId) {
  try {
    clearActiveRun(scope, jobId);
  } catch (err) {
    log("active_run_clear_failed", {
      job: jobId,
      run: runId,
      error: err?.message || String(err),
    });
  }
}
