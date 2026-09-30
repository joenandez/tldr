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
export const DELIVERY_RETRY_BASE_MS = 30_000;
export const DELIVERY_RETRY_MAX_MS = 15 * 60 * 1000;

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
export function verifyClaimToken(db, { resourceType, resourceId, token, now }) {
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
    if (Date.parse(row.lease_expires_at) <= now.getTime()) {
      throw new TightbeamError('claim_expired', 'the claim lease has expired');
    }
    return { row, alreadyResolved: false };
  }

  if (row.outcome === 'completed' || row.outcome === 'failed') {
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
  db.prepare("UPDATE claims SET state = 'released', outcome = ?, released_at = ? WHERE id = ?").run(
    outcome,
    now.toISOString(),
    row.id,
  );
}
