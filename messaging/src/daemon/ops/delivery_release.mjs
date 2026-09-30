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

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { releaseClaim, verifyClaimToken } from './claims_shared.mjs';

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

    const now = new Date();
    const outcome = withTransaction(context.db, () => {
      const { row, alreadyResolved } = verifyClaimToken(context.db, { resourceType: 'delivery', resourceId: deliveryId, token, now });
      if (alreadyResolved) {
        throw new TightbeamError('claim_expired', 'this claim has already been completed and cannot be released');
      }

      releaseClaim(context.db, { row, outcome: null, now });
      context.db.prepare("UPDATE deliveries SET state = 'pending', updated_at = ? WHERE id = ?").run(now.toISOString(), deliveryId);

      return { delivery_id: deliveryId, state: 'pending' };
    });

    return { result: outcome };
  },
};
