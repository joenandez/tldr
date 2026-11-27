// The ack gate's read/ markers (ac-jfv.156): what `agent receive` keeps for the
// read refusal, and the received snapshot a reply/ack/park takes before its
// first daemon request. Split from ack_gate.mjs (its complexity limit); that
// module never imports this one. Layout and rules: the ack_gate.mjs header.

import fs from "node:fs";

import {
  MESSAGE_ID,
  assertOwnFiles,
  closed,
  createWhole,
  ensure,
  names,
  reclaimGate,
  slot,
} from "./ack_gate.mjs";

// A read/ marker is for an armed id that is not answered or escaped, and for nothing else.
const live = (paths, id) =>
  fs.existsSync(slot(paths, "armed", id)) && !closed(paths, id);

/**
 * `agent receive` returned message `id`: write `read/<id>` once (a first write
 * wins) holding `fields`, what the read refusal shows, only while `id` is live.
 * Re-checked after it publishes, like armOne: openAckGateItems and escapeAckGate
 * unlink read/ after armed/, so one of the two always sees the other. False when
 * nothing is kept (an unsafe id, an id not armed, or one closed meanwhile).
 * shortcut: a dead session keeps at most its armed count of read/ files until its next gate read or write; add a sweeper if that matters.
 */
export function markAckGateRead(paths, id, fields) {
  assertOwnFiles(paths);
  reclaimGate(paths);
  if (!MESSAGE_ID.test(id) || !live(paths, id)) return false;
  ensure(paths, "read");
  createWhole(slot(paths, "read", id), `${JSON.stringify(fields)}\n`);
  const kept = live(paths, id);
  if (!kept) fs.rmSync(slot(paths, "read", id), { force: true });
  reclaimGate(paths); // after the write too: the bound holds when it returns
  return kept;
}

/** True when `read/<id>` exists: the verdict's read-or-unread test, with no read. */
export const hasAckGateRead = (paths, id) =>
  fs.existsSync(slot(paths, "read", id));

/**
 * What `read/<id>` holds, `{}` when it is unreadable; null when the id was
 * never received. Callers pass MESSAGE_ID ids only, so a `.tmp` partial write is never read.
 */
export function readAckGateRead(paths, id) {
  let text;
  try {
    text = fs.readFileSync(slot(paths, "read", id), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {}; // read, but its copy is damaged: refuse without it
  }
}

/**
 * The armed ids that already have a visible `read/` marker, with the
 * conversation the marker names: `[{ message_id, conversation_id }]`. Taken
 * before a reply/ack/park's first daemon request, it is exactly what that
 * command had received; an id received later is not in it. No clock involved.
 */
export function snapshotAckGateReceived(paths) {
  assertOwnFiles(paths);
  return names(slot(paths, "armed"))
    .filter((id) => MESSAGE_ID.test(id))
    .map((id) => ({
      message_id: id,
      conversation_id: readAckGateRead(paths, id)?.conversation_id,
    }))
    .filter((entry) => typeof entry.conversation_id === "string");
}
