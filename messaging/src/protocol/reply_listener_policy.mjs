// Shared fixed policy for opaque reply bindings and endpoint listeners.
// It is static contract data, so protocol is the lowest legal shared layer
// for both daemon enforcement and CLI hook timeout derivation.

export const REPLY_BINDING_POLICY = Object.freeze({
  bindingLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  providerAcceptanceGraceMs: 30 * 1000,
  listenerLeaseMs: 30 * 1000,
  listenerHeartbeatMs: 5 * 1000,
  maxParkMs: 4 * 60 * 60 * 1000,
  presentationAckDeadlineMs: 1500,
});
