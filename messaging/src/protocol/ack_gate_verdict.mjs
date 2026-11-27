// The ack-first gate's verdict (ac-jfv.156): expiry, a clock behind arming,
// corruption and the refusal cap are decided here, PER MESSAGE ID, from the lock-free files
// of ack_gate.mjs (see its header for the layout and the invariant). One id
// spending its 3 refusals or 5 minutes escapes alone; the others keep gating.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertOwnFiles,
  closed,
  escapeAckGate,
  names,
  readAckGate,
  slot,
} from "./ack_gate.mjs";

export const ACK_GATE_REFUSAL_CAP = 3;
export const ACK_GATE_EXPIRY_MS = 5 * 60 * 1000;

// Parallel calls read the clock before another process's slot lands: a step back under this is not a clock anomaly.
const CLOCK_SLACK_MS = 1000;

// The newest stamp of this arm's refusal slots (names `<ms>-<pid>-<rand>`; earlier arms' are below armed-at), 0 when none.
const newestSlot = (paths, item) =>
  Math.max(
    0,
    ...names(slot(paths, "refusals", item.message_id))
      .map((name) => Number.parseInt(name, 10))
      .filter((ms) => ms >= item.armed_at_epoch_ms),
  );

// `corrupt`, `clock_back` or `expired` once this id's own 5 minutes ran out (a corrupt
// stamp is 0), else null. clock_back is any clock anomaly: now behind armed-at, or
// more than 1 s behind this arm's newest slot stamp (a step back after a refusal).
// Either way the id escapes at once (fails open), so no refusal comes after it.
const spentReason = (paths, item, at) => {
  if (item.corrupt) return "corrupt";
  if (
    at <
    Math.max(item.armed_at_epoch_ms, newestSlot(paths, item) - CLOCK_SLACK_MS)
  )
    return "clock_back";
  return at >= item.armed_at_epoch_ms + ACK_GATE_EXPIRY_MS ? "expired" : null;
};

// Escapes `entries` ([{ id, reason }]) one reason at a time: `[{ reason, messageIds, escaped, failed, error }]`.
function escapeEntries(paths, entries) {
  const reasons = [...new Set(entries.map((entry) => entry.reason))];
  return reasons.map((reason) => {
    const messageIds = entries
      .filter((entry) => entry.reason === reason)
      .map((entry) => entry.id);
    return { reason, messageIds, ...escapeAckGate(paths, messageIds) };
  });
}

/**
 * Takes one refusal slot under `refusals/<id>/` before the call is decided,
 * then counts that id's slots (own included). Only this id's directory is
 * touched, so a verdict never spends another message's budget. A slot counts
 * only when stamped at or after the id's own armed-at (`item.armed_at_epoch_ms`):
 * a leftover of an earlier gate never does.
 * The stamp is clamped to armed-at: a clock that steps back after arming still counts this slot, so the cap holds.
 */
function takeSlot(paths, item, now) {
  const id = item.message_id;
  const dir = slot(paths, "refusals", id);
  const stamp = Math.max(now(), item.armed_at_epoch_ms);
  const file = path.join(
    dir,
    `${stamp}-${process.pid}-${randomBytes(3).toString("hex")}`,
  );
  try {
    fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A reclaim removed the (empty) directory, or it never existed: make it, once more.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
  }
  return { id, file, count: countSlots(dir, item.armed_at_epoch_ms) };
}

const countSlots = (dir, armedAt) =>
  names(dir).filter((name) => Number.parseInt(name, 10) >= armedAt).length;

/** Gives reserved slots back (the call was allowed, or never refused). */
export const releaseAckGateRefusal = (slots) => {
  for (const reserved of slots) fs.rmSync(reserved.file, { force: true });
};

/**
 * The verdict's first step, from the files alone. Statuses:
 *   none      nothing is armed
 *   opened    nothing live is left: every id escaped (`reason`, `escapes`), or an
 *             escape could not be persisted; the caller logs and allows this boundary
 *   reserved  slots are held (`slots`, `count` = the highest per-id count,
 *             `messageIds` = the live ids); `escapes` lists ids that escaped now
 * An id over its cap or past its 5 minutes escapes alone. Its fourth
 * reservation opens it, so a burst may open early but never yields more than
 * 3 refusals per id.
 */
export function beginAckGateVerdict(paths, { now = Date.now } = {}) {
  assertOwnFiles(paths);
  const gate = readAckGate(paths);
  if (!gate) return { status: "none" };
  const at = now();
  const spent = [];
  const slots = [];
  for (const item of gate.items) {
    const reason = spentReason(paths, item, at);
    if (reason) spent.push({ id: item.message_id, reason });
    else slots.push(takeSlot(paths, item, now));
  }
  const capped = slots.filter((taken) => taken.count > ACK_GATE_REFUSAL_CAP);
  releaseAckGateRefusal(capped);
  const escapes = escapeEntries(paths, [
    ...spent,
    ...capped.map((taken) => ({ id: taken.id, reason: "refusal_cap" })),
  ]);
  const live = slots.filter((taken) => !capped.includes(taken));
  // An escape that could not be persisted leaves its id armed: this boundary is allowed, never refused.
  if (live.length === 0 || escapes.some((out) => out.failed.length > 0)) {
    releaseAckGateRefusal(live);
    return { status: "opened", reason: escapes[0].reason, escapes };
  }
  return {
    status: "reserved",
    slots: live,
    count: Math.max(...live.map((taken) => taken.count)),
    messageIds: live.map((taken) => taken.id),
    escapes,
  };
}

/**
 * Re-reads the gate right before a refusal: of the reserved `slots`, keeps
 * those still armed and inside their 5 minutes (`live`, each with its `armedAt`). The others' slots go
 * back; an id whose time ran out escapes (`escapes`, as beginAckGateVerdict).
 * If such an escape could not be persisted, every slot goes back and `opened`
 * is set (`live` empty): the boundary is allowed.
 */
export function recheckAckGateSlots(paths, slots, { now = Date.now } = {}) {
  const items = new Map(
    (readAckGate(paths)?.items ?? []).map((item) => [item.message_id, item]),
  );
  const at = now();
  const spent = slots
    .filter((taken) => items.has(taken.id))
    .map((taken) => ({
      id: taken.id,
      reason: spentReason(paths, items.get(taken.id), at),
    }))
    .filter((entry) => entry.reason);
  const live = slots.filter(
    (taken) =>
      items.has(taken.id) && !spent.some((entry) => entry.id === taken.id),
  );
  releaseAckGateRefusal(slots.filter((taken) => !live.includes(taken)));
  const escapes = escapeEntries(paths, spent);
  // An escape that could not be persisted allows this boundary, as in beginAckGateVerdict.
  if (escapes.some((out) => out.failed.length > 0)) {
    releaseAckGateRefusal(live);
    return { live: [], escapes, opened: true };
  }
  const armedAt = (taken) => items.get(taken.id).armed_at_epoch_ms;
  return {
    live: live.map((taken) => ({
      ...taken,
      armedAt: armedAt(taken),
      bodyShown: items.get(taken.id).body_shown, // R4: the reply copy
    })),
    escapes,
  };
}

/**
 * T4, step 1 of 2, BEFORE any arm (Codex R21): takes one refusal slot for the
 * notice's id, so no failure ever leaves an arm to undo. The slot is stamped
 * with one clock reading `at`, clamped up to an existing arm's armed-at; the
 * caller arms with that same `at`, so the slot is never stamped before the
 * armed-at it counts under (no clock_back, counted toward the cap, and never
 * reclaimed while armed). Statuses:
 *   reserved  `slot` is held, `at` is the arm time to use
 *   opened    answered or escaped (`gone`, no slot taken), or spent (`reason`
 *             refusal_cap, expired, clock_back, corrupt: it escaped, `escapes`)
 */
export function reserveAckGateNotice(
  paths,
  messageId,
  { now = Date.now } = {},
) {
  assertOwnFiles(paths);
  if (closed(paths, messageId)) return gone([]);
  const at = now();
  const item = readAckGate(paths)?.items.find(
    (entry) => entry.message_id === messageId,
  ) ?? { message_id: messageId, armed_at_epoch_ms: at, corrupt: false };
  const reason = spentReason(paths, item, at);
  return reason
    ? openedBy(paths, messageId, reason)
    : noticeSlot(paths, item, at);
}

// The slot, stamped `at` (clamped up to armed-at); a 4th escapes the id.
function noticeSlot(paths, item, at) {
  const taken = takeSlot(paths, item, () => at);
  if (taken.count <= ACK_GATE_REFUSAL_CAP)
    return { status: "reserved", slot: taken, at };
  releaseAckGateRefusal([taken]);
  return openedBy(paths, item.message_id, "refusal_cap");
}

/**
 * T4, step 2 of 2, after the arm (whatever it returned or threw): from the
 * files alone, the slot is reserved when the id is armed and live, the slot is
 * stamped at or after the armed-at in place (a racer may have armed later), and
 * the id's count is still within the cap. Else the slot goes back: `opened`.
 */
export function confirmAckGateNotice(paths, taken, { now = Date.now } = {}) {
  const { live, escapes } = recheckAckGateSlots(paths, [taken], { now });
  if (live.length === 0) return gone(escapes, escapes[0]?.reason);
  const dir = path.dirname(taken.file);
  const armedAt = live[0].armedAt;
  const count = countSlots(dir, armedAt);
  if (
    count <= ACK_GATE_REFUSAL_CAP &&
    Number.parseInt(path.basename(taken.file), 10) >= armedAt
  )
    return { status: "reserved", slot: taken, count };
  releaseAckGateRefusal([taken]);
  return count > ACK_GATE_REFUSAL_CAP
    ? openedBy(paths, taken.id, "refusal_cap")
    : gone([]);
}

const gone = (escapes, reason = "gone") => ({
  status: "opened",
  reason,
  escapes,
});

const openedBy = (paths, id, reason) => ({
  status: "opened",
  reason,
  escapes: escapeEntries(paths, [{ id, reason }]),
});
