// One fresh reading of "is the process that owns this session still running",
// shared by the two places that may start a second process on an existing
// session: the availability-takeover decision (listener_reconciler.mjs) and
// the resumer's launch fence (resumer.mjs). Only a fresh `gone` observation
// of a complete, valid owner tuple proves the owner exited; everything else
// is `alive` or unknown, and no caller may treat unknown as permission.
//
// The reading is taken from the endpoint row itself, never from a delivery or
// request snapshot, and the row's identity fields (`ownerFenceFields`) are
// what a conditional update or a re-read compares afterwards, so an owner
// that registered during the observation is a changed owner.

import { observeRetirementProcess } from './retirement_executor.mjs';
import {
  OWNER_PROCESS_FIELDS,
  ownerProcessLiveness,
  ownerProcessTupleIsAbsent,
  ownerProcessTupleIssue,
} from './owner_process_contract.mjs';

const OWNER_FENCE_FIELDS = Object.freeze(['process_generation', 'owner_epoch', 'owner_launch_token', ...OWNER_PROCESS_FIELDS]);

/** The endpoint's current owner facts, or null when the endpoint is gone. */
export function readOwnerFence(db, endpointId) {
  return db.prepare(`SELECT runtime, state, launch_mode, ${OWNER_FENCE_FIELDS.join(', ')} FROM endpoints WHERE id = ?`).get(endpointId) ?? null;
}

/** Whether two readings name the same owner: tuple, generation, epoch, token. */
export function sameOwnerFence(a, b) {
  return Boolean(a) && Boolean(b) && OWNER_FENCE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Observes the recorded owner now. Returns `{ liveness, reason }` where
 * liveness is `gone` | `alive` | `unavailable` | `unknown`:
 *   gone         the recorded PID is absent or reused (fresh `ps` answer)
 *   alive        the same PID with the same start identity is running
 *   unavailable  `ps` could not answer, or threw
 *   unknown      no owner tuple, or one that is incomplete/invalid for the
 *                endpoint's runtime and generation (no liveness evidence)
 * `observeProcess` is a parameter so tests drive every answer.
 */
export function observeOwnerLiveness(owner, observeProcess = observeRetirementProcess) {
  if (!owner) return { liveness: 'unknown', reason: 'endpoint_missing' };
  if (ownerProcessTupleIsAbsent(owner)) return { liveness: 'unknown', reason: 'no_owner_tuple' };
  if (ownerProcessTupleIssue(owner, { runtime: owner.runtime, processGeneration: owner.process_generation }) !== null) {
    return { liveness: 'unknown', reason: 'invalid_owner_tuple' };
  }
  try {
    return { liveness: ownerProcessLiveness(owner, observeProcess(owner.owner_process_pid)), reason: null };
  } catch (error) {
    return { liveness: 'unavailable', reason: 'observation_error', error: error.message };
  }
}
