// Shared request/response envelope construction, validation, structured
// errors, and NDJSON frame encode/decode. Imported by both src/daemon/ and
// src/client/ (the architecture contract §5 import boundary rule). This module
// imports from neither.

export const PROTOCOL_VERSION = '1.0';

// Tightbeam's own version, reported on the wire and by `--version`. It is
// independent of the tldr package version (as are PROTOCOL_VERSION and the
// state schema version), so it is a source constant here rather than a value
// read from any package manifest. compat.json's package_version must match it.
export const DAEMON_VERSION = '0.2.5';

// Required structured error codes from docs/protocol.md.
export const STRUCTURED_ERROR_CODES = Object.freeze([
  'protocol_incompatible',
  'permission_denied',
  'identity_unverified',
  'identity_conflict',
  'application_unknown',
  'endpoint_unknown',
  'conversation_unknown',
  'conversation_binding_conflict',
  'idempotency_collision',
  'claim_held',
  'claim_expired',
  'obligation_conflict',
  'resume_handler_unavailable',
  'migration_incompatible',
]);

// Transport-level error codes, docs/protocol.md "Transport-level error
// codes (additions, kept minimal)".
export const TRANSPORT_ERROR_CODES = Object.freeze(['malformed_request', 'unauthenticated']);

export const ERROR_CODES = Object.freeze([...STRUCTURED_ERROR_CODES, ...TRANSPORT_ERROR_CODES]);

// Independently negotiated additions to the channel and listener planes.
// A channel adapter can use bound replies without participating in listener
// lifecycle, and a hook can safely retain its existing Stop behavior until it
// understands listener.v1.
export const CHANNELS_REPLY_BINDING_V1 = 'channels.reply-binding.v1';
export const LISTENER_V1 = 'listener.v1';
export const MESSAGING_REPLY_CAUSALITY_V1 = 'messaging.reply-causality.v1';
export const MESSAGING_RECEIPT_V1 = 'messaging.receipt.v1';

// Stable names for the narrow operations introduced by those capabilities.
// Keeping them at the protocol boundary prevents adapters from rebuilding
// operation strings or falling back to a generic raw-ID message request.
export const CHANNEL_REPLY_PUBLISH_OPERATION = 'channel.reply.publish';
export const LISTENER_ATTACH_OPERATION = 'listener.attach';
export const LISTENER_HEARTBEAT_OPERATION = 'listener.heartbeat';
export const LISTENER_ACK_OPERATION = 'listener.ack';
export const LISTENER_END_OPERATION = 'listener.end';

// Baseline capability set for protocol 1.0, docs/protocol.md "Handshake".
// messaging.events.v1 (ws-9): the inbox.subscribe / event-frame protocol
// amendment, docs/protocol.md "Live notification and event frames".
export const BASELINE_CAPABILITIES = Object.freeze([
  'compat.v1',
  'admin.v1',
  'messaging.v1',
  'obligations.v1',
  'delivery.v1',
  'resume.v1',
  'state.v1',
  'messaging.events.v1',
  'channels.v1',
  CHANNELS_REPLY_BINDING_V1,
  LISTENER_V1,
  MESSAGING_REPLY_CAUSALITY_V1,
  MESSAGING_RECEIPT_V1,
]);

export class TightbeamError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TightbeamError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function makeError(code, message, details) {
  return new TightbeamError(code, message, details);
}

/**
 * Only the major component of "major.minor" gates compatibility
 * (docs/protocol.md "Request envelope"; the architecture contract §7).
 */
export function isMajorVersionCompatible(clientProtocolVersion, daemonProtocolVersion = PROTOCOL_VERSION) {
  const clientMajor = majorOf(clientProtocolVersion);
  const daemonMajor = majorOf(daemonProtocolVersion);
  if (clientMajor === null || daemonMajor === null) return false;
  return clientMajor === daemonMajor;
}

function majorOf(version) {
  if (typeof version !== 'string') return null;
  const [major] = version.split('.');
  if (!/^\d+$/.test(major ?? '')) return null;
  return major;
}

/**
 * Validates the request envelope shape (field presence and type) from
 * docs/protocol.md "Request envelope". Does not check protocol_version
 * compatibility or authentication — those are connection-lifecycle
 * concerns handled by src/daemon/server.mjs.
 */
export function validateRequestEnvelope(candidate) {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { ok: false, code: 'malformed_request', message: 'request envelope must be a JSON object', field: null, requestId: null };
  }

  const { protocol_version: protocolVersion, request_id: requestId, app_id: appId, op, payload } = candidate;
  // Best-effort request_id for the error response, per docs/protocol.md
  // Response envelope: "request_id — echoed from the request, or null if
  // unparseable." Only trusted when request_id itself is well-formed.
  const echoableRequestId = typeof requestId === 'string' && requestId.length > 0 ? requestId : null;

  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    return fail('protocol_version', 'protocol_version is required and must be a string', echoableRequestId);
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return fail('request_id', 'request_id is required and must be a string', null);
  }
  if (appId !== null && typeof appId !== 'string') {
    return fail('app_id', 'app_id must be a string or null', echoableRequestId);
  }
  if (typeof op !== 'string' || op.length === 0) {
    return fail('op', 'op is required and must be a string', echoableRequestId);
  }
  if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    return fail('payload', 'payload must be an object when present', echoableRequestId);
  }

  return {
    ok: true,
    value: {
      protocol_version: protocolVersion,
      request_id: requestId,
      app_id: appId ?? null,
      op,
      payload: payload ?? {},
    },
  };
}

function fail(field, message, requestId = null) {
  return { ok: false, code: 'malformed_request', message, field, requestId };
}

export function successEnvelope({ protocolVersion = PROTOCOL_VERSION, requestId, result, capabilities } = {}) {
  const envelope = {
    protocol_version: protocolVersion,
    request_id: requestId ?? null,
    ok: true,
    result: result ?? {},
  };
  if (capabilities !== undefined) envelope.capabilities = capabilities;
  return envelope;
}

export function errorEnvelope({ protocolVersion = PROTOCOL_VERSION, requestId, code, message, details } = {}) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return {
    protocol_version: protocolVersion,
    request_id: requestId ?? null,
    ok: false,
    error,
  };
}

/**
 * An unsolicited server-to-client event frame (docs/protocol.md "Live
 * notification and event frames"): request_id is always null, and the
 * presence of `event` (never present on a real response envelope) is
 * what distinguishes it from a frame-level parse-failure response, whose
 * request_id is also null.
 */
export function eventEnvelope({ protocolVersion = PROTOCOL_VERSION, event, payload } = {}) {
  return {
    protocol_version: protocolVersion,
    request_id: null,
    event,
    payload: payload ?? {},
  };
}

// 1 MiB frame cap, the architecture contract §1.
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * Encodes one NDJSON frame: exactly one JSON.stringify line, \n-terminated.
 * JSON.stringify always escapes embedded newlines in string values, so the
 * result is always exactly one line (the architecture contract §1).
 */
export function encodeFrame(obj) {
  const line = JSON.stringify(obj);
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(`encoded frame exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`);
  }
  return line + '\n';
}

function parseLine(line, maxBytes) {
  if (Buffer.byteLength(line, 'utf8') > maxBytes) {
    return { ok: false, code: 'malformed_request' };
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, code: 'malformed_request' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, code: 'malformed_request' };
  }
  return { ok: true, value };
}

/**
 * Stateful NDJSON line splitter for a single connection. push() accepts an
 * incoming string chunk and returns zero or more parsed frame results.
 * Enforces the 1 MiB per-line cap both on completed lines and on an
 * unterminated buffer that has grown past the cap (a client that never
 * sends '\n' must not be able to grow memory unboundedly).
 */
export class FrameDecoder {
  constructor({ maxBytes = MAX_FRAME_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += chunk;
    const frames = [];
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      frames.push(parseLine(line, this.maxBytes));
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBytes) {
      frames.push({ ok: false, code: 'malformed_request' });
      this.buffer = '';
    }
    return frames;
  }
}
