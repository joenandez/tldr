import {
  getTransportState,
  mutateTransportState,
} from "./substrate/canonical_store.mjs";

const LIFECYCLE_VERSION = 1;

function initializedLifecycle(prior, now) {
  return {
    version: LIFECYCLE_VERSION,
    state: "received",
    received_at: now,
    updated_at: now,
    attempt_count: 0,
    next_retry_at: null,
    last_error_code: null,
    lease: null,
    inbox: null,
    presentation: null,
    reply: null,
    terminal: null,
    ...(prior || {}),
  };
}

export function readTldrAgentInbound(scope, messageId) {
  return getTransportState(scope, messageId)?.tldr_agent_inbound || null;
}

export function mutateTldrAgentInbound({
  scope,
  messageId,
  now = new Date(),
  mutate,
} = {}) {
  if (!scope || !messageId || typeof mutate !== "function") return null;
  const updatedAt = now.toISOString();
  const next = mutateTransportState(scope, messageId, (transportState) => {
    const lifecycle = initializedLifecycle(
      transportState.tldr_agent_inbound,
      updatedAt,
    );
    const update = mutate(lifecycle, transportState) || {};
    return {
      tldr_agent_inbound: {
        ...lifecycle,
        ...update,
        version: LIFECYCLE_VERSION,
        updated_at: updatedAt,
      },
    };
  });
  return next?.tldr_agent_inbound || null;
}

export const TLDR_AGENT_INBOUND_LIFECYCLE_VERSION = LIFECYCLE_VERSION;
