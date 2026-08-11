import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonIfExists } from "./store.mjs";
import { sessionDir } from "./identity_state.mjs";

const MANAGED_BACKGROUND_SOURCES = new Set([
  "env",
  "helm_job",
  "command_shape",
  "durable_resume",
]);

function nowIso() {
  return new Date().toISOString();
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function normalize(value) {
  return String(value || "unknown")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

export function tachyonListenPolicyForIdentity(identity) {
  const launchMode = normalize(identity?.launch_mode);
  const launchSource = normalize(identity?.launch_source);
  if (launchMode === "interactive") {
    return {
      classification: "live",
      listenPolicy: "hold_open",
      disabledReason: null,
    };
  }
  const explicitlyManaged =
    ["non_interactive", "noninteractive", "headless"].includes(launchMode) &&
    launchSource !== "no_tty" &&
    (MANAGED_BACKGROUND_SOURCES.has(launchSource) ||
      launchSource === "unknown");
  if (explicitlyManaged) {
    return {
      classification: "managed_background",
      listenPolicy: "disabled",
      disabledReason: "managed_background",
    };
  }
  return {
    classification: "unknown",
    listenPolicy: "hold_open",
    disabledReason: null,
  };
}

function replyWaitingPath(sessionId) {
  return join(sessionDir(sessionId), "reply-waiting.json");
}

function readReplyWaitingEmail(sessionId) {
  if (!sessionId) return null;
  const row = readJsonIfExists(replyWaitingPath(sessionId), null);
  if (!row || typeof row !== "object") return null;
  return row;
}

function withoutLegacyMode(row) {
  if (!row || typeof row !== "object") return {};
  const {
    session_mode: _sessionMode,
    delivery_mode: _deliveryMode,
    listen_disabled_reason: _disabledReason,
    ...modeFree
  } = row;
  return modeFree;
}

function hasReplyWaitingEmail(sessionId) {
  const row = readReplyWaitingEmail(sessionId);
  if (!row || row.waiting !== true) return false;
  if (typeof row.last_message_id === "string" && row.last_message_id)
    return true;
  return Array.isArray(row.threads) && row.threads.length > 0;
}

export function recordReplyWaitingEmail({
  sessionId,
  threadId,
  messageId,
  sentAt = nowIso(),
} = {}) {
  if (!sessionId || !threadId || !messageId) {
    return { recorded: false, reason: "missing_reply_waiting_fields" };
  }
  const prior = readReplyWaitingEmail(sessionId);
  const threads = new Set(
    Array.isArray(prior?.threads)
      ? prior.threads.filter(Boolean).map(String)
      : [],
  );
  threads.add(String(threadId));
  const next = {
    version: 1,
    session_id: String(sessionId),
    waiting: true,
    threads: [...threads],
    last_message_id: String(messageId),
    last_sent_at: sentAt,
    last_user_prompt_submit_at:
      typeof prior?.last_user_prompt_submit_at === "string"
        ? prior.last_user_prompt_submit_at
        : null,
    updated_at: nowIso(),
  };
  atomicWriteJson(replyWaitingPath(sessionId), next);
  return { recorded: true, path: replyWaitingPath(sessionId), row: next };
}

export function clearReplyWaitingEmail({ sessionId, threadId } = {}) {
  if (!sessionId || !threadId) {
    return { cleared: false, reason: "missing_reply_waiting_fields" };
  }
  const path = replyWaitingPath(sessionId);
  const prior = readReplyWaitingEmail(sessionId);
  if (!prior || prior.waiting !== true) {
    return { cleared: false, reason: "missing_reply_waiting_email" };
  }
  const normalizedThreadId = String(threadId);
  const threads = Array.isArray(prior.threads)
    ? prior.threads.filter(Boolean).map(String)
    : [];
  if (!threads.includes(normalizedThreadId)) {
    return { cleared: false, reason: "thread_not_waiting" };
  }
  const remainingThreads = threads.filter(
    (candidate) => candidate !== normalizedThreadId,
  );
  if (remainingThreads.length === 0) {
    rmSync(path, { force: true });
    return { cleared: true, path, row: null };
  }
  const next = {
    ...withoutLegacyMode(prior),
    waiting: true,
    threads: remainingThreads,
    last_message_id: null,
    last_sent_at: null,
    updated_at: nowIso(),
  };
  atomicWriteJson(path, next);
  return { cleared: true, path, row: next };
}

export function recordUserPromptSubmitForTachyon({
  sessionId,
  submittedAt = nowIso(),
} = {}) {
  if (!sessionId) {
    return { recorded: false, reason: "missing_session_id" };
  }
  const prior = readReplyWaitingEmail(sessionId);
  if (!prior || prior.waiting !== true) {
    return { recorded: false, reason: "missing_reply_waiting_email" };
  }
  const next = {
    ...withoutLegacyMode(prior),
    last_user_prompt_submit_at: submittedAt,
    updated_at: nowIso(),
  };
  atomicWriteJson(replyWaitingPath(sessionId), next);
  return { recorded: true, path: replyWaitingPath(sessionId), row: next };
}

export function tachyonListenerEligible({ sessionId, identity = null } = {}) {
  if (!sessionId || !hasReplyWaitingEmail(sessionId)) return false;
  return tachyonListenPolicyForIdentity(identity).listenPolicy === "hold_open";
}
