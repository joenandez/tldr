// The private resume-debug directory's retention: Claude's debug logs, pruned
// before each launch (moved out of resumer.mjs unchanged).
import fs from "node:fs";
import path from "node:path";

// What <state-root>/resume-debug keeps of Claude's debug logs: the newest
// 20, at most 64 MiB between them, none older than a week.
export const RESUME_DEBUG_RETAINED_LOGS = 20;
export const RESUME_DEBUG_RETAINED_BYTES = 64 * 1024 * 1024;
const RESUME_DEBUG_RETAINED_MS = 7 * 24 * 60 * 60 * 1000;

function warnPruneFailed(logger, requestId, err) {
  logger?.warn({
    event: "resume_debug_log_prune_failed",
    resume_request_id: requestId,
    message: err.message,
  });
}

// Regular `.log` files only, newest first.
function listLogs(dir, names) {
  const logs = [];
  for (const name of names.filter((entry) => entry.endsWith(".log"))) {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile())
        logs.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // removed since the listing
    }
  }
  return logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Makes room for one more Claude debug log in a private directory, oldest
 * removed first, inside the count, byte, and age bounds above. Only regular
 * files are counted or removed (Claude keeps a `latest` symlink there). A
 * log is diagnostic evidence, never state, so nothing here blocks a launch.
 */
export function prepareResumeDebugLog(debugFile, logger, requestId) {
  const dir = path.dirname(debugFile);
  let names;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    names = fs.readdirSync(dir);
  } catch (err) {
    warnPruneFailed(logger, requestId, err);
    return;
  }
  const oldestKeptMs = Date.now() - RESUME_DEBUG_RETAINED_MS;
  let kept = 0;
  let bytes = 0;
  for (const log of listLogs(dir, names)) {
    bytes += log.size;
    const keep =
      kept < RESUME_DEBUG_RETAINED_LOGS - 1 &&
      bytes <= RESUME_DEBUG_RETAINED_BYTES &&
      log.mtimeMs >= oldestKeptMs;
    if (keep) kept += 1;
    else removeLog(log.file, logger, requestId);
  }
}

function removeLog(file, logger, requestId) {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    warnPruneFailed(logger, requestId, err);
  }
}
