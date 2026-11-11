// delivery.release — docs/protocol.md "Obligations and delivery".
// Voluntary release: returns the delivery to 'pending' immediately (no
// need to wait for lease expiry) so a fresh claimant can pick it up right
// away. Token-gated via claims_shared.mjs (adapted from tldr;'s
// tldr_agent_inbound_claim.mjs releaseTldrAgentInbound, see
// the internal provenance record). A second release attempt with the same (now-released)
// token is not idempotent-success — protocol.md's error list for this
// operation is permission_denied/claim_expired only, and a claim that is
// no longer held cannot be released again; it fails closed with
// claim_expired.
//
// Optional `outcome: "aborted_unsent"` (ac-jfv.87): the claimant was cut off
// before it sent anything. The claim then gives its attempt back, and
// delivery.claim auto-select offers the delivery again with no backoff.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { releaseClaim, UNSENT_ABORT_OUTCOME, UNSENT_ABORT_WARN_EVERY, unsentRun, verifyClaimToken } from './claims_shared.mjs';

// A delivery that keeps being cut off before it sends is never failed (the host is slow, not
// the delivery), so the run is made visible: one warning per UNSENT_ABORT_WARN_EVERY aborts.
// The run is the previous claim's run plus one: one lookup, never a recount of the history.
function unsentRunEndingAt(db, row) {
  const previous = db
    .prepare("SELECT outcome FROM claims WHERE resource_type = 'delivery' AND resource_id = ? AND id < ? ORDER BY id DESC LIMIT 1")
    .get(row.resource_id, row.id);
  return unsentRun(previous?.outcome) + 1;
}

function warnOnRepeatedUnsentAborts(context, deliveryId, run) {
  if (run % UNSENT_ABORT_WARN_EVERY !== 0) return;
  context.logger?.warn({
    event: 'delivery_unsent_aborts_repeated',
    params: { delivery_id: deliveryId, consecutive_unsent_aborts: run, warn_every: UNSENT_ABORT_WARN_EVERY },
    result: 'still_offered',
    status: 'ok',
  });
}

export const deliveryReleaseOp = {
  name: 'delivery.release',
  allowedScopes: ['agent'],
  permission: 'consume_outbound_requests',
  handler(context, payload) {
    const deliveryId = payload && payload.delivery_id;
    const token = payload && payload.token;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new TightbeamError('malformed_request', 'delivery_id is required and must be a string', { field: 'delivery_id' });
    }

    // Optional and backward compatible: an absent outcome is the plain release.
    const releaseOutcome = payload.outcome ?? null;
    if (releaseOutcome !== null && releaseOutcome !== UNSENT_ABORT_OUTCOME) {
      throw new TightbeamError('malformed_request', `outcome must be "${UNSENT_ABORT_OUTCOME}" when present`, { field: 'outcome' });
    }

    const now = new Date();
    const outcome = withTransaction(context.db, () => {
      const { row, alreadyResolved } = verifyClaimToken(context.db, {
        resourceType: 'delivery',
        resourceId: deliveryId,
        token,
        now,
        allowUnreapedExpiry: releaseOutcome === UNSENT_ABORT_OUTCOME,
      });
      if (alreadyResolved) {
        throw new TightbeamError('claim_expired', 'this claim has already been completed and cannot be released');
      }

      const unsent = releaseOutcome === UNSENT_ABORT_OUTCOME;
      const run = unsent ? unsentRunEndingAt(context.db, row) : 0;
      releaseClaim(context.db, { row, outcome: unsent ? `${UNSENT_ABORT_OUTCOME}:${run}` : releaseOutcome, now });
      context.db.prepare("UPDATE deliveries SET state = 'pending', updated_at = ? WHERE id = ?").run(now.toISOString(), deliveryId);

      if (unsent) warnOnRepeatedUnsentAborts(context, deliveryId, run);
      return { delivery_id: deliveryId, state: 'pending' };
    });

    return { result: outcome };
  },
};
