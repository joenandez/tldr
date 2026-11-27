// Where the ack-first gate arms (ac-jfv.156): each entry path that shows the
// user's own message to the agent records it as armed through here. Arming is
// best effort and never blocks the notice being shown. Eligibility: only a
// user-origin, non-typed notice arms (`isUserNotice`, the `typed=` tag attribute,
// the daemon's `unread_from_user`, the wait envelope's `user_notice` flag).

import {
  armAckGate,
  isUserNotice,
  logAckGateOpened,
} from "../protocol/ack_gate.mjs";
import {
  OPENING_TAG,
  attributeIds,
  parseBodyMessageIds,
} from "../protocol/arrival_block.mjs";
import { sessionPaths } from "../protocol/session_paths.mjs";
import { bodyShownIds } from "./arrival_notification.mjs";
import { resolveRuntime, resolveSessionId } from "./hook_identity.mjs";

/** A call from the main session of a non-Copilot runtime: the only kind the gate acts on. */
export const isGatedSession = (ctx) =>
  !ctx.payload?.agent_id && !ctx.copilotInput;

// The notice goes out without a gate: say why in ack-gate.log, where the gate's other fail-opens are.
function recordArmFailure(ctx, ids, { source, error, log }) {
  try {
    logAckGateOpened(ctx.paths, {
      reason: "arm_failed",
      messageIds: ids,
      event: "ack_gate.arm_failed",
      extra: { source, error: error.code || error.message },
    });
  } catch (logError) {
    log({
      event: "ack_gate_log_failed",
      session_id: ctx.identity.session_id,
      reason: "arm_failed",
      status: "error",
      error: logError.code || logError.message,
      stack: logError.stack,
    });
  }
}

// True when something was armed; false for nothing to arm, an escaped id, or a failed write.
// `bodyShown`: the ids whose body the arming block rendered (R4); none by default.
function arm(ctx, ids, { source, log, bodyShown }) {
  if (ids.length === 0 || !isGatedSession(ctx) || !ctx.paths?.ackGateDir)
    return false;
  try {
    const armed = armAckGate(ctx.paths, ids, {
      now: ctx.ackGateNow,
      bodyShown,
    });
    log({
      event: armed.length > 0 ? "ack_gate_armed" : "ack_gate_arm_skipped",
      session_id: ctx.identity.session_id,
      source,
      ...(armed.length > 0 ? {} : { reason: "escaped" }),
      message_ids: ids,
    });
    return armed.length > 0;
  } catch (error) {
    // Arming is best effort: a failed write must not lose the notice that is being shown.
    log({
      event: "ack_gate_arm_failed",
      session_id: ctx.identity.session_id,
      source,
      status: "error",
      error: error.code || error.message,
      stack: error.stack,
    });
    recordArmFailure(ctx, ids, { source, error, log });
    return false;
  }
}

/** P1 to P5: notification entries that were shown; only user messages arm (not typed notices). */
export function armShownEntries(ctx, entries, { source, log, bodyShown }) {
  return arm(
    ctx,
    entries.filter(isUserNotice).map((entry) => entry.message_id),
    { source, log, bodyShown },
  );
}

/**
 * The ids a `<tldr_messages ... external="..." typed="...">` tag lists as the
 * user's own messages: `external` minus `typed` (a typed delegation, replacement
 * or cancel notice is user-origin but asks nothing). Typed input has no tag, so none.
 */
export function parseGateMessageIds(text) {
  if (typeof text !== "string") return [];
  const ids = [];
  for (const [tag] of text.matchAll(OPENING_TAG)) {
    const typed = new Set(attributeIds(tag, "typed"));
    ids.push(...attributeIds(tag, "external").filter((id) => !typed.has(id)));
  }
  return [...new Set(ids)];
}

/** P6: a prompt carrying an arrival tag arms its gate-eligible ids. Typed input has no tag. */
export function armPromptNotices(ctx, prompt, log) {
  return arm(ctx, parseGateMessageIds(prompt), {
    source: "user_prompt",
    log,
    bodyShown: new Set(parseBodyMessageIds(prompt)),
  });
}

/**
 * P6 when the credential file cannot be read (malformed, loose mode): the
 * runtime and session come from the payload and environment the normal path
 * uses (`resolveRuntime`, `resolveSessionId`), never from credentials, and the
 * tagged prompt arms before the caller rethrows the credential error. With the
 * session known but no runtime resolvable, `arm_failed` (no_runtime) goes to
 * ack-gate.log; with no session, nothing can be recorded.
 */
export function armPromptWithoutCredentials(
  { stateRoot, payload, env, flags, registry },
  log,
) {
  let ctx = null;
  const ids = parseGateMessageIds(payload?.prompt);
  try {
    const explicit = flags.runtime || env.TIGHTBEAM_RUNTIME;
    // Without a runtime the session still resolves through the full env chain, so the failure can be logged where the gate lives.
    const runtime = resolveRuntime({ payload, env, registry, explicit });
    const sessionId = resolveSessionId({ payload, env, registry, runtime });
    ctx = sessionId
      ? {
          paths: sessionPaths(stateRoot, sessionId),
          identity: { session_id: sessionId },
          payload,
          copilotInput: null,
        }
      : null;
    if (ctx && runtime) return armPromptNotices(ctx, payload?.prompt, log);
    if (ctx) throw new Error("no_runtime");
    return false;
  } catch (error) {
    log({
      event: "ack_gate_arm_failed",
      source: "user_prompt",
      status: "error",
      error: error.code || error.message,
      stack: error.stack,
    });
    if (ctx && ids.length > 0)
      recordArmFailure(ctx, ids, { source: "user_prompt", error, log });
    return false;
  }
}

/**
 * P3: a Stop block for an unread message arms it only when the decision says it
 * is a user's own message (`unread_from_user`, set by the daemon): an agent's
 * message or a typed notice never arms.
 */
export function armStopBlock(ctx, decision, log) {
  if (
    typeof decision?.unread_message_id !== "string" ||
    decision.unread_from_user !== true
  )
    return false;
  return arm(ctx, [decision.unread_message_id], {
    source: "stop_block",
    log,
  });
}

/** P7: the message an `agent wait` returned, when the wait recorded it as a user's own notice. */
export function armWaitNotice(ctx, messageId, log) {
  return arm(ctx, [messageId], { source: "wait_result", log });
}

/**
 * Arms the gate (no refusal counted) for the shown notice. Call before marking
 * the watermark seen. False means nothing was armed (the id escaped, or the
 * write failed). T4 decides from the files after it, whatever it returned (confirmAckGateNotice).
 */
export function armNoticeRefusal(ctx, entry, log) {
  return armShownEntries(ctx, [entry], {
    source: "pre_tool_use",
    log,
    bodyShown: bodyShownIds([entry]), // the entry as the block renders it (R4)
  });
}
