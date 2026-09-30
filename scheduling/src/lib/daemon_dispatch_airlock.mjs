import { performance } from "node:perf_hooks";
import {
  loadActiveRunsReadOnly,
  loadDispatchIndexReadOnly,
  loadDispatchJobsReadOnly,
} from "./store.mjs";
import { isProcessAlive } from "./process_liveness.mjs";
import { computeDueShadowSample } from "./dispatch_due_shadow.mjs";

const DEFAULT_DAEMON_DISPATCH_CHILD_CAP = 4;
const DEFAULT_DAEMON_DISPATCH_LAUNCH_BUDGET = 4;

function finitePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function daemonNowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function dispatchAdmissionLimits() {
  return {
    cap: finitePositiveInteger(
      process.env.HELM_DAEMON_DISPATCH_CHILD_CAP,
      DEFAULT_DAEMON_DISPATCH_CHILD_CAP,
    ),
    launchBudget: finitePositiveInteger(
      process.env.HELM_DAEMON_DISPATCH_LAUNCH_BUDGET,
      DEFAULT_DAEMON_DISPATCH_LAUNCH_BUDGET,
    ),
  };
}

function parseTimeMs(value) {
  if (!value || typeof value !== "string") return NaN;
  return new Date(value).getTime();
}

export function classifyScopeDueForDispatch(
  scope,
  {
    atIso = daemonNowIso(),
    readJobs = loadDispatchJobsReadOnly,
    readActiveRuns = loadActiveRunsReadOnly,
    pidAlive = isProcessAlive,
  } = {},
) {
  let jobs;
  let dispatchIndexStatus = null;
  let dispatchIndexReason = null;
  try {
    const loaded = readJobs(scope);
    if (Array.isArray(loaded)) {
      jobs = loaded;
    } else {
      jobs = loaded?.jobs;
      dispatchIndexStatus = loaded?.dispatchIndexStatus || null;
      dispatchIndexReason = loaded?.dispatchIndexReason || null;
    }
  } catch {
    return {
      scope,
      dispatchNeeded: true,
      reason: "unreadable_jobs",
      dueJobCount: 0,
      enabledJobCount: 0,
      earliestNextRunAt: null,
      dispatchIndexStatus: "fallback_failed",
      dispatchIndexReason: "unreadable_jobs",
    };
  }

  const enabledJobs = Array.isArray(jobs)
    ? jobs.filter((job) => job?.state?.enabled !== false)
    : [];
  if (enabledJobs.length === 0) {
    return withDispatchIndexStatus(
      idleClassification(scope, "no_enabled_jobs"),
      { dispatchIndexStatus, dispatchIndexReason },
    );
  }

  const atMs = parseTimeMs(atIso);
  const dueJobs = [];
  let earliestNextRunAt = null;
  let earliestNextRunMs = Infinity;

  for (const job of enabledJobs) {
    const nextRunAt = job?.state?.next_run_at || null;
    if (!nextRunAt) {
      return withDispatchIndexStatus(
        dispatchClassification(scope, "missing_next_run_at", {
          dueJobCount: dueJobs.length,
          enabledJobCount: enabledJobs.length,
          earliestNextRunAt,
        }),
        { dispatchIndexStatus, dispatchIndexReason },
      );
    }
    const nextRunMs = parseTimeMs(nextRunAt);
    if (!Number.isFinite(nextRunMs) || !Number.isFinite(atMs)) {
      return withDispatchIndexStatus(
        dispatchClassification(scope, "invalid_next_run_at", {
          dueJobCount: dueJobs.length,
          enabledJobCount: enabledJobs.length,
          earliestNextRunAt,
        }),
        { dispatchIndexStatus, dispatchIndexReason },
      );
    }
    if (nextRunMs <= atMs) dueJobs.push(job);
    if (nextRunMs < earliestNextRunMs) {
      earliestNextRunMs = nextRunMs;
      earliestNextRunAt = nextRunAt;
    }
  }

  if (dueJobs.length > 0) {
    const activeRunSuppression = classifyActiveRunSuppression({
      scope,
      dueJobs,
      readActiveRuns,
      pidAlive,
    });
    if (activeRunSuppression.suppressed) {
      return withDispatchIndexStatus(
        {
          ...idleClassification(scope, "active_run_in_flight"),
          dueJobCount: dueJobs.length,
          enabledJobCount: enabledJobs.length,
          earliestNextRunAt,
          activeRunInFlightJobCount: activeRunSuppression.jobCount,
        },
        { dispatchIndexStatus, dispatchIndexReason },
      );
    }

    return withDispatchIndexStatus(
      dispatchClassification(scope, "due", {
        dueJobCount: dueJobs.length,
        enabledJobCount: enabledJobs.length,
        earliestNextRunAt,
      }),
      { dispatchIndexStatus, dispatchIndexReason },
    );
  }

  const activeRunReap = classifyActiveRunReapNeed({
    scope,
    readActiveRuns,
    pidAlive,
  });
  if (activeRunReap.dispatchNeeded) {
    return withDispatchIndexStatus(
      dispatchClassification(scope, "active_run_reap_needed", {
        enabledJobCount: enabledJobs.length,
        earliestNextRunAt,
      }),
      { dispatchIndexStatus, dispatchIndexReason },
    );
  }

  return withDispatchIndexStatus(
    {
      ...idleClassification(scope, "idle"),
      enabledJobCount: enabledJobs.length,
      earliestNextRunAt,
    },
    { dispatchIndexStatus, dispatchIndexReason },
  );
}

function activeRunsObject(scope, readActiveRuns) {
  try {
    const runs = readActiveRuns(scope)?.runs;
    if (!runs || typeof runs !== "object" || Array.isArray(runs)) return null;
    return runs;
  } catch {
    return null;
  }
}

function activeRunPidAlive(pidAlive, pid, details) {
  try {
    return pidAlive(pid, details) === true;
  } catch {
    return false;
  }
}

function classifyActiveRunReapNeed({ scope, readActiveRuns, pidAlive }) {
  const activeRuns = activeRunsObject(scope, readActiveRuns);
  if (!activeRuns) return { dispatchNeeded: false };

  for (const entry of Object.values(activeRuns)) {
    const pid = Number(entry?.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!activeRunPidAlive(pidAlive, pid, { scope, activeRun: entry })) {
      return { dispatchNeeded: true };
    }
  }
  return { dispatchNeeded: false };
}

function classifyActiveRunSuppression({
  scope,
  dueJobs,
  readActiveRuns,
  pidAlive,
}) {
  if (!Array.isArray(dueJobs) || dueJobs.length === 0) {
    return { suppressed: false, jobCount: 0 };
  }

  const activeRuns = activeRunsObject(scope, readActiveRuns);
  if (!activeRuns) return { suppressed: false, jobCount: 0 };

  let liveDueJobCount = 0;
  for (const job of dueJobs) {
    const jobId = typeof job?.id === "string" ? job.id : null;
    if (!jobId) return { suppressed: false, jobCount: 0 };
    const entry = activeRuns[jobId];
    const pid = Number(entry?.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { suppressed: false, jobCount: 0 };
    }

    if (!activeRunPidAlive(pidAlive, pid, { scope, job, activeRun: entry })) {
      return { suppressed: false, jobCount: 0 };
    }
    liveDueJobCount += 1;
  }

  return {
    suppressed: liveDueJobCount === dueJobs.length,
    jobCount: liveDueJobCount,
  };
}

function hasDeadActiveRunNeedingDispatch({ scope, readActiveRuns, pidAlive }) {
  const activeRuns = activeRunsObject(scope, readActiveRuns);
  if (!activeRuns) return false;
  for (const entry of Object.values(activeRuns)) {
    const pid = Number(entry?.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!activeRunPidAlive(pidAlive, pid, { scope, activeRun: entry })) {
      return true;
    }
  }
  return false;
}

function withDispatchIndexStatus(result, details = {}) {
  if (!details.dispatchIndexStatus) return result;
  return {
    ...result,
    dispatchIndexStatus: details.dispatchIndexStatus,
    dispatchIndexReason: details.dispatchIndexReason,
  };
}

function dispatchClassification(scope, reason, details = {}) {
  return {
    scope,
    dispatchNeeded: true,
    reason,
    dueJobCount: details.dueJobCount || 0,
    enabledJobCount: details.enabledJobCount || 0,
    earliestNextRunAt: details.earliestNextRunAt || null,
  };
}

function idleClassification(scope, reason) {
  return {
    scope,
    dispatchNeeded: false,
    reason,
    earliestNextRunAt: null,
  };
}

export function classifyDispatchableScopesForDueWork(
  scopes,
  {
    atIso = daemonNowIso(),
    readJobs = loadDispatchJobsReadOnly,
    readActiveRuns = loadActiveRunsReadOnly,
    pidAlive = isProcessAlive,
  } = {},
) {
  const classifications = scopes.map((scope) =>
    classifyScopeDueForDispatch(scope, {
      atIso,
      readJobs,
      readActiveRuns,
      pidAlive,
    }),
  );
  const dispatchNeeded = classifications
    .filter((entry) => entry.dispatchNeeded)
    .map((entry) => entry.scope);
  const idleSkipped = classifications.filter((entry) => !entry.dispatchNeeded);
  const unknownReasons = new Set([
    "missing_next_run_at",
    "invalid_next_run_at",
    "unreadable_jobs",
  ]);

  return {
    dispatchNeeded,
    idleSkipped,
    summary: {
      dispatchable_scope_count: scopes.length,
      dispatch_needed_scope_count: dispatchNeeded.length,
      due_scope_count: classifications.filter(
        (entry) => (entry.dueJobCount || 0) > 0,
      ).length,
      due_job_count: classifications.reduce(
        (sum, entry) => sum + (entry.dueJobCount || 0),
        0,
      ),
      active_run_in_flight_scope_count: classifications.filter(
        (entry) => entry.reason === "active_run_in_flight",
      ).length,
      active_run_in_flight_job_count: classifications.reduce(
        (sum, entry) => sum + (entry.activeRunInFlightJobCount || 0),
        0,
      ),
      idle_skipped_scope_count: idleSkipped.length,
      no_enabled_job_scope_count: classifications.filter(
        (entry) => entry.reason === "no_enabled_jobs",
      ).length,
      unknown_dispatch_needed_scope_count: classifications.filter((entry) =>
        unknownReasons.has(entry.reason),
      ).length,
      unreadable_jobs_scope_count: classifications.filter(
        (entry) => entry.reason === "unreadable_jobs",
      ).length,
      dispatch_index_hit_scope_count: classifications.filter(
        (entry) => entry.dispatchIndexStatus === "hit",
      ).length,
      dispatch_index_fallback_scope_count: classifications.filter(
        (entry) => entry.dispatchIndexStatus === "fallback_full_jobs",
      ).length,
    },
  };
}

export function applyDispatchAdmission(
  scopes,
  {
    cap = DEFAULT_DAEMON_DISPATCH_CHILD_CAP,
    launchBudget = DEFAULT_DAEMON_DISPATCH_LAUNCH_BUDGET,
    nowIso = daemonNowIso(),
    registryGeneration = null,
  } = {},
) {
  const normalizedCap = finitePositiveInteger(
    cap,
    DEFAULT_DAEMON_DISPATCH_CHILD_CAP,
  );
  const normalizedBudget = finitePositiveInteger(
    launchBudget,
    DEFAULT_DAEMON_DISPATCH_LAUNCH_BUDGET,
  );
  const limit = Math.min(normalizedCap, normalizedBudget);
  const admitted = scopes.slice(0, limit);
  const deferred = scopes.slice(limit).map((scope) => ({
    scope,
    reason:
      normalizedCap <= normalizedBudget
        ? "daemon_dispatch_child_cap_saturated"
        : "daemon_dispatch_launch_budget_saturated",
    cap: normalizedCap,
    launchBudget: normalizedBudget,
    deferredAt: nowIso,
    registryGeneration,
  }));

  return {
    admitted,
    deferred,
    cap: normalizedCap,
    launchBudget: normalizedBudget,
  };
}

async function sampleEventLoopLagMs() {
  const started = performance.now();
  await new Promise((resolveLag) => setImmediate(resolveLag));
  return Math.max(0, performance.now() - started);
}

function uniqueScopeIds(rows = []) {
  return new Set(
    rows
      .map((row) => row?.scope_id)
      .filter((scopeId) => typeof scopeId === "string" && scopeId.length > 0),
  );
}

function groupRowsByScope(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    if (typeof row?.scope_id !== "string" || row.scope_id.length === 0) {
      continue;
    }
    const list = grouped.get(row.scope_id) || [];
    list.push(row);
    grouped.set(row.scope_id, list);
  }
  return grouped;
}

function normalizeDueAdmissionInput(dueScopes) {
  if (dueScopes === null || dueScopes === undefined) return null;

  if (Array.isArray(dueScopes)) {
    return {
      available: true,
      dueRows: dueScopes.map((scope) => ({
        scope_id: scope?.scope_id,
        job_id: null,
        active_run_id: null,
        next_run_at: null,
      })),
      suppressedRows: [],
    };
  }

  if (dueScopes?.available === false) {
    return {
      available: false,
      reason: dueScopes.reason || "global_due_query_unavailable",
    };
  }

  if (dueScopes?.available === true) {
    return {
      available: true,
      dueRows: Array.isArray(dueScopes.dueRows) ? dueScopes.dueRows : [],
      suppressedRows: Array.isArray(dueScopes.suppressedRows)
        ? dueScopes.suppressedRows
        : [],
    };
  }

  return {
    available: false,
    reason: "global_due_query_invalid_result",
  };
}

export async function prepareAirlockDispatch({
  plan,
  daemonInstanceId,
  appendActivityEvent,
  appendPerfEvent,
  memorySample,
  unavailableScopeIds = new Set(),
  readJobs = loadDispatchJobsReadOnly,
  readActiveRuns = loadActiveRunsReadOnly,
  pidAlive = isProcessAlive,
  dueScopes = null, // Row-level fast admission result; null=classify path.
  globalDueQueryFallbackReason = null,
  emitDueShadowSample = true,
}) {
  const startedMs = performance.now();
  const atIso = daemonNowIso();
  const eventLoopLagMs = await sampleEventLoopLagMs();

  let dueScopeList, sampleSummary, idleSkippedResults, globalDueQuery;
  const dueAdmission = normalizeDueAdmissionInput(dueScopes);
  const fallbackReason =
    globalDueQueryFallbackReason ||
    (dueAdmission?.available === false ? dueAdmission.reason : null);

  if (dueAdmission?.available === true) {
    // Global due-query path: idle scopes absent from result = 0 reads.
    // The due index has no quarantine_state/dispatch_state columns, so a
    // quarantined or disabled scope can still carry a due row. Intersect with
    // the registry-approved dispatchable set so the flag-on path honors the
    // same quarantine/disable/cwd-missing gate the classify path gets via
    // plan.dispatchable. O(due scopes); idle scopes remain absent (0 reads).
    const dueRows = dueAdmission.dueRows;
    const suppressedRows = dueAdmission.suppressedRows;
    const dispatchableById = new Map(
      plan.dispatchable.map((scope) => [scope.scope_id, scope]),
    );
    const directDueScopeIds = uniqueScopeIds(dueRows);
    const allDueScopeIds = uniqueScopeIds([...dueRows, ...suppressedRows]);
    const dispatchCandidateIds = new Set();
    for (const scopeId of directDueScopeIds) {
      if (dispatchableById.has(scopeId)) dispatchCandidateIds.add(scopeId);
    }

    const suppressedRowsByScope = groupRowsByScope(suppressedRows);
    const activeRunInFlightScopeIds = new Set();
    let activeRunInFlightJobCount = 0;
    idleSkippedResults = [];
    for (const scope of plan.dispatchable) {
      const rows = suppressedRowsByScope.get(scope.scope_id);
      if (!rows || dispatchCandidateIds.has(scope.scope_id)) continue;

      const classification = classifyScopeDueForDispatch(scope, {
        atIso,
        readJobs,
        readActiveRuns,
        pidAlive,
      });
      if (classification.dispatchNeeded) {
        dispatchCandidateIds.add(scope.scope_id);
        continue;
      }

      idleSkippedResults.push({
        scope: classification.scope,
        ok: true,
        skipped: true,
        reason: classification.reason,
      });
      if (classification.reason === "active_run_in_flight") {
        activeRunInFlightScopeIds.add(scope.scope_id);
        activeRunInFlightJobCount +=
          classification.activeRunInFlightJobCount || rows.length;
      }
    }
    for (const scope of plan.dispatchable) {
      if (dispatchCandidateIds.has(scope.scope_id)) continue;
      if (allDueScopeIds.has(scope.scope_id)) continue;
      if (
        hasDeadActiveRunNeedingDispatch({ scope, readActiveRuns, pidAlive })
      ) {
        dispatchCandidateIds.add(scope.scope_id);
        continue;
      }
      const dispatchIndex = loadDispatchIndexReadOnly(scope);
      if (!dispatchIndex.ok) {
        const classification = classifyScopeDueForDispatch(scope, {
          atIso,
          readJobs,
          readActiveRuns,
          pidAlive,
        });
        if (classification.dispatchNeeded) {
          dispatchCandidateIds.add(scope.scope_id);
          continue;
        }
        idleSkippedResults.push({
          scope: classification.scope,
          ok: true,
          skipped: true,
          reason: classification.reason,
        });
        if (classification.reason === "active_run_in_flight") {
          activeRunInFlightScopeIds.add(scope.scope_id);
          activeRunInFlightJobCount +=
            classification.activeRunInFlightJobCount || 0;
        }
        continue;
      }
      idleSkippedResults.push({
        scope,
        ok: true,
        skipped: true,
        reason: "idle",
      });
    }

    dueScopeList = plan.dispatchable.filter((scope) =>
      dispatchCandidateIds.has(scope.scope_id),
    );
    globalDueQuery = true;
    sampleSummary = {
      dispatchable_scope_count: plan.dispatchable.length,
      dispatch_needed_scope_count: dueScopeList.length,
      due_scope_count: allDueScopeIds.size,
      due_job_count: dueRows.length + suppressedRows.length,
      active_run_in_flight_scope_count: activeRunInFlightScopeIds.size,
      active_run_in_flight_job_count: activeRunInFlightJobCount,
      idle_skipped_scope_count: Math.max(
        0,
        plan.dispatchable.length - dueScopeList.length,
      ),
      no_enabled_job_scope_count: 0,
      unknown_dispatch_needed_scope_count: 0,
      unreadable_jobs_scope_count: 0,
      dispatch_index_hit_scope_count: allDueScopeIds.size,
      dispatch_index_fallback_scope_count: 0,
      idle_scope_read_count: 0,
    };
  } else {
    // Classify path (flag off — byte-identical to existing behaviour).
    const duePlan = classifyDispatchableScopesForDueWork(plan.dispatchable, {
      atIso,
      readJobs,
      readActiveRuns,
      pidAlive,
    });
    if (emitDueShadowSample) {
      computeDueShadowSample({
        atIso,
        airlockDueSet: duePlan.dispatchNeeded.map((s) => ({
          scope_id: s.scope_id,
        })),
        daemonInstanceId,
        sink: appendPerfEvent,
      });
    }
    dueScopeList = duePlan.dispatchNeeded;
    sampleSummary = duePlan.summary;
    globalDueQuery = false;
    idleSkippedResults = duePlan.idleSkipped.map((e) => ({
      scope: e.scope,
      ok: true,
      skipped: true,
      reason: e.reason,
    }));
  }

  const limits = dispatchAdmissionLimits();
  const launchCandidates = dueScopeList.filter(
    (scope) => !unavailableScopeIds.has(scope.scope_id),
  );
  const admission = applyDispatchAdmission(launchCandidates, {
    ...limits,
    nowIso: atIso,
    registryGeneration: plan.generation,
  });

  for (const deferred of admission.deferred) {
    emitAdmissionDeferred({
      deferred,
      daemonInstanceId,
      appendActivityEvent,
      appendPerfEvent,
    });
  }

  const sampleBase = {
    event: "daemon_dispatch_scope_prefilter_sample",
    type: "daemon_dispatch_scope_prefilter_sample",
    classification: "helm_control_plane",
    daemon_instance_id: daemonInstanceId,
    registry_generation: plan.generation,
    authoritative_registry: plan.authoritative,
    at: atIso,
    ...sampleSummary,
    single_flight_blocked_scope_count:
      dueScopeList.length - launchCandidates.length,
    launch_admitted_scope_count: admission.admitted.length,
    deferred_scope_count: admission.deferred.length,
    dispatch_child_cap: admission.cap,
    dispatch_launch_budget: admission.launchBudget,
    dispatch_launch_rate_budget: admission.launchBudget,
    event_loop_lag_ms: eventLoopLagMs,
    ...(globalDueQuery ? { global_due_query: true } : {}),
    ...(fallbackReason
      ? { global_due_query_fallback_reason: fallbackReason }
      : {}),
  };

  return {
    dispatchScopes: admission.admitted,
    recordPrefilterSample: ({ launchedScopeCount }) =>
      appendPerfEvent({
        ...sampleBase,
        launched_scope_count: launchedScopeCount,
        duration_ms: Math.max(0, performance.now() - startedMs),
        memory: memorySample(),
      }),
    idleSkippedResults,
    deferredResults: admission.deferred.map((entry) => ({
      scope: entry.scope,
      ok: true,
      skipped: true,
      reason: entry.reason,
      deferred: true,
    })),
  };
}

function emitAdmissionDeferred({
  deferred,
  daemonInstanceId,
  appendActivityEvent,
  appendPerfEvent,
}) {
  const payload = {
    scope_id: deferred.scope.scope_id,
    cwd: deferred.scope.cwd,
    reason: deferred.reason,
    cap: deferred.cap,
    launch_budget: deferred.launchBudget,
    launch_rate_budget: deferred.launchBudget,
    deferred_at: deferred.deferredAt,
    registry_generation: deferred.registryGeneration,
  };
  appendActivityEvent({
    event_type: "scope_dispatch_admission_deferred",
    daemon_instance_id: daemonInstanceId,
    scope_id: payload.scope_id,
    cwd: payload.cwd,
    reason: payload.reason,
    metadata: payload,
  });
  appendPerfEvent({
    event: "scope_dispatch_admission_deferred",
    type: "scope_dispatch_admission_deferred",
    classification: "helm_control_plane",
    daemon_instance_id: daemonInstanceId,
    ...payload,
  });
}
