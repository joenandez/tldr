// dispatch_provider_skip — close a Skyhook run whose provider skipped on purpose.

import { appendActivityEvent } from "./activity_stream.mjs";
import { appendJobHistoryEvent } from "./read_store.mjs";
import { computeNextAfterRun } from "./schedule_eval.mjs";
import {
  persistRuntimePatch,
  runtimePatchFor,
} from "./dispatch_schedule_finalization.mjs";

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// C1 of the provider-run outcome contract: the provider exited 0 without a
// session and printed its helm.skip line. The run is a deliberate no-op —
// recorded as skipped with the provider's reason, never retried or replaced
// by a fallback agent.
export async function finalizeProviderSkip(scope, job, result, ctx) {
  const {
    finalizeAttempt,
    runId,
    startedAt,
    scheduledAt,
    daemonInstanceId,
    logPaths,
    baselineUpdatedAt,
    consumedPhaseAbortedSlot,
  } = ctx;
  const finishedAt = nowIso();
  const skip = result.skip;
  finalizeAttempt({
    scope,
    jobId: job.id,
    runId,
    daemonInstanceId,
    metadata: job.metadata || null,
    status: "skipped",
    error: `provider_skip:${skip.reason}`,
    cleanup: result.wrapper?.cleanup || null,
    exitCode: 0,
    terminalSource: "provider-skip",
    signalSource: result.signal_source || null,
    startupWindowMs: result.startup_window_ms || null,
    now: finishedAt,
  });
  const providerSkip = {
    reason: skip.reason,
    source: skip.source,
    agent: skip.agent,
    version: skip.version,
  };
  const skippedEvent = {
    id: `run_${runId}_skipped`,
    ts: finishedAt,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    kind: "skipped",
    status: "skipped",
    reason: skip.reason,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: result.duration_ms ?? null,
    error: null,
    exit_code: 0,
    log_paths: logPaths,
    payload: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
      log_paths: logPaths,
      provider_skip: providerSkip,
      agent_fallback: result.agent_fallback || null,
    },
  };
  appendJobHistoryEvent(scope, job.id, skippedEvent);
  appendActivityEvent({
    type: "job_run_skipped",
    kind: "run",
    level: "info",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    status: "skipped",
    reason: skip.reason,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: result.duration_ms ?? null,
    pid: result.pid || null,
    error: null,
    data: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
      log_paths: logPaths,
      provider_skip: providerSkip,
      signal_source: result.signal_source || null,
    },
  });
  process.stderr.write(
    `[helm provider-skip] recorded scope=${scope.scope_id || "unknown"} job=${job.id} run=${runId} reason=${skip.reason} fallback=none\n`,
  );
  job.state.last_run_at = finishedAt;
  job.state.last_status = "skipped";
  job.state.last_error = null;
  job.state.last_failed_step = null;
  job.state.deferred_since = null;
  job.state.deferred_reason = null;
  const next = computeNextAfterRun(job, scheduledAt || finishedAt, finishedAt);
  job.state.next_run_at = next.next_run_at;
  if (!next.enabled) job.state.enabled = false;
  job.meta.updated_at = nowIso();
  await persistRuntimePatch(
    scope,
    job.id,
    baselineUpdatedAt,
    runtimePatchFor(job, consumedPhaseAbortedSlot),
  );
  return skippedEvent;
}
