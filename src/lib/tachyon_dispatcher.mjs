import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import {
  ackTachyonDelivery,
  beginTachyonDelivery,
  markTachyonDeliveryMissed,
  readTachyonDelivery,
} from "./tachyon_listener_delivery.mjs";
import {
  markTachyonListenerEnded,
  signalTachyonWake,
} from "./tachyon_listener.mjs";
import { getBlockingStopHookTachyonListener } from "./tachyon_listener_read.mjs";

function numericTimeout(value, fallback = 1500) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const TACHYON_LISTENER_RECOVERY_REASONS = new Set([
  "ack_missed",
  "stale_or_terminal",
  "missing_hook_wait_state",
  "hook_pid_dead",
  "hook_parent_dead",
  "hook_reparented",
  "hook_ppid_unknown",
]);

export function shouldRecoverFromTachyonLiveFailure(reason) {
  return TACHYON_LISTENER_RECOVERY_REASONS.has(reason);
}

export async function tryTachyonLiveDelivery({
  scope,
  sessionId,
  messageId,
  pidAlive,
  liveSessionEligible = false,
  waitForAck,
  recordDecision,
} = {}) {
  const ackTimeoutMs = numericTimeout(process.env.HELM_TACHYON_ACK_TIMEOUT_MS);
  const listener = getBlockingStopHookTachyonListener({ sessionId });
  if (listener.eligible && liveSessionEligible && pidAlive) {
    const begun = beginTachyonDelivery({
      scope,
      sessionId,
      messageId,
      ownerId: listener.listener?.owner_id || null,
      ackDeadlineMs: ackTimeoutMs,
    });
    if (begun.begun) {
      signalTachyonWake({ sessionId, messageId });
      const ack = await waitForAck({
        sessionId,
        messageId,
        timeoutMs: ackTimeoutMs,
      });
      if (ack?.acked) {
        ackTachyonDelivery({
          scope,
          sessionId,
          messageId,
          ownerId: listener.listener?.owner_id || null,
        });
        recordDecision(scope, messageId, "live_listener_acked", {
          session_id: sessionId,
          listener_owner_id: listener.listener?.owner_id || null,
          acked_at: ack.acked_at || null,
          ack_elapsed_ms: ack.elapsed_ms ?? null,
          tachyon_wait_state: listener.wait_state_evidence || null,
        });
        appendActivityEvent({
          type: "comms_dispatcher_decision",
          level: "info",
          scope_id: scope.scope_id ?? null,
          cwd: scope.cwd ?? null,
          data: {
            message_id: messageId,
            decision: "live_listener_acked",
            session_id: sessionId,
            listener_state: "acked",
            listener_owner_id: listener.listener?.owner_id || null,
            last_heartbeat_age_ms: listener.last_heartbeat_age_ms ?? null,
            fallback_reason: null,
            ...(listener.wait_state_evidence || {}),
          },
        });
        return { handled: true, decision: "live_listener_acked" };
      }
      markTachyonDeliveryMissed({
        scope,
        sessionId,
        messageId,
        fallbackReason: ack?.reason || "ack_timeout",
      });
      markTachyonListenerEnded({
        sessionId,
        ownerId: listener.listener?.owner_id || null,
        terminalReason: "ack_missed",
      });
    }
    return { handled: false, reason: "ack_missed" };
  }
  if (listener.listener && !listener.eligible) {
    appendActivityEvent({
      type: "tachyon_listener_stale",
      level: "warn",
      scope_id: scope.scope_id ?? null,
      cwd: scope.cwd ?? null,
      data: {
        message_id: messageId,
        session_id: sessionId,
        decision: "live_listener_fallback",
        listener_state: listener.listener?.state || null,
        terminal_reason: listener.listener?.terminal_reason || null,
        last_heartbeat_age_ms: listener.last_heartbeat_age_ms ?? null,
        fallback_reason: listener.reason || "stale_listener",
        ...(listener.wait_state_evidence || {}),
      },
    });
  }
  return { handled: false, reason: listener.reason || "not_eligible" };
}

export async function waitForTachyonAck({
  sessionId,
  messageId,
  timeoutMs = 1500,
} = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const delivery = readTachyonDelivery({ sessionId, messageId });
    if (delivery?.state === "acked") {
      return {
        acked: true,
        acked_at: delivery.acked_at || null,
        elapsed_ms: Date.now() - started,
      };
    }
    if (delivery?.state === "missed" || delivery?.state === "fallback") {
      return {
        acked: false,
        reason: delivery.fallback_reason || delivery.state,
        elapsed_ms: Date.now() - started,
      };
    }
    // eslint-disable-next-line no-await-in-loop -- bounded polling waits for the listener ack file to change.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    acked: false,
    reason: "ack_timeout",
    elapsed_ms: Date.now() - started,
  };
}
