// PRFAQ-0-1 Phase 1 — comms dispatcher.
//
// Runs inside the daemon tick (src/lib/daemon.mjs:runOnce). For every inbound
// canonical row (metadata.source='inbound_webhook') lacking a terminal
// dispatch_decision, executes the three-rule decision tree:
//
//   Case A  PID dead              → resume directly
//   Case B1 PID alive + idle      → resume with safe owner replacement
//   Case B2 PID alive otherwise   → enqueue inbox + delivered_to_alive_session
//   Case D  no captured session   → bounded owner recovery
//
// Decision is recorded durably on transport_state; the
// canonical message payload is immutable after persistence.
//
// Idempotency: routed replies are appended to inbox.jsonl with message-id
// de-dupe before a terminal dispatch_decision is stamped. A daemon crash before
// stamping can retry without duplicate inbox entries.
//
// References: design doc §4 (decision tree), §5 (TTY primitive),
// §9 (failure-mode table).

import { join } from "node:path";
import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import {
  listMessages,
  getThread,
  upsertThread,
  getTransportState,
  loadTransportStateEntries,
  messagesDir,
  mutateTransportState,
} from "./substrate/canonical_store.mjs";
import { lookupThreadOwnerSession } from "./substrate/thread_ownership.mjs";
import { readState, readIdentity } from "./identity_state.mjs";
import { resumeAgentSession as _defaultResumeAgentSession } from "./substrate/resume_session.mjs";
import { appendJsonLine } from "./store.mjs";
import {
  tryTachyonLiveDelivery,
  waitForTachyonAck,
} from "./tachyon_dispatcher.mjs";
import { enqueueInboxEntry } from "./session_inbox.mjs";
import { createReplyObligation } from "./reply_obligation_sla.mjs";
import {
  classifySessionOwnerState,
  immutableOwnerCwd,
} from "./session_owner_state.mjs";
import { reconcileDeadOwnerState } from "./comms_dispatcher_owner_reconcile.mjs";
import { processStartEvidence } from "./process_liveness.mjs";
import {
  claimTldrAgentInbound,
  releaseTldrAgentInbound,
} from "./tldr_agent_inbound_claim.mjs";
import { mutateTldrAgentInbound } from "./tldr_agent_inbound_lifecycle.mjs";

const _routeDeps = {
  resumeAgentSession: _defaultResumeAgentSession,
  waitForTachyonAck,
};

const TERMINAL_DECISIONS = new Set([
  "resumed_pid_dead",
  "resume_handoff_scheduled_alive_idle",
  "delivered_to_alive_session",
  "live_listener_acked",
  "reply_already_satisfied",
  "stale_inbound_no_reply",
  "dead_lettered",
]);

// Infrastructure and fixed-scope recovery failures use exponential backoff up
// to DISPATCH_MAX_ATTEMPTS, then dead-letter durably on the canonical message.
const RETRY_BACKOFF_DECISIONS = new Set([
  "resume_start_failed",
  "thread_recovery_required",
  "owner_cwd_recovery_required",
  "obligation_persist_failed",
  "inbox_persist_failed",
  "dispatch_claim_persist_failed",
]);

export const DISPATCH_MAX_ATTEMPTS = 8;
const DISPATCH_RETRY_BASE_MS = 30_000;
const DISPATCH_RETRY_MAX_MS = 30 * 60_000;
const DEFAULT_INBOUND_NACK_REPLY_TTL_MS = 15 * 60_000;
const DEFAULT_INBOUND_HARD_REPLY_TTL_MS = 6 * 60 * 60_000;

function dispatchRetryDelayMs(attempts) {
  return Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_MAX_MS,
  );
}

const TERMINAL_HANDOFF_DECISIONS = new Set([
  "resumed_pid_dead",
  "resume_handoff_scheduled_alive_idle",
  "delivered_to_alive_session",
  "live_listener_acked",
  // The exact owner already read this inbound and sent a delivered reply.
  // Treat that durable completion as terminal even if an earlier resume
  // scheduling attempt left the dispatcher row retryable.
  "reply_already_satisfied",
]);

const LIVE_PRESENTATION_DECISIONS = new Set([
  "delivered_to_alive_session",
  "live_listener_acked",
]);

const RESUME_PRESENTATION_DECISIONS = new Set([
  "resumed_pid_dead",
  "resume_handoff_scheduled_alive_idle",
]);

function hasDurableDirectResumeInFlight(transportState) {
  return (
    transportState?.tldr_agent_inbound?.presentation?.state ===
      "resume_started" &&
    transportState?.direct_resume_terminal_state === "running"
  );
}

function configuredPositiveMs(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function inboundMessageTimestampMs(row) {
  const candidates = [row?.created_at, row?.scheduled_for].filter(Boolean);
  for (const value of candidates) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inboundAgeMs(row, nowMs = Date.now()) {
  const timestampMs = inboundMessageTimestampMs(row);
  if (!Number.isFinite(timestampMs)) return null;
  return Math.max(0, nowMs - timestampMs);
}

function staleInboundNoReplyDetail({
  row,
  ageMs,
  ttlMs,
  policy,
  routeError = null,
}) {
  return {
    reason: "replyability_ttl_expired",
    policy,
    age_ms: ageMs,
    ttl_ms: ttlMs,
    message_created_at: row?.created_at || null,
    message_scheduled_for: row?.scheduled_for || null,
    route_error: routeError,
  };
}

function staleInboundNoReplyDecision({ row, origin }) {
  const ageMs = inboundAgeMs(row);
  if (!Number.isFinite(ageMs)) return null;
  const hardTtlMs = configuredPositiveMs(
    "HELM_INBOUND_HARD_REPLY_TTL_MS",
    DEFAULT_INBOUND_HARD_REPLY_TTL_MS,
  );
  if (ageMs > hardTtlMs) {
    return staleInboundNoReplyDetail({
      row,
      ageMs,
      ttlMs: hardTtlMs,
      policy: "hard_reply_ttl",
    });
  }
  if (origin?.metadata?.session_id) return null;
  const nackTtlMs = configuredPositiveMs(
    "HELM_INBOUND_NACK_REPLY_TTL_MS",
    DEFAULT_INBOUND_NACK_REPLY_TTL_MS,
  );
  if (ageMs <= nackTtlMs) return null;
  return staleInboundNoReplyDetail({
    row,
    ageMs,
    ttlMs: nackTtlMs,
    policy: "route_failure_nack_ttl",
    routeError: "durable_thread_owner_unavailable",
  });
}

function recordStaleInboundNoReply(scope, row, messageId, detail) {
  recordDecision(scope, messageId, "stale_inbound_no_reply", detail);
  appendActivityEvent({
    type: "comms_dispatcher_stale_inbound_no_reply",
    level: "warn",
    scope_id: scope.scope_id ?? null,
    cwd: scope.cwd ?? null,
    data: {
      message_id: messageId,
      thread_id: row?.thread_id || null,
      reason: detail.reason,
      policy: detail.policy,
      age_ms: detail.age_ms,
      ttl_ms: detail.ttl_ms,
      route_error: detail.route_error || null,
    },
  });
  return "stale_inbound_no_reply";
}

function resumeInvokeDetail(invoke, base = {}) {
  const detail = {
    ...base,
    invoke_ok: Boolean(invoke?.ok),
  };
  if (invoke?.ok) {
    detail.resume_id = invoke.resume_id || null;
    detail.process_started = Boolean(invoke.process_started);
    detail.pid = invoke.pid || null;
    detail.handoff_started = Boolean(invoke.handoff_started);
  } else {
    detail.invoke_error = invoke?.error || null;
    detail.invoke_hint = invoke?.hint || null;
    detail.invoke_stderr = invoke?.stderr || null;
    detail.invoke_stdout = invoke?.stdout || null;
    detail.invoke_exit_code = invoke?.exit_code ?? null;
    detail.resume_id = invoke?.resume_id || null;
  }
  return detail;
}

function recordResumeStartFailed(scope, messageId, detail) {
  recordDecision(scope, messageId, "resume_start_failed", detail);
  appendActivityEvent({
    type: "comms_dispatcher_decision",
    level: "error",
    scope_id: scope.scope_id ?? null,
    cwd: scope.cwd ?? null,
    data: {
      message_id: messageId,
      decision: "resume_start_failed",
      session_id: detail.session_id || null,
      target_scope_id: detail.target_scope_id || null,
      invoke_ok: false,
      resume_id: detail.resume_id || null,
      invoke_error: detail.invoke_error || null,
      invoke_hint: detail.invoke_hint || null,
      invoke_stderr: detail.invoke_stderr || null,
      invoke_stdout: detail.invoke_stdout || null,
      invoke_exit_code: detail.invoke_exit_code ?? null,
    },
  });
  return "resume_start_failed";
}

function resumeCommandForRuntime(runtime, sessionId) {
  return runtime === "codex"
    ? `codex exec resume ${sessionId}`
    : `claude --resume ${sessionId}`;
}

// Select inbound rows that have not yet reached a terminal dispatch decision.
function selectPendingInboundRows(scope) {
  const transportEntries = loadTransportStateEntries(scope);
  const out = [];
  for (const row of listMessages(scope)) {
    const isInbound = row?.metadata?.source === "inbound_webhook";
    if (!isInbound) continue;
    const ts = transportEntries[row.message_id] || null;
    if (ts?.tldr_agent_inbound?.terminal) continue;
    // Opportunity #1: rows inside their retry-backoff window are held —
    // a failing resume is no longer hammered on every tick.
    const nextRetryMs = ts?.tldr_agent_inbound?.next_retry_at
      ? Date.parse(ts.tldr_agent_inbound.next_retry_at)
      : null;
    if (Number.isFinite(nextRetryMs) && nextRetryMs > Date.now()) continue;
    out.push({ row, transport_state: ts });
  }
  return out;
}

function deadLetterLedgerPath(scope) {
  return join(messagesDir(scope), "dead-letter.jsonl");
}

function recordDecision(scope, messageId, decision, detail = {}) {
  const decidedAt = new Date().toISOString();
  const terminalHandoff = TERMINAL_HANDOFF_DECISIONS.has(decision)
    ? {
        inbound_terminal_state: decision,
        inbound_terminal_reason: null,
        inbound_terminal_at: decidedAt,
      }
    : {};

  // Opportunity #1: retryable infra failures accrue attempts + exponential
  // backoff atomically (under the transport-state lock), escalating to a
  // durable dead-letter once attempts are exhausted. Success and waiting
  // decisions clear the retry bookkeeping.
  let deadLettered = false;
  const next = mutateTransportState(scope, messageId, (prior) => {
    const lifecycle = {
      version: 1,
      state: "received",
      received_at: decidedAt,
      updated_at: decidedAt,
      attempt_count: 0,
      next_retry_at: null,
      last_error_code: null,
      lease: null,
      inbox: null,
      presentation: null,
      reply: null,
      terminal: null,
      ...(prior.tldr_agent_inbound || {}),
    };
    if (RETRY_BACKOFF_DECISIONS.has(decision)) {
      const attempts = (Number(prior.dispatch_attempts) || 0) + 1;
      if (attempts >= DISPATCH_MAX_ATTEMPTS) {
        deadLettered = true;
        return {
          dispatch_decision: "dead_lettered",
          dispatch_decided_at: decidedAt,
          dispatch_detail: detail,
          dispatch_attempts: attempts,
          dispatch_next_retry_at: null,
          inbound_terminal_state: "dead_lettered",
          inbound_terminal_reason: decision,
          inbound_terminal_at: decidedAt,
          tldr_agent_inbound: {
            ...lifecycle,
            state: "terminal",
            updated_at: decidedAt,
            attempt_count: attempts,
            next_retry_at: null,
            last_error_code: decision,
            terminal: {
              state: "failed",
              reason: decision,
              at: decidedAt,
            },
          },
        };
      }
      const nextRetryAt = new Date(
        Date.now() + dispatchRetryDelayMs(attempts),
      ).toISOString();
      return {
        dispatch_decision: decision,
        dispatch_decided_at: decidedAt,
        dispatch_detail: detail,
        dispatch_attempts: attempts,
        dispatch_next_retry_at: nextRetryAt,
        tldr_agent_inbound: {
          ...lifecycle,
          state: "retry_wait",
          updated_at: decidedAt,
          attempt_count: attempts,
          next_retry_at: nextRetryAt,
          last_error_code: decision,
        },
      };
    }
    const clearRetry =
      TERMINAL_DECISIONS.has(decision) && prior.dispatch_next_retry_at
        ? { dispatch_next_retry_at: null }
        : {};
    let lifecycleUpdate = {};
    if (RESUME_PRESENTATION_DECISIONS.has(decision)) {
      lifecycleUpdate = {
        state: "reply_pending",
        presentation: {
          state: "resume_started",
          at: decidedAt,
          session_id: detail.session_id || null,
          runtime: detail.runtime || null,
          resume_id: detail.resume_id || null,
          pid: detail.pid || null,
        },
        terminal: { state: "presented", decision, at: decidedAt },
      };
    } else if (LIVE_PRESENTATION_DECISIONS.has(decision)) {
      lifecycleUpdate = {
        state: "reply_pending",
        presentation: {
          state: "presented_live",
          at: decidedAt,
          session_id: detail.session_id || null,
          pid: detail.last_pid || detail.pid || null,
        },
        terminal: { state: "presented", decision, at: decidedAt },
      };
    } else if (decision === "reply_already_satisfied") {
      lifecycleUpdate = {
        state: "satisfied",
        terminal: { state: "satisfied", decision, at: decidedAt },
      };
    } else if (TERMINAL_DECISIONS.has(decision)) {
      lifecycleUpdate = {
        state: "terminal",
        terminal: {
          state: "complete",
          decision,
          reason: null,
          at: decidedAt,
        },
      };
    }
    return {
      dispatch_decision: decision,
      dispatch_decided_at: decidedAt,
      dispatch_detail: detail,
      ...clearRetry,
      ...terminalHandoff,
      tldr_agent_inbound: {
        ...lifecycle,
        ...lifecycleUpdate,
        updated_at: decidedAt,
        next_retry_at: null,
        last_error_code: null,
      },
    };
  });

  if (deadLettered) {
    appendJsonLine(
      deadLetterLedgerPath(scope),
      {
        message_id: messageId,
        scope_id: scope.scope_id || null,
        reason: decision,
        attempts: next.dispatch_attempts,
        dead_lettered_at: decidedAt,
        detail,
      },
      { durable: true },
    );
    appendActivityEvent({
      type: "comms_dispatcher_dead_lettered",
      level: "error",
      scope_id: scope.scope_id ?? null,
      cwd: scope.cwd ?? null,
      data: {
        message_id: messageId,
        reason: decision,
        attempts: next.dispatch_attempts,
        ledger_path: deadLetterLedgerPath(scope),
      },
    });
  }
  return next;
}

// Resolve the originating session for an inbound row. Thread ownership is the
// only canonical session route. Opportunity #5: use the SAME rule as
// thread_ownership.lookupThreadOwnerSession — the O(1) stamped
// owner_session_id, then the legacy earliest-outbound fallback for threads
// created before the invariant — so the owner the invariant protects can
// never differ from the session the dispatcher resumes. The legacy fallback
// only counts when the candidate resolves to a durable registered identity;
// otherwise bounded owner recovery preserves the unresolved inbound without
// guessing a destination. A durable legacy owner is written through onto the
// thread row so the next lookup is O(1).
function resolveOriginSession(scope, inboundRow) {
  const thread = getThread(scope, inboundRow.thread_id);
  let ownerSessionId = thread?.owner_session_id || null;
  if (ownerSessionId && !readIdentity(ownerSessionId)) {
    ownerSessionId = null;
  }
  if (!ownerSessionId) {
    const legacyOwner = lookupThreadOwnerSession(scope, inboundRow.thread_id);
    if (legacyOwner && readIdentity(legacyOwner)) {
      ownerSessionId = legacyOwner;
      if (thread) {
        upsertThread(scope, {
          thread_id: inboundRow.thread_id,
          owner_session_id: ownerSessionId,
          owner_session_backfilled_at: new Date().toISOString(),
          owner_session_backfill_reason: "legacy_earliest_outbound_durable",
        });
      }
    }
  }
  if (!ownerSessionId) return null;
  return {
    thread_owner_fallback: true,
    metadata: {
      session_id: ownerSessionId,
      controlling_tty: thread?.owner_controlling_tty || null,
    },
  };
}

// Per-row dispatch. The durable per-inbound claim encloses obligation/inbox
// persistence and the one authoritative live/dead owner route.
async function dispatchOne(scope, { row }, runtime) {
  const messageId = row.message_id;
  const latestTransportState = getTransportState(scope, messageId);
  const latestDecision = latestTransportState?.dispatch_decision || null;
  if (latestDecision && TERMINAL_DECISIONS.has(latestDecision)) {
    return latestDecision;
  }
  if (hasDurableDirectResumeInFlight(latestTransportState)) {
    return "queued_resume_in_flight";
  }
  const dispatchClaim = claimTldrAgentInbound({ scope, messageId });
  if (!dispatchClaim.ok) {
    const failed = recordDecision(
      scope,
      messageId,
      "dispatch_claim_persist_failed",
      { reason: dispatchClaim.error || "dispatch_claim_persist_failed" },
    );
    return failed.dispatch_decision;
  }
  if (!dispatchClaim.claimed) return "queued_dispatch_claim_held";

  try {
    const threadId = row.thread_id;

    // Only the immutable thread owner can receive the inbound. Missing ownership
    // enters bounded recovery; no address/header/workspace input is a route.
    const origin = resolveOriginSession(scope, row);
    const staleDecision = staleInboundNoReplyDecision({
      row,
      origin,
    });
    if (staleDecision) {
      return recordStaleInboundNoReply(scope, row, messageId, staleDecision);
    }

    if (!origin || !origin.metadata?.session_id) {
      const recovery = recordDecision(
        scope,
        messageId,
        "thread_recovery_required",
        {
          thread_id: threadId,
          reason: "durable_thread_owner_unavailable",
        },
      );
      return recovery.dispatch_decision;
    }

    const sessionId = origin.metadata.session_id;
    const originDispatchDetail = origin.dispatch_detail || {};
    const identity = readIdentity(sessionId);
    let state = readState(sessionId);
    try {
      const obligation = createReplyObligation({
        scope,
        inboundRow: row,
        ownerSessionId: sessionId,
      });
      if (!obligation?.ok) {
        throw new Error(
          obligation?.error || "reply obligation persistence failed",
        );
      }
      if (
        obligation.obligation?.state === "satisfied" ||
        obligation.obligation?.durable_satisfaction_state === "satisfied"
      ) {
        const satisfied = recordDecision(
          scope,
          messageId,
          "reply_already_satisfied",
          {
            thread_id: threadId,
            session_id: sessionId,
            satisfied_by_message_id:
              obligation.obligation.satisfied_by_message_id ||
              obligation.obligation.acked_by_message_id ||
              null,
            durable_satisfied_at:
              obligation.obligation.durable_satisfied_at || null,
          },
        );
        return satisfied.dispatch_decision;
      }
    } catch (err) {
      appendActivityEvent({
        type: "reply_obligation_create_failed",
        level: "warn",
        scope_id: scope.scope_id ?? null,
        cwd: scope.cwd ?? null,
        error: err.message,
        data: {
          message_id: messageId,
          thread_id: threadId,
          session_id: sessionId,
        },
      });
      const failed = recordDecision(
        scope,
        messageId,
        "obligation_persist_failed",
        { thread_id: threadId, session_id: sessionId },
      );
      return failed.dispatch_decision;
    }

    const inboxEntry = {
      queued_at: new Date().toISOString(),
      message_id: messageId,
      thread_id: threadId,
      subject: row.subject || null,
      body: row.body || null,
      sender: row.sender || null,
      external_message_id: null, // populated when AgentMail webhook carries it
    };
    try {
      const enqueued = enqueueInboxEntry(sessionId, inboxEntry);
      if (!enqueued || typeof enqueued.appended !== "boolean") {
        throw new Error(
          "inbox persistence did not confirm append or duplicate",
        );
      }
      const inboxWrittenAt = new Date().toISOString();
      const lifecycle = mutateTldrAgentInbound({
        scope,
        messageId,
        now: new Date(inboxWrittenAt),
        mutate(prior) {
          return {
            state: "inbox_written",
            inbox: {
              state: "written",
              message_id: messageId,
              session_id: sessionId,
              written_at: prior.inbox?.written_at || inboxWrittenAt,
              append_result: enqueued.appended ? "appended" : "duplicate",
            },
          };
        },
      });
      if (!lifecycle?.inbox?.written_at) {
        throw new Error("canonical inbox transition did not persist");
      }
    } catch (err) {
      appendActivityEvent({
        type: "comms_dispatcher_inbox_enqueue_failed",
        level: "warn",
        scope_id: scope.scope_id ?? null,
        cwd: scope.cwd ?? null,
        error: err.message,
        data: { message_id: messageId, session_id: sessionId },
      });
      const failed = recordDecision(scope, messageId, "inbox_persist_failed", {
        thread_id: threadId,
        session_id: sessionId,
      });
      return failed.dispatch_decision;
    }

    const ownerState = classifySessionOwnerState({
      sessionId,
      identity,
      state,
    });
    state = reconcileDeadOwnerState({ scope, sessionId, ownerState, state });
    const lastPid = ownerState.pid;
    const pidAlive = ownerState.alive;
    const tachyon = await tryTachyonLiveDelivery({
      scope,
      sessionId,
      messageId,
      pidAlive,
      liveSessionEligible: ownerState.listenerEligible,
      sessionState: state,
      waitForAck: _routeDeps.waitForTachyonAck,
      recordDecision,
    });
    if (tachyon.handled) return tachyon.decision;
    if (pidAlive && state?.state === "idle") {
      const resumeCwd = immutableOwnerCwd(identity);
      if (!resumeCwd) {
        const recovery = recordDecision(
          scope,
          messageId,
          "owner_cwd_recovery_required",
          { thread_id: threadId, session_id: sessionId },
        );
        return recovery.dispatch_decision;
      }
      const effectiveRuntime = identity?.runtime || runtime;
      const expectedStartTime = processStartEvidence(lastPid).start_time;
      const baseDetail = {
        session_id: sessionId,
        last_pid: lastPid,
        live_pid_source: ownerState.source,
        state: state.state,
        state_status: "present",
        expected_start_time: expectedStartTime,
        runtime: effectiveRuntime,
        resume_command: resumeCommandForRuntime(effectiveRuntime, sessionId),
        ...originDispatchDetail,
      };

      let invoke;
      try {
        invoke = await _routeDeps.resumeAgentSession({
          sessionId,
          runtime: effectiveRuntime,
          cwd: resumeCwd,
          inboundRow: row,
          scope,
          replacement: {
            expectedPid: lastPid,
            expectedStartTime,
            pidSource: ownerState.source,
            controllingTty: identity?.controlling_tty || null,
          },
        });
      } catch (err) {
        invoke = {
          ok: false,
          error: "resume_start_threw",
          hint: err?.message || String(err),
        };
      }
      const detail = resumeInvokeDetail(invoke, baseDetail);
      if (!invoke?.ok) {
        return recordResumeStartFailed(scope, messageId, detail);
      }
      recordDecision(
        scope,
        messageId,
        "resume_handoff_scheduled_alive_idle",
        detail,
      );
      appendActivityEvent({
        type: "comms_dispatcher_decision",
        level: "info",
        scope_id: scope.scope_id ?? null,
        cwd: scope.cwd ?? null,
        data: {
          message_id: messageId,
          decision: "resume_handoff_scheduled_alive_idle",
          session_id: sessionId,
          last_pid: lastPid,
          invoke_ok: true,
          resume_id: detail.resume_id,
          pid: detail.pid,
          log_prefix: "[🪳 TEMP TACHYON_SAFE_HANDOFF]",
          ...originDispatchDetail,
        },
      });
      return "resume_handoff_scheduled_alive_idle";
    }

    if (pidAlive) {
      const detail = {
        session_id: sessionId,
        last_pid: lastPid,
        live_pid_source: ownerState.source,
        state: state?.state || null,
        state_status: state ? "present" : "missing",
        ...originDispatchDetail,
      };
      recordDecision(scope, messageId, "delivered_to_alive_session", detail);
      appendActivityEvent({
        type: "tachyon_safe_handoff",
        level: "info",
        scope_id: scope.scope_id ?? null,
        cwd: scope.cwd ?? null,
        data: {
          action: "busy_owner_queued",
          message_id: messageId,
          session_id: sessionId,
          pid: lastPid,
          listener_reason: tachyon.reason || null,
          log_prefix: "[🪳 TEMP TACHYON_SAFE_HANDOFF]",
        },
      });
      appendActivityEvent({
        type: "comms_dispatcher_decision",
        level: "info",
        scope_id: scope.scope_id ?? null,
        cwd: scope.cwd ?? null,
        data: {
          message_id: messageId,
          decision: "delivered_to_alive_session",
          session_id: sessionId,
          last_pid: lastPid,
          live_pid_source: ownerState.source,
          state: state?.state || null,
          state_status: state ? "present" : "missing",
          ...originDispatchDetail,
        },
      });
      return "delivered_to_alive_session";
    }

    // Case A — PID dead. Start the exact runtime/session directly in its
    // immutable originating cwd. The resumed session receives the bounded
    // owner reply on stdin and drains its queued inbox entry on this turn.
    const resumeCwd = immutableOwnerCwd(identity);
    if (!resumeCwd) {
      const recovery = recordDecision(
        scope,
        messageId,
        "owner_cwd_recovery_required",
        { thread_id: threadId, session_id: sessionId },
      );
      return recovery.dispatch_decision;
    }
    const effectiveRuntime = identity?.runtime || runtime;
    const resumeCommand = resumeCommandForRuntime(effectiveRuntime, sessionId);
    let invoke;
    try {
      invoke = await _routeDeps.resumeAgentSession({
        sessionId,
        runtime: effectiveRuntime,
        cwd: resumeCwd,
        inboundRow: row,
        scope,
      });
    } catch (err) {
      invoke = {
        ok: false,
        error: "resume_start_threw",
        hint: err?.message || String(err),
      };
    }
    const detail = resumeInvokeDetail(invoke, {
      session_id: sessionId,
      resume_command: resumeCommand,
      runtime: effectiveRuntime,
      ...originDispatchDetail,
    });
    if (!invoke?.ok) {
      return recordResumeStartFailed(scope, messageId, detail);
    }
    recordDecision(scope, messageId, "resumed_pid_dead", detail);
    appendActivityEvent({
      type: "comms_dispatcher_decision",
      level: "info",
      scope_id: scope.scope_id ?? null,
      cwd: scope.cwd ?? null,
      data: {
        message_id: messageId,
        decision: "resumed_pid_dead",
        session_id: sessionId,
        invoke_ok: true,
        resume_id: detail.resume_id,
        pid: detail.pid,
        invoke_error: null,
        ...originDispatchDetail,
      },
    });
    return "resumed_pid_dead";
  } finally {
    const outcome =
      getTransportState(scope, messageId)?.dispatch_decision ||
      "dispatch_error";
    const released = releaseTldrAgentInbound({
      scope,
      messageId,
      token: dispatchClaim.token,
      outcome,
    });
    if (!released.ok) {
      appendActivityEvent({
        type: "tldr_agent_dispatch_claim_release_failed",
        level: "error",
        scope_id: scope.scope_id ?? null,
        cwd: scope.cwd ?? null,
        data: { message_id: messageId, outcome },
      });
    }
  }
}

// tickDispatcher — invoked once per daemon tick per scope. Selects pending
// inbound rows, dispatches each in sequence. Returns a small summary the
// daemon can log.
export async function tickDispatcher({ scope, runtime = "claude" } = {}) {
  if (!scope) return { ok: false, error: "scope required" };
  const pending = selectPendingInboundRows(scope);
  if (pending.length === 0) {
    return {
      ok: true,
      scope_id: scope.scope_id,
      decisions: [],
      pending_count: 0,
    };
  }
  const decisions = [];
  for (const entry of pending) {
    try {
      // Decisions are processed sequentially so terminal state writes stay ordered.
      // eslint-disable-next-line no-await-in-loop
      const decision = await dispatchOne(scope, entry, runtime);
      decisions.push({ message_id: entry.row.message_id, decision });
    } catch (err) {
      appendActivityEvent({
        type: "comms_dispatcher_tick_error",
        level: "error",
        scope_id: scope.scope_id ?? null,
        cwd: scope.cwd ?? null,
        error: err.message,
        data: { message_id: entry.row.message_id },
      });
      decisions.push({
        message_id: entry.row.message_id,
        decision: "error",
        error: err.message,
      });
    }
  }
  return {
    ok: true,
    scope_id: scope.scope_id,
    decisions,
    pending_count: pending.length,
  };
}

export const _internals = {
  TERMINAL_DECISIONS,
  RETRY_BACKOFF_DECISIONS,
  recordDecision,
  selectPendingInboundRows,
  resolveOriginSession,
  setRouteToWorkspaceDeps(overrides = {}) {
    if (overrides.resumeAgentSession)
      _routeDeps.resumeAgentSession = overrides.resumeAgentSession;
    if (overrides.waitForTachyonAck)
      _routeDeps.waitForTachyonAck = overrides.waitForTachyonAck;
  },
  resetRouteToWorkspaceDeps() {
    _routeDeps.resumeAgentSession = _defaultResumeAgentSession;
    _routeDeps.waitForTachyonAck = waitForTachyonAck;
  },
};
