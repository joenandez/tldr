// A daemon that predates a session.stop field refuses it as malformed before
// writing anything, so the Stop is retried once under the SAME idempotency key
// without that field and behaves exactly as it did before the field existed.
function unsupportedField(error, field) {
  return error?.code === "malformed_request" && error?.details?.field === field;
}

async function sendStop(client, request, { backgroundWait, sessionId, log }) {
  if (!backgroundWait) return client.request("session.stop", request);
  try {
    return await client.request("session.stop", {
      ...request,
      background_wait: true,
    });
  } catch (error) {
    if (!unsupportedField(error, "background_wait")) throw error;
    log({
      event: "stop_gate_background_wait_unsupported",
      session_id: sessionId,
      endpoint_id: request.endpoint_id,
      result: "retry_without_flag",
    });
    return client.request("session.stop", request);
  }
}

export async function requestSessionStop(client, request, options) {
  const { sessionId, log } = options;
  try {
    return await sendStop(client, request, options);
  } catch (error) {
    if (
      request.wait_outcome?.outcome !== "message" ||
      !unsupportedField(error, "wait_outcome")
    )
      throw error;
    log({
      event: "stop_gate_wait_outcome_unsupported",
      session_id: sessionId,
      endpoint_id: request.endpoint_id,
      result: "retry_without_wait_outcome",
    });
    const { wait_outcome: _unsupported, ...withoutOutcome } = request;
    return sendStop(client, withoutOutcome, options);
  }
}
