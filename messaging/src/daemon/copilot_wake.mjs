// Daemon side of the Copilot permission-authority carrier (acp-78o.153.1).
// A Copilot endpoint that Academy launched keeps the permission mode it was
// launched under. The resumer wakes it only through Academy's managed-resume
// consumer under that stored mode, and refuses, leaving the delivery pending,
// whenever the mode is missing, unusable or cannot run `agent receive`. No
// path here defaults a mode, starts a new session, or admits a replacement.

import { copilotRecipePrefix } from "../cli/copilot_hook_runtime.mjs";
import { TightbeamError } from "../protocol/envelope.mjs";
import { isSafeRuntimeId } from "../runtimes/registry.mjs";
import {
  ACADEMY_AGENT_NAME_PATTERN,
  buildCopilotSpawnInvocation,
  buildCopilotWakeInvocation,
  COPILOT_WAKE_SESSION_ID,
  hasWakeVehicle,
  isAcademyPermissionMode,
  isPackageBoundCopilotRecord,
  WAKE_MESSAGE_ID,
} from "../runtimes/copilot_wake_contract.mjs";
import { buildAssertActivePayload } from "./ops/resume_claim.mjs";

export const WAKE_PERMISSION_UNAVAILABLE =
  "copilot_wake_permission_unavailable";
export const WAKE_PERMISSION_CANNOT_RECEIVE =
  "copilot_wake_permission_cannot_receive";
export const WAKE_PERMISSION_INVALID = "copilot_wake_permission_invalid";
export const WAKE_IDENTITY_UNAVAILABLE = "copilot_wake_identity_unavailable";
export const COPILOT_SESSION_UNAVAILABLE = "copilot_session_unavailable";
const WAKE_ATTENTION_SOURCE = "resume.copilot_wake_refused";

// Academy prints this before any prompt when Copilot cannot load the session.
const COPILOT_LOAD_FAILURE =
  /Resource not found: Session [0-9a-f-]{36} not found/i;

export function copilotLoadFailed(stderr) {
  return typeof stderr === "string" && COPILOT_LOAD_FAILURE.test(stderr);
}

/** The package-bound Copilot record behind a stored runtime, or false. */
export function isCopilotWakeRuntime(registry, storedRuntime) {
  return isPackageBoundCopilotRecord(registry?.get?.(storedRuntime));
}

/**
 * endpoint.register's `academy_permission_mode`: null, or one of the three
 * modes for the package-bound Copilot record with an Academy agent name.
 */
export function normalizeAcademyPermissionMode(
  payload,
  { wakeRuntime, academyAgentName },
) {
  const value = payload.academy_permission_mode ?? null;
  if (value === null) return null;
  if (
    !isAcademyPermissionMode(value) ||
    !wakeRuntime ||
    academyAgentName === null
  ) {
    throw new TightbeamError(
      "malformed_request",
      "academy_permission_mode must be approve-all, approve-reads or deny-all, and only the package-bound Copilot runtime with an Academy agent name may carry it",
      { field: "academy_permission_mode" },
    );
  }
  return value;
}

// A replay with no captured owner proves nothing about who holds the session,
// so a stored mode that differs from what arrived is stale authority: clear it.
// Equal values and an already-NULL mode are left alone, never elevated.
export function clearUnprovenPermissionMode(context, endpointId, incomingMode) {
  const cleared = context.db
    .prepare(
      "UPDATE endpoints SET academy_permission_mode = NULL WHERE id = ? AND academy_permission_mode IS NOT NULL AND academy_permission_mode IS NOT ?",
    )
    .run(endpointId, incomingMode).changes;
  if (cleared === 0) return;
  context.logger?.info({
    event: "endpoint_permission_mode_cleared",
    endpoint_id: endpointId,
    params: { reason: "owner_unproven_mismatch", incoming_mode: incomingMode },
    result: "cleared",
    status: "ok",
  });
}

/** The first invalid Academy column of a stored/imported endpoint row, or null. */
export function invalidAcademyField(endpoint) {
  const mode = endpoint.academy_permission_mode;
  if (mode !== null && mode !== undefined && !isAcademyPermissionMode(mode)) {
    return "academy_permission_mode";
  }
  const name = endpoint.academy_agent_name;
  const valid =
    name === null ||
    name === undefined ||
    (typeof name === "string" && ACADEMY_AGENT_NAME_PATTERN.test(name));
  return valid ? null : "academy_agent_name";
}

/** The same ids and name checks the registration applies, for stored data. */
export function normalizeAcademyAgentName(value) {
  if (value === null || value === undefined) return null;
  if (!ACADEMY_AGENT_NAME_PATTERN.test(value)) {
    throw new TightbeamError(
      "malformed_request",
      "academy_agent_name must be a valid Academy specialist name when present",
      { field: "academy_agent_name" },
    );
  }
  return value;
}

/**
 * Candidate-query scope for wake runtimes: a Copilot endpoint is selected
 * only with an Academy agent name AND the confirmed exit of its recorded
 * owner. Without that proof a live (or unobserved) ACP process may still
 * hold the session, and a second writer must never be started. A sessionless
 * named placeholder has no session to hold, so it needs no proof. Ids come
 * from the registry and are safe-id checked before they reach the SQL text.
 */
export function copilotWakeScopeSql(records) {
  const ids = records.map((record) => record.id).filter(isSafeRuntimeId);
  if (ids.length === 0) return "1 = 1";
  const list = ids.map((id) => `'${id}'`).join(",");
  return `(e.runtime NOT IN (${list}) OR (e.academy_agent_name IS NOT NULL AND (e.owner_process_exited_at IS NOT NULL OR e.provider_session_id IS NULL)))`;
}

const MODE_REFUSALS = Object.freeze({
  usable: null,
  absent: WAKE_PERMISSION_UNAVAILABLE,
  invalid: WAKE_PERMISSION_INVALID,
  cannot_receive: WAKE_PERMISSION_CANNOT_RECEIVE,
});

function modeKind(mode) {
  if (mode === null || mode === undefined) return "absent";
  if (!isAcademyPermissionMode(mode)) return "invalid";
  return hasWakeVehicle(mode) ? "usable" : "cannot_receive";
}

function sessionIsExact(request) {
  return (
    ACADEMY_AGENT_NAME_PATTERN.test(request.academy_agent_name ?? "") &&
    COPILOT_WAKE_SESSION_ID.test(request.session_id ?? "") &&
    request.session_id === request.endpoint_session_id
  );
}

function messageIdsAreExact(messageIds) {
  return (
    messageIds.length > 0 &&
    messageIds.every((id) => typeof id === "string" && WAKE_MESSAGE_ID.test(id))
  );
}

function identityIsExact(request, messageIds) {
  return sessionIsExact(request) && messageIdsAreExact(messageIds);
}

// Identity first, then the stored mode; null means the wake may proceed.
function refusalFor(request, messageIds) {
  if (!identityIsExact(request, messageIds)) return WAKE_IDENTITY_UNAVAILABLE;
  return MODE_REFUSALS[modeKind(request.academy_permission_mode)];
}

function isSessionlessNamed(request) {
  return (
    !request.session_id &&
    !request.endpoint_session_id &&
    ACADEMY_AGENT_NAME_PATTERN.test(request.academy_agent_name ?? "")
  );
}

// A placeholder has no stored mode: Academy stamps approve-all when it adopts.
// It has no session yet either, so its commands cannot state a session binding:
// the brief keeps the renderer's default prefix (the installed front door), as
// any session's commands do before its first hook runs.
function planNamedSpawn(
  request,
  messageIds,
  { externalMessageIds, briefFor, pendingContext },
) {
  if (!messageIdsAreExact(messageIds))
    return {
      refusal: {
        reason: WAKE_IDENTITY_UNAVAILABLE,
        attentionSource: WAKE_ATTENTION_SOURCE,
      },
    };
  const prompt = briefFor({
    messageId: messageIds[0],
    messageIds,
    externalMessageIds,
    pendingContext,
  });
  return {
    invocation: buildCopilotSpawnInvocation({
      agentName: request.academy_agent_name,
      prompt,
    }),
  };
}

/**
 * The wake decision for one candidate request. null: not a wake runtime, the
 * builtin path applies. `{ refusal }`: a typed pre-claim refusal. Otherwise
 * the Academy invocation built from the stored mode; its stdin is added after
 * the claim exists (see `wakeStdin`).
 */
export function planCopilotWake({
  record,
  request,
  messageIds,
  externalMessageIds,
  briefFor,
  pendingContext = new Map(),
}) {
  if (!isPackageBoundCopilotRecord(record)) return null;
  const plan = isSessionlessNamed(request) ? planNamedSpawn : planResumeWake;
  return plan(request, messageIds, {
    record,
    externalMessageIds,
    briefFor,
    pendingContext,
  });
}

// The resumed session is known, so the first input states the same session
// binding the live Copilot hook renders (the manifest has no verified session
// variable); the identity check above has already vouched for the session id.
function planResumeWake(
  request,
  messageIds,
  { record, externalMessageIds, briefFor, pendingContext },
) {
  const reason = refusalFor(request, messageIds);
  if (reason !== null)
    return { refusal: { reason, attentionSource: WAKE_ATTENTION_SOURCE } };
  const prompt = briefFor({
    messageId: messageIds[0],
    messageIds,
    externalMessageIds,
    pendingContext,
    prefix: copilotRecipePrefix(record.id, request.session_id),
  });
  return {
    invocation: buildCopilotWakeInvocation({
      agentName: request.academy_agent_name,
      sessionId: request.session_id,
      mode: request.academy_permission_mode,
      prompt,
    }),
  };
}

/**
 * Ends a refused wake: the request fails with its typed reason and its root
 * (if any) needs attention. The delivery is untouched and still pending.
 * `ops` carries the resumer's own failure and notice writers.
 */
export function refuseCopilotWake({
  context,
  request,
  refusal,
  now,
  ops: { failRequest, stageTerminalFailureNotice },
}) {
  failRequest(context.db, { requestId: request.id, now, refusal });
  stageTerminalFailureNotice(context, { requestId: request.id });
  context.logger?.warn({
    event: "resume.copilot_wake_refused",
    params: {
      resume_request_id: request.id,
      endpoint_id: request.endpoint_id,
      runtime: request.runtime,
      request_reason: request.reason,
    },
    result: {
      reason: refusal.reason,
      outcome: "failed",
      delivery: "pending",
      permission_mode: request.academy_permission_mode ?? null,
    },
    status: "refused",
  });
  return 1;
}

/**
 * The consumer's stdin: the same nine-field assert-active payload
 * resume.claim returns, for the claim just taken, read from the endpoint row.
 */
export function wakeStdin(db, request, claim) {
  const endpoint = db
    .prepare(
      "SELECT provider_session_id, process_generation, owner_epoch, owner_launch_token FROM endpoints WHERE id = ?",
    )
    .get(request.endpoint_id);
  return `${JSON.stringify(buildAssertActivePayload(db, { id: request.id, endpoint_id: request.endpoint_id, ...endpoint }, claim.token))}\n`;
}
