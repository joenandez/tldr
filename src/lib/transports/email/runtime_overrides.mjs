// Production builds deliberately expose no mutable email transport overrides.
// The test condition resolves the same internal import to tests/support.
export function getConfigOverride() {
  return null;
}

export function getSdkOverride() {
  return null;
}

export function getVerifiedOwnerEmailOverride() {
  return null;
}

export async function readVerifiedOwnerEmail() {
  return null;
}

export function getAegisBrokerTestOverrides() {
  return Object.freeze({
    allowLegacyDirect: false,
    requestInbound: null,
    inboundWebhook: null,
    requestOutbound: null,
  });
}

function directTransportUnavailable() {
  const error = new Error("Protected broker transport is required.");
  error.code = "PROVIDER_UNAVAILABLE";
  throw error;
}

export async function sendEmail() {
  directTransportUnavailable();
}

export async function replyToMessage() {
  directTransportUnavailable();
}

export async function getMessage() {
  directTransportUnavailable();
}

export async function listMessages() {
  directTransportUnavailable();
}

export async function getThread() {
  directTransportUnavailable();
}

export function isAgentMailConfigured() {
  return { ok: false, reason: "protected_broker_required" };
}

export function readTldrAgentPollConfig() {
  return Object.freeze({
    inbox_id: "aegis-protected-bound-inbox",
    inbox_email: "aegis-protected-bound-inbox",
  });
}

export async function resolveTldrAgentAgentMailConfig() {
  directTransportUnavailable();
}

const REJECTED_EVENTS = new Set([
  "message.received.spam",
  "message.received.blocked",
  "message.bounced",
  "message.complained",
  "message.rejected",
]);

export function authorizeInboundEnvelope({ eventType = null } = {}) {
  return REJECTED_EVENTS.has(eventType)
    ? { ok: false, reason: "broker_rejected_envelope" }
    : { ok: true, reason: "broker_authorized_envelope" };
}

export function authorizeInboundSender() {
  return { ok: false, reason: "broker_authorization_required" };
}
