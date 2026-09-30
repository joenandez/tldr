import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  AEGIS_INBOUND_TIMEOUT_MS,
  requestAegisInbound,
  requestAegisOutbound,
} from "../aegis_client.mjs";
import { deadLetterInbound } from "./email/inbound_dead_letter.mjs";
import {
  createInboxListRetry,
  inboxListFailureCause,
  logInboxMessageReadFailure,
} from "./email/inbox_list_failure.mjs";
import { appendActivityEvent } from "../tldr_agent_diagnostics.mjs";
import { selectInboundEmailBody } from "./email/inbound_body.mjs";
import { renderTldrAgentEmail } from "./email/templates.mjs";
import { statePanelForRow } from "./email/render/panel.mjs";
import {
  authorizeInboundEnvelope,
  readTldrAgentPollConfig,
} from "#tldr-agent-email-overrides";
import { getHelmHome } from "../helm_home.mjs";

const BROKER_AUTHORIZED = Symbol("aegis-broker-authorized-owner");
const BROKER_OUTBOUND = Symbol("aegis-broker-outbound-request");
const POLL_BACK_WINDOW_MS = 30 * 60 * 1000;
export {
  BROKER_AUTHORIZED as _BROKER_AUTHORIZED_CONTEXT,
  BROKER_OUTBOUND as _BROKER_OUTBOUND_REQUEST_CONTEXT,
};
export { inboundDeadLetterPath } from "./email/inbound_dead_letter.mjs";
export { inboxListFailureCause } from "./email/inbox_list_failure.mjs";
export const POLL_SEEN_IDS_CAP = 500;
export const RECONCILE_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function failed() {
  return Object.assign(new Error("Email not sent"), {
    code: "transport_send_failed",
    hint: "Retry explicitly after confirming tldr; setup is ready.",
  });
}
function attachments(payload) {
  return Array.isArray(payload?.attachments)
    ? payload.attachments.length
    : Number(payload?.attachmentCount ?? payload?.attachment_count) || 0;
}
function timeout(promise, timeoutMs, code) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error(code), { code })),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
function event(type, scope, data, level = "info") {
  appendActivityEvent({
    type,
    level,
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data,
  });
}
export function extractAddress(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/<([^>]+)>/);
  const result = (match ? match[1] : value).trim().toLowerCase();
  return result.includes("@") ? result : null;
}
export function isOwnInbox(address, inbox) {
  const normalize = (value) => {
    const email = extractAddress(value);
    if (!email) return null;
    const [local, domain] = email.split("@");
    return `${local.split("+")[0]}@${domain}`;
  };
  return Boolean(normalize(address) && normalize(address) === normalize(inbox));
}
export function computePollWindow({
  lastSeenTimestamp,
  lastPolledAt = null,
  nowMs = Date.now(),
  backWindowMs = POLL_BACK_WINDOW_MS,
  reconcileMaxWindowMs = RECONCILE_MAX_WINDOW_MS,
} = {}) {
  let from = nowMs - backWindowMs;
  for (const value of [lastSeenTimestamp, lastPolledAt]) {
    const parsed = Date.parse(value || "");
    if (!Number.isNaN(parsed)) from = Math.min(from, parsed);
  }
  return new Date(Math.max(from, nowMs - reconcileMaxWindowMs)).toISOString();
}
export function appendAndBoundSeenIds(prior, values, cap = POLL_SEEN_IDS_CAP) {
  const seen = new Set(prior || []);
  const result = [...(prior || [])];
  for (const value of values || [])
    if (typeof value === "string" && value && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  return result.slice(-cap);
}
export function filterFreshInbounds({ messages, inboxEmail, seenIds }) {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  const fresh = [];
  let dedupSkipped = 0;
  let ownSkipped = 0;
  for (const message of messages || []) {
    const from =
      typeof message?.from === "string"
        ? message.from
        : message?.from?.address || message?.from?.email;
    if (isOwnInbox(from, inboxEmail)) {
      ownSkipped += 1;
    } else if (seen.has(message.messageId)) {
      dedupSkipped += 1;
    } else fresh.push(message);
  }
  return { fresh, dedupSkipped, ownSkipped };
}
export function parseInboundIntent() {
  return { intent: "reply" };
}
export function renderOutboundEnvelope(row) {
  const { statePanel, agent } = statePanelForRow(row);
  return renderTldrAgentEmail({
    state: row?.metadata?.tldr_agent_email_state || "conversation",
    subject: row?.subject || null,
    body: row?.body || "",
    replyInstruction: row?.metadata?.reply_instruction,
    securityNotice: row?.metadata?.security_notice,
    statePanel,
    agent,
  });
}
async function attachmentNotice({ state, messageId, threadId, invoke }) {
  if (!messageId || !threadId) throw failed();
  const envelope = renderTldrAgentEmail({ state });
  return invoke({
    operation: "reply_owner_thread",
    body: envelope.text,
    html: envelope.html,
    idempotencyKey: `tldr-agent-${state}-${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`,
    parentMessageId: messageId,
    threadId,
  });
}
export const emailTransport = {
  async send(row, context = {}) {
    const scope = context.scope || null;
    const envelope = renderOutboundEnvelope(row);
    const invoke = context.requestAegisOutbound || requestAegisOutbound;
    event("transport_email_send_attempt", scope, {
      transport: "email",
      message_id: row.message_id,
      thread_id: row.thread_id,
    });
    try {
      const result =
        row.kind === "reply"
          ? await (() => {
              const parent = context.tightbeamProviderParent;
              if (!parent?.external_id || !parent.external_thread_id)
                throw failed();
              return invoke({
                operation: "reply_owner_thread",
                body: envelope.text,
                html: envelope.html,
                idempotencyKey: row.idempotency_key,
                parentMessageId: parent.external_id,
                threadId: parent.external_thread_id,
              });
            })()
          : await invoke({
              operation: "send_owner_message",
              body: envelope.text,
              html: envelope.html,
              subject: envelope.subject || "(no subject)",
              idempotencyKey: row.idempotency_key,
            });
      if (!result?.messageId || !result?.threadId) throw failed();
      return {
        external_id: result.messageId,
        external_thread_id: result.threadId,
        deliveryState: "sent",
      };
    } catch (cause) {
      const error =
        cause?.code === "transport_send_failed"
          ? cause
          : Object.assign(failed(), {
              cause,
              ambiguous: cause?.ambiguous === true,
            });
      event(
        "transport_email_send_outcome",
        scope,
        { code: error.code },
        "error",
      );
      throw error;
    }
  },
  async inboundWebhook(payload, context = {}) {
    if (!payload || typeof payload !== "object") throw failed();
    const envelope = authorizeInboundEnvelope({
      eventType:
        payload.event || payload.event_type || payload.eventType || null,
      headers: payload.headers || null,
    });
    if (!envelope.ok)
      return { ok: false, rejected: true, reason: envelope.reason };
    if (context[BROKER_AUTHORIZED] !== true)
      return {
        ok: false,
        rejected: true,
        reason: "broker_authorization_required",
      };
    const messageId = payload.messageId;
    const threadId = payload.threadId;
    const body = selectInboundEmailBody(payload).latestReplyBody;
    const usable = typeof body === "string" && body.trim().length > 0;
    const count = attachments(payload);
    let notice = null;
    if (count && messageId && threadId) {
      notice = await attachmentNotice({
        state: usable ? "attachment_ignored" : "attachment_only",
        messageId,
        threadId,
        invoke: context[BROKER_OUTBOUND] || requestAegisOutbound,
      });
      if (!usable)
        return {
          canonicalRow: null,
          dispatchResult: null,
          attachment_only: true,
          attachment_count: count,
          attachment_notice: {
            external_id: notice.messageId,
            external_thread_id: notice.threadId,
          },
        };
    }
    if (!context.tightbeamInbound)
      return {
        canonicalRow: null,
        dispatchResult: null,
        recovery_required: true,
        reason: "tightbeam_bridge_required",
      };
    if (!messageId || !threadId || !usable)
      return {
        canonicalRow: null,
        dispatchResult: null,
        recovery_required: true,
        reason: "inbound_payload_incomplete",
      };
    const binding = await context.tightbeamInbound.findThreadBinding(threadId);
    if (!binding)
      return {
        canonicalRow: null,
        dispatchResult: null,
        recovery_required: true,
        reason: "thread_recovery_required",
      };
    const published = await context.tightbeamInbound.publishInboundEmail({
      binding,
      provider_message_id: messageId,
      provider_thread_id: threadId,
      body,
    });
    return published?.ok === true
      ? {
          canonicalRow: null,
          dispatchResult: null,
          tightbeam_message_id: published.message_id,
        }
      : {
          canonicalRow: null,
          dispatchResult: null,
          recovery_required: true,
          reason: published?.code || "tightbeam_publish_failed",
        };
  },
};
export function inboxPollStatePath() {
  return (
    process.env.HELM_EMAIL_POLL_STATE_PATH ||
    join(getHelmHome(), "email", "poll-state.json")
  );
}
export function readInboxPollState({ inboxId } = {}) {
  let all = {};
  try {
    if (existsSync(inboxPollStatePath()))
      all = JSON.parse(readFileSync(inboxPollStatePath(), "utf8"));
  } catch {}
  return inboxId ? all[inboxId] || {} : all;
}
export function writeInboxPollState({
  inboxId,
  lastSeenTimestamp,
  seenMessageIds,
  lastPolledAt,
  continuationPageToken,
  continuationAfter,
  recoveryAttempts,
}) {
  const path = inboxPollStatePath();
  const all = readInboxPollState();
  const entry = { seenMessageIds };
  if (lastSeenTimestamp) entry.lastSeenTimestamp = lastSeenTimestamp;
  if (lastPolledAt) entry.lastPolledAt = lastPolledAt;
  if (continuationPageToken)
    entry.continuationPageToken = continuationPageToken;
  if (continuationAfter) entry.continuationAfter = continuationAfter;
  if (recoveryAttempts && Object.keys(recoveryAttempts).length)
    entry.recoveryAttempts = recoveryAttempts;
  all[inboxId] = entry;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, JSON.stringify(all));
  renameSync(temp, path);
  return { path };
}
// The native inbound bridge launches the Aegis app, reads the keychain, and
// calls AgentMail (~0.75 s at moderate load). The client's old 2 s default
// failed about half of the live failed ticks under heavy load. Every inbox
// read (list and message) gets the client's full inbound budget (item 14).
export const AEGIS_INBOUND_POLL_TIMEOUT_MS = AEGIS_INBOUND_TIMEOUT_MS;

export async function pollInbox({
  scope = null,
  dispatch = true,
  exec = null,
  nowMs = Date.now(),
  configOverride = null,
  timeoutMs = 15000,
  tightbeamInbound = null,
  deadlineMs = null,
} = {}) {
  const config = configOverride || readTldrAgentPollConfig();
  if (
    !config?.inbox_id ||
    !config?.inbox_email ||
    Object.hasOwn(config, "api_key")
  )
    return {
      ok: false,
      error: "agentmail_unreachable",
      fetched: 0,
      written: 0,
      skipped_duplicates: 0,
      errors: [],
    };
  const state = readInboxPollState({ inboxId: config.inbox_id });
  const calculatedAfter = computePollWindow({
    lastSeenTimestamp: state.lastSeenTimestamp,
    lastPolledAt: state.lastPolledAt,
    nowMs,
  });
  const after = state.continuationPageToken
    ? state.continuationAfter || calculatedAfter
    : calculatedAfter;
  const broker = exec?.requestAegisInbound || requestAegisInbound;
  const messages = [];
  const rejectedMessageIds = [];
  let cursor = state.continuationPageToken || null;
  let pagesFetched = 0;
  let continuation = false;
  const list = createInboxListRetry({
    deadlineMs,
    budgetMs: timeoutMs,
    brokerTimeoutMs: AEGIS_INBOUND_POLL_TIMEOUT_MS,
    scope,
    now: exec?.now,
  });
  try {
    do {
      // Pages must remain ordered so a failed page cannot advance the cursor.
      // eslint-disable-next-line no-await-in-loop
      const listed = await list.readPage(({ brokerTimeoutMs, raceTimeoutMs }) =>
        timeout(
          broker({
            operation: "poll_bound_inbox",
            after,
            cursor,
            limit: 25,
            timeoutMs: brokerTimeoutMs,
          }),
          raceTimeoutMs,
          "inbox_poll_timeout",
        ),
      );
      if (!Array.isArray(listed?.messages))
        throw new Error("inbox_list_failed");
      messages.push(...listed.messages);
      if (Array.isArray(listed.rejectedMessageIds))
        rejectedMessageIds.push(...listed.rejectedMessageIds);
      cursor =
        typeof listed.nextCursor === "string" && listed.nextCursor
          ? listed.nextCursor
          : null;
      pagesFetched += 1;
      continuation = Boolean(cursor);
    } while (cursor && pagesFetched < 10 && messages.length < 250);
  } catch (error) {
    const reason =
      error?.code === "inbox_poll_timeout" ? error.code : "inbox_list_failed";
    return {
      ok: false,
      error: reason,
      ...inboxListFailureCause(error),
      list_retries: list.retries(),
      after,
      fetched: messages.length,
      written: 0,
      skipped_duplicates: 0,
      errors: [{ stage: "listMessages", error: reason }],
    };
  }
  const { fresh, dedupSkipped, ownSkipped } = filterFreshInbounds({
    messages,
    inboxEmail: config.inbox_email,
    seenIds: state.seenMessageIds || [],
  });
  const processed = [...new Set(rejectedMessageIds)];
  const errors = [];
  let unauthorizedSkipped = 0;
  const recoveryAttempts =
    state.recoveryAttempts && typeof state.recoveryAttempts === "object"
      ? { ...state.recoveryAttempts }
      : {};
  let recoveryCursorFloor = null;
  const markForRecovery = (message, reason) => {
    const previous = recoveryAttempts[message.messageId];
    const attempts = Math.max(0, Number(previous?.attempts) || 0) + 1;
    if (attempts >= 3) {
      deadLetterInbound({
        payload: { messageId: message.messageId, threadId: message.threadId },
        reason: `${reason}_exhausted`,
        startedAt: nowMs,
      });
      delete recoveryAttempts[message.messageId];
      processed.push(message.messageId);
      errors.push({
        stage: "inboundWebhook",
        messageId: message.messageId,
        error: `${reason}_exhausted`,
      });
      return;
    }
    recoveryAttempts[message.messageId] = {
      attempts,
      firstSeenAt: previous?.firstSeenAt || new Date(nowMs).toISOString(),
      timestamp: message.timestamp || null,
      reason,
    };
    const timestampMs = Date.parse(message.timestamp || "");
    const floor = Number.isNaN(timestampMs)
      ? after
      : new Date(timestampMs - 1).toISOString();
    if (!recoveryCursorFloor || floor < recoveryCursorFloor)
      recoveryCursorFloor = floor;
    errors.push({
      stage: "inboundWebhook",
      messageId: message.messageId,
      error: reason,
    });
  };
  for (const summary of fresh) {
    if (!dispatch) continue;
    if (summary.senderAuthorized !== true) {
      unauthorizedSkipped += 1;
      processed.push(summary.messageId);
      continue;
    }
    try {
      // Seen IDs are committed only after each broker read has settled.
      const readStartedAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const response = await timeout(
        broker({
          operation: "get_bound_message",
          messageId: summary.messageId,
          timeoutMs: AEGIS_INBOUND_POLL_TIMEOUT_MS,
        }),
        timeoutMs,
        "inbox_poll_timeout",
      ).catch((error) => {
        logInboxMessageReadFailure(scope, error, Date.now() - readStartedAt);
        throw error;
      });
      const full = response?.messages?.[0];
      if (!full || full.senderAuthorized !== true) {
        unauthorizedSkipped += 1;
        processed.push(summary.messageId);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const inbound = await emailTransport.inboundWebhook(
        {
          messageId: full.messageId || summary.messageId,
          threadId: full.threadId || summary.threadId,
          text: full.text || full.body || full.preview || "",
          body: full.body || full.text || full.preview || "",
          extractedText: full.extractedText || full.extracted_text || null,
          extracted_text: full.extracted_text || full.extractedText || null,
          attachmentCount: attachments(full),
          timestamp: full.timestamp || summary.timestamp || null,
          headers: full.headers || null,
          eventType: full.event || full.event_type || full.eventType || null,
        },
        {
          scope,
          [BROKER_AUTHORIZED]: true,
          [BROKER_OUTBOUND]: exec?.requestAegisOutbound || requestAegisOutbound,
          tightbeamInbound,
        },
      );
      if (inbound?.recovery_required) {
        markForRecovery(summary, inbound.reason || "thread_recovery_required");
      } else processed.push(summary.messageId);
    } catch {
      markForRecovery(summary, "inbound_capture_failed");
    }
  }
  let latest = messages.reduce(
    (value, message) =>
      message.timestamp && (!value || message.timestamp > value)
        ? message.timestamp
        : value,
    state.lastSeenTimestamp || null,
  );
  if (recoveryCursorFloor && (!latest || recoveryCursorFloor < latest))
    latest = recoveryCursorFloor;
  if (dispatch)
    writeInboxPollState({
      inboxId: config.inbox_id,
      lastSeenTimestamp: latest,
      seenMessageIds: appendAndBoundSeenIds(
        state.seenMessageIds || [],
        processed,
      ),
      lastPolledAt: new Date(nowMs).toISOString(),
      continuationPageToken: continuation ? cursor : null,
      continuationAfter: continuation ? after : null,
      recoveryAttempts,
    });
  return {
    ok: true,
    after,
    fetched: messages.length,
    pages_fetched: pagesFetched,
    list_retries: list.retries(),
    messages_seen: messages.length,
    continuation,
    fresh: fresh.length,
    written: 0,
    skipped_duplicates: dedupSkipped,
    own_skipped: ownSkipped,
    unauthorized_skipped: unauthorizedSkipped,
    last_seen_timestamp: latest,
    last_polled_at: dispatch
      ? new Date(nowMs).toISOString()
      : state.lastPolledAt || null,
    errors,
    dispatch,
    dispatch_results: [],
  };
}
