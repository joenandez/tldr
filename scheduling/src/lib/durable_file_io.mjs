// Opportunity #2 (reliability review 2026-06-11): durable JSON file writes.
// writeJsonAtomic/appendJsonLine historically did temp+rename / O_APPEND with
// no fsync — crash or power loss could lose the tail of messages.jsonl or
// leave a rename un-journaled. Durable mode fsyncs the file (and, for the
// atomic rename, the directory) before returning. Non-durable remains the
// default for hot, rebuildable streams (activity events).
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

function tempPath(path) {
  return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
}

function fsyncDirBestEffort(dir) {
  // Directory fsync makes the rename itself durable. Best-effort: some
  // platforms/filesystems reject opening a directory for fsync.
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // unsupported — temp+rename atomicity still holds
  }
}

function unlinkTempBestEffort(path) {
  try {
    unlinkSync(path);
  } catch {
    // The temp may not have been created, or cleanup may hit the same I/O fault.
  }
}

function writeFullySync(fd, payload, writeSyncFn) {
  const buffer = Buffer.from(payload, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const written = writeSyncFn(fd, buffer, offset, remaining);
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      const err = new Error(
        `incomplete durable write: wrote ${offset} of ${buffer.length} bytes`,
      );
      err.code = "EIO";
      throw err;
    }
    offset += written;
  }
}

export function writeJsonAtomic(
  path,
  value,
  { durable = false, writeSyncFn = writeSync } = {},
) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let fd = null;
  try {
    if (durable) {
      fd = openSync(tmp, "w");
      writeFullySync(fd, payload, writeSyncFn);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
    } else {
      writeFileSync(tmp, payload, "utf8");
    }
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original persistence failure.
      }
    }
    unlinkTempBestEffort(tmp);
    throw err;
  }
  if (durable) {
    fsyncDirBestEffort(dirname(path));
  }
}

// Replaces a single text file by writing a sibling temporary file and renaming
// it into place. The sibling is important: rename is atomic only within one
// filesystem, so callers never observe a truncated backing skill.
export function writeTextAtomic(path, text, { durable = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  let fd = null;
  try {
    if (durable) {
      fd = openSync(tmp, "w");
      writeFullySync(fd, text, writeSync);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
    } else {
      writeFileSync(tmp, text, "utf8");
    }
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the replacement failure.
      }
    }
    unlinkTempBestEffort(tmp);
    throw err;
  }
  if (durable) fsyncDirBestEffort(dirname(path));
}

export function appendJsonLine(path, value, { durable = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(value)}\n`;
  if (durable) {
    const fd = openSync(path, "a");
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return;
  }
  writeFileSync(path, payload, { flag: "a" });
}
