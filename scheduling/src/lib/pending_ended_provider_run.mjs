// Idle-gate probe: does `scope` hold a pending provider-run marker whose run has ended? Such a scope needs a
// dispatch child so dispatchScope's sweepProviderRunOutcomes can finalize (and hold) it. One directory read plus a
// liveness check per marker; markers of still-running sessions do not count. Read-only.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isSameProcessAlive } from "./process_liveness.mjs";
import { pendingDir, readMarker } from "./provider_run_outcome.mjs";
import { groupAlive, recordedOutcome } from "./provider_run_sweep.mjs";

// Same test as sweepProviderRunOutcomes: a recorded session outcome, else the session pid (same start time)
// and its process group both gone. A leftover child can keep the group alive after the outcome was written.
function runEnded(marker, pidAlive) {
  if (recordedOutcome(marker)) return true;
  const alive =
    Number.isInteger(marker.pid) &&
    pidAlive(marker.pid, marker.pid_start_time || null);
  return !alive && !groupAlive(marker.pgid);
}

export function hasEndedPendingProviderRun(
  scope,
  { pidAlive = isSameProcessAlive } = {},
) {
  let names;
  try {
    names = readdirSync(pendingDir(scope)).filter((n) => n.endsWith(".json"));
  } catch {
    return false;
  }
  return names.some((name) => {
    const marker = readMarker(join(pendingDir(scope), name));
    return marker && runEnded(marker, pidAlive);
  });
}
