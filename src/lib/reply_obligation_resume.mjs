import { processStartEvidence } from "./process_liveness.mjs";
import { immutableOwnerCwd } from "./session_owner_state.mjs";
import { derivedResumeId } from "./tldr_agent_exact_resume.mjs";
import { getMessage, getTransportState } from "./substrate/canonical_store.mjs";

const RESUME_CLAIM_LEASE_MS = 60_000;
const RESUME_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SUPPORTED_RESUME_RUNTIMES = new Set(["claude", "codex"]);

export function replyObligationResultSummary(scope, processed) {
  return {
    ok: true,
    scope_id: scope?.scope_id ?? null,
    processed,
    pending_checked: 0,
    due_checked: 0,
    terminal_checked: 0,
    event_projections_repaired: 0,
    store_writes: 0,
    satisfied: 0,
    late_satisfied: 0,
    alive_owner_overdue: 0,
    alive_unknown_owner_overdue: 0,
    alive_listening_owner_acked: 0,
    alive_idle_owner_resumes_started: 0,
    alive_listener_failed_resumes_started: 0,
    dead_owner_resumes_started: 0,
    resume_failed_no_reply: 0,
    ack_soft_missed: 0,
    ack_hard_missed_alive_owner: 0,
    ack_hard_missed_alive_unknown_owner: 0,
    resume_failed_no_ack: 0,
  };
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function resumeEvent(scope, type, ownerState, obligation, invoke, logPrefix) {
  return {
    type,
    level: "warn",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: {
      message_id: obligation.message_id,
      thread_id: obligation.thread_id,
      owner_session_id: obligation.owner_session_id,
      pid: ownerState.pid,
      live_pid_source: ownerState.source,
      owner_state: ownerState.state,
      listener_state: ownerState.listener?.state || null,
      listener_reason: ownerState.listenerReason || null,
      invoke_ok: Boolean(invoke?.ok),
      resume_id: invoke?.resume_id || null,
      invoke_error: invoke?.error || null,
      log_prefix: logPrefix,
    },
  };
}

export function findDurableRecoveryResume({ scope, obligation, ownerState }) {
  const identity = ownerState?.identity;
  const ownerCwd = immutableOwnerCwd(identity);
  const ownerRuntime = identity?.runtime;
  if (
    identity?.session_id !== obligation?.owner_session_id ||
    !ownerCwd ||
    !SUPPORTED_RESUME_RUNTIMES.has(ownerRuntime)
  ) {
    return { ok: false, retry_safe: false, error: "owner_identity_invalid" };
  }
  const resumeId = derivedResumeId(obligation.owner_session_id);
  let message;
  let transportState;
  try {
    message = getMessage(scope, obligation.message_id);
    transportState = getTransportState(scope, obligation.message_id);
  } catch {
    return { ok: false, retry_safe: false, error: "resume_store_unreadable" };
  }
  const started = transportState?.tldr_agent_inbound?.presentation;
  if (!message || !started) {
    return { ok: false, retry_safe: true, error: "resume_evidence_absent" };
  }
  if (transportState?.direct_resume_terminal_state === "failure") {
    return { ok: false, retry_safe: true, error: "resume_terminal_failed" };
  }
  if (
    message.message_id !== obligation.message_id ||
    message.thread_id !== obligation.thread_id ||
    started.state !== "resume_started" ||
    started.session_id !== obligation.owner_session_id ||
    started.resume_id !== resumeId
  ) {
    return { ok: false, retry_safe: false, error: "resume_evidence_conflict" };
  }
  return { ok: true, retry_safe: false, resume_id: resumeId };
}

function resumeClaimExpired(obligation, now) {
  if (obligation?.resume_attempt_state !== "claimed") return false;
  let expiresAt = Date.parse(obligation.resume_attempt_lease_expires_at || "");
  if (!Number.isFinite(expiresAt)) {
    const claimedAt = Date.parse(obligation.resume_attempt_claimed_at || "");
    if (!Number.isFinite(claimedAt)) return false;
    expiresAt = claimedAt + RESUME_CLAIM_LEASE_MS;
  }
  return expiresAt <= new Date(now).getTime();
}

export function reconcileAmbiguousRecoveryResume({
  scope,
  obligation,
  ownerState,
  now,
  persist,
  findExistingResume = findDurableRecoveryResume,
}) {
  const resumeAttemptCount = obligation.resume_attempt_count || 0;
  const claimExpired = resumeClaimExpired(obligation, now);
  const ambiguous =
    resumeAttemptCount > 0 &&
    (obligation.resume_attempt_state === "claimed" ||
      obligation.resume_attempt_state === "released");
  if (ambiguous) {
    let existing;
    try {
      existing = findExistingResume({ scope, obligation, ownerState });
    } catch {
      existing = {
        ok: false,
        retry_safe: false,
        error: "resume_store_unreadable",
      };
    }
    if (existing?.ok) {
      obligation.resume_attempt_state = "scheduled";
      obligation.resume_attempt_completed_at = iso(now);
      obligation.resume_attempt_lease_expires_at = null;
      obligation.last_resume_schedule_id = existing.resume_id;
      obligation.last_resume_error = null;
      persist();
      return { action: "hold", resumeAttemptCount };
    }
    if (!existing?.retry_safe) {
      obligation.last_resume_error =
        existing?.error || "resume_reconcile_failed";
      persist();
      return { action: "hold", resumeAttemptCount };
    }
  }
  if (obligation.resume_attempt_state === "claimed" && !claimExpired) {
    return { action: "hold", resumeAttemptCount };
  }
  const retryReleasedClaim =
    resumeAttemptCount > 0 &&
    resumeAttemptCount < 2 &&
    (obligation.resume_attempt_state === "released" || claimExpired);
  if (claimExpired) {
    obligation.resume_attempt_state = "released";
    obligation.resume_attempt_completed_at = iso(now);
    obligation.resume_attempt_lease_expires_at = null;
    obligation.last_resume_error = "resume_claim_expired";
    persist();
  }
  return { action: "proceed", resumeAttemptCount, retryReleasedClaim };
}

export async function startRecoveryResume({
  scope,
  obligation,
  ownerState,
  resumeAgentSession,
  emit,
  result,
  counterName,
  eventType,
  logPrefix,
  now,
  persist,
  replaceOwner = false,
}) {
  const inboundRow = getMessage(scope, obligation.message_id);
  const expectedStartTime = replaceOwner
    ? processStartEvidence(ownerState.pid).start_time
    : null;
  obligation.resume_attempt_count = (obligation.resume_attempt_count || 0) + 1;
  obligation.resume_attempt_state = "claimed";
  obligation.resume_attempt_claimed_at = iso(now);
  obligation.resume_attempt_lease_expires_at = new Date(
    new Date(now).getTime() + RESUME_CLAIM_LEASE_MS,
  ).toISOString();
  obligation.resume_attempt_completed_at = null;
  obligation.last_resume_schedule_id = null;
  obligation.state = "escalated";
  persist();

  const ownerCwd = immutableOwnerCwd(ownerState.identity);
  const ownerRuntime = ownerState.identity?.runtime;
  const ownerIdentityMatches =
    ownerState.identity?.session_id === obligation.owner_session_id;
  const resumeArgs =
    ownerIdentityMatches &&
    ownerCwd &&
    SUPPORTED_RESUME_RUNTIMES.has(ownerRuntime)
      ? {
          sessionId: obligation.owner_session_id,
          runtime: ownerRuntime,
          cwd: ownerCwd,
          inboundRow,
          scope,
        }
      : null;
  if (replaceOwner && resumeArgs) {
    resumeArgs.replacement = {
      expectedPid: ownerState.pid,
      expectedStartTime,
      pidSource: ownerState.source,
      controllingTty: ownerState.identity?.controlling_tty || null,
    };
  }
  let invoke;
  if (!resumeArgs) {
    invoke = {
      ok: false,
      error: !ownerIdentityMatches
        ? "owner_identity_recovery_required"
        : ownerCwd
          ? "owner_runtime_recovery_required"
          : "owner_cwd_recovery_required",
    };
  } else {
    let resolveCancellation;
    let cancelled = false;
    const cancellation = new Promise((resolve) => {
      resolveCancellation = resolve;
    });
    const handlers = new Map();
    const removeHandlers = () => {
      for (const [signalName, handler] of handlers) {
        process.off(signalName, handler);
      }
      handlers.clear();
    };
    for (const signalName of RESUME_SIGNALS) {
      const hadOtherListener = process.listenerCount(signalName) > 0;
      const handler = () => {
        if (cancelled) return;
        cancelled = true;
        obligation.resume_attempt_state = "released";
        obligation.resume_attempt_completed_at = new Date().toISOString();
        obligation.resume_attempt_lease_expires_at = null;
        obligation.last_resume_error = `cancelled_${signalName.toLowerCase()}`;
        persist();
        resolveCancellation({
          ok: false,
          cancelled: true,
          error: obligation.last_resume_error,
        });
        if (!hadOtherListener) setImmediate(() => process.exit(0));
      };
      handlers.set(signalName, handler);
      process.once(signalName, handler);
    }
    try {
      invoke = await Promise.race([
        Promise.resolve().then(() => resumeAgentSession(resumeArgs)),
        cancellation,
      ]);
    } catch (err) {
      invoke = { ok: false, error: err?.message || String(err) };
    } finally {
      removeHandlers();
    }
  }
  if (!invoke?.cancelled) {
    obligation.resume_attempt_state = invoke?.ok ? "scheduled" : "failed";
    obligation.resume_attempt_completed_at = iso(now);
    obligation.resume_attempt_lease_expires_at = null;
    obligation.last_resume_schedule_id = invoke?.resume_id || null;
    obligation.last_resume_error = invoke?.error || null;
    persist();
  }
  result[counterName] += 1;
  emit(
    resumeEvent(scope, eventType, ownerState, obligation, invoke, logPrefix),
  );
  return true;
}
