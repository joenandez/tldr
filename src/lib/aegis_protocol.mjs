export const PROTOCOL_VERSION = 2;
/* 512 KiB. The frame has to carry a rendered HTML twin (bounded at 256 KiB)
 * beside the 32 KiB text body, and JSON escaping expands the markup. Mirrors
 * native/aegis-core/src/protocol.rs. */
export const MAX_FRAME_BYTES = 524_288;

const TRUSTED_TRANSACTION = [
  ["authorization", "string", 4096, true],
  ["transaction_id", "string", 256, true],
];
const OPERATIONS = new Map([
  ["health", []],
  ["version", []],
  ["status_safe", []],
  ["setup_state_safe", []],
  ["submit_verification_code", [["code", "code", 8, true]]],
  ["resend_verification_code", []],
  [
    "send_owner_message",
    [
      ["body", "string", 32768, true],
      /* The rendered HTML twin, optional. Field order mirrors the Rust schema
       * exactly: the canonical re-encode check rejects a frame whose keys sort
       * differently. */
      ["html", "string", 262144, false],
      ["idempotency_key", "string", 256, true],
      ["subject", "string", 998, false],
    ],
  ],
  [
    "reply_owner_thread",
    [
      ["body", "string", 32768, true],
      ["html", "string", 262144, false],
      ["idempotency_key", "string", 256, true],
      ["parent_message_id", "string", 256, true],
      ["thread_id", "string", 256, true],
    ],
  ],
  [
    "poll_bound_inbox",
    [
      ["after", "string", 64, true],
      ["cursor", "string", 256, false],
      ["limit", "number", 100, true],
    ],
  ],
  ["get_bound_message", [["message_id", "string", 256, true]]],
  ["get_bound_thread", [["thread_id", "string", 256, true]]],
  [
    "begin_enrollment",
    [
      ["authorization", "string", 4096, true],
      ["transaction_id", "string", 256, true],
    ],
  ],
  [
    "submit_enrollment",
    [
      ["api_key", "string", 4096, true],
      ["grant_id", "string", 256, true],
      ["owner_email", "string", 320, true],
      ["transaction_id", "string", 256, true],
    ],
  ],
  [
    "begin_owner_rotation",
    [
      ["authorization", "string", 4096, true],
      ["new_owner_email", "string", 320, true],
      ["transaction_id", "string", 256, true],
    ],
  ],
  [
    "replace_agentmail_key",
    [
      ["api_key", "string", 4096, true],
      ["authorization", "string", 4096, true],
      ["transaction_id", "string", 256, true],
    ],
  ],
  ["uninstall", TRUSTED_TRANSACTION],
]);

const SAFE_ERRORS = new Map([
  ["BROKER_VERSION_UNSUPPORTED", "The broker protocol version is unsupported."],
  ["INVALID_FRAME", "The broker request frame is invalid."],
  ["REQUEST_TOO_LARGE", "The broker request is too large."],
  ["INVALID_REQUEST", "The broker request is invalid."],
  ["UNKNOWN_OPERATION", "The broker operation is not available."],
  ["UNAUTHORIZED", "The broker operation is not authorized."],
  ["BROKER_UNAVAILABLE", "The protected broker is unavailable."],
  ["INVALID_TRANSITION", "The broker state transition is invalid."],
  ["POLICY_CORRUPT", "Protected broker policy is unavailable."],
  ["POLICY_ROLLBACK", "Protected broker policy rollback was blocked."],
  ["CREDENTIAL_UNAVAILABLE", "The protected credential is unavailable."],
  ["PROVIDER_UNAVAILABLE", "The messaging provider is unavailable."],
  ["VERIFICATION_INVALID", "The verification code could not be accepted."],
  ["VERIFICATION_EXPIRED", "The verification code has expired."],
  ["VERIFICATION_COOLDOWN", "Verification is temporarily unavailable."],
  ["VERIFICATION_UNAVAILABLE", "Verification is unavailable."],
]);

export class ProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProtocolError";
    this.code = code;
  }
}
export function decodeFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 4)
    throw new ProtocolError("INVALID_FRAME");
  const length = frame.readUInt32BE(0);
  if (length > MAX_FRAME_BYTES) throw new ProtocolError("REQUEST_TOO_LARGE");
  if (frame.length !== length + 4) throw new ProtocolError("INVALID_FRAME");
  let parsed;
  try {
    parsed = JSON.parse(frame.subarray(4).toString("utf8"));
  } catch {
    throw new ProtocolError("INVALID_REQUEST");
  }
  if (!isRecord(parsed) || parsed.version !== PROTOCOL_VERSION) {
    if (isRecord(parsed) && Number.isInteger(parsed.version))
      throw new ProtocolError("BROKER_VERSION_UNSUPPORTED");
    throw new ProtocolError("INVALID_REQUEST");
  }
  const message = Object.hasOwn(parsed, "operation")
    ? { type: "request", value: normalizeRequest(parsed) }
    : { type: "response", value: normalizeResponse(parsed) };
  const canonical =
    message.type === "request"
      ? encodeRequest(message.value)
      : encodeResponse(message.value);
  if (!frame.equals(canonical)) throw new ProtocolError("INVALID_REQUEST");
  return message;
}

export function decodeFrameLength(header) {
  if (!Buffer.isBuffer(header) || header.length !== 4)
    throw new ProtocolError("INVALID_FRAME");
  const length = header.readUInt32BE(0);
  if (length > MAX_FRAME_BYTES) throw new ProtocolError("REQUEST_TOO_LARGE");
  return length;
}

export function encodeRequest(request) {
  requireKeys(request, ["version", "operation", "requestId", "payload"]);
  if (request.version !== PROTOCOL_VERSION)
    throw new ProtocolError("BROKER_VERSION_UNSUPPORTED");
  const payload = validatePayload(request.operation, request.payload);
  return frameJson({
    version: PROTOCOL_VERSION,
    operation: request.operation,
    request_id: bounded(request.requestId, 128),
    payload,
  });
}

export function encodeResponse(response) {
  requireKeys(
    response,
    response.ok
      ? ["version", "requestId", "ok", "result"]
      : ["version", "requestId", "ok", "error"],
  );
  if (response.version !== PROTOCOL_VERSION || typeof response.ok !== "boolean")
    throw new ProtocolError("INVALID_REQUEST");
  const base = {
    version: PROTOCOL_VERSION,
    request_id: bounded(response.requestId, 128),
    ok: response.ok,
  };
  if (response.ok)
    return frameJson({ ...base, result: validateResult(response.result) });
  return frameJson({ ...base, error: validateError(response.error) });
}

function normalizeRequest(value) {
  requireKeys(value, ["version", "operation", "request_id", "payload"]);
  return {
    version: PROTOCOL_VERSION,
    operation: value.operation,
    requestId: bounded(value.request_id, 128),
    payload: validatePayload(value.operation, value.payload),
  };
}

function normalizeResponse(value) {
  if (typeof value.ok !== "boolean") throw new ProtocolError("INVALID_REQUEST");
  requireKeys(
    value,
    value.ok
      ? ["version", "request_id", "ok", "result"]
      : ["version", "request_id", "ok", "error"],
  );
  const base = {
    version: PROTOCOL_VERSION,
    requestId: bounded(value.request_id, 128),
    ok: value.ok,
  };
  return value.ok
    ? { ...base, result: validateResult(value.result) }
    : { ...base, error: validateError(value.error) };
}

function validatePayload(operation, payload) {
  const schema = OPERATIONS.get(operation);
  if (!schema) throw new ProtocolError("UNKNOWN_OPERATION");
  if (!isRecord(payload)) throw new ProtocolError("INVALID_REQUEST");
  const allowed = schema.map(([name]) => name);
  if (Object.keys(payload).some((key) => !allowed.includes(key)))
    throw new ProtocolError("INVALID_REQUEST");
  const normalized = {};
  for (const [name, type, maximum, required] of schema) {
    const value = payload[name];
    if (value === undefined && !required) continue;
    if (type === "string") normalized[name] = bounded(value, maximum);
    else if (type === "code") {
      if (typeof value !== "string" || !/^[0-9]{8}$/.test(value))
        throw new ProtocolError("INVALID_REQUEST");
      normalized[name] = value;
    } else if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
      throw new ProtocolError("INVALID_REQUEST");
    else normalized[name] = value;
  }
  return normalized;
}

function validateResult(result) {
  if (!isRecord(result) || typeof result.kind !== "string")
    throw new ProtocolError("INVALID_REQUEST");
  const schemas = {
    version: ["kind", "min_version", "max_version"],
    health: ["kind", "status"],
    status_safe: ["kind", "status"],
    setup_state_safe: [
      "kind",
      "state",
      "destination_masked",
      "expires_at",
      "verify_available_at",
      "resend_available_at",
    ],
    verification: ["kind", "outcome", "state", "resend_available_at"],
    enrollment_grant: ["kind", "generation", "grant_id", "expires_at"],
    delivery: ["kind", "message_id", "thread_id"],
    inbound_batch: ["kind", "messages", "next_cursor", "rejected_message_ids"],
    accepted: ["kind", "generation"],
  };
  const keys = schemas[result.kind];
  if (!keys) throw new ProtocolError("INVALID_REQUEST");
  if (result.kind === "verification") {
    if (
      !isRecord(result) ||
      Object.keys(result).some(
        (key) =>
          !["kind", "outcome", "state", "resend_available_at"].includes(key),
      ) ||
      !["kind", "outcome", "state"].every((key) => Object.hasOwn(result, key))
    )
      throw new ProtocolError("INVALID_REQUEST");
  } else requireKeys(result, keys);
  if (result.kind === "version") {
    if (
      !Number.isSafeInteger(result.min_version) ||
      !Number.isSafeInteger(result.max_version)
    )
      throw new ProtocolError("INVALID_REQUEST");
    return {
      kind: "version",
      min_version: result.min_version,
      max_version: result.max_version,
    };
  }
  if (result.kind === "health" || result.kind === "status_safe") {
    if (typeof result.status !== "string")
      throw new ProtocolError("INVALID_REQUEST");
    return { kind: result.kind, status: result.status };
  }
  if (result.kind === "setup_state_safe") {
    if (
      typeof result.state !== "string" ||
      ![
        result.destination_masked,
        result.expires_at,
        result.verify_available_at,
        result.resend_available_at,
      ].every(
        (value) =>
          value === null ||
          (typeof value === "string"
            ? Buffer.byteLength(value) <= 320
            : Number.isSafeInteger(value) && value >= 0),
      )
    )
      throw new ProtocolError("INVALID_REQUEST");
    return {
      kind: "setup_state_safe",
      state: bounded(result.state, 64),
      destination_masked:
        result.destination_masked === null
          ? null
          : bounded(result.destination_masked, 320),
      expires_at: nullableTimestamp(result.expires_at),
      verify_available_at: nullableTimestamp(result.verify_available_at),
      resend_available_at: nullableTimestamp(result.resend_available_at),
    };
  }
  if (result.kind === "verification") {
    if (
      typeof result.outcome !== "string" ||
      typeof result.state !== "string" ||
      (result.resend_available_at !== undefined &&
        result.resend_available_at !== null &&
        (!Number.isSafeInteger(result.resend_available_at) ||
          result.resend_available_at < 0))
    )
      throw new ProtocolError("INVALID_REQUEST");
    return {
      kind: "verification",
      outcome: bounded(result.outcome, 32),
      state: bounded(result.state, 64),
      ...(result.resend_available_at === undefined
        ? {}
        : {
            resend_available_at: nullableTimestamp(result.resend_available_at),
          }),
    };
  }
  if (result.kind === "enrollment_grant") {
    if (
      !Number.isSafeInteger(result.generation) ||
      result.generation < 0 ||
      !Number.isSafeInteger(result.expires_at) ||
      result.expires_at < 0
    )
      throw new ProtocolError("INVALID_REQUEST");
    return {
      kind: "enrollment_grant",
      generation: result.generation,
      grant_id: bounded(result.grant_id, 512),
      expires_at: result.expires_at,
    };
  }
  if (result.kind === "delivery") {
    return {
      kind: "delivery",
      message_id: bounded(result.message_id, 256),
      thread_id: bounded(result.thread_id, 256),
    };
  }
  if (result.kind === "inbound_batch") {
    if (
      !Array.isArray(result.messages) ||
      result.messages.length > 25 ||
      !Array.isArray(result.rejected_message_ids) ||
      result.rejected_message_ids.length > 25
    )
      throw new ProtocolError("INVALID_REQUEST");
    return {
      kind: "inbound_batch",
      messages: result.messages.map(validateInboundEnvelope),
      next_cursor: nullableBounded(result.next_cursor, 256),
      rejected_message_ids: result.rejected_message_ids.map((value) =>
        bounded(value, 256),
      ),
    };
  }
  if (!Number.isSafeInteger(result.generation))
    throw new ProtocolError("INVALID_REQUEST");
  return { kind: "accepted", generation: result.generation };
}

function validateInboundEnvelope(value) {
  requireKeys(value, [
    "message_id",
    "thread_id",
    "sender_authorized",
    "subject",
    "text",
    "timestamp",
    "in_reply_to",
    "attachment_count",
    "body_truncated",
  ]);
  if (
    value.sender_authorized !== true ||
    !Number.isSafeInteger(value.attachment_count) ||
    value.attachment_count < 0 ||
    value.attachment_count > 100 ||
    typeof value.body_truncated !== "boolean"
  )
    throw new ProtocolError("INVALID_REQUEST");
  return {
    message_id: bounded(value.message_id, 256),
    thread_id: bounded(value.thread_id, 256),
    sender_authorized: true,
    subject: nullableBounded(value.subject, 998),
    text: nullableBounded(value.text, 32768),
    timestamp: bounded(value.timestamp, 64),
    in_reply_to: nullableBounded(value.in_reply_to, 256),
    attachment_count: value.attachment_count,
    body_truncated: value.body_truncated,
  };
}

function nullableBounded(value, maximum) {
  return value === null ? null : bounded(value, maximum);
}
function nullableTimestamp(value) {
  return value === null ? null : value;
}
function validateError(error) {
  requireKeys(error, ["code", "message"]);
  const message = SAFE_ERRORS.get(error.code);
  if (!message || error.message !== message)
    throw new ProtocolError("INVALID_REQUEST");
  return { code: error.code, message };
}
function frameJson(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME_BYTES)
    throw new ProtocolError("REQUEST_TOO_LARGE");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function bounded(value, maximum) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maximum
  )
    throw new ProtocolError("INVALID_REQUEST");
  return value;
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireKeys(value, keys) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new ProtocolError("INVALID_REQUEST");
}
