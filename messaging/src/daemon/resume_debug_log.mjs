// The private resume-debug directory's retention (Claude's debug logs, pruned
// before each launch), and the redacted stderr tail a failed wake child logs.
import fs from "node:fs";
import path from "node:path";

// What <state-root>/resume-debug keeps of Claude's debug logs: the newest
// 20, at most 64 MiB between them, none older than a week.
export const RESUME_DEBUG_RETAINED_LOGS = 20;
export const RESUME_DEBUG_RETAINED_BYTES = 64 * 1024 * 1024;
const RESUME_DEBUG_RETAINED_MS = 7 * 24 * 60 * 60 * 1000;

// Each pattern masks a value, never the text around it. The key-name pattern
// allows a prefix (GITHUB_TOKEN, client_secret) and JSON or quoted forms.
const SECRET_PATTERNS = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted key]",
  ],
  [/(Authorization["']?\s*[:=]\s*).*/gi, "$1[redacted]"],
  [/\b(Bearer|Basic)\s+[^\s'"]+/gi, "$1 [redacted]"],
  [/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [
    /([A-Za-z0-9_]*(?:api[_-]?key|token|password|passwd|secret|credential)[A-Za-z0-9_]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s'"&,}]+)/gi,
    "$1[redacted]",
  ],
];

// Size of the in-memory stderr ring in resumer.mjs: input this long was cut
// at the front, so its first line is partial and is dropped.
const STDERR_RING_BYTES = 16_384;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * The last `lines` lines of a failed child's stderr (each keeps its last 400
 * chars), at most `bytes` UTF-8 bytes, ANSI codes stripped, secrets masked.
 * Child stderr is untrusted and may echo prompts or credentials: this is the
 * only form of it that reaches the daemon log.
 */
export function stderrTail(text, { lines = 20, bytes = 4096 } = {}) {
  let rows = String(text ?? "")
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n|\r/);
  if (String(text ?? "").length >= STDERR_RING_BYTES) rows = rows.slice(1);
  let tail = rows
    .map((row) => row.trimEnd())
    .filter((row, i, all) => row || i < all.length - 1)
    .slice(-lines)
    .map((row) => row.slice(-400))
    .join("\n")
    .trim();
  for (const [pattern, mask] of SECRET_PATTERNS)
    tail = tail.replace(pattern, mask);
  while (Buffer.byteLength(tail) > bytes) {
    const cut = tail.indexOf("\n");
    // A single over-long line: keep whole code points from its end.
    if (cut === -1)
      return Array.from(tail)
        .slice(-Math.floor(bytes / 4))
        .join("");
    tail = tail.slice(cut + 1);
  }
  return tail;
}

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
