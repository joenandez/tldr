import { spawnSync } from "node:child_process";

export function isProcessAlive(pid, { spawnSyncImpl = spawnSync } = {}) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;

  try {
    process.kill(numericPid, 0);
  } catch (err) {
    if (err?.code !== "EPERM") return false;
  }

  const stat = processStat(numericPid, spawnSyncImpl);
  if (stat && /^Z/i.test(stat)) return false;
  return true;
}

// Opportunity #4 (reliability review 2026-06-11): identity-verified liveness.
// `isProcessAlive` alone cannot distinguish the original process from an
// unrelated one that reused its PID — the wrong-kill / runaway-daemon class
// (COE-2026-05-05, 05-23). When start-time evidence was captured at spawn,
// require it to match before declaring "the process we launched is alive".
// Inconclusive reads (no captured evidence, or ps unavailable right now)
// resolve to "same" so a transient ps failure can never trigger a false
// kill or a false orphan-reap of a healthy run.
export function isSameProcessAlive(
  pid,
  capturedStartTime,
  { spawnSyncImpl = spawnSync } = {},
) {
  if (!isProcessAlive(pid, { spawnSyncImpl })) return false;
  if (!capturedStartTime) return true;
  const evidence = processStartEvidence(pid, { spawnSyncImpl });
  if (!evidence.start_time) return true;
  return evidence.start_time === capturedStartTime;
}

export function processStartEvidence(pid, { spawnSyncImpl = spawnSync } = {}) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return { pid: numericPid, alive: false, start_time: null };
  }
  const alive = isProcessAlive(numericPid, { spawnSyncImpl });
  if (!alive) return { pid: numericPid, alive: false, start_time: null };
  try {
    const result = spawnSyncImpl(
      "ps",
      ["-o", "lstart=", "-p", String(numericPid)],
      { encoding: "utf8" },
    );
    if (result?.status !== 0) {
      return { pid: numericPid, alive: true, start_time: null };
    }
    const startTime = String(result?.stdout || "").trim() || null;
    return { pid: numericPid, alive: true, start_time: startTime };
  } catch {
    return { pid: numericPid, alive: true, start_time: null };
  }
}

export function processParentPid(pid, { spawnSyncImpl = spawnSync } = {}) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return null;
  try {
    const result = spawnSyncImpl(
      "ps",
      ["-o", "ppid=", "-p", String(numericPid)],
      {
        encoding: "utf8",
      },
    );
    if (result?.status !== 0) return null;
    const parsed = Number(String(result?.stdout || "").trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function processStat(pid, spawnSyncImpl) {
  try {
    const result = spawnSyncImpl("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    });
    if (result?.status !== 0) return null;
    return String(result?.stdout || "").trim();
  } catch {
    return null;
  }
}
