export const TLDR_AGENT_DIAGNOSTIC_SCHEMA_VERSION = 1;

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const RUNTIMES = new Set(["claude", "codex", "unknown"]);
const EVENT_CODES = new Set([
  "daemon_inbox_poll_scheduler",
  "daemon_inbox_poll_tick",
  "daemon_inbox_poll_tick_failed",
  "daemon_lifecycle",
  "daemon_outbound_tick",
  "daemon_outbound_tick_failed",
  "daemon_singleton_collision",
  "daemon_slack_inbound_tick",
  "daemon_slack_inbound_tick_failed",
  "daemon_slack_listener_exited",
  "daemon_slack_listener_started",
  "daemon_slack_listener_stopped",
  "daemon_slack_outbound_tick",
  "daemon_slack_outbound_tick_failed",
  "local_health_check",
  "transport_email_inbound_dead_lettered",
  "transport_email_inbound_dispatch_failed",
  "transport_email_inbound_idempotent_skip",
  "transport_email_inbound_sender_rejected",
  "transport_email_inbound_webhook_normalized",
  "transport_email_inbound_webhook_received",
  "transport_email_inbox_poll",
  "transport_email_inbox_poll_dispatch_failed",
  "transport_email_inbox_poll_list_failed",
  "transport_email_inbox_poll_message_read_failed",
  "transport_email_send_attempt",
  "transport_email_send_outcome",
  "slack_append_failed",
  "slack_channel_recreated",
  "slack_credentials_absent",
  "slack_credentials_deleted",
  "slack_credentials_read",
  "slack_credentials_refused",
  "slack_credentials_written",
  "slack_delivery_complete_failed",
  "slack_delivery_failed",
  "slack_delivery_release_failed",
  "slack_disconnect_done",
  "slack_disconnect_refused",
  "slack_entry_failed",
  "slack_entry_refused",
  "slack_entry_result",
  "slack_inbound_drained",
  "slack_inbound_hint_failed",
  "slack_inbound_not_ready",
  "slack_inbound_published",
  "slack_inbound_send_failed",
  "slack_inbox_rotated",
  "slack_inbox_rotated_swept",
  "slack_repair_diagnosed",
  "slack_setup_code_rejected",
  "slack_setup_done",
  "slack_setup_failed",
  "slack_setup_register_route",
  "slack_setup_start",
  "slack_socket_close_failed",
  "slack_socket_connecting",
  "slack_socket_crashed",
  "slack_socket_ended",
  "slack_socket_hello",
  "slack_socket_not_ready",
  "slack_socket_open_failed",
  "slack_socket_reconnect_scheduled",
  "slack_socket_stopped",
  "slack_status_checked",
  "tightbeam_slack_claim",
  "tightbeam_slack_commit",
  "tightbeam_slack_complete",
  "tightbeam_slack_publish",
  "tightbeam_slack_register",
  "tightbeam_slack_release",
  "tightbeam_slack_retire",
]);
const OUTCOMES = new Set([
  "accepted",
  "acked",
  "allowed",
  "already_acked",
  "blocked",
  "dead_lettered",
  "deduplicated",
  "delivered",
  "disabled",
  "error",
  "failed",
  "failure",
  "fallback",
  "healthy",
  "idempotent_skip",
  "missed",
  "pending",
  "ready",
  "rejected",
  "released",
  "retry",
  "sent",
  "started",
  "stopped",
  "success",
  "timeout",
  "unknown",
]);
const ERROR_CODES = new Set([
  "agentmail_unreachable",
  "daemon_phase_failed",
  "daemon_phase_timeout",
  "inbound_poll_failed",
  "inbox_list_failed",
  "inbox_poll_timeout",
  "poll_child_aborted",
  "poll_child_failed",
  "poll_child_timeout",
  "provider_send_failed",
  "reply_parent_unauthorized",
  "sender_not_authorized",
  "status_port_bind_failed",
  "tightbeam_delivery_failed",
  "tightbeam_invalid_claimed_delivery",
  "tightbeam_preflight_failed",
]);
// Why an inbox read failed (item 41; set by inboxListFailureCause), or why
// the outbound claim failed (item 49; set by the private poll runner).
const CAUSES = new Set([
  "bridge_exit_nonzero",
  "bridge_output_too_large",
  "bridge_response_invalid",
  "bridge_signaled",
  "bridge_spawn_failed",
  "bridge_timeout",
  "broker_error",
  "claim_failed",
  "listing_malformed",
  "poll_timeout",
  "unknown",
]);
// The Aegis broker's public error codes (aegis_protocol.mjs SAFE_ERRORS).
const BROKER_CODES = new Set([
  "BROKER_UNAVAILABLE",
  "BROKER_VERSION_UNSUPPORTED",
  "CREDENTIAL_UNAVAILABLE",
  "INVALID_FRAME",
  "INVALID_REQUEST",
  "INVALID_TRANSITION",
  "POLICY_CORRUPT",
  "POLICY_ROLLBACK",
  "PROVIDER_UNAVAILABLE",
  "REPLY_PARENT_UNAUTHORIZED",
  "REQUEST_TOO_LARGE",
  "UNAUTHORIZED",
  "UNKNOWN_OPERATION",
]);
const COUNT_KEYS = new Set([
  "accepted",
  "appended",
  "attempt",
  "attempted",
  "attempts",
  "block_count",
  "bridge_exit_code",
  "bridge_ms",
  "dead_owner_resumes_started",
  "deduplicated",
  "delivered",
  "failed",
  "fetched",
  "fresh",
  "latency_ms",
  "observed",
  "processed",
  "rejected",
  "released",
  "retried",
  "sent",
  "stopped_for_deadline",
  "terminal",
  "written",
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
  const code =
    [input.code, input.type, input.event_type, input.event].find(Boolean) ??
    null;
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
    input.result?.outcome,
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
  const cause = firstAllowed(CAUSES, input.cause, data.cause, metadata.cause);
  if (cause) event.cause = cause;
  const brokerCode = firstAllowed(
    BROKER_CODES,
    input.broker_code,
    data.broker_code,
    metadata.broker_code,
  );
  if (brokerCode) event.broker_code = brokerCode;
  // Provider strings are open-ended, so only a short snake_case token passes.
  const result = input.result ?? data;
  const slackError = result?.slack_error;
  if (typeof slackError === "string" && /^[a-z0-9_]{1,64}$/.test(slackError))
    event.slack_error = slackError;
  const httpStatus = Number(result?.http_status);
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)
    event.http_status = httpStatus;
  const counts = projectCounts(input.counts, data, metadata);
  if (counts) event.counts = counts;
  return event;
}
