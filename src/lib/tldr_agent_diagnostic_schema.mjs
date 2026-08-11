export const TLDR_AGENT_DIAGNOSTIC_SCHEMA_VERSION = 1;

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const RUNTIMES = new Set(["claude", "codex", "unknown"]);
const EVENT_CODES = new Set([
  "agent_session_owner_resolution_failed",
  "agent_session_owner_resolved",
  "alive_idle_revive_pid_terminate",
  "ariadne_followup_dismissed",
  "ariadne_followup_unfulfilled",
  "ariadne_pending_record_failed",
  "ariadne_stop_blocked",
  "beacon_followup_cancelled",
  "beacon_followup_unresolved",
  "beacon_stop_gate_unavailable",
  "tldr_agent_ariadne_candidate_record_failed",
  "tldr_agent_dispatch_claim_release_failed",
  "tldr_agent_reply_prompt_presented_failed",
  "comms_dispatcher_dead_lettered",
  "comms_dispatcher_dead_owner_state_recover_failed",
  "comms_dispatcher_dead_owner_state_recovered",
  "comms_dispatcher_decision",
  "comms_dispatcher_inbox_enqueue_failed",
  "comms_dispatcher_resume_attempt",
  "comms_dispatcher_resume_outcome",
  "comms_dispatcher_stale_inbound_no_reply",
  "comms_dispatcher_tick_error",
  "comms_outbound_blocked",
  "daemon_inbox_poll_scheduler",
  "daemon_lifecycle",
  "daemon_reply_obligation_sla_tick",
  "daemon_singleton_collision",
  "local_health_check",
  "reply_obligation_ack_hard_missed_alive_owner",
  "reply_obligation_ack_hard_missed_alive_unknown_owner",
  "reply_obligation_ack_soft_missed",
  "reply_obligation_create_failed",
  "reply_obligation_created",
  "reply_obligation_late_satisfied",
  "reply_obligation_resume_failed_no_ack",
  "reply_obligation_resume_started",
  "reply_obligation_satisfied",
  "substrate_kernel_cross_session_reply_blocked",
  "substrate_kernel_idempotency_collision",
  "substrate_kernel_idempotency_hit",
  "substrate_kernel_message_persist",
  "substrate_kernel_message_submit",
  "substrate_kernel_outbound_metadata_invalid",
  "substrate_kernel_transport_send_failed",
  "tachyon_listener_ack",
  "tachyon_listener_ack_missed",
  "tachyon_listener_delivery",
  "tachyon_listener_heartbeat",
  "tachyon_listener_registered",
  "tachyon_listener_stale",
  "tachyon_listener_terminal",
  "tachyon_safe_handoff",
  "thread_created_without_owner",
  "transport_email_inbound_dead_lettered",
  "transport_email_inbound_dispatch_failed",
  "transport_email_inbound_idempotent_skip",
  "transport_email_inbound_sender_rejected",
  "transport_email_inbound_webhook_normalized",
  "transport_email_inbound_webhook_received",
  "transport_email_inbox_poll",
  "transport_email_inbox_poll_dispatch_failed",
  "transport_email_inbox_poll_list_failed",
  "transport_email_send_attempt",
  "transport_email_send_outcome",
]);
const OUTCOMES = new Set([
  "accepted",
  "acked",
  "allowed",
  "already_acked",
  "blocked",
  "busy_owner_queued",
  "dead_lettered",
  "deduplicated",
  "delivered",
  "delivered_to_alive_session",
  "delivery_pending",
  "disabled",
  "error",
  "failed",
  "failure",
  "fallback",
  "healthy",
  "idempotent_skip",
  "late_satisfied",
  "live_listener_acked",
  "live_listener_fallback",
  "missed",
  "pending",
  "ready",
  "rejected",
  "resume_handoff_scheduled_alive_idle",
  "resume_start_failed",
  "resumed_pid_dead",
  "retry",
  "satisfied",
  "sent",
  "started",
  "stopped",
  "success",
  "terminal",
  "timeout",
  "unknown",
  "unresolved",
]);
const ERROR_CODES = new Set([
  "ack_timeout",
  "agentmail_unreachable",
  "daemon_phase_failed",
  "daemon_phase_timeout",
  "inbox_persist_failed",
  "listener_in_flight",
  "listener_not_owned",
  "missing_listener",
  "obligation_persist_failed",
  "owner_not_ready",
  "provider_send_failed",
  "sender_not_authorized",
  "stale_listener",
  "status_port_bind_failed",
  "thread_not_owned_by_session",
  "thread_owner_missing",
]);
const COUNT_KEYS = new Set([
  "accepted",
  "ack_hard_missed_alive_owner",
  "ack_hard_missed_alive_unknown_owner",
  "ack_soft_missed",
  "alive_owner_overdue",
  "appended",
  "attempt",
  "attempts",
  "block_count",
  "dead_owner_resumes_started",
  "deduplicated",
  "delivered",
  "failed",
  "late_satisfied",
  "observed",
  "processed",
  "rejected",
  "resume_failed_no_ack",
  "resume_failed_no_reply",
  "retried",
  "satisfied",
  "sent",
  "terminal",
  "unread_count",
]);

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function projectCounts(...sources) {
  const counts = {};
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source))
      continue;
    for (const key of COUNT_KEYS) {
      const count = Number(source[key]);
      if (!Number.isFinite(count) || count < 0) continue;
      counts[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(count));
    }
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function firstAllowed(allowed, ...values) {
  return values.find((value) => allowed.has(value)) ?? null;
}

export function projectTldrAgentDiagnostic(
  input = {},
  { now = new Date() } = {},
) {
  const code = input.code || input.type || input.event_type || null;
  if (!EVENT_CODES.has(code)) return null;
  const data = input.data && typeof input.data === "object" ? input.data : {};
  const metadata =
    input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const event = {
    schema_version: TLDR_AGENT_DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: safeDate(input.timestamp || input.ts || now).toISOString(),
    code,
  };
  const level = firstAllowed(LEVELS, input.level);
  if (level) event.level = level;
  const outcome = firstAllowed(
    OUTCOMES,
    input.outcome,
    input.status,
    data.outcome,
    data.decision,
    data.action,
    data.state,
  );
  if (outcome) event.outcome = outcome;
  const runtime = firstAllowed(RUNTIMES, input.runtime, data.runtime);
  if (runtime) event.runtime = runtime;
  const errorCode = firstAllowed(
    ERROR_CODES,
    input.error_code,
    input.reason_code,
    data.error_code,
    data.code,
    data.reason,
    data.fallback_reason,
  );
  if (errorCode) event.error_code = errorCode;
  const counts = projectCounts(input.counts, data, metadata);
  if (counts) event.counts = counts;
  if (
    code.startsWith("beacon_") &&
    typeof data.obligation_id === "string" &&
    /^[A-Za-z0-9_-]{1,160}$/.test(data.obligation_id)
  ) {
    event.obligation_id = data.obligation_id;
  }
  if (
    code.startsWith("beacon_") &&
    typeof input.event_id === "string" &&
    /^[A-Za-z0-9:_-]{1,200}$/.test(input.event_id)
  ) {
    event.event_id = input.event_id;
  }
  if (
    code === "beacon_stop_gate_unavailable" &&
    typeof data.availability_key === "string" &&
    /^[a-f0-9]{24}$/.test(data.availability_key)
  ) {
    event.availability_key = data.availability_key;
  }
  return event;
}
