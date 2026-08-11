// Canonical email transport. AgentMail errors preserve their cause and all
// boundary logs exclude message bodies. Sends remain sequential per thread.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { requestAegisInbound, requestAegisOutbound } from "../aegis_client.mjs";
import { deadLetterInbound } from "./email/inbound_dead_letter.mjs";
import { registerTransport } from "../substrate/transport_interface.mjs";
import { appendActivityEvent } from "../tldr_agent_diagnostics.mjs";
import {
  appendMessageIdempotent,
  upsertThread,
  getThread,
  getMessage as getCanonicalMessage,
  findInboundMessageIdByExternalId,
  listMessagesForThread,
  loadTransportStateEntries,
  updateTransportState,
} from "../substrate/canonical_store.mjs";
import { publish, EVENT_KIND } from "../substrate/events.mjs";
import { selectInboundEmailBody } from "./email/inbound_body.mjs";
import { renderTldrAgentEmail } from "./email/templates.mjs";
import { statePanelForRow } from "./email/render/panel.mjs";
import {
  authorizeInboundEnvelope,
  authorizeInboundSender,
  getAegisBrokerTestOverrides,
  getMessage,
  getThread as agentMailGetThread,
  getVerifiedOwnerEmailOverride,
  isAgentMailConfigured,
  listMessages,
  readTldrAgentPollConfig,
  readVerifiedOwnerEmail,
  replyToMessage,
  resolveTldrAgentAgentMailConfig,
  sendEmail,
} from "#tldr-agent-email-overrides";
import { getHelmHome } from "../helm_home.mjs";
import { inProcessMemorySample } from "../resource_sampler.mjs";
import {
  assertOwningSessionForReply,
  lookupThreadOwnerSession,
  resolveWriterSessionId,
} from "../substrate/thread_ownership.mjs";

const HINT = Object.freeze({
  agentmail_unreachable:
    "Verify ~/.helm/email/config.json exists with api_key + inbox_id + inbox_email, then retry. Run `helm-tasks onboard --reconfigure agentmail` to (re)provision the credential.",
  transport_send_failed:
    "Inspect transport_state.error for the underlying AgentMail SDK exception and retry within --max-attempts.",
});
const TRUSTED_OWNER_CONTEXT = Symbol("tldr-agent-verified-owner");
const BROKER_AUTHORIZED_CONTEXT = Symbol("aegis-broker-authorized-owner");
const BROKER_OUTBOUND_REQUEST_CONTEXT = Symbol("aegis-broker-outbound-request");

function normalizeOwnerEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function fingerprintOwnerEmail(value) {
  return createHash("sha256")
    .update(`tldr-agent-owner-v1\0${normalizeOwnerEmail(value) ?? ""}`)
    .digest("hex");
}

async function resolveVerifiedOwnerEmail(expectedFingerprint = null) {
  const override = getVerifiedOwnerEmailOverride();
  if (override) {
    const owner = normalizeOwnerEmail(override);
    return expectedFingerprint &&
      fingerprintOwnerEmail(owner) !== expectedFingerprint
      ? null
      : owner;
  }
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) return null;
  try {
    const owner = normalizeOwnerEmail(await readVerifiedOwnerEmail());
    return owner && fingerprintOwnerEmail(owner) === expectedFingerprint
      ? owner
      : null;
  } catch {
    return null;
  }
}

function emailNotSent() {
  return makeError(
    "transport_send_failed",
    "Email not sent",
    "Retry explicitly after verifying tldr; messaging is ready.",
  );
}
function makeError(code, message, hint, cause = null) {
  const err = new Error(message);
  err.code = code;
  err.hint = hint || HINT[code] || null;
  if (cause) err.cause = cause;
  return err;
}

function bodyPreview(body) {
  if (typeof body !== "string" || body.length === 0) return null;
  return body.length > 120 ? `${body.slice(0, 117)}…` : body;
}

function timeoutError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function withTimeout(promise, timeoutMs, code = "operation_timeout") {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(timeoutError(code, `${code} after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function deltaMb(after, before, key) {
  const a = Number(after?.[key]);
  const b = Number(before?.[key]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) * 10) / 10;
}

function memoryGuardrail(rssDeltaMb) {
  if (!Number.isFinite(rssDeltaMb)) return null;
  if (rssDeltaMb >= 50) return "alert";
  if (rssDeltaMb >= 25) return "warn";
  return "ok";
}

function makeMessageId() {
  return `msg_${Date.now().toString(36)}_${randomBytes(8).toString("hex")}`;
}

function logAttempt(canonicalRow, scope) {
  appendActivityEvent({
    type: "transport_email_send_attempt",
    level: "info",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: {
      transport: "email",
      message_id: canonicalRow.message_id,
      thread_id: canonicalRow.thread_id,
      kind: canonicalRow.kind,
      scheduled_for: canonicalRow.scheduled_for,
    },
  });
}

function logOutcome({
  canonicalRow,
  scope,
  status,
  durationMs,
  error = null,
  externalId = null,
  externalThreadId = null,
}) {
  appendActivityEvent({
    type: "transport_email_send_outcome",
    level: status === "success" ? "info" : "error",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    status,
    duration_ms: durationMs,
    error: error ? error.message || String(error) : null,
    data: {
      transport: "email",
      message_id: canonicalRow.message_id,
      thread_id: canonicalRow.thread_id,
      external_id: externalId,
      external_thread_id: externalThreadId,
      code: error?.code || null,
    },
  });
}

function logInboundReceived(payload, scope) {
  appendActivityEvent({
    type: "transport_email_inbound_webhook_received",
    level: "info",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: {
      transport: "email",
      external_id: payload?.messageId || null,
      external_thread_id: payload?.threadId || null,
    },
  });
}

function logInboundNormalized({
  canonicalRow,
  scope,
  durationMs,
  status,
  error = null,
}) {
  appendActivityEvent({
    type: "transport_email_inbound_webhook_normalized",
    level: status === "success" ? "info" : "error",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    status,
    duration_ms: durationMs,
    error: error ? error.message || String(error) : null,
    data: {
      transport: "email",
      message_id: canonicalRow?.message_id || null,
      thread_id: canonicalRow?.thread_id || null,
    },
  });
}

export { inboundDeadLetterPath } from "./email/inbound_dead_letter.mjs";

function logInboundSenderRejected({ payload, scope, auth, entryPoint }) {
  appendActivityEvent({
    type: "transport_email_inbound_sender_rejected",
    level: "warn",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: {
      transport: "email",
      entry_point: entryPoint,
      reason: auth?.reason || "unknown",
      external_id: payload?.messageId || null,
      external_thread_id: payload?.threadId || null,
    },
  });
}

// Find the most recent prior canonical message on the thread (excluding the
// current row) that has a resolvable AgentMail message-id in transport_state.
// Used to thread email replies via the in-reply-to header (UX §8.3).
//
// Failed prior reply rows have no external_id (transport never accepted them);
// skip them and walk back to the most recent ancestor that *did* land. Without
// this, every failed reply attempt becomes a poison row that blocks future
// reply-parent resolution on the same thread — the user-visible symptom is
// `email reply on thread <tid> has no resolvable parent AgentMail message-id`
// even though the inbound that opened the thread is present and delivered.
function findParentExternalId(scope, threadId, currentMessageId) {
  if (!scope) return null;
  const candidates = listMessagesForThread(scope, threadId).filter(
    (row) => row.message_id !== currentMessageId,
  );
  candidates.sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
  // Opportunity #2: one transport-state parse, not one per candidate row.
  const transportEntries = loadTransportStateEntries(scope);
  for (const candidate of candidates) {
    const ts = transportEntries[candidate.message_id] || null;
    if (!ts || !ts.external_id) continue;
    return {
      external_id: ts.external_id,
      external_thread_id: ts.external_thread_id || null,
      parent_message_id: candidate.message_id,
    };
  }
  return null;
}

// PRFAQ-0-1.1 invariant — 1 email thread = 1 agent session.
//
// The substrate enforces this in kernel.message() before composeCanonicalRow:
// when a `reply` row on an email target comes from a session that does NOT
// own the target thread, the request is rejected. The implementation lives in
// src/lib/substrate/thread_ownership.mjs so the kernel can call it without
// pulling in the email-transport side-effect graph.
//
// Re-exports below let downstream callers (the legacy agent-email skill
// bridge, tests, the inbound-webhook routing layer) reach the same helpers
// through the transport surface they already import.
export {
  assertOwningSessionForReply,
  lookupThreadOwnerSession,
  resolveWriterSessionId,
};

// Test-only export. Mirrors findParentExternalId so unit tests can exercise
// the picker's failed-row skipping without standing up the full SDK mock.
export const _findParentExternalIdForTest = findParentExternalId;

// Scan the canonical store for any prior message whose transport_state has
// the given AgentMail thread-id. Returns the substrate thread_id or null.
// Used by inboundWebhook to resolve a synthetic AgentMail event to the
// substrate-side thread (so a reply lands on the same canonical thread).
function findSubstrateThreadByExternalThreadId(scope, externalThreadId) {
  if (!scope || !externalThreadId) return null;
  // Opportunity #2: one transport-state parse + indexed row reads.
  const transportEntries = loadTransportStateEntries(scope);
  for (const [messageId, ts] of Object.entries(transportEntries)) {
    if (ts?.external_thread_id !== externalThreadId) continue;
    const row = getCanonicalMessage(scope, messageId);
    if (row?.thread_id) return row.thread_id;
  }
  return null;
}

// GH#24 — idempotency lookup for inbound ingest. Scan the canonical store
// for an inbound row (metadata.source='inbound_webhook') whose
// transport_state.external_id matches this AgentMail message id. Returns the
// existing canonical row or null. Keyed on the external message_id so a
// single inbound produces at most one canonical row no matter how many poll
// cycles (or the webhook + poll, or reconcile) observe it.
function findInboundByExternalMessageId(scope, externalMessageId) {
  if (!scope || !externalMessageId) return null;
  // Opportunity #2: indexed reverse lookup, not O(messages × entries) rescans.
  const messageId = findInboundMessageIdByExternalId(scope, externalMessageId);
  return messageId ? getCanonicalMessage(scope, messageId) : null;
}

function resolveScopeForExternalThread({ fallbackScope, externalThreadId }) {
  void externalThreadId;
  return fallbackScope || null;
}

// COE-2 AI-2 — inbox poll watermark helpers (lockstep mirror of the legacy
// bridge cmdPoll's widen-window + dedup logic at
// ~/.agents/skills/agent-email/bin/agent-email.mjs). Pure functions so unit
// tests can assert behavior without spinning up an AgentMail SDK. The future
// substrate-native pollInbox surface (post burn-the-boats) consumes these.
//
// Watermark cursor (lastSeenTimestamp) remains the SDK-efficiency knob;
// per-messageId dedup is the once-only-delivery correctness layer. Widened
// 30-min back-window ensures late-arriving inbounds with timestamps < cursor
// are still fetched. Without these layers, a Joe reply landing in AgentMail
// after the cursor advanced would be silently missed forever — the exact
// Branch-C failure mode codified in COE-2026-05-12.
export const POLL_BACK_WINDOW_MS = 30 * 60 * 1000;
export const POLL_SEEN_IDS_CAP = 500;
const POLL_RECOVERY_ATTEMPT_LIMIT = 3;

// Opportunity #1: maximum startup-reconcile reach-back. A daemon outage
// longer than the 30-min back-window used to lose any inbound that aged
// past the cursor (COE-2026-05-12 Branch C class); the window now expands
// to cover the gap since the last successful poll, bounded by this cap.
export const RECONCILE_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Compute the AgentMail listMessages `after` parameter:
// min(cursor, now-30min, lastPolledAt), floored at now - RECONCILE_MAX_WINDOW_MS.
// Idempotent ingest dedups any re-reads the wider window causes.
export function computePollWindow({
  lastSeenTimestamp,
  lastPolledAt = null,
  nowMs = Date.now(),
  backWindowMs = POLL_BACK_WINDOW_MS,
  reconcileMaxWindowMs = RECONCILE_MAX_WINDOW_MS,
} = {}) {
  const windowBackMs = nowMs - backWindowMs;
  const lastMs = lastSeenTimestamp ? Date.parse(lastSeenTimestamp) : null;
  const lastPolledMs = lastPolledAt ? Date.parse(lastPolledAt) : null;
  let startMs = windowBackMs;
  if (lastMs && !Number.isNaN(lastMs)) startMs = Math.min(startMs, lastMs);
  if (lastPolledMs && !Number.isNaN(lastPolledMs)) {
    startMs = Math.min(startMs, lastPolledMs);
  }
  startMs = Math.max(startMs, nowMs - reconcileMaxWindowMs);
  return new Date(startMs).toISOString();
}

// Append newIds to priorIds without duplicates; FIFO-trim to cap so the
// persisted seen-set stays bounded. Insertion order preserved (oldest first,
// newest at end). Returns a new array.
export function appendAndBoundSeenIds(
  priorIds,
  newIds,
  cap = POLL_SEEN_IDS_CAP,
) {
  const set = new Set(Array.isArray(priorIds) ? priorIds : []);
  const out = Array.isArray(priorIds) ? [...priorIds] : [];
  for (const id of newIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (set.has(id)) continue;
    set.add(id);
    out.push(id);
  }
  if (out.length > cap) return out.slice(out.length - cap);
  return out;
}

// Filter a fetched message list down to fresh inbound messages: drop our own
// outbounds (from address matches inboxEmail) AND drop anything in seenIds.
// Returns { fresh, dedupSkipped, ownSkipped }.
export function filterFreshInbounds({ messages, inboxEmail, seenIds }) {
  const seenSet =
    seenIds instanceof Set
      ? seenIds
      : new Set(Array.isArray(seenIds) ? seenIds : []);
  const fresh = [];
  let dedupSkipped = 0;
  let ownSkipped = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (isOwnInbox(messageFromAddress(m), inboxEmail)) {
      ownSkipped += 1;
      continue;
    }
    if (seenSet.has(m.messageId)) {
      dedupSkipped += 1;
      continue;
    }
    fresh.push(m);
  }
  return { fresh, dedupSkipped, ownSkipped };
}

// COE-2 AI-4 — given a fully-fetched AgentMail thread (threads.get), filter
// its messages down to unseen inbound messages — same predicates as
// filterFreshInbounds, but the input is a thread object rather than a
// listMessages window. Used by the `reconcile --thread-id` path to force a
// ground-truth read on a known-important thread when the inbox-wide poll
// cursor or dedup set has missed an inbound (Branch B+C mitigation gap).
//
// Returns { unseen, alreadySeen, ownSkipped, messageCount }. The unseen list
// is in chronological order (oldest first) when AgentMail returns the thread
// that way; otherwise sorted by timestamp ascending so dispatch order is
// deterministic.
export function filterUnseenThreadInbounds({ thread, inboxEmail, seenIds }) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const seenSet =
    seenIds instanceof Set
      ? seenIds
      : new Set(Array.isArray(seenIds) ? seenIds : []);
  const sorted = [...messages].sort((a, b) => {
    const ta =
      a?.timestamp instanceof Date
        ? a.timestamp.getTime()
        : Date.parse(a?.timestamp || 0);
    const tb =
      b?.timestamp instanceof Date
        ? b.timestamp.getTime()
        : Date.parse(b?.timestamp || 0);
    return ta - tb;
  });
  const unseen = [];
  let alreadySeen = 0;
  let ownSkipped = 0;
  for (const m of sorted) {
    if (isOwnInbox(messageFromAddress(m), inboxEmail)) {
      ownSkipped += 1;
      continue;
    }
    if (seenSet.has(m.messageId)) {
      alreadySeen += 1;
      continue;
    }
    unseen.push(m);
  }
  return { unseen, alreadySeen, ownSkipped, messageCount: messages.length };
}

// COE-2 AI-7 — strip "Display Name <addr@x.com>" wrapping. Returns the raw
// address lowercased, or null when the input does not contain an address.
export function extractAddress(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/<([^>]+)>/);
  const candidate = (m ? m[1] : trimmed).trim();
  if (!candidate.includes("@")) return null;
  return candidate.toLowerCase();
}

function messageFromAddress(message) {
  const from = message?.from;
  if (typeof from === "string") return from;
  return from?.address || from?.email || from?.value || "";
}

// COE-2 AI-7 — true when `addr` resolves to the same mailbox as `inboxEmail`.
// Treats AgentMail subaddressing (foo+anything@inbox.tld → foo@inbox.tld) as
// the same mailbox so reply-self detection catches workspace/session aliases.
export function isOwnInbox(addr, inboxEmail) {
  const a = extractAddress(addr);
  const b = extractAddress(inboxEmail);
  if (!a || !b) return false;
  const stripPlus = (s) => {
    const [local, domain] = s.split("@");
    if (!local || !domain) return s;
    const bare = local.split("+")[0];
    return `${bare}@${domain}`;
  };
  return stripPlus(a) === stripPlus(b);
}

// COE-2 AI-7 — given the AgentMail source message and our own inbox, decide
// the recipient for a reply.
//   - If source.from is NOT our inbox → return null (use SDK default; replies
//     route back to source.from, the normal case).
//   - If source.from IS our inbox → walk source.to looking for the first
//     non-own address. That's the human we originally addressed; reply there.
//   - If no non-own address exists in source.to → throw `reply_to_self_unresolvable`
//     so the caller aborts loudly instead of chaining another dead reply.
export function resolveReplyRecipient({ source, inboxEmail }) {
  if (!source || typeof source !== "object") return null;
  if (!isOwnInbox(source.from, inboxEmail)) return null;
  const toList = normalizeToAddresses(source.to);
  for (const candidate of toList) {
    if (!isOwnInbox(candidate, inboxEmail)) {
      return extractAddress(candidate);
    }
  }
  const err = new Error(
    `reply-to-self detected: source.from (${extractAddress(source.from)}) is our inbox and source.to has no non-own recipient. Refusing to chain another reply that would route back to ourselves. Send a NEW message on a fresh thread to the intended human.`,
  );
  err.code = "reply_to_self_unresolvable";
  err.hint =
    "AgentMail thread chain landed on a self-addressed source message. Use sendEmail (new thread) with an explicit human recipient, or fix the cached parent message-id upstream.";
  throw err;
}

// Normalize the `payload.to` field across the three shapes AgentMail's
// webhook surfaces use: string ("a@b.c"), comma-separated string ("a@b.c, c@d.e"),
// or array of objects/strings ([{address: "..."}] or ["..."]).
function normalizeToAddresses(rawTo) {
  if (!rawTo) return [];
  if (typeof rawTo === "string") {
    return rawTo
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(rawTo)) {
    const out = [];
    for (const entry of rawTo) {
      if (typeof entry === "string") {
        const s = entry.trim();
        if (s) out.push(s);
      } else if (entry && typeof entry === "object") {
        const addr = entry.address || entry.email || null;
        if (typeof addr === "string" && addr.trim()) out.push(addr.trim());
      }
    }
    return out;
  }
  return [];
}

// Recipient tags are transport metadata, never routing authority. tldr;
// resolves every accepted owner reply from the provider thread in its one
// installation scope.
export function parseInboundIntent() {
  return { intent: "reply" };
}

function inboundAttachmentCount(payload) {
  if (Array.isArray(payload?.attachments)) return payload.attachments.length;
  for (const value of [payload?.attachmentCount, payload?.attachment_count]) {
    const count = Number(value);
    if (Number.isSafeInteger(count) && count > 0) return count;
  }
  return 0;
}

async function sendAttachmentNotice({
  state,
  externalMessageId,
  externalThreadId,
  config,
  owner,
  brokerAuthorized = false,
  invokeBroker = requestAegisOutbound,
}) {
  if (!externalMessageId) {
    throw emailNotSent();
  }
  const envelope = renderTldrAgentEmail({ state });
  const idempotencyKey = `tldr-agent-${state}-${createHash("sha256")
    .update(String(externalMessageId))
    .digest("hex")
    .slice(0, 32)}`;
  if (brokerAuthorized) {
    if (!externalThreadId) throw emailNotSent();
    return invokeBroker({
      operation: "reply_owner_thread",
      body: envelope.text,
      html: envelope.html,
      idempotencyKey,
      parentMessageId: externalMessageId,
      threadId: externalThreadId,
    });
  }
  if (!config?.api_key || !config?.inbox_id || !owner) {
    throw emailNotSent();
  }
  return replyToMessage({
    apiKey: config.api_key,
    inboxId: config.inbox_id,
    messageId: externalMessageId,
    to: owner,
    text: envelope.text,
    html: envelope.html,
    idempotencyKey,
  });
}

// renderOutboundEnvelope — full wire-format projection. Returns the AgentMail
// SDK-shaped record { to, subject, text, html }. The owner address and thread
// continuity are resolved internally; the envelope carries no routing chrome.
// The body passes through verbatim. It is Markdown an agent wrote, and the
// renderer is what turns it into a document — anything that reflows it here
// destroys the structure before the parser ever sees it.
export function renderOutboundEnvelope(row) {
  const state = row?.metadata?.tldr_agent_email_state || "conversation";
  const { statePanel, agent } = statePanelForRow(row);
  return renderTldrAgentEmail({
    state,
    subject: row?.subject || null,
    body: row?.body || "",
    replyInstruction: row?.metadata?.reply_instruction,
    securityNotice: row?.metadata?.security_notice,
    statePanel,
    agent,
  });
}

async function resolveTransportConfig({
  explicit = null,
  resolver = null,
  purpose = "messaging",
} = {}) {
  if (explicit) return explicit;
  if (typeof resolver === "function") return resolver({ purpose });
  return resolveTldrAgentAgentMailConfig({ purpose });
}

export const emailTransport = {
  // send: translate a canonical email row into an AgentMail send / reply
  // call. Returns { external_id, deliveryState: 'sent' } on success. Throws
  // an Error with .code in { agentmail_unreachable, transport_send_failed }
  // on failure.
  async send(canonicalRow, ctx = {}) {
    const startedAt = Date.now();
    const scope = ctx.scope || null;
    const aegisTestOverrides = getAegisBrokerTestOverrides(ctx);
    const aegisRequired =
      ctx.aegisOutboundMode === "development-required" ||
      process.env.TLDR_AGENT_AEGIS_OUTBOUND === "development-required" ||
      aegisTestOverrides.allowLegacyDirect !== true;
    logAttempt(canonicalRow, scope);
    let config = null;
    let owner = null;
    if (!aegisRequired) {
      try {
        config = await resolveTransportConfig({
          resolver: ctx.resolveAgentMailConfig,
        });
      } catch {
        const wrapped = emailNotSent();
        logOutcome({
          canonicalRow,
          scope,
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: wrapped,
        });
        throw wrapped;
      }

      owner = await resolveVerifiedOwnerEmail(config.owner_fingerprint);
      if (!owner) {
        const err = emailNotSent();
        logOutcome({
          canonicalRow,
          scope,
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: err,
        });
        throw err;
      }
    }

    const envelope = renderOutboundEnvelope(canonicalRow);
    const subject = envelope.subject || "(no subject)";
    const text = envelope.text;
    const html = envelope.html;

    let result;
    try {
      if (aegisRequired) {
        const invoke =
          aegisTestOverrides.requestOutbound || requestAegisOutbound;
        if (canonicalRow.kind === "reply") {
          const writerSessionId = resolveWriterSessionId(canonicalRow.metadata);
          const ownership = assertOwningSessionForReply(
            scope,
            canonicalRow.thread_id,
            writerSessionId,
          );
          const parent = ownership.ok
            ? findParentExternalId(
                scope,
                canonicalRow.thread_id,
                canonicalRow.message_id,
              )
            : null;
          if (!parent?.external_id || !parent.external_thread_id) {
            throw emailNotSent();
          }
          result = await invoke({
            operation: "reply_owner_thread",
            body: text,
            html,
            idempotencyKey: canonicalRow.idempotency_key,
            parentMessageId: parent.external_id,
            threadId: parent.external_thread_id,
          });
        } else {
          result = await invoke({
            operation: "send_owner_message",
            body: text,
            html,
            subject,
            idempotencyKey: canonicalRow.idempotency_key,
          });
        }
      } else if (canonicalRow.kind === "reply") {
        const parent = findParentExternalId(
          scope,
          canonicalRow.thread_id,
          canonicalRow.message_id,
        );
        if (!parent) {
          const err = emailNotSent();
          logOutcome({
            canonicalRow,
            scope,
            status: "failed",
            durationMs: Date.now() - startedAt,
            error: err,
          });
          throw err;
        }
        result = await replyToMessage({
          apiKey: config.api_key,
          inboxId: config.inbox_id,
          messageId: parent.external_id,
          to: owner,
          text,
          html,
          idempotencyKey: canonicalRow.idempotency_key,
        });
      } else {
        result = await sendEmail({
          apiKey: config.api_key,
          inboxId: config.inbox_id,
          to: owner,
          subject,
          text,
          html,
          idempotencyKey: canonicalRow.idempotency_key,
        });
      }
    } catch (err) {
      // Pre-shaped errors (transport_send_failed thrown above) propagate
      // unchanged so the caller sees the existing log + error envelope.
      if (err && err.code === "transport_send_failed" && err.hint) throw err;
      const wrapped = emailNotSent();
      if (err?.ambiguous === true) wrapped.ambiguous = true;
      logOutcome({
        canonicalRow,
        scope,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: wrapped,
      });
      throw wrapped;
    }

    // Persist the complete provider identity before returning acceptance to
    // the kernel. This is the crash-safe handoff used by owner activation and
    // the interrupted-first-outbound fallback.
    if (scope && result?.threadId) {
      updateTransportState(scope, canonicalRow.message_id, {
        transport: "email",
        delivery_state: "sent",
        external_id: result.messageId,
        external_thread_id: result.threadId,
      });
    }

    logOutcome({
      canonicalRow,
      scope,
      status: "success",
      durationMs: Date.now() - startedAt,
      externalId: result.messageId,
      externalThreadId: result.threadId,
    });
    return {
      external_id: result.messageId,
      external_thread_id: result.threadId,
      deliveryState: "sent",
    };
  },

  async inboundWebhook(payload, ctx = {}) {
    const startedAt = Date.now();
    let scope = ctx.scope || null;
    logInboundReceived(payload, scope);

    if (!payload || typeof payload !== "object") {
      const err = makeError(
        "transport_send_failed",
        "email inbound webhook received empty payload.",
        "AgentMail webhook must include messageId + threadId + from.",
      );
      logInboundNormalized({
        canonicalRow: null,
        scope,
        durationMs: Date.now() - startedAt,
        status: "failed",
        error: err,
      });
      throw err;
    }

    const envelopeAuth = authorizeInboundEnvelope({
      eventType:
        payload?.event || payload?.event_type || payload?.eventType || null,
      headers: payload?.headers || null,
    });
    if (!envelopeAuth.ok) {
      logInboundSenderRejected({
        payload,
        scope,
        auth: envelopeAuth,
        entryPoint: "inboundWebhook",
      });
      return { ok: false, rejected: true, reason: envelopeAuth.reason };
    }

    const brokerAuthorized = ctx[BROKER_AUTHORIZED_CONTEXT] === true;
    const externalMessageId = payload.messageId || null;
    const externalThreadId = payload.threadId || null;
    const subject = payload.subject || null;
    const bodySelection = selectInboundEmailBody(payload);
    const text = bodySelection.latestReplyBody;
    const attachmentCount = inboundAttachmentCount(payload);
    const hasUsableText = typeof text === "string" && text.trim().length > 0;
    const createdAt =
      payload.timestamp instanceof Date
        ? payload.timestamp.toISOString()
        : payload.timestamp || new Date().toISOString();

    const verifiedOwnerEmail = brokerAuthorized
      ? null
      : ctx[TRUSTED_OWNER_CONTEXT] ||
        (await resolveVerifiedOwnerEmail(ctx.emailConfig?.owner_fingerprint));
    const auth = brokerAuthorized
      ? { ok: true, reason: "broker_authorized" }
      : authorizeInboundSender({
          from: payload.from,
          eventType:
            payload.event || payload.event_type || payload.eventType || null,
          verifiedOwnerEmail,
          headers: payload.headers,
        });
    if (!auth.ok) {
      logInboundSenderRejected({
        payload,
        scope,
        auth,
        entryPoint: "inboundWebhook",
      });
      return {
        ok: false,
        rejected: true,
        reason: auth.reason,
      };
    }

    scope = resolveScopeForExternalThread({
      fallbackScope: scope,
      externalThreadId,
    });

    // GH#24 — fail-closed idempotency on the AgentMail message_id. The poller
    // can observe the same inbound across multiple poll windows before the
    // seen-set is durably committed (live repro: msg_mpdaue53 queued 3x in
    // 34s on thr_email_4473496f4d4fd927). Short-circuit BEFORE allocating a
    // thread, appending a row, publishing message.created, or invoking the
    // dispatch hook — so a re-observed message produces at most one canonical
    // row and at most one resume.
    if (scope && externalMessageId) {
      const existing = findInboundByExternalMessageId(scope, externalMessageId);
      if (existing) {
        appendActivityEvent({
          type: "transport_email_inbound_idempotent_skip",
          level: "debug",
          scope_id: scope.scope_id ?? null,
          cwd: scope.cwd ?? null,
          data: {
            transport: "email",
            external_id: externalMessageId,
            external_thread_id: externalThreadId,
            message_id: existing.message_id,
            thread_id: existing.thread_id,
            duration_ms: Date.now() - startedAt,
          },
        });
        return {
          canonicalRow: existing,
          dispatchResult: null,
          idempotent: true,
        };
      }
    }

    // Opportunity #1: a null scope means nothing below would persist (row,
    // message.created, dispatch hook are all scope-bound). Routable failure:
    // durable dead-letter + retryable NACK (webhook server maps it to 5xx).
    if (!scope) {
      deadLetterInbound({ payload, reason: "scope_unresolved", startedAt });
      logInboundNormalized({
        canonicalRow: null,
        scope: null,
        durationMs: Date.now() - startedAt,
        status: "failed",
        error: new Error("scope_unresolved"),
      });
      return {
        canonicalRow: null,
        dispatchResult: null,
        dropped: true,
        retryable: true,
        dead_lettered: true,
        reason: "scope_unresolved",
      };
    }

    const substrateThreadId = findSubstrateThreadByExternalThreadId(
      scope,
      externalThreadId,
    );
    if (!substrateThreadId) {
      return {
        canonicalRow: null,
        dispatchResult: null,
        recovery_required: true,
        reason: "thread_recovery_required",
      };
    }
    if (!lookupThreadOwnerSession(scope, substrateThreadId)) {
      return {
        canonicalRow: null,
        dispatchResult: null,
        recovery_required: true,
        reason: "thread_owner_missing",
      };
    }
    const kind = "reply";
    let attachmentNotice = null;
    if (attachmentCount > 0) {
      attachmentNotice = await sendAttachmentNotice({
        state: hasUsableText ? "attachment_ignored" : "attachment_only",
        externalMessageId,
        externalThreadId,
        config: brokerAuthorized
          ? null
          : await resolveTransportConfig({
              explicit: ctx.emailConfig,
              resolver: ctx.resolveAgentMailConfig,
            }),
        owner: verifiedOwnerEmail,
        brokerAuthorized,
        invokeBroker:
          ctx[BROKER_OUTBOUND_REQUEST_CONTEXT] ?? requestAegisOutbound,
      });
      if (!hasUsableText) {
        logInboundNormalized({
          canonicalRow: null,
          scope,
          durationMs: Date.now() - startedAt,
          status: "success",
        });
        return {
          canonicalRow: null,
          dispatchResult: null,
          attachment_only: true,
          attachment_count: attachmentCount,
          attachment_notice: {
            external_id: attachmentNotice.messageId,
            external_thread_id: attachmentNotice.threadId,
          },
        };
      }
    }

    const canonicalRow = {
      message_id: makeMessageId(),
      thread_id: substrateThreadId,
      workspace_id: scope?.scope_id || null,
      kind,
      target: "email://owner",
      target_class: "email",
      transport: "email",
      subject,
      body: text || null,
      body_preview: bodyPreview(text),
      sender: {
        agent_id: null,
        agent_name: null,
        address: null,
        workspace_id: scope?.scope_id || null,
      },
      scheduled_for: createdAt,
      status: "delivered",
      // Opportunity #8 (GH#24): inbound rows carry a deterministic key from
      // the AgentMail message id so the canonical-store mutex can enforce
      // exactly-one-row atomically across webhook + poll observers.
      idempotency_key: externalMessageId
        ? `ik_inbound_${createHash("sha256").update(String(externalMessageId)).digest("hex").slice(0, 32)}`
        : null,
      external_message_id: externalMessageId,
      metadata: {
        kind,
        source: "inbound_webhook",
        inbound_body: bodySelection.metadata,
        ...(payload.bodyTruncated === true
          ? { provider_body_truncated: true }
          : {}),
        ...(attachmentCount > 0
          ? { attachments: { ignored_count: attachmentCount } }
          : {}),
      },
      tags: ["message", "email", "inbound"],
      reason: "AgentMail inbound webhook",
      created_at: createdAt,
    };

    if (scope) {
      const priorThread = getThread(scope, substrateThreadId);
      upsertThread(scope, {
        thread_id: substrateThreadId,
        workspace_id: scope.scope_id,
        target_class: "email",
        created_at: priorThread?.created_at || createdAt,
        last_active_at: createdAt,
      });
      // Opportunity #8: atomic check-then-append under the store mutex —
      // the GH#24 race (webhook + poll both miss the pre-check and both
      // write) cannot produce a duplicate row anymore.
      const appended = appendMessageIdempotent(scope, canonicalRow);
      if (appended.existing) {
        appendActivityEvent({
          type: "transport_email_inbound_idempotent_skip",
          level: "debug",
          scope_id: scope.scope_id ?? null,
          cwd: scope.cwd ?? null,
          data: {
            transport: "email",
            external_id: externalMessageId,
            external_thread_id: externalThreadId,
            message_id: appended.row.message_id,
            thread_id: appended.row.thread_id,
            duration_ms: Date.now() - startedAt,
            atomic_guard: true,
          },
        });
        return {
          canonicalRow: appended.row,
          dispatchResult: null,
          idempotent: true,
        };
      }
      updateTransportState(scope, canonicalRow.message_id, {
        transport: "email",
        delivery_state: "delivered",
        external_id: externalMessageId,
        external_thread_id: externalThreadId,
        tldr_agent_inbound: {
          version: 1,
          state: "received",
          received_at: createdAt,
          updated_at: createdAt,
          attempt_count: 0,
          next_retry_at: null,
          last_error_code: null,
          lease: null,
          inbox: null,
          presentation: null,
          reply: null,
          terminal: null,
        },
      });
      publish({
        kind: EVENT_KIND.MESSAGE_CREATED,
        workspace_id: scope.scope_id,
        data: {
          message: canonicalRow,
          thread: getThread(scope, substrateThreadId),
        },
      });
    }

    // Trigger workspace-routing dispatch — Phase 3 keeps the existing skill
    // path byte-identical. When ctx.dispatch is provided, it is the routing
    // entrypoint (the test path uses a mock to assert the call shape).
    // When absent the driver is a no-op routing-side; Phase 5's shim wires
    // the live agent-email dispatchReply path.
    let dispatchResult = null;
    if (typeof ctx.dispatch === "function") {
      try {
        dispatchResult = await ctx.dispatch({
          message: canonicalRow,
          payload: {
            messageId: externalMessageId,
            threadId: externalThreadId,
            subject,
            extractedText: text,
            timestamp: createdAt,
          },
          scope,
        });
      } catch {
        appendActivityEvent({
          type: "transport_email_inbound_dispatch_failed",
          level: "warn",
          scope_id: scope?.scope_id || null,
          cwd: scope?.cwd || null,
          error: "inbound_dispatch_failed",
          data: {
            transport: "email",
            message_id: canonicalRow.message_id,
            external_id: externalMessageId,
          },
        });
      }
    }

    logInboundNormalized({
      canonicalRow,
      scope,
      durationMs: Date.now() - startedAt,
      status: "success",
    });

    return {
      canonicalRow,
      dispatchResult,
      ...(attachmentNotice
        ? {
            attachment_notice: {
              external_id: attachmentNotice.messageId,
              external_thread_id: attachmentNotice.threadId,
            },
          }
        : {}),
    };
  },

  // No-op subscription. message.created events fan out via events.mjs at
  // the kernel layer; the driver does not maintain its own subscriber set.
  subscribe(_workspaceId, _kinds, _cb) {
    return () => {};
  },

  probe() {
    const result = isAgentMailConfigured();
    if (result.ok) return { available: true, version: "1" };
    return {
      available: false,
      reason: result.reason,
      hint: HINT.agentmail_unreachable,
    };
  },
};

// COE-2 AI-6 unblocker — substrate-native inbox poll surface.
//
// Promotes the watermark + dedup helpers above into a single async entry
// point the daemon (implicit lifecycle, per Joe's directive on thread
// 0eaffd5d 2026-05-13 13:47Z) and the `helm-tasks inbox poll` CLI both
// consume. The legacy `*/3 * * * *` `agent-email-poll` cron's job is now
// owned here: listMessages → filterFreshInbounds → fetch full body →
// inboundWebhook → canonical row → tickDispatcher (next daemon tick).
//
// Implicit lifecycle: the daemon tick checks `~/.helm/email/config.json`
// through its fixed-cadence inbox scheduler and calls pollInbox iff config exists.
// No explicit "enable polling" CLI; configuration IS the trigger.

export function inboxPollStatePath() {
  if (process.env.HELM_EMAIL_POLL_STATE_PATH)
    return process.env.HELM_EMAIL_POLL_STATE_PATH;
  return join(getHelmHome(), "email", "poll-state.json");
}

// Legacy state.json location. Used as a one-shot seed source when the
// substrate state file does not exist — so the daemon poll picks up where
// the legacy poll cron left off (the AI-2 seenMessageIds set) and does
// not re-dispatch the 30-min back-window on first run. Seeds from the
// pre-consolidation default at ~/.helm/inbox-poll/state.json.
function legacyInboxPollStatePath() {
  if (process.env.HELM_LEGACY_INBOX_POLL_STATE_PATH)
    return process.env.HELM_LEGACY_INBOX_POLL_STATE_PATH;
  return join(getHelmHome(), "inbox-poll", "state.json");
}

export function readInboxPollState({ inboxId } = {}) {
  const path = inboxPollStatePath();
  let state = {};
  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      state = {};
    }
  } else {
    const legacy = legacyInboxPollStatePath();
    if (legacy && existsSync(legacy)) {
      try {
        state = JSON.parse(readFileSync(legacy, "utf8"));
      } catch {
        state = {};
      }
    }
  }
  if (!inboxId) return state;
  return state[inboxId] || {};
}

export function writeInboxPollState({
  inboxId,
  lastSeenTimestamp,
  seenMessageIds,
  lastPolledAt,
  continuationPageToken = null,
  continuationAfter = null,
  recoveryAttempts,
}) {
  const path = inboxPollStatePath();
  let state = {};
  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      state = {};
    }
  }
  const prior =
    state[inboxId] && typeof state[inboxId] === "object" ? state[inboxId] : {};
  const entry = { seenMessageIds };
  if (lastSeenTimestamp !== undefined && lastSeenTimestamp !== null) {
    entry.lastSeenTimestamp = lastSeenTimestamp;
  }
  if (lastPolledAt !== undefined) {
    entry.lastPolledAt = lastPolledAt;
  } else if (prior.lastPolledAt !== undefined) {
    entry.lastPolledAt = prior.lastPolledAt;
  }
  if (typeof continuationPageToken === "string" && continuationPageToken) {
    entry.continuationPageToken = continuationPageToken;
  }
  if (typeof continuationAfter === "string" && continuationAfter) {
    entry.continuationAfter = continuationAfter;
  }
  const nextRecoveryAttempts = recoveryAttempts ?? prior.recoveryAttempts;
  if (
    nextRecoveryAttempts &&
    typeof nextRecoveryAttempts === "object" &&
    Object.keys(nextRecoveryAttempts).length > 0
  ) {
    entry.recoveryAttempts = nextRecoveryAttempts;
  }
  state[inboxId] = entry;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
  return { path };
}

export async function pollInbox({
  scope = null,
  dispatch = true,
  dispatchCaptured = null,
  exec = null,
  nowMs = Date.now(),
  configOverride = null,
  timeoutMs = 15000,
  pageLimit = 5,
  messageLimit = 250,
  resolveAgentMailConfig = null,
  aegisInboundMode = null,
} = {}) {
  const aegisTestOverrides = getAegisBrokerTestOverrides(exec);
  const aegisRequired =
    aegisInboundMode === "development-required" ||
    process.env.TLDR_AGENT_AEGIS_INBOUND === "development-required" ||
    aegisTestOverrides.allowLegacyDirect !== true;
  let config;
  try {
    config = aegisRequired
      ? configOverride || readTldrAgentPollConfig()
      : await resolveTransportConfig({
          explicit: configOverride,
          resolver: resolveAgentMailConfig,
          purpose: "messaging",
        });
    if (
      !config?.inbox_id ||
      !config?.inbox_email ||
      (aegisRequired && Object.hasOwn(config, "api_key"))
    )
      throw new Error("not ready");
  } catch (err) {
    return {
      ok: false,
      error: err?.code || "agentmail_unreachable",
      hint: err?.hint || HINT.agentmail_unreachable,
      fetched: 0,
      written: 0,
      skipped_duplicates: 0,
      errors: [],
    };
  }

  const brokerRequest =
    aegisTestOverrides.requestInbound || requestAegisInbound;
  const effective = {
    listMessages: aegisRequired
      ? async ({ after, limit, pageToken }) => {
          const result = await brokerRequest({
            operation: "poll_bound_inbox",
            after,
            cursor: pageToken,
            limit: Math.min(25, limit),
          });
          return {
            messages: result.messages,
            nextPageToken: result.nextCursor,
            rejectedMessageIds: result.rejectedMessageIds,
          };
        }
      : exec?.listMessages || listMessages,
    getMessage: aegisRequired
      ? async ({ messageId }) => {
          const result = await brokerRequest({
            operation: "get_bound_message",
            messageId,
          });
          if (result.messages.length !== 1) {
            const error = new Error("PROVIDER_UNAVAILABLE");
            error.code = "PROVIDER_UNAVAILABLE";
            throw error;
          }
          return result.messages[0];
        }
      : exec?.getMessage || getMessage,
    memorySample: exec?.memorySample || inProcessMemorySample,
    cpuUsage: exec?.cpuUsage || process.cpuUsage.bind(process),
    inboundWebhook:
      (aegisRequired
        ? aegisTestOverrides.inboundWebhook
        : exec?.inboundWebhook) ||
      ((payload, ctx) => emailTransport.inboundWebhook(payload, ctx)),
  };
  const verifiedOwnerEmail = aegisRequired
    ? null
    : await resolveVerifiedOwnerEmail(config.owner_fingerprint);
  if (!verifiedOwnerEmail) {
    if (aegisRequired) {
      // Exact sender authorization is broker-owned in this mode.
    } else {
      return {
        ok: false,
        error: "owner_not_ready",
        fetched: 0,
        written: 0,
        skipped_duplicates: 0,
        errors: [],
      };
    }
  }
  const priorState = readInboxPollState({ inboxId: config.inbox_id });
  const lastSeenTimestamp = priorState.lastSeenTimestamp || null;
  const priorSeenIds = Array.isArray(priorState.seenMessageIds)
    ? priorState.seenMessageIds
    : [];
  const recoveryAttempts =
    priorState.recoveryAttempts &&
    typeof priorState.recoveryAttempts === "object"
      ? { ...priorState.recoveryAttempts }
      : {};
  const priorRecoveryAttempts = JSON.stringify(recoveryAttempts);
  const seenSet = new Set(priorSeenIds);
  const initialContinuationPageToken =
    typeof priorState.continuationPageToken === "string" &&
    priorState.continuationPageToken
      ? priorState.continuationPageToken
      : undefined;
  const continuationAfter =
    typeof priorState.continuationAfter === "string" &&
    priorState.continuationAfter
      ? priorState.continuationAfter
      : null;
  const after =
    continuationAfter ||
    computePollWindow({
      lastSeenTimestamp,
      lastPolledAt: priorState.lastPolledAt || null,
      nowMs,
    });

  const startedAt = Date.now();
  const memoryBefore = effective.memorySample();
  const cpuBefore = effective.cpuUsage();
  const timeoutResult = () => {
    appendActivityEvent({
      type: "transport_email_inbox_poll",
      level: "warn",
      scope_id: scope?.scope_id ?? null,
      cwd: scope?.cwd ?? null,
      duration_ms: Date.now() - startedAt,
      data: {
        after,
        ok: false,
        timed_out: true,
        timeout_ms: timeoutMs,
        pages_fetched: 0,
        messages_seen: 0,
        messages_written: 0,
        continuation: false,
      },
    });
    return {
      ok: false,
      error: "inbox_poll_timeout",
      timed_out: true,
      timeout_ms: timeoutMs,
      after,
      fetched: 0,
      written: 0,
      skipped_duplicates: 0,
      errors: [{ stage: "timeout", error: "inbox_poll_timeout" }],
    };
  };
  const cappedMessageLimit = Math.max(0, Math.floor(Number(messageLimit) || 0));
  const cappedPageLimit = Math.max(0, Math.floor(Number(pageLimit) || 0));
  const messages = [];
  const brokerRejectedIds = [];
  let pagesFetched = 0;
  let continuation = false;
  let pageToken = initialContinuationPageToken;
  try {
    while (
      cappedPageLimit > 0 &&
      cappedMessageLimit > 0 &&
      pagesFetched < cappedPageLimit &&
      messages.length < cappedMessageLimit
    ) {
      const remaining = cappedMessageLimit - messages.length;
      // eslint-disable-next-line no-await-in-loop -- AgentMail page tokens must be followed sequentially.
      const listResp = await withTimeout(
        effective.listMessages({
          apiKey: config.api_key,
          inboxId: config.inbox_id,
          after,
          limit: Math.min(50, remaining),
          pageToken,
        }),
        timeoutMs,
        "inbox_poll_timeout",
      );
      const pageMessages = Array.isArray(listResp?.messages)
        ? listResp.messages
        : [];
      if (aegisRequired && Array.isArray(listResp?.rejectedMessageIds)) {
        brokerRejectedIds.push(...listResp.rejectedMessageIds);
      }
      if (pageMessages.length > 0 || listResp?.nextPageToken) {
        pagesFetched += 1;
      }
      const accepted = pageMessages.slice(0, remaining);
      messages.push(...accepted);
      if (pageMessages.length > accepted.length) {
        continuation = true;
        break;
      }
      if (!listResp?.nextPageToken) break;
      pageToken = listResp.nextPageToken;
      if (
        pagesFetched >= cappedPageLimit ||
        messages.length >= cappedMessageLimit
      ) {
        continuation = true;
        break;
      }
    }
  } catch (err) {
    if (err?.code === "inbox_poll_timeout") {
      return timeoutResult(err);
    }
    appendActivityEvent({
      type: "transport_email_inbox_poll_list_failed",
      level: "error",
      scope_id: scope?.scope_id ?? null,
      cwd: scope?.cwd ?? null,
      error: "inbox_list_failed",
      data: { after },
    });
    return {
      ok: false,
      error: "inbox_list_failed",
      hint: "Retry after AgentMail inbox access is restored.",
      after,
      fetched: 0,
      written: 0,
      skipped_duplicates: 0,
      errors: [{ stage: "listMessages", error: "inbox_list_failed" }],
    };
  }
  const pollSucceededAt = new Date(nowMs).toISOString();
  const { fresh, dedupSkipped, ownSkipped } = filterFreshInbounds({
    messages,
    inboxEmail: config.inbox_email,
    seenIds: seenSet,
  });

  // Advance watermark across ALL fetched messages (including outbound) so an
  // inbox with only outbound traffic still advances the cursor between polls.
  // Mirrors legacy cmdPoll exactly (AI-2 widen-window contract).
  const toIso = (v) =>
    v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
  let latestTs = lastSeenTimestamp ? toIso(lastSeenTimestamp) : null;
  for (const m of messages) {
    const t = toIso(m.timestamp);
    if (t && (!latestTs || t > latestTs)) latestTs = t;
  }

  const errors = [];
  const newlyProcessedIds = dispatch ? [...new Set(brokerRejectedIds)] : [];
  const dispatchResults = [];
  let written = 0;
  let unauthorizedSkipped = brokerRejectedIds.length;
  let recoveryCursorFloor = null;

  for (const m of fresh) {
    if (!dispatch) continue;

    const listFrom =
      typeof m?.from === "string"
        ? m.from
        : m?.from?.address || m?.from?.email || null;
    const listEventType = m?.event || m?.event_type || m?.eventType || null;
    const listAuth = aegisRequired
      ? {
          ok: m?.senderAuthorized === true,
          reason: "broker_authorized",
        }
      : authorizeInboundSender({
          from: m?.from,
          eventType: listEventType,
          verifiedOwnerEmail,
          headers: m?.headers,
        });
    const hasListSender = Boolean(extractAddress(listFrom));
    if (
      !listAuth.ok &&
      (hasListSender || listAuth.reason !== "sender_not_authorized")
    ) {
      unauthorizedSkipped += 1;
      newlyProcessedIds.push(m.messageId);
      logInboundSenderRejected({
        payload: {
          messageId: m.messageId,
          threadId: m.threadId,
        },
        scope,
        auth: listAuth,
        entryPoint: "pollInbox",
      });
      continue;
    }

    let full;
    try {
      // eslint-disable-next-line no-await-in-loop -- per-message fetch/write must stop safely on timeout.
      full = await withTimeout(
        effective.getMessage({
          apiKey: config.api_key,
          inboxId: config.inbox_id,
          messageId: m.messageId,
        }),
        timeoutMs,
        "inbox_poll_timeout",
      );
    } catch (err) {
      if (err?.code === "inbox_poll_timeout") return timeoutResult(err);
      errors.push({
        stage: "getMessage",
        messageId: m.messageId,
        error: "message_fetch_failed",
      });
      continue;
    }

    const payload = {
      messageId: full.messageId || m.messageId,
      threadId: full.threadId || m.threadId,
      from: full.from,
      to: full.to,
      subject: full.subject,
      text: full.text || full.body || full.preview || "",
      body: full.body || full.text || full.preview || "",
      extractedText: full.extractedText || full.extracted_text || null,
      extracted_text: full.extracted_text || full.extractedText || null,
      preview: full.preview || null,
      attachmentCount: inboundAttachmentCount(full),
      timestamp: full.timestamp || m.timestamp,
      headers: full.headers || null,
      eventType:
        full.event ||
        full.event_type ||
        full.eventType ||
        m.event ||
        m.event_type ||
        m.eventType ||
        null,
      inReplyTo:
        full.inReplyTo ??
        full.in_reply_to ??
        full.parentMessageId ??
        full.parent_message_id ??
        null,
      bodyTruncated: full.bodyTruncated === true,
    };
    const fullAuth = aegisRequired
      ? {
          ok: full?.senderAuthorized === true,
          reason: "broker_authorized",
        }
      : authorizeInboundSender({
          from: payload.from,
          eventType:
            full?.event ||
            full?.event_type ||
            full?.eventType ||
            payload.event ||
            null,
          verifiedOwnerEmail,
          headers: payload.headers,
        });
    if (!fullAuth.ok) {
      unauthorizedSkipped += 1;
      newlyProcessedIds.push(m.messageId);
      logInboundSenderRejected({
        payload,
        scope,
        auth: fullAuth,
        entryPoint: "pollInbox",
      });
      continue;
    }

    try {
      const routedScope = resolveScopeForExternalThread({
        fallbackScope: scope,
        externalThreadId: payload.threadId,
      });
      // eslint-disable-next-line no-await-in-loop -- cursor state advances only after sequential writes finish.
      const inboundResult = await withTimeout(
        effective.inboundWebhook(payload, {
          scope: routedScope,
          source: "poll",
          emailConfig: config,
          [BROKER_AUTHORIZED_CONTEXT]: aegisRequired,
          [BROKER_OUTBOUND_REQUEST_CONTEXT]: aegisRequired
            ? aegisTestOverrides.requestOutbound
            : null,
          [TRUSTED_OWNER_CONTEXT]: verifiedOwnerEmail,
        }),
        timeoutMs,
        "inbox_poll_timeout",
      );
      // Opportunity #1: a dropped (nothing-persisted) inbound must NOT be
      // marked seen — the next poll retries it instead of aging it out.
      if (inboundResult?.dropped) {
        errors.push({
          stage: "inboundWebhook",
          messageId: m.messageId,
          error: inboundResult.reason || "inbound_dropped",
        });
        continue;
      }
      // An inbound whose provider thread cannot yet be mapped to the fixed
      // canonical thread is not processed. Keep it outside the durable seen
      // set so the next overlap poll retries after routing state recovers.
      if (inboundResult?.recovery_required) {
        const priorRecovery = recoveryAttempts[m.messageId];
        const attempts = Math.max(0, Number(priorRecovery?.attempts) || 0) + 1;
        const reason = inboundResult.reason || "thread_recovery_required";
        if (attempts >= POLL_RECOVERY_ATTEMPT_LIMIT) {
          deadLetterInbound({
            payload: {
              messageId: payload.messageId,
              threadId: payload.threadId,
            },
            reason: `${reason}_exhausted`,
            startedAt,
          });
          delete recoveryAttempts[m.messageId];
          newlyProcessedIds.push(m.messageId);
          errors.push({
            stage: "inboundWebhook",
            messageId: m.messageId,
            error: `${reason}_exhausted`,
          });
          continue;
        }
        recoveryAttempts[m.messageId] = {
          attempts,
          firstSeenAt: priorRecovery?.firstSeenAt || pollSucceededAt,
          timestamp: toIso(payload.timestamp),
          reason,
        };
        const timestampMs = Date.parse(toIso(payload.timestamp) || "");
        const cursorFloor = Number.isNaN(timestampMs)
          ? after
          : new Date(timestampMs - 1).toISOString();
        if (!recoveryCursorFloor || cursorFloor < recoveryCursorFloor) {
          recoveryCursorFloor = cursorFloor;
        }
        errors.push({
          stage: "inboundWebhook",
          messageId: m.messageId,
          error: reason,
        });
        continue;
      }
      newlyProcessedIds.push(m.messageId);
      // GH#24 — an idempotent re-observation is not a fresh write.
      if (inboundResult?.canonicalRow && !inboundResult?.idempotent)
        written += 1;
      if (
        typeof dispatchCaptured === "function" &&
        inboundResult?.canonicalRow &&
        !inboundResult?.idempotent
      ) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const dispatchResult = await withTimeout(
            dispatchCaptured({
              scope: routedScope,
              message: inboundResult.canonicalRow,
              payload,
            }),
            timeoutMs,
            "inbox_poll_timeout",
          );
          dispatchResults.push({
            message_id: inboundResult.canonicalRow.message_id,
            scope_id: routedScope?.scope_id || null,
            result: dispatchResult || null,
          });
        } catch (err) {
          dispatchResults.push({
            message_id: inboundResult.canonicalRow.message_id,
            scope_id: routedScope?.scope_id || null,
            error:
              err?.code === "inbox_poll_timeout"
                ? "inbox_poll_timeout"
                : "dispatch_failed",
          });
          appendActivityEvent({
            type: "transport_email_inbox_poll_dispatch_failed",
            level: "warn",
            scope_id: routedScope?.scope_id ?? null,
            cwd: routedScope?.cwd ?? null,
            error:
              err?.code === "inbox_poll_timeout"
                ? "inbox_poll_timeout"
                : "dispatch_failed",
            data: {
              transport: "email",
              message_id: inboundResult.canonicalRow.message_id,
              external_id: payload.messageId || null,
            },
          });
        }
      }
    } catch (err) {
      if (err?.code === "inbox_poll_timeout") return timeoutResult(err);
      errors.push({
        stage: "inboundWebhook",
        messageId: m.messageId,
        error: "inbound_capture_failed",
      });
    }
  }
  for (const messageId of newlyProcessedIds) delete recoveryAttempts[messageId];
  if (recoveryCursorFloor && (!latestTs || recoveryCursorFloor < latestTs)) {
    latestTs = recoveryCursorFloor;
  }

  // Persist watermark + dedup set in lockstep with the legacy contract.
  // Only mutate when dispatch=true — read-only mode must NOT advance the
  // watermark or seen-set, so a subsequent dispatch=true poll picks up the
  // same inbound and writes the canonical row.
  if (dispatch) {
    const nextSeenIds = appendAndBoundSeenIds(priorSeenIds, newlyProcessedIds);
    const cursorChanged = latestTs && latestTs !== lastSeenTimestamp;
    const seenChanged = nextSeenIds.length !== priorSeenIds.length;
    const recoveryChanged =
      JSON.stringify(recoveryAttempts) !== priorRecoveryAttempts;
    const pollAttemptChanged = priorState.lastPolledAt !== pollSucceededAt;
    const nextContinuationPageToken = continuation ? pageToken || null : null;
    const nextContinuationAfter = nextContinuationPageToken ? after : null;
    const continuationChanged =
      (priorState.continuationPageToken || null) !==
        nextContinuationPageToken ||
      (priorState.continuationAfter || null) !== nextContinuationAfter;
    if (
      cursorChanged ||
      seenChanged ||
      recoveryChanged ||
      pollAttemptChanged ||
      continuationChanged
    ) {
      writeInboxPollState({
        inboxId: config.inbox_id,
        lastSeenTimestamp: latestTs,
        seenMessageIds: nextSeenIds,
        lastPolledAt: pollSucceededAt,
        continuationPageToken: nextContinuationPageToken,
        continuationAfter: nextContinuationAfter,
        recoveryAttempts,
      });
    }
  }

  const memoryAfter = effective.memorySample();
  const cpuAfter = effective.cpuUsage();
  const rssDeltaMb = deltaMb(memoryAfter, memoryBefore, "rss_mb");
  const heapDeltaMb = deltaMb(memoryAfter, memoryBefore, "heap_used_mb");
  const cpuDeltaMs = Math.round(
    (cpuAfter.user - cpuBefore.user + (cpuAfter.system - cpuBefore.system)) /
      1000,
  );
  const guardrail = memoryGuardrail(rssDeltaMb);
  const reportedLastSeenTimestamp = dispatch ? latestTs : lastSeenTimestamp;
  const reportedLastPolledAt = dispatch
    ? pollSucceededAt
    : priorState.lastPolledAt || null;

  appendActivityEvent({
    type: "transport_email_inbox_poll",
    level: written > 0 || errors.length > 0 ? "info" : "debug",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    duration_ms: Date.now() - startedAt,
    data: {
      after,
      fetched: messages.length,
      fresh: fresh.length,
      written,
      pages_fetched: pagesFetched,
      page_limit: pageLimit,
      message_limit: messageLimit,
      messages_seen: messages.length,
      messages_written: written,
      skipped_duplicates: dedupSkipped,
      own_skipped: ownSkipped,
      unauthorized_skipped: unauthorizedSkipped,
      errors: errors.length,
      continuation,
      dispatch,
      dispatch_results: dispatchResults.length,
      last_seen_timestamp: reportedLastSeenTimestamp,
      last_polled_at: reportedLastPolledAt,
      rss_delta_mb: rssDeltaMb,
      heap_delta_mb: heapDeltaMb,
      cpu_delta_ms: cpuDeltaMs,
      memory_guardrail: guardrail,
    },
  });

  return {
    ok: true,
    after,
    fetched: messages.length,
    pages_fetched: pagesFetched,
    messages_seen: messages.length,
    continuation,
    rss_delta_mb: rssDeltaMb,
    heap_delta_mb: heapDeltaMb,
    cpu_delta_ms: cpuDeltaMs,
    memory_guardrail: guardrail,
    fresh: fresh.length,
    written,
    skipped_duplicates: dedupSkipped,
    own_skipped: ownSkipped,
    unauthorized_skipped: unauthorizedSkipped,
    last_seen_timestamp: reportedLastSeenTimestamp,
    last_polled_at: reportedLastPolledAt,
    errors,
    dispatch,
    dispatch_results: dispatchResults,
  };
}

// reconcileInboxThread — substrate mirror of the legacy `agent-email
// reconcile --thread-id` command. Forces a ground-truth read of a known-
// important thread via getThread, filters its messages against the local
// dedup set, and writes canonical rows for any unseen inbound via
// inboundWebhook. Idempotent: subsequent runs return written=0 because the
// dedup set absorbs all surfaced ids on the first pass.
export async function reconcileInboxThread({
  scope = null,
  threadId,
  dispatch = true,
  exec = null,
  configOverride = null,
  resolveAgentMailConfig = null,
  aegisInboundMode = null,
} = {}) {
  if (!threadId || typeof threadId !== "string") {
    return { ok: false, error: "thread_id_required" };
  }

  const aegisTestOverrides = getAegisBrokerTestOverrides(exec);
  const aegisRequired =
    aegisInboundMode === "development-required" ||
    process.env.TLDR_AGENT_AEGIS_INBOUND === "development-required" ||
    aegisTestOverrides.allowLegacyDirect !== true;
  let config;
  try {
    config = aegisRequired
      ? configOverride || readTldrAgentPollConfig()
      : await resolveTransportConfig({
          explicit: configOverride,
          resolver: resolveAgentMailConfig,
        });
    if (
      !config?.inbox_id ||
      !config?.inbox_email ||
      (aegisRequired && Object.hasOwn(config, "api_key"))
    )
      throw new Error("not ready");
  } catch (err) {
    return {
      ok: false,
      error: err?.code || "agentmail_unreachable",
      hint: err?.hint || HINT.agentmail_unreachable,
    };
  }

  const brokerRequest =
    aegisTestOverrides.requestInbound || requestAegisInbound;
  const effective = {
    getThread: aegisRequired
      ? async ({ threadId: providerThreadId }) => {
          const result = await brokerRequest({
            operation: "get_bound_thread",
            threadId: providerThreadId,
          });
          return {
            messages: result.messages,
            rejectedMessageIds: result.rejectedMessageIds,
          };
        }
      : exec?.getThread || agentMailGetThread,
    getMessage: aegisRequired
      ? async ({ messageId }) => {
          const result = await brokerRequest({
            operation: "get_bound_message",
            messageId,
          });
          if (result.messages.length !== 1) throw new Error("invalid message");
          return result.messages[0];
        }
      : exec?.getMessage || getMessage,
    inboundWebhook:
      (aegisRequired
        ? aegisTestOverrides.inboundWebhook
        : exec?.inboundWebhook) ||
      ((payload, ctx) => emailTransport.inboundWebhook(payload, ctx)),
  };
  const verifiedOwnerEmail = aegisRequired
    ? null
    : await resolveVerifiedOwnerEmail(config.owner_fingerprint);
  if (!verifiedOwnerEmail && !aegisRequired) {
    return { ok: false, error: "owner_not_ready", thread_id: threadId };
  }

  let thread;
  try {
    thread = await effective.getThread({
      apiKey: config.api_key,
      inboxId: config.inbox_id,
      threadId,
    });
  } catch {
    return {
      ok: false,
      error: "thread_fetch_failed",
      hint: "Retry after the AgentMail thread is available.",
      thread_id: threadId,
    };
  }

  const priorState = readInboxPollState({ inboxId: config.inbox_id });
  const priorSeenIds = Array.isArray(priorState.seenMessageIds)
    ? priorState.seenMessageIds
    : [];
  const { unseen, alreadySeen, ownSkipped, messageCount } =
    filterUnseenThreadInbounds({
      thread,
      inboxEmail: config.inbox_email,
      seenIds: priorSeenIds,
    });

  const errors = [];
  const brokerRejectedIds = Array.isArray(thread?.rejectedMessageIds)
    ? thread.rejectedMessageIds
    : [];
  const newlyProcessedIds = dispatch ? [...new Set(brokerRejectedIds)] : [];
  let written = 0;
  let unauthorizedSkipped = brokerRejectedIds.length;

  for (const m of unseen) {
    if (!dispatch) continue;

    const listFrom =
      typeof m?.from === "string"
        ? m.from
        : m?.from?.address || m?.from?.email || null;
    const listAuth = aegisRequired
      ? { ok: m?.senderAuthorized === true, reason: "broker_authorized" }
      : authorizeInboundSender({
          from: m?.from,
          eventType: m?.event || m?.event_type || m?.eventType || null,
          verifiedOwnerEmail,
          headers: m?.headers,
        });
    const hasListSender = Boolean(extractAddress(listFrom));
    if (
      !listAuth.ok &&
      (hasListSender || listAuth.reason !== "sender_not_authorized")
    ) {
      unauthorizedSkipped += 1;
      newlyProcessedIds.push(m.messageId);
      logInboundSenderRejected({
        payload: {
          messageId: m.messageId,
          threadId: m.threadId || threadId,
        },
        scope,
        auth: listAuth,
        entryPoint: "reconcileInboxThread",
      });
      continue;
    }

    // The thread.messages payload from getThread typically carries the full
    // body already (the AgentMail SDK returns `text` / `extractedText` on
    // threads.get). Avoid an extra messages.get round-trip when present.
    let payloadSource = m;
    if (!m.text && !m.body && !m.extractedText && !m.extracted_text) {
      try {
        // eslint-disable-next-line no-await-in-loop -- reconcile fetches only missing bodies sequentially.
        payloadSource = await effective.getMessage({
          apiKey: config.api_key,
          inboxId: config.inbox_id,
          messageId: m.messageId,
        });
      } catch {
        errors.push({
          stage: "getMessage",
          messageId: m.messageId,
          error: "message_fetch_failed",
        });
        continue;
      }
    }

    const payload = {
      messageId: payloadSource.messageId || m.messageId,
      threadId: payloadSource.threadId || m.threadId || threadId,
      from: payloadSource.from || m.from,
      to: payloadSource.to || m.to,
      subject: payloadSource.subject || m.subject,
      text:
        payloadSource.text || payloadSource.body || payloadSource.preview || "",
      body:
        payloadSource.body || payloadSource.text || payloadSource.preview || "",
      extractedText:
        payloadSource.extractedText || payloadSource.extracted_text || null,
      extracted_text:
        payloadSource.extracted_text || payloadSource.extractedText || null,
      preview: payloadSource.preview || null,
      attachmentCount: inboundAttachmentCount(payloadSource),
      timestamp: payloadSource.timestamp || m.timestamp,
      headers: payloadSource.headers || null,
      bodyTruncated: payloadSource.bodyTruncated === true,
    };

    const fullAuth = aegisRequired
      ? {
          ok: payloadSource?.senderAuthorized === true,
          reason: "broker_authorized",
        }
      : authorizeInboundSender({
          from: payload.from,
          eventType:
            payloadSource?.event ||
            payloadSource?.event_type ||
            payloadSource?.eventType ||
            null,
          verifiedOwnerEmail,
          headers: payload.headers,
        });
    if (!fullAuth.ok) {
      unauthorizedSkipped += 1;
      newlyProcessedIds.push(m.messageId);
      logInboundSenderRejected({
        payload,
        scope,
        auth: fullAuth,
        entryPoint: "reconcileInboxThread",
      });
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- reconcile preserves deterministic seen-set updates.
      const inboundResult = await effective.inboundWebhook(payload, {
        scope,
        emailConfig: config,
        [BROKER_AUTHORIZED_CONTEXT]: aegisRequired,
        [BROKER_OUTBOUND_REQUEST_CONTEXT]: aegisRequired
          ? aegisTestOverrides.requestOutbound
          : null,
        [TRUSTED_OWNER_CONTEXT]: verifiedOwnerEmail,
      });
      // GH#24 — an idempotent re-observation is not a fresh write.
      if (inboundResult?.canonicalRow && !inboundResult?.idempotent)
        written += 1;
      if (!inboundResult?.dropped) newlyProcessedIds.push(m.messageId);
    } catch {
      errors.push({
        stage: "inboundWebhook",
        messageId: m.messageId,
        error: "inbound_capture_failed",
      });
    }
  }

  // Reconcile is thread-scoped — don't touch lastSeenTimestamp (cmdPoll's
  // inbox-wide watermark). Only append to seenMessageIds so a re-run is
  // idempotent. Matches legacy cmdReconcile.
  if (dispatch && newlyProcessedIds.length > 0) {
    const nextSeenIds = appendAndBoundSeenIds(priorSeenIds, newlyProcessedIds);
    if (nextSeenIds.length !== priorSeenIds.length) {
      writeInboxPollState({
        inboxId: config.inbox_id,
        lastSeenTimestamp: priorState.lastSeenTimestamp || null,
        seenMessageIds: nextSeenIds,
      });
    }
  }

  return {
    ok: true,
    thread_id: threadId,
    message_count: messageCount,
    unseen: unseen.length,
    already_seen: alreadySeen,
    own_skipped: ownSkipped,
    unauthorized_skipped: unauthorizedSkipped,
    written,
    errors,
    dispatch,
  };
}

export function registerEmailTransport() {
  return registerTransport("email", emailTransport);
}

// Self-register on import. CLI and daemon processes can opt in by
// importing this module once at process boot; tests that want a clean
// registry call transport_interface._resetForTests then re-import.
registerEmailTransport();
