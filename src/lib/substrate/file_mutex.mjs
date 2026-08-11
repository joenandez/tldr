// Opportunity #2 (reliability review 2026-06-11): cross-process advisory
// file mutex for canonical-store mutations. The substrate writers (daemon
// poll tick, webhook HTTP server, comms-dispatcher tick, every CLI
// `helm-tasks message` process) all read-modify-write the same JSON files;
// without mutual exclusion a concurrent writer silently clobbers fields
// like dispatch_decision / owner_session_id (the recurring misroute class).
//
// Store mutations use the synchronous helper; provider calls use the async
// helper so a lifecycle lock can remain held across network I/O.
import {
  closeSync,
  futimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const DEFAULT_HARD_STALE_MS = 120_000;

export class MutexTimeoutError extends Error {
  constructor(lockPath, timeoutMs) {
    super(`file_mutex: timed out after ${timeoutMs}ms waiting for ${lockPath}`);
    this.name = "MutexTimeoutError";
    this.lock_path = lockPath;
    this.timeout_ms = timeoutMs;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createLock(lockPath) {
  const ownerToken = randomUUID();
  const fd = openSync(lockPath, "wx");
  try {
    writeFileSync(
      fd,
      `${JSON.stringify({
        pid: process.pid,
        owner_token: ownerToken,
        acquired_at: new Date().toISOString(),
      })}\n`,
    );
    return { fd, ownerToken };
  } catch (error) {
    closeSync(fd);
    rmSync(lockPath, { force: true });
    throw error;
  }
}

function ownsLock(lockPath, ownerToken) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    return owner.owner_token === ownerToken;
  } catch {
    return false;
  }
}

function releaseLock(lockPath, owner) {
  try {
    if (ownsLock(lockPath, owner.ownerToken)) {
      rmSync(lockPath, { force: true });
    }
  } finally {
    closeSync(owner.fd);
  }
}

function heartbeatLock(lockPath, owner) {
  if (!ownsLock(lockPath, owner.ownerToken)) return;
  try {
    const now = new Date();
    futimesSync(owner.fd, now, now);
  } catch {
    // A lost or closed lock is handled by ownership-checked release.
  }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockAgeMs(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function abandonedLock(lockPath, { staleMs, hardStaleMs }) {
  const ageMs = lockAgeMs(lockPath);
  if (ageMs === null) return false;
  if (ageMs >= hardStaleMs) return true;
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    const pid = Number(owner.pid);
    if (Number.isInteger(pid) && pid > 0) return !pidIsAlive(pid);
  } catch {
    // A just-created lock can be visible before its owner JSON is readable.
  }
  return ageMs >= staleMs;
}

export function fileMutexState(
  lockPath,
  { staleMs = 10_000, hardStaleMs = DEFAULT_HARD_STALE_MS } = {},
) {
  if (lockAgeMs(lockPath) === null) return "missing";
  return abandonedLock(lockPath, { staleMs, hardStaleMs })
    ? "abandoned"
    : "held";
}

// Acquire `lockPath` exclusively (O_EXCL create), run fn, release. A lock
// whose owner process died (or whose legacy owner metadata is stale) is
// presumed abandoned and stolen.
export function withFileMutex(
  lockPath,
  fn,
  {
    timeoutMs = 5000,
    staleMs = 10_000,
    hardStaleMs = DEFAULT_HARD_STALE_MS,
    pollMs = 5,
  } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let owner;
  for (;;) {
    try {
      owner = createLock(lockPath);
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (abandonedLock(lockPath, { staleMs, hardStaleMs })) {
        // Steal: if two stealers race, exactly one wins the wx create.
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new MutexTimeoutError(lockPath, timeoutMs);
      }
      sleepSync(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    releaseLock(lockPath, owner);
  }
}

export async function withFileMutexAsync(
  lockPath,
  fn,
  {
    timeoutMs = 5000,
    staleMs = 10_000,
    hardStaleMs = DEFAULT_HARD_STALE_MS,
    heartbeatMs = Math.max(1, Math.floor(hardStaleMs / 3)),
    pollMs = 5,
  } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let owner;
  for (;;) {
    try {
      owner = createLock(lockPath);
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (abandonedLock(lockPath, { staleMs, hardStaleMs })) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new MutexTimeoutError(lockPath, timeoutMs);
      }
      // eslint-disable-next-line no-await-in-loop -- mutex acquisition polls until the bounded deadline.
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  const heartbeat = setInterval(
    () => heartbeatLock(lockPath, owner),
    heartbeatMs,
  );
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    releaseLock(lockPath, owner);
  }
}
