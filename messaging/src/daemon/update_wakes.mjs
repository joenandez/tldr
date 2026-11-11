// Scheduled-wake bookkeeping for lifecycle effects (thread-followups C2/C3):
// an `update` may carry `wake_at`; any update or close on an attempt cancels
// its pending wakes first, so a new `--at` replaces an earlier one and a
// complete/cancel leaves nothing to fire. Runs in the commit's transaction.

import { TightbeamError } from "../protocol/envelope.mjs";
import { cancelWakesForAttempt, insertWake } from "./scheduled_wakes.mjs";

// Validates the optional update-only fields (`acknowledgement`, `wake_at`) onto `effect`.
export function readUpdateFields(declaredEffect, effect) {
  const { acknowledgement, wake_at: wakeAt } = declaredEffect;
  if (acknowledgement !== undefined) {
    if (acknowledgement !== true)
      throw new TightbeamError(
        "malformed_request",
        "obligation_effect.acknowledgement must be true when present",
        { field: "acknowledgement" },
      );
    effect.acknowledgement = true;
  }
  if (wakeAt === undefined) return;
  const parsed = typeof wakeAt === "string" ? Date.parse(wakeAt) : NaN;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== wakeAt)
    throw new TightbeamError(
      "malformed_request",
      "obligation_effect.wake_at must be an ISO-8601 UTC timestamp",
      { field: "wake_at" },
    );
  effect.wake_at = wakeAt;
}

const WAKE_EFFECTS = new Set([
  "update",
  "handoff.offer",
  "close.fulfilled",
  "close.cancelled",
]);

// The node and every open-or-closed descendant: a root close covers its attempts.
function subtreeIds(db, nodeId) {
  return db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT ? UNION SELECT o.id FROM obligations o JOIN tree t ON o.parent_id = t.id
       ) SELECT id FROM tree`,
    )
    .all(nodeId)
    .map((row) => row.id);
}

export function applyWakeEffects(db, { effect, now }) {
  if (!WAKE_EFFECTS.has(effect.type)) return;
  for (const id of subtreeIds(db, effect.obligation_id))
    cancelWakesForAttempt(db, id, now);
  if (effect.type === "update" && effect.wake_at)
    insertWake(db, {
      attemptId: effect.obligation_id,
      endpointId: effect.sender_endpoint_id,
      reason: "at",
      wakeAt: effect.wake_at,
    });
}
