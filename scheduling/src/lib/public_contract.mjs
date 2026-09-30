function clonePayload(value) {
  if (value === null || value === undefined) return {};
  return JSON.parse(JSON.stringify(value));
}

function categoryFromType(type, fallback = null) {
  if (!type) return fallback;
  if (type.startsWith("job_run_")) return "run";
  if (type === "job_catchup_overflow") return "run";
  if (type.startsWith("job_")) return "job";
  if (type.startsWith("dispatch_")) return "dispatch";
  if (type.startsWith("notification_")) return "notification";
  if (type.startsWith("runtime_health_")) return "health";
  if (type.startsWith("scope_")) return "workspace";
  if (type === "workspace_down") return "workspace";
  if (type.startsWith("service_")) return "service";
  if (type.startsWith("daemon_")) return "daemon";
  if (type === "prune_completed") return "maintenance";
  return fallback || "event";
}

function actionFromType(type) {
  switch (type) {
    case "job_run_started":
      return "started";
    case "job_run_launching":
      return "launching";
    case "job_run_identity_registered":
      return "identity_registered";
    case "job_run_terminal":
      return "terminal";
    case "job_run_completed_success":
    case "job_run_completed_failure":
    case "job_run_completed_timeout":
      return "completed";
    case "job_run_skipped":
    case "job_catchup_overflow":
      return "skipped";
    case "job_run_retry":
      return "retry";
    case "job_run_cancelled":
      return "cancelled";
    case "job_created":
      return "created";
    case "job_updated":
      return "updated";
    case "job_deleted":
      return "deleted";
    case "job_paused":
      return "paused";
    case "job_resumed":
      return "resumed";
    case "job_cloned":
      return "cloned";
    case "job_auto_paused":
      return "auto_paused";
    case "job_next_run_scheduled":
      return "scheduled";
    case "job_due_detected":
      return "due";
    case "dispatch_started":
      return "started";
    case "dispatch_finished":
    case "dispatch_failed":
      return "finished";
    case "notification_stdout_succeeded":
    case "notification_webhook_succeeded":
    case "notification_file_appended":
      return "delivered";
    case "notification_stdout_failed":
    case "notification_webhook_failed":
    case "notification_file_failed":
      return "failed";
    case "notification_no_channels":
      return "suppressed";
    case "runtime_health_ok":
      return "healthy";
    case "runtime_health_dispatch_stale":
    case "runtime_health_service_not_running":
      return "unhealthy";
    case "scope_registered":
      return "registered";
    case "scope_pruned":
      return "pruned";
    case "workspace_down":
      return "down";
    case "service_installed":
      return "installed";
    case "daemon_started":
      return "started";
    case "prune_completed":
      return "completed";
    default:
      return type || "event";
  }
}

function statusFromType(event) {
  const type = event.type || event.event_type || null;
  if (type === "job_run_completed_success") return "success";
  if (type === "job_run_completed_failure") return "failure";
  if (type === "job_run_completed_timeout") return "timeout";
  if (type === "job_run_skipped" || type === "job_catchup_overflow")
    return "skipped";
  if (type === "job_run_retry") return "retrying";
  if (type === "job_run_cancelled") return "cancelled";
  if (type === "runtime_health_ok") return "success";
  if (
    type === "runtime_health_dispatch_stale" ||
    type === "runtime_health_service_not_running"
  )
    return "failure";
  return event.status || null;
}

function reasonFromEvent(event) {
  const type = event.type || event.event_type || null;
  if (type === "job_catchup_overflow") return "catchup_overflow";
  return event.reason || event.data?.reason || null;
}

export function publicEventFromActivity(event) {
  if (!event) return null;
  const type = event.type || event.event_type || null;
  const payload = clonePayload(event.data || {});
  payload.internal_type = type;
  return {
    id: event.event_id,
    ts: event.timestamp,
    scope_id: event.scope_id || null,
    cwd: event.cwd || null,
    job_id: event.job_id || null,
    run_id: event.run_id || null,
    category: categoryFromType(type, event.kind || null),
    action: actionFromType(type),
    status: statusFromType(event),
    reason: reasonFromEvent(event),
    scheduled_at: event.scheduled_at || null,
    started_at: event.started_at || null,
    finished_at: event.finished_at || null,
    duration_ms: event.duration_ms ?? null,
    level: event.level || "info",
    source: event.source || null,
    message: event.message || null,
    payload,
  };
}

function runKindFromPublicEvent(event) {
  if (!event || event.category !== "run") return null;
  if (event.action === "started") return "started";
  if (event.action === "completed") return "completed";
  if (event.action === "skipped") return "skipped";
  if (event.action === "retry") return "retry";
  if (event.action === "cancelled") return "cancelled";
  return null;
}

export function publicHistoryEventFromActivity(event) {
  const publicEvent = publicEventFromActivity(event);
  const kind = runKindFromPublicEvent(publicEvent);
  if (!kind) return null;
  const payload = publicEvent.payload || {};
  return {
    id: publicEvent.id,
    ts:
      kind === "completed"
        ? publicEvent.finished_at || publicEvent.ts
        : publicEvent.ts,
    scope_id: publicEvent.scope_id,
    cwd: publicEvent.cwd,
    job_id: publicEvent.job_id,
    run_id: publicEvent.run_id,
    kind,
    status: publicEvent.status,
    reason: publicEvent.reason,
    scheduled_at: publicEvent.scheduled_at,
    started_at: publicEvent.started_at,
    finished_at: publicEvent.finished_at,
    duration_ms: publicEvent.duration_ms,
    error: event.error || null,
    log_paths: payload.log_paths || null,
    session_id: payload.session_id ?? null,
    resume_command: payload.resume_command ?? null,
    resume_cwd: payload.resume_cwd ?? null,
    resume_confidence: payload.resume_confidence ?? null,
    resume_candidates: Array.isArray(payload.resume_candidates)
      ? payload.resume_candidates
      : [],
    agent_summary: payload.agent_summary ?? null,
    agent_status: payload.agent_status ?? null,
    agent_error: payload.agent_error ?? null,
    injected_via: payload.injected_via ?? null,
    payload,
  };
}

export function terminalHistoryEvent(events = []) {
  return (
    [...events]
      .filter(
        (event) =>
          event.kind === "completed" ||
          event.kind === "skipped" ||
          event.kind === "cancelled",
      )
      .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")))
      .slice(-1)[0] || null
  );
}
