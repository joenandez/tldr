import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readIdentity, readState } from "./identity_state.mjs";
import { isProcessAlive } from "./process_liveness.mjs";
import {
  getBlockingStopHookTachyonListener,
  getFreshTachyonListener,
} from "./tachyon_listener_read.mjs";
import { tachyonListenerEligible } from "./tachyon_eligibility.mjs";

const VALID_EXECUTION_STATES = new Set(["busy", "idle"]);
const FAILED_BLOCKING_LISTENER_REASONS = new Set([
  "missing_hook_wait_state",
  "hook_pid_dead",
  "hook_parent_dead",
  "hook_reparented",
  "hook_ppid_unknown",
]);

export function immutableOwnerCwd(identity) {
  const cwd = identity?.cwd;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  try {
    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}

function pidCandidate(value, source) {
  const pid = Number(value);
  if (!Number.isFinite(pid) || pid <= 1) return null;
  return { pid, source };
}

function resolveLivePid({ identity, state, isPidAlive = isProcessAlive }) {
  const candidates = [
    pidCandidate(identity?.pid, "identity.pid"),
    pidCandidate(state?.last_pid, "state.last_pid"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isPidAlive(candidate.pid)) {
      return { alive: true, pid: candidate.pid, source: candidate.source };
    }
  }
  const fallback = candidates[0] || null;
  return {
    alive: false,
    pid: fallback?.pid || null,
    source: fallback?.source || null,
  };
}

export function classifySessionOwnerState({
  sessionId,
  identity = readIdentity(sessionId),
  state = readState(sessionId),
  now = new Date().toISOString(),
  isPidAlive = isProcessAlive,
  listenerEligible = tachyonListenerEligible,
  getFreshListener = getFreshTachyonListener,
  getBlockingListener = getBlockingStopHookTachyonListener,
} = {}) {
  const liveness = resolveLivePid({ identity, state, isPidAlive });
  const listener = sessionId
    ? getFreshListener({ sessionId, now: new Date(now).toISOString() })
    : { fresh: false, listener: null, reason: "missing_session_id" };
  const blockingListener = sessionId
    ? getBlockingListener({ sessionId, now: new Date(now).toISOString() })
    : { eligible: false, reason: "missing_session_id" };
  const eligible = Boolean(listenerEligible({ sessionId, identity }));
  const executionState = VALID_EXECUTION_STATES.has(state?.state)
    ? state.state
    : null;

  const base = {
    state: "dead",
    alive: liveness.alive,
    pid: liveness.pid,
    source: liveness.source,
    identity,
    stateRow: state,
    executionState,
    listener: listener.listener || null,
    listenerFresh: Boolean(listener.fresh),
    listenerEligible: eligible,
    listenerReason: listener.reason || null,
    listenerBlockingEligible: Boolean(blockingListener.eligible),
    listenerBlockingReason: blockingListener.reason || null,
    listenerWaitStateEvidence: blockingListener.wait_state_evidence || null,
    lastHeartbeatAgeMs: listener.last_heartbeat_age_ms ?? null,
  };

  if (!liveness.alive) return base;
  if (eligible && listener.fresh) {
    return { ...base, state: "alive_listening" };
  }
  if (!executionState) return { ...base, state: "alive_unknown" };
  if (executionState === "idle") return { ...base, state: "alive_idle" };
  return { ...base, state: "alive_busy" };
}

export function hasFailedTachyonListener(ownerState) {
  if (
    ownerState?.listener &&
    ownerState.listenerFresh &&
    FAILED_BLOCKING_LISTENER_REASONS.has(ownerState.listenerBlockingReason)
  ) {
    return true;
  }
  if (!ownerState?.listener || ownerState.listenerFresh) return false;
  const listenerState = ownerState.listener.state || null;
  if (listenerState === "ended") return true;
  if (ownerState.listener.terminal_reason) return true;
  return ownerState.listenerReason === "stale_or_terminal";
}
