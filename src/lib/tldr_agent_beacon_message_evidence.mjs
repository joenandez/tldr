import {
  getMessage,
  getThread,
  getTransportState,
  updateTransportState,
} from "./substrate/canonical_store.mjs";
import {
  deriveSideEffectKey,
  outboundEffectPayloadMatches,
} from "./outbound_effect_identity.mjs";
import { getBeaconOutboundEffect } from "./tldr_agent_beacon_outbound_effect.mjs";
import {
  beaconLifecycleMutexState,
  fulfillBeaconObligation,
} from "./tldr_agent_beacon_marker.mjs";

const KINDS = {
  confirmation: {
    pointer: "confirmationMessageId",
    purpose: "beacon_confirmation",
  },
  terminal: {
    pointer: "terminalMessageId",
    purpose: "beacon_terminal",
  },
};
const ACCEPTED_DELIVERY = new Set(["sent", "delivered"]);

function nonempty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function effectIdentity(message) {
  return deriveSideEffectKey({
    namespace: "substrate_message",
    logicalEventKey: message.idempotency_key,
    effect: "message",
    channel: message.transport,
    recipient: message.target,
  });
}

function messageMatches(message, marker, kind, sessionId, scope, owner) {
  if (
    message.thread_id !== marker.boundThreadId ||
    message.workspace_id !== scope.scope_id ||
    message.transport !== "email" ||
    message.idempotency_key !== `beacon:${message.message_id}` ||
    message.metadata?.obligation_id !== marker.obligationId ||
    message.metadata?.purpose !== kind.purpose ||
    message.metadata?.originator_session_id !== sessionId ||
    message.metadata?.session_id !== sessionId ||
    (nonempty(owner) && message.target !== `email://${owner}`)
  ) {
    return false;
  }
  return (
    kind.purpose !== "beacon_terminal" ||
    (message.kind === "reply" &&
      nonempty(marker.terminalOutcome) &&
      message.metadata?.terminal_outcome === marker.terminalOutcome)
  );
}

function effectMatches(effect, message) {
  return (
    effect.namespace === "substrate_message" &&
    effect.logical_run_key === null &&
    effect.logical_event_key === message.idempotency_key &&
    effect.channel === message.transport &&
    effect.recipient === message.target &&
    effect.template_version === null &&
    outboundEffectPayloadMatches(effect, {
      payload: {
        kind: message.kind,
        target: message.target,
        subject: message.subject,
        body: message.body,
      },
      renderInputs: {
        workspace_id: message.workspace_id,
        scheduled_for: message.scheduled_for,
      },
    })
  );
}

function classifyEffect(effect, marker, kindName, options) {
  if (!effect) return "incomplete";
  if (effect.status === "attempting") {
    if (kindName !== "terminal") return "incomplete";
    const lockState = beaconLifecycleMutexState(
      {
        scopeId: options.scope.scope_id,
        sessionId: options.sessionId,
        obligationId: marker.obligationId,
      },
      options,
    );
    return lockState === "held" ? "incomplete" : "ambiguous";
  }
  if (effect.status === "failed_definite") return "failed_definite";
  if (effect.status === "ambiguous") return "ambiguous";
  return effect.status === "accepted" ? null : "incomplete";
}

function repairableTransport(transport, providerMessageId) {
  if (!transport) return true;
  if (transport.transport && transport.transport !== "email") return false;
  if (
    nonempty(transport.external_id) &&
    transport.external_id !== providerMessageId
  ) {
    return false;
  }
  return (
    !nonempty(transport.external_id) &&
    (!transport.delivery_state ||
      transport.delivery_state === "pending" ||
      ACCEPTED_DELIVERY.has(transport.delivery_state))
  );
}

function readOnce(marker, kindName, options, allowRepair) {
  const kind = KINDS[kindName];
  if (!kind) throw new TypeError("Beacon evidence kind is invalid");
  const pointer = marker?.[kind.pointer];
  if (!nonempty(pointer)) return "incomplete";

  const message = getMessage(options.scope, pointer);
  if (!message) return "incomplete";
  if (
    !messageMatches(
      message,
      marker,
      kind,
      options.sessionId,
      options.scope,
      options.owner,
    )
  ) {
    return "mismatch";
  }

  const thread = getThread(options.scope, marker.boundThreadId);
  if (!thread) return "incomplete";
  if (
    thread.thread_id !== marker.boundThreadId ||
    (nonempty(thread.owner_session_id) &&
      thread.owner_session_id !== options.sessionId)
  ) {
    return "mismatch";
  }

  const effect = getBeaconOutboundEffect({
    home: options.home,
    sideEffectKey: effectIdentity(message),
  });
  if (effect && !effectMatches(effect, message)) return "mismatch";
  const effectClassification = classifyEffect(
    effect,
    marker,
    kindName,
    options,
  );
  if (effectClassification) return effectClassification;
  if (!nonempty(effect.last_provider_message_id)) return "incomplete";
  if (
    thread.owner_session_id !== options.sessionId ||
    !nonempty(thread.external_thread_id)
  ) {
    return "incomplete";
  }

  const transport = getTransportState(options.scope, pointer);
  if (
    transport &&
    nonempty(transport.external_id) &&
    transport.external_id !== effect.last_provider_message_id
  ) {
    return "mismatch";
  }
  if (
    transport &&
    nonempty(transport.external_thread_id) &&
    transport.external_thread_id !== thread.external_thread_id
  ) {
    return "mismatch";
  }
  if (
    transport?.transport === "email" &&
    ACCEPTED_DELIVERY.has(transport.delivery_state) &&
    transport.external_id === effect.last_provider_message_id &&
    nonempty(transport.external_thread_id) &&
    transport.external_thread_id === thread.external_thread_id
  ) {
    return "accepted";
  }
  if (
    allowRepair &&
    repairableTransport(transport, effect.last_provider_message_id)
  ) {
    updateTransportState(options.scope, pointer, {
      transport: "email",
      delivery_state: "sent",
      external_id: effect.last_provider_message_id,
      external_thread_id: thread.external_thread_id,
      error: null,
    });
    return readOnce(marker, kindName, options, false);
  }
  return "incomplete";
}

export function readBeaconMessageEvidence(marker, kind, options = {}) {
  if (!options.scope || !nonempty(options.sessionId)) {
    throw new TypeError("Beacon evidence scope and session are required");
  }
  return readOnce(marker, kind, options, true);
}

export function reconcileBeaconObligation(marker, options = {}) {
  const confirmation = readBeaconMessageEvidence(
    marker,
    "confirmation",
    options,
  );
  if (confirmation !== "accepted" || !nonempty(marker?.terminalMessageId)) {
    return { evidence: confirmation, changed: false, marker };
  }

  const terminal = readBeaconMessageEvidence(marker, "terminal", options);
  if (terminal !== "accepted" || marker.status !== "pending") {
    return { evidence: terminal, changed: false, marker };
  }

  const fulfilled = fulfillBeaconObligation(
    {
      scopeId: options.scope.scope_id,
      sessionId: options.sessionId,
      obligationId: marker.obligationId,
      acceptedTerminalMessageId: marker.terminalMessageId,
    },
    {
      home: options.home,
      path: options.path,
      now: options.now,
      retryMs: options.retryMs,
      intervalMs: options.intervalMs,
    },
  );
  return fulfilled.ok
    ? {
        evidence: terminal,
        changed: fulfilled.changed,
        marker: fulfilled.marker,
      }
    : { evidence: terminal, changed: false, marker, error: fulfilled.error };
}
