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
import { acquireClaim, CLAIM_ATTEMPTS_EXHAUSTED, claimEndedAtMs, deliveryRetryDelayMs, issueReplyBindingToken, MAX_DELIVERY_CLAIM_ATTEMPTS, resolveLeaseMs, isUnsentOutcome } from './claims_shared.mjs';
import { AGED_TIER2_MS, behindHeldOlder, candidateTiers, heldRouteDeliveries, settleAnsweredNotices } from './delivery_priority.mjs';
import { advanceReplyWaitForDelivery, markStagedDeliveryFailedAttention } from '../lifecycle_transition.mjs';

const DELIVERY_PROJECTION_SQL = `SELECT d.id AS id, d.message_id AS message_id, d.endpoint_id AS endpoint_id, e.created_by_app_id AS owner_app_id,
                    d.state AS state, d.channel_route_id AS channel_route_id,
                    m.conversation_id AS conversation_id, conv.metadata AS conversation_metadata, m.sender_principal_id AS sender_principal_id,
                    m.body AS body, m.metadata AS metadata, m.created_at AS created_at, m.origin AS origin,
                    d.route_reason AS route_reason,
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
    .prepare("UPDATE deliveries SET state = 'failed', failure_cause = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'claimed')")
    .run(CLAIM_ATTEMPTS_EXHAUSTED, timestamp, deliveryId);
  if (failed.changes !== 1) return false;
  // The cause is on the row (ac-jfv.239); a released marker claim keeps the history, like the sweep's (ac-votvj).
  context.db
    .prepare(
      "INSERT INTO claims (resource_type, resource_id, state, token, claimed_at, lease_expires_at, attempt_count, released_at, outcome) VALUES ('delivery', ?, 'released', ?, ?, ?, ?, ?, ?)",
    )
    .run(deliveryId, CLAIM_ATTEMPTS_EXHAUSTED, timestamp, timestamp, latestClaim.attempt_count, timestamp, CLAIM_ATTEMPTS_EXHAUSTED);
  advanceReplyWaitForDelivery(context.db, { deliveryId, outcome: 'failed', now });
  markStagedDeliveryFailedAttention(context.db, { deliveryId, now, logger: context.logger });
  context.logger?.warn({
    event: 'delivery_claim_attempts_exhausted',
    params: { delivery_id: deliveryId, attempts: latestClaim.attempt_count, max_attempts: MAX_DELIVERY_CLAIM_ATTEMPTS },
    result: 'delivery_failed',
    status: 'ok',
  });
  return true;
}

/** Where a delivery's latest claim puts it in the auto-select offer order. */
function offerKind(claim, now) {
  const attempts = claim?.attempt_count ?? 0;
  // First true entry wins, so the order is the precedence.
  const holds = {
    exhausted: attempts >= MAX_DELIVERY_CLAIM_ATTEMPTS,
    unsent: isUnsentOutcome(claim?.outcome),
    fresh: attempts === 0,
    retry: Boolean(claim) && now.getTime() >= claimEndedAtMs(claim) + deliveryRetryDelayMs(attempts),
  };
  return Object.keys(holds).find((kind) => holds[kind]) ?? 'waiting';
}

// One line per claim, at the boundary: which path, and why. Tier 0-1 picks and guard skips are
// info; the routine tier 2 pick and an empty poll stay debug.
function logSelection(context, { tier, selected }) {
  const notable = selected && (selected.tier < 2 || selected.guardSkipped > 0 || selected.promotedFrom);
  const log = notable ? context.logger?.info : context.logger?.debug; // an idle poll is the steady state
  log?.call(context.logger, {
    event: 'delivery_claim.selected',
    params: { tier_filter: tier ?? null, offered: selected?.offered ?? 0 },
    result: selected
      ? {
          delivery_id: selected.id,
          tier: selected.tier,
          kind: selected.kind,
          aged: selected.aged,
          guard_skipped: selected.guardSkipped,
          promoted_from: selected.promotedFrom,
        }
      : { delivery_id: null },
    status: 'ok',
  });
}

const KIND_RANK = { fresh: 0, retry: 1, unsent: 2 };

const CANDIDATES_SQL = `SELECT d.id AS id, d.created_at AS created_at, d.channel_route_id AS channel_route_id,
              m.conversation_id AS conversation_id, m.origin AS origin, json_extract(m.metadata, '$.notice') AS notice
         FROM deliveries d
         JOIN endpoints e ON e.id = d.endpoint_id
         JOIN messages m ON m.id = d.message_id
    LEFT JOIN claims c ON c.resource_type = 'delivery' AND c.resource_id = d.id AND c.state = 'claimed' AND c.lease_expires_at > ?
        WHERE e.created_by_app_id = ?
          AND d.state IN ('pending', 'claimed')
          AND (? IS NULL OR d.endpoint_id = ?)
          AND (? IS NULL OR d.channel_route_id = ?)
          AND c.id IS NULL
        ORDER BY d.created_at ASC, d.id ASC`;

/**
 * Candidates in (created_at, id) order that may be offered now, each with its `kind`. An unsent
 * abort costs no attempt and no wait, but a delivery that keeps aborting must not hold the queue,
 * so unsent is offered last. An earlier failure never blocks a newer delivery (user decision,
 * 2026-09-22): a retry waits out its backoff without holding anything, and exhausted deliveries
 * fail terminally here.
 */
function offerableCandidates(context, { appId, endpointId, channelRouteId, now }) {
  const candidates = context.db
    .prepare(CANDIDATES_SQL)
    .all(now.toISOString(), appId, endpointId, endpointId, channelRouteId, channelRouteId);
  const latest = latestDeliveryClaims(context.db, candidates.map((candidate) => candidate.id));
  const offered = [];
  for (const candidate of candidates) {
    const claim = latest.get(candidate.id);
    const kind = offerKind(claim, now);
    if (kind === 'exhausted') failExhaustedDelivery(context, { deliveryId: candidate.id, latestClaim: claim, now });
    else if (kind !== 'waiting') offered.push({ ...candidate, kind, abortedAt: kind === 'unsent' ? claim.released_at : '' });
  }
  return offered;
}

/**
 * Orders offers: tier (0 notice, 1 answer to an unanswered user message, 2 the rest), then inside
 * tier 2 aged work (older than 15 min) ahead of young work, then fresh, retry past backoff,
 * least-recently-aborted unsent. A `tier` filter keeps that tier only, so one consumer per tier
 * never sees another tier's rows and unsent is last only inside its own tier. The input is
 * already (created_at, id) and Array.sort is stable, so ties keep that order.
 */
function rankOffers(context, offered, { tier, now }) {
  const tiers = candidateTiers(context.db, offered);
  const ageLimit = now.getTime() - AGED_TIER2_MS;
  for (const row of offered) {
    row.tier = tiers.get(row.id);
    row.aged = row.tier === 2 && Date.parse(row.created_at) < ageLimit;
  }
  return offered.filter((row) => tier === undefined || row.tier === tier).sort(compareOffers);
}

// Tier, aged tier 2 first, kind (fresh, retry, unsent), least recently aborted.
function compareOffers(a, b) {
  const keys = [a.tier - b.tier, Number(b.aged) - Number(a.aged), KIND_RANK[a.kind] - KIND_RANK[b.kind]];
  return keys.find((key) => key !== 0) ?? compareText(a.abortedAt, b.abortedAt);
}
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Auto-select: the first ranked offer that may go now. A tier 1-2 row on a channel route is first
 * replaced by the oldest offered tier 1-2 row of its route and conversation (an older post still
 * offerable goes before a newer answer; this ignores the `tier` filter, because thread order needs
 * it and the exclusive claim settles a race between the two lanes). It is then skipped when it is
 * behind a held older delivery. Tier 0 stands alone: no promotion, no guard, and an answered busy
 * notice is superseded instead of offered. Returns { id, tier, kind, promotedFrom, ... } or null.
 */
function selectAutoClaimDelivery(context, { appId, endpointId, channelRouteId, tier, now }) {
  const offered = offerableCandidates(context, { appId, endpointId, channelRouteId, now });
  const ranked = offered.length > 0 ? settleAnsweredNotices(context, rankOffers(context, offered, { tier, now }), now) : [];
  const held = ranked.some(isGuarded) ? heldRouteDeliveries(context.db, now) : [];
  const targets = ranked.map((row) => ({ row, target: threadHead(offered, row) }));
  const behindHeld = ({ target }) => isGuarded(target) && behindHeldOlder(held, target);
  const chosen = targets.find((pick) => !behindHeld(pick));
  if (!chosen) return null;
  const guardSkipped = targets.slice(0, targets.indexOf(chosen)).filter(behindHeld).length;
  const { row, target } = chosen;
  return { ...target, guardSkipped, offered: offered.length, promotedFrom: target === row ? null : row.id };
}

const isGuarded = (row) => row.tier > 0 && Boolean(row.channel_route_id);

// The row a pick stands for: the oldest offered tier 1-2 row of its route and conversation. `offered`
// is in (created_at, id) order and holds `row` itself, so the first match is never missing.
function threadHead(offered, row) {
  if (!isGuarded(row)) return row;
  const sameThread = (other) => other.channel_route_id === row.channel_route_id && other.conversation_id === row.conversation_id;
  return offered.find((other) => other === row || (sameThread(other) && canLead(other)));
}

// An unsent abort is never promoted: a post that keeps aborting must not hold its thread (2026-09-22 rule).
function canLead(other) {
  return other.tier > 0 && other.kind !== 'unsent';
}

// `tier` picks among many deliveries; a targeted claim names one. Absent means every tier.
function tierFilter(payload, deliveryId) {
  const tier = payload && payload.tier;
  if (tier === undefined) return undefined;
  if (![0, 1, 2].includes(tier)) {
    throw new TightbeamError('malformed_request', 'tier must be the integer 0, 1 or 2 when present', { field: 'tier' });
  }
  if (deliveryId) throw new TightbeamError('malformed_request', 'tier cannot be combined with delivery_id', { field: 'tier' });
  return tier;
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
    const tier = tierFilter(payload, deliveryId);
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
        // A channel copy that ended (delivered, failed for any cause, skipped, superseded) stays ended:
        // a claim by id would put it back to `claimed` and a late consumer could deliver it (ac-votvj).
        // The row's state decides, not the latest claim: a state export carries states, not claims.
        if (delivery.channel_route_id && delivery.state !== 'pending' && delivery.state !== 'claimed') {
          throw new TightbeamError('claim_held', `delivery "${deliveryId}" already ended (${delivery.state})`);
        }
      } else {
        // Auto-select never lets an earlier failure block a newer delivery
        // (user decision, 2026-09-22). Exhausted deliveries fail terminally
        // first; then a never-claimed delivery is offered before any retry,
        // and a retry is offered only after its backoff. Deliveries with an
        // actively-held (unexpired) claim are never candidates, so a held
        // oldest row never turns into claim_held while newer rows wait.
        const selected = selectAutoClaimDelivery(context, {
          appId: connection.appId,
          endpointId: endpointId ?? null,
          channelRouteId: channelRouteId ?? null,
          tier,
          now,
        });
        delivery = selected ? selectDeliveryProjection(context.db, { deliveryId: selected.id, channelRouteId }) : null;
        logSelection(context, { tier, selected });
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
            .prepare('SELECT provider_session_id, runtime, authority_reference FROM endpoints WHERE id = ?')
            .get(senderEndpointId);
          message.sender_endpoint_id = senderEndpointId;
          if (typeof endpoint?.provider_session_id === 'string') message.sender_session_id = endpoint.provider_session_id;
          if (typeof endpoint?.runtime === 'string') message.sender_runtime = endpoint.runtime;
          // Top-level only: channel adapters read named fields, so it never reaches email or Slack.
          if (typeof endpoint?.authority_reference === 'string' && endpoint.authority_reference.length > 0) {
            message.sender_cwd = endpoint.authority_reference;
          }
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
        tier_filter: tier ?? null, // the tier this call applied: a consumer checks it against what it asked
      };
      if (delivery.route_reason !== null) {
        result.route_reason = delivery.route_reason;
      }
      if (delivery.route_app_id) {
        // The other channel copies of this message and their states (ac-jfv.55): a channel that
        // cannot send its copy decides from them whether the message still reaches the user.
        result.sibling_channels = context.db
          .prepare(
            `SELECT r.selector AS selector, d.state AS state
               FROM deliveries d JOIN channel_routes r ON r.id = d.channel_route_id
              WHERE d.message_id = ? AND d.id <> ?
              ORDER BY r.selector, d.id`,
          )
          .all(delivery.message_id, delivery.id)
          .map((row) => ({ selector: row.selector, state: row.state }));
      }
      if (acceptReplyBinding === true && delivery.reply_binding_id && delivery.route_app_id === connection.appId) {
        result.reply_binding = issueReplyBindingToken(context.db, { bindingId: delivery.reply_binding_id, now });
      }
      return result;
    });

    if (outcome === null) {
      throw new TightbeamError('claim_held', 'no pending delivery is currently available to claim', { tier_filter: tier ?? null });
    }
    return { result: outcome };
  },
};
