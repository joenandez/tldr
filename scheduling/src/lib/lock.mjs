import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { locksDir, ensureSchedulerDirs } from "./store.mjs";
import {
  isSameProcessAlive,
  processStartEvidence,
} from "./process_liveness.mjs";

const DEFAULT_MAX_LIFETIME_SEC = 3600;
const DEFAULT_EXECUTION_MAX_LIFETIME_SEC = 120;

// Opportunity #10: one clock source. Dispatch/schedule honor HELM_NOW but
// lease freshness used the wall clock, so due-ness and lease staleness could
// disagree under replay or clock skew.
function nowMs() {
  if (process.env.HELM_NOW) {
    const ms = new Date(process.env.HELM_NOW).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function nowIsoClock() {
  return new Date(nowMs()).toISOString();
}

function readLock(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function corruptLockGraceMs() {
  const raw = process.env.HELM_CORRUPT_LOCK_GRACE_MS;
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed < 0) return 1000;
  return parsed;
}

function corruptLockAgeMs(path) {
  try {
    return Math.max(0, nowMs() - statSync(path).mtimeMs);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function maxLifetimeSec(name = "execution.lock") {
  const raw =
    process.env.HELM_LEASE_MAX_LIFETIME_SEC ||
    (name === "execution.lock"
      ? process.env.HELM_EXECUTION_LEASE_MAX_LIFETIME_SEC
      : null);
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return name === "execution.lock"
      ? DEFAULT_EXECUTION_MAX_LIFETIME_SEC
      : DEFAULT_MAX_LIFETIME_SEC;
  }
  return parsed;
}

// Opportunity #4: staleness is keyed to the last heartbeat renewal
// (updated_at), not acquisition. The old acquired_at basis structurally
// guaranteed any run longer than the max lifetime (120s for execution.lock)
// would have its healthy holder reaped — long agent runs are the norm. A
// renewing holder stays fresh forever; a crashed holder stops renewing and
// goes stale one max-lifetime after its last heartbeat.
function leaseFreshnessBaseMs(current) {
  const updatedMs = current?.updated_at
    ? new Date(current.updated_at).getTime()
    : NaN;
  if (Number.isFinite(updatedMs)) return updatedMs;
  const acquiredMs = current?.acquired_at
    ? new Date(current.acquired_at).getTime()
    : NaN;
  return Number.isFinite(acquiredMs) ? acquiredMs : null;
}

function isStaleByAge(current, name = "execution.lock") {
  if (!current || !current.acquired_at) return false;
  const baseMs = leaseFreshnessBaseMs(current);
  if (baseMs === null) return false;
  const ageSec = (nowMs() - baseMs) / 1000;
  return ageSec > maxLifetimeSec(name);
}

export function lockPath(scope, name = "execution.lock") {
  return join(locksDir(scope), name);
}

export function acquireLease(
  scope,
  owner,
  leaseSec = 60,
  name = "execution.lock",
) {
  ensureSchedulerDirs(scope);
  const path = lockPath(scope, name);
  const current = readLock(path);
  if (existsSync(path) && !current) {
    const ageMs = corruptLockAgeMs(path);
    if (ageMs >= corruptLockGraceMs()) {
      rmSync(path, { force: true });
    } else {
      return {
        acquired: false,
        reason: "corrupt_lock",
        current: null,
        path,
        age_ms: ageMs,
      };
    }
  }
  const leaseFresh =
    current &&
    current.lease_until &&
    new Date(current.lease_until).getTime() > nowMs();
  if (leaseFresh && !isStaleByAge(current, name)) {
    return { acquired: false, reason: "locked", current };
  }
  if (current) {
    rmSync(path, { force: true });
  }
  const acquiredAt = nowIsoClock();
  const leaseUntil = new Date(nowMs() + leaseSec * 1000).toISOString();
  const payload = {
    owner,
    holder_pid: process.pid,
    // Opportunity #4: identity evidence so reapStaleLease never signals an
    // unrelated process that merely reused this PID.
    holder_start_time: processStartEvidence(process.pid).start_time,
    acquired_at: acquiredAt,
    lease_until: leaseUntil,
    updated_at: acquiredAt,
  };
  try {
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      const latest = readLock(path);
      if (!latest) {
        return {
          acquired: false,
          reason: "corrupt_lock",
          current: null,
          path,
          age_ms: corruptLockAgeMs(path),
        };
      }
      return { acquired: false, reason: "locked", current: latest };
    }
    throw err;
  }
  return { acquired: true, lease_until: leaseUntil, path };
}

export function renewLease(
  scope,
  owner,
  leaseSec = 60,
  name = "execution.lock",
) {
  const path = lockPath(scope, name);
  const current = readLock(path);
  if (!current || current.owner !== owner) return false;
  if (isStaleByAge(current, name)) return false;
  const acquiredAt = current.acquired_at ?? nowIsoClock();
  // Opportunity #4: renewal is a heartbeat — it extends lease_until without
  // an acquired_at cap. The old cap meant a lease could never outlive
  // acquired_at + max lifetime, so every long run's healthy holder was
  // eventually reaped mid-run. Abandonment is now detected by renewals
  // stopping (isStaleByAge on updated_at), not by total runtime.
  const payload = {
    owner,
    holder_pid: current.holder_pid ?? process.pid,
    holder_start_time: current.holder_start_time ?? null,
    acquired_at: acquiredAt,
    lease_until: new Date(nowMs() + leaseSec * 1000).toISOString(),
    updated_at: nowIsoClock(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return true;
}

export function releaseLease(scope, owner, name = "execution.lock") {
  const path = lockPath(scope, name);
  const current = readLock(path);
  if (!current || current.owner !== owner) return false;
  rmSync(path, { force: true });
  return true;
}

export function reapStaleLease(scope, opts = {}) {
  const lockName = opts.lockName || "execution.lock";
  const kill = opts.kill || ((pid, signal) => process.kill(pid, signal));
  const path = lockPath(scope, lockName);
  const current = readLock(path);
  if (!current) return { reaped: false, reason: "no_lock" };
  if (!current.acquired_at)
    return { reaped: false, reason: "legacy_no_acquired_at" };
  const baseMs = leaseFreshnessBaseMs(current);
  if (baseMs === null) return { reaped: false, reason: "invalid_acquired_at" };
  // Opportunity #4: age from the last heartbeat renewal, so a healthy
  // long-running holder that keeps renewing is never reaped.
  const ageSec = (nowMs() - baseMs) / 1000;
  if (ageSec <= maxLifetimeSec(lockName))
    return { reaped: false, reason: "fresh", age_sec: ageSec };
  const pid = Number(current.holder_pid);
  let killed = false;
  let killSkippedReason = null;
  if (Number.isFinite(pid) && pid > 0) {
    // Opportunity #4: only signal the holder when its identity still
    // matches the recorded start-time evidence — never an unrelated
    // process that reused the PID.
    const sameProcess = current.holder_start_time
      ? isSameProcessAlive(pid, current.holder_start_time)
      : true;
    if (sameProcess) {
      try {
        kill(pid, "SIGTERM");
        killed = true;
      } catch (err) {
        if (err && err.code !== "ESRCH") throw err;
      }
    } else {
      killSkippedReason = "pid_identity_mismatch";
    }
  }
  rmSync(path, { force: true });
  return {
    reaped: true,
    holder_pid: Number.isFinite(pid) ? pid : null,
    age_sec: ageSec,
    killed,
    ...(killSkippedReason ? { kill_skipped_reason: killSkippedReason } : {}),
    owner: current.owner,
  };
}
