import { emitSafetyEvent } from "./safety_events.mjs";

function errorDetails(err) {
  return {
    code: err?.code || "daemon_phase_failure_record_failed",
    message: err?.message || String(err),
  };
}

function writeFallback(event) {
  try {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  } catch {
    // The daemon must preserve the original phase result even if stderr fails.
  }
}

export function recordDaemonPhaseFailureSafely({
  recordFailure,
  home,
  daemonInstanceId,
  phase,
  cause,
  now = () => new Date().toISOString(),
} = {}) {
  try {
    recordFailure({ home, daemonInstanceId, phase, cause, now });
    return { recorded: true, error: null };
  } catch (err) {
    const error = errorDetails(err);
    const metadata = {
      phase,
      phase_cause: cause,
      storage_error_code: error.code,
      storage_error: error.message,
    };
    writeFallback({
      level: "error",
      event: "daemon_phase_failure_record_failed",
      daemon_instance_id: daemonInstanceId,
      metadata,
      timestamp: now(),
    });
    try {
      emitSafetyEvent({
        type: "daemon_phase_failure_record_failed",
        subsystem: "daemon",
        status: "failure",
        errorClass: error.code,
        daemonInstanceId,
        metadata,
      });
    } catch (eventErr) {
      writeFallback({
        level: "error",
        event: "daemon_phase_failure_event_write_failed",
        daemon_instance_id: daemonInstanceId,
        error: errorDetails(eventErr),
        timestamp: now(),
      });
    }
    return { recorded: false, error };
  }
}
