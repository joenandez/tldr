// ac-jfv.161: mail abandoned on a dead holder is never delivered late. The
// busy-over-exited settle (busy_over_exited_owner.mjs) calls this in its own
// transaction; the writers that could bring an abandoned message back read the
// marker it leaves (ops/claims_shared.mjs: abandonBlocks, routeExistingMessage).
import { withTransaction } from "./db.mjs";
import { LIMIT_HORIZON_MS } from "./ops/resume_fail.mjs";
import { ABANDONED_DELIVERY_OUTCOME } from "./ops/claims_shared.mjs";
import { markRootAttention } from "./custody_reconciler.mjs";

// Mail older than this when a dead holder is settled is abandoned, never delivered late. It must
// exceed the longest healthy wait of a message before a wake reads it: the auth-retry sequence
// (60 s + 5 m + 15 m + 1 h) plus five 3 m launch leases is ~1.6 h, and a hosted queue hold is
// 30 m. A usage-limit hold (up to days) is measured by its own end, not by this bound.
export const DEAD_HOLDER_STALE_AFTER_MS = 3 * 3_600_000;

const MAX_LOGGED_IDS = 20;

// Untyped endpoint deliveries still unread past the bound go `failed`, the terminal state every
// reader already skips (`state != 'failed'`): no new status, no migration. A typed delivery
// (route_reason: a staged report, a recovery route) is spared: failing it skips the reply-wait
// advance and staged-failure attention that delivery.claim/complete run. Staleness runs from the
// later of the delivery and the end of the endpoint's last usage-limit hold, because the settle
// fires exactly when that hold lapses: mail queued during it, or held past the provider's reset,
// is not a pile-up. A limit refusal or usage_limit give-up within LIMIT_HORIZON_MS is spared too,
// for `recovery rewake`. Each abandoned delivery's claim is released with it, its own unstarted
// wake request fails, and the open attempt this endpoint holds for a work request it carried
// closes failed (its wakes cancelled, its scheduled-wake deliveries failed) and the request itself
// stays open, so its root is flagged needs-attention (ac-3d5.95). The requester hears once from
// main's stalled-holder catch-all (holder_stall.mjs, its holder_failed notice says the request was
// abandoned and how old it is); a user request is flagged only (Joe 2026-11-24). Runs in the
// settle's transaction.
// A hold's end is the earlier of its lease and its release (claimEndedAtMs): an operator cancel
// releases a limit_backoff claim but leaves its far lease. The rows match what readers count as
// waiting (`state != 'failed' AND read_at IS NULL`), so a `delivered` row never read is abandoned too.
// A delivery under a live delivery.claim on this dead endpoint is abandoned as well: the claimant
// is a dead session's, and failDelivery releases the claim with it so it cannot complete it later.
const STALE_BACKLOG = `
  SELECT d.id, d.message_id, d.state, d.created_at, m.origin FROM deliveries d JOIN messages m ON m.id = d.message_id
   WHERE d.endpoint_id = ? AND d.channel_route_id IS NULL AND d.route_reason IS NULL
     AND d.state <> 'failed' AND d.read_at IS NULL AND d.created_at < ?
     AND COALESCE((SELECT MAX(MIN(c.lease_expires_at, COALESCE(c.released_at, c.lease_expires_at))) FROM claims c JOIN resume_requests r ON r.id = c.resource_id
                    WHERE c.resource_type = 'resume_request' AND r.endpoint_id = d.endpoint_id
                      AND c.limit_refused_at IS NOT NULL), '') < ?
     AND NOT EXISTS (
       SELECT 1 FROM resume_requests r
         LEFT JOIN claims c ON c.resource_type = 'resume_request' AND c.resource_id = r.id
        WHERE r.endpoint_id = d.endpoint_id AND r.message_id = d.message_id
          AND (c.limit_refused_at >= ? OR (r.replacement_failure_reason = 'usage_limit' AND r.updated_at >= ?)))
   ORDER BY d.created_at ASC, d.id ASC`;

function failDelivery(db, id, nowIso) {
  const { changes } = db
    .prepare(
      "UPDATE deliveries SET state = 'failed', updated_at = ? WHERE id = ? AND read_at IS NULL",
    )
    .run(nowIso, id);
  db.prepare(
    "UPDATE claims SET state = 'released', outcome = 'failed', released_at = ? WHERE resource_type = 'delivery' AND resource_id = ? AND state = 'claimed'",
  ).run(nowIso, id);
  // The marker every recovery check reads (abandonBlocks): abandoned, not failed by chance. Only
  // a row this call changed is marked.
  if (changes > 0)
    db.prepare(
      "INSERT INTO claims (resource_type, resource_id, state, token, claimed_at, lease_expires_at, released_at, outcome) VALUES ('delivery', ?, 'released', 'abandoned', ?, ?, ?, ?)",
    ).run(id, nowIso, nowIso, nowIso, ABANDONED_DELIVERY_OUTCOME);
  return changes;
}

// The attempt this endpoint holds for a work request an abandoned message opened.
// A root whose conversation still has a kept (unread, not failed) delivery for this endpoint stays
// held: the agent will answer that work, and a closed attempt would fail its custody check.
function closeHeldAttempts(db, messageId, { endpointId, nowIso, tally }) {
  const attempts = db
    .prepare(
      `SELECT a.id, a.parent_id, root.status AS root_status FROM obligations a JOIN message_effects me ON me.obligation_id = a.parent_id AND me.effect = 'open'
         JOIN obligations root ON root.id = a.parent_id
        WHERE me.message_id = ? AND a.role = 'attempt' AND a.status = 'open' AND a.custodian_endpoint_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM deliveries k JOIN messages km ON km.id = k.message_id
             WHERE k.endpoint_id = a.custodian_endpoint_id AND km.conversation_id = root.conversation_id
               AND k.state <> 'failed' AND k.read_at IS NULL AND k.route_reason IS NOT 'scheduled.wake')`,
    )
    .all(messageId, endpointId);
  for (const attempt of attempts) {
    const closed = db
      .prepare(
        `UPDATE obligations SET status = 'closed', resolution = 'failed', resolution_reason = 'dead_holder_abandoned',
              resolution_source = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
      )
      .run(`dead_holder_abandoned:${endpointId}`, nowIso, attempt.id).changes;
    tally.attemptsClosed += closed;
    tally.wakesCancelled += db
      .prepare(
        "UPDATE scheduled_wakes SET cancelled_at = ? WHERE attempt_id = ? AND cancelled_at IS NULL",
      )
      .run(nowIso, attempt.id).changes;
    const wakes = db
      .prepare(
        "SELECT id FROM deliveries WHERE endpoint_id = ? AND source_obligation_id = ? AND route_reason = 'scheduled.wake' AND read_at IS NULL AND state <> 'failed'",
      )
      .all(endpointId, attempt.parent_id);
    for (const wake of wakes)
      tally.wakeDeliveriesFailed += failDelivery(db, wake.id, nowIso);
    // Only a close this call made, on a root still open: a rerun or a closed root is not flagged.
    if (closed !== 1 || attempt.root_status !== "open") continue;
    markRootAttention(db, { rootId: attempt.parent_id, now: nowIso });
    tally.rootsFlagged += 1;
  }
}

function abandonStaleBacklog(db, endpointId, nowIso) {
  const nowMs = Date.parse(nowIso);
  const cutoff = new Date(nowMs - DEAD_HOLDER_STALE_AFTER_MS).toISOString();
  const limitSince = new Date(nowMs - LIMIT_HORIZON_MS).toISOString();
  const stale = db
    .prepare(STALE_BACKLOG)
    .all(endpointId, cutoff, cutoff, limitSince, limitSince);
  // A claimed request with a live launch lease is left to its launch.
  const endRequests = db.prepare(
    `UPDATE resume_requests SET state = 'failed', updated_at = ? WHERE endpoint_id = ? AND message_id = ?
        AND (state = 'pending' OR (state = 'claimed' AND NOT EXISTS (
          SELECT 1 FROM claims c WHERE c.resource_type = 'resume_request' AND c.resource_id = resume_requests.id
             AND c.state = 'claimed' AND c.lease_expires_at > ?)))`,
  );
  const tally = {
    count: 0,
    countDeliveredUnread: 0,
    requestsFailed: 0,
    attemptsClosed: 0,
    wakesCancelled: 0,
    wakeDeliveriesFailed: 0,
    rootsFlagged: 0,
  };
  const changed = [];
  for (const delivery of stale) {
    // A `delivered` row never read is waiting to readers; it is counted apart, and marked like the rest.
    const failed = failDelivery(db, delivery.id, nowIso);
    if (failed === 0) continue;
    changed.push(delivery);
    tally[delivery.state === "delivered" ? "countDeliveredUnread" : "count"] +=
      failed;
    tally.requestsFailed += endRequests.run(
      nowIso,
      endpointId,
      delivery.message_id,
      nowIso,
    ).changes;
  }
  // After every stale delivery is failed, so a sibling about to be abandoned does not keep a root.
  for (const delivery of changed) {
    closeHeldAttempts(db, delivery.message_id, { endpointId, nowIso, tally });
  }
  return {
    ...tally,
    countInbound: changed.filter((row) => row.origin === "inbound").length,
    oldestAgeMs:
      changed.length > 0 ? nowMs - Date.parse(changed[0].created_at) : null,
    messageIds: changed.map((row) => row.message_id),
  };
}

// The boundary line, once per settle; the ids (capped) at debug.
function logAbandoned(context, endpointId, abandoned) {
  const params = { endpoint_id: endpointId };
  context.logger?.info?.({
    event: "dead_holder_backlog_abandoned",
    params: { ...params, stale_after_ms: DEAD_HOLDER_STALE_AFTER_MS },
    result: {
      count: abandoned.count,
      count_delivered_unread: abandoned.countDeliveredUnread,
      count_inbound: abandoned.countInbound,
      requests_failed: abandoned.requestsFailed,
      attempts_closed: abandoned.attemptsClosed,
      roots_flagged: abandoned.rootsFlagged,
      wake_deliveries_failed: abandoned.wakeDeliveriesFailed,
      wakes_cancelled: abandoned.wakesCancelled,
      oldest_age_ms: abandoned.oldestAgeMs,
    },
    status: "ok",
  });
  context.logger?.debug?.({
    event: "dead_holder_backlog_abandoned_ids",
    params,
    result: {
      message_ids: abandoned.messageIds.slice(0, MAX_LOGGED_IDS),
      not_listed: Math.max(abandoned.messageIds.length - MAX_LOGGED_IDS, 0),
    },
    status: "ok",
  });
}

/**
 * Runs `write` (an endpoint CAS returning whether it landed) and, when it did,
 * abandons the endpoint's stale backlog in the same transaction. Only the
 * busy-over-exited settle calls it; exported so the unit tests can pin the
 * abandon rules without a stranded row.
 */
export function withBacklogAbandon(context, { endpointId, nowIso }, write) {
  let abandoned = null;
  const landed = withTransaction(context.db, () => {
    const done = write();
    if (done) abandoned = abandonStaleBacklog(context.db, endpointId, nowIso);
    return done;
  });
  if (
    abandoned &&
    abandoned.count +
      abandoned.countDeliveredUnread +
      abandoned.requestsFailed +
      abandoned.attemptsClosed +
      abandoned.wakeDeliveriesFailed +
      abandoned.wakesCancelled >
      0
  )
    logAbandoned(context, endpointId, abandoned);
  return landed;
}
