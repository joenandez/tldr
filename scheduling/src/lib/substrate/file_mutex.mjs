import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

export function withFileMutex(
  lockPath,
  fn,
  { timeoutMs = 5000, staleMs = 10_000, pollMs = 5 } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
        { flag: "wx" },
      );
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      let ageMs = Number.POSITIVE_INFINITY;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        // The lock vanished between EEXIST and stat; retry immediately.
      }
      if (ageMs >= staleMs) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline)
        throw new MutexTimeoutError(lockPath, timeoutMs);
      sleepSync(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
