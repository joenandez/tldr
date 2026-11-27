// What the ack gate reclaims on read and after every write (ac-jfv.156 review
// rounds 3, 4, 9 and 15): abandoned temporaries, old escaped, read and replied
// markers, marker directories over their cap, and refusal slots once old,
// never an armed id's.
// File times are real, so this module reads the real clock. Nothing here deletes recursively:
// a recursive delete from a stale listing could remove a directory that has
// been re-created and re-filled since (round 4, finding 3). Counting is by
// stamp (ack_gate_verdict.mjs), so what is left behind is never counted wrongly.

import fs from "node:fs";
import path from "node:path";

export const TMP_MAX_AGE_MS = 60_000;
export const ESCAPED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SLOT_MAX_AGE_MS = 10 * 60 * 1000;
// Equals ACK_GATE_EXPIRY_MS: a read/ marker (a message body) is useless once its id expired.
// Not imported: ack_gate_verdict.mjs imports ack_gate.mjs, which imports this module.
export const READ_MAX_AGE_MS = 5 * 60 * 1000;
export const MARKER_CAP = 512;
const MARKER_MAX_AGE_MS = {
  escaped: ESCAPED_MAX_AGE_MS,
  read: READ_MAX_AGE_MS,
  replied: ESCAPED_MAX_AGE_MS,
};
export const ALL_SLOTS = -1; // `maxAge` that matches every file

// Reclaim is hygiene: a race lost (gone already, directory refilled) or an
// unreadable leftover must never fail the gate read that triggered it, and the
// stamp-based count is right whether or not a leftover is removed.
const tolerate = (action) => {
  try {
    return action();
  } catch {
    return undefined;
  }
};

function removeIfOlder(dir, name, maxAge) {
  const file = path.join(dir, name);
  tolerate(() => {
    // ALL_SLOTS never reads the clock: a slot stamped ahead of a clock that stepped back still goes.
    if (maxAge === ALL_SLOTS || Date.now() - fs.statSync(file).mtimeMs > maxAge)
      fs.unlinkSync(file);
  });
}

/**
 * Removes the slot files of one id's directory older than `maxAge` (default
 * 10 minutes; -1 for all), then the directory when it is empty. Single files
 * and `rmdir` only: a directory that was refilled is not empty, and its fresh
 * slots are never old.
 */
export function reclaimSlots(dir, maxAge = SLOT_MAX_AGE_MS) {
  const slots = tolerate(() => fs.readdirSync(dir)) ?? [];
  for (const name of slots) removeIfOlder(dir, name, maxAge);
  tolerate(() => fs.rmdirSync(dir));
}

const isTemporary = (name) => name.startsWith(".") && name.endsWith(".tmp");

// A removed replied/ or escaped/ marker can at worst let an old id re-arm, which the 3-refusal / 5-minute bound still limits.
function capMarkers(dir, listed) {
  if (listed.length <= MARKER_CAP) return; // stat only when over the cap
  const aged = listed
    .map((name) => ({
      name,
      at: tolerate(() => fs.statSync(path.join(dir, name)).mtimeMs),
    }))
    .filter((entry) => entry.at !== undefined)
    .sort((a, b) => a.at - b.at);
  for (const { name } of aged.slice(0, aged.length - MARKER_CAP))
    tolerate(() => fs.unlinkSync(path.join(dir, name)));
}

// An armed id's slots are never reclaimed (R15): its count only grows until it is
// answered or escapes, whatever the clock does. Checked per id NOW, not from the listing.
function reclaimIdSlots(dirs, id) {
  const has = (kind) => fs.existsSync(path.join(dirs[kind], id));
  if (has("armed") && !has("escaped") && !has("replied")) return;
  // Closed or orphaned: the 10-minute age rule. A closed id's slots stay for a late
  // verdict's count (no early reset) and never refuse, so clock trouble there is harmless.
  // Accepted limit: an orphan that re-arms between the check above and an unlink can lose
  // one fresh slot; that needs a re-arm plus a slot in that instant.
  reclaimSlots(path.join(dirs.refusals, id));
}

/**
 * `listing` holds the names the caller read: `armed`, `escaped`, `refusals`,
 * `read`, `replied`, each under `dirs.<same key>`. Removes `.tmp` files older
 * than 60 s in `armed/`, `escaped/`, `read/` and `replied/`; `read/` markers
 * older than 5 minutes (the gate's expiry); `escaped/` and `replied/` markers
 * older than 24 h; the oldest entries of a marker directory over 512; no slot
 * of an armed id, other slot files older than 10 minutes, and the slot
 * directories that are empty.
 */
export function reclaimAckGate(dirs, listing) {
  for (const name of listing.armed.filter(isTemporary))
    removeIfOlder(dirs.armed, name, TMP_MAX_AGE_MS);
  for (const [kind, maxAge] of Object.entries(MARKER_MAX_AGE_MS)) {
    const listed = listing[kind] ?? [];
    for (const name of listed)
      removeIfOlder(
        dirs[kind],
        name,
        isTemporary(name) ? TMP_MAX_AGE_MS : maxAge,
      );
    capMarkers(dirs[kind], listed);
  }
  for (const id of listing.refusals) reclaimIdSlots(dirs, id);
}
