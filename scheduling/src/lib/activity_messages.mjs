function durationSummary(durationMs) {
  if (!Number.isFinite(durationMs)) return null;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function renderActivityMessage(event) {
  switch (event.type) {
    case "daemon_started":
      return `daemon started instance=${event.data?.daemon_instance_id || "unknown"}`;
    case "scope_registered":
      return `scope registered scope=${event.scope_id || event.cwd || "unknown"}`;
    case "scope_pruned":
      return `scope pruned scope=${event.scope_id || event.cwd || "unknown"}`;
    case "dispatch_started":
      return `dispatch started scope=${event.scope_id || event.cwd || "unknown"}`;
    case "dispatch_finished":
      return `dispatch finished scope=${event.scope_id || event.cwd || "unknown"} status=${event.status || "success"}`;
    case "dispatch_failed":
      return `dispatch failed scope=${event.scope_id || event.cwd || "unknown"} error=${event.error || "unknown"}`;
    case "job_due_detected":
      return `job due id=${event.job_id || "unknown"} scheduled_at=${event.scheduled_at || "unknown"}`;
    case "job_run_started":
      return `run started job=${event.job_id || "unknown"} run=${event.run_id || "unknown"}${event.pid ? ` pid=${event.pid}` : ""}`;
    case "job_run_launching":
      return `run launching job=${event.job_id || "unknown"} run=${event.run_id || "unknown"}`;
    case "job_run_identity_registered":
      return `run identity registered job=${event.job_id || "unknown"} run=${event.run_id || "unknown"}`;
    case "job_run_terminal":
      return `run terminal job=${event.job_id || "unknown"} run=${event.run_id || "unknown"} status=${event.status || "unknown"} reason=${event.reason || "unknown"}`;
    case "job_run_completed_success":
      return `run completed job=${event.job_id || "unknown"} status=success duration=${durationSummary(event.duration_ms) || "unknown"}`;
    case "job_run_completed_failure":
      return `run completed job=${event.job_id || "unknown"} status=failure error=${event.error || "unknown"}`;
    case "job_run_completed_timeout":
      return `run completed job=${event.job_id || "unknown"} status=timeout duration=${durationSummary(event.duration_ms) || "unknown"}`;
    case "job_run_skipped":
      return `run skipped job=${event.job_id || "unknown"} reason=${event.reason || event.data?.reason || "unknown"}`;
    case "job_run_deferred":
      return `run deferred job=${event.job_id || "unknown"} reason=${event.reason || "unknown"} since=${event.data?.deferred_since || event.scheduled_at || "unknown"}`;
    case "job_run_cancelled":
      return `run cancelled job=${event.job_id || "unknown"} run=${event.run_id || "unknown"} pid=${event.pid || "unknown"}`;
    case "job_catchup_overflow":
      return `catchup overflow job=${event.job_id || "unknown"} next=${event.scheduled_at || "unknown"}`;
    case "job_run_retry":
      return `run retry job=${event.job_id || "unknown"} attempt=${event.data?.attempt || "?"}/${event.data?.max_attempts || "?"}`;
    case "job_auto_paused":
      return `job auto-paused job=${event.job_id || "unknown"} reason=${event.data?.reason || "unknown"} failures=${event.data?.consecutive_failures || "?"}`;
    case "notification_webhook_succeeded":
      return `notification delivered channel=webhook job=${event.job_id || "unknown"} run=${event.run_id || "unknown"}`;
    case "notification_webhook_failed":
      return `notification failed channel=webhook job=${event.job_id || "unknown"} run=${event.run_id || "unknown"} error=${event.error || "unknown"}`;
    case "notification_file_appended":
      return `notification delivered channel=file job=${event.job_id || "unknown"} run=${event.run_id || "unknown"}`;
    case "notification_file_failed":
      return `notification failed channel=file job=${event.job_id || "unknown"} run=${event.run_id || "unknown"} error=${event.error || "unknown"}`;
    case "runtime_health_dispatch_stale":
      return `runtime unhealthy scope=${event.scope_id || event.cwd || "unknown"} reason=dispatch_stale`;
    case "runtime_health_service_not_running":
      return `runtime unhealthy reason=service_not_running`;
    case "runtime_health_ok":
      return `runtime healthy${event.scope_id ? ` scope=${event.scope_id}` : ""}`;
    case "job_created":
      return `job created id=${event.job_id || "unknown"} scope=${event.scope_id || event.cwd || "unknown"}`;
    case "job_updated":
      return `job updated id=${event.job_id || "unknown"} scope=${event.scope_id || event.cwd || "unknown"}`;
    case "job_deleted":
      return `job deleted id=${event.job_id || "unknown"} scope=${event.scope_id || event.cwd || "unknown"}`;
    case "job_paused":
      return `job paused id=${event.job_id || "unknown"} scope=${event.scope_id || event.cwd || "unknown"}`;
    case "job_resumed":
      return `job resumed id=${event.job_id || "unknown"} scope=${event.scope_id || event.cwd || "unknown"}`;
    case "job_cloned":
      return `job cloned source=${event.data?.source_id || "unknown"} new=${event.job_id || event.data?.new_id || "unknown"}`;
    case "job_next_run_scheduled":
      return `job next-run id=${event.job_id || "unknown"} next=${event.data?.next_run_at || "unknown"}`;
    case "job_retry_exhausted":
      return `job retry exhausted id=${event.job_id || "unknown"} attempts=${event.data?.attempts || "?"}/${event.data?.max_attempts || "?"}`;
    case "notification_stdout_succeeded":
      return `notification delivered channel=stdout job=${event.job_id || "unknown"} run=${event.run_id || "unknown"}`;
    case "notification_stdout_failed":
      return `notification failed channel=stdout job=${event.job_id || "unknown"} run=${event.run_id || "unknown"} error=${event.error || "unknown"}`;
    case "notification_no_channels":
      return `notification no-channels job=${event.job_id || "unknown"} run=${event.run_id || "unknown"}`;
    case "workspace_down":
      return `workspace down scope=${event.scope_id || event.cwd || "unknown"}`;
    case "service_installed":
      return `service installed mode=${event.data?.mode || "unknown"}`;
    case "prune_completed":
      return `prune completed events=${event.data?.events_deleted ?? 0} logs=${event.data?.log_files_deleted ?? 0} bytes=${event.data?.bytes_freed ?? 0}`;
    case "comms_inbound_webhook_success":
      return `inbound webhook success thread=${event.data?.thread_id || "unknown"} message=${event.data?.substrate_message_id || event.data?.external_message_id || "unknown"}`;
    case "comms_inbound_webhook_hmac_rejected":
      return `inbound webhook rejected reason=hmac request=${event.data?.request_id || "unknown"}`;
    case "comms_inbound_webhook_malformed":
      return `inbound webhook malformed reason=${event.data?.reason || "unknown"} request=${event.data?.request_id || "unknown"}`;
    case "comms_inbound_webhook_normalize_failed":
      return `inbound webhook normalize failed request=${event.data?.request_id || "unknown"} error=${event.data?.error || "unknown"}`;
    case "comms_inbound_webhook_bind_failed":
      return `inbound webhook bind failed port=${event.data?.port || "unknown"} reason=${event.data?.reason || "unknown"}`;
    default:
      return event.message || event.type || "activity";
  }
}
