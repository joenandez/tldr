// A session never stops while it holds an open request it has neither
// completed nor parked (thread-followups B). A Stop that lets the session go
// leaves a `cap` wake (ensureHeldCoverage) so the scheduled-wake pass brings
// it back.
import { tightbeamCommandName } from "../cli/package_context.mjs";
import {
  hasPendingWake,
  leaveCapWake,
  migrationCutoff,
} from "./scheduled_wakes.mjs";

/** Attention source for a staged report whose exact delivery failed (DELIVERY-FAIL). */
export const DELIVERY_FAILED_ATTENTION_SOURCE = "delivery.failed";

/**
 * True while a staged terminal report still has an ACTIVE (pending/claimed)
 * typed delivery for this root (route reason DELIVERY_CONFIRMED_ROUTE_REASON).
 * A failed delivery drops out of the predicate: the candidate stays as audit
 * and a later close.fulfilled may stage a fresh one (LC-D05 "terminal
 * candidate is retained for audit").
 */
export function hasActiveStagedResolution(db, rootId) {
  return Boolean(
    db
      .prepare(
        `SELECT 1
           FROM deliveries d
           JOIN message_effects me ON me.message_id = d.message_id AND me.effect IN ('close.fulfilled', 'close.cancelled') AND me.obligation_id = ?
          WHERE d.route_reason = 'close.delivery_confirmed' AND d.source_obligation_id = ?
            AND d.state IN ('pending', 'claimed')
          LIMIT 1`,
      )
      .get(rootId, rootId),
  );
}

// Work this endpoint holds (an attempt, or a delegation it accepted: rule 9)
// with no open child (not handed on, so the delegator is exempt), no pending
// wake (not parked), and no complete staged on its root awaiting delivery
// confirmation (521.12), created after the upgrade stamp. A thread with a
// message this endpoint has not read is skipped while Stop's unread path will
// present a message this time (`unreadFirst`), so the session never sees a
// block for a request it has not read. When that path lets Stop pass (its
// escape, or only notices it skips), skipping would drop the request.
function heldAttempts(db, endpoint, { rootOf, unreadFirst }) {
  const cutoff = migrationCutoff(db);
  if (!cutoff) return [];
  const held = db
    .prepare(
      `SELECT a.id, EXISTS (
            SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
             WHERE d.endpoint_id = a.custodian_endpoint_id AND d.read_at IS NULL
               AND d.state != 'failed' AND m.conversation_id = a.conversation_id) AS unread
         FROM obligations a
        WHERE a.role IN ('attempt', 'delegation') AND a.status = 'open' AND a.custodian_endpoint_id = ?
          AND a.created_at >= ?
          AND NOT EXISTS (SELECT 1 FROM obligations c WHERE c.parent_id = a.id AND c.status = 'open')
        ORDER BY a.id`,
    )
    .all(endpoint.id, cutoff)
    .filter(
      (attempt) =>
        !hasPendingWake(db, attempt.id) &&
        !hasActiveStagedResolution(db, rootOf(db, attempt.id)),
    );
  const defer = held.some((attempt) => attempt.unread) && unreadFirst();
  return defer ? held.filter((attempt) => !attempt.unread) : held;
}

/**
 * Invariant D for a Stop whose final decision lets the session go: every held
 * attempt of this endpoint (unread ones included) ends up with a pending
 * wake. A park that presents a message gets one too: the presentation can be
 * missed while the owner stays alive, which queues no resume.
 */
export function ensureHeldCoverage(db, { endpoint, now, rootOf, logger }) {
  if (endpoint.state === "retiring") return 0;
  const held = heldAttempts(db, endpoint, { rootOf, unreadFirst: () => false });
  const woken = held.filter((attempt) =>
    leaveCapWake(db, { attemptId: attempt.id, endpointId: endpoint.id, now }),
  );
  if (woken.length > 0)
    logger?.info({
      event: "held_request_coverage",
      params: { endpoint_id: endpoint.id, held: held.length },
      result: "cap_wake_inserted",
      status: "ok",
    });
  return woken.length;
}

/**
 * A staged complete whose delivery failed puts the root's held leaves back
 * under invariant D, whichever endpoint holds them (the holder may already
 * have stopped).
 */
export function ensureStagedFailureCoverage(db, { rootId, now, logger }) {
  const cutoff = migrationCutoff(db);
  const root = db
    .prepare("SELECT status FROM obligations WHERE id = ?")
    .get(rootId);
  // Held only once no staged delivery (another route) is still in flight.
  if (
    !cutoff ||
    root?.status !== "open" ||
    hasActiveStagedResolution(db, rootId)
  )
    return 0;
  const leaves = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT ? UNION SELECT o.id FROM obligations o JOIN tree t ON o.parent_id = t.id
       )
       SELECT a.id, a.custodian_endpoint_id AS endpoint_id
         FROM obligations a JOIN tree ON tree.id = a.id
        WHERE a.role IN ('attempt', 'delegation') AND a.status = 'open'
          AND a.custodian_endpoint_id IS NOT NULL AND a.created_at >= ?
          AND NOT EXISTS (SELECT 1 FROM obligations c WHERE c.parent_id = a.id AND c.status = 'open')`,
    )
    .all(rootId, cutoff);
  const woken = leaves.filter((leaf) =>
    leaveCapWake(db, { attemptId: leaf.id, endpointId: leaf.endpoint_id, now }),
  );
  logger?.info({
    event: "held_request_failed_delivery_coverage",
    params: { root_obligation_id: rootId, held: leaves.length },
    result: woken.length > 0 ? "cap_wake_inserted" : "already_covered",
    status: "ok",
  });
  return woken.length;
}

function renderHeldReason(rootIds) {
  const cli = tightbeamCommandName();
  const lines = rootIds
    .slice(0, 10)
    .map(
      (id) =>
        `  - ${id}\n` +
        `    done:  ${cli} agent complete --work ${id} --body "<the answer>"\n` +
        `    later: ${cli} agent delegate --work ${id} --at <when you expect the answer> --body "<what you are doing and when you will report back>"`,
    );
  const more =
    rootIds.length > 10 ? `\n  ...and ${rootIds.length - 10} more` : "";
  return (
    `[tightbeam] Cannot stop: you hold ${rootIds.length} open request(s) you have not completed or parked:\n${lines.join("\n")}${more}\n` +
    "Complete the request, or park it with delegate --at (a time like 1h or 2026-10-28T14:00:00Z), then stop again."
  );
}

/**
 * Returns a block decision while a held request is unreported and the root's
 * block budget lasts; null otherwise. Past the cap it inserts nothing: Stop
 * may still block later (pending reply, unread), so the caller leaves the
 * `cap` wake only once the final decision lets the session go
 * (ensureHeldCoverage). Only a pending wake covers a held attempt; the new
 * wake is due at the later of now and 60 min after the attempt's last wake.
 */
export function heldRequestStop(
  db,
  { endpoint, now, trace, cap, rootOf, recordBlock, unreadFirst, logger },
) {
  const held =
    endpoint.state === "retiring"
      ? []
      : heldAttempts(db, endpoint, { rootOf, unreadFirst });
  if (held.length === 0) return null;
  // Only roots with block budget left block or are named; a root past its
  // cap waits for the cap pass, which wakes every held root.
  const roots = [
    ...new Set(held.map((attempt) => rootOf(db, attempt.id))),
  ].filter(
    (rootId) =>
      (db
        .prepare(
          // The failed-delivery mark is visibility, not a spent block.
          `SELECT stop_block_count - (attention_source = '${DELIVERY_FAILED_ATTENTION_SOURCE}') AS n FROM root_attention WHERE root_obligation_id = ?`,
        )
        .get(rootId)?.n ?? 0) < cap,
  );
  if (roots.length === 0) {
    logger?.info({
      event: "held_request_cap_pass",
      params: { endpoint_id: endpoint.id, held: held.length },
      result: "coverage_after_decision",
      status: "ok",
    });
    return null;
  }
  for (const rootId of roots) recordBlock(db, { rootId, now });
  trace.reason = "held_request";
  return {
    decision: "block",
    obligation_ids: [],
    reason: renderHeldReason(roots),
  };
}

/**
 * A staged delivery reached a terminal state without closing the root (another
 * route failed earlier): the request is held again, so cover it.
 */
export function ensureStagedDeliveryCoverage(db, { deliveryId, now, logger }) {
  const delivery = db
    .prepare(
      "SELECT route_reason, source_obligation_id FROM deliveries WHERE id = ?",
    )
    .get(deliveryId);
  if (
    delivery?.route_reason !== "close.delivery_confirmed" ||
    !delivery.source_obligation_id
  )
    return 0;
  return ensureStagedFailureCoverage(db, {
    rootId: delivery.source_obligation_id,
    now: now instanceof Date ? now.toISOString() : now,
    logger,
  });
}
