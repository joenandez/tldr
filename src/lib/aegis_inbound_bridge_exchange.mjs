import { spawnAegisInboundBridge } from "#tldr-agent-aegis-inbound-bridge";

import { MAX_FRAME_BYTES, decodeFrame } from "./aegis_protocol.mjs";

// Inbox reads (list, message, thread) spawn the native bridge, which launches
// the Aegis app and waits up to 4.5 s on the broker (item 14). The client
// waits 5 s by default and never longer.
export const AEGIS_INBOUND_TIMEOUT_MS = 5_000;

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

export function nativeBridgeExchange({
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

export function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
