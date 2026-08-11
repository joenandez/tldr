import { readTachyonListener } from "./tachyon_listener.mjs";
import {
  classifyBlockingStopHook,
  tachyonWaitStatePayload,
} from "./tachyon_listener_wait_state.mjs";

const LIVE_STATES = new Set(["listening", "delivering"]);

function nowIso() {
  return new Date().toISOString();
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
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

export function getFreshTachyonListener({ sessionId, now = nowIso() } = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const at = requireString(now, "now");
  const listener = readTachyonListener(normalizedSessionId);
  if (isFresh(listener, at)) return { fresh: true, listener };
  return {
    fresh: false,
    listener,
    reason: listener ? "stale_or_terminal" : "missing_listener",
    last_heartbeat_age_ms: heartbeatAgeMs(listener, at),
  };
}

export function getBlockingStopHookTachyonListener({
  sessionId,
  now = nowIso(),
} = {}) {
  const normalizedSessionId = requireString(sessionId, "sessionId");
  const at = requireString(now, "now");
  const listener = readTachyonListener(normalizedSessionId);
  const ageMs = heartbeatAgeMs(listener, at);
  if (!isFresh(listener, at)) {
    return {
      fresh: false,
      eligible: false,
      listener,
      reason: listener ? "stale_or_terminal" : "missing_listener",
      last_heartbeat_age_ms: ageMs,
      wait_state_evidence: tachyonWaitStatePayload(listener),
    };
  }
  const waitState = classifyBlockingStopHook(listener);
  if (!waitState.eligible) {
    return {
      fresh: true,
      eligible: false,
      listener: waitState.hook_current_ppid
        ? { ...listener, hook_current_ppid: waitState.hook_current_ppid }
        : listener,
      reason: waitState.reason,
      last_heartbeat_age_ms: ageMs,
      wait_state_evidence: {
        ...tachyonWaitStatePayload(listener),
        hook_current_ppid:
          waitState.hook_current_ppid ?? listener?.hook_current_ppid ?? null,
      },
    };
  }
  const eligibleListener = {
    ...listener,
    hook_current_ppid: waitState.hook_current_ppid,
  };
  return {
    fresh: true,
    eligible: true,
    listener: eligibleListener,
    reason: null,
    last_heartbeat_age_ms: ageMs,
    wait_state_evidence: tachyonWaitStatePayload(eligibleListener),
  };
}
