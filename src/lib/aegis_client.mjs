import { randomBytes } from "node:crypto";
import { createConnection as connectSocket } from "node:net";

import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  decodeFrameLength,
  encodeRequest,
} from "./aegis_protocol.mjs";
import {
  AEGIS_INBOUND_TIMEOUT_MS,
  nativeBridgeExchange,
  protocolError,
} from "./aegis_inbound_bridge_exchange.mjs";
import * as local from "./agentmail_local_client.mjs";

const DEFAULT_SOCKET = "/var/run/ai.codename.aegis.broker.sock";
// A reply can validate its parent and then send through the provider. Each
// provider operation has a ten-second deadline inside Aegis.
const DEFAULT_OUTBOUND_TIMEOUT_MS = 25_000;
export { AEGIS_INBOUND_TIMEOUT_MS };
const { LOCAL_OPTIONS, usesLocalClient } = local;
const ALLOWED_OPTIONS = new Set([
  ...LOCAL_OPTIONS,
  "socketPath",
  "operation",
  "body",
  "html",
  "subject",
  "idempotencyKey",
  "threadId",
  "parentMessageId",
  "timeoutMs",
]);
const ALLOWED_INBOUND_OPTIONS = new Set([
  ...LOCAL_OPTIONS,
  "operation",
  "after",
  "cursor",
  "limit",
  "messageId",
  "threadId",
  "timeoutMs",
]);

export function requestAegisOutbound(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw protocolError("INVALID_REQUEST");
  }
  if (Object.keys(options).some((key) => !ALLOWED_OPTIONS.has(key))) {
    throw protocolError("INVALID_REQUEST");
  }
  const {
    socketPath = process.env.TLDR_AGENT_AEGIS_SOCKET || DEFAULT_SOCKET,
    operation,
    body,
    html,
    subject,
    idempotencyKey,
    threadId,
    parentMessageId,
    timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS,
  } = options;
  const payload = { body, idempotency_key: idempotencyKey };
  if (html) payload.html = html;
  if (operation === "send_owner_message") {
    if (subject !== undefined) payload.subject = subject;
  } else if (operation === "reply_owner_thread") {
    payload.parent_message_id = parentMessageId;
    payload.thread_id = threadId;
  } else {
    throw protocolError("INVALID_REQUEST");
  }
  if (usesLocalClient(options))
    return local.localOutbound({ operation, payload, timeoutMs }, options);
  const requestId = `outbound-${randomBytes(12).toString("hex")}`;
  const frame = encodeRequest({
    version: PROTOCOL_VERSION,
    operation,
    requestId,
    payload,
  });
  return exchange({
    socketPath,
    timeoutMs,
    requestId,
    frame,
    expectedKind: "delivery",
    outbound: true,
    project: (result) => ({
      messageId: result.message_id,
      threadId: result.thread_id,
    }),
  });
}

export function requestAegisStatusSafe(options = {}) {
  const { timeoutMs = 2_000 } = options;
  if (usesLocalClient(options)) return local.localStatus(options);
  const requestId = `status-${randomBytes(12).toString("hex")}`;
  return exchange({
    socketPath: DEFAULT_SOCKET,
    timeoutMs,
    requestId,
    frame: encodeRequest({
      version: PROTOCOL_VERSION,
      operation: "status_safe",
      requestId,
      payload: {},
    }),
    expectedKind: "status_safe",
    project: (result) => result.status,
  });
}

// setup_state_safe is a single broker read, not an inbox operation. Its
// projection has already been bounded by the protocol decoder; retaining the
// wire names makes an exact update-continuity comparison unambiguous.
export function requestAegisSetupStateSafe(options = {}) {
  const { timeoutMs = 2_000 } = options;
  if (usesLocalClient(options)) return local.localSetupState(options);
  const requestId = `setup-state-${randomBytes(12).toString("hex")}`;
  return exchange({
    socketPath: DEFAULT_SOCKET,
    timeoutMs,
    requestId,
    frame: encodeRequest({
      version: PROTOCOL_VERSION,
      operation: "setup_state_safe",
      requestId,
      payload: {},
    }),
    expectedKind: "setup_state_safe",
    project: (result) =>
      Object.freeze({
        state: result.state,
        destination_masked: result.destination_masked,
        expires_at: result.expires_at,
        verify_available_at: result.verify_available_at,
        resend_available_at: result.resend_available_at,
      }),
  });
}

export function requestAegisInbound(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw protocolError("INVALID_REQUEST");
  }
  if (Object.keys(options).some((key) => !ALLOWED_INBOUND_OPTIONS.has(key))) {
    throw protocolError("INVALID_REQUEST");
  }
  const {
    operation,
    after,
    cursor,
    limit,
    messageId,
    threadId,
    timeoutMs = AEGIS_INBOUND_TIMEOUT_MS,
  } = options;
  let payload;
  if (operation === "poll_bound_inbox") {
    payload = { after, limit };
    if (cursor !== undefined && cursor !== null) payload.cursor = cursor;
  } else if (operation === "get_bound_message") {
    payload = { message_id: messageId };
  } else if (operation === "get_bound_thread") {
    payload = { thread_id: threadId };
  } else {
    throw protocolError("INVALID_REQUEST");
  }
  const requestId = `inbound-${randomBytes(12).toString("hex")}`;
  encodeRequest({ version: PROTOCOL_VERSION, operation, requestId, payload });
  if (usesLocalClient(options))
    return local.localInbound({ operation, payload, timeoutMs }, options);
  return nativeBridgeExchange({
    operation,
    payload,
    timeoutMs,
    requestId,
    project: projectAegisInboundResult,
  });
}

export function projectAegisInboundResult(result) {
  return {
    messages: result.messages.map((message) => ({
      messageId: message.message_id,
      threadId: message.thread_id,
      senderAuthorized: message.sender_authorized,
      subject: message.subject,
      text: message.text,
      timestamp: message.timestamp,
      inReplyTo: message.in_reply_to,
      attachmentCount: message.attachment_count,
      bodyTruncated: message.body_truncated,
    })),
    nextCursor: result.next_cursor,
    rejectedMessageIds: result.rejected_message_ids,
  };
}

function exchange({
  socketPath,
  timeoutMs,
  requestId,
  frame,
  expectedKind,
  project,
  outbound = false,
}) {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(socketPath);
    const chunks = [];
    let received = 0;
    let expected = null;
    let settled = false;
    let requestSubmitted = false;
    const uncertain = (error) => {
      if (outbound && requestSubmitted) error.ambiguous = true;
      return error;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      requestSubmitted = true;
      socket.end(frame);
    });
    socket.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_FRAME_BYTES + 4) {
        finish(reject, uncertain(protocolError("REQUEST_TOO_LARGE")));
        return;
      }
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (expected === null && buffer.length >= 4) {
        expected = decodeFrameLength(buffer.subarray(0, 4)) + 4;
      }
      if (expected !== null && buffer.length === expected) {
        let decoded;
        try {
          decoded = decodeFrame(buffer);
        } catch (error) {
          finish(reject, uncertain(error));
          return;
        }
        const response = decoded.value;
        if (decoded.type !== "response" || response.requestId !== requestId) {
          finish(reject, uncertain(protocolError("INVALID_REQUEST")));
        } else if (!response.ok) {
          const error = protocolError(response.error.code);
          if (
            outbound &&
            ["BROKER_UNAVAILABLE", "PROVIDER_UNAVAILABLE"].includes(error.code)
          ) {
            error.ambiguous = true;
          }
          finish(reject, error);
        } else if (response.result.kind !== expectedKind) {
          finish(reject, uncertain(protocolError("INVALID_REQUEST")));
        } else {
          finish(resolve, project(response.result));
        }
      }
    });
    socket.once("timeout", () =>
      finish(reject, uncertain(protocolError("BROKER_UNAVAILABLE"))),
    );
    socket.once("error", () =>
      finish(reject, uncertain(protocolError("BROKER_UNAVAILABLE"))),
    );
    socket.once("end", () => {
      if (!settled) finish(reject, uncertain(protocolError("INVALID_FRAME")));
    });
  });
}
