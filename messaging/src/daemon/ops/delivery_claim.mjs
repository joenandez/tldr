// delivery.claim — docs/protocol.md "Obligations and delivery". Scope for
// "the caller's authorized scope" (omitted delivery_id) is ownership of
// the recipient endpoint, matching message.acknowledge's
// `endpoints.created_by_app_id === connection.appId` isolation rule
// (the state ownership contract §1: consume_outbound_requests is not
// allowed_authorities-scoped, so ownership-by-endpoint is the only
// available scoping mechanism). Reap-then-insert lease acquisition lives
// in claims_shared.mjs, adapted from tldr;'s tldr_agent_inbound_claim.mjs
// (see the internal provenance record).

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { acquireClaim, deliveryRetryDelayMs, issueReplyBindingToken, MAX_DELIVERY_CLAIM_ATTEMPTS, resolveLeaseMs } from './claims_shared.mjs';
import { advanceReplyWaitForDelivery, markStagedDeliveryFailedAttention } from '../lifecycle_transition.mjs';

const DELIVERY_PROJECTION_SQL = `SELECT d.id AS id, d.message_id AS message_id, d.endpoint_id AS endpoint_id, e.created_by_app_id AS owner_app_id,
                    m.conversation_id AS conversation_id, conv.metadata AS conversation_metadata, m.sender_principal_id AS sender_principal_id,
                    m.body AS body, m.metadata AS metadata, m.created_at AS created_at, m.origin AS origin,
                    m.in_reply_to_message_id AS in_reply_to_message_id,
                    sender.display_name AS sender_display_name, origin_route.selector AS origin_channel_selector,
                    effect.effect_payload AS effect_payload, route.app_id AS route_app_id,
                    binding.id AS reply_binding_id
               FROM deliveries d
               JOIN endpoints e ON e.id = d.endpoint_id
               JOIN messages m ON m.id = d.message_id
               JOIN conversations conv ON conv.id = m.conversation_id
          LEFT JOIN principals sender ON sender.id = m.sender_principal_id
          LEFT JOIN channel_routes origin_route ON origin_route.id = m.origin_channel_route_id
          LEFT JOIN message_effects effect ON effect.message_id = m.id
          LEFT JOIN channel_routes route ON route.id = d.channel_route_id
          LEFT JOIN reply_bindings binding
                 ON binding.source_delivery_id = d.id
                AND binding.channel_route_id = d.channel_route_id
                AND binding.app_id = route.app_id
              WHERE d.id = ? AND (? IS NULL OR d.channel_route_id = ?)`;

function selectDeliveryProjection(db, { deliveryId, channelRouteId }) {
  return db.prepare(DELIVERY_PROJECTION_SQL).get(deliveryId, channelRouteId ?? null, channelRouteId ?? null);
}

/** When a claim stopped holding its lease: a voluntary release, or lease expiry. */
function claimEndedAtMs(claim) {
  const leaseEnd = Date.parse(claim.lease_expires_at);
  if (claim.state === 'released' && claim.released_at) return Math.min(leaseEnd, Date.parse(claim.released_at));
  return leaseEnd;
}

function latestDeliveryClaims(db, deliveryIds) {
  if (deliveryIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT c.resource_id, c.id, c.state, c.attempt_count, c.lease_expires_at, c.released_at, c.outcome
         FROM claims c
         JOIN (
           SELECT resource_id, MAX(id) AS id FROM claims
            WHERE resource_type = 'delivery' AND resource_id IN (SELECT value FROM json_each(?))
            GROUP BY resource_id
         ) latest ON latest.id = c.id`,
    )
    .all(JSON.stringify(deliveryIds));
  return new Map(rows.map((row) => [row.resource_id, row]));
}

/**
 * Terminal failure for a delivery whose claimants never finished it. The
 * transport outcome matches delivery.complete { outcome: "failed" }: the
 * reply wait advances and a staged delivery-confirmed root gains attention
 * while its work stays open.
 */
function failExhaustedDelivery(context, { deliveryId, latestClaim, now }) {
  const timestamp = now.toISOString();
  if (latestClaim.state === 'claimed') {
    context.db.prepare("UPDATE claims SET state = 'released', outcome = 'expired', released_at = ? WHERE id = ? AND state = 'claimed'").run(timestamp, latestClaim.id);
  }
  const failed = context.db
    .prepare("UPDATE deliveries SET state = 'failed', updated_at = ? WHERE id = ? AND state IN ('pending', 'claimed')")
    .run(timestamp, deliveryId);
  if (failed.changes !== 1) return false;
  advanceReplyWaitForDelivery(context.db, { deliveryId, outcome: 'failed', now });
  markStagedDeliveryFailedAttention(context.db, { deliveryId, now });
  context.logger?.warn({
    event: 'delivery_claim_attempts_exhausted',
    params: { delivery_id: deliveryId, attempts: latestClaim.attempt_count, max_attempts: MAX_DELIVERY_CLAIM_ATTEMPTS },
    result: 'delivery_failed',
    status: 'ok',
  });
  return true;
}

function selectAutoClaimDelivery(context, { appId, endpointId, channelRouteId, now }) {
  const candidates = context.db
    .prepare(
      `SELECT d.id AS id
         FROM deliveries d
         JOIN endpoints e ON e.id = d.endpoint_id
    LEFT JOIN claims c ON c.resource_type = 'delivery' AND c.resource_id = d.id AND c.state = 'claimed' AND c.lease_expires_at > ?
        WHERE e.created_by_app_id = ?
          AND d.state IN ('pending', 'claimed')
          AND (? IS NULL OR d.endpoint_id = ?)
          AND (? IS NULL OR d.channel_route_id = ?)
          AND c.id IS NULL
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .all(now.toISOString(), appId, endpointId, endpointId, channelRouteId, channelRouteId);
  const latest = latestDeliveryClaims(context.db, candidates.map((candidate) => candidate.id));
  let retry = null;
  for (const { id } of candidates) {
    const claim = latest.get(id);
    const attempts = claim?.attempt_count ?? 0;
    if (attempts === 0) return id;
    if (attempts >= MAX_DELIVERY_CLAIM_ATTEMPTS) {
      failExhaustedDelivery(context, { deliveryId: id, latestClaim: claim, now });
      continue;
    }
    if (retry === null && now.getTime() >= claimEndedAtMs(claim) + deliveryRetryDelayMs(attempts)) retry = id;
  }
  return retry;
}

export const deliveryClaimOp = {
  name: 'delivery.claim',
  allowedScopes: ['agent'],
  permission: 'consume_outbound_requests',
  handler(context, payload, connection) {
    const deliveryId = payload && payload.delivery_id;
    const endpointId = payload && payload.endpoint_id;
    const channelRouteId = payload && payload.channel_route_id;
    const acceptReplyBinding = payload && payload.accept_reply_binding;
    if (deliveryId !== undefined && deliveryId !== null && (typeof deliveryId !== 'string' || deliveryId.length === 0)) {
      throw new TightbeamError('malformed_request', 'delivery_id must be a string when present', { field: 'delivery_id' });
    }
    if (endpointId !== undefined && endpointId !== null && (typeof endpointId !== 'string' || endpointId.length === 0)) {
      throw new TightbeamError('malformed_request', 'endpoint_id must be a string when present', { field: 'endpoint_id' });
    }
    if (channelRouteId !== undefined && channelRouteId !== null && (typeof channelRouteId !== 'string' || channelRouteId.length === 0)) {
      throw new TightbeamError('malformed_request', 'channel_route_id must be a string when present', { field: 'channel_route_id' });
    }
    if (acceptReplyBinding !== undefined && typeof acceptReplyBinding !== 'boolean') {
      throw new TightbeamError('malformed_request', 'accept_reply_binding must be a boolean when present', { field: 'accept_reply_binding' });
    }
    const leaseMs = resolveLeaseMs(payload.lease_ms);
    const now = new Date();

    const outcome = withTransaction(context.db, () => {
      let delivery;
      if (deliveryId) {
        delivery = selectDeliveryProjection(context.db, { deliveryId, channelRouteId });
        if (!delivery) {
          throw new TightbeamError('malformed_request', `no delivery registered with id "${deliveryId}"`, { field: 'delivery_id' });
        }
        if (delivery.owner_app_id !== connection.appId) {
          throw new TightbeamError('permission_denied', 'consume_outbound_requests is not granted for this delivery');
        }
      } else {
        // Auto-select never lets an earlier failure block a newer delivery
        // (user decision, 2026-09-22). Exhausted deliveries fail terminally
        // first; then a never-claimed delivery is offered before any retry,
        // and a retry is offered only after its backoff. Deliveries with an
        // actively-held (unexpired) claim are never candidates, so a held
        // oldest row never turns into claim_held while newer rows wait.
        const selectedId = selectAutoClaimDelivery(context, {
          appId: connection.appId,
          endpointId: endpointId ?? null,
          channelRouteId: channelRouteId ?? null,
          now,
        });
        delivery = selectedId ? selectDeliveryProjection(context.db, { deliveryId: selectedId, channelRouteId }) : null;
        // No pending delivery matches the caller's scope right now. Not
        // covered by a dedicated structured error in docs/protocol.md's
        // delivery.claim error list (permission_denied, claim_held only,
        // unlike resume.claim's resume_handler_unavailable) — reusing
        // claim_held for "nothing currently available to claim" is the
        // documented-error-set-compliant choice; see the ws-8 completion
        // report for this resolved ambiguity. The error is raised after the
        // transaction commits, so an exhausted delivery failed above stays
        // failed even when nothing else is claimable.
        if (!delivery) return null;
      }

      const claim = acquireClaim(context.db, { resourceType: 'delivery', resourceId: delivery.id, leaseMs, now });
      context.db.prepare("UPDATE deliveries SET state = 'claimed', updated_at = ? WHERE id = ?").run(now.toISOString(), delivery.id);

      const metadata = JSON.parse(delivery.metadata ?? '{}');
      try {
        const subject = JSON.parse(delivery.conversation_metadata ?? '{}')?.subject;
        if (typeof subject === 'string' && subject.trim().length > 0) metadata.subject = subject;
      } catch {
        // Historical conversations may have malformed or absent metadata;
        // they remain readable and never gain an invented subject.
      }
      const message = {
        message_id: delivery.message_id,
        conversation_id: delivery.conversation_id,
        sender_principal_id: delivery.sender_principal_id,
        in_reply_to_message_id: delivery.in_reply_to_message_id ?? null,
        origin: delivery.origin,
        sender_display_name: delivery.sender_display_name ?? null,
        body: delivery.body,
        metadata,
        created_at: delivery.created_at,
      };
      if (delivery.origin === 'inbound' && typeof delivery.origin_channel_selector === 'string') {
        message.origin_channel_selector = delivery.origin_channel_selector;
      }
      try {
        const senderEndpointId = JSON.parse(delivery.effect_payload ?? '{}')?.declaration?.sender_endpoint_id;
        if (typeof senderEndpointId === 'string') {
          const endpoint = context.db
            .prepare('SELECT provider_session_id, runtime FROM endpoints WHERE id = ?')
            .get(senderEndpointId);
          message.sender_endpoint_id = senderEndpointId;
          if (typeof endpoint?.provider_session_id === 'string') message.sender_session_id = endpoint.provider_session_id;
          if (typeof endpoint?.runtime === 'string') message.sender_runtime = endpoint.runtime;
        }
      } catch {
        // An immutable historical effect row without a parseable declaration
        // cannot authorize an endpoint return target.
      }

      const result = {
        delivery_id: delivery.id,
        message_id: delivery.message_id,
        endpoint_id: delivery.endpoint_id,
        token: claim.token,
        lease_expires_at: claim.leaseExpiresAt,
        message,
      };
      if (acceptReplyBinding === true && delivery.reply_binding_id && delivery.route_app_id === connection.appId) {
        result.reply_binding = issueReplyBindingToken(context.db, { bindingId: delivery.reply_binding_id, now });
      }
      return result;
    });

    if (outcome === null) {
      throw new TightbeamError('claim_held', 'no pending delivery is currently available to claim');
    }
    return { result: outcome };
  },
};
