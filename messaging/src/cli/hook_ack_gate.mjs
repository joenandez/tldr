// The hook CLI's half of the ack-first gate (ac-jfv.156). State and refusal
// copy live in protocol/; this module turns the local files into a refusal
// (exit 2) or an open gate before a main-session tool call.
//
// No hook waits on the daemon: the verdict reads only `ack.gate/` (armed ids,
// their refusal slots, and the `read/` markers `agent receive` wrote). An id
// leaves the gate when an agent command records its reply (`replied/`), or
// escapes once it spent 3 refusals or 5 minutes. Expiry, corruption and the
// refusal cap are decided in protocol/ack_gate_verdict.mjs.
//
// Copilot never arms and never refuses (out of scope); a subagent call (payload
// `agent_id`) is never refused or counted.

import { isUserNotice, logAckGateOpened } from "../protocol/ack_gate.mjs";
import { hasAckGateRead, readAckGateRead } from "../protocol/ack_gate_read.mjs";
import {
  MAX_SHOWN,
  readRefusalText,
  shownRefusalText,
  unreadRefusalText,
} from "../protocol/ack_gate_copy.mjs";
import {
  beginAckGateVerdict,
  confirmAckGateNotice,
  recheckAckGateSlots,
  reserveAckGateNotice,
} from "../protocol/ack_gate_verdict.mjs";
import { armNoticeRefusal } from "./hook_ack_arm.mjs";
import { asRendered } from "./arrival_notification.mjs";
import { tightbeamRecipeCommand } from "./package_context.mjs";

function openGate(
  ctx,
  { reason, messageIds, log, event = "ack_gate.opened", extra = {} },
) {
  try {
    logAckGateOpened(ctx.paths, { reason, messageIds, event, extra });
  } catch (error) {
    log({
      event: "ack_gate_log_failed",
      session_id: ctx.identity.session_id,
      reason,
      status: "error",
      error: error.code || error.message,
      stack: error.stack,
    });
  }
  log({
    event:
      event === "ack_gate.opened"
        ? "ack_gate_opened"
        : "ack_gate_escape_failed",
    session_id: ctx.identity.session_id,
    reason,
    message_ids: messageIds,
  });
}

// Logs what an escape did: one `opened` line for the ids that left the gate, one
// `escape_failed` line for those that stayed armed (their marker could not be made).
function reportEscape(ctx, outcome, log) {
  if (outcome.escaped.length > 0)
    openGate(ctx, { reason: outcome.reason, messageIds: outcome.escaped, log });
  if (outcome.failed.length > 0)
    openGate(ctx, {
      reason: "escape_failed",
      messageIds: outcome.failed,
      log,
      event: "ack_gate.escape_failed",
      extra: {
        intended_reason: outcome.reason,
        error: outcome.error?.code || outcome.error?.message,
      },
    });
}

const reportEscapes = (ctx, escapes, log) => {
  for (const outcome of escapes) reportEscape(ctx, outcome, log);
};

function refuse(text) {
  process.stderr.write(`${text}\n`);
  process.exitCode = 2;
}

const clockOf = (ctx) => ({ now: ctx.ackGateNow });

// One re-read right before refusing: an id answered after begin (unarmed) or
// whose 5 minutes ran out since (escaped, logged) gets its slot back and is not refused.
function stillLive(ctx, begun, log) {
  const rechecked = recheckAckGateSlots(ctx.paths, begun.slots, clockOf(ctx));
  reportEscapes(ctx, rechecked.escapes, log);
  return rechecked;
}

/**
 * PreToolUse while something is armed, from local files only: no client, no
 * drain, no deadline. Returns
 *   null                        nothing is armed: the caller goes on as usual;
 *   `{ ackGate: "opened", ... }`  every live id escaped (cap, expiry, clock_back, corruption): allowed;
 *   `{ ackGate: "stale", ... }`   every reserved id was answered meanwhile: slots released, allowed;
 *   `{ refused: true, ... }`    after writing the refusal to stderr with exit 2.
 * An armed id with no `read/` marker refuses with "read it first"; else the
 * read refusal shows the messages. A refusal keeps its slots.
 */
export function localAckGateVerdict(ctx, { log }) {
  const begun = beginAckGateVerdict(ctx.paths, clockOf(ctx));
  if (begun.status === "none") return null;
  reportEscapes(ctx, begun.escapes ?? [], log);
  if (begun.status === "opened")
    return { ackGate: "opened", reason: begun.reason, message_ids: [] };
  return refuseLive(ctx, begun, log);
}

/**
 * Stop with no identity yet has no daemon to ask, so an armed gate holds the
 * turn from local files, under the same per-id cap and expiry as PreToolUse
 * (a hold takes a refusal slot, so it ends after 3 or 5 minutes). Returns
 * null when nothing live is armed, else the block, after exit 2.
 */
export function localStopAckHold(ctx, { log }) {
  const live = liveArmed(ctx, log);
  const ids = live.map((taken) => taken.id);
  if (ids.length === 0) return null;
  const prefix = ctx.recipePrefix ?? tightbeamRecipeCommand();
  // R4: an id whose body was shown is answered directly; else receive it first.
  const next = live[0].bodyShown
    ? `Reply command: ${prefix} agent reply --message ${ids[0]} --body "<reply>"`
    : `Receive command: ${prefix} agent receive --message ${ids[0]}`;
  const reason = `[tldr] Do not end the turn yet: a user is waiting for your reply to ${ids.join(", ")}.\n${next}`;
  log({
    event: "ack_gate_stop_held",
    session_id: ctx.identity.session_id,
    message_ids: ids,
  });
  refuse(reason);
  return {
    blocked: true,
    message_ids: ids,
    output: { decision: "block", reason },
  };
}

// Live armed slots (id, bodyShown), oldest first, after taking and re-checking them; [] when none is live.
function liveArmed(ctx, log) {
  const begun = beginAckGateVerdict(ctx.paths, clockOf(ctx));
  reportEscapes(ctx, begun.escapes ?? [], log);
  const rechecked =
    begun.status === "reserved" ? stillLive(ctx, begun, log) : { live: [] };
  if (rechecked.opened) return [];
  return rechecked.live.sort(
    (a, b) => a.armedAt - b.armedAt || (a.id < b.id ? -1 : 1),
  );
}

// Refuses for the reserved ids still live after the re-read; none left is allowed.
function refuseLive(ctx, begun, log) {
  // Existence only: bodies are read below for the ids the refusal shows.
  const read = new Set(
    begun.messageIds.filter((id) => hasAckGateRead(ctx.paths, id)),
  );
  // Oldest armed first, as notices are shown and armed: the unread refusal names what receive gives next.
  const rechecked = stillLive(ctx, begun, log);
  if (rechecked.opened)
    return { ackGate: "opened", reason: "escape_failed", message_ids: [] };
  const live = rechecked.live.sort(
    (a, b) => a.armedAt - b.armedAt || (a.id < b.id ? -1 : 1),
  );
  const ids = live.map((taken) => taken.id);
  if (live.length === 0) {
    log({
      event: "ack_gate_stale_verdict",
      session_id: ctx.identity.session_id,
      message_ids: begun.messageIds,
    });
    return { ackGate: "stale", message_ids: [] };
  }
  const unreadSlot = live.find((taken) => !read.has(taken.id));
  const unread = unreadSlot && { message_id: unreadSlot.id };
  const prefix = ctx.recipePrefix ?? tightbeamRecipeCommand();
  const gate = unread ? "unread" : "read";
  log({
    event: "ack_gate_refused",
    session_id: ctx.identity.session_id,
    gate,
    body_shown: Boolean(unreadSlot?.bodyShown),
    refusals: Math.max(...live.map((taken) => taken.count)),
    message_ids: ids,
  });
  refuse(
    unread
      ? (unreadSlot.bodyShown ? shownRefusalText : unreadRefusalText)(unread, {
          prefix,
        })
      : readRefusalText(
          ids.map((id, i) => ({
            ...(i < MAX_SHOWN ? readAckGateRead(ctx.paths, id) : null),
            message_id: id,
          })),
          { prefix },
        ),
  );
  return { refused: true, gate, message_ids: ids };
}

/**
 * T4 for one notice: slot first, then the arm (Codex R21), so no path ever
 * removes an arm. True: refuse with the notice (its slot is kept, refusal 1).
 * False: the caller stages the notice: the id is answered or escaped, spent (a
 * 4th slot escapes it with `refusal_cap`, logged), its slot failed (nothing was
 * armed), or the arm failed or was skipped (the slot goes back; one a failure
 * strands is an orphan, reclaimed once 10 minutes old). An arm left live is
 * always one this call refuses with, so a staged notice is never gated.
 * Contract (a): never throws; a failure is logged once and returns false.
 */
export function reserveNoticeRefusal(ctx, entry, log) {
  try {
    const taken = reserveAckGateNotice(
      ctx.paths,
      entry.message_id,
      clockOf(ctx),
    );
    reportEscapes(ctx, taken.escapes ?? [], log);
    if (taken.status !== "reserved") return false;
    // The slot's own clock reading: the slot is never stamped before the armed-at it counts under.
    armNoticeRefusal({ ...ctx, ackGateNow: () => taken.at }, entry, log);
    const out = confirmAckGateNotice(ctx.paths, taken.slot, clockOf(ctx));
    reportEscapes(ctx, out.escapes ?? [], log);
    return out.status === "reserved"; // a failure after this only wastes a slot: fewer refusals, never more
  } catch (error) {
    log({
      event: "ack_gate_notice_slot_failed",
      session_id: ctx.identity.session_id,
      status: "error",
      error: error.code || error.message,
      stack: error.stack,
      message_ids: [entry.message_id],
    });
    return false;
  }
}

/**
 * T4 for each user notice, in order: the ones that took a refusal slot. Each
 * arms as the block of those before it renders it, so its body_shown is exact (R4).
 */
export function reserveNoticeRefusals(ctx, entries, log) {
  const reserved = [];
  for (const entry of entries.filter(isUserNotice)) {
    const rendered = asRendered(reserved, entry, { prefix: ctx.recipePrefix });
    if (reserveNoticeRefusal(ctx, rendered, log)) reserved.push(entry);
  }
  return reserved;
}

const NOTICE_LEAD =
  "[tldr] This tool call did not run: a user message just arrived. Read it, reply to it, then repeat the call.";

/** Writes the notice as the refusal. Last step, so any earlier failure leaves the notice retryable. */
export function showNoticeRefusal(ctx, noticeText) {
  refuse(`${NOTICE_LEAD}\n${noticeText}`);
}
