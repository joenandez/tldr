import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  appendJsonLine,
  ensureGlobalRuntimeDirs,
  ensureScopeRuntimeDirs,
  eventsRoot,
  globalRuntimeRoot,
  scopeRuntimeRoot,
} from "./store.mjs";
import {
  publicEventFromActivity,
  publicHistoryEventFromActivity,
} from "./public_contract.mjs";
import { pushToHistoryRing } from "./history_ring.mjs";
import { assertSafeJobId } from "./job_id.mjs";

const TAIL_SEEK_CHUNK_BYTES = 16 * 1024;
function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const PUBLIC_EVENTS_MAX_SCAN_LINES = positiveNumberEnv(
  "HELM_PUBLIC_EVENTS_MAX_SCAN_LINES",
  5000,
);
// Opportunity #7: the legacy events cache used to pin the ENTIRE event
// history in process memory with no eviction. Consumers only ever read the
// recent tail, so cap the cache at the newest N events.
const LEGACY_EVENTS_CACHE_MAX = positiveNumberEnv(
  "HELM_LEGACY_EVENTS_CACHE_MAX",
  20000,
);
let legacyActivityEventsCache = null;

function readRoot() {
  return join(globalRuntimeRoot(), "read");
}

export function publicEventsPath() {
  return join(readRoot(), "events.jsonl");
}

function scopeReadRoot(scope) {
  return join(scopeRuntimeRoot(scope), "read");
}

function historyRoot(scope) {
  return join(scopeReadRoot(scope), "history");
}

export function jobHistoryPath(scope, jobId) {
  return join(historyRoot(scope), `${assertSafeJobId(jobId)}.jsonl`);
}

function loadJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadLegacyActivityEvents() {
  if (!existsSync(eventsRoot())) return [];
  const dayFiles = readdirSync(eventsRoot())
    .filter((file) => file.endsWith(".jsonl"))
    .sort();
  const signature = dayFiles
    .map((file) => {
      const st = statSync(join(eventsRoot(), file));
      return `${file}:${st.size}:${st.mtimeMs}`;
    })
    .join("|");
  if (legacyActivityEventsCache?.signature === signature) {
    return legacyActivityEventsCache.events;
  }
  let events = [];
  for (const file of dayFiles) {
    const path = join(eventsRoot(), file);
    for (const event of loadJsonl(path)) {
      events.push(event);
    }
    // Bounded cache: keep only the newest tail (day files sort ascending).
    if (events.length > LEGACY_EVENTS_CACHE_MAX) {
      events = events.slice(events.length - LEGACY_EVENTS_CACHE_MAX);
    }
  }
  legacyActivityEventsCache = { signature, events };
  return events;
}

export function ensureReadStoreDirs(scope = null) {
  ensureGlobalRuntimeDirs();
  mkdirSync(readRoot(), { recursive: true });
  if (scope) {
    ensureScopeRuntimeDirs(scope);
    mkdirSync(historyRoot(scope), { recursive: true });
  }
}

export function appendPublicEvent(publicEvent) {
  if (!publicEvent) return null;
  ensureReadStoreDirs();
  appendJsonLine(publicEventsPath(), publicEvent);
  return publicEvent;
}

function publicEventsForFilters(events, filters = {}) {
  const scopeId = filters.scopeId || null;
  const jobId = filters.jobId || null;
  const since = filters.since || null;
  const levels = filters.levels || null;
  return events.filter((event) => {
    if (scopeId && event.scope_id !== scopeId) return false;
    if (jobId && event.job_id !== jobId) return false;
    if (since && String(event.ts || "") < since) return false;
    if (levels && event.level && !levels.has(event.level)) return false;
    return true;
  });
}

export function backfillPublicEvents() {
  ensureReadStoreDirs();
  if (existsSync(publicEventsPath())) return;
  for (const activityEvent of loadLegacyActivityEvents()) {
    const publicEvent = publicEventFromActivity(activityEvent);
    if (publicEvent) appendJsonLine(publicEventsPath(), publicEvent);
  }
}

export function loadPublicEvents(limit = 2000, filters = {}) {
  backfillPublicEvents();
  const normalizedLimit =
    limit === null || limit === undefined
      ? null
      : Math.max(0, Math.floor(Number(limit) || 0));
  const scanLimit =
    normalizedLimit === null
      ? PUBLIC_EVENTS_MAX_SCAN_LINES
      : Math.max(normalizedLimit, PUBLIC_EVENTS_MAX_SCAN_LINES);
  if (normalizedLimit === 0) return [];
  const filtered = publicEventsForFilters(
    readLastJsonLines(publicEventsPath(), scanLimit),
    filters,
  );
  if (normalizedLimit === null) return filtered;
  return filtered.slice(-normalizedLimit);
}

export function appendJobHistoryEvent(scope, jobId, historyEvent) {
  if (!historyEvent) return null;
  ensureReadStoreDirs(scope);
  appendJsonLine(jobHistoryPath(scope, jobId), historyEvent);
  pushToHistoryRing(scope?.scope_id || null, jobId, historyEvent);
  return historyEvent;
}

export function backfillJobHistory(scope, jobId) {
  ensureReadStoreDirs(scope);
  const path = jobHistoryPath(scope, jobId);
  if (existsSync(path)) return;
  const events = loadLegacyActivityEvents()
    .filter((event) => event.scope_id === scope.scope_id)
    .filter((event) => event.job_id === jobId)
    .map(publicHistoryEventFromActivity)
    .filter(Boolean)
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  if (events.length === 0) {
    writeFileSync(path, "", "utf8");
    return;
  }
  for (const event of events) {
    appendJsonLine(path, event);
  }
}

// Tail-seek JSONL reader: reads chunks from the end of the file until we've
// accumulated `limit` lines. Avoids parsing the full history (which can be
// 10k+ events) when the caller only needs the last N.
function splitBufferOnNewlines(buffer) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a) continue;
    parts.push(buffer.subarray(start, i));
    start = i + 1;
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function readLastJsonLines(path, limit) {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  if (size === 0) return [];
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(TAIL_SEEK_CHUNK_BYTES);
    let pos = size;
    let carry = Buffer.alloc(0);
    const lines = [];
    while (pos > 0 && lines.length <= limit) {
      const len = Math.min(TAIL_SEEK_CHUNK_BYTES, pos);
      pos -= len;
      readSync(fd, chunk, 0, len, pos);
      const head = chunk.subarray(0, len);
      const combined = carry.length ? Buffer.concat([head, carry]) : head;
      const parts = splitBufferOnNewlines(combined);
      // If we're not at BOF, the first fragment may be an incomplete line —
      // carry the raw bytes forward so UTF-8 code points survive chunk splits.
      carry =
        pos > 0
          ? Buffer.from(parts.shift() ?? Buffer.alloc(0))
          : Buffer.alloc(0);
      for (let i = parts.length - 1; i >= 0 && lines.length <= limit; i--) {
        const line = parts[i];
        if (line.length) lines.unshift(line.toString("utf8"));
      }
    }
    if (carry.length && lines.length <= limit)
      lines.unshift(carry.toString("utf8"));
    const tail = lines.slice(-limit);
    const parsed = [];
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        /* skip malformed */
      }
    }
    return parsed;
  } finally {
    closeSync(fd);
  }
}

export function loadJobHistory(scope, jobId, limit = 20) {
  backfillJobHistory(scope, jobId);
  return readLastJsonLines(jobHistoryPath(scope, jobId), limit);
}

export function publicEventsFileSize() {
  if (!existsSync(publicEventsPath())) return 0;
  return statSync(publicEventsPath()).size;
}
