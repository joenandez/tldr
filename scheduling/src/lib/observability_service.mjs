import { listRegisteredScopes } from "./scopes.mjs";
import { serviceStatus } from "./service.mjs";
import { activeRunStatus } from "./process_state.mjs";
import { heartbeatStatus } from "./heartbeat.mjs";
import { runtimeHealth } from "./runtime.mjs";
import {
  loadActiveRunsReadOnly,
  loadJobsReadOnly,
  loadRuntime,
  helmHome,
  resolveScope,
  runLogPaths,
} from "./store.mjs";
import { loadJobHistory, loadPublicEvents } from "./read_store.mjs";
import {
  HISTORY_RING_SIZE,
  HISTORY_RING_MAX_JOBS,
  historyFromRing,
  pushToHistoryRing,
} from "./history_ring.mjs";
import { terminalHistoryEvent } from "./public_contract.mjs";
import { mergeLedgerTerminalHistory } from "./skyhook_history_merge.mjs";

export {
  HISTORY_RING_SIZE,
  HISTORY_RING_MAX_JOBS,
  historyFromRing,
  pushToHistoryRing,
};
function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function latestTerminalEvent(events = []) {
  return terminalHistoryEvent(events);
}

export function decorateJob(
  job,
  events = [],
  atIso = nowIso(),
  activeRunEntry = null,
) {
  const recent = [...events].sort((a, b) =>
    String(a.ts || "").localeCompare(String(b.ts || "")),
  );
  const running = activeRunStatus(activeRunEntry);
  const failureCount = (() => {
    let count = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const evt = recent[i];
      if (
        evt.kind !== "completed" &&
        evt.kind !== "skipped" &&
        evt.kind !== "cancelled"
      )
        continue;
      if (evt.status === "failure" || evt.status === "timeout") {
        count += 1;
        continue;
      }
      break;
    }
    return count;
  })();
  const lastRun = latestTerminalEvent(recent);
  const lastError = lastRun?.error || null;
  const lastRetryCount = (() => {
    if (!lastRun?.run_id) return 0;
    return recent.filter(
      (evt) => evt.kind === "retry" && evt.run_id === lastRun.run_id,
    ).length;
  })();
  const lifecycleStatus = (() => {
    if (running) return "running";
    if (!job.state.enabled) {
      if (
        job.state.last_status === "failure" ||
        job.state.last_status === "timeout"
      )
        return "failure";
      if (job.state.last_status === "skipped") return "skipped";
      if (job.state.last_status === "success") return "success";
    }
    if (
      job.state.next_run_at &&
      new Date(job.state.next_run_at) <= new Date(atIso)
    )
      return "due";
    if (
      job.state.last_status === "failure" ||
      job.state.last_status === "timeout"
    )
      return "failure";
    if (job.state.last_status === "success") return "success";
    return "idle";
  })();
  return {
    ...job,
    process: job.process
      ? {
          command: job.process.command,
          args: Array.isArray(job.process.args) ? job.process.args : [],
          stdin: job.process.stdin ?? null,
          stdin_file: job.process.stdin_file ?? null,
          cwd: job.process.cwd ?? null,
          env: isPlainObject(job.process.env) ? job.process.env : {},
        }
      : null,
    execution: {
      model: job.execution?.model ?? null,
      max_turns: job.execution?.max_turns ?? 50,
      timeout_sec: job.execution?.timeout_sec ?? null,
    },
    limits: {
      timeout_sec:
        job.limits?.timeout_sec ?? job.execution?.timeout_sec ?? null,
    },
    execution_hints: {
      model: job.execution_hints?.model ?? job.execution?.model ?? null,
      max_turns:
        job.execution_hints?.max_turns ?? job.execution?.max_turns ?? 50,
      output_format: job.execution_hints?.output_format ?? null,
      non_interactive: job.execution_hints?.non_interactive ?? true,
      provider: job.execution_hints?.provider ?? null,
      provider_config: isPlainObject(job.execution_hints?.provider_config)
        ? job.execution_hints.provider_config
        : undefined,
      managed: job.execution_hints?.managed ?? null,
      unmanaged: job.execution_hints?.unmanaged === true,
      session_required: job.execution_hints?.session_required ?? null,
    },
    metadata: isPlainObject(job.metadata) ? job.metadata : {},
    memory: isPlainObject(job.memory) ? job.memory : { mode: "read+write" },
    tags: job.tags || [],
    retry: job.retry || { max_attempts: 0, backoff: "none", delay_sec: 0 },
    lifecycle_status: lifecycleStatus,
    active_run: running,
    next_run_at: job.state.next_run_at,
    last_error: lastError,
    consecutive_failures: failureCount,
    last_retry_count: lastRetryCount,
    last_run: lastRun
      ? {
          run_id: lastRun.run_id || null,
          status: lastRun.status || null,
          finished_at: lastRun.finished_at || lastRun.ts || null,
          error: lastRun.error || null,
          log_paths: lastRun.log_paths || null,
          memory: lastRun.payload?.memory || null,
        }
      : null,
  };
}

export function historyForJob(scope, jobId, limit = 20) {
  let events;
  if (limit <= HISTORY_RING_SIZE) {
    const hit = historyFromRing(scope?.scope_id || null, jobId, limit);
    if (hit && hit.length >= limit) events = hit;
  }
  if (!events) events = loadJobHistory(scope, jobId, limit);
  return mergeLedgerTerminalHistory(scope, jobId, events, limit);
}

export function workspaceRunEvents(scope, limit = 5000) {
  const jobs = loadJobsReadOnly(scope);
  const projected = [];
  for (const job of jobs) {
    projected.push(...historyForJob(scope, job.id, limit));
  }
  return projected
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")))
    .slice(-limit);
}

export function activeRunsIndex(scope) {
  return loadActiveRunsReadOnly(scope).runs || {};
}

export function baseStatusData({
  scope,
  jobs,
  runEvents,
  schedulerScriptPath,
}) {
  const hb = heartbeatStatus(scope);
  const service = serviceStatus(schedulerScriptPath);
  const enabledJobs = jobs.filter((j) => j.state.enabled);
  const nextDue =
    enabledJobs
      .filter((j) => j.state.next_run_at)
      .sort((a, b) =>
        a.state.next_run_at.localeCompare(b.state.next_run_at),
      )[0] || null;
  const lastCompleted =
    runEvents.filter((e) => e.kind === "completed").slice(-1)[0] || null;
  return {
    heartbeat: hb,
    service,
    jobs_total: jobs.length,
    jobs_enabled: enabledJobs.length,
    next_due_job: nextDue
      ? { id: nextDue.id, next_run_at: nextDue.state.next_run_at }
      : null,
    last_completed_run: lastCompleted,
  };
}

export function workspaceStatusData({
  scope,
  jobs,
  runEvents,
  runtime,
  registryEntry,
  schedulerScriptPath,
  includeHeartbeat = true,
}) {
  const service = serviceStatus(schedulerScriptPath);
  const health = runtimeHealth(
    runtime,
    service,
    registryEntry?.registered_at || null,
  );
  const base = baseStatusData({ scope, jobs, runEvents, schedulerScriptPath });
  if (!includeHeartbeat) delete base.heartbeat;
  return {
    ...base,
    runtime,
    health,
  };
}

export function listJobs(scope, atIso = nowIso()) {
  const jobs = loadJobsReadOnly(scope);
  const activeRuns = activeRunsIndex(scope);
  return jobs.map((job) =>
    decorateJob(
      job,
      historyForJob(scope, job.id, 100),
      atIso,
      activeRuns[job.id] || null,
    ),
  );
}

export function getJob(scope, id, atIso = nowIso()) {
  const jobs = loadJobsReadOnly(scope);
  const job = jobs.find((entry) => entry.id === id);
  if (!job) return null;
  const activeRuns = activeRunsIndex(scope);
  return decorateJob(
    job,
    historyForJob(scope, id, 100),
    atIso,
    activeRuns[job.id] || null,
  );
}

export function jobStatusPayload(scope, id, atIso = nowIso()) {
  const jobs = loadJobsReadOnly(scope);
  const job = jobs.find((entry) => entry.id === id);
  if (!job) return null;
  const events = historyForJob(scope, id, 100);
  const activeRuns = activeRunsIndex(scope);
  const decorated = decorateJob(job, events, atIso, activeRuns[job.id] || null);
  const lastRun = latestTerminalEvent(events);
  return {
    job_id: job.id,
    exists: true,
    enabled: job.state.enabled,
    lifecycle_status: decorated.lifecycle_status,
    active_run: decorated.active_run,
    last_run: lastRun
      ? {
          run_id: lastRun.run_id || null,
          status: lastRun.status || null,
          finished_at: lastRun.finished_at || lastRun.ts || null,
          error: lastRun.error || null,
          log_paths: lastRun.log_paths || null,
          memory: lastRun.payload?.memory || null,
        }
      : null,
    job: decorated,
  };
}

export function resolveRunForLogs({ scope, jobId, runId = null }) {
  const active = activeRunStatus(activeRunsIndex(scope)[jobId] || null);
  const events = historyForJob(scope, jobId, 5000);
  if (runId) {
    if (active?.run_id === runId) {
      return {
        run_id: runId,
        active: true,
        pid: active.pid,
        started_at: active.started_at,
        log_paths: active.log_paths || runLogPaths(scope, jobId, runId),
      };
    }
    const matching =
      [...events]
        .filter((event) => event.run_id === runId)
        .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")))
        .slice(-1)[0] || null;
    if (matching) {
      return {
        run_id: runId,
        active: false,
        pid: null,
        started_at: matching.started_at || matching.ts || null,
        log_paths: matching.log_paths || runLogPaths(scope, jobId, runId),
      };
    }
    return {
      run_id: runId,
      active: false,
      pid: null,
      started_at: null,
      log_paths: runLogPaths(scope, jobId, runId),
    };
  }

  if (active) {
    return {
      run_id: active.run_id,
      active: true,
      pid: active.pid,
      started_at: active.started_at,
      log_paths: active.log_paths || runLogPaths(scope, jobId, active.run_id),
    };
  }

  const last = latestTerminalEvent(events);
  if (!last?.run_id) return null;
  return {
    run_id: last.run_id,
    active: false,
    pid: null,
    started_at: last.started_at || last.ts || null,
    log_paths: last.log_paths || runLogPaths(scope, jobId, last.run_id),
  };
}

export function workspaceSummary(entry, schedulerScriptPath) {
  if (!entry) return null;
  const scope = resolveScope({ cwd: entry.cwd });
  const jobs = loadJobsReadOnly(scope);
  const runEvents = workspaceRunEvents(scope, 5000);
  const runtime = loadRuntime(scope);
  const activeRuns = activeRunsIndex(scope);
  return {
    scope_id: entry.scope_id,
    cwd: entry.cwd,
    storage_root: scope.storage_root,
    registered_at: entry.registered_at,
    updated_at: entry.updated_at,
    exists: true,
    active_runs_count: Object.keys(activeRuns).length,
    ...workspaceStatusData({
      scope,
      jobs,
      runEvents,
      runtime,
      registryEntry: entry,
      schedulerScriptPath,
      includeHeartbeat: false,
    }),
  };
}

export function globalServerEvents(schedulerScriptPath, query = {}) {
  const since = query.since || null;
  const scopeId = query.scope_id || null;
  const jobId = query.job_id || null;
  const limit = Number(query.limit || 100);
  const events = loadPublicEvents(limit, {
    since,
    scopeId,
    jobId,
    levels: new Set(["info", "error", "debug"]),
  });
  return {
    helm_home: helmHome(),
    service: serviceStatus(schedulerScriptPath),
    events,
  };
}

export function registeredWorkspaceSummaries(schedulerScriptPath) {
  return listRegisteredScopes().map((entry) =>
    workspaceSummary(entry, schedulerScriptPath),
  );
}
