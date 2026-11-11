// Shared fixed policy for opaque reply bindings and endpoint listeners.
// It is static contract data, so protocol is the lowest legal shared layer
// for both daemon enforcement and CLI hook timeout derivation.

export const REPLY_BINDING_POLICY = Object.freeze({
  bindingLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  providerAcceptanceGraceMs: 30 * 1000,
  listenerLeaseMs: 30 * 1000,
  listenerHeartbeatMs: 5 * 1000,
  maxParkMs: 4 * 60 * 60 * 1000,
  // One `agent wait` call. The agent decides whether to wait again.
  maxReplyWaitMs: 16 * 60 * 60 * 1000,
  presentationAckDeadlineMs: 1500,
});

// The host's own tool-call window for one maximum wait: the wait plus a minute
// for startup and handling. Codex's outer @exec yield and Claude's Bash timeout.
export const REPLY_WAIT_HOST_WINDOW_MS =
  REPLY_BINDING_POLICY.maxReplyWaitMs + 60 * 1000;
