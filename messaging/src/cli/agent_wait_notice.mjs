// What the ack gate needs from agent commands (ac-jfv.156).
//
// `agent wait`: whether the message the wait returned is a user's own notice.
// The wait records it beside its message id in ONE action-store mutation
// (recordWaitMessage in agent_wait_journal.mjs) and PostToolUse arms the gate on
// it, so a user message that arrives during a wait gates the next call even
// when nothing was staged. The wait also arms the gate itself (armWaitResult):
// the installed PostToolUse shell hook exits before any JavaScript runs when
// nothing is staged.
//
// `agent receive`, `reply`, `ack`, `update`, `complete`, `cancel`, `decline`,
// `delegate --at` and the low-level `ack`: once the daemon confirmed
// the receive or the reply, the local `read/` and `replied/` markers record it
// (the PreToolUse verdict reads only these files). Local file work only, no
// extra daemon request; best effort: never fails the command.

import { logAckGateOpened, markAckGateReplied } from "../protocol/ack_gate.mjs";
import { neutralizeAckBody } from "../protocol/ack_gate_copy.mjs";
import {
  markAckGateRead,
  snapshotAckGateReceived,
} from "../protocol/ack_gate_read.mjs";
import { armWaitNotice } from "./hook_ack_arm.mjs";
import { readActionStore } from "./agent_action_store.mjs";
import { readWaitEnvelope, sameOwner } from "./agent_wait_journal.mjs";

/** `{ message_id, user_notice }` this wait recorded for the session, or null. */
export function readWaitNotice(session, actionId) {
  if (!actionId) return null;
  const entry = readWaitEnvelope(readActionStore(session), session, actionId);
  return sameOwner(entry, session) && entry.message_id
    ? { message_id: entry.message_id, user_notice: entry.user_notice === true }
    : null;
}

/**
 * Arms the gate for the user notice an `agent wait` is returning, from the
 * session paths the CLI resolved for this caller. Best effort: a failure is
 * logged to ack-gate.log (armWaitNotice) and never fails the wait.
 */
export function armWaitResult(session, messageId) {
  if (!session.ack_gate_paths) return false;
  const ctx = {
    paths: session.ack_gate_paths,
    identity: { session_id: session.session_id },
    payload: {},
    copilotInput: null,
  };
  try {
    return armWaitNotice(ctx, messageId, debugLog);
  } catch (error) {
    process.stderr.write(
      `tightbeam: ack gate arm failed: ${error.code || error.message}\n`,
    );
    return false;
  }
}

function debugLog(fields) {
  if (process.env.TIGHTBEAM_HOOK_DEBUG)
    process.stderr.write(
      `${JSON.stringify({ component: "tightbeam-agent", ...fields })}\n`,
    );
}

// A gate step failed: one structured line on stderr and one in ack-gate.log; the command goes on.
function gateFailed(session, error, { event, ...extra }) {
  const code = error.code || error.message;
  debugLog({ event: `ack_gate_${event}`, stack: error.stack });
  process.stderr.write(
    `${JSON.stringify({ component: "tightbeam-agent", event: `ack_gate_${event}`, status: "warn", error: code, ...extra })}\n`,
  );
  try {
    logAckGateOpened(session.ack_gate_paths, {
      reason: event,
      event: `ack_gate.${event}`,
      messageIds: extra.message_ids ?? [],
      extra: { error: code },
    });
  } catch {
    // stderr above already carries it
  }
}

// What the read refusal shows, from a `message.receive` result (message_receive.mjs: no subject or sender there today).
const readFields = (result) => ({
  subject: result.conversation_subject ?? result.subject ?? null,
  conversation_id: result.conversation_id ?? null,
  thread:
    typeof result.conversation_id === "string"
      ? result.conversation_id.replace(/^[^_]+_/, "").slice(0, 8)
      : null,
  work_id: result.work_id ?? null,
  ack_pending: result.ack_pending === true,
  ...(result.sender_label ? { sender_label: result.sender_label } : {}),
  // Stored as shown (capped, " [truncated]" kept): the copy re-applies it unchanged, and the verdict never parses a full body.
  body: neutralizeAckBody(result.body),
});

/** `agent receive` returned `result`: write `read/<message_id>`. */
export function recordAckGateRead(session, result) {
  if (!session.ack_gate_paths || typeof result?.message_id !== "string") return;
  try {
    if (
      markAckGateRead(
        session.ack_gate_paths,
        result.message_id,
        readFields(result),
      )
    )
      debugLog({
        event: "ack_gate_marker_written",
        kind: "read",
        message_ids: [result.message_id],
      });
  } catch (error) {
    gateFailed(session, error, {
      event: "marker_failed",
      kind: "read",
      message_ids: [result.message_id],
    });
  }
}

/** The daemon saved a reply or ack for `messageIds` in `conversationId`: write `replied/<id>` (thread siblings included) and open them. */
export function recordAckGateReplied(session, messageIds, thread) {
  if (!session.ack_gate_paths) return;
  try {
    const marked = markAckGateReplied(
      session.ack_gate_paths,
      messageIds,
      thread,
    );
    if (marked.length > 0)
      debugLog({
        event: "ack_gate_marker_written",
        kind: "replied",
        message_ids: marked,
      });
  } catch (error) {
    gateFailed(session, error, {
      event: "marker_failed",
      kind: "replied",
      message_ids: messageIds,
    });
  }
}

/** update, complete, cancel or decline committed `result`: the work's user message is answered too (replied, never re-armed). Returns `result`. */
export function recordAckGateClosed(session, { chain, command, result }) {
  recordAckGateReplied(session, [chain.user_origin_message_id], {
    conversationId: chain.conversation_id,
    received: command.ackGateReceived,
  });
  return result;
}

/**
 * The ids this session had received (a visible `read/` marker) before the
 * command's first daemon request, with their conversations
 * (snapshotAckGateReceived). Only reply, ack, update, complete, cancel, decline and delegate --at mark replies;
 * every other command gets [] without a read. A failure is logged and yields [] (no sibling marked).
 */
export function ackGateReceivedBefore(session, command) {
  const marks =
    ["reply", "ack", "update", "complete", "cancel", "decline"].includes(
      command.command,
    ) ||
    (command.command === "delegate" && Boolean(command.wakeAt));
  if (!marks || !session.ack_gate_paths) return [];
  try {
    return snapshotAckGateReceived(session.ack_gate_paths);
  } catch (error) {
    gateFailed(session, error, { event: "snapshot_failed" });
    return [];
  }
}

/**
 * The low-level `ack <id> --endpoint <e>` was saved: it answers the user, so
 * `replied/<id>` opens this session's gate when `e` is this session's own
 * endpoint (`loadSession()` resolves it; another session's gate is not ours).
 * Never throws.
 */
export function recordLowLevelAck(loadSession, payload) {
  let session;
  try {
    session = loadSession();
  } catch (error) {
    debugLog({
      event: "ack_gate_low_level_ack_skipped",
      reason: error.code || error.message,
    });
    return;
  }
  if (session.endpoint_id === payload.endpoint_id)
    recordAckGateReplied(session, [payload.message_id], {});
}

/**
 * After an agent command the daemon confirmed: receive writes `read/`, reply
 * writes `replied/` for its message and the received ids of its conversation
 * (ack and delegate --at mark their own user message). Local file work only:
 * no daemon request. Other commands touch nothing. Never throws.
 */
export function recordAckGateAfter(session, { command, result }) {
  if (command.command === "receive") recordAckGateRead(session, result);
  else if (command.command === "reply")
    recordAckGateReplied(session, [command.messageId], {
      conversationId: result?.conversation_id,
      received: command.ackGateReceived,
    });
}
