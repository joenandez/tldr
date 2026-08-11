import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";
import { recordAriadnePendingOutbound } from "./ariadne_followup.mjs";
import { sessionDir } from "./identity_state.mjs";
import { readJsonIfExists } from "./store.mjs";

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function pendingPath(sessionId) {
  return join(sessionDir(sessionId), "ariadne-pending.json");
}

function readPending(sessionId) {
  const row = readJsonIfExists(pendingPath(sessionId), null);
  return {
    version: "1.0",
    session_id: String(sessionId || ""),
    threads:
      row?.threads &&
      typeof row.threads === "object" &&
      !Array.isArray(row.threads)
        ? row.threads
        : {},
    updated_at: row?.updated_at || null,
  };
}

function writePending(sessionId, row, at) {
  const path = pendingPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const next = {
    ...row,
    version: "1.0",
    session_id: String(sessionId),
    updated_at: nowIso(at),
  };
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return next;
}

function eventBase(type, data) {
  return { type, level: "warn", scope_id: null, cwd: null, data };
}

export function recordAriadneTldrAgentCandidateOutbound({
  sessionId,
  threadId,
  messageId,
  bodyPreview = "",
  sentAt = new Date(),
  emit = appendActivityEvent,
} = {}) {
  if (!sessionId || !threadId || !messageId) {
    return { recorded: false, reason: "missing_tldr_agent_candidate_fields" };
  }
  try {
    const prior = readPending(sessionId);
    const priorThread = prior.threads[String(threadId)] || null;
    const next = writePending(
      sessionId,
      {
        ...prior,
        threads: {
          ...prior.threads,
          [String(threadId)]: {
            latest_message_id: String(messageId),
            body_preview: String(bodyPreview || "").slice(0, 120),
            sent_at: nowIso(sentAt),
            tldr_agent_candidate: true,
            followup_required: priorThread?.followup_required === true,
            followup_required_at:
              priorThread?.followup_required === true
                ? priorThread.followup_required_at || nowIso(sentAt)
                : null,
            completion_observed_at: null,
          },
        },
      },
      sentAt,
    );
    return { recorded: true, path: pendingPath(sessionId), row: next };
  } catch {
    emit(
      eventBase("tldr_agent_ariadne_candidate_record_failed", {
        session_id: String(sessionId),
        thread_id: String(threadId),
        message_id: String(messageId),
        error: "candidate_state_unavailable",
      }),
    );
    return { recorded: false, reason: "tldr_agent_candidate_write_failed" };
  }
}

export function recordAriadneOutboundForDelivery({
  sessionId,
  row,
  tldrAgentReplyCandidate = false,
} = {}) {
  const record =
    row?.kind === "reply" && tldrAgentReplyCandidate === true
      ? recordAriadneTldrAgentCandidateOutbound
      : recordAriadnePendingOutbound;
  return record({
    sessionId,
    threadId: row?.thread_id,
    messageId: row?.message_id,
    bodyPreview: row?.body_preview,
    sentAt: row?.created_at,
  });
}

function successfulCoffeeReplyMessageId(hookInput) {
  if (hookInput?.tool_name !== "Bash") return null;
  const command = hookInput?.tool_input?.command;
  if (
    typeof command !== "string" ||
    !/(?:^|[\s/])tldr-agent(?:\.mjs)?\s+reply(?:\s|$)/.test(command)
  ) {
    return null;
  }
  const output = hookInput?.tool_response?.stdout;
  if (typeof output !== "string") return null;
  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch {
    return null;
  }
  return envelope?.ok === true &&
    envelope?.error === null &&
    envelope?.data?.status === "sent" &&
    typeof envelope?.data?.message_id === "string"
    ? envelope.data.message_id
    : null;
}

function latestCandidateEntry(threads) {
  return Object.entries(threads)
    .filter(([, row]) => row?.tldr_agent_candidate === true)
    .sort((left, right) => {
      const sent =
        Date.parse(left[1]?.sent_at || "") -
        Date.parse(right[1]?.sent_at || "");
      return Number.isNaN(sent) || sent === 0
        ? left[0].localeCompare(right[0])
        : sent;
    })
    .at(-1);
}

export function observeAriadneToolUse({
  sessionId,
  hookInput,
  at = new Date(),
} = {}) {
  const hookEvent = hookInput?.hook_event_name;
  if (
    !sessionId ||
    (hookEvent !== "PreToolUse" && hookEvent !== "PostToolUse")
  ) {
    return { changed: false, reason: "not_tool_use" };
  }
  const prior = readPending(sessionId);
  const completedMessageId =
    hookEvent === "PostToolUse"
      ? successfulCoffeeReplyMessageId(hookInput)
      : null;
  const matched = Object.entries(prior.threads).find(
    ([, row]) =>
      row?.tldr_agent_candidate === true &&
      completedMessageId === row.latest_message_id,
  );
  const selected = matched || latestCandidateEntry(prior.threads);
  if (!selected) return { changed: false, reason: "no_tldr_agent_candidate" };
  const [threadId, candidate] = selected;
  const ownCompletion = Boolean(matched);
  if (hookEvent === "PostToolUse" && !ownCompletion) {
    return { changed: false, reason: "not_coffee_reply_completion" };
  }
  if (ownCompletion && candidate.completion_observed_at) {
    return { changed: false, reason: "completion_already_observed" };
  }
  if (!ownCompletion && !candidate.completion_observed_at) {
    return { changed: false, reason: "candidate_completion_unobserved" };
  }
  if (!ownCompletion && candidate.followup_required === true) {
    return { changed: false, reason: "followup_already_required" };
  }
  const observedAt = nowIso(at);
  const nextCandidate = ownCompletion
    ? {
        ...candidate,
        completion_observed_at: observedAt,
        followup_required: false,
        followup_required_at: null,
      }
    : {
        ...candidate,
        followup_required: true,
        followup_required_at: observedAt,
      };
  writePending(
    sessionId,
    {
      ...prior,
      threads: { ...prior.threads, [threadId]: nextCandidate },
    },
    at,
  );
  return {
    changed: true,
    action: ownCompletion ? "candidate_completed" : "followup_required",
    thread_id: threadId,
    message_id: candidate.latest_message_id,
  };
}
