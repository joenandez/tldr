import { emitSafetyEvent } from "./safety_events.mjs";

function eventType(err) {
  const code = err?.code || "runtime_store_unready";
  if (code === "runtime_schema_newer") return "runtime_schema_refusal";
  if (
    ["ENOSPC", "EIO", "EROFS", "EDQUOT"].includes(code) ||
    /disk I\/O|database or disk is full|read-?only/i.test(err?.message || "")
  ) {
    return "runtime_store_io_failure";
  }
  return "runtime_store_readiness_failure";
}

export function emitRuntimeStoreReadinessFailure(
  err,
  { supportedVersion, metadata = {} } = {},
) {
  const code = err?.code || "runtime_store_unready";
  try {
    return emitSafetyEvent({
      type: eventType(err),
      subsystem: "runtime_store",
      status: "failure",
      errorClass: code,
      metadata: { code, supported_version: supportedVersion, ...metadata },
    });
  } catch (eventErr) {
    try {
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          event: "runtime_store_readiness_event_write_failed",
          code,
          event_error_code: eventErr?.code || null,
          event_error: eventErr?.message || String(eventErr),
          timestamp: new Date().toISOString(),
        })}\n`,
      );
    } catch {
      // The readiness result remains fail-closed when local sinks are unwritable.
    }
    return null;
  }
}
