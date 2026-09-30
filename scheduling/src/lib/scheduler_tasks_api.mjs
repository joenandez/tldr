import { existsSync } from "node:fs";
import { basename } from "node:path";
import { activeRunStatus } from "./process_state.mjs";
import {
  loadActiveRunsReadOnly,
  loadJobsReadOnly,
  resolveScope,
} from "./store.mjs";
import { listRegisteredScopes } from "./scopes.mjs";
import { deleteJob, setJobPaused } from "./job_service.mjs";

function nowMs() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).getTime()
    : Date.now();
}

function parseTimeMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isRepeating(job) {
  return (
    job?.schedule?.type === "recurring" || job?.schedule?.type === "interval"
  );
}

function isFutureOnce(job, atMs) {
  if (job?.schedule?.type !== "once") return false;
  const nextMs = parseTimeMs(job?.state?.next_run_at);
  return nextMs !== null && nextMs >= atMs;
}

function scheduledLabel(job) {
  const schedule = job?.schedule || {};
  if (schedule.type === "recurring") return schedule.cron || "recurring";
  if (schedule.type === "interval") return schedule.every || "interval";
  if (schedule.type === "once") return schedule.start_at || "once";
  return schedule.type || "unknown";
}

function runnerLabel(job) {
  const provider = job?.execution_hints?.provider || null;
  if (provider) return provider;
  const command = job?.process?.command || null;
  if (command) return basename(command);
  if (job?.prompt) return "agent";
  return "unknown";
}

function lifecycleStatus(job, activeRun, atMs) {
  if (activeRun) return "running";
  if (job?.state?.enabled !== true) return "paused";
  const nextMs = parseTimeMs(job?.state?.next_run_at);
  if (nextMs !== null && nextMs <= atMs) return "due";
  if (
    job?.state?.last_status === "failure" ||
    job?.state?.last_status === "timeout"
  )
    return "failure";
  if (job?.state?.last_status === "success") return "success";
  if (job?.state?.last_status === "skipped") return "skipped";
  return "idle";
}

function currentState(job, activeRun, atMs) {
  if (activeRun) return "running";
  if (job?.state?.enabled !== true) return "paused";
  if (job?.state?.deferred_reason || job?.state?.infrastructure_deferred_reason)
    return "deferred";
  const nextMs = parseTimeMs(job?.state?.next_run_at);
  if (nextMs !== null && nextMs <= atMs) return "due";
  return "waiting";
}

function lastResult(job) {
  const status = job?.state?.last_status || "none";
  if (status === "failure" || status === "timeout") return "failure";
  if (status === "success" || status === "skipped") return status;
  return "none";
}

function titleForJob(job) {
  return job?.metadata?.title || job?.name || job?.id || "untitled";
}

function projectTask({ entry, scope, job, activeRun, atMs }) {
  return {
    scope_id: entry.scope_id,
    cwd: entry.cwd,
    storage_root: scope.storage_root,
    job_id: job.id,
    id: job.id,
    name: job.name || job.id,
    title: titleForJob(job),
    enabled: job?.state?.enabled === true,
    lifecycle_status: lifecycleStatus(job, activeRun, atMs),
    current_state: currentState(job, activeRun, atMs),
    active_run: activeRun,
    runner: runnerLabel(job),
    schedule: {
      type: job?.schedule?.type || null,
      timezone: job?.schedule?.timezone || null,
      cron: job?.schedule?.cron || null,
      every: job?.schedule?.every || null,
      start_at: job?.schedule?.start_at || null,
      end_at: job?.schedule?.end_at || null,
      label: scheduledLabel(job),
    },
    next_run_at: job?.state?.next_run_at || null,
    last_run_at: job?.state?.last_run_at || null,
    last_status: job?.state?.last_status || "none",
    last_result: lastResult(job),
    last_error: job?.state?.last_error || null,
    deferred_since:
      job?.state?.deferred_since ||
      job?.state?.infrastructure_deferred_slot ||
      null,
    deferred_reason:
      job?.state?.deferred_reason ||
      job?.state?.infrastructure_deferred_reason ||
      null,
    tags: Array.isArray(job?.tags) ? job.tags : [],
    metadata: {
      title: job?.metadata?.title || null,
      kind: job?.metadata?.kind || null,
      role: job?.metadata?.role || null,
      purpose: job?.metadata?.purpose || null,
    },
    execution_hints: {
      provider: job?.execution_hints?.provider || null,
      managed: job?.execution_hints?.managed ?? null,
      unmanaged: job?.execution_hints?.unmanaged === true,
      session_required: job?.execution_hints?.session_required ?? null,
    },
  };
}

function matchesView(task, job, view, atMs) {
  if (view === "all") return true;
  if (view === "paused")
    return !task.enabled && (isRepeating(job) || isFutureOnce(job, atMs));
  if (view === "scheduled")
    return task.enabled || isRepeating(job) || isFutureOnce(job, atMs);
  return task.enabled;
}

function matchesQuery(task, query) {
  if (!query) return true;
  const haystack = [
    task.title,
    task.job_id,
    task.cwd,
    task.runner,
    task.schedule.label,
    task.current_state,
    task.last_result,
    ...task.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function summarizeWorkspace(entry, tasks, error = null) {
  return {
    scope_id: entry.scope_id,
    cwd: entry.cwd,
    storage_root: entry.storage_root || null,
    error,
    tasks_total: tasks.length,
    tasks_enabled: tasks.filter((task) => task.enabled).length,
    tasks_paused: tasks.filter((task) => !task.enabled).length,
  };
}

export function listSchedulerTasks(query = {}) {
  const atMs = nowMs();
  const view = ["enabled", "scheduled", "paused", "all"].includes(query.view)
    ? query.view
    : "enabled";
  const requestedScopeId = query.scope_id || null;
  const scheduleType = query.schedule_type || null;
  const status = query.status || null;
  const search = query.q ? String(query.q).trim().toLowerCase() : "";
  const limit = Number.isFinite(query.limit)
    ? Math.max(1, Math.min(Math.floor(query.limit), 1000))
    : 500;

  const tasks = [];
  const workspaces = [];
  const errors = [];
  const entries = listRegisteredScopes().filter(
    (entry) => !requestedScopeId || entry.scope_id === requestedScopeId,
  );

  for (const entry of entries) {
    if (!existsSync(entry.cwd)) {
      workspaces.push(summarizeWorkspace(entry, [], "cwd_missing"));
      continue;
    }
    let scope;
    let jobs;
    let activeRuns;
    try {
      scope = resolveScope({ cwd: entry.cwd });
      jobs = loadJobsReadOnly(scope);
      activeRuns = loadActiveRunsReadOnly(scope).runs || {};
    } catch (err) {
      const message = err?.message || String(err);
      errors.push({ scope_id: entry.scope_id, cwd: entry.cwd, error: message });
      workspaces.push(summarizeWorkspace(entry, [], message));
      continue;
    }

    const workspaceTasks = [];
    for (const job of jobs) {
      const activeRun = activeRunStatus(activeRuns[job.id] || null);
      const task = projectTask({ entry, scope, job, activeRun, atMs });
      if (!matchesView(task, job, view, atMs)) continue;
      if (scheduleType && task.schedule.type !== scheduleType) continue;
      if (status && task.current_state !== status) continue;
      if (!matchesQuery(task, search)) continue;
      workspaceTasks.push(task);
    }
    workspaces.push(summarizeWorkspace(entry, workspaceTasks));
    tasks.push(...workspaceTasks);
  }

  tasks.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const aNext = parseTimeMs(a.next_run_at) ?? Number.MAX_SAFE_INTEGER;
    const bNext = parseTimeMs(b.next_run_at) ?? Number.MAX_SAFE_INTEGER;
    if (aNext !== bNext) return aNext - bNext;
    return `${a.cwd}:${a.job_id}`.localeCompare(`${b.cwd}:${b.job_id}`);
  });

  const limitedTasks = tasks.slice(0, limit);
  return {
    view,
    count: limitedTasks.length,
    total_matching: tasks.length,
    truncated: tasks.length > limitedTasks.length,
    generated_at: new Date(atMs).toISOString(),
    workspaces,
    tasks: limitedTasks,
    errors,
  };
}

function resolveSchedulerTaskScope(scopeId) {
  const entry =
    listRegisteredScopes().find(
      (candidate) => candidate.scope_id === scopeId,
    ) || null;
  if (!entry) {
    throw Object.assign(new Error(`scope '${scopeId}' not found`), {
      code: "scope_not_found",
      statusCode: 404,
    });
  }
  if (!existsSync(entry.cwd)) {
    throw Object.assign(new Error(`scope '${scopeId}' cwd is missing`), {
      code: "scope_cwd_missing",
      statusCode: 410,
    });
  }
  return resolveScope({ cwd: entry.cwd });
}

export async function setSchedulerTaskEnabled({ scopeId, jobId, enabled }) {
  const scope = resolveSchedulerTaskScope(scopeId);
  const result = await setJobPaused(scope, jobId, enabled, { source: "http" });
  if (!result?.ok) {
    throw Object.assign(new Error("job update failed"), {
      code: "scope_busy",
      statusCode: 409,
      details: result?.details || null,
    });
  }
  const task =
    listSchedulerTasks({ scope_id: scopeId, view: "all" }).tasks.find(
      (candidate) => candidate.job_id === jobId,
    ) || null;
  return {
    scope_id: scopeId,
    cwd: scope.cwd,
    job_id: jobId,
    enabled,
    task,
  };
}

export async function deleteSchedulerTask({ scopeId, jobId }) {
  const scope = resolveSchedulerTaskScope(scopeId);
  const result = await deleteJob(scope, jobId, { source: "http" });
  if (!result?.ok) {
    throw Object.assign(new Error("job deletion failed"), {
      code: "scope_busy",
      statusCode: 409,
      details: result?.details || null,
    });
  }
  if (result.value?.deleted !== 1) {
    throw Object.assign(new Error(`job '${jobId}' not found`), {
      code: "not_found",
      statusCode: 404,
    });
  }
  return {
    scope_id: scopeId,
    cwd: scope.cwd,
    job_id: jobId,
    deleted: result.value.deleted,
  };
}
