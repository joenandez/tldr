function errorDetails(err) {
  return {
    code: err?.code || null,
    message: err?.message || String(err),
  };
}

export async function runSentinelTickSafely({
  tick,
  recordFailure,
  now = () => new Date().toISOString(),
  writeFallback = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  try {
    return { ok: true, result: await tick() };
  } catch (err) {
    const failure = {
      ts: now(),
      kind: "sentinel_tick_failed",
      error: err?.message || String(err),
      code: err?.code || null,
    };
    try {
      recordFailure(failure);
      return { ok: false, error: errorDetails(err), failure_recorded: true };
    } catch (recordErr) {
      const recordError = errorDetails(recordErr);
      try {
        writeFallback(
          JSON.stringify({
            level: "error",
            event: "sentinel_tick_failure_record_failed",
            failure,
            record_error: recordError,
            timestamp: now(),
          }),
        );
      } catch {
        // Keep the watchdog loop alive even when every local sink is unwritable.
      }
      return {
        ok: false,
        error: errorDetails(err),
        failure_recorded: false,
        record_error: recordError,
      };
    }
  }
}
