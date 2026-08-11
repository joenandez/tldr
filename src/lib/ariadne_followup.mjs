import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { sessionDir } from "./identity_state.mjs";
import { readJsonIfExists } from "./store.mjs";
import { tachyonListenerEligible } from "./tachyon_eligibility.mjs";
import { renderAriadneStopNotice } from "./ariadne_notice.mjs";

export { renderAriadneStopNotice } from "./ariadne_notice.mjs";
export { ARIADNE_BLOCK_CAP } from "./ariadne_notice.mjs";

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function pendingPath(sessionId) {
  return join(sessionDir(sessionId), "ariadne-pending.json");
}

function adjudicationsPath(sessionId) {
  return join(sessionDir(sessionId), "ariadne-adjudications.json");
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function eventBase(type, level, data) {
  return { type, level, scope_id: null, cwd: null, data };
}

function emptyPending(sessionId) {
  return {
    version: "1.0",
    session_id: String(sessionId || ""),
    threads: {},
    updated_at: null,
  };
}

function emptyAdjudications(sessionId) {
  return {
    version: "1.0",
    session_id: String(sessionId || ""),
    markers: {},
    block_count: 0,
    warned: false,
    updated_at: null,
  };
}

export function readAriadnePending(sessionId) {
  if (!sessionId) return emptyPending(sessionId);
  const row = readJsonIfExists(pendingPath(sessionId), null);
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return emptyPending(sessionId);
  }
  return {
    ...emptyPending(sessionId),
    ...row,
    threads:
      row.threads &&
      typeof row.threads === "object" &&
      !Array.isArray(row.threads)
        ? row.threads
        : {},
  };
}

export function readAriadneAdjudications(sessionId) {
  if (!sessionId) return emptyAdjudications(sessionId);
  const row = readJsonIfExists(adjudicationsPath(sessionId), null);
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return emptyAdjudications(sessionId);
  }
  return {
    ...emptyAdjudications(sessionId),
    ...row,
    markers:
      row.markers &&
      typeof row.markers === "object" &&
      !Array.isArray(row.markers)
        ? row.markers
        : {},
    block_count: Number.isInteger(row.block_count) ? row.block_count : 0,
    warned: row.warned === true,
  };
}

function writeAdjudications(sessionId, row, at = new Date()) {
  const next = {
    ...row,
    version: "1.0",
    session_id: String(sessionId),
    updated_at: nowIso(at),
  };
  atomicWriteJson(adjudicationsPath(sessionId), next);
  return next;
}

export function recordAriadnePendingOutbound({
  sessionId,
  threadId,
  messageId,
  bodyPreview = "",
  sentAt = nowIso(),
  emit = appendActivityEvent,
} = {}) {
  if (!sessionId || !threadId || !messageId) {
    return { recorded: false, reason: "missing_ariadne_pending_fields" };
  }
  try {
    const prior = readAriadnePending(sessionId);
    const next = {
      version: "1.0",
      session_id: String(sessionId),
      threads: {
        ...prior.threads,
        [String(threadId)]: {
          latest_message_id: String(messageId),
          body_preview: String(bodyPreview || "").slice(0, 120),
          sent_at: nowIso(sentAt),
        },
      },
      updated_at: nowIso(sentAt),
    };
    atomicWriteJson(pendingPath(sessionId), next);
    return { recorded: true, path: pendingPath(sessionId), row: next };
  } catch (error) {
    emit(
      eventBase("ariadne_pending_record_failed", "warn", {
        session_id: String(sessionId),
        thread_id: String(threadId),
        message_id: String(messageId),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { recorded: false, reason: "ariadne_pending_write_failed" };
  }
}

export function computePendingSet({ sessionId } = {}) {
  const pending = readAriadnePending(sessionId);
  const adjudications = readAriadneAdjudications(sessionId);
  return Object.entries(pending.threads)
    .filter(([threadId, row]) => {
      return (
        row &&
        typeof row === "object" &&
        row.latest_message_id &&
        (row.tldr_agent_candidate !== true || row.followup_required === true) &&
        adjudications.markers[threadId]?.covered_message_id !==
          row.latest_message_id
      );
    })
    .map(([threadId, row]) => ({
      thread_id: threadId,
      latest_message_id: row.latest_message_id,
      body_preview: row.body_preview || "",
      sent_at: row.sent_at || null,
    }))
    .sort((a, b) => a.thread_id.localeCompare(b.thread_id));
}

export function stampAdjudication({
  sessionId,
  threadId,
  resolution,
  reason = null,
  coveredMessageId,
  firstBlockedMessageId,
  at = new Date(),
  emit = appendActivityEvent,
} = {}) {
  const pending = readAriadnePending(sessionId);
  const current = pending.threads[String(threadId || "")];
  if (!sessionId || !threadId || !current) {
    return { ok: false, changed: false, reason: "unknown_thread" };
  }
  if (resolution === "dismissed" && !String(reason || "").trim()) {
    return { ok: false, changed: false, reason: "missing_reason" };
  }
  if (!new Set(["dismissed", "satisfied"]).has(resolution)) {
    return { ok: false, changed: false, reason: "invalid_resolution" };
  }
  const covered = String(coveredMessageId || current.latest_message_id);
  const store = readAriadneAdjudications(sessionId);
  const prior = store.markers[String(threadId)];
  if (
    prior?.covered_message_id === covered &&
    prior?.resolution === resolution &&
    (resolution !== "dismissed" || prior.reason === String(reason).trim())
  ) {
    return { ok: true, changed: false, marker: prior };
  }
  const marker = {
    covered_message_id: covered,
    resolution,
    reason: resolution === "dismissed" ? String(reason).trim() : null,
    at: nowIso(at),
    first_blocked_message_id:
      firstBlockedMessageId || prior?.first_blocked_message_id || covered,
  };
  const next = writeAdjudications(
    sessionId,
    { ...store, markers: { ...store.markers, [String(threadId)]: marker } },
    at,
  );
  if (resolution === "dismissed") {
    emit(
      eventBase("ariadne_followup_dismissed", "info", {
        session_id: String(sessionId),
        thread_id: String(threadId),
        reason: marker.reason,
        covered_message_id: marker.covered_message_id,
      }),
    );
  }
  return { ok: true, changed: true, marker, row: next };
}

export function markFirstBlocked({ sessionId, pending, at = new Date() } = {}) {
  const store = readAriadneAdjudications(sessionId);
  let changed = false;
  const markers = { ...store.markers };
  for (const item of pending || []) {
    const prior = markers[item.thread_id];
    if (prior?.first_blocked_message_id) continue;
    markers[item.thread_id] = {
      covered_message_id: prior?.covered_message_id || null,
      resolution: prior?.resolution || null,
      reason: prior?.reason || null,
      at: prior?.at || nowIso(at),
      first_blocked_message_id: item.latest_message_id,
    };
    changed = true;
  }
  if (changed) writeAdjudications(sessionId, { ...store, markers }, at);
  return changed;
}

export function autoSatisfyFollowups({ sessionId, at = new Date() } = {}) {
  const pending = readAriadnePending(sessionId);
  const store = readAriadneAdjudications(sessionId);
  const satisfied = [];
  const markers = { ...store.markers };
  for (const [threadId, outbound] of Object.entries(pending.threads)) {
    const marker = markers[threadId];
    if (
      (outbound?.tldr_agent_candidate === true &&
        outbound?.followup_required === true) ||
      !marker?.first_blocked_message_id ||
      marker.first_blocked_message_id === outbound?.latest_message_id ||
      marker.covered_message_id === outbound?.latest_message_id
    ) {
      continue;
    }
    markers[threadId] = {
      covered_message_id: outbound.latest_message_id,
      resolution: "satisfied",
      reason: null,
      at: nowIso(at),
      first_blocked_message_id: marker.first_blocked_message_id,
    };
    satisfied.push(threadId);
  }
  if (satisfied.length > 0) {
    writeAdjudications(sessionId, { ...store, markers }, at);
    resetBlockCountIfClear({ sessionId, at });
  }
  return { satisfied };
}

export function incrementBlockCount({ sessionId, at = new Date() } = {}) {
  const store = readAriadneAdjudications(sessionId);
  const blockCount = store.block_count + 1;
  writeAdjudications(sessionId, { ...store, block_count: blockCount }, at);
  return blockCount;
}

export function markWarned({ sessionId, at = new Date() } = {}) {
  const store = readAriadneAdjudications(sessionId);
  if (store.warned) return false;
  writeAdjudications(sessionId, { ...store, warned: true }, at);
  return true;
}

export function resetBlockCountIfClear({ sessionId, at = new Date() } = {}) {
  if (computePendingSet({ sessionId }).length > 0) return false;
  const store = readAriadneAdjudications(sessionId);
  if (store.block_count === 0) return false;
  writeAdjudications(sessionId, { ...store, block_count: 0 }, at);
  return true;
}

export function runAriadneStopGate({
  sessionId,
  identity = null,
  env = process.env,
  now = new Date(),
} = {}) {
  if (!sessionId || env?.HELM_ARIADNE_DISABLE === "1") {
    return { action: "allow", pending: [], blockCount: 0, notice: null };
  }
  autoSatisfyFollowups({ sessionId, at: now });
  const pending = computePendingSet({ sessionId });
  if (pending.length === 0) {
    resetBlockCountIfClear({ sessionId, at: now });
    return { action: "allow", pending, blockCount: 0, notice: null };
  }
  const store = readAriadneAdjudications(sessionId);
  if (tachyonListenerEligible({ sessionId, identity })) {
    if (!markWarned({ sessionId, at: now })) {
      return {
        action: "allow",
        pending,
        blockCount: store.block_count,
        notice: null,
      };
    }
    return {
      action: "warn",
      pending,
      blockCount: store.block_count,
      notice: renderAriadneStopNotice({ kind: "warn", pending, now }),
    };
  }
  return {
    action: "allow",
    pending,
    blockCount: store.block_count,
    notice: null,
  };
}
