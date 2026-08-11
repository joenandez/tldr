import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { sessionDir } from "./identity_state.mjs";
import { readJsonIfExists } from "./store.mjs";
import { updateTransportState } from "./substrate/canonical_store.mjs";
import { tachyonWaitStatePayload } from "./tachyon_listener_wait_state.mjs";

const LIVE_STATES = new Set(["listening", "delivering"]);
const TERMINAL_DELIVERY_STATES = new Set(["acked", "missed", "fallback"]);

function nowIso() {
  return new Date().toISOString();
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
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

function readListener(sessionId) {
  const state = readJsonIfExists(listenerPath(sessionId), null);
  if (!state || typeof state !== "object") return null;
  if (!state.deliveries || typeof state.deliveries !== "object") {
    state.deliveries = {};
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

export function beginTachyonDelivery({
  scope,
  sessionId,
  messageId,
  ownerId = null,
  ackDeadlineMs = 1000,
  now = nowIso(),
} = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const normalizedMessageId = requireString(messageId, "messageId");
  const at = requireString(now, "now");
  const prior = readListener(normalizedSessionId);
  if (!isFresh(prior, at)) {
    return {
      begun: false,
      reason: prior ? "stale_listener" : "missing_listener",
    };
  }
  if (ownerId && prior.owner_id !== ownerId) {
    return { begun: false, reason: "listener_not_owned" };
  }
  const existing = prior.deliveries?.[normalizedMessageId] || null;
  if (existing && TERMINAL_DELIVERY_STATES.has(existing.state)) {
    return {
      begun: false,
      reason: `already_${existing.state}`,
      delivery: existing,
      terminal: true,
    };
  }
  const delivery =
    existing?.state === "pending"
      ? existing
      : {
          message_id: normalizedMessageId,
          state: "pending",
          began_at: at,
          ack_deadline_at: new Date(
            Date.parse(at) + Math.max(1, Number(ackDeadlineMs) || 1000),
          ).toISOString(),
          acked_at: null,
          missed_at: null,
          fallback_reason: null,
        };
  const next = {
    ...prior,
    state: "delivering",
    current_message_id: normalizedMessageId,
    deliveries: {
      ...(prior.deliveries || {}),
      [normalizedMessageId]: delivery,
    },
  };
  writeListener(normalizedSessionId, next);
  if (scope) {
    updateTransportState(scope, normalizedMessageId, {
      tachyon_delivery_state: "pending",
      tachyon_delivery_began_at: delivery.began_at,
      tachyon_listener_owner_id: next.owner_id || null,
      tachyon_ack_deadline_at: delivery.ack_deadline_at,
    });
  }
  appendActivityEvent({
    type: "tachyon_listener_delivery",
    level: "debug",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: activityPayload({
      sessionId: normalizedSessionId,
      listener: next,
      messageId: normalizedMessageId,
      decision: "delivery_pending",
      at,
    }),
  });
  return {
    begun: true,
    session_id: normalizedSessionId,
    message_id: normalizedMessageId,
    delivery,
    listener: next,
  };
}

export function ackTachyonDelivery({
  scope = null,
  sessionId,
  messageId,
  ownerId = null,
  now = nowIso(),
} = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const normalizedMessageId = requireString(messageId, "messageId");
  const at = requireString(now, "now");
  const prior = readListener(normalizedSessionId);
  if (!prior) return { acked: false, reason: "missing_listener" };
  if (ownerId && prior.owner_id !== ownerId) {
    return { acked: false, reason: "listener_not_owned" };
  }
  const existing = prior.deliveries?.[normalizedMessageId] || null;
  if (existing?.state === "acked") {
    if (scope) {
      updateTransportState(scope, normalizedMessageId, {
        tachyon_delivery_state: "acked",
        tachyon_delivery_acked_at: existing.acked_at || at,
        tachyon_listener_owner_id: prior.owner_id || null,
      });
    }
    return {
      acked: true,
      duplicate: true,
      session_id: normalizedSessionId,
      message_id: normalizedMessageId,
    };
  }
  if (existing && TERMINAL_DELIVERY_STATES.has(existing.state)) {
    return { acked: false, reason: `already_${existing.state}` };
  }
  const delivery = {
    ...(existing || { message_id: normalizedMessageId, began_at: at }),
    state: "acked",
    acked_at: at,
  };
  const next = {
    ...prior,
    state: "listening",
    current_message_id: null,
    deliveries: {
      ...(prior.deliveries || {}),
      [normalizedMessageId]: delivery,
    },
  };
  writeListener(normalizedSessionId, next);
  if (scope) {
    updateTransportState(scope, normalizedMessageId, {
      tachyon_delivery_state: "acked",
      tachyon_delivery_acked_at: at,
      tachyon_listener_owner_id: next.owner_id || null,
    });
  }
  appendActivityEvent({
    type: "tachyon_listener_ack",
    level: "info",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: activityPayload({
      sessionId: normalizedSessionId,
      listener: next,
      messageId: normalizedMessageId,
      decision: "live_listener_acked",
      terminalReason: "delivered",
      at,
    }),
  });
  return {
    acked: true,
    duplicate: false,
    session_id: normalizedSessionId,
    message_id: normalizedMessageId,
    acked_at: at,
  };
}

export function markTachyonDeliveryMissed({
  scope = null,
  sessionId,
  messageId,
  fallbackReason = "ack_timeout",
  now = nowIso(),
} = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const normalizedMessageId = requireString(messageId, "messageId");
  const at = requireString(now, "now");
  const prior = readListener(normalizedSessionId);
  if (!prior) return { missed: false, reason: "missing_listener" };
  const existing = prior.deliveries?.[normalizedMessageId] || null;
  if (existing?.state === "acked") {
    return { missed: false, reason: "already_acked" };
  }
  if (existing?.state === "missed" || existing?.state === "fallback") {
    return {
      missed: true,
      duplicate: true,
      session_id: normalizedSessionId,
      message_id: normalizedMessageId,
    };
  }
  const delivery = {
    ...(existing || { message_id: normalizedMessageId, began_at: at }),
    state: "missed",
    missed_at: at,
    fallback_reason: fallbackReason,
  };
  const next = {
    ...prior,
    state: "listening",
    current_message_id: null,
    deliveries: {
      ...(prior.deliveries || {}),
      [normalizedMessageId]: delivery,
    },
  };
  writeListener(normalizedSessionId, next);
  if (scope) {
    updateTransportState(scope, normalizedMessageId, {
      tachyon_delivery_state: "missed",
      tachyon_delivery_missed_at: at,
      tachyon_fallback_reason: fallbackReason,
    });
  }
  appendActivityEvent({
    type: "tachyon_listener_ack_missed",
    level: "warn",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: activityPayload({
      sessionId: normalizedSessionId,
      listener: next,
      messageId: normalizedMessageId,
      decision: "live_listener_fallback",
      fallbackReason,
      at,
    }),
  });
  return {
    missed: true,
    duplicate: false,
    session_id: normalizedSessionId,
    message_id: normalizedMessageId,
    fallback_reason: fallbackReason,
  };
}

export function readTachyonDelivery({ sessionId, messageId } = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const normalizedMessageId = requireString(messageId, "messageId");
  const listener = readListener(normalizedSessionId);
  return listener?.deliveries?.[normalizedMessageId] || null;
}
