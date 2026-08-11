// Bounded same-thread reply monitor backed by each canonical inbound message.

import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import {
  getTransportState,
  listMessagesForThread as defaultListMessagesForThread,
  loadTransportStateEntries,
} from "./substrate/canonical_store.mjs";
import { resumeAgentSession as defaultResumeAgentSession } from "./substrate/resume_session.mjs";
import {
  reconcileAmbiguousRecoveryResume,
  replyObligationResultSummary,
  startRecoveryResume,
} from "./reply_obligation_resume.mjs";
import { classifySessionOwnerState } from "./session_owner_state.mjs";
import {
  tryTachyonLiveDelivery,
  waitForTachyonAck as defaultWaitForTachyonAck,
} from "./tachyon_dispatcher.mjs";
import { findTldrAgentSatisfyingReply } from "./tldr_agent_reply_satisfaction.mjs";
import { hasReadInboxMessage } from "./substrate/blocked_unread.mjs";
import { mutateTldrAgentInbound } from "./tldr_agent_inbound_lifecycle.mjs";

const DEFAULT_REPLY_DUE_MS = 2 * 60 * 1000;
const DEFAULT_ACK_HARD_DUE_MS = 5 * 60 * 1000;
const DEFAULT_TICK_LIMIT = 20;
const REPLY_OBLIGATION_VERSION = "2.0";

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function addMs(value, ms) {
  return new Date(new Date(value).getTime() + ms).toISOString();
}

function ackSoftDueAt(obligation) {
  return obligation.ack_soft_due_at || obligation.reply_due_at || null;
}

function ackHardDueAt(obligation) {
  if (obligation.ack_hard_due_at) return obligation.ack_hard_due_at;
  const base = obligation.created_at || obligation.inbound_created_at || null;
  const baseMs = Date.parse(base || "");
  if (!Number.isNaN(baseMs)) {
    return new Date(baseMs + DEFAULT_ACK_HARD_DUE_MS).toISOString();
  }
  return obligation.reply_due_at || null;
}

function eventBase(scope, type, level, data) {
  return {
    type,
    level,
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data,
  };
}

function persistObligation(scope, obligation, now = new Date()) {
  return mutateTldrAgentInbound({
    scope,
    messageId: obligation.message_id,
    now,
    mutate(prior) {
      return {
        state:
          obligation.state === "satisfied"
            ? "satisfied"
            : prior.presentation
              ? "reply_pending"
              : prior.state,
        reply: { ...obligation },
      };
    },
  });
}

export function readReplyObligations(scope) {
  const obligations = {};
  for (const [messageId, transportState] of Object.entries(
    loadTransportStateEntries(scope),
  )) {
    const obligation = transportState?.tldr_agent_inbound?.reply;
    if (!obligation) continue;
    obligations[messageId] = obligation;
  }
  return {
    version: REPLY_OBLIGATION_VERSION,
    obligations,
    reconciliation: {},
  };
}

export function createReplyObligation({
  scope,
  inboundRow,
  ownerSessionId,
  now = new Date(),
  dueMs = DEFAULT_REPLY_DUE_MS,
  ackSoftDueMs = dueMs,
  ackHardDueMs = DEFAULT_ACK_HARD_DUE_MS,
  emit = appendActivityEvent,
} = {}) {
  if (!scope) return { ok: false, error: "scope required" };
  if (!inboundRow?.message_id) {
    return { ok: false, error: "message_id required" };
  }
  if (!inboundRow?.thread_id) return { ok: false, error: "thread_id required" };
  if (!ownerSessionId) return { ok: false, error: "owner_session_id required" };
  const prior = getTransportState(scope, inboundRow.message_id)
    ?.tldr_agent_inbound?.reply;
  if (prior) return { ok: true, created: false, obligation: prior };

  const createdAt = iso(now);
  const inboundCreatedAt = iso(
    inboundRow.created_at || inboundRow.scheduled_for || createdAt,
  );
  const obligation = {
    message_id: inboundRow.message_id,
    thread_id: inboundRow.thread_id,
    owner_session_id: ownerSessionId,
    scope_id: scope.scope_id ?? null,
    created_at: createdAt,
    inbound_created_at: inboundCreatedAt,
    reply_due_at: addMs(createdAt, dueMs),
    ack_soft_due_at: addMs(createdAt, ackSoftDueMs),
    ack_hard_due_at: addMs(createdAt, ackHardDueMs),
    ack_state: "pending",
    acked_at: null,
    acked_by_message_id: null,
    ack_soft_missed_at: null,
    ack_hard_missed_at: null,
    state: "pending",
    resume_attempt_count: 0,
    resume_attempt_state: null,
    resume_attempt_claimed_at: null,
    resume_attempt_completed_at: null,
    last_resume_schedule_id: null,
    last_checked_at: null,
    last_resume_error: null,
    satisfied_by_message_id: null,
    durable_satisfaction_state: "pending",
    durable_satisfied_at: null,
    transport_delivery_state: null,
    transport_confirmed_at: null,
    operator_visible_state: "unknown",
    operator_visible_at: null,
  };
  const persisted = persistObligation(scope, obligation, now);
  if (persisted?.reply?.message_id !== obligation.message_id) {
    return { ok: false, error: "reply_obligation_persist_failed" };
  }
  emit(
    eventBase(scope, "reply_obligation_created", "info", {
      message_id: obligation.message_id,
      thread_id: obligation.thread_id,
      owner_session_id: obligation.owner_session_id,
      reply_due_at: obligation.reply_due_at,
    }),
  );
  return { ok: true, created: true, obligation };
}

function timestampAfter(candidate, boundary) {
  const candidateMs = Date.parse(candidate || "");
  const boundaryMs = Date.parse(boundary || "");
  return (
    !Number.isNaN(candidateMs) &&
    !Number.isNaN(boundaryMs) &&
    candidateMs > boundaryMs
  );
}

function defaultIsOwnerAlive(sessionId) {
  return classifySessionOwnerState({ sessionId }).alive;
}

function activeObligations(obligations, limit) {
  return Object.values(obligations)
    .filter(
      (obligation) =>
        obligation?.state !== "satisfied" &&
        obligation?.state !== "abandoned" &&
        obligation?.state !== "failed_no_ack",
    )
    .sort((left, right) =>
      String(ackSoftDueAt(left) || left.message_id).localeCompare(
        String(ackSoftDueAt(right) || right.message_id),
      ),
    )
    .slice(0, Math.max(0, Math.floor(Number(limit) || 0)));
}

function markAckHardMissed(obligation, now) {
  obligation.ack_state = "hard_missed";
  obligation.ack_hard_missed_at ||= iso(now);
}

function markFailedNoAck({
  scope,
  obligation,
  now,
  emit,
  result,
  eventType,
  persist,
}) {
  markAckHardMissed(obligation, now);
  obligation.state = "failed_no_ack";
  const counter =
    eventType === "reply_obligation_ack_hard_missed_alive_unknown_owner"
      ? "ack_hard_missed_alive_unknown_owner"
      : "ack_hard_missed_alive_owner";
  result[counter] += 1;
  persist();
  emit(
    eventBase(scope, eventType, "error", {
      message_id: obligation.message_id,
      thread_id: obligation.thread_id,
      owner_session_id: obligation.owner_session_id,
      ack_soft_due_at: ackSoftDueAt(obligation),
      ack_hard_due_at: ackHardDueAt(obligation),
    }),
  );
}

function satisfyObligation({
  scope,
  obligation,
  satisfyingReply,
  now,
  result,
  persist,
  emit,
}) {
  const { row: reply, transportState } = satisfyingReply;
  const satisfiedAt = iso(now);
  const late = timestampAfter(satisfiedAt, ackSoftDueAt(obligation));
  if (late && !obligation.ack_soft_missed_at) {
    obligation.ack_soft_missed_at = satisfiedAt;
    result.ack_soft_missed += 1;
  }
  if (timestampAfter(satisfiedAt, ackHardDueAt(obligation))) {
    markAckHardMissed(obligation, now);
  }
  obligation.state = "satisfied";
  obligation.ack_state = late ? "acked_late" : "acked";
  obligation.acked_at = satisfiedAt;
  obligation.acked_by_message_id = reply.message_id;
  obligation.satisfied_by_message_id = reply.message_id;
  obligation.durable_satisfaction_state = "satisfied";
  obligation.durable_satisfied_at = satisfiedAt;
  obligation.transport_delivery_state = transportState.delivery_state || null;
  obligation.transport_confirmed_at = transportState.last_attempt_at || null;
  result[late ? "late_satisfied" : "satisfied"] += 1;
  persist();
  emit(
    eventBase(
      scope,
      late ? "reply_obligation_late_satisfied" : "reply_obligation_satisfied",
      late ? "warn" : "info",
      {
        message_id: obligation.message_id,
        thread_id: obligation.thread_id,
        owner_session_id: obligation.owner_session_id,
        satisfied_by_message_id: reply.message_id,
        durable_satisfied_at: satisfiedAt,
        transport_delivery_state: obligation.transport_delivery_state,
      },
    ),
  );
}

export async function tickReplyObligations({
  scope,
  now = new Date(),
  limit = DEFAULT_TICK_LIMIT,
  listMessagesForThread = defaultListMessagesForThread,
  getTransportStateForMessage = getTransportState,
  isInboundRead = hasReadInboxMessage,
  isOwnerAlive = defaultIsOwnerAlive,
  classifyOwnerState = classifySessionOwnerState,
  resumeAgentSession = defaultResumeAgentSession,
  findExistingResume,
  waitForTachyonAck = defaultWaitForTachyonAck,
  emit = appendActivityEvent,
} = {}) {
  if (!scope) return { ok: false, error: "scope required" };
  const selected = activeObligations(
    readReplyObligations(scope).obligations,
    limit,
  );
  const result = replyObligationResultSummary(scope, selected.length);
  let storeWrites = 0;

  for (const obligation of selected) {
    const persist = () => {
      persistObligation(scope, obligation, now);
      storeWrites += 1;
    };
    const satisfyingReply = findTldrAgentSatisfyingReply({
      obligation,
      listMessagesForThread,
      getTransportStateForMessage,
      isInboundRead,
      scope,
    });
    if (satisfyingReply) {
      satisfyObligation({
        scope,
        obligation,
        satisfyingReply,
        now,
        result,
        persist,
        emit,
      });
      continue;
    }

    const nowMs = now.getTime();
    const softDueMs = Date.parse(ackSoftDueAt(obligation) || "");
    const hardDueMs = Date.parse(ackHardDueAt(obligation) || "");
    const softDue = !Number.isNaN(softDueMs) && softDueMs <= nowMs;
    const hardDue = !Number.isNaN(hardDueMs) && hardDueMs <= nowMs;
    result[hardDue ? "due_checked" : "pending_checked"] += 1;

    if (softDue && !obligation.ack_soft_missed_at) {
      obligation.ack_state = "soft_missed";
      obligation.ack_soft_missed_at = iso(now);
      result.ack_soft_missed += 1;
      persist();
      emit(
        eventBase(scope, "reply_obligation_ack_soft_missed", "warn", {
          message_id: obligation.message_id,
          thread_id: obligation.thread_id,
          owner_session_id: obligation.owner_session_id,
          ack_soft_due_at: ackSoftDueAt(obligation),
          ack_hard_due_at: ackHardDueAt(obligation),
        }),
      );
    }

    let ownerState = classifyOwnerState({
      sessionId: obligation.owner_session_id,
      now: iso(now),
    });
    if (
      !hardDue &&
      ownerState.state === "alive_listening" &&
      (obligation.resume_attempt_count || 0) < 1
    ) {
      // eslint-disable-next-line no-await-in-loop -- canonical rows are advanced serially.
      const tachyon = await tryTachyonLiveDelivery({
        scope,
        sessionId: obligation.owner_session_id,
        messageId: obligation.message_id,
        pidAlive: true,
        liveSessionEligible: true,
        sessionState: ownerState.stateRow,
        waitForAck: waitForTachyonAck,
        recordDecision: () => {},
      });
      if (tachyon.handled) {
        result.alive_listening_owner_acked += 1;
        emit(
          eventBase(
            scope,
            "reply_obligation_overdue_alive_listener_acked",
            "info",
            {
              message_id: obligation.message_id,
              thread_id: obligation.thread_id,
              owner_session_id: obligation.owner_session_id,
              pid: ownerState.pid,
              live_pid_source: ownerState.source,
              listener_owner_id: ownerState.listener?.owner_id || null,
            },
          ),
        );
        continue;
      }
    }
    if (!hardDue) continue;

    markAckHardMissed(obligation, now);
    persist();
    ownerState = classifyOwnerState({
      sessionId: obligation.owner_session_id,
      now: iso(now),
    });
    const ownerAlive = isOwnerAlive(obligation.owner_session_id, obligation);
    const recovery = reconcileAmbiguousRecoveryResume({
      scope,
      obligation,
      ownerState,
      now,
      persist,
      findExistingResume,
    });
    if (recovery.action === "hold") continue;
    const { resumeAttemptCount, retryReleasedClaim } = recovery;
    if (resumeAttemptCount >= 1 && !retryReleasedClaim) {
      result.resume_failed_no_ack += 1;
      obligation.state = "failed_no_ack";
      persist();
      emit(
        eventBase(scope, "reply_obligation_resume_failed_no_ack", "error", {
          message_id: obligation.message_id,
          thread_id: obligation.thread_id,
          owner_session_id: obligation.owner_session_id,
          last_resume_id: obligation.last_resume_schedule_id || null,
        }),
      );
      continue;
    }
    if (ownerState.state === "alive_idle" && resumeAttemptCount < 2) {
      // eslint-disable-next-line no-await-in-loop -- bounded recovery is serial.
      await startRecoveryResume({
        scope,
        obligation,
        ownerState,
        resumeAgentSession,
        emit,
        result,
        counterName: "alive_idle_owner_resumes_started",
        eventType: "reply_obligation_overdue_alive_idle_resume_started",
        logPrefix: "[TEMP ALIVE_IDLE_REVIVE]",
        now,
        persist,
        replaceOwner: true,
      });
      continue;
    }
    if (ownerState.state === "alive_unknown") {
      markFailedNoAck({
        scope,
        obligation,
        now,
        emit,
        result,
        eventType: "reply_obligation_ack_hard_missed_alive_unknown_owner",
        persist,
      });
      continue;
    }
    if (ownerState.alive || ownerAlive) {
      markFailedNoAck({
        scope,
        obligation,
        now,
        emit,
        result,
        eventType: "reply_obligation_ack_hard_missed_alive_owner",
        persist,
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded recovery is serial.
    await startRecoveryResume({
      scope,
      obligation,
      ownerState,
      resumeAgentSession,
      emit,
      result,
      counterName: "dead_owner_resumes_started",
      eventType: "reply_obligation_overdue_dead_owner_resume_started",
      logPrefix: "[TEMP DEAD_OWNER_REVIVE]",
      now,
      persist,
    });
  }
  result.store_writes = storeWrites;
  return result;
}
