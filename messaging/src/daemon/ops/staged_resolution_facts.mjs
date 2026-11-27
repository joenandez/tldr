// How long a staged terminal resolution can hold its root open (drive-liveness T5, read-only). Main
// closes such a root only through the typed delivery, so an operator cancel is refused while one is
// pending or claimed. The delivery gives up only through main's own machinery: delivery.claim fails
// it once MAX_DELIVERY_CLAIM_ATTEMPTS unfinished claims are spent, and ensureStagedFailureCoverage
// then takes over. This reads the same constants and delay function; it changes nothing.
//
// gives_up_at assumes a claimant that claims again the moment each backoff ends and runs every
// claim for the lease the latest claim asked for; each claimant poll gap adds to it, and a claim
// ended early by a plain release brings it forward. Exhaustion itself fires at the next
// auto-select delivery.claim after that time.

import {
  claimEndedAtMs,
  deliveryRetryDelayMs,
  isUnsentOutcome,
  MAX_DELIVERY_CLAIM_ATTEMPTS,
  unsentRun,
} from "./claims_shared.mjs";

const iso = (ms) => new Date(ms).toISOString();

// Only a channel delivery has a lane that claims it again, so only it has a real exhaustion path.
// Nothing claims a session delivery on its own, whatever claim history a manual claim left on it.
function unbounded(claim, delivery) {
  if (!delivery.channel_route_id)
    return {
      unbounded_reason: "session_recipient_unclaimed",
      unblocked_by:
        "a delivery.claim and complete at the recipient's endpoint, a resume launch failing because its working directory is gone, or a replacement or recovery of that endpoint; reading it does not settle it and nothing claims a session delivery",
    };
  if (claim && isUnsentOutcome(claim.outcome))
    return {
      unbounded_reason: "unsent_aborts",
      unblocked_by: `a claimant that completes it, or a release that counts; ${unsentRun(claim.outcome)} unsent abort(s) in a row have each given the attempt back, and an unsent abort is never failed`,
    };
  return claim
    ? null
    : {
        unbounded_reason: "awaiting_first_claim",
        unblocked_by:
          "the channel lane claiming it; nothing fails a delivery nobody has claimed",
      };
}

function bounded(claim) {
  const attempts = claim.attempt_count;
  const endedAt = claimEndedAtMs(claim);
  const leaseMs =
    Date.parse(claim.lease_expires_at) - Date.parse(claim.claimed_at);
  let givesUpAt = endedAt;
  for (let spent = attempts; spent < MAX_DELIVERY_CLAIM_ATTEMPTS; spent += 1)
    givesUpAt += deliveryRetryDelayMs(spent) + leaseMs;
  return {
    next_retry_at:
      attempts < MAX_DELIVERY_CLAIM_ATTEMPTS
        ? iso(endedAt + deliveryRetryDelayMs(attempts))
        : null,
    gives_up_at: iso(givesUpAt),
    assumed_lease_ms: leaseMs,
  };
}

/**
 * The staged resolution of `rootId`, or null when none holds it. It is the one active typed delivery
 * that holds the work longest (an unbounded one first), with how many are active.
 */
export function stagedResolutionFacts(db, rootId) {
  const deliveries = db
    .prepare(
      `SELECT d.id, d.message_id, d.state, d.channel_route_id
         FROM deliveries d
         JOIN message_effects me ON me.message_id = d.message_id AND me.effect IN ('close.fulfilled', 'close.cancelled') AND me.obligation_id = ?
        WHERE d.route_reason = 'close.delivery_confirmed' AND d.source_obligation_id = ?
          AND d.state IN ('pending', 'claimed')
        ORDER BY d.created_at ASC, d.id ASC`,
    )
    .all(rootId, rootId);
  const latestClaim = db.prepare(
    "SELECT * FROM claims WHERE resource_type = 'delivery' AND resource_id = ? ORDER BY id DESC LIMIT 1",
  );
  const facts = deliveries.map((delivery) => {
    const claim = latestClaim.get(delivery.id);
    return {
      message_id: delivery.message_id,
      delivery_id: delivery.id,
      delivery_state: delivery.state,
      attempts: claim?.attempt_count ?? 0,
      next_retry_at: null,
      gives_up_at: null,
      ...(unbounded(claim, delivery) ?? bounded(claim)),
    };
  });
  if (facts.length === 0) return null;
  const longest =
    facts.find((fact) => fact.unbounded_reason) ??
    facts.reduce((a, b) => (b.gives_up_at > a.gives_up_at ? b : a));
  return { ...longest, active_deliveries: facts.length };
}
