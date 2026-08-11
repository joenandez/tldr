import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { readJsonIfExists } from "./store.mjs";
import { sessionDir } from "./identity_state.mjs";
import { tachyonWaitStatePayload } from "./tachyon_listener_wait_state.mjs";
const LIVE_STATES = new Set(["listening", "delivering"]);
export {
  ackTachyonDelivery,
  beginTachyonDelivery,
  markTachyonDeliveryMissed,
  readTachyonDelivery,
} from "./tachyon_listener_delivery.mjs";
function nowIso() {
  return new Date().toISOString();
}
function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}
function isNil(value) {
  return value === null || value === undefined;
}
function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
function listenerPath(sessionId) {
  return join(sessionDir(sessionId), "tachyon-listener.json");
}
function wakePath(sessionId) {
  return join(sessionDir(sessionId), "tachyon-wake.json");
}
function deliveryDefaults() {
  return {};
}
function readListener(sessionId) {
  const state = readJsonIfExists(listenerPath(sessionId), null);
  if (!state || typeof state !== "object") return null;
  if (!state.deliveries || typeof state.deliveries !== "object") {
    state.deliveries = deliveryDefaults();
  }
  return state;
}
function writeListener(sessionId, state) {
  atomicWriteJson(listenerPath(sessionId), state);
  return state;
}
function heartbeatAgeMs(listener, atIso = nowIso()) {
  const last = Date.parse(listener?.last_heartbeat_at || "");
  const at = Date.parse(atIso || "");
  if (!Number.isFinite(last) || !Number.isFinite(at)) return null;
  return Math.max(0, at - last);
}
function isFresh(listener, atIso = nowIso()) {
  if (!listener || !LIVE_STATES.has(listener.state)) return false;
  if (listener.terminal_reason) return false;
  if (!listener.deadline_at) return false;
  return String(listener.deadline_at) > String(atIso);
}
function activityPayload({
  sessionId,
  listener,
  messageId = null,
  decision = null,
  terminalReason = null,
  fallbackReason = null,
  at = nowIso(),
} = {}) {
  return {
    message_id: messageId,
    session_id: sessionId,
    decision,
    listener_state: listener?.state || null,
    listener_owner_id: listener?.owner_id || null,
    listener_pid: listener?.pid ?? null,
    terminal_reason: terminalReason,
    last_heartbeat_at: listener?.last_heartbeat_at || null,
    last_heartbeat_age_ms: heartbeatAgeMs(listener, at),
    fallback_reason: fallbackReason,
    ...tachyonWaitStatePayload(listener),
  };
}
export function tachyonListenerPaths(sessionId) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  return {
    listener: listenerPath(normalizedSessionId),
    wake: wakePath(normalizedSessionId),
  };
}
export function claimTachyonListener({
  sessionId,
  ownerId = `listener_${process.pid}_${randomBytes(4).toString("hex")}`,
  pid = process.pid,
  hookPid = null,
  hookPpid = null,
  agentPid = null,
  runtime = null,
  waitState = null,
  leaseMs = 30000,
  now = nowIso(),
} = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const normalizedOwnerId = requireString(ownerId, "ownerId");
  const at = requireString(now, "now");
  const prior = readListener(normalizedSessionId);
  if (prior && isFresh(prior, at) && prior.owner_id !== normalizedOwnerId) {
    return {
      claimed: false,
      reason: "listener_in_flight",
      session_id: normalizedSessionId,
      owner_id: normalizedOwnerId,
      blocking_owner_id: prior.owner_id || null,
      deadline_at: prior.deadline_at || null,
    };
  }
  const state = {
    version: 1,
    session_id: normalizedSessionId,
    owner_id: normalizedOwnerId,
    pid: isNil(pid) ? null : Number(pid),
    hook_pid: isNil(hookPid) ? null : Number(hookPid),
    hook_ppid: isNil(hookPpid) ? null : Number(hookPpid),
    agent_pid: isNil(agentPid)
      ? isNil(pid)
        ? null
        : Number(pid)
      : Number(agentPid),
    runtime: typeof runtime === "string" && runtime ? runtime : null,
    wait_state: typeof waitState === "string" && waitState ? waitState : null,
    state: "listening",
    claimed_at:
      prior?.owner_id === normalizedOwnerId ? prior.claimed_at || at : at,
    last_heartbeat_at: at,
    deadline_at: new Date(
      Date.parse(at) + Math.max(1, Number(leaseMs) || 30000),
    ).toISOString(),
    ended_at: null,
    terminal_reason: null,
    current_message_id: null,
    deliveries:
      prior?.deliveries && typeof prior.deliveries === "object"
        ? prior.deliveries
        : {},
  };
  writeListener(normalizedSessionId, state);
  appendActivityEvent({
    type: "tachyon_listener_registered",
    level: "debug",
    data: activityPayload({
      sessionId: normalizedSessionId,
      listener: state,
      at,
    }),
  });
  return {
    claimed: true,
    session_id: normalizedSessionId,
    owner_id: normalizedOwnerId,
    deadline_at: state.deadline_at,
  };
}
export function refreshTachyonListener({
  sessionId,
  ownerId,
  leaseMs = 30000,
  now = nowIso(),
} = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const normalizedOwnerId = requireString(ownerId, "ownerId");
  const at = requireString(now, "now");
  const prior = readListener(normalizedSessionId);
  if (
    !prior ||
    prior.owner_id !== normalizedOwnerId ||
    !LIVE_STATES.has(prior.state)
  ) {
    return { refreshed: false, reason: "listener_not_owned" };
  }
  const next = {
    ...prior,
    last_heartbeat_at: at,
    hook_pid: prior.hook_pid ?? null,
    hook_ppid: prior.hook_ppid ?? null,
    agent_pid: prior.agent_pid ?? prior.pid ?? null,
    runtime: prior.runtime ?? null,
    wait_state: prior.wait_state ?? null,
    deadline_at: new Date(
      Date.parse(at) + Math.max(1, Number(leaseMs) || 30000),
    ).toISOString(),
  };
  writeListener(normalizedSessionId, next);
  appendActivityEvent({
    type: "tachyon_listener_heartbeat",
    level: "debug",
    data: activityPayload({
      sessionId: normalizedSessionId,
      listener: next,
      at,
    }),
  });
  return {
    refreshed: true,
    session_id: normalizedSessionId,
    owner_id: normalizedOwnerId,
    deadline_at: next.deadline_at,
  };
}
export function markTachyonListenerEnded({
  sessionId,
  ownerId = null,
  terminalReason = "process_exit",
  now = nowIso(),
} = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const at = requireString(now, "now");
  const prior = readListener(normalizedSessionId);
  if (!prior) return { ended: false, reason: "missing_listener" };
  if (ownerId && prior.owner_id !== ownerId) {
    return { ended: false, reason: "listener_not_owned" };
  }
  const next = {
    ...prior,
    state: "ended",
    ended_at: at,
    terminal_reason: terminalReason,
  };
  writeListener(normalizedSessionId, next);
  appendActivityEvent({
    type: "tachyon_listener_terminal",
    level: terminalReason === "delivered" ? "info" : "warn",
    data: activityPayload({
      sessionId: normalizedSessionId,
      listener: next,
      terminalReason,
      at,
    }),
  });
  return {
    ended: true,
    session_id: normalizedSessionId,
    owner_id: next.owner_id,
    terminal_reason: terminalReason,
  };
}
export function signalTachyonWake({
  sessionId,
  messageId,
  now = nowIso(),
} = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const normalizedMessageId = requireString(messageId, "messageId");
  const payload = {
    version: 1,
    session_id: normalizedSessionId,
    message_id: normalizedMessageId,
    signaled_at: requireString(now, "now"),
    nonce: randomBytes(8).toString("hex"),
  };
  atomicWriteJson(wakePath(normalizedSessionId), payload);
  return payload;
}
export function readTachyonListener(sessionId) {
  return readListener(requireString(sessionId, "sessionId"));
}
