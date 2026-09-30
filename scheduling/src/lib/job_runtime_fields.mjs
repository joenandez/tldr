export function normalizeJobRuntimeFields(input, now) {
  return {
    retry: {
      max_attempts:
        input.retry?.max_attempts !== undefined ? input.retry.max_attempts : 0,
      backoff:
        input.retry?.backoff !== undefined ? input.retry.backoff : "none",
      delay_sec:
        input.retry?.delay_sec !== undefined ? input.retry.delay_sec : 0,
    },
    conditions: {
      file_exists: input.conditions?.file_exists || null,
      env_set: input.conditions?.env_set || null,
    },
    state: {
      enabled: input.state?.enabled ?? true,
      last_run_at: input.state?.last_run_at || null,
      next_run_at: input.state?.next_run_at || null,
      last_status: input.state?.last_status || "none",
      last_error: input.state?.last_error || null,
      last_failed_step: input.state?.last_failed_step || null,
      deferred_since: input.state?.deferred_since || null,
      deferred_reason: input.state?.deferred_reason || null,
      infrastructure_deferred_slot:
        input.state?.infrastructure_deferred_slot || null,
      infrastructure_deferred_reason:
        input.state?.infrastructure_deferred_reason || null,
    },
    meta: {
      created_at: input.meta?.created_at || now,
      updated_at: now,
    },
  };
}
