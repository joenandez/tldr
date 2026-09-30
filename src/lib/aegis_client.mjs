import { randomBytes } from "node:crypto";
import { createConnection as connectSocket } from "node:net";

import { spawnAegisInboundBridge } from "#tldr-agent-aegis-inbound-bridge";

import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeFrame,
  decodeFrameLength,
  encodeRequest,
} from "./aegis_protocol.mjs";

const DEFAULT_SOCKET = "/var/run/ai.codename.aegis.broker.sock";
// A reply can validate its parent and then send through the provider. Each
// provider operation has a ten-second deadline inside Aegis.
const DEFAULT_OUTBOUND_TIMEOUT_MS = 25_000;
// Inbox reads (list, message, thread) spawn the native bridge, which launches
// the Aegis app and waits up to 4.5 s on the broker (item 14). The client
// waits 5 s by default and never longer.
export const AEGIS_INBOUND_TIMEOUT_MS = 5_000;
const ALLOWED_OPTIONS = new Set([
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

export function requestAegisStatusSafe({ timeoutMs = 2_000 } = {}) {
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
export function requestAegisSetupStateSafe({ timeoutMs = 2_000 } = {}) {
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

// Every inbound bridge failure used to reject with the same code, so a poll
// could not tell our timer from a bridge exit or a broker refusal (item 41).
// `error.bridge` keeps which path failed, as bounded non-secret fields only.
function bridgeFailure(error, startedAt, cause, extra = {}) {
  const exitCode = Number.isInteger(extra.exitCode) ? extra.exitCode : null;
  error.bridge = {
    cause,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    exit_code: exitCode !== null && exitCode >= 0 ? exitCode : null,
    signal: typeof extra.signal === "string" ? extra.signal : null,
    broker_code: typeof extra.brokerCode === "string" ? extra.brokerCode : null,
  };
  return error;
}

function nativeBridgeExchange({
  operation,
  payload,
  timeoutMs,
  requestId,
  project,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawnAegisInboundBridge();
    const chunks = [];
    let received = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      callback(value);
    };
    const fail = (code, cause, extra) =>
      finish(
        reject,
        bridgeFailure(protocolError(code), startedAt, cause, extra),
      );
    const timer = setTimeout(
      () => fail("BROKER_UNAVAILABLE", "bridge_timeout"),
      Math.max(
        1,
        Math.min(
          AEGIS_INBOUND_TIMEOUT_MS,
          Number(timeoutMs) || AEGIS_INBOUND_TIMEOUT_MS,
        ),
      ),
    );
    child.stdout.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_FRAME_BYTES) {
        fail("REQUEST_TOO_LARGE", "bridge_output_too_large");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", () =>
      fail("BROKER_UNAVAILABLE", "bridge_spawn_failed"),
    );
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        // The native bridge exits 2 on any socket failure, including its own
        // receive timeout; `elapsed_ms` is what tells those apart.
        fail(
          "BROKER_UNAVAILABLE",
          signal ? "bridge_signaled" : "bridge_exit_nonzero",
          { exitCode: code, signal },
        );
        return;
      }
      let decoded;
      try {
        const body = Buffer.concat(chunks);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length);
        decoded = decodeFrame(Buffer.concat([header, body]));
      } catch (error) {
        finish(
          reject,
          bridgeFailure(error, startedAt, "bridge_response_invalid"),
        );
        return;
      }
      const response = decoded.value;
      if (decoded.type !== "response" || response.requestId !== requestId) {
        fail(
          response?.error?.code ?? "INVALID_REQUEST",
          "bridge_response_invalid",
        );
        return;
      }
      if (!response.ok) {
        const brokerCode = response.error?.code ?? "INVALID_REQUEST";
        fail(brokerCode, "broker_error", { brokerCode });
        return;
      }
      if (response.result.kind !== "inbound_batch") {
        fail("INVALID_REQUEST", "bridge_response_invalid");
        return;
      }
      try {
        finish(resolve, project(response.result));
      } catch (error) {
        finish(
          reject,
          bridgeFailure(error, startedAt, "bridge_response_invalid"),
        );
      }
    });
    child.stdin.end(
      JSON.stringify({ operation, payload, request_id: requestId }),
    );
  });
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

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
