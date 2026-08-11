// Canonical in-process kernel; delivery stays sequential per thread.

import { randomBytes } from "node:crypto";
import { appendActivityEvent } from "../tldr_agent_diagnostics.mjs";
import { guardOutbound } from "../outbound_guard.mjs";
import {
  recordBeaconOutboundEffectFailure,
  recordBeaconOutboundEffectSuccess,
} from "../tldr_agent_beacon_outbound_effect.mjs";
import {
  readIdentity,
  resolveOutboundEmailSessionOwner,
  resolveSessionFromPidAncestry,
} from "../identity_state.mjs";
import { tachyonListenPolicyForIdentity } from "../tachyon_eligibility.mjs";
import { resolveAgentRunSessionFromEnv } from "../agent_run_session.mjs";
import {
  parseTargetUri,
  targetClassFromScheme,
  allocateThreadId,
  validateWorkspaceId,
} from "./identity.mjs";
import {
  activateThreadIdentity,
  appendMessage,
  claimThreadIdentity,
  upsertThread,
  getThread,
  releaseThreadIdentityClaim,
  updateTransportState,
} from "./canonical_store.mjs";
import { deriveKey, collisionCheck } from "./idempotency.mjs";
import { publish, EVENT_KIND } from "./events.mjs";
import { getTransport, listRegisteredSchemes } from "./transport_interface.mjs";
import {
  assertOwningSessionForReply,
  resolveWriterSessionId,
} from "./thread_ownership.mjs";
import {
  checkUnreadBeforeDispatch,
  clearBlockedAttempt,
  recordBlockedAttempt,
  shouldEscalateToRepeated,
  tupleKey,
} from "./blocked_unread.mjs";
import { applyReservedDelivery } from "./reserved_delivery.mjs";
import {
  isBeaconOutboundEffect,
  isBeaconFailedDefiniteRetry,
  prepareCanonicalOutboundEffect,
} from "./outbound_effect_options.mjs";
import { recordAcceptedEmailPostSendEffects } from "./email_post_send_effects.mjs";
import { prepareFailedDeliveryRetry } from "./failed_delivery_retry.mjs";

function nowIso() {
  return new Date().toISOString();
}

function makeMessageId() {
  return `msg_${Date.now().toString(36)}_${randomBytes(8).toString("hex")}`;
}

function isAmbiguousTransportError(error) {
  if (error?.ambiguous === true) return true;
  const code = String(error?.code || "").toLowerCase();
  const errorMessage = String(error?.message || "").toLowerCase();
  return (
    code.includes("timeout") ||
    code.includes("unknown") ||
    errorMessage.includes("timeout") ||
    errorMessage.includes("unknown whether")
  );
}

function bodyPreview(body) {
  if (typeof body !== "string" || body.length === 0) return null;
  return body.length > 120 ? `${body.slice(0, 117)}…` : body;
}

// PRFAQ-0-4 Appendix B — outbound canonical-row metadata stamp. Captures the
// originator's workspace + cwd + session + controlling tty + the recipient
// surface (target URI scheme). PRFAQ-0-1 shipped session_id + controlling_tty
// here; PRFAQ-0-4 Phase 1 extends to the full Appendix B contract so every
// transport adapter's renderOutboundEnvelope can project the same fields onto
// its wire format and so parseInboundEnvelope can restore them on inbound.
//
// Caller-provided metadata always wins (back-compat shims that pre-populate
// metadata.session_id / metadata.originator_thread_id remain authoritative).
export function deriveOutboundStamp({ scope, parsed, threadId }) {
  const hookSession = resolveSessionFromPidAncestry();
  let sessionId = hookSession.ok ? hookSession.session_id : null;
  let identityForSession = hookSession.ok ? hookSession.identity : null;
  // Sev-2 2026-05-22 (codename-grove resume break): when PID ancestry is
  // AMBIGUOUS (multiple nested agent sessions match), do NOT short-circuit to
  // null. Ambiguous ancestry can't pick a session, but the agent-run registry
  // (keyed by HELM_JOB_ID/HELM_RUN_ID) is unambiguous, and the explicit
  // CLAUDE_CODE_SESSION_ID env is the harness-provided current session — both
  // are MORE authoritative than ancestry, so they disambiguate it. Skipping
  // them on ambiguity is exactly what wrote a null session_id on the original
  // outbound, leaving the thread with no owner_session_id so every reply
  // spawned a fresh session instead of resuming. The only ancestry result we
  // still trust outright is an unambiguous match (handled above).
  if (!sessionId) {
    const runSession = resolveAgentRunSessionFromEnv();
    if (runSession.ok) {
      sessionId = runSession.session_id;
      identityForSession = runSession.identity || null;
    }
  }
  if (!sessionId) {
    // Env vars are the harness-provided fallback. They can be absent or stale
    // when shells inherit parent agent env, so an UNAMBIGUOUS hook match wins
    // (checked first, above). On ambiguity or no match, the env value is the
    // best deterministic signal we have for the current session.
    sessionId =
      process.env.CLAUDE_SESSION_ID ||
      process.env.CODEX_THREAD_ID ||
      process.env.HELM_AGENT_SESSION_ID ||
      process.env.CLAUDE_CODE_SESSION_ID ||
      null;
  }
  let controllingTty = null;
  if (identityForSession?.controlling_tty) {
    controllingTty = identityForSession.controlling_tty;
  } else if (sessionId) {
    try {
      const identity = readIdentity(sessionId);
      identityForSession = identityForSession || identity;
      if (identity && identity.controlling_tty) {
        controllingTty = identity.controlling_tty;
      }
    } catch {
      // identity.json read is best-effort; absence is not an error.
    }
  }
  const listenPolicy = tachyonListenPolicyForIdentity(identityForSession);
  return {
    session_id: sessionId,
    controlling_tty: controllingTty,
    sender_launch_mode: identityForSession?.launch_mode || "unknown",
    sender_launch_source: identityForSession?.launch_source || "unknown",
    tachyon_listen_policy: listenPolicy.listenPolicy,
    tachyon_disabled_reason: listenPolicy.disabledReason,
    // PRFAQ-0-4 Appendix B fields.
    originator_ws: scope?.scope_id || null,
    originator_cwd: scope?.cwd || null,
    // The adapter id of the agent that wrote this, for the email footer's
    // AGENT row. Null when no identity resolved — the footer omits the row
    // rather than guessing a name.
    originator_runtime: identityForSession?.runtime ?? null,
    originator_session_id: sessionId,
    originator_thread_id: threadId || null,
    recipient_surface: parsed?.scheme || null,
  };
}

// PRFAQ-0-4 Phase 1 — fail-closed write-side validator. Returns a code/message/
// hint envelope when an outbound row is missing any Appendix B required field.
// Inbound rows (metadata.source='inbound_webhook') are normalized through
// parseInboundEnvelope and bypass this validator.
export function validateOutboundMetadata(row) {
  if (!row || typeof row !== "object") {
    return {
      ok: false,
      error: {
        code: "outbound_metadata_missing",
        message: "row is required.",
        hint: "composeCanonicalRow must return a row before validation.",
      },
    };
  }
  if (row.metadata?.source === "inbound_webhook") return { ok: true };
  const m = row.metadata || {};
  const missing = [];
  if (!m.originator_ws) missing.push("originator_ws");
  if (!m.originator_cwd) missing.push("originator_cwd");
  if (!m.recipient_surface) missing.push("recipient_surface");
  if (row.kind === "reply" && !m.originator_thread_id)
    missing.push("originator_thread_id");
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    error: {
      code: "outbound_metadata_missing",
      message: `Outbound canonical-row missing required Appendix B metadata: ${missing.join(", ")}.`,
      hint: "PRFAQ-0-4 Phase 1: every outbound row carries originator_ws, originator_cwd, recipient_surface, and (on kind=reply) originator_thread_id. Ensure scope.cwd is set on the calling context.",
    },
  };
}

// Compose a canonical row from the kernel-ready input. Pure function — no
// I/O. Idempotent on stable inputs (the message_id is stamped only after
// idempotency lookup misses, in recordCanonicalRow).
export function composeCanonicalRow({
  kind,
  target,
  schedule,
  payload = {},
  scope,
  opts = {},
}) {
  const parsed = parseTargetUri(target);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: parsed.reason || "target_invalid",
        message: `Invalid --target: ${target}.`,
        hint: `Expected one of ${listRegisteredSchemes()
          .map((s) => `${s}://...`)
          .join(" | ")}.`,
      },
    };
  }
  const targetClass = targetClassFromScheme(parsed.scheme);
  const threadIdFromUri = parsed.threadId || null;
  const threadId =
    opts.thread_id ||
    threadIdFromUri ||
    (kind === "new" ? allocateThreadId(targetClass) : null);
  if (!threadId) {
    return {
      ok: false,
      error: {
        code: "thread_required",
        message: "Could not resolve a thread id for kind=reply.",
        hint: "Pass --thread <id> when --target does not carry the thread id (email://owner).",
      },
    };
  }
  const scheduledFor = schedule?.at || nowIso();
  const callerMetadata = payload.metadata || {};
  const stamp = deriveOutboundStamp({ scope, parsed, threadId });
  const metadata = {
    ...callerMetadata,
    // PRFAQ-0-1 keys preserved for the comms-dispatcher lookup.
    session_id: callerMetadata.session_id ?? stamp.session_id,
    controlling_tty: callerMetadata.controlling_tty ?? stamp.controlling_tty,
    sender_launch_mode:
      callerMetadata.sender_launch_mode ?? stamp.sender_launch_mode,
    sender_launch_source:
      callerMetadata.sender_launch_source ?? stamp.sender_launch_source,
    tachyon_listen_policy:
      callerMetadata.tachyon_listen_policy ?? stamp.tachyon_listen_policy,
    tachyon_disabled_reason:
      callerMetadata.tachyon_disabled_reason ?? stamp.tachyon_disabled_reason,
    // PRFAQ-0-4 Appendix B — full outbound metadata contract. Caller-provided
    // values always win (back-compat shims may pre-populate).
    originator_ws: callerMetadata.originator_ws ?? stamp.originator_ws,
    originator_cwd: callerMetadata.originator_cwd ?? stamp.originator_cwd,
    // Named explicitly, like every other field here: this block copies the
    // stamp key by key, so a key that is not listed never reaches the row and
    // the footer's AGENT row goes silently missing.
    originator_runtime:
      callerMetadata.originator_runtime ?? stamp.originator_runtime,
    originator_session_id:
      callerMetadata.originator_session_id ?? stamp.originator_session_id,
    originator_thread_id:
      callerMetadata.originator_thread_id ?? stamp.originator_thread_id,
    recipient_surface:
      callerMetadata.recipient_surface ?? stamp.recipient_surface,
  };
  if (process.env.HELM_AGENT_SESSION_REQUIRED === "1" && !metadata.session_id) {
    return {
      ok: false,
      error: {
        code: "missing_session_id",
        message: "Agent outbound message is missing session_id.",
        hint: "Helm requires agent-backed outbound messages to carry session_id. Check SessionStart hooks and agent run session capture.",
      },
    };
  }
  const row = {
    message_id: opts.message_id || null, // stamped after idempotency lookup
    thread_id: threadId,
    workspace_id: scope.scope_id,
    kind,
    target,
    target_class: targetClass,
    transport: parsed.scheme,
    subject: payload.subject ?? null,
    body: payload.body ?? null,
    body_preview: bodyPreview(payload.body),
    sender: payload.sender || {
      agent_id: null,
      agent_name: null,
      workspace_id: scope.scope_id,
    },
    scheduled_for: scheduledFor,
    status: "pending",
    idempotency_key: opts.idempotency_key || null,
    metadata,
    tags: payload.tags || ["message"],
    reason: payload.reason || null,
    created_at: nowIso(),
  };
  return { ok: true, row };
}

// resolveTransport returns the registered driver for a target URI or an
// error envelope. Used by message() but exported so the wake-shim can probe
// transport availability without going through message().
export function resolveTransport(target) {
  const parsed = parseTargetUri(target);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: parsed.reason || "target_invalid",
        message: `Invalid --target: ${target}.`,
        hint: "See helm-tasks message --help-json for valid URI shapes.",
      },
    };
  }
  const driver = getTransport(parsed.scheme);
  if (!driver) {
    return {
      ok: false,
      error: {
        code: "unknown_transport",
        message: `No transport driver registered for scheme '${parsed.scheme}'.`,
        hint: `Registered schemes: ${listRegisteredSchemes().join(", ")}. (Phase 1 registers the registry only; drivers land in Phase 2-4.)`,
      },
    };
  }
  return { ok: true, driver, scheme: parsed.scheme, parsed };
}

// recordCanonicalRow — stamps message_id + idempotency_key, runs collision
// check, writes the canonical row + thread row + transport_state row.
// Idempotent: a second call with the same canonical-row inputs returns the
// prior row + existing: true (no duplicate write, no duplicate transport
// delivery — Plan §6.1 idempotency contract span).
export function recordCanonicalRow(
  scope,
  draftRow,
  {
    explicitIdempotencyKey = null,
    scheduledForVolatile = false,
    expectedMessageId = null,
  } = {},
) {
  const wsCheck = validateWorkspaceId(scope.scope_id);
  if (!wsCheck.ok) {
    return {
      ok: false,
      error: {
        code: "workspace_id_required",
        message: "scope.scope_id is required.",
        hint: "Resolve a scope before invoking the kernel.",
      },
    };
  }
  // PRFAQ-0-4 Phase 1 — fail closed on missing Appendix B metadata. This is
  // the substrate's guarantee that round-trip is honored on every outbound
  // send. Inbound rows are normalized through parseInboundEnvelope and skip.
  const validation = validateOutboundMetadata(draftRow);
  if (!validation.ok) {
    appendActivityEvent({
      type: "substrate_kernel_outbound_metadata_invalid",
      level: "error",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      data: {
        error_code: validation.error.code,
        kind: draftRow.kind,
        transport: draftRow.transport,
      },
    });
    return validation;
  }
  const candidateKey =
    explicitIdempotencyKey || deriveKey(draftRow, { scheduledForVolatile });
  const collision = collisionCheck(scope, candidateKey, draftRow, {
    scheduledForVolatile,
    expectedMessageId,
  });
  if (!collision.ok) {
    appendActivityEvent({
      type: "substrate_kernel_idempotency_collision",
      level: "error",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      data: {
        idempotency_key: candidateKey,
        conflicting_field: collision.error.code,
      },
    });
    return { ok: false, error: collision.error };
  }
  if (collision.prior) {
    // idempotency hit — return the prior row.
    appendActivityEvent({
      type: "substrate_kernel_idempotency_hit",
      level: "debug",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      data: {
        idempotency_key: candidateKey,
        message_id: collision.prior.message_id,
      },
    });
    return { ok: true, row: collision.prior, existing: true };
  }
  const messageId = draftRow.message_id || makeMessageId();
  const finalRow = {
    ...draftRow,
    message_id: messageId,
    idempotency_key: candidateKey,
  };

  // Ensure thread row exists (or refresh last_active_at). Thread upsert
  // happens BEFORE message append so the thread is always discoverable when
  // a subscriber receives the message.created event.
  //
  // Persist the canonical thread before transport dispatch, but activate its
  // owner only after the provider has accepted the outbound and its identity
  // is durable.
  const priorThread = getThread(scope, finalRow.thread_id);
  const isOutboundOriginator = finalRow.metadata?.source !== "inbound_webhook";
  const ownerSessionId =
    finalRow.metadata?.originator_session_id ||
    finalRow.metadata?.session_id ||
    null;
  const threadPatch = {
    thread_id: finalRow.thread_id,
    workspace_id: finalRow.workspace_id,
    target_class: finalRow.target_class,
    created_at: priorThread?.created_at || finalRow.created_at,
    last_active_at: finalRow.created_at,
  };
  if (priorThread?.owner_session_id) {
    threadPatch.owner_session_id = priorThread.owner_session_id;
  }

  // Sev-2 2026-05-22 (codename-grove resume break) — owner-integrity signal.
  // An outbound that CREATES a thread but resolves no session is unresumable
  // by construction: there is no owner_session_id, so any later inbound reply
  // will spawn a fresh session instead of resuming this one. Emit a loud,
  // operator-visible event the moment it happens (rather than discovering it
  // when a reply mis-routes). The drop/continuity alarm observes this type.
  if (isOutboundOriginator && !priorThread && !ownerSessionId) {
    appendActivityEvent({
      type: "thread_created_without_owner",
      level: "warn",
      scope_id: scope?.scope_id ?? null,
      cwd: scope?.cwd ?? null,
      data: {
        message_id: finalRow.message_id,
        thread_id: finalRow.thread_id,
        target: finalRow.target,
        target_class: finalRow.target_class,
        kind: finalRow.kind,
        reason:
          "outbound created a thread with no resolvable session_id; thread is not resumable",
      },
    });
  }
  upsertThread(scope, threadPatch);

  if (
    isOutboundOriginator &&
    finalRow.transport === "email" &&
    ownerSessionId
  ) {
    const claim = claimThreadIdentity(
      scope,
      finalRow.thread_id,
      ownerSessionId,
    );
    if (!claim.ok) {
      return {
        ok: false,
        error: {
          code: claim.reason || "thread_owner_claim_failed",
          message: `Email thread ${finalRow.thread_id} is already bound to another session.`,
          hint: "Only the session that established this thread may send on it.",
        },
      };
    }
  }

  appendMessage(scope, finalRow);
  updateTransportState(scope, messageId, {
    transport: finalRow.transport,
    delivery_state: "pending",
  });
  appendActivityEvent({
    type: "substrate_kernel_message_persist",
    level: "info",
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    data: {
      message_id: messageId,
      thread_id: finalRow.thread_id,
      transport: finalRow.transport,
      kind: finalRow.kind,
    },
  });
  return { ok: true, row: finalRow, existing: false };
}
function activateAcceptedEmailThread(scope, row, deliveryResult) {
  if (
    row.transport !== "email" ||
    !["sent", "delivered"].includes(deliveryResult?.deliveryState) ||
    !deliveryResult?.external_id ||
    !deliveryResult?.external_thread_id
  ) {
    return getThread(scope, row.thread_id);
  }
  const ownerSessionId =
    row.metadata?.originator_session_id || row.metadata?.session_id || null;
  if (!ownerSessionId) return getThread(scope, row.thread_id);
  const activated = activateThreadIdentity(
    scope,
    row.thread_id,
    ownerSessionId,
    deliveryResult.external_thread_id,
  );
  if (!activated.ok) {
    const err = new Error(
      activated.reason === "external_thread_mismatch"
        ? "Provider reply diverged from the durable tldr; email thread."
        : "Email thread ownership changed before provider acceptance was committed.",
    );
    err.code = activated.reason || "thread_identity_activation_failed";
    err.hint = "Use the bounded owner-facing recovery flow before retrying.";
    err.ambiguous = true;
    throw err;
  }
  return activated.thread;
}

function releaseEmailThreadClaim(scope, row) {
  if (row.transport !== "email") return;
  const ownerSessionId =
    row.metadata?.originator_session_id || row.metadata?.session_id || null;
  if (!ownerSessionId) return;
  releaseThreadIdentityClaim(scope, row.thread_id, ownerSessionId);
}

// PRFAQ-0-1.1 — 1 email thread = 1 agent session invariant.
//
// Pre-composition gate. When the caller is replying on an email thread that
// was minted by a different session, the substrate FAILS CLOSED: it returns a
// blocked error instead of
// silently re-routing the send to a fresh thread.
//
// GH#15 — the prior behavior auto-coerced kind=reply --thread <id> to a new
// thread and sent successfully, silently diverging from the agent's stated
// intent (the operator received an orphan duplicate; the named thread got
// nothing). Per feedback_bug_not_workaround.md silent divergence from agent
// intent is a bug. The fail-loud path here aligns with
// feedback_helm_protect_from_self.md: make hard-to-debug silent thread-
// divergence impossible to author. Coffee has no multi-session override or
// ownership-transfer path.
//
// Returns { kind, opts, payload, blocked: null } when the send may proceed,
// or { blocked: <error> } when it must be refused (message() returns the
// error verbatim).
function applyOneThreadOneSessionInvariant({
  kind,
  target,
  opts,
  payload,
  scope,
}) {
  if (kind !== "reply") return { kind, opts, payload, blocked: null };
  if (!scope) return { kind, opts, payload, blocked: null };
  const parsed = parseTargetUri(target);
  if (!parsed.ok || parsed.scheme !== "email") {
    return { kind, opts, payload, blocked: null };
  }
  const callerMeta = payload?.metadata || {};
  const threadId = opts?.thread_id || parsed.threadId || null;
  if (!threadId) return { kind, opts, payload, blocked: null };
  const writerSessionId = resolveWriterSessionId(callerMeta);
  const check = assertOwningSessionForReply(scope, threadId, writerSessionId);
  if (check.ok) {
    return {
      kind,
      opts,
      payload: { ...payload, metadata: callerMeta },
      blocked: null,
    };
  }
  // Mismatch — fail closed. Do NOT coerce to a new thread; the agent's
  // stated intent (reply on this thread) is honored or refused, never
  // silently rewritten.
  const detail = {
    reason: "one_thread_one_session_invariant",
    thread_id: threadId,
    owner_session_id: check.owner_session_id || null,
    writer_session_id: check.writer_session_id || null,
    blocked_at: nowIso(),
  };
  appendActivityEvent({
    type: "substrate_kernel_cross_session_reply_blocked",
    level: "warn",
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    data: detail,
  });
  return {
    kind,
    opts,
    payload,
    blocked: {
      code:
        check.reason === "thread_owner_missing"
          ? "thread_owner_missing"
          : "thread_not_owned_by_session",
      message: `Reply on thread ${threadId} refused: it is owned by a different agent session${check.owner_session_id ? ` (${check.owner_session_id})` : ""}. The 1-thread-1-session invariant will not fan a second session into an existing email thread.`,
      hint:
        check.reason === "thread_owner_missing"
          ? "This thread has no durable tldr; owner; use the bounded recovery flow."
          : "Only the session that established this thread may reply.",
    },
  };
}

function applyExactEmailSessionOwner({ target, payload, opts, scope }) {
  const parsed = parseTargetUri(target);
  if (!parsed.ok || parsed.scheme !== "email") {
    return { ok: true, payload, opts };
  }
  const resolver =
    typeof opts.session_owner_resolver === "function"
      ? opts.session_owner_resolver
      : resolveOutboundEmailSessionOwner;
  const resolved = resolver({ pid: process.pid });
  if (!resolved.ok) {
    appendActivityEvent({
      type: "agent_session_owner_resolution_failed",
      level: "error",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      message: `failed to bind outbound email to a live agent session: ${resolved.error || "missing_agent_session_owner"}`,
      data: {
        target_scheme: "email",
        message_pid: process.pid,
        ancestry: resolved.ancestry || [],
        env_candidates: resolved.env_candidates || [],
        candidate_sessions: resolved.candidates || [],
        failure_reason: resolved.error || "missing_agent_session_owner",
        cwd: scope.cwd,
      },
    });
    return {
      ok: false,
      error: {
        code: resolved.error || "missing_agent_session_owner",
        message:
          "Outbound email refused: Helm could not bind this send to the live agent session that invoked helm-tasks message.",
        hint: "Check runtime session env and SessionStart/UserPromptSubmit hook artifacts under ~/.helm/sessions.",
      },
    };
  }
  appendActivityEvent({
    type: "agent_session_owner_resolved",
    level: "debug",
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    message: `resolved outbound email owner ${resolved.session_id} from PID ${resolved.selected_pid}`,
    data: {
      target_scheme: "email",
      message_pid: process.pid,
      selected_session_id: resolved.session_id,
      selected_pid: resolved.selected_pid,
      ancestry_depth: resolved.ancestry_depth,
      source_field: resolved.source_field,
    },
  });
  const metadata = {
    ...(payload?.metadata || {}),
    session_id: resolved.session_id,
    originator_session_id: resolved.session_id,
    controlling_tty: resolved.identity?.controlling_tty || null,
  };
  return {
    ok: true,
    payload: { ...payload, metadata },
    opts: {
      ...opts,
      sender_session_id: opts.sender_session_id || resolved.session_id,
    },
  };
}

// message — the canonical primitive. Resolves transport, derives /
// validates idempotency, writes the canonical row, hands off to the
// resolved TransportDriver.send(), publishes message.created, returns the
// UX §2 success-payload triple.
export async function message(input) {
  const { target, schedule, scope } = input || {};
  let { kind, payload = {}, opts = {} } = input || {};
  if (!scope || typeof scope !== "object") {
    return {
      ok: false,
      error: {
        code: "scope_required",
        message: "scope is required.",
        hint: "Resolve a scope before invoking message().",
      },
    };
  }
  appendActivityEvent({
    type: "substrate_kernel_message_submit",
    level: "info",
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    data: { kind, target },
  });

  const transport = resolveTransport(target);
  if (!transport.ok) return { ok: false, error: transport.error };

  const ownerGate = applyExactEmailSessionOwner({
    target,
    payload,
    opts,
    scope,
  });
  if (!ownerGate.ok) return { ok: false, error: ownerGate.error };
  payload = ownerGate.payload;
  opts = ownerGate.opts;

  const reserved = applyReservedDelivery({ kind, payload, opts });
  if (!reserved.ok) return reserved;
  payload = reserved.payload;
  opts = reserved.opts;

  // PRFAQ-0-1.1 invariant — must run before composeCanonicalRow. GH#15: a
  // cross-session reply without the override fails closed here, before any
  // canonical row is written or any transport send is attempted.
  const invariant = applyOneThreadOneSessionInvariant({
    kind,
    target,
    opts,
    payload,
    scope,
  });
  if (invariant.blocked) {
    return { ok: false, error: invariant.blocked };
  }
  kind = invariant.kind;
  opts = invariant.opts;
  payload = invariant.payload;

  const candidateThreadId =
    opts?.thread_id || transport.parsed?.threadId || null;
  const shouldCheckUnread =
    candidateThreadId &&
    (kind === "reply" ||
      (kind === "new" && Boolean(getThread(scope, candidateThreadId))));
  if (shouldCheckUnread) {
    const senderSessionId = opts.sender_session_id || null;
    const counterKey = tupleKey({
      target,
      threadId: candidateThreadId,
      senderSessionId,
    });
    const unreadCheck = checkUnreadBeforeDispatch({
      scope,
      threadId: candidateThreadId,
      sessionId: senderSessionId,
      target,
      idempotencyKey: opts.idempotency_key || null,
    });
    if (!unreadCheck.ok) {
      const attempt = recordBlockedAttempt({ scope, tupleKey: counterKey });
      const maxRetries = Number.isFinite(Number(opts.max_blocked_retries))
        ? Number(opts.max_blocked_retries)
        : undefined;
      const repeated = shouldEscalateToRepeated({
        scope,
        tupleKey: counterKey,
        maxRetries,
      });
      const code = repeated ? "blocked_unread_repeated" : "blocked_unread";
      appendActivityEvent({
        type: "comms_outbound_blocked",
        level: repeated ? "error" : "warn",
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        data: {
          thread_id: candidateThreadId,
          unread_count: unreadCheck.data?.unread_count ?? null,
          attempt: attempt.attempt,
          tuple_key: counterKey,
          idempotency_key: opts.idempotency_key || null,
        },
      });
      return {
        ok: false,
        error: {
          code,
          message: repeated
            ? `Outbound dispatch blocked repeatedly by unread inbound on thread ${candidateThreadId}.`
            : `Outbound dispatch blocked by unread inbound on thread ${candidateThreadId}.`,
          hint:
            unreadCheck.data?.hint ||
            `helm-tasks inbox get ${unreadCheck.data?.latest_message_id || "<message-id>"}`,
        },
        data: unreadCheck.data,
      };
    }
    clearBlockedAttempt({ scope, tupleKey: counterKey });
  }

  const composed = composeCanonicalRow({
    kind,
    target,
    schedule,
    payload,
    scope,
    opts,
  });
  if (!composed.ok) return { ok: false, error: composed.error };

  // Volatile schedules must not mint a fresh identity when time moves.
  const scheduledForVolatile =
    !schedule?.at || schedule?.type === "now" || schedule?.type === "in";
  const recorded = recordCanonicalRow(scope, composed.row, {
    explicitIdempotencyKey: opts.idempotency_key || null,
    scheduledForVolatile,
    expectedMessageId: reserved.messageId,
  });
  if (!recorded.ok) return { ok: false, error: recorded.error };

  const finalRow = recorded.row;
  const failedRetry = prepareFailedDeliveryRetry({
    scope,
    row: finalRow,
    existing: recorded.existing && !isBeaconOutboundEffect(finalRow),
  });
  let threadRow = getThread(scope, finalRow.thread_id);

  let deliveryResult = null;
  let outboundEffect = null;
  if (
    !recorded.existing ||
    failedRetry.retrying ||
    isBeaconFailedDefiniteRetry(finalRow, opts.outbound_effect)
  ) {
    const guard = await guardOutbound({
      route: "substrate.message",
      channel: finalRow.transport,
      sideEffectKind: "transport_send",
      scope,
      data: {
        message_id: finalRow.message_id,
        thread_id: finalRow.thread_id,
        target_class: finalRow.target_class,
      },
    });
    if (guard.suppressed) {
      if (!failedRetry.retrying)
        updateTransportState(scope, finalRow.message_id, {
          transport: finalRow.transport,
          delivery_state: "suppressed",
          external_id: null,
          error: guard.reason,
        });
      if (!failedRetry.retrying) releaseEmailThreadClaim(scope, finalRow);
      threadRow = getThread(scope, finalRow.thread_id);
      deliveryResult = { deliveryState: "suppressed", outboundGuard: guard };
      publish({
        kind: EVENT_KIND.MESSAGE_CREATED,
        workspace_id: scope.scope_id,
        data: { message: finalRow, thread: threadRow },
      });
      return {
        ok: true,
        data: {
          message: { ...finalRow, existing: recorded.existing },
          thread: threadRow,
          activation: null,
          outbound_guard: guard,
        },
      };
    }
    if (isBeaconOutboundEffect(finalRow)) {
      outboundEffect = prepareCanonicalOutboundEffect(
        finalRow,
        opts?.outbound_effect,
      );
      if (!outboundEffect.allowed) {
        if (recorded.existing) {
          return {
            ok: true,
            data: {
              message: { ...finalRow, existing: true },
              thread: threadRow,
              activation: null,
              outbound_effect: outboundEffect,
            },
          };
        }
        updateTransportState(scope, finalRow.message_id, {
          transport: finalRow.transport,
          delivery_state:
            outboundEffect.status === "blocked" ? "blocked" : "suppressed",
          external_id: null,
          error: outboundEffect.reason,
        });
        releaseEmailThreadClaim(scope, finalRow);
        threadRow = getThread(scope, finalRow.thread_id);
        publish({
          kind: EVENT_KIND.MESSAGE_CREATED,
          workspace_id: scope.scope_id,
          data: { message: finalRow, thread: threadRow },
        });
        if (outboundEffect.status === "blocked") {
          return {
            ok: false,
            error: {
              code: outboundEffect.reason,
              message: `Outbound side effect blocked: ${outboundEffect.reason}.`,
              hint: "Inspect outbound_effects and reconcile the side effect explicitly.",
            },
          };
        }
        return {
          ok: true,
          data: {
            message: { ...finalRow, existing: recorded.existing },
            thread: threadRow,
            activation: null,
            outbound_effect: outboundEffect,
          },
        };
      }
    }
    if (guard.mode === "dry_run") {
      if (outboundEffect) {
        recordBeaconOutboundEffectFailure({
          sideEffectKey: outboundEffect.side_effect_key,
          ambiguous: false,
          error: "dry_run",
        });
      }
      if (!failedRetry.retrying)
        updateTransportState(scope, finalRow.message_id, {
          transport: finalRow.transport,
          delivery_state: "dry_run",
          external_id: null,
          error: "outbound_dry_run",
        });
      if (!failedRetry.retrying) releaseEmailThreadClaim(scope, finalRow);
      threadRow = getThread(scope, finalRow.thread_id);
      publish({
        kind: EVENT_KIND.MESSAGE_CREATED,
        workspace_id: scope.scope_id,
        data: { message: finalRow, thread: threadRow },
      });
      return {
        ok: true,
        data: {
          message: { ...finalRow, existing: recorded.existing },
          thread: threadRow,
          activation: null,
          outbound_guard: guard,
          ...(outboundEffect ? { outbound_effect: outboundEffect } : {}),
        },
      };
    }
    const retryStart = failedRetry.begin();
    if (!retryStart.ok) return retryStart;
    try {
      deliveryResult = await transport.driver.send(finalRow, { scope });
      if (deliveryResult && deliveryResult.deliveryState) {
        updateTransportState(scope, finalRow.message_id, {
          transport: finalRow.transport,
          delivery_state: deliveryResult.deliveryState,
          external_id: deliveryResult.external_id || null,
          external_thread_id: deliveryResult.external_thread_id || null,
          error: deliveryResult.error || null,
        });
        threadRow = activateAcceptedEmailThread(
          scope,
          finalRow,
          deliveryResult,
        );
        if (
          finalRow.transport === "email" &&
          (deliveryResult.deliveryState === "sent" ||
            deliveryResult.deliveryState === "delivered")
        ) {
          const replyWaitingSessionId =
            finalRow.metadata?.originator_session_id ||
            finalRow.metadata?.session_id ||
            null;
          recordAcceptedEmailPostSendEffects({
            sessionId: replyWaitingSessionId,
            row: finalRow,
            tldrAgentReplyCandidate: opts?.tldr_agent_reply_candidate === true,
          });
        }
      }
      if (outboundEffect) {
        recordBeaconOutboundEffectSuccess({
          sideEffectKey: outboundEffect.side_effect_key,
          providerMessageId: deliveryResult?.external_id || null,
        });
      }
    } catch (err) {
      const ambiguous = isAmbiguousTransportError(err);
      if (outboundEffect) {
        recordBeaconOutboundEffectFailure({
          sideEffectKey: outboundEffect.side_effect_key,
          ambiguous,
          error: err?.code || err?.message || String(err),
        });
      }
      updateTransportState(scope, finalRow.message_id, {
        transport: finalRow.transport,
        delivery_state: ambiguous ? "ambiguous" : "failed",
        error: err && err.message ? err.message : String(err),
      });
      releaseEmailThreadClaim(scope, finalRow);
      appendActivityEvent({
        type: "substrate_kernel_transport_send_failed",
        level: "error",
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        error: err,
        data: {
          message_id: finalRow.message_id,
          transport: finalRow.transport,
          code: err?.code || null,
        },
      });
      // GH#16 — propagate the transport's own error taxonomy instead of
      // flattening every failure to a generic transport_send_failed with a
      // useless hint. The email driver already shapes specific codes/messages/
      // hints (e.g. "no resolvable parent AgentMail message-id", auth errors);
      // discarding them is what made replies in the owning workspace opaque.
      return {
        ok: false,
        error: {
          code: err?.code || "transport_send_failed",
          message:
            err?.message || `Transport ${finalRow.transport} send failed.`,
          hint: err?.hint || "Inspect transport_state.error and retry.",
          ...(ambiguous ? { ambiguous: true } : {}),
        },
      };
    }
    publish({
      kind: EVENT_KIND.MESSAGE_CREATED,
      workspace_id: scope.scope_id,
      data: { message: finalRow, thread: threadRow },
    });
  }

  return {
    ok: true,
    data: {
      message: { ...finalRow, existing: recorded.existing },
      thread: threadRow,
      activation: deliveryResult?.activation || null,
      ...(outboundEffect ? { outbound_effect: outboundEffect } : {}),
    },
  };
}

// reply — sugar over message(kind: 'reply'). Resolves the thread first to
// derive the correct target URI for transports that need it (email://addr
// where the URI doesn't carry the thread id).
export async function reply(threadId, input) {
  const { scope, payload = {}, opts = {}, schedule } = input || {};
  if (!scope)
    return {
      ok: false,
      error: {
        code: "scope_required",
        message: "scope is required.",
        hint: "Resolve a scope before invoking reply().",
      },
    };
  const thread = getThread(scope, threadId);
  if (!thread) {
    return {
      ok: false,
      error: {
        code: "thread_required",
        message: `Thread ${threadId} not found.`,
        hint: 'Pass an existing thread_id; create a new thread via message({ kind: "new" }).',
      },
    };
  }
  // Compose the target URI from the thread's target_class. agent-session
  // carries the thread id in the URI; email/inbox use --thread (opts).
  const target =
    input.target ||
    (thread.target_class === "agent-session"
      ? `agent-session://${threadId}`
      : `${thread.target_class}://${thread.workspace_id}`);
  return message({
    kind: "reply",
    target,
    schedule,
    payload,
    scope,
    opts: { ...opts, thread_id: threadId },
  });
}
