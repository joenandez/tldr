// PRFAQ-0-1.1 — substrate invariant: 1 email thread = 1 agent session.
//
// Every email thread Joe sees in his inbox is owned by exactly ONE agent
// session. The session that minted the thread (the originator of the FIRST
// outbound row on this thread_id) owns the thread. Subsequent replies on
// the same thread must come from the owning session, or the substrate
// auto-coerces the write to a new thread so two sessions never appear to
// be one continuous conversation in Joe's inbox.
//
// Why: Joe codified the invariant on email thread `c1ec6f03` ("Sessions/
// Replies") 2026-05-12T17:06Z after observing N writes from N agent sessions
// landing on a single PRFAQ thread — from Joe's inbox the thread reads as
// one long session, but the substrate side has N sessions with no shared
// context, breaking Joe's mental model of which thread is actually getting
// resumed if he replies.
//
// This module is read-only over the canonical store. Writes (stamping
// owner_session_id on the thread row) live in kernel.recordCanonicalRow.

import {
  activateThreadIdentity,
  getThread,
  getTransportState,
  listMessagesForThread,
} from "./canonical_store.mjs";
import { resolveSessionFromPidAncestry } from "../identity_state.mjs";
import { resolveAgentRunSessionFromEnv } from "../agent_run_session.mjs";

// Find the originator_session_id of the FIRST outbound message that
// established this substrate thread_id. Two-tier lookup:
//   1. canonical thread `owner_session_id` field (O(1)) — stamped on first
//      outbound row creating the thread, never updated thereafter.
//   2. Fallback over canonical payloads for the earliest provider-accepted
//      Coffee outbound whose provider identity is durable. This closes the
//      interrupted-write window between provider acceptance and thread stamp
//      without treating failed/pending/legacy rows as owners.
export function lookupThreadOwnerSession(scope, threadId) {
  if (!scope || !threadId) return null;
  const cached = getThread(scope, threadId);
  if (cached && cached.owner_session_id) return cached.owner_session_id;
  let owner = null;
  let externalThreadId = null;
  let firstCreated = null;
  for (const row of listMessagesForThread(scope, threadId)) {
    if (row.metadata?.source === "inbound_webhook") continue;
    const transportState = row.message_id
      ? getTransportState(scope, row.message_id)
      : null;
    if (
      !["sent", "delivered"].includes(transportState?.delivery_state) ||
      !transportState?.external_id ||
      !transportState?.external_thread_id
    ) {
      continue;
    }
    const sid =
      row.metadata?.originator_session_id || row.metadata?.session_id || null;
    if (!sid) continue;
    if (!firstCreated || String(row.created_at) < String(firstCreated)) {
      firstCreated = row.created_at;
      owner = sid;
      externalThreadId = transportState.external_thread_id;
    }
  }
  if (owner && externalThreadId) {
    const activated = activateThreadIdentity(
      scope,
      threadId,
      owner,
      externalThreadId,
    );
    if (!activated.ok) return null;
  }
  return owner;
}

// Substrate invariant assertion. Returns:
//   { ok: true, owner_session_id }                          - allowed (in-thread)
//   { ok: false, owner_session_id, writer_session_id }      - blocked (mismatch)
//
// Callers share this source-of-truth; lookup may repair the narrow
// provider-accepted/interrupted-write window before this predicate runs.
export function assertOwningSessionForReply(
  scope,
  threadId,
  writerSessionId,
  _options = {},
) {
  const owner = lookupThreadOwnerSession(scope, threadId);
  if (!owner) {
    return {
      ok: false,
      reason: "thread_owner_missing",
      owner_session_id: null,
      writer_session_id: writerSessionId || null,
    };
  }
  if (writerSessionId && owner === writerSessionId) {
    return { ok: true, owner_session_id: owner };
  }
  return {
    ok: false,
    owner_session_id: owner,
    writer_session_id: writerSessionId || null,
  };
}

// Resolve the writing session id from caller-provided metadata or the
// runtime env. Caller metadata wins so back-compat shims that pre-populate
// `originator_session_id` remain authoritative.
export function resolveWriterSessionId(metadata = {}) {
  if (metadata?.originator_session_id || metadata?.session_id) {
    return metadata.originator_session_id || metadata.session_id;
  }
  const hookSession = resolveSessionFromPidAncestry();
  if (hookSession.ok) return hookSession.session_id;
  if (hookSession.error === "session_pid_ambiguous") return null;
  const runSession = resolveAgentRunSessionFromEnv();
  if (runSession.ok) return runSession.session_id;
  return (
    process.env.CLAUDE_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.HELM_AGENT_SESSION_ID ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    null
  );
}
