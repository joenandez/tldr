// ac-uc6tr: every channel copy (a delivery with channel_route_id: a message's copy to the Email,
// Slack or Subspace route) reaches a terminal state. dead_holder_abandon covers endpoint mail
// only; a copy for a route nobody drains used to stay `pending` forever. Two paths end it here:
// the periodic sweep (nobody claimed it, or claimed and vanished) and a route's retirement.
import { withTransaction } from "./db.mjs";
import { ensureStagedDeliveryCoverage } from "./held_request_stop.mjs";
import {
  advanceReplyWaitForDelivery,
  closeStagedDeliveryConfirmedChain,
} from "./lifecycle_transition.mjs";
import {
  CHANNEL_CONSUMER_ABSENT,
  CHANNEL_ROUTE_RETIRED,
} from "./ops/claims_shared.mjs";

export {
  CHANNEL_CONSUMER_ABSENT,
  CHANNEL_ROUTE_RETIRED,
  CHANNEL_COPY_CAUSES,
} from "./ops/claims_shared.mjs";

// A live consumer claims a copy within seconds, so a copy unread this long has no consumer. The
// bound covers an app closed overnight; Joe 2026-11-24: "dead-session messages are abandoned, not
// delivered late" (dead_holder_abandon.mjs applies the same rule to endpoint mail at 3 h).
export const CHANNEL_COPY_STALE_AFTER_MS = 24 * 3_600_000;
// A pass fails at most this many copies, oldest first, so the first run over a long backlog
// cannot hold the daemon's write lock for long; the rest go on the next tick.
export const CHANNEL_COPY_SWEEP_BATCH = 200;

// tldr's own in-process adapters drain their routes themselves; their copies are theirs to settle
// (PR #115 email-skip rules read their sibling states), so the sweep leaves them alone.
const OWN_ADAPTER_APPS = ["tldr-email", "tldr-slack"];
// The terms of the partial index deliveries_channel_open (performance_indexes.mjs), repeated so
// SQLite uses it: a pass reads only unfinished channel copies, never the delivered history.
const OPEN_COPY =
  "d.channel_route_id IS NOT NULL AND d.state IN ('pending', 'claimed') AND d.read_at IS NULL";

const MAX_LOGGED_IDS = 20;
// The resumer ticks every second. A pass that found nothing stale waits this long before looking
// again; a pass that failed rows runs again at once, so a backlog drains one batch per tick.
export const CHANNEL_COPY_SWEEP_IDLE_MS = 60_000;
const nextPassAt = new WeakMap();

/**
 * Fails one unread, unfinished channel copy with `cause` on its row (deliveries.failure_cause,
 * ac-jfv.239): its live claim is released with the cause (a late complete or release finds a
 * released claim and gets claim_expired), and a released marker claim keeps the history. Its reply
 * wait ends failed; no notice, wake, retry or root attention follows (the cause is the consumer's,
 * not the sender's). A staged report's copy counts resolved, so its root closes here when a sibling
 * already delivered (ac-jfv.243); when it does not close, the held request keeps a wake once no
 * copy is in flight, as after delivery.complete. Returns 1 when this call failed it, else 0. Runs
 * inside the caller's transaction.
 */
export function failChannelCopy(db, { id, cause, nowIso, logger }) {
  const { changes } = db
    .prepare(
      "UPDATE deliveries SET state = 'failed', failure_cause = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'claimed') AND read_at IS NULL AND channel_route_id IS NOT NULL",
    )
    .run(cause, nowIso, id);
  if (changes === 0) return 0;
  db.prepare(
    "UPDATE claims SET state = 'released', outcome = ?, released_at = ? WHERE resource_type = 'delivery' AND resource_id = ? AND state = 'claimed'",
  ).run(cause, nowIso, id);
  db.prepare(
    "INSERT INTO claims (resource_type, resource_id, state, token, claimed_at, lease_expires_at, released_at, outcome) VALUES ('delivery', ?, 'released', ?, ?, ?, ?, ?)",
  ).run(id, cause, nowIso, nowIso, nowIso, cause);
  // A reply wait on this copy ends failed (delivery_failed) instead of pending forever. Unlike
  // failExhaustedDelivery, no staged-report attention: a swept copy is not the sender's failure.
  advanceReplyWaitForDelivery(db, {
    deliveryId: id,
    outcome: "failed",
    now: nowIso,
  });
  const closure = closeStagedDeliveryConfirmedChain(db, {
    deliveryId: id,
    now: nowIso,
  });
  if (closure)
    logger?.info?.({
      event: "delivery_staged_closure_committed",
      params: { delivery_id: id, cause, ...closure },
      result: "staged_chain_closed",
      status: "ok",
    });
  else
    ensureStagedDeliveryCoverage(db, { deliveryId: id, now: nowIso, logger });
  return 1;
}

/** A retired route's pending and claimed copies fail with channel_route_retired. In the retire's transaction. */
export function failRouteCopies(context, { routeId, nowIso }) {
  const ids = context.db
    .prepare(
      `SELECT d.id FROM deliveries d JOIN channel_routes r ON r.id = d.channel_route_id JOIN applications a ON a.id = r.app_id
        WHERE d.channel_route_id = ? AND ${OPEN_COPY} AND a.name NOT IN (${OWN_ADAPTER_APPS.map(() => "?").join(", ")})`,
    )
    .all(routeId, ...OWN_ADAPTER_APPS);
  const failed = ids.reduce(
    (sum, row) =>
      sum +
      failChannelCopy(context.db, {
        id: row.id,
        cause: CHANNEL_ROUTE_RETIRED,
        nowIso,
        logger: context.logger,
      }),
    0,
  );
  if (failed > 0)
    context.logger?.info?.({
      event: "channel_copies_failed",
      params: { cause: CHANNEL_ROUTE_RETIRED, route_id: routeId },
      result: { count: failed },
      status: "ok",
    });
  return failed;
}

const STALE_COPIES = `
  SELECT d.id FROM deliveries d
    JOIN channel_routes r ON r.id = d.channel_route_id JOIN applications a ON a.id = r.app_id
   WHERE ${OPEN_COPY} AND d.created_at < ?
     AND a.name NOT IN (${OWN_ADAPTER_APPS.map(() => "?").join(", ")})
   ORDER BY d.created_at LIMIT ?`;

// The copies due this pass, [] while an idle pass is backing off. A pass that finds none sets the backoff.
function dueCopies(context, now) {
  if (now.getTime() < (nextPassAt.get(context.db) ?? 0)) return [];
  const cutoff = new Date(
    now.getTime() - CHANNEL_COPY_STALE_AFTER_MS,
  ).toISOString();
  const stale = context.db
    .prepare(STALE_COPIES)
    .all(cutoff, ...OWN_ADAPTER_APPS, CHANNEL_COPY_SWEEP_BATCH);
  nextPassAt.set(
    context.db,
    stale.length === 0 ? now.getTime() + CHANNEL_COPY_SWEEP_IDLE_MS : 0,
  );
  return stale;
}

/**
 * One sweep pass, run from the resumer tick: channel copies unread past the bound fail with
 * channel_consumer_absent. One info line per pass that failed rows; nothing when none did.
 */
export function sweepStaleChannelCopies(context, { now = new Date() } = {}) {
  const startedAt = Date.now();
  const nowIso = now.toISOString();
  // Read first: an idle tick must not take the write lock for nothing (the resumer's own rule).
  const stale = dueCopies(context, now);
  const failedIds =
    stale.length === 0
      ? []
      : withTransaction(context.db, () =>
          stale
            .filter(
              (row) =>
                failChannelCopy(context.db, {
                  id: row.id,
                  cause: CHANNEL_CONSUMER_ABSENT,
                  nowIso,
                  logger: context.logger,
                }) === 1,
            )
            .map((row) => row.id),
        );
  if (failedIds.length > 0)
    context.logger?.info?.({
      event: "channel_copies_failed",
      params: {
        cause: CHANNEL_CONSUMER_ABSENT,
        stale_after_ms: CHANNEL_COPY_STALE_AFTER_MS,
        batch: CHANNEL_COPY_SWEEP_BATCH,
      },
      result: {
        count: failedIds.length,
        delivery_ids: failedIds.slice(0, MAX_LOGGED_IDS),
        not_listed: Math.max(failedIds.length - MAX_LOGGED_IDS, 0),
      },
      status: "ok",
      latency_ms: Date.now() - startedAt,
    });
  return failedIds.length;
}
