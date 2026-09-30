import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { executeJob } from "./executor.mjs";
import { launchCommandUntilStarted } from "./executor_start_confirm.mjs";
import { emitNotifications } from "./notify.mjs";
import { appendActivityEvent } from "./activity_stream.mjs";
import { appendJobHistoryEvent, loadJobHistory } from "./read_store.mjs";
import { recordSkippedOccurrence } from "./skipped_occurrence_accounting.mjs";
import { computeNextAfterRun } from "./schedule_eval.mjs";
import {
  clearActiveRun,
  loadActiveRunsReadOnly,
  loadJobs,
  runHeartbeatPath,
  runLogPaths,
  setActiveRun,
} from "./store.mjs";
import { markDispatchFinished, markDispatchStarted } from "./runtime.mjs";
import { withExecutionLease } from "./scope_runtime.mjs";
import { reapWorkspace } from "./reaper.mjs";
import { acquireSlot } from "./inflight_registry.mjs";
import { isProcessAlive, processStartEvidence } from "./process_liveness.mjs";
import { appendPerfEvent } from "./resource_sampler.mjs";
import {
  claimLogicalRunForJob,
  finalizeRunAttempt,
  reconcileRuntimeLedger,
  recordRunAttemptRunning,
} from "./runtime_ledger.mjs";
import {
  acquireSkyhookAdmission,
  skyhookRolloutEnabledFor,
  skyhookStartupWindowMs,
} from "./skyhook_dispatch_policy.mjs";
import { recordRunSessionOutcome } from "./run_session_outcome.mjs";
import {
  evaluateScopeDispatch,
  advanceAfterOverflow,
} from "./dispatch_evaluator.mjs";
import { infrastructureMarkerThroughSlot } from "./dispatch_infrastructure_marker.mjs";
import {
  NON_LAUNCH_SCHEDULE_ADVANCES,
  applyTerminalLedgerSkip,
  persistRuntimePatch,
  persistRuntimePatches,
  runtimePatchFor,
} from "./dispatch_schedule_finalization.mjs";
import {
  sleepMsAsync as retryStoreSleepAsync,
  withRuntimeStoreTransactionRetry,
  withRuntimeStoreTransactionRetryAsync,
} from "./runtime_store_retry.mjs";
import { assignmentRunContract } from "./assignment_completion_delivery.mjs";

export {
  persistInprocScheduleDecision,
  persistRuntimePatch,
  persistRuntimePatches,
} from "./dispatch_schedule_finalization.mjs";

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function commandStartupWindowMs() {
  const raw = Number.parseInt(process.env.HELM_COMMAND_STARTUP_WINDOW_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 250;
}

// Opportunity #4: capture start-time evidence at spawn so the reaper can
// verify PID identity before any orphan decision or kill signal.
function pidStartTimeOf(pid) {
  try {
    return processStartEvidence(pid).start_time;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveProcessStdin(job, scope) {
  if (typeof job.process?.stdin === "string") return job.process.stdin;
  if (job.process?.stdin_file) {
    const base = job.process.cwd || scope.cwd;
    const resolved = isAbsolute(job.process.stdin_file)
      ? job.process.stdin_file
      : join(base, job.process.stdin_file);
    return readFileSync(resolved, "utf8");
  }
  return null;
}

export function readAndConsumeReportSidecar(cwd, runId) {
  if (!cwd || !runId) return null;
  const path = join(cwd, ".helm", "runs", "reports", `${runId}.json`);
  if (!existsSync(path)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
  return parsed;
}

function mergeAdapterAndReportFields(result, report) {
  // Adapter capture wins for session/resume; side-car wins for agent_*.
  const fields = {
    session_id: result?.session_id ?? report?.session_id ?? null,
    resume_command: result?.resume_command ?? report?.resume_command ?? null,
    resume_cwd: result?.resume_cwd ?? null,
    resume_confidence: result?.resume_confidence ?? null,
    resume_candidates: Array.isArray(result?.resume_candidates)
      ? result.resume_candidates
      : [],
    agent_summary: report?.summary ?? null,
    agent_status: report?.status ?? null,
    agent_error: report?.error ?? null,
    agent_origin_thread_id: report?.origin_thread_id ?? null,
    agent_completion_message_id: report?.completion_message_id ?? null,
    agent_communication_issue: report?.communication_issue ?? null,
    injected_via: result?.injected_via ?? null,
    agent_fallback: result?.agent_fallback ?? null,
  };
  return fields;
}

function historyStartEvent(
  job,
  runId,
  startedAt,
  reason,
  scheduledAt,
  logPaths,
) {
  return {
    id: `run_${runId}_started`,
    ts: startedAt,
    scope_id: null,
    cwd: null,
    job_id: job.id,
    run_id: runId,
    kind: "started",
    status: "running",
    reason,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    error: null,
    log_paths: logPaths,
    payload: {
      log_paths: logPaths,
      ...(assignmentRunContract(job)
        ? { assignment_run_contract: assignmentRunContract(job) }
        : {}),
    },
  };
}

function historyCompleteEvent(
  job,
  runId,
  startedAt,
  finishedAt,
  result,
  logPaths,
  notificationResults,
) {
  return {
    id: `run_${runId}_completed`,
    ts: finishedAt,
    scope_id: null,
    cwd: null,
    job_id: job.id,
    run_id: runId,
    kind: "completed",
    status:
      result.error && String(result.error).startsWith("timeout after ")
        ? "timeout"
        : result.status,
    reason: null,
    scheduled_at: null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: result.duration_ms,
    error: result.error,
    log_paths: logPaths,
    payload: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
      log_paths: logPaths,
      wrapper: result.wrapper || null,
      memory: result.memory || result.wrapper?.memory || null,
      output: result.output || null,
      notification_results: notificationResults || [],
    },
  };
}

function historyRetryEvent(
  scope,
  job,
  runId,
  startedAt,
  scheduledAt,
  attempt,
  maxAttempts,
  delayMs,
  previousError,
  logPaths,
) {
  return {
    id: `run_${runId}_retry_${attempt}`,
    ts: nowIso(),
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    kind: "retry",
    status: "retrying",
    reason: "retry",
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    error: previousError || null,
    log_paths: logPaths,
    payload: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
      attempt,
      max_attempts: maxAttempts,
      delay_ms: delayMs,
      previous_error: previousError || null,
      log_paths: logPaths,
    },
  };
}

function historySkippedEvent(
  scope,
  job,
  runId,
  scheduledAt,
  reason,
  error = null,
) {
  return {
    id: `run_${runId}_skipped`,
    ts: nowIso(),
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    kind: "skipped",
    status: "skipped",
    reason,
    scheduled_at: scheduledAt,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    error,
    log_paths: null,
    payload: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
    },
  };
}

function historyDeferredEvent(scope, job, scheduledAt, reason) {
  return {
    id: `job_${job.id}_deferred_${Date.now()}`,
    ts: nowIso(),
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: null,
    kind: "deferred",
    status: "deferred",
    reason,
    scheduled_at: scheduledAt,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    error: null,
    log_paths: null,
    payload: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
    },
  };
}

function historyCancelledEvent(scope, jobId, entry) {
  const cancelledAt = nowIso();
  return {
    id: `run_${entry.run_id}_cancelled`,
    ts: cancelledAt,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: jobId,
    run_id: entry.run_id,
    kind: "cancelled",
    status: "cancelled",
    reason: "cancelled",
    scheduled_at: null,
    started_at: entry.started_at || null,
    finished_at: cancelledAt,
    duration_ms: null,
    error: null,
    log_paths: entry.log_paths || null,
    payload: {
      cancelled_at: cancelledAt,
      log_paths: entry.log_paths || null,
    },
  };
}

// Derive a short, bounded failure string + the failing step from a run result.
// `result.error` already carries a compact code (exit_code_N, timeout after Ns,
// missing_agent_session_id: ..., or an adapter classification summary). We map
// that to a coarse step label so job state names *where* the tick broke. On
// success both fields clear to null. (COE-2026-05-22 orchestrator-tick AI-1.)
function deriveFailureDetail(result) {
  if (!result || result.status === "success") {
    return { last_error: null, last_failed_step: null };
  }
  const rawError = result.error
    ? String(result.error)
    : `status_${result.status || "unknown"}`;
  // Cap the stored string so a runaway adapter summary can't bloat jobs.json.
  const last_error =
    rawError.length > 500 ? `${rawError.slice(0, 497)}...` : rawError;
  let last_failed_step = "run";
  if (rawError.startsWith("timeout after ")) last_failed_step = "timeout";
  else if (rawError.startsWith("exit_code_")) last_failed_step = "process_exit";
  else if (rawError.startsWith("missing_agent_session_id"))
    last_failed_step = "session_resolution";
  else if (result.agent_session_required)
    last_failed_step = "session_resolution";
  else if (result.agent_classification?.status === "failure")
    last_failed_step = "agent_classification";
  return { last_error, last_failed_step };
}

function computeRetryDelay(retry, attempt) {
  const baseSec = retry.delay_sec || 0;
  if (retry.backoff === "linear") return baseSec * attempt * 1000;
  if (retry.backoff === "exponential")
    return baseSec * Math.pow(2, attempt - 1) * 1000;
  return baseSec * 1000; // 'none'
}

function sleepMs(ms) {
  return retryStoreSleepAsync(ms);
}

function runtimeStoreLockDetails(err) {
  return {
    code: err?.code || "runtime_store_locked",
    message: err?.message || "runtime store lock is already held",
    lock_path: err?.details?.lock_path || null,
    holder_pid: err?.details?.holder_pid || null,
    owner: err?.details?.owner || null,
  };
}

function laterIsoOrCandidate(existing, candidate) {
  if (!existing || !candidate) return candidate;
  const existingMs = new Date(existing).getTime();
  const candidateMs = new Date(candidate).getTime();
  if (!Number.isFinite(existingMs) || !Number.isFinite(candidateMs)) {
    return candidate;
  }
  return existingMs > candidateMs ? existing : candidate;
}

function appendRuntimeStoreLockPerf({
  context,
  status,
  waitMs,
  operationMs,
  attempt,
  maxAttempts,
  details = null,
}) {
  try {
    appendPerfEvent({
      event: "runtime_store_lock_wait_sample",
      type: "runtime_store_lock_wait_sample",
      classification: "helm_control_plane",
      subsystem: "runtime_store",
      scope_id: context.scope?.scope_id || null,
      cwd: context.scope?.cwd || null,
      job_id: context.jobId || null,
      run_id: context.runId || null,
      daemon_instance_id: context.daemonInstanceId || null,
      stage: context.stage || "unknown",
      status,
      deferred: status === "deferred",
      contended: attempt > 1 || status === "deferred",
      wait_ms: Math.max(0, waitMs),
      operation_ms: Math.max(0, operationMs),
      attempts: attempt,
      max_attempts: maxAttempts,
      code: details?.code || null,
      holder_pid: details?.holder_pid || null,
      owner: details?.owner || null,
    });
  } catch {
    // Perf telemetry must not change dispatch behavior.
  }
}

/**
 * Shared setup helper: resolves retry config values and computes a maxAttempts
 * hint for telemetry (the actual bound is time-only in the shared helper).
 */
function runtimeLockRetryConfig() {
  const retryMs = Number(process.env.HELM_RUNTIME_LOCK_RETRY_MS ?? 600);
  const intervalMs = Number(
    process.env.HELM_RUNTIME_LOCK_RETRY_INTERVAL_MS ?? 75,
  );
  const safeRetryMs = Number.isFinite(retryMs) && retryMs >= 0 ? retryMs : 600;
  const safeIntervalMs =
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 75;
  const maxAttempts = Math.max(1, Math.floor(safeRetryMs / safeIntervalMs) + 1);
  return { retryMs: safeRetryMs, intervalMs: safeIntervalMs, maxAttempts };
}

function makeRetryTelemetry(context, maxAttempts, startedMs) {
  // Tracks the attempt number that succeeded so appendRuntimeStoreLockPerf
  // gets the right value. Incremented by onRetry before each sleep.
  let currentAttempt = 1;
  let lastDetails = null;

  return {
    get currentAttempt() {
      return currentAttempt;
    },
    get lastDetails() {
      return lastDetails;
    },
    set lastDetails(v) {
      lastDetails = v;
    },
    onRetry({ attempt, error }) {
      currentAttempt = attempt + 1; // next attempt will be attempt+1
      if (error) lastDetails = runtimeStoreLockDetails(error);
    },
    onExhausted({ attempt, elapsedMs, error, details: rawDetails }) {
      if (error) lastDetails = runtimeStoreLockDetails(error);
      const details = lastDetails ?? rawDetails;
      appendRuntimeStoreLockPerf({
        context,
        status: "deferred",
        waitMs: elapsedMs,
        operationMs: elapsedMs,
        attempt,
        maxAttempts,
        details,
      });
    },
    onAcquired(operationStartedMs, operationEndedMs) {
      appendRuntimeStoreLockPerf({
        context,
        status: "acquired",
        waitMs: Math.max(0, operationStartedMs - startedMs),
        operationMs: Math.max(0, operationEndedMs - operationStartedMs),
        attempt: currentAttempt,
        maxAttempts,
        details: lastDetails,
      });
    },
  };
}

/**
 * Async thin wrapper: delegates retry loop to the shared helper in
 * runtime_store_retry.mjs, preserving dispatch-specific telemetry via
 * onRetry / onExhausted callbacks. No second copy of the policy logic.
 */
async function withRuntimeStoreLockRetry(context, fn) {
  const { retryMs, intervalMs, maxAttempts } = runtimeLockRetryConfig();
  const startedMs = Date.now();
  const tel = makeRetryTelemetry(context, maxAttempts, startedMs);

  const result = await withRuntimeStoreTransactionRetryAsync(
    null,
    {
      retryMs,
      intervalMs,
      context,
      onRetry: tel.onRetry.bind(tel),
      onExhausted: tel.onExhausted.bind(tel),
    },
    async () => {
      const operationStartedMs = Date.now();
      const value = fn();
      tel.onAcquired(operationStartedMs, Date.now());
      return value;
    },
  );

  if (result.ok) return result;

  // Merge dispatch-specific details shape onto the returned error details
  const rawErr = result.error;
  const dispatchDetails = runtimeStoreLockDetails(rawErr);
  return {
    ok: false,
    error: rawErr,
    details: { ...dispatchDetails, action: "defer_nonfatal" },
  };
}

/**
 * Sync thin wrapper: delegates retry loop to the shared helper in
 * runtime_store_retry.mjs, preserving dispatch-specific telemetry via
 * onRetry / onExhausted callbacks. No second copy of the policy logic.
 */
function withRuntimeStoreLockRetrySync(context, fn) {
  const { retryMs, intervalMs, maxAttempts } = runtimeLockRetryConfig();
  const startedMs = Date.now();
  const tel = makeRetryTelemetry(context, maxAttempts, startedMs);

  const result = withRuntimeStoreTransactionRetry(
    null,
    {
      retryMs,
      intervalMs,
      context,
      onRetry: tel.onRetry.bind(tel),
      onExhausted: tel.onExhausted.bind(tel),
    },
    () => {
      const operationStartedMs = Date.now();
      const value = fn();
      tel.onAcquired(operationStartedMs, Date.now());
      return value;
    },
  );

  if (result.ok) return result;

  // Merge dispatch-specific details shape onto the returned error details
  const rawErr = result.error;
  const dispatchDetails = runtimeStoreLockDetails(rawErr);
  return {
    ok: false,
    error: rawErr,
    details: { ...dispatchDetails, action: "defer_nonfatal" },
  };
}

function appendRuntimeStoreDeferredEvent({
  type,
  scope,
  jobId,
  runId,
  daemonInstanceId,
  reason,
  metadata,
  details,
}) {
  appendActivityEvent({
    type,
    kind: "run",
    level: "info",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: jobId,
    run_id: runId,
    status: "deferred",
    reason,
    error: null,
    data: {
      metadata: isPlainObject(metadata) ? metadata : {},
      ...details,
    },
  });
}

export function recordLaunchEvidenceWithRuntimeStoreRetry({
  home,
  scope,
  jobId,
  runId,
  daemonInstanceId = null,
  metadata = null,
  processInfo,
  now = nowIso(),
} = {}) {
  const attempt = withRuntimeStoreLockRetrySync(
    {
      scope,
      stage: "launch_evidence",
      jobId,
      daemonInstanceId,
    },
    () =>
      recordRunAttemptRunning({
        home,
        attemptId: runId,
        wrapperPid: processInfo.wrapper?.pid || processInfo.pid,
        jobPid: processInfo.pid,
        processGroupId: processInfo.wrapper?.pgid || processInfo.pid,
        wrapperState: "post_exec",
        now,
      }),
  );
  if (!attempt.ok) {
    appendRuntimeStoreDeferredEvent({
      type: "job_launch_evidence_deferred",
      scope,
      jobId,
      runId,
      daemonInstanceId,
      reason: "runtime_store_locked",
      metadata,
      details: attempt.details,
    });
  }
  return attempt;
}

export function finalizeRunAttemptWithRuntimeStoreRetry({
  home,
  scope,
  jobId,
  runId,
  daemonInstanceId = null,
  metadata = null,
  status,
  error = null,
  cleanup = null,
  exitCode = null,
  terminalSource = null,
  signalSource = null,
  startupWindowMs = null,
  now = nowIso(),
} = {}) {
  const attempt = withRuntimeStoreLockRetrySync(
    {
      scope,
      stage: "terminal_finalization",
      jobId,
      daemonInstanceId,
    },
    () =>
      finalizeRunAttempt({
        home,
        attemptId: runId,
        status,
        error,
        cleanup,
        exitCode,
        terminalSource,
        signalSource,
        startupWindowMs,
        now,
      }),
  );
  if (!attempt.ok) {
    appendRuntimeStoreDeferredEvent({
      type: "job_terminal_finalization_deferred",
      scope,
      jobId,
      runId,
      daemonInstanceId,
      reason: "runtime_store_locked",
      metadata,
      details: attempt.details,
    });
  }
  return attempt;
}

// startRun: synchronous prelude that spawns a job in the background and returns
// a handle with the runId + a completion Promise. Returns `null` if the
// per-scope concurrency cap is saturated (caller handles deferral), or a
// structured skipped handle when the runtime ledger rejects the run claim.
//
// The completion Promise resolves to the final completed-history event (same
// shape as the legacy runOne return). It is also registered in the in-flight
// registry so callers can drain via drainInflight().
export function startRun(scope, job, opts = {}) {
  // Opportunity #10: run ids share the dispatch clock (HELM_NOW-aware) so
  // run identity and due-ness cannot disagree under replay; the random
  // suffix keeps ids unique within a frozen clock.
  const runId = `run_${new Date(nowIso()).getTime()}_${Math.random().toString(16).slice(2, 8)}`;
  const startedAt = nowIso();
  const scheduledAt = opts.scheduledAt || null;
  const reason = opts.reason || "manual";
  const daemonInstanceId = opts.daemonInstanceId || null;
  const consumedPhaseAbortedSlot =
    opts.consumedInfrastructureSlot ||
    infrastructureMarkerThroughSlot(job, scheduledAt) ||
    (reason === "scheduled" ? scheduledAt : null);
  const logPaths = runLogPaths(scope, job.id, runId);
  const baselineUpdatedAt =
    opts.baselineUpdatedAt ?? job.meta?.updated_at ?? null;
  const skyhookAgentRun = skyhookRolloutEnabledFor(job);
  const fakeExecValue = process.env.HELM_FAKE_EXEC_JSON;
  const fakeExecActive = Boolean(
    fakeExecValue && fakeExecValue !== "undefined" && fakeExecValue !== "null",
  );
  const notificationChannels = Array.isArray(job?.notify?.channels)
    ? job.notify.channels
    : [];
  const hasCompletionDependentNotifications = notificationChannels.some(
    (channel) => channel === "file" || channel === "webhook",
  );
  const startConfirmCommandRun = Boolean(
    reason === "scheduled" &&
      scheduledAt &&
      !skyhookAgentRun &&
      job?.process?.command &&
      !fakeExecActive &&
      !hasCompletionDependentNotifications,
  );

  let completionResolve;
  let completionReject;
  const completion = new Promise((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });

  const skyhookAdmission = skyhookAgentRun
    ? acquireSkyhookAdmission(runId)
    : null;
  if (skyhookAdmission && !skyhookAdmission.admitted) {
    appendActivityEvent({
      type: "job_dispatch_deferred",
      kind: "run",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      scheduled_at: scheduledAt,
      reason: skyhookAdmission.reason,
      data: {
        metadata: isPlainObject(job.metadata) ? job.metadata : {},
        cap: skyhookAdmission.cap || null,
        rate: skyhookAdmission.rate || null,
      },
    });
    return null;
  }

  const releaseSlot = acquireSlot(scope, runId, completion);
  if (releaseSlot === null) {
    if (skyhookAdmission?.release) skyhookAdmission.release();
    appendActivityEvent({
      type: "job_dispatch_deferred",
      kind: "run",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      scheduled_at: scheduledAt,
      reason: "concurrency_saturated",
      data: {
        metadata: isPlainObject(job.metadata) ? job.metadata : {},
      },
    });
    return null;
  }

  let ledgerClaim = null;
  const claimAttempt = withRuntimeStoreLockRetrySync(
    { scope, stage: "claim", jobId: job.id, daemonInstanceId },
    () =>
      claimLogicalRunForJob({
        scope,
        job,
        scheduledAt: scheduledAt || startedAt,
        attemptId: runId,
        daemonInstanceId: daemonInstanceId || "manual",
        leaseToken: runId,
        now: startedAt,
      }),
  );
  if (!claimAttempt.ok) {
    if (skyhookAdmission?.release) skyhookAdmission.release();
    releaseSlot();
    appendActivityEvent({
      type: "job_dispatch_deferred",
      kind: "run",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      scheduled_at: scheduledAt,
      status: "deferred",
      reason: "runtime_store_locked",
      error: null,
      data: {
        metadata: isPlainObject(job.metadata) ? job.metadata : {},
        ...claimAttempt.details,
      },
    });
    return null;
  }
  ledgerClaim = claimAttempt.value;

  if (!ledgerClaim.claimed) {
    if (skyhookAdmission?.release) skyhookAdmission.release();
    releaseSlot();
    const skipReason = ledgerClaim.reason || "duplicate_logical_run";
    const skippedEvent = historySkippedEvent(
      scope,
      job,
      runId,
      scheduledAt,
      skipReason,
    );
    appendActivityEvent({
      type: "job_run_skipped",
      kind: "run",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: runId,
      reason: skipReason,
      scheduled_at: scheduledAt,
      status: "skipped",
      data: {
        logical_run_key: ledgerClaim.logical_run_key,
        existing_status: ledgerClaim.status,
        existing_state: ledgerClaim.state,
        identity_key: ledgerClaim.identity_key || null,
        blocking_attempt_id: ledgerClaim.blocking_attempt_id || null,
      },
    });
    appendJobHistoryEvent(scope, job.id, skippedEvent);
    return {
      skipped: true,
      reason: skipReason,
      runId,
      scheduledAt,
      event: skippedEvent,
      ledgerClaim,
    };
  }

  appendActivityEvent({
    type: "job_run_started",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    reason,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    data: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
      log_paths: logPaths,
    },
  });
  appendJobHistoryEvent(scope, job.id, {
    ...historyStartEvent(job, runId, startedAt, reason, scheduledAt, logPaths),
    scope_id: scope.scope_id,
    cwd: scope.cwd,
  });

  let releasedSlot = false;
  const releaseCapacity = () => {
    if (releasedSlot) return;
    releasedSlot = true;
    if (skyhookAdmission?.release) skyhookAdmission.release();
    releaseSlot();
  };

  // Kick off the background completion. Legacy command jobs resolve to the
  // completed-history event; Skyhook agent jobs resolve once session identity is
  // confirmed and continue terminal observation in the background.
  (async () => {
    try {
      if (skyhookAgentRun) {
        const startedEvent = await executeAndFinalizeSkyhookAgent(
          scope,
          job,
          opts,
          {
            runId,
            startedAt,
            scheduledAt,
            reason,
            daemonInstanceId,
            logPaths,
            baselineUpdatedAt,
            consumedPhaseAbortedSlot,
          },
          releaseCapacity,
        );
        completionResolve(startedEvent);
      } else if (startConfirmCommandRun) {
        const startedEvent = await executeAndFinalizeCommandStarted(
          scope,
          job,
          opts,
          {
            runId,
            startedAt,
            scheduledAt,
            reason,
            daemonInstanceId,
            logPaths,
            baselineUpdatedAt,
            consumedPhaseAbortedSlot,
          },
        );
        completionResolve(startedEvent);
      } else {
        const completedEvent = await executeAndFinalize(scope, job, opts, {
          runId,
          startedAt,
          scheduledAt,
          reason,
          daemonInstanceId,
          logPaths,
          baselineUpdatedAt,
          consumedPhaseAbortedSlot,
        });
        completionResolve(completedEvent);
      }
    } catch (err) {
      completionReject(err);
    } finally {
      releaseCapacity();
    }
  })();

  return {
    runId,
    startedAt,
    logPaths,
    completion,
    skyhookAgentRun,
    startConfirmCommandRun,
  };
}

export async function runOne(scope, job, opts = {}) {
  const handle = startRun(scope, job, opts);
  if (handle === null) {
    throw Object.assign(new Error("concurrency saturated"), {
      code: "concurrency_saturated",
      exitCode: 1,
    });
  }
  if (handle.skipped) return handle.event;
  return await handle.completion;
}

// The handoff returns once the session is up, but the session is a process this
// dispatcher launched and still holds a terminal promise for. Its exit is the
// work's own boundary, so it is recorded as the run's terminal work outcome —
// the fact that makes a handed-off run finishable without the agent choosing to
// report. Detached from the dispatch: the run is finalized either way, and a
// boundary that cannot be recorded must not fail the launch.
function observeAgentSessionBoundary({ scope, jobId, runId, terminal }) {
  if (!terminal || typeof terminal.then !== "function") return;
  terminal.then(
    (outcome) => {
      recordRunSessionOutcome({
        cwd: scope.cwd,
        jobId,
        runId,
        status: outcome?.status,
        finishedAt: nowIso(),
        exitCode: outcome?.exit_code ?? null,
        signal: outcome?.signal ?? null,
        error: outcome?.error ?? null,
      });
    },
    () => {
      /* the launch already reported its own failure */
    },
  );
}

async function executeAndFinalizeSkyhookAgent(
  scope,
  job,
  opts,
  ctx,
  releaseCapacity,
) {
  const {
    runId,
    startedAt,
    scheduledAt,
    reason,
    daemonInstanceId,
    logPaths,
    baselineUpdatedAt,
    consumedPhaseAbortedSlot,
  } = ctx;
  let spawned = false;
  let livePid = null;
  let result;
  try {
    result = await executeJob(job, {
      schedulerScriptPath: opts.schedulerScriptPath,
      scope,
      logPaths,
      runId,
      startedAt,
      runMode: reason === "manual" ? "direct" : "scheduled",
      memoryMode: opts.memoryMode || null,
      resolveOnStarted: true,
      startupWindowMs: skyhookStartupWindowMs(job),
      onSpawn: (processInfo) => {
        spawned = true;
        livePid = processInfo.pid;
        recordLaunchEvidenceWithRuntimeStoreRetry({
          scope,
          jobId: job.id,
          runId,
          daemonInstanceId,
          metadata: job.metadata || null,
          processInfo,
          now: nowIso(),
        });
        setActiveRun(scope, job.id, {
          run_id: runId,
          pid: processInfo.pid,
          pid_start_time: pidStartTimeOf(processInfo.pid),
          heartbeat_path: runHeartbeatPath(scope, runId),
          started_at: startedAt,
          command: processInfo.command,
          args: processInfo.args,
          cwd: processInfo.cwd,
          log_paths: logPaths,
          wrapper: processInfo.wrapper || null,
          memory: processInfo.wrapper?.memory || null,
          skyhook: true,
        });
      },
    });
  } catch (err) {
    result = {
      status: "failure",
      error: String(err?.message || err),
      duration_ms: 0,
      wrapper: null,
      output: null,
    };
  }

  if (result.status !== "started") {
    releaseCapacity();
    if (spawned) clearActiveRun(scope, job.id);
    const finishedAt = nowIso();
    finalizeRunAttemptWithRuntimeStoreRetry({
      scope,
      jobId: job.id,
      runId,
      daemonInstanceId,
      metadata: job.metadata || null,
      status: "failure",
      error: result.error || "agent_start_failed",
      cleanup: result.wrapper?.cleanup || null,
      exitCode: result.exit_code ?? null,
      terminalSource: "supervisor",
      signalSource: result.signal_source || null,
      startupWindowMs: result.startup_window_ms || null,
      now: finishedAt,
    });
    const failedEvent = historyCompleteEvent(
      job,
      runId,
      startedAt,
      finishedAt,
      { ...result, status: "failure" },
      logPaths,
      [],
    );
    appendJobHistoryEvent(scope, job.id, {
      ...failedEvent,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      scheduled_at: scheduledAt,
    });
    appendActivityEvent({
      type: "job_run_completed_failure",
      kind: "run",
      level: "error",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: runId,
      status: "failure",
      reason,
      scheduled_at: scheduledAt,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: result.duration_ms,
      elapsed_ms: result.elapsed_ms ?? result.duration_ms,
      pid: livePid,
      error: result.error || "agent_start_failed",
      data: {
        metadata: isPlainObject(job.metadata) ? job.metadata : {},
        log_paths: logPaths,
        wrapper: result.wrapper || null,
        memory: result.memory || result.wrapper?.memory || null,
        output: result.output || null,
        pid: result.pid || livePid || null,
        signal_source: result.signal_source || null,
        startup_window_ms: result.startup_window_ms || null,
        elapsed_ms: result.elapsed_ms ?? result.duration_ms ?? null,
        agent_session_required: result.agent_session_required === true,
        skyhook: true,
      },
    });
    return {
      ...failedEvent,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      scheduled_at: scheduledAt,
    };
  }

  const startedMemory = result.memory || result.wrapper?.memory || null;
  if (spawned) {
    setActiveRun(scope, job.id, {
      run_id: runId,
      pid: result.pid || livePid,
      pid_start_time: pidStartTimeOf(result.pid || livePid),
      heartbeat_path: runHeartbeatPath(scope, runId),
      started_at: startedAt,
      command: result.wrapper?.command || null,
      args: result.wrapper?.args || [],
      cwd: result.wrapper?.cwd || job.process?.cwd || scope.cwd,
      log_paths: logPaths,
      wrapper: result.wrapper || null,
      memory: startedMemory,
      skyhook: true,
    });
  }

  appendActivityEvent({
    type: "job_run_identity_registered",
    kind: "run",
    level: "info",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    status: "running",
    reason,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    pid: result.pid || livePid,
    data: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
      session_id: result.session_id || null,
      signal_source: result.signal_source || null,
      startup_window_ms: result.startup_window_ms || null,
      memory: startedMemory,
      skyhook: true,
    },
  });
  observeAgentSessionBoundary({
    scope,
    jobId: job.id,
    runId,
    terminal: result.terminal,
  });
  result.detach?.();
  releaseCapacity();

  const startedEvent = {
    id: `run_${runId}_skyhook_started`,
    ts: nowIso(),
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    kind: "started",
    status: "running",
    reason: "skyhook_started",
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: null,
    duration_ms: result.duration_ms,
    dispatch_latency_ms: result.duration_ms,
    queue_age_ms: scheduledAt
      ? Math.max(0, Date.parse(startedAt) - Date.parse(scheduledAt))
      : null,
    resume_duration_ms: result.duration_ms,
    due_but_not_run_count: 0,
    blocked_scope_count: 0,
    error: null,
    log_paths: logPaths,
    session_id: result.session_id || null,
    memory: startedMemory,
    payload: {
      session_id: result.session_id || null,
      signal_source: result.signal_source || null,
      startup_window_ms: result.startup_window_ms || null,
      memory: startedMemory,
      dispatch_latency_ms: result.duration_ms,
      queue_age_ms: scheduledAt
        ? Math.max(0, Date.parse(startedAt) - Date.parse(scheduledAt))
        : null,
      resume_duration_ms: result.duration_ms,
      due_but_not_run_count: 0,
      blocked_scope_count: 0,
      skyhook: true,
      ...(assignmentRunContract(job)
        ? { assignment_run_contract: assignmentRunContract(job) }
        : {}),
    },
  };

  {
    const finishedAt = nowIso();
    if (spawned) clearActiveRun(scope, job.id);
    finalizeRunAttemptWithRuntimeStoreRetry({
      scope,
      jobId: job.id,
      runId,
      daemonInstanceId,
      metadata: job.metadata || null,
      status: "success",
      error: "skyhook_started",
      cleanup: result.wrapper?.cleanup || null,
      terminalSource: "skyhook-handoff",
      signalSource: result.signal_source || null,
      startupWindowMs: result.startup_window_ms || null,
      now: finishedAt,
    });
    appendActivityEvent({
      type: "job_run_completed_success",
      kind: "run",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: runId,
      status: "success",
      reason: "skyhook_started",
      scheduled_at: scheduledAt,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: result.duration_ms,
      pid: result.pid || livePid,
      error: null,
      data: {
        metadata: isPlainObject(job.metadata) ? job.metadata : {},
        log_paths: logPaths,
        wrapper: result.wrapper || null,
        memory: result.memory || result.wrapper?.memory || null,
        output: result.output || null,
        session_id: result.session_id || null,
        signal_source: result.signal_source || null,
        startup_window_ms: result.startup_window_ms || null,
        skyhook: true,
        handoff: true,
      },
    });
    const completedEvent = historyCompleteEvent(
      job,
      runId,
      startedAt,
      finishedAt,
      { ...result, status: "success", error: null },
      logPaths,
      [],
    );
    appendJobHistoryEvent(scope, job.id, {
      ...completedEvent,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      scheduled_at: scheduledAt,
      session_id: result.session_id || null,
    });
    job.state.last_run_at = finishedAt;
    job.state.last_status = "success";
    job.state.last_error = null;
    job.state.last_failed_step = null;
    job.state.deferred_since = null;
    job.state.deferred_reason = null;
    const next = computeNextAfterRun(
      job,
      scheduledAt || finishedAt,
      finishedAt,
    );
    job.state.next_run_at = next.next_run_at;
    if (!next.enabled) job.state.enabled = false;
    job.meta.updated_at = nowIso();
    await persistRuntimePatch(
      scope,
      job.id,
      baselineUpdatedAt,
      runtimePatchFor(job, consumedPhaseAbortedSlot),
    );
    return startedEvent;
  }
}

async function executeAndFinalizeCommandStarted(scope, job, opts, ctx) {
  const {
    runId,
    startedAt,
    scheduledAt,
    reason,
    daemonInstanceId,
    logPaths,
    baselineUpdatedAt,
    consumedPhaseAbortedSlot,
  } = ctx;
  let spawned = false;
  let livePid = null;
  let spawnedProcessInfo = null;
  let result;
  try {
    const cwd = job.process?.cwd || scope.cwd;
    const runtimeScopeId = scope.scope_id || scope.cwd;
    const runtimeScopeCwd = cwd;
    const heartbeatPath = runHeartbeatPath(scope, runId);
    result = await launchCommandUntilStarted({
      command: job.process.command,
      args: Array.isArray(job.process.args)
        ? job.process.args.map((value) => String(value))
        : [],
      cwd,
      timeoutSec: job.limits?.timeout_sec ?? job.execution?.timeout_sec ?? null,
      stdinText: resolveProcessStdin(job, scope),
      extraEnv: {
        HELM_JOB_ID: job.id,
        HELM_JOB_NAME: job.name,
        HELM_RUN_ID: runId,
        HELM_SCOPE_ID: runtimeScopeId,
        HELM_SCOPE_CWD: runtimeScopeCwd,
        HELM_TRIGGERED_AT: new Date().toISOString(),
        HELM_RUN_HEARTBEAT_PATH: heartbeatPath,
        ...(job.process.env && typeof job.process.env === "object"
          ? job.process.env
          : {}),
      },
      memoryMode: opts.memoryMode || process.env.HELM_MEMORY || null,
      onSpawn: (processInfo) => {
        spawned = true;
        livePid = processInfo.pid;
        spawnedProcessInfo = processInfo;
      },
      logPaths,
      startupWindowMs: commandStartupWindowMs(),
    });
  } catch (err) {
    result = {
      status: "failure",
      error: String(err?.message || err),
      duration_ms: 0,
      wrapper: null,
      output: null,
    };
  }

  if (spawned && spawnedProcessInfo) {
    recordLaunchEvidenceWithRuntimeStoreRetry({
      scope,
      jobId: job.id,
      runId,
      daemonInstanceId,
      metadata: job.metadata || null,
      processInfo: spawnedProcessInfo,
      now: nowIso(),
    });
    setActiveRun(scope, job.id, {
      run_id: runId,
      pid: spawnedProcessInfo.pid,
      pid_start_time: pidStartTimeOf(spawnedProcessInfo.pid),
      heartbeat_path: runHeartbeatPath(scope, runId),
      started_at: startedAt,
      command: spawnedProcessInfo.command,
      args: spawnedProcessInfo.args,
      cwd: spawnedProcessInfo.cwd,
      log_paths: logPaths,
      wrapper: spawnedProcessInfo.wrapper || null,
      memory: spawnedProcessInfo.wrapper?.memory || null,
      start_confirm: true,
    });
  }

  if (result.status !== "started") {
    if (spawned) clearActiveRun(scope, job.id);
    const finishedAt = nowIso();
    finalizeRunAttemptWithRuntimeStoreRetry({
      scope,
      jobId: job.id,
      runId,
      daemonInstanceId,
      metadata: job.metadata || null,
      status: "failure",
      error: result.error || "process_start_failed",
      cleanup: result.wrapper?.cleanup || null,
      exitCode: result.exit_code ?? null,
      terminalSource: "supervisor",
      signalSource: result.signal_source || null,
      startupWindowMs: result.startup_window_ms || null,
      now: finishedAt,
    });
    const failedEvent = historyCompleteEvent(
      job,
      runId,
      startedAt,
      finishedAt,
      { ...result, status: "failure" },
      logPaths,
      [],
    );
    appendJobHistoryEvent(scope, job.id, {
      ...failedEvent,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      scheduled_at: scheduledAt,
    });
    appendActivityEvent({
      type: "job_run_completed_failure",
      kind: "run",
      level: "error",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: runId,
      status: "failure",
      reason,
      scheduled_at: scheduledAt,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: result.duration_ms,
      elapsed_ms: result.elapsed_ms ?? result.duration_ms,
      pid: livePid,
      error: result.error || "process_start_failed",
      data: {
        metadata: isPlainObject(job.metadata) ? job.metadata : {},
        log_paths: logPaths,
        wrapper: result.wrapper || null,
        memory: result.memory || result.wrapper?.memory || null,
        output: result.output || null,
        pid: result.pid || livePid || null,
        signal_source: result.signal_source || null,
        startup_window_ms: result.startup_window_ms || null,
        elapsed_ms: result.elapsed_ms ?? result.duration_ms ?? null,
        handoff: false,
      },
    });
    return {
      ...failedEvent,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      scheduled_at: scheduledAt,
    };
  }

  result.detach?.();
  const finishedAt = nowIso();
  if (spawned) clearActiveRun(scope, job.id);
  finalizeRunAttemptWithRuntimeStoreRetry({
    scope,
    jobId: job.id,
    runId,
    daemonInstanceId,
    metadata: job.metadata || null,
    status: "success",
    error: "process_started",
    cleanup: result.wrapper?.cleanup || null,
    terminalSource: "process-handoff",
    signalSource: result.signal_source || null,
    startupWindowMs: result.startup_window_ms || null,
    now: finishedAt,
  });
  appendActivityEvent({
    type: "job_run_completed_success",
    kind: "run",
    level: "info",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    status: "success",
    reason: "process_started",
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: result.duration_ms,
    elapsed_ms: result.elapsed_ms ?? result.duration_ms,
    pid: result.pid || livePid,
    error: null,
    data: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
      log_paths: logPaths,
      wrapper: result.wrapper || null,
      memory: result.memory || result.wrapper?.memory || null,
      output: result.output || null,
      pid: result.pid || livePid || null,
      signal_source: result.signal_source || null,
      startup_window_ms: result.startup_window_ms || null,
      handoff: true,
    },
  });
  const completedEvent = historyCompleteEvent(
    job,
    runId,
    startedAt,
    finishedAt,
    { ...result, status: "success", error: null },
    logPaths,
    [],
  );
  appendJobHistoryEvent(scope, job.id, {
    ...completedEvent,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    scheduled_at: scheduledAt,
  });
  job.state.last_run_at = finishedAt;
  job.state.last_status = "success";
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
  return {
    ...completedEvent,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    scheduled_at: scheduledAt,
  };
}

async function executeAndFinalize(scope, job, opts, ctx) {
  const {
    runId,
    startedAt,
    scheduledAt,
    reason,
    daemonInstanceId,
    logPaths,
    baselineUpdatedAt,
    consumedPhaseAbortedSlot,
  } = ctx;

  let spawned = false;
  let livePid = null;
  let result;
  let retryAttempt = 0;
  const maxRetries = job.retry?.max_attempts || 0;

  for (;;) {
    spawned = false;
    livePid = null;
    try {
      // Retry attempts must execute serially for one run_id so history,
      // active-run, and wrapper cleanup evidence remain ordered.
      // eslint-disable-next-line no-await-in-loop
      result = await executeJob(job, {
        schedulerScriptPath: opts.schedulerScriptPath,
        scope,
        logPaths,
        runId,
        startedAt,
        runMode: reason === "manual" ? "direct" : "scheduled",
        memoryMode: opts.memoryMode || null,
        onSpawn: (processInfo) => {
          spawned = true;
          livePid = processInfo.pid;
          recordLaunchEvidenceWithRuntimeStoreRetry({
            scope,
            jobId: job.id,
            runId,
            daemonInstanceId,
            metadata: job.metadata || null,
            processInfo,
            now: nowIso(),
          });
          setActiveRun(scope, job.id, {
            run_id: runId,
            pid: processInfo.pid,
            pid_start_time: pidStartTimeOf(processInfo.pid),
            heartbeat_path: runHeartbeatPath(scope, runId),
            started_at: startedAt,
            command: processInfo.command,
            args: processInfo.args,
            cwd: processInfo.cwd,
            log_paths: logPaths,
            wrapper: processInfo.wrapper || null,
            memory: processInfo.wrapper?.memory || null,
          });
        },
      });
    } finally {
      if (spawned) clearActiveRun(scope, job.id);
    }

    if (result.status === "success" || retryAttempt >= maxRetries) {
      if (
        result.status !== "success" &&
        maxRetries > 0 &&
        retryAttempt >= maxRetries
      ) {
        appendActivityEvent({
          type: "job_retry_exhausted",
          kind: "job",
          level: "error",
          daemon_instance_id: daemonInstanceId,
          scope_id: scope.scope_id,
          cwd: scope.cwd,
          job_id: job.id,
          run_id: runId,
          status: "failure",
          source: "system",
          error: result.error,
          data: {
            attempts: retryAttempt,
            max_attempts: maxRetries,
            final_error: result.error,
          },
        });
      }
      break;
    }

    retryAttempt++;
    const delayMs = computeRetryDelay(job.retry, retryAttempt);
    appendActivityEvent({
      type: "job_run_retry",
      kind: "run",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: runId,
      status: "retrying",
      data: {
        attempt: retryAttempt,
        max_attempts: maxRetries,
        backoff: job.retry.backoff,
        delay_ms: delayMs,
        previous_error: result.error,
      },
    });
    appendJobHistoryEvent(
      scope,
      job.id,
      historyRetryEvent(
        scope,
        job,
        runId,
        startedAt,
        scheduledAt,
        retryAttempt,
        maxRetries,
        delayMs,
        result.error,
        logPaths,
      ),
    );

    // eslint-disable-next-line no-await-in-loop
    if (delayMs > 0) await sleepMs(delayMs);
  }

  const finishedAt = nowIso();
  finalizeRunAttemptWithRuntimeStoreRetry({
    scope,
    jobId: job.id,
    runId,
    daemonInstanceId,
    metadata: job.metadata || null,
    status: result.status,
    error: result.error,
    cleanup: result.wrapper?.cleanup || null,
    now: finishedAt,
  });
  const completionType = (() => {
    if (result.error && String(result.error).startsWith("timeout after "))
      return "job_run_completed_timeout";
    if (result.status === "success") return "job_run_completed_success";
    return "job_run_completed_failure";
  })();

  const notificationPayload = {
    event_type: "job_run_completed",
    job_id: job.id,
    run_id: runId,
    status: result.status,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: result.duration_ms,
    summary: result.status === "success" ? "completed" : "failed",
    error: result.error,
    metadata: isPlainObject(job.metadata) ? job.metadata : {},
    log_paths: logPaths,
    memory: result.memory || result.wrapper?.memory || null,
  };
  const notificationResults = await emitNotifications(
    job,
    notificationPayload,
    { jsonOnly: Boolean(opts.jsonOnly) },
  );

  const reportSidecar = readAndConsumeReportSidecar(
    job.process?.cwd || scope.cwd,
    runId,
  );
  const adapterFields = mergeAdapterAndReportFields(result, reportSidecar);

  appendActivityEvent({
    type: completionType,
    kind: "run",
    level: completionType === "job_run_completed_success" ? "info" : "error",
    daemon_instance_id: daemonInstanceId,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    status: result.status,
    reason,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: result.duration_ms,
    pid: livePid,
    error: result.error,
    data: {
      metadata: isPlainObject(job.metadata) ? job.metadata : {},
      log_paths: logPaths,
      wrapper: result.wrapper || null,
      memory: result.memory || result.wrapper?.memory || null,
      output: result.output || null,
      notification_results: notificationResults,
      ...adapterFields,
    },
  });

  for (const notification of notificationResults || []) {
    if (notification.channel === "stdout") {
      appendActivityEvent({
        type: notification.ok
          ? "notification_stdout_succeeded"
          : "notification_stdout_failed",
        kind: "notification",
        level: notification.ok ? "info" : "error",
        daemon_instance_id: daemonInstanceId,
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: job.id,
        run_id: runId,
        status: notification.ok ? "success" : "failure",
        source: "system",
        error: notification.error || null,
        data: {
          metadata: isPlainObject(job.metadata) ? job.metadata : {},
        },
      });
      continue;
    }
    if (notification.channel === "webhook") {
      appendActivityEvent({
        type: notification.ok
          ? "notification_webhook_succeeded"
          : "notification_webhook_failed",
        kind: "notification",
        level: notification.ok ? "info" : "error",
        daemon_instance_id: daemonInstanceId,
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: job.id,
        run_id: runId,
        status: notification.ok ? "success" : "failure",
        error: notification.error || null,
        data: {
          metadata: isPlainObject(job.metadata) ? job.metadata : {},
        },
      });
      continue;
    }
    if (notification.channel === "file") {
      appendActivityEvent({
        type: notification.ok
          ? "notification_file_appended"
          : "notification_file_failed",
        kind: "notification",
        level: notification.ok ? "info" : "error",
        daemon_instance_id: daemonInstanceId,
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: job.id,
        run_id: runId,
        status: notification.ok ? "success" : "failure",
        error: notification.error || null,
        data: {
          metadata: isPlainObject(job.metadata) ? job.metadata : {},
          file_path: job.notify?.file_path || null,
        },
      });
    }
  }

  const channelsLen = Array.isArray(job.notify?.channels)
    ? job.notify.channels.length
    : 0;
  const notifyOn = job.notify?.on || "both";
  if (
    (notificationResults || []).length === 0 &&
    (channelsLen === 0 || notifyOn === "none")
  ) {
    appendActivityEvent({
      type: "notification_no_channels",
      kind: "notification",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: runId,
      status: result.status,
      source: "system",
      data: {
        configured_channels: Array.isArray(job.notify?.channels)
          ? job.notify.channels
          : [],
        notify_on: notifyOn,
        run_status: result.status,
      },
    });
  }

  job.state.last_run_at = finishedAt;
  job.state.last_status = result.status;
  // Persist failure detail to job state so a failed run is diagnosable from
  // jobs.json alone, not just the activity stream (COE-2026-05-22
  // orchestrator-tick AI-1: job state stored only last_status, leaving us
  // blind to which step failed and why). Cleared to null on success.
  const failureDetail = deriveFailureDetail(result);
  job.state.last_error = failureDetail.last_error;
  job.state.last_failed_step = failureDetail.last_failed_step;
  job.state.deferred_since = null;
  job.state.deferred_reason = null;
  const next = computeNextAfterRun(job, scheduledAt || finishedAt, finishedAt);
  const previousNextRunAt = job.state.next_run_at;
  job.state.next_run_at = laterIsoOrCandidate(
    previousNextRunAt,
    next.next_run_at,
  );
  if (job.state.next_run_at) {
    appendActivityEvent({
      type: "job_next_run_scheduled",
      kind: "job",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: runId,
      source: "system",
      data: {
        next_run_at: job.state.next_run_at,
        computed_next_run_at: next.next_run_at,
        previous_next_run_at: previousNextRunAt,
        previous_run_at: scheduledAt || finishedAt,
        enabled: next.enabled,
      },
    });
  }
  if (!next.enabled) job.state.enabled = false;
  if (
    job.schedule.end_at &&
    new Date(finishedAt) > new Date(job.schedule.end_at)
  ) {
    job.state.enabled = false;
    job.state.next_run_at = null;
  }
  job.meta.updated_at = nowIso();

  // Auto-pause on consecutive failure threshold
  const failureThreshold = job.notify?.on_consecutive_failures;
  if (failureThreshold && result.status !== "success") {
    const recentEvents = loadJobHistory(scope, job.id, 1000).filter(
      (evt) => evt.kind === "completed",
    );
    // The current completion has not been appended yet, so seed the streak with it.
    let consecutive =
      result.status === "failure" || result.status === "timeout" ? 1 : 0;
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      if (
        recentEvents[i].status === "failure" ||
        recentEvents[i].status === "timeout"
      ) {
        consecutive++;
      } else break;
    }
    if (consecutive >= failureThreshold) {
      job.state.enabled = false;
      appendActivityEvent({
        type: "job_auto_paused",
        kind: "run",
        level: "error",
        daemon_instance_id: daemonInstanceId,
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: job.id,
        run_id: runId,
        status: "paused",
        data: {
          reason: "consecutive_failure_threshold",
          threshold: failureThreshold,
          consecutive_failures: consecutive,
        },
      });
    }
  }

  const baseHistoryEvent = historyCompleteEvent(
    job,
    runId,
    startedAt,
    finishedAt,
    result,
    logPaths,
    notificationResults,
  );
  const completedEvent = {
    ...baseHistoryEvent,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    scheduled_at: scheduledAt,
    ...adapterFields,
    payload: {
      ...baseHistoryEvent.payload,
      ...adapterFields,
    },
  };
  appendJobHistoryEvent(scope, job.id, completedEvent);

  // Persist the post-run job state. With concurrent dispatch, the calling
  // dispatch loop may have already returned, so the completion handler owns
  // the persist. The optimistic-concurrency check against baselineUpdatedAt
  // means a parallel writer (e.g., the dispatch loop's own end-of-tick patch)
  // cannot clobber our next_run_at advancement.
  await persistRuntimePatch(
    scope,
    job.id,
    baselineUpdatedAt,
    runtimePatchFor(job, consumedPhaseAbortedSlot),
  );

  return completedEvent;
}

export async function runJobNow(scope, id, opts = {}) {
  const leaseOwner = `manual_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  return withExecutionLease(scope, leaseOwner, async () => {
    const jobs = loadJobs(scope);
    const job = jobs.find((entry) => entry.id === id);
    if (!job) {
      throw Object.assign(new Error(`job '${id}' not found`), {
        code: "not_found",
        exitCode: 1,
      });
    }
    if (!job.state.enabled) {
      throw Object.assign(new Error(`job '${id}' is disabled`), {
        code: "job_disabled",
        exitCode: 1,
      });
    }
    let execJob = job;
    if (opts.overrides) {
      execJob = JSON.parse(JSON.stringify(job));
      if (opts.overrides.env && execJob.process) {
        execJob.process.env = {
          ...(execJob.process.env || {}),
          ...opts.overrides.env,
        };
      }
      if (opts.overrides.args && execJob.process) {
        execJob.process.args = opts.overrides.args;
      }
      if (opts.overrides.prompt && execJob.prompt) {
        execJob.prompt = { type: "inline", value: opts.overrides.prompt };
      }
      if (opts.overrides.memory) {
        execJob.memory = {
          ...(execJob.memory || {}),
          ...opts.overrides.memory,
        };
      }
    }
    // runOne now owns its own persistRuntimePatch via executeAndFinalize; we
    // don't double-persist here. If the concurrency cap is saturated, runOne
    // throws with code=concurrency_saturated.
    const result = await runOne(scope, execJob, {
      reason: "manual",
      scheduledAt: nowIso(),
      schedulerScriptPath: opts.schedulerScriptPath,
      jsonOnly: opts.jsonOnly,
      memoryMode: opts.memoryMode || null,
      daemonInstanceId: opts.daemonInstanceId || null,
    });
    return result;
  });
}

export async function dispatchScope(scope, opts = {}) {
  const at = opts.at || nowIso();
  const limit = Number(opts.limit || 50);
  // Default catchup = 1: if a job missed N scheduled ticks while the daemon
  // was busy/stalled, fire exactly once on recovery (with scheduled_at set to
  // the first missed slot) and skip the rest. Replaying every missed tick
  // produces destructive bursts for agent-spawning jobs. Per-job override
  // via schedule.max_catchup_runs for jobs that legitimately need replay.
  const maxCatchupRuns = Number(opts.maxCatchupRuns || 1);
  const daemonInstanceId = opts.daemonInstanceId || null;
  const dryRun = Boolean(opts.dryRun);
  const drainCompletions = opts.drainCompletions !== false;
  const leaseOwner =
    daemonInstanceId ||
    `dispatch_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  const launched = await withExecutionLease(scope, leaseOwner, async () => {
    if (!dryRun) markDispatchStarted(scope, daemonInstanceId);
    // dispatch_started activity event intentionally omitted — emitting on every
    // daemon tick (11 scopes × 4/min) drowns out real job events in the stream.

    // Reconciler/reaper sweep: runs BEFORE due-job evaluation so
    // freshly-unblocked jobs become eligible in the same tick.
    if (!dryRun) {
      const reconciledAttempt = await withRuntimeStoreLockRetry(
        {
          scope,
          stage: "reconcile",
          daemonInstanceId,
        },
        () => reconcileRuntimeLedger({ now: at }),
      );
      if (!reconciledAttempt.ok) {
        markDispatchFinished(scope, "success", null, daemonInstanceId);
        appendActivityEvent({
          type: "dispatch_deferred",
          kind: "dispatch",
          level: "info",
          daemon_instance_id: daemonInstanceId,
          scope_id: scope.scope_id,
          cwd: scope.cwd,
          status: "deferred",
          reason: "runtime_store_locked",
          error: null,
          data: reconciledAttempt.details,
        });
        return { dueEvents: [], spawnedHandles: [] };
      }
      await reapWorkspace(scope, { daemonInstanceId, now: at });
    }

    const dueEvents = [];
    // Spawned in-flight handles for this tick — drained at the end so dueEvents
    // includes completion events (callers count `kind === 'completed'`).
    const spawnedHandles = [];
    const scheduleAdvanceJobIds = new Set();
    const consumedInfrastructureSlots = new Map();
    const jobs = loadJobs(scope);
    const originalScheduledSlots = new Map(
      jobs.map((job) => {
        const scheduledAt = job.state?.next_run_at || null;
        return [
          job.id,
          infrastructureMarkerThroughSlot(job, scheduledAt) || scheduledAt,
        ];
      }),
    );
    const baselineUpdatedAt = new Map(
      jobs.map((job) => [job.id, job.meta?.updated_at || null]),
    );
    // Single-instance lock: jobs with a still-in-flight prior run are skipped
    // this tick. Reaper above has already cleared orphaned/hung entries, so
    // anything remaining is a live process. Without this, a long run that
    // outlives the daemon's per-tick lease boundary could overlap with the
    // next tick's dispatch (e.g., manual `helm-tasks dispatch-now`, multiple
    // daemons during a transition). next_run_at is intentionally NOT advanced;
    // the next tick re-evaluates and dispatches once the prior run clears.
    const activeRunsAtTickStart = loadActiveRunsReadOnly(scope).runs || {};
    try {
      const { jobDecisions } = await evaluateScopeDispatch(scope, {
        at,
        jobs,
        activeRuns: activeRunsAtTickStart,
        maxCatchupRuns,
        dryRun,
      });
      for (const decision of jobDecisions) {
        const consumedSlot = originalScheduledSlots.get(decision.job_id);
        if (NON_LAUNCH_SCHEDULE_ADVANCES.has(decision.action) && consumedSlot) {
          consumedInfrastructureSlots.set(decision.job_id, consumedSlot);
        }
      }

      for (const decision of jobDecisions) {
        if (dueEvents.length >= limit) break;
        const { job, job_id } = decision;

        if (decision.action === "in_flight") {
          if (!dryRun) {
            appendActivityEvent({
              type: "job_run_skipped",
              kind: "run",
              level: "info",
              daemon_instance_id: daemonInstanceId,
              scope_id: scope.scope_id,
              cwd: scope.cwd,
              job_id,
              status: "skipped",
              reason: "in_flight",
              scheduled_at: decision.scheduledAt,
              data: {
                metadata: isPlainObject(job.metadata) ? job.metadata : {},
                active_run_id: decision.activeRunId || null,
              },
            });
          }
          continue;
        }

        if (decision.action === "past_end_at") {
          scheduleAdvanceJobIds.add(job_id);
          continue;
        }

        // Emit skip events for missed-run-policy skips (no_slots path)
        if (decision.action === "no_slots") {
          for (const skipped of decision.skipped || []) {
            const skipRunId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
            const skippedEvent = dryRun
              ? historySkippedEvent(
                  scope,
                  job,
                  skipRunId,
                  skipped.scheduled_at,
                  skipped.reason,
                )
              : recordSkippedOccurrence({
                  scope,
                  job,
                  scheduledAt: skipped.scheduled_at,
                  reason: skipped.reason,
                  daemonInstanceId,
                }).history_event;
            dueEvents.push(skippedEvent);
          }
          continue;
        }

        if (decision.action === "defer") {
          const deferredEvent = historyDeferredEvent(
            scope,
            job,
            decision.scheduledAt,
            decision.reason,
          );
          appendJobHistoryEvent(scope, job.id, deferredEvent);
          appendActivityEvent({
            type: "job_run_deferred",
            kind: "run",
            level: "info",
            daemon_instance_id: daemonInstanceId,
            scope_id: scope.scope_id,
            cwd: scope.cwd,
            job_id,
            scheduled_at: decision.scheduledAt,
            reason: decision.reason,
            data: {
              metadata: isPlainObject(job.metadata) ? job.metadata : {},
              deferred_since: job.state.deferred_since,
              pending_slots: decision.slots?.length || 1,
            },
          });
          dueEvents.push(deferredEvent);
          continue;
        }

        if (decision.action === "expire_and_skip") {
          for (const slot of decision.slots) {
            const expiredRunId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
            const expiredEvent = dryRun
              ? historySkippedEvent(
                  scope,
                  job,
                  expiredRunId,
                  slot,
                  decision.reason,
                )
              : recordSkippedOccurrence({
                  scope,
                  job,
                  scheduledAt: slot,
                  reason: decision.reason,
                  daemonInstanceId,
                }).history_event;
            dueEvents.push(expiredEvent);
          }
          continue;
        }

        if (decision.action === "condition_miss") {
          for (const slot of decision.slots) {
            if (dueEvents.length >= limit) break;
            appendActivityEvent({
              type: "job_due_detected",
              daemon_instance_id: daemonInstanceId,
              scope_id: scope.scope_id,
              cwd: scope.cwd,
              job_id,
              scheduled_at: slot,
              data: {
                metadata: isPlainObject(job.metadata) ? job.metadata : {},
              },
            });
            const skipRunId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
            const skippedEvent = dryRun
              ? historySkippedEvent(
                  scope,
                  job,
                  skipRunId,
                  slot,
                  decision.reason,
                )
              : recordSkippedOccurrence({
                  scope,
                  job,
                  scheduledAt: slot,
                  reason: decision.reason,
                  daemonInstanceId,
                }).history_event;
            dueEvents.push(skippedEvent);
          }
          continue;
        }

        if (decision.action === "error_deferred") {
          appendActivityEvent({
            type: "job_dispatch_deferred",
            kind: "run",
            level: "info",
            daemon_instance_id: daemonInstanceId,
            scope_id: scope.scope_id,
            cwd: scope.cwd,
            job_id,
            status: "deferred",
            reason: decision.reason,
            error: String(decision.error?.message || decision.error),
            data: { metadata: isPlainObject(job.metadata) ? job.metadata : {} },
          });
          continue;
        }

        if (decision.action !== "launch") continue;

        // dryRun: push simplified event (evaluator already returned launch w/ slots)
        if (dryRun) {
          dueEvents.push({
            job_id,
            name: job.name,
            slots: decision.slots,
            overflow: decision.overflow || false,
          });
          continue;
        }

        // Emit skip events for coalesced / latest-only slots (decision.skipped)
        for (const skipped of decision.skipped || []) {
          const coalescedEvent = recordSkippedOccurrence({
            scope,
            job,
            scheduledAt: skipped.scheduled_at,
            reason: skipped.reason,
            daemonInstanceId,
          }).history_event;
          dueEvents.push(coalescedEvent);
        }

        // Slot execution loop
        const effectiveMaxCatchup =
          job.schedule.max_catchup ??
          job.schedule.max_catchup_runs ??
          maxCatchupRuns;
        let catchupBudgetUsed = 0;
        let overflowCandidate = decision.overflow_next || null;
        const queuedSlots = new Set(decision.slots);
        const slotsToProcess = [...decision.slots];

        const nextDueAfterSlot = (scheduledAt) => {
          const next = computeNextAfterRun(job, scheduledAt, scheduledAt);
          if (!next.enabled || !next.next_run_at) return null;
          if (new Date(next.next_run_at) > new Date(at)) return null;
          return next.next_run_at;
        };
        const queueNextDueSlot = (scheduledAt) => {
          const nextScheduledAt = nextDueAfterSlot(scheduledAt);
          if (!nextScheduledAt || queuedSlots.has(nextScheduledAt))
            return nextScheduledAt;
          queuedSlots.add(nextScheduledAt);
          slotsToProcess.push(nextScheduledAt);
          return nextScheduledAt;
        };

        for (const scheduledAt of slotsToProcess) {
          if (dueEvents.length >= limit) break;
          appendActivityEvent({
            type: "job_due_detected",
            daemon_instance_id: daemonInstanceId,
            scope_id: scope.scope_id,
            cwd: scope.cwd,
            job_id,
            scheduled_at: scheduledAt,
            data: { metadata: isPlainObject(job.metadata) ? job.metadata : {} },
          });

          const handle = startRun(scope, job, {
            reason: "scheduled",
            scheduledAt,
            schedulerScriptPath: opts.schedulerScriptPath,
            jsonOnly: opts.jsonOnly,
            daemonInstanceId,
            baselineUpdatedAt: baselineUpdatedAt.get(job.id) || null,
            drainCompletions,
            consumedInfrastructureSlot:
              originalScheduledSlots.get(job.id) || scheduledAt,
          });
          if (handle === null) {
            // Concurrency saturated; startRun emitted job_dispatch_deferred.
            break;
          }
          if (handle.skipped) {
            const ledgerSkip = applyTerminalLedgerSkip(
              job,
              handle,
              scheduledAt,
            );
            if (ledgerSkip) {
              consumedInfrastructureSlots.set(
                job.id,
                originalScheduledSlots.get(job.id) || scheduledAt,
              );
              dueEvents.push({
                ...handle.event,
                scope_id: scope.scope_id,
                cwd: scope.cwd,
              });
              if (
                ledgerSkip.terminal &&
                catchupBudgetUsed < effectiveMaxCatchup
              ) {
                overflowCandidate = queueNextDueSlot(scheduledAt);
              }
              continue;
            }
            break;
          }
          dueEvents.push({
            ...historyStartEvent(
              job,
              handle.runId,
              handle.startedAt,
              "scheduled",
              scheduledAt,
              handle.logPaths,
            ),
            scope_id: scope.scope_id,
            cwd: scope.cwd,
          });
          spawnedHandles.push({ jobId: job.id, scheduledAt, handle });
          catchupBudgetUsed += 1;
          overflowCandidate = nextDueAfterSlot(scheduledAt);
          if (catchupBudgetUsed >= effectiveMaxCatchup) break;
        }

        const suppressOverflow = decision.precheck?.action === "coalesce";
        const shouldRecordOverflow =
          decision.overflow &&
          overflowCandidate &&
          (catchupBudgetUsed >= effectiveMaxCatchup ||
            (decision.overflow_reason === "catchup_cost_cap" &&
              catchupBudgetUsed > 0));

        if (!suppressOverflow && shouldRecordOverflow) {
          const skippedNext = advanceAfterOverflow(job, overflowCandidate, at);
          job.state.enabled = skippedNext.enabled;
          job.state.next_run_at = skippedNext.next_run_at;
          job.state.last_status = "skipped";
          job.meta.updated_at = nowIso();
          scheduleAdvanceJobIds.add(job.id);
          consumedInfrastructureSlots.set(
            job.id,
            originalScheduledSlots.get(job.id) || overflowCandidate,
          );
          const overflowReason = decision.overflow_reason || "catchup_overflow";
          const overflowEvent = recordSkippedOccurrence({
            scope,
            job,
            scheduledAt: overflowCandidate,
            reason: overflowReason,
            activityType: "job_catchup_overflow",
            daemonInstanceId,
          }).history_event;
          dueEvents.push(overflowEvent);
        }
      }

      if (dryRun) return { dueEvents, spawnedHandles };

      const spawnedJobIds = new Set(spawnedHandles.map(({ jobId }) => jobId));
      const runtimeUpdates = [];
      for (const job of jobs) {
        if (spawnedJobIds.has(job.id) && !scheduleAdvanceJobIds.has(job.id))
          continue;
        runtimeUpdates.push({
          jobId: job.id,
          baselineUpdatedAt: baselineUpdatedAt.get(job.id) || null,
          patch: runtimePatchFor(
            job,
            consumedInfrastructureSlots.get(job.id) || null,
          ),
        });
      }
      // One catalog mutation preserves the existing per-job conflict checks
      // without rewriting a multi-megabyte catalog once per idle job. The
      // former O(job count) synchronous write loop could starve the execution
      // lease renewal timer until the watchdog reaped a managed handoff.
      const persistedRuntime = await persistRuntimePatches(
        scope,
        runtimeUpdates,
      );
      if (!persistedRuntime.ok) {
        const reason =
          persistedRuntime.details?.reason || "catalog_lease_unavailable";
        throw Object.assign(
          new Error(`runtime batch persistence failed: ${reason}`),
          {
            code: "runtime_batch_persistence_failed",
            details: {
              ...(persistedRuntime.details || {}),
              reason,
              job_count: runtimeUpdates.length,
              failure_atomic: true,
            },
          },
        );
      }
      if (!drainCompletions || spawnedHandles.length === 0) {
        markDispatchFinished(scope, "success", null, daemonInstanceId);
      }
      // Only emit dispatch_finished when jobs were actually dispatched or
      // skipped/deferred — idle ticks produce no events worth recording.
      if (
        (!drainCompletions || spawnedHandles.length === 0) &&
        dueEvents.length > 0
      ) {
        appendActivityEvent({
          type: "dispatch_finished",
          level: "info",
          daemon_instance_id: daemonInstanceId,
          scope_id: scope.scope_id,
          cwd: scope.cwd,
          status: "success",
          error: null,
          data: {
            dispatched: dueEvents.filter((event) => event.kind === "completed")
              .length,
            started: dueEvents.filter((event) => event.kind === "started")
              .length,
            detached: spawnedHandles.length > 0 && !drainCompletions,
          },
        });
      }
      return { dueEvents, spawnedHandles };
    } catch (err) {
      markDispatchFinished(
        scope,
        "failure",
        String(err?.message || err),
        daemonInstanceId,
      );
      appendActivityEvent({
        type: "dispatch_failed",
        level: "error",
        daemon_instance_id: daemonInstanceId,
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        status: "failure",
        error: String(err?.message || err),
        data: err?.details || null,
      });
      throw err;
    }
  });

  if (!launched.ok) return launched;
  const { dueEvents, spawnedHandles } = launched.value;
  if (dryRun || !drainCompletions || spawnedHandles.length === 0) {
    return { ok: true, value: dueEvents };
  }

  // Drain after releasing execution.lock. A slow or wedged child can keep this
  // dispatch command alive for CLI compatibility, but it no longer refreshes
  // the per-scope dispatch lane lease or blocks later due jobs.
  const completedEvents = await Promise.all(
    spawnedHandles.map(async ({ jobId, scheduledAt, handle }) => {
      try {
        return await handle.completion;
      } catch (err) {
        return {
          id: `run_${jobId}_dispatch_error`,
          ts: nowIso(),
          scope_id: scope.scope_id,
          cwd: scope.cwd,
          job_id: jobId,
          run_id: handle?.runId || null,
          kind: "completed",
          status: "failure",
          reason: "dispatch_error",
          scheduled_at: scheduledAt,
          started_at: handle?.startedAt || null,
          finished_at: nowIso(),
          duration_ms: null,
          error: String(err?.message || err),
          log_paths: handle?.logPaths || null,
          payload: { error: String(err?.message || err) },
        };
      }
    }),
  );
  dueEvents.push(...completedEvents);

  const hasFailures = dueEvents.some(
    (event) => event.kind === "completed" && event.status !== "success",
  );
  markDispatchFinished(
    scope,
    hasFailures ? "failure" : "success",
    hasFailures ? "one_or_more_jobs_failed" : null,
    daemonInstanceId,
  );
  if (dueEvents.length > 0) {
    appendActivityEvent({
      type: hasFailures ? "dispatch_failed" : "dispatch_finished",
      level: hasFailures ? "error" : "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      status: hasFailures ? "failure" : "success",
      error: hasFailures ? "one_or_more_jobs_failed" : null,
      data: {
        dispatched: dueEvents.filter((event) => event.kind === "completed")
          .length,
        started: dueEvents.filter((event) => event.kind === "started").length,
      },
    });
  }
  return { ok: true, value: dueEvents };
}

export async function cancelJob(scope, id, opts = {}) {
  const activeRuns = loadActiveRunsReadOnly(scope);
  const entry = (activeRuns.runs || {})[id];
  if (!entry) {
    throw Object.assign(new Error(`no active run for job '${id}'`), {
      code: "no_active_run",
      exitCode: 1,
    });
  }
  const kill = opts.kill || process.kill.bind(process);
  const pidAlive = opts.pidAlive || isProcessAlive;
  const timeoutMs = Number(opts.timeoutMs ?? 5000);
  const pollMs = Number(opts.pollMs ?? 200);
  const pid = entry.pid;
  let killed = false;
  try {
    try {
      kill(-pid, "SIGTERM");
    } catch {
      kill(pid, "SIGTERM");
    }
    killed = true;
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
  if (killed) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (pidAlive(pid)) {
      try {
        try {
          kill(-pid, "SIGKILL");
        } catch {
          kill(pid, "SIGKILL");
        }
      } catch {
        /* already gone */
      }
    }
  }
  clearActiveRun(scope, id);
  appendActivityEvent({
    type: "job_run_cancelled",
    kind: "run",
    level: "info",
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: id,
    run_id: entry.run_id,
    pid,
    status: "cancelled",
    data: { cancelled_at: nowIso(), log_paths: entry.log_paths || null },
  });
  appendJobHistoryEvent(scope, id, historyCancelledEvent(scope, id, entry));
  return { job_id: id, run_id: entry.run_id, pid, cancelled: true };
}
