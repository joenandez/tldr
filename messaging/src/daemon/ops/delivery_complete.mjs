// delivery.complete — docs/protocol.md "Obligations and delivery".
// Durable + idempotent: a replay with the same token and the same
// outcome that already completed this claim returns the same result
// without a new write, rather than erroring — the ws-8 workstream's
// explicit idempotency requirement, layered on top of the token-gated
// claim/release pattern in claims_shared.mjs (adapted from tldr;'s
// tldr_agent_inbound_claim.mjs, see the internal provenance record). A replay with a
// DIFFERENT outcome than what was already recorded is not a true replay
// — it is rejected with claim_expired (the lease is no longer active to
// change), using only the two documented error codes for this operation.
//
// Delivery evidence stays TRANSPORT truth, with exactly one exception on
// the FORWARD graph (Project Relay parent 4.2; transitions.yaml
// DELIVERY-SUCCEED / DELIVERY-FAIL; canonical INV-07): completing the
// EXACT typed eligible delivery of a staged delivery-confirmed resolution
// (`route_reason = 'close.delivery_confirmed'`,
// source_obligation_id = root, at an endpoint of the principal that opened
// the work) with `outcome: "delivered"` closes that staged chain inside
// this same transaction; `outcome: "failed"` leaves the root open and
// marks its attention. Another participant's copy of the same report is an
// ordinary delivery: it completes here as pure transport. The closure rides
// the claim ledger's already-resolved short-circuit, so a replayed delivered
// claim — across restarts included — returns the original result and can
// never double-close. Every other delivery completes transport-only.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { CONSUMER_FAILED, releaseClaim, verifyClaimToken } from './claims_shared.mjs';
import { ensureStagedDeliveryCoverage } from '../held_request_stop.mjs';
import { acceptProviderAcknowledgement, advanceReplyWaitForDelivery, closeStagedDeliveryConfirmedChain, markStagedDeliveryFailedAttention } from '../lifecycle_transition.mjs';

const OUTCOME_TO_CLAIM_OUTCOME = { delivered: 'completed', failed: 'failed' };
// A failed copy with one of these reasons was skipped by policy, not lost: another channel
// delivered the message (ac-jfv.55). The delivery row stays 'failed' for every state reader; its
// failure_cause is SKIPPED_CLAIM_PREFIX + reason (ac-jfv.239), and the claim outcome says the same.
export const SKIP_REASONS = new Set(['email_reply_parent_missing']);
export const SKIPPED_CLAIM_PREFIX = 'skipped:';

export const deliveryCompleteOp = {
  name: 'delivery.complete',
  allowedScopes: ['agent'],
  permission: 'consume_outbound_requests',
  handler(context, payload) {
    const deliveryId = payload && payload.delivery_id;
    const token = payload && payload.token;
    const outcomeValue = payload && payload.outcome;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new TightbeamError('malformed_request', 'delivery_id is required and must be a string', { field: 'delivery_id' });
    }
    if (outcomeValue !== 'delivered' && outcomeValue !== 'failed') {
      throw new TightbeamError('malformed_request', 'outcome must be "delivered" or "failed"', { field: 'outcome' });
    }
    const reason = payload.reason;
    if (reason !== undefined && (outcomeValue !== 'failed' || !SKIP_REASONS.has(reason))) {
      throw new TightbeamError('malformed_request', `reason must be one of ${[...SKIP_REASONS].join(', ')} with outcome "failed"`, { field: 'reason' });
    }

    const now = new Date();
    const claimOutcome = reason === undefined ? OUTCOME_TO_CLAIM_OUTCOME[outcomeValue] : `${SKIPPED_CLAIM_PREFIX}${reason}`;
    // The row's durable cause (ac-jfv.239): none on a delivered copy.
    const failureCause = outcomeValue === 'delivered' ? null : reason === undefined ? CONSUMER_FAILED : claimOutcome;
    const resultFields = reason === undefined ? {} : { reason };

    const startedAt = Date.now();
    const outcome = withTransaction(context.db, () => {
      const { row, alreadyResolved } = verifyClaimToken(context.db, { resourceType: 'delivery', resourceId: deliveryId, token, now });

      if (alreadyResolved) {
        if (row.outcome !== claimOutcome) {
          throw new TightbeamError('claim_expired', 'this claim was already completed with a different outcome');
        }
        return { delivery_id: deliveryId, state: outcomeValue, outcome: outcomeValue, ...resultFields };
      }

      releaseClaim(context.db, { row, outcome: claimOutcome, now });
      context.db.prepare('UPDATE deliveries SET state = ?, failure_cause = ?, updated_at = ? WHERE id = ?').run(outcomeValue, failureCause, now.toISOString(), deliveryId);
      advanceReplyWaitForDelivery(context.db, { deliveryId, outcome: outcomeValue, now });

      // The single forward-graph exception (INV-07): only the exact staged
      // delivered receipt closes work; a failed one leaves it open and
      // actionable. Both helpers are inert for every ordinary delivery row.
      // A copy skipped by policy (a reason) resolves its route like a delivered one: the staged root
      // closes once the other copies are delivered, which the closure itself requires (ac-jfv.55).
      if (outcomeValue === 'delivered' || reason !== undefined) {
        const acknowledgement = outcomeValue === 'delivered' ? acceptProviderAcknowledgement(context.db, { deliveryId, now }) : null;
        const closure = closeStagedDeliveryConfirmedChain(context.db, { deliveryId, now });
        // Another route failed earlier and this was the last one in flight: the request is held again (invariant D).
        if (!closure) ensureStagedDeliveryCoverage(context.db, { deliveryId, now, logger: context.logger });
        context.logger?.info({
          event: closure ? 'delivery_staged_closure_committed' : acknowledgement ? 'delivery_acknowledgement_accepted' : 'delivery_complete_transport_only',
          params: { delivery_id: deliveryId, ...resultFields, ...(acknowledgement ?? {}), ...(closure ?? {}) },
          result: closure ? 'staged_chain_closed' : acknowledgement ? 'acknowledgement_accepted_root_open' : 'transport_only',
          status: 'ok',
          latency_ms: Date.now() - startedAt,
        });
      } else {
        const attention = markStagedDeliveryFailedAttention(context.db, { deliveryId, now, logger: context.logger });
        context.logger?.info({
          event: attention ? 'delivery_staged_failure_marked' : 'delivery_complete_transport_only',
          params: { delivery_id: deliveryId, ...(attention ?? {}) },
          result: attention ? 'root_attention_marked_root_left_open' : 'transport_only',
          status: 'ok',
          latency_ms: Date.now() - startedAt,
        });
      }

      return { delivery_id: deliveryId, state: outcomeValue, outcome: outcomeValue, ...resultFields };
    });

    return { result: outcome };
  },
};
