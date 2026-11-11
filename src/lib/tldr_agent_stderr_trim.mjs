import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { daemonStderrPath } from "./tldr_agent_launchd_definition.mjs";

export const DAEMON_STDERR_MAX_BYTES = 1024 * 1024;

function readRange(fd, start, end) {
  const buffer = Buffer.alloc(end - start);
  readSync(fd, buffer, 0, buffer.length, start);
  return buffer;
}

// Launchd keeps the daemon's stderr file open (O_APPEND) and never reopens it, so a rename
// would send every later line to the renamed file, unbounded. The file is trimmed in place:
// its last `maxBytes` go to `.1`, then the file is truncated. A line appended during the copy
// is picked up by re-copying the tail, at most MAX_TRIM_PASSES times, so a steady writer
// cannot hold the daemon and `.1` never passes maxBytes. Residual risk: a line appended
// after the last pass and before the truncate (microseconds) is lost; the live file can pass
// maxBytes by what is written between two maintenance passes.
// afterCopy is a test seam that runs after each copy pass.
const MAX_TRIM_PASSES = 3;

export function trimDaemonStderr(home, maxBytes, { afterCopy } = {}) {
  const path = daemonStderrPath(home);
  if (!existsSync(path) || statSync(path).size <= maxBytes) return false;
  const source = openSync(path, "r");
  let backup = null;
  try {
    backup = openSync(`${path}.1`, "w", 0o600);
    let copied = 0;
    for (let pass = 0; pass < MAX_TRIM_PASSES; pass += 1) {
      const size = fstatSync(source).size;
      if (size === copied) break;
      const tail = readRange(source, Math.max(0, size - maxBytes), size);
      ftruncateSync(backup, 0);
      writeSync(backup, tail, 0, tail.length, 0);
      copied = size;
      afterCopy?.();
    }
    truncateSync(path, 0);
  } finally {
    closeSync(source);
    if (backup !== null) closeSync(backup);
  }
  return true;
}

// Best effort: a crashing daemon is restarted by launchd, so trimming at start keeps the
// file bounded even when the first tick never reaches the per-tick maintenance.
export function trimDaemonStderrAtStart(home) {
  try {
    trimDaemonStderr(home, DAEMON_STDERR_MAX_BYTES);
  } catch {
    // Diagnostics must never block the daemon.
  }
}
