// The ack-first gate's local state (ac-jfv.156); refusal copy: ack_gate_copy.mjs, verdict: ack_gate_verdict.mjs, read/ markers: ack_gate_read.mjs. Lives in src/protocol/
// because the hook CLI and the daemon-side proof tools may both import it.
//
// "A user notice was shown, a reply is owed." The CLI writes the state;
// hooks/pre-tool-use only tests whether `armed/` holds an entry, and the CLI
// verdict reads these files only: no hook waits on the daemon. The agent
// commands write `read/` and `replied/` once the daemon confirmed the receive or
// the reply; that is local file work, never an extra daemon request.
//
// Lock-free by construction: every state fact is ONE file that is only created
// (exclusively) or unlinked, and neither can tear. No lock. The one exception is
// armed/<id> gaining `body_shown` by an atomic rename that keeps its time (ack_gate_shown.mjs).
//
//   sessions/<id>/ack.gate/armed/<message_id>    content `<armed_at_epoch_ms>\n`, then `body_shown\n` when the arming block showed
//                                                its body (ac-kf9rt R4); at most 512 (a notice past that is not armed: armed_cap)
//   sessions/<id>/ack.gate/escaped/<message_id>  empty marker: this id never arms again
//   sessions/<id>/ack.gate/refusals/<message_id>/<ms>-<pid>-<rand>   one empty file per reserved refusal
//   sessions/<id>/ack.gate/read/<message_id>     one JSON line: what the read refusal shows (agent receive wrote it);
//                                                written only while armed/<id> is live, unlinked when the id is
//                                                answered or escapes, else reclaimed after 5 minutes
//   sessions/<id>/ack.gate/replied/<message_id>  empty marker: the daemon saved a reply or ack; never arms again
//   sessions/<id>/ack-gate.log                   one JSON line per open / fail-open (append only)
//
// The bounds are PER MESSAGE: each armed id owes a first reply for at most 3
// refusals and 5 minutes from its own arming. A session stays gated while any
// armed id is inside its bounds; a new user message starts its own budget.
// Clearing, expiring or capping one id never moves another's start or count,
// and a verdict only ever writes slots under the ids it read, so an old verdict
// cannot spend a newer message's budget. An id escapes once (arm re-checks
// `escaped/` after it creates, escape creates `escaped/` before it unlinks, so
// one of them always sees the other), and it is refused at most 3 times: its
// slot is created BEFORE the refusal is decided and counted after, so parallel
// hooks cannot all pass a check (the verdict is local; there is no daemon call).
// An id's count is the slots stamped at or after ITS armed-at, so a leftover
// slot of an earlier gate never counts.
// BOUND: when any writer returns, armed/, read/, replied/ and escaped/ each hold
// at most 512 message ids and nothing past its age limit; concurrent writers
// may overshoot only while both are inside the call. Rule: every writer of a
// marker directory runs the reclaim AFTER its write. armed/ is never trimmed
// (an armed id is never dropped silently): its bound is the admission check
// plus a recount after publish that unlinks only the caller's own new file.
// read/ is also bounded by armed/ (written only while its id is live).
// refusals/<id>/ is bounded by the cap plus concurrent racers (the id escapes
// at the cap). An armed id's slots are never reclaimed, so its count only grows
// until it is answered or escapes; any other id's go once 10 minutes old.
// The reclaim runs on every gate read and after every write, hygiene only and never recursive: `.tmp` files older than 60 s in every directory, read
// markers older than 5 minutes, escaped and replied markers older than 24 h
// (an id re-presented a day later may gate again), the oldest entries of a
// marker directory over 512, the slots as above, and the slot directories that
// are empty (an answered id's slots are removed at once, file by file). See
// ack_gate_reclaim.mjs.
// `paths` is the object `sessionPaths()` returns; writers re-check their files sit in its directory.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { markBodyShown } from "./ack_gate_shown.mjs";
import {
  ALL_SLOTS,
  MARKER_CAP,
  reclaimAckGate,
  reclaimSlots,
} from "./ack_gate_reclaim.mjs";
import { isSafeSessionId } from "./session_paths.mjs";

// A message id is also a file name: nothing but this shape arms.
export const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,80}$/;
// A bounded decimal with no leading zero: 10 to 15 digits, always a safe integer.
const EPOCH_MS = /^[1-9][0-9]{9,14}$/;

/** A user's own message shown as itself: user origin, not a typed delegation / replacement / cancel notice (the daemon calls those not_gated). */
export const isUserNotice = (entry) =>
  entry?.has_external_origin === true &&
  (entry.notice === undefined || entry.notice === null);

export function assertOwnFiles(paths) {
  const session = path.basename(paths.dir);
  const inside = (file) =>
    typeof file === "string" && path.dirname(file) === paths.dir;
  if (
    !isSafeSessionId(session) ||
    ![paths.ackGateDir, paths.ackGateLog].every(inside)
  ) {
    throw new Error(`unsafe ack gate path under ${JSON.stringify(paths.dir)}`);
  }
}

export const slot = (paths, kind, name = "") =>
  path.join(paths.ackGateDir, kind, name);
export const ensure = (paths, kind) =>
  fs.mkdirSync(slot(paths, kind), { recursive: true, mode: 0o700 });

export function names(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return []; // a file in the way holds no entries
    throw error;
  }
}

// Creates `file` with its whole content or not at all, never half written: the
// content goes to a dot-named temporary file, then a hard link publishes it
// (link fails with EEXIST when `file` exists; a reader never sees a prefix).
export function createWhole(file, text) {
  const temporary = path.join(
    path.dirname(file),
    `.${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    fs.linkSync(temporary, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Runs the reclaim (ack_gate_reclaim.mjs) on every gate read, arm and read-marker write; returns the armed listing.
export function reclaimGate(paths) {
  const kinds = ["armed", "escaped", "refusals", "read", "replied"];
  const dirs = Object.fromEntries(
    kinds.map((kind) => [kind, slot(paths, kind)]),
  );
  const listing = Object.fromEntries(
    kinds.map((kind) => [kind, names(dirs[kind])]),
  );
  reclaimAckGate(dirs, listing);
  return listing.armed;
}

/**
 * The armed ids, or null when nothing is armed: `{ items: [{ message_id,
 * armed_at_epoch_ms, corrupt }] }`. Every id has its own start; an unreadable
 * timestamp counts as 0 and flags that item `corrupt` (so it is spent). An
 * armed id that also escaped is not armed (and is cleaned up). A read also
 * reclaims stale temporaries, old escaped markers and orphaned slots.
 */
export function readAckGate(paths) {
  const armed = reclaimGate(paths);
  const items = armed
    .filter((name) => MESSAGE_ID.test(name))
    .map((name) => armedItem(paths, name))
    .filter(Boolean);
  return items.length === 0 ? null : { items };
}

// An id that escaped or was answered never arms (again).
export const closed = (paths, id) =>
  fs.existsSync(slot(paths, "escaped", id)) ||
  fs.existsSync(slot(paths, "replied", id));

// One armed file as an item; null when it is gone, escaped or answered (its armed file is cleaned up).
function armedItem(paths, name) {
  if (closed(paths, name)) {
    fs.rmSync(slot(paths, "armed", name), { force: true });
    fs.rmSync(slot(paths, "read", name), { force: true });
    return null;
  }
  try {
    const [stamp, flag] = fs
      .readFileSync(slot(paths, "armed", name), "utf8")
      .trim()
      .split("\n");
    const valid = EPOCH_MS.test(stamp);
    return {
      message_id: name,
      armed_at_epoch_ms: valid ? Number(stamp) : 0,
      corrupt: !valid,
      body_shown: flag === "body_shown",
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const armedCount = (paths) =>
  names(slot(paths, "armed")).filter((name) => MESSAGE_ID.test(name)).length;
const CAPPED = "capped";

// True when armed, false when closed, CAPPED when a racer filled the last place first.
function armOne(paths, id, { at, bodyShown }) {
  if (closed(paths, id)) return false;
  ensure(paths, "armed");
  const text = `${at}\n${bodyShown ? "body_shown\n" : ""}`;
  const created = createWhole(slot(paths, "armed", id), text); // false: already armed, keep its time
  markBodyShown(slot(paths, "armed", id), bodyShown); // a no-op on a record just created with the flag
  const capped = created && armedCount(paths) > MARKER_CAP; // recount after publish; only our own file is ever unlinked for it
  if (!capped && !closed(paths, id)) return true;
  fs.rmSync(slot(paths, "armed", id), { force: true }); // ours over the cap, or an escape or a reply landed in between
  return capped ? CAPPED : false;
}

/**
 * A user notice was shown: arm each valid message id once. An id that escaped
 * (cap, expiry, clock_back, corruption) or was replied to is skipped; only a new id starts a fresh
 * gate. Returns the ids that are armed afterwards (already armed ones included).
 * `bodyShown`: the ids whose body the arming block rendered (R4).
 */
export function armAckGate(
  paths,
  messageIds,
  { now = Date.now, bodyShown = new Set() } = {},
) {
  assertOwnFiles(paths);
  const armed = new Set(
    names(slot(paths, "armed")).filter((name) => MESSAGE_ID.test(name)),
  );
  const capped = []; // fails open for these notices; armed ids keep their budgets
  // Admission by the listing taken once; ids this call arms are bounded by armOne's recount.
  const out = validIds(messageIds).filter((id) => {
    const state =
      armed.has(id) || armed.size < MARKER_CAP
        ? armOne(paths, id, { at: now(), bodyShown: bodyShown.has(id) })
        : CAPPED;
    if (state === CAPPED) capped.push(id);
    return state === true;
  });
  if (capped.length > 0)
    logAckGateOpened(paths, { reason: "armed_cap", messageIds: capped, now });
  reclaimGate(paths);
  return out;
}

/**
 * The ids leave the gate for good: create `escaped/<id>` FIRST, then unlink
 * `armed/<id>`. An id whose marker cannot be created is disarmed anyway (fail
 * open, so no later call restarts Node for it); the caller allows the boundary
 * and logs `escape_failed` once. Accepted limit: with no `escaped/` such an id
 * can re-arm if its notice is shown again (each arm still at most 3 refusals in
 * 5 minutes). Returns `{ escaped, failed, error }`.
 */
export function escapeAckGate(paths, messageIds) {
  assertOwnFiles(paths);
  const out = { escaped: [], failed: [], error: null };
  const mark = (id) => {
    ensure(paths, "escaped");
    try {
      fs.writeFileSync(slot(paths, "escaped", id), "", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error; // already escaped is fine
    }
  };
  for (const id of messageIds) {
    try {
      mark(id);
      out.escaped.push(id);
    } catch (error) {
      out.failed.push(id);
      out.error ??= error;
    }
    fs.rmSync(slot(paths, "armed", id), { force: true });
    fs.rmSync(slot(paths, "read", id), { force: true }); // its body is not kept past the gate
    // its slots stay (a late verdict still counts them: no early reset); reclaimed once old
  }
  reclaimGate(paths);
  return out;
}

/** The answered ids (replied, not_owed, not_gated) leave the gate: unlink `armed/<id>`, its slots and its `read/` marker. */
export function openAckGateItems(paths, messageIds) {
  assertOwnFiles(paths);
  for (const id of messageIds) {
    fs.rmSync(slot(paths, "armed", id), { force: true });
    // One file at a time, never recursive; an id that re-armed meanwhile keeps its slots.
    // A slot a late verdict adds is left behind: it is stamped before the next arm, so it never counts, and is reclaimed once old.
    if (!fs.existsSync(slot(paths, "armed", id))) {
      reclaimSlots(slot(paths, "refusals", id), ALL_SLOTS);
      fs.rmSync(slot(paths, "read", id), { force: true }); // replied/ stays: it is what stops a re-arm
    }
  }
}

const validIds = (ids) =>
  [...new Set(ids ?? [])].filter(
    (id) => typeof id === "string" && MESSAGE_ID.test(id),
  );

/** Stable API (l7's PreToolUse notice gate calls it before arming): true once `replied/<id>` exists, i.e. the daemon confirmed a reply or ack. */
export const hasLocalReplyMarker = (paths, messageId) =>
  MESSAGE_ID.test(messageId) &&
  fs.existsSync(slot(paths, "replied", messageId));

/**
 * The daemon saved this session's reply or ack in `conversationId` for these
 * ids: create `replied/<id>` FIRST, then open them (armOne re-checks the marker
 * after it creates, so one of the two always sees the other). The ids of the
 * `received` snapshot (snapshotAckGateReceived, taken before the command's
 * first daemon request) in that conversation are answered by the same reply;
 * any other id stays armed. Returns the ids marked.
 */
export function markAckGateReplied(
  paths,
  messageIds,
  { conversationId, received = [] } = {},
) {
  assertOwnFiles(paths);
  const siblings = received
    .filter((entry) => entry.conversation_id === conversationId)
    .map((entry) => entry.message_id);
  const ids = validIds([...messageIds, ...siblings]);
  if (ids.length === 0) return [];
  ensure(paths, "replied");
  for (const id of ids) createWhole(slot(paths, "replied", id), "");
  openAckGateItems(paths, ids);
  reclaimGate(paths);
  return ids;
}

function appendLog(paths, fields, now = Date.now) {
  const line = {
    ...fields,
    session: path.basename(paths.dir),
    at: new Date(now()).toISOString(),
  };
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(paths.ackGateLog, `${JSON.stringify(line)}\n`, {
    mode: 0o600,
  });
}

/** One line in ack-gate.log: the gate opened (or failed open) for `reason`; `extra` adds fields. */
export function logAckGateOpened(
  paths,
  {
    reason,
    messageIds = [],
    event = "ack_gate.opened",
    extra = {},
    now = Date.now,
  },
) {
  assertOwnFiles(paths);
  appendLog(paths, { event, reason, message_ids: messageIds, ...extra }, now);
}
