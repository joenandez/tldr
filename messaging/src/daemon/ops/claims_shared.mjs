// Shared bounded-lease claim logic for delivery.claim/.complete/.release
// and resume.claim/.complete/.fail (the state ownership contract §7, "Claim").
// Adapted from tldr;'s tldr_agent_inbound_claim.mjs bounded-lease pattern
// (see the internal provenance record): a claim is granted only if no existing lease on the
// same resource is both held and unexpired; a token-gated release/complete
// requires presenting the exact held token, never "whoever asks first."
//
// Reap-then-insert happens inside ONE transaction (the caller wraps every
// exported function here in withTransaction): the partial-unique index on
// claims(resource_type, resource_id) WHERE state = 'claimed'
// (the state ownership contract §7) can only express "no two simultaneously
// claimed rows," not "unless expired," so the expiry check and the reap it
// triggers must happen in code, transactionally, before the new claim row
// is inserted — the exact race the ws-5 schema note flags.
//
// Token verification is done by looking up the claim row matching the
// PRESENTED TOKEN (not simply "the most recent row"), so that:
// - a token that never existed on this resource -> permission_denied
//   ("wrong/absent token", checked first, docs/protocol.md precedence).
// - a token that matches a row which is no longer the active claim
//   (reaped after natural expiry, or superseded by a later reclaim) ->
//   claim_expired, even after someone else has already reclaimed the
//   resource with a brand-new token.
// - a token that matches the CURRENTLY claimed row, but whose lease has
//   passed lease_expires_at and has not yet been reaped by anyone ->
//   claim_expired (time-checked, not state-checked, since reaping only
//   happens lazily at the next claim attempt).

import { createHash, randomBytes } from 'node:crypto';
import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';

// F6: the owning resource row for each claimable resource_type — reused
// by acquireClaim's reap branch and by reapExpired() below so an expired
// claim's resource is put back to 'pending', not left stuck 'claimed'
// forever (only the next claim ATTEMPT used to reap; a state-filtered
// list/poll saw nothing until then).
function resourceTableFor(resourceType) {
  if (resourceType === 'delivery') return 'deliveries';
  if (resourceType === 'resume_request') return 'resume_requests';
  return null;
}

// 60s default lease, matching tldr;'s TLDR_AGENT_INBOUND_CLAIM_POLICY
// default (a tuned operational parameter, not an architectural fact —
// the behavior inventory §5). 24h max: a "sane bound" so a caller
// cannot hold a resource claimed indefinitely by requesting an
// absurdly long lease.
export const DEFAULT_LEASE_MS = 60_000;
export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

// A delivery that its claimant cannot finish must never block newer
// deliveries (user decision, 2026-09-22). Auto-select offers never-claimed
// deliveries first, holds an expired or released claim back for a doubling
// backoff, and fails a delivery terminally once it has been claimed
// MAX_DELIVERY_CLAIM_ATTEMPTS times without an outcome. With the default
// 60s lease the whole retry budget spans roughly one hour, which rides out
// a provider outage without letting one poison row cycle forever.
export const MAX_DELIVERY_CLAIM_ATTEMPTS = 8;
// The cause a delivery failed for once its claim budget is spent (a released marker claim's outcome).
export const CLAIM_ATTEMPTS_EXHAUSTED = 'claim_attempts_exhausted';
export const DELIVERY_RETRY_BASE_MS = 30_000;
export const DELIVERY_RETRY_MAX_MS = 15 * 60 * 1000;

// A claimant cut off before it sent anything (a daemon phase abort on an
// overloaded host) releases with this outcome: the claim gives its attempt
// back and auto-select offers the delivery again at once (ac-jfv.87). Only
// delivery.release accepts it; a claimant that may have sent keeps the
// plain release, which counts.
export const UNSENT_ABORT_OUTCOME = 'aborted_unsent';
// The stored outcome carries the run of unsent aborts that ends at that claim ("aborted_unsent:3"),
// so the next release extends it from the previous claim instead of recounting the history.
export const isUnsentOutcome = (outcome) => typeof outcome === 'string' && outcome.startsWith(UNSENT_ABORT_OUTCOME);
export const unsentRun = (outcome) => (isUnsentOutcome(outcome) ? Number(outcome.split(':')[1]) || 1 : 0);
// A delivery whose claimants abort unsent this many times in a row is logged (never failed).
export const UNSENT_ABORT_WARN_EVERY = 10;

// ac-jfv.239: a failed delivery's cause is `deliveries.failure_cause`, set in the same UPDATE by
// every writer that ends a channel copy, and carried by state export (claims are not). Values:
// consumer_failed, skipped:<reason> (ac-jfv.55), channel_consumer_absent, channel_route_retired
// (ac-uc6tr), claim_attempts_exhausted (ac-votvj); legacy:<outcome> from the schema-32 backfill.
// NULL on a failed row: an endpoint delivery, or unknown. Claims keep history only.
export const CONSUMER_FAILED = 'consumer_failed';
export const CHANNEL_CONSUMER_ABSENT = 'channel_consumer_absent';
export const CHANNEL_ROUTE_RETIRED = 'channel_route_retired';
// The daemon's own causes for a copy it ended: none of them is a skip (another channel delivered
// it), and none is an abandoned endpoint delivery (abandonBlocks).
export const CHANNEL_COPY_CAUSES = new Set([CHANNEL_CONSUMER_ABSENT, CHANNEL_ROUTE_RETIRED]);

// SQL: delivery `alias` was skipped by policy (ac-jfv.55). The one reading every state reader shares.
// Both predicates are 0 or 1, never NULL: a NULL inside NOT or SUM would drop the row from a count.
export const skippedDeliverySql = (alias) => `(${alias}.state = 'failed' AND COALESCE(${alias}.failure_cause, '') LIKE 'skipped:%')`;

// SQL: channel copy `alias` ended without a fault anyone could fix on that channel, so a staged
// root counts it resolved beside a delivered copy (ac-jfv.243): skipped by policy, no consumer
// ever drained the channel, or its route is gone. A consumer's failure, a spent claim budget, a
// legacy or unknown cause stay unresolved: the user may have missed the message where they read.
export const resolvedCopySql = (alias) =>
  `(${alias}.state = 'failed' AND (COALESCE(${alias}.failure_cause, '') LIKE 'skipped:%' OR COALESCE(${alias}.failure_cause, '') IN ('${CHANNEL_CONSUMER_ABSENT}', '${CHANNEL_ROUTE_RETIRED}')))`;

// ac-jfv.161: mail abandoned on a dead holder is never delivered late, by any path. An abandoned
// delivery leaves a released delivery claim with this outcome (no schema change); every writer
// that creates a delivery of an EXISTING message goes through routeExistingMessage (the one
// exception: channel_reply_mirror's backfillMirrors writes channel-route deliveries, which the
// abandon never touches), and every check below asks the same question, abandonBlocks.
export const ABANDONED_DELIVERY_OUTCOME = 'dead_holder_abandoned';

// One scope for every check (retire, route, refuse, inherit), so they can never disagree. For each
// abandoned copy of the message, on endpoint E at time `at`, `endpointId` is blocked when it is in
// E's replacement lineage (both directions), or when it takes custody of the work from E AFTER the
// abandon (E held an attempt of the root the message opened). An endpoint that already held an
// attempt of that root BEFORE the abandon (a switch gave it the work earlier) is not blocked: its
// mail is not a pile-up. `prospective` asks the question of a recovery about to admit its attempt:
// the target counts as holding it now, so a check before the insert answers like one after it.
const ABANDONED_COPIES = `
  SELECT d.endpoint_id AS endpoint_id, c.released_at AS at FROM deliveries d
    JOIN claims c ON c.resource_type = 'delivery' AND c.resource_id = d.id AND c.outcome = ?
   WHERE d.message_id = ? AND d.state = 'failed' AND d.read_at IS NULL`;
const BLOCKED_BY_COPY = `
  WITH RECURSIVE lineage(id) AS (
    SELECT ?
    UNION SELECT rr.replacement_endpoint_id FROM resume_requests rr JOIN lineage l ON rr.endpoint_id = l.id WHERE rr.replacement_endpoint_id IS NOT NULL
    UNION SELECT rr.endpoint_id FROM resume_requests rr JOIN lineage l ON rr.replacement_endpoint_id = l.id)
  SELECT 1 FROM lineage WHERE id = ?
  UNION ALL
  SELECT 1 FROM message_effects me
    JOIN obligations before ON before.parent_id = me.obligation_id AND before.role = 'attempt' AND before.custodian_endpoint_id = ?
   WHERE me.effect = 'open' AND me.message_id = ?
     AND (? = 1 OR EXISTS (SELECT 1 FROM obligations after WHERE after.parent_id = me.obligation_id AND after.role = 'attempt' AND after.custodian_endpoint_id = ? AND after.created_at >= ?))
     AND NOT EXISTS (SELECT 1 FROM obligations own WHERE own.parent_id = me.obligation_id AND own.role = 'attempt' AND own.custodian_endpoint_id = ? AND own.created_at < ?)
  LIMIT 1`;

export function abandonBlocks(db, { messageId, endpointId, prospective = false }) {
  const copies = db.prepare(ABANDONED_COPIES).all(ABANDONED_DELIVERY_OUTCOME, messageId);
  const blocked = db.prepare(BLOCKED_BY_COPY);
  return copies.some((copy) => blocked.get(copy.endpoint_id, endpointId, copy.endpoint_id, messageId, Number(prospective), endpointId, copy.at, endpointId, copy.at) !== undefined);
}

/**
 * The one writer of a delivery row for an EXISTING message (a recovery route, a replacement
 * admission). Returns the new delivery id, or null when the message was abandoned for `subjectId`
 * (the endpoint the work comes from or goes to; defaults to the target): nothing is written.
 */
export function routeExistingMessage(db, { messageId, endpointId, subjectId = endpointId, routeReason, sourceObligationId, now }) {
  if (abandonBlocks(db, { messageId, endpointId: subjectId })) return null;
  const id = generateId('delivery');
  db.prepare(
    "INSERT INTO deliveries (id, message_id, endpoint_id, state, route_reason, source_obligation_id, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
  ).run(id, messageId, endpointId, routeReason, sourceObligationId, now, now);
  return id;
}

/**
 * A failed wake request whose message was abandoned for its endpoint must never seed a replacement
 * (the sweep would insert the opener again, typed and fresh): end its eligibility for good.
 */
export function retireAbandonedRequest(db, { request, now, logger }) {
  if (!abandonBlocks(db, { messageId: request.message_id, endpointId: request.endpoint_id })) return false;
  db.prepare('UPDATE resume_requests SET replacement_failure_reason = ?, updated_at = ? WHERE id = ?').run(ABANDONED_DELIVERY_OUTCOME, now, request.id);
  logger?.info?.({
    event: 'resume_replacement_skipped_abandoned_message',
    params: { resume_request_id: request.id, endpoint_id: request.endpoint_id },
    status: 'skipped',
  });
  return true;
}

/** True (and logged) when a recovery route of `messageId` to `target` must be skipped (an inherited root: custody moves, the abandoned opener is never routed). */
export function skipAbandonedOpener(db, { messageId, target, rootId, operation, logger }) {
  if (!abandonBlocks(db, { messageId, endpointId: target.id, prospective: true })) return false;
  logger?.info?.({ event: 'recovery_route_skipped_abandoned_opener', params: { root_obligation_id: rootId, target_endpoint_id: target.id, operation }, status: 'skipped' });
  return true;
}

/**
 * A direct retry or switch of a root whose opener was abandoned for the target is refused whole,
 * before any write (prospective: the target counts as holding the attempt it is about to be
 * given, so this answers like the route check after the insert). Kept younger mail is never
 * moved, copied or failed: it waits on its own endpoint, which reads it on its next wake.
 */
export function refuseAbandonedRoot({ db, logger }, { root, target }) {
  const opener = db.prepare("SELECT message_id FROM message_effects WHERE effect = 'open' AND obligation_id = ?").get(root.id);
  if (!opener || !abandonBlocks(db, { messageId: opener.message_id, endpointId: target.id, prospective: true })) return;
  logger?.info?.({ event: 'recovery_refused_abandoned_root', params: { root_obligation_id: root.id, target_endpoint_id: target.id }, status: 'refused' });
  throw new TightbeamError('obligation_conflict', `root "${root.id}" was opened by mail abandoned on a dead holder; recovering it would deliver that mail late — send a new message instead`, {
    field: 'root_obligation_id',
  });
}

/** When a claim stopped holding its lease: a voluntary release, or lease expiry. */
export function claimEndedAtMs(claim) {
  const leaseEnd = Date.parse(claim.lease_expires_at);
  if (claim.state === 'released' && claim.released_at) return Math.min(leaseEnd, Date.parse(claim.released_at));
  return leaseEnd;
}

/** Wait after the attempts-th unfinished claim before auto-select offers the delivery again. */
export function deliveryRetryDelayMs(attempts) {
  if (!Number.isInteger(attempts) || attempts <= 0) return 0;
  return Math.min(DELIVERY_RETRY_BASE_MS * 2 ** (attempts - 1), DELIVERY_RETRY_MAX_MS);
}

export function resolveLeaseMs(value) {
  if (value === undefined || value === null) return DEFAULT_LEASE_MS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TightbeamError('malformed_request', 'lease_ms must be a positive integer when present', { field: 'lease_ms' });
  }
  return Math.min(value, MAX_LEASE_MS);
}

/**
 * Acquires a new claim on (resourceType, resourceId), reaping an expired
 * active claim first if one exists. Throws claim_held if an active,
 * unexpired claim is already present. Must be called inside the caller's
 * withTransaction.
 */
export function acquireClaim(db, { resourceType, resourceId, leaseMs, now }) {
  const active = db
    .prepare("SELECT * FROM claims WHERE resource_type = ? AND resource_id = ? AND state = 'claimed'")
    .get(resourceType, resourceId);

  if (active) {
    if (Date.parse(active.lease_expires_at) > now.getTime()) {
      throw new TightbeamError('claim_held', `${resourceType} "${resourceId}" is already claimed`, {
        lease_expires_at: active.lease_expires_at,
      });
    }
    db.prepare("UPDATE claims SET state = 'released', outcome = 'expired', released_at = ? WHERE id = ?").run(
      now.toISOString(),
      active.id,
    );
    const table = resourceTableFor(resourceType);
    if (table) {
      db.prepare(`UPDATE ${table} SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'claimed'`).run(
        now.toISOString(),
        resourceId,
      );
    }
  }

  const mostRecent = db
    .prepare('SELECT attempt_count FROM claims WHERE resource_type = ? AND resource_id = ? ORDER BY id DESC LIMIT 1')
    .get(resourceType, resourceId);
  const attemptCount = (mostRecent ? mostRecent.attempt_count : 0) + 1;

  const token = randomBytes(16).toString('hex');
  const claimedAt = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();

  db.prepare(
    `INSERT INTO claims (resource_type, resource_id, state, token, claimed_at, lease_expires_at, attempt_count, released_at, outcome)
     VALUES (?, ?, 'claimed', ?, ?, ?, ?, NULL, NULL)`,
  ).run(resourceType, resourceId, token, claimedAt, leaseExpiresAt, attemptCount);

  return { token, claimedAt, leaseExpiresAt, attemptCount };
}

/**
 * Issues recoverable opaque reply capability material. The durable state
 * stores only the digest, so a state export remains useful for validation
 * after import without itself becoming an inbound-publish credential.
 */
export function issueReplyBindingToken(db, { bindingId, now }) {
  const token = `rpb_${randomBytes(32).toString('hex')}`;
  const digest = `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
  db.prepare(
    'INSERT INTO reply_binding_tokens (token_digest, binding_id, issued_at, retired_at) VALUES (?, ?, ?, NULL)',
  ).run(digest, bindingId, now.toISOString());
  return token;
}

/**
 * Verifies a presented token against (resourceType, resourceId). Throws
 * permission_denied for a token that does not match any claim ever made
 * on this resource, or claim_expired for a token whose claim is no
 * longer the active holder (naturally expired, whether or not it has
 * been reaped/reclaimed yet). Returns { row, alreadyResolved } for a
 * currently-valid claim (alreadyResolved: false) or a durably-completed
 * one (alreadyResolved: true, row.outcome is 'completed' or 'failed') so
 * the caller can short-circuit an idempotent replay.
 */
export function verifyClaimToken(db, { resourceType, resourceId, token, now, allowUnreapedExpiry = false }) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TightbeamError('permission_denied', 'a claim token is required');
  }

  const row = db
    .prepare('SELECT * FROM claims WHERE resource_type = ? AND resource_id = ? AND token = ? ORDER BY id DESC LIMIT 1')
    .get(resourceType, resourceId, token);
  if (!row) {
    throw new TightbeamError('permission_denied', 'presented token does not match any claim on this resource');
  }

  if (row.state === 'claimed') {
    // An unsent-abort release may land after the lease on a slow host; while
    // the row is still unreaped nobody else holds the delivery, so it is honored.
    if (!allowUnreapedExpiry && Date.parse(row.lease_expires_at) <= now.getTime()) {
      throw new TightbeamError('claim_expired', 'the claim lease has expired');
    }
    return { row, alreadyResolved: false };
  }

  if (row.outcome === 'completed' || row.outcome === 'failed' || row.outcome?.startsWith('skipped:')) {
    return { row, alreadyResolved: true };
  }
  throw new TightbeamError('claim_expired', 'the claim is no longer active');
}

/**
 * F6: reaps every claim of `resourceType` whose lease has expired but
 * which nothing has yet attempted to reclaim (acquireClaim's own reap
 * branch only fires lazily, on the NEXT claim attempt on that exact
 * resource) — releasing the stale claim row and returning its owning
 * resource row (a delivery or resume_request left 'claimed') to
 * 'pending', in one transaction. Callers wrap this in withTransaction.
 * Intended to run proactively at the top of state-filtered polling ops
 * (resume.list, inbox.list) so abandoned work becomes visible again
 * without requiring a fresh claim attempt first.
 */
export function reapExpired(db, resourceType, now) {
  const table = resourceTableFor(resourceType);
  if (!table) return;

  const expired = db
    .prepare("SELECT id, resource_id FROM claims WHERE resource_type = ? AND state = 'claimed' AND lease_expires_at <= ?")
    .all(resourceType, now.toISOString());
  if (expired.length === 0) return;

  const releaseStmt = db.prepare("UPDATE claims SET state = 'released', outcome = 'expired', released_at = ? WHERE id = ?");
  const resetStmt = db.prepare(`UPDATE ${table} SET state = 'pending', updated_at = ? WHERE id = ? AND state = 'claimed'`);
  for (const row of expired) {
    releaseStmt.run(now.toISOString(), row.id);
    resetStmt.run(now.toISOString(), row.resource_id);
  }
}

/**
 * Marks a held claim row released with a terminal outcome ('completed',
 * 'failed', or null for a voluntary release with no recorded outcome).
 */
export function releaseClaim(db, { row, outcome, now }) {
  // An unsent abort gives its attempt back, so the next claim restarts from the prior count.
  const attemptCount = isUnsentOutcome(outcome) ? Math.max(row.attempt_count - 1, 0) : row.attempt_count;
  db.prepare("UPDATE claims SET state = 'released', outcome = ?, released_at = ?, attempt_count = ? WHERE id = ?").run(
    outcome,
    now.toISOString(),
    attemptCount,
    row.id,
  );
}
