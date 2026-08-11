import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { helmHome, readJsonIfExists, writeJsonAtomic } from "../store.mjs";
import { helmSessionsRoot, sessionDir } from "../identity_state.mjs";
import { getThread, listMessagesForThread } from "./canonical_store.mjs";

const DEFAULT_MAX_RETRIES = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_THRESHOLD = 10;

function nowIso() {
  return new Date().toISOString();
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore malformed inbox rows */
    }
  }
  return out;
}

function atomicWriteText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export function blockedUnreadMarkerPath({ home = helmHome() } = {}) {
  return join(home, "email", "blocked-unread-since.ts");
}

export function blockedAttemptPath(scope) {
  void scope;
  return join(helmHome(), "email", "blocked-retries.json");
}

export function readStatePath(sessionId) {
  return join(sessionDir(sessionId), "inbox-read-state.json");
}

export function bootstrapBlockedUnreadMarker(
  _scope = null,
  { home = helmHome(), now = nowIso } = {},
) {
  const path = blockedUnreadMarkerPath({ home });
  if (existsSync(path)) {
    return {
      ok: true,
      path,
      created: false,
      value: readFileSync(path, "utf8").trim(),
    };
  }
  const value = now();
  try {
    atomicWriteText(path, `${value}\n`);
    return { ok: true, path, created: true, value };
  } catch (err) {
    return { ok: false, path, error: err?.message || String(err) };
  }
}

export function findSessionsBoundToThread(scope, threadId) {
  if (!scope || !threadId) return [];
  const sessions = new Set();
  const thread = getThread(scope, threadId);
  if (thread?.owner_session_id) sessions.add(String(thread.owner_session_id));
  for (const key of ["owner_session_ids", "bound_session_ids", "session_ids"]) {
    if (Array.isArray(thread?.[key])) {
      for (const id of thread[key]) {
        if (id) sessions.add(String(id));
      }
    }
  }
  for (const row of listMessagesForThread(scope, threadId)) {
    const meta = row.metadata || {};
    const id = meta.originator_session_id || meta.session_id || null;
    if (id) sessions.add(String(id));
  }
  return Array.from(sessions).sort();
}

function sessionsWithThread(threadId) {
  const root = helmSessionsRoot();
  if (!existsSync(root)) return [];
  const out = [];
  for (const sessionId of readdirSync(root).filter(
    (name) => !name.startsWith("."),
  )) {
    const inbox = join(root, sessionId, "inbox.jsonl");
    if (!existsSync(inbox)) continue;
    if (readJsonl(inbox).some((row) => row?.thread_id === threadId))
      out.push(sessionId);
  }
  return out.sort();
}

function markerTimestamp() {
  const path = blockedUnreadMarkerPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function rowTimestampMs(row) {
  const raw =
    row?.created_at || row?.queued_at || row?.ts || row?.scheduled_for || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function isAfterRollout(row, rolloutMs) {
  if (rolloutMs === null) return false;
  return rowTimestampMs(row) >= rolloutMs;
}

function readShadow(sessionId) {
  return readJsonIfExists(readStatePath(sessionId), {});
}

export function hasReadInboxMessage({
  sessionId,
  messageId,
  atOrBefore = null,
} = {}) {
  if (!sessionId || !messageId) return false;
  const readAt = Date.parse(readShadow(sessionId)[messageId]?.read_ts || "");
  if (!Number.isFinite(readAt)) return false;
  if (!atOrBefore) return true;
  const boundary = Date.parse(atOrBefore);
  return Number.isFinite(boundary) && readAt <= boundary;
}

function excerpt(row) {
  const body = String(row?.body || "");
  if (body.length <= 160) return body;
  return `${body.slice(0, 157)}...`;
}

export function checkUnreadBeforeDispatch({
  scope,
  threadId,
  sessionId = null,
  target = null,
  idempotencyKey = null,
} = {}) {
  void target;
  void idempotencyKey;
  if (!scope || !threadId)
    return { ok: true, data: { thread_id: threadId || null, unread_count: 0 } };
  const rolloutMs = markerTimestamp();
  if (rolloutMs === null)
    return { ok: true, data: { thread_id: threadId, unread_count: 0 } };

  let candidateSessions = sessionId
    ? [String(sessionId)]
    : findSessionsBoundToThread(scope, threadId);
  if (candidateSessions.length === 0)
    candidateSessions = sessionsWithThread(threadId);

  const unread = [];
  for (const sid of candidateSessions) {
    const inbox = join(sessionDir(sid), "inbox.jsonl");
    const shadow = readShadow(sid);
    for (const row of readJsonl(inbox)) {
      if (row?.thread_id !== threadId) continue;
      if (!isAfterRollout(row, rolloutMs)) continue;
      const messageId = row.message_id;
      if (!messageId || shadow[messageId]) continue;
      unread.push({ session_id: sid, row });
    }
  }

  if (unread.length === 0) {
    return { ok: true, data: { thread_id: threadId, unread_count: 0 } };
  }
  unread.sort((a, b) => rowTimestampMs(a.row) - rowTimestampMs(b.row));
  const latest = unread[unread.length - 1];
  return {
    ok: false,
    code: "blocked_unread",
    data: {
      thread_id: threadId,
      unread_count: unread.length,
      latest_message_id: latest.row.message_id,
      latest_excerpt: excerpt(latest.row),
      latest_ts:
        latest.row.created_at ||
        latest.row.queued_at ||
        latest.row.ts ||
        latest.row.scheduled_for ||
        null,
      session_ids: Array.from(
        new Set(unread.map((item) => item.session_id)),
      ).sort(),
      hint: `helm-tasks inbox get ${latest.row.message_id}`,
    },
  };
}

export function tupleKey({
  target = null,
  threadId = null,
  senderSessionId = null,
} = {}) {
  const raw = JSON.stringify({
    target: target || null,
    thread_id: threadId || null,
    sender_session_id: senderSessionId || null,
  });
  return createHash("sha256").update(raw).digest("hex");
}

function loadAttemptState(scope) {
  const parsed = readJsonIfExists(blockedAttemptPath(scope), null);
  if (!parsed || typeof parsed !== "object" || !parsed.entries) {
    return { version: "1.0", entries: {} };
  }
  return parsed;
}

function writeAttemptState(scope, state) {
  writeJsonAtomic(blockedAttemptPath(scope), state);
}

export function recordBlockedAttempt({
  scope,
  tupleKey: key,
  at = nowIso(),
} = {}) {
  if (!scope || !key) return { ok: false, attempt: 0 };
  const state = loadAttemptState(scope);
  const entry = state.entries[key] || { attempts: [] };
  entry.attempts = [...(entry.attempts || []), at].slice(-100);
  state.entries[key] = entry;
  writeAttemptState(scope, state);
  return { ok: true, attempt: entry.attempts.length, tuple_key: key };
}

export function clearBlockedAttempt({ scope, tupleKey: key } = {}) {
  if (!scope || !key) return { ok: true, cleared: false };
  const state = loadAttemptState(scope);
  if (!state.entries[key]) return { ok: true, cleared: false };
  delete state.entries[key];
  writeAttemptState(scope, state);
  return { ok: true, cleared: true };
}

export function shouldEscalateToRepeated({
  scope,
  tupleKey: key,
  maxRetries = DEFAULT_MAX_RETRIES,
  now = new Date(),
} = {}) {
  if (!scope || !key) return false;
  const state = loadAttemptState(scope);
  const attempts = Array.isArray(state.entries[key]?.attempts)
    ? state.entries[key].attempts
    : [];
  const max = Number.isFinite(Number(maxRetries))
    ? Number(maxRetries)
    : DEFAULT_MAX_RETRIES;
  if (attempts.length > max) return true;
  const cutoff = now.getTime() - RATE_LIMIT_WINDOW_MS;
  const recent = attempts.filter((ts) => {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) && ms >= cutoff;
  });
  return recent.length > RATE_LIMIT_THRESHOLD;
}

export function markRead({
  scope = null,
  sessionId,
  messageId,
  via = "unknown",
  now = new Date(),
} = {}) {
  void scope;
  if (!sessionId || !messageId) return { ok: false, error: "missing_required" };
  const path = readStatePath(sessionId);
  const prior = readJsonIfExists(path, {});
  if (prior[messageId]) {
    bootstrapBlockedUnreadMarker(scope);
    return { ok: true, path, changed: false };
  }
  const next = {
    ...prior,
    [messageId]: {
      read_ts: now.toISOString(),
      read_via: via,
    },
  };
  writeJsonAtomic(path, next);
  bootstrapBlockedUnreadMarker(scope);
  return { ok: true, path, changed: true };
}
