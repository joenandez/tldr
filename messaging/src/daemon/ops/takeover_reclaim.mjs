// Handing a decided availability takeover back to its predecessor owner.
// Shared by the resumer (attempts exhausted) and by the predecessor's own
// live call (ac-obpcx): either way the endpoint leaves takeover_pending and
// its delivery is receivable again by the exact owner it had before.

/**
 * Restore the predecessor's exact epoch and token (not a fresh token: a token
 * marks a daemon headless launch, and receipt matches the admission) for the
 * takeover the reconciler decided on this endpoint and message. Only that
 * exact regime (same generation and session, epoch one past the delivery's
 * admission) is released; anything else moved on and is left alone.
 * Call inside the caller's write transaction. Returns the delivery id or null.
 */
export function restoreTakeoverPredecessor(db, { endpointId, messageId, now }) {
  const decided = db
    .prepare(
      `SELECT d.id AS delivery_id, d.admission_owner_epoch, d.admission_owner_launch_token, e.owner_launch_token
       FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
      WHERE d.endpoint_id = ? AND d.message_id = ? AND d.takeover_decided_at IS NOT NULL AND d.read_at IS NULL
        AND e.state = 'takeover_pending' AND e.process_generation = d.admission_process_generation
        AND e.provider_session_id IS d.admission_provider_session_id AND e.owner_epoch = d.admission_owner_epoch + 1`,
    )
    .get(endpointId, messageId);
  if (!decided) return null;
  const restored = db
    .prepare(
      `UPDATE endpoints SET state = 'idle', owner_epoch = ?, owner_launch_token = ?, updated_at = ?
      WHERE id = ? AND state = 'takeover_pending' AND owner_epoch = ? AND owner_launch_token IS ?`,
    )
    .run(
      decided.admission_owner_epoch,
      decided.admission_owner_launch_token,
      now,
      endpointId,
      decided.admission_owner_epoch + 1,
      decided.owner_launch_token,
    );
  if (restored.changes !== 1) return null;
  db.prepare(
    "UPDATE deliveries SET takeover_decided_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now, decided.delivery_id);
  return decided.delivery_id;
}

// The one rule for "the predecessor can still take this endpoint back" that
// reclaim and the send/Stop gates share (ac-jfv.171): a pending availability
// takeover whose session is the endpoint's, with no launch claim ever taken
// (an expired claim goes back to pending, but its successor may still be
// alive, so any claim row keeps the fence), and whose decided delivery
// restoreTakeoverPredecessor can still restore.
const RECLAIMABLE_TAKEOVER = `SELECT r.id AS request_id, r.message_id
  FROM endpoints e
  JOIN resume_requests r ON r.endpoint_id = e.id AND r.reason = 'availability_takeover' AND r.state = 'pending'
   AND r.session_id IS e.provider_session_id
  JOIN deliveries d ON d.endpoint_id = e.id AND d.message_id = r.message_id AND d.takeover_decided_at IS NOT NULL
   AND d.read_at IS NULL AND e.process_generation = d.admission_process_generation
   AND e.provider_session_id IS d.admission_provider_session_id AND e.owner_epoch = d.admission_owner_epoch + 1
 WHERE e.id = ? AND e.state = 'takeover_pending'
   AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.resource_type = 'resume_request' AND c.resource_id = r.id)`;

/**
 * True when `endpointId` is takeover-fenced: takeover_pending and its
 * predecessor can no longer take it back, so it can receive nothing and its
 * unread mail gates neither its thread sends nor its Stop. Reads claims only
 * for a takeover_pending endpoint.
 */
export function takeoverFenced(db, endpointId) {
  const state = db
    .prepare("SELECT state FROM endpoints WHERE id = ?")
    .get(endpointId)?.state;
  return (
    state === "takeover_pending" &&
    !db.prepare(`${RECLAIMABLE_TAKEOVER} LIMIT 1`).get(endpointId)
  );
}

/**
 * The takeover fence exists so a predecessor and its successor never both
 * receive. A call from the endpoint's exact current process (id, generation,
 * provider session, app) proves the predecessor is alive; while no successor
 * has been launched (the takeover request is still pending, unclaimed), it
 * takes the endpoint back and the takeover is failed (only while no launch was ever claimed), so the resumer never
 * launches one. Once a successor is launching the fence holds.
 * Call inside the caller's write transaction. Returns true when reclaimed.
 */
export function reclaimLiveTakeover(
  db,
  input,
  { appId, via, logger, now = new Date().toISOString() },
) {
  const pending = db
    .prepare(
      `${RECLAIMABLE_TAKEOVER} AND e.process_generation = ? AND e.provider_session_id = ? AND e.created_by_app_id = ?
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT 1`,
    )
    .get(
      input.endpoint_id,
      input.process_generation,
      input.provider_session_id,
      appId,
    );
  if (!pending) return false;
  const deliveryId = restoreTakeoverPredecessor(db, {
    endpointId: input.endpoint_id,
    messageId: pending.message_id,
    now,
  });
  if (!deliveryId) return false;
  db.prepare(
    `UPDATE resume_requests SET state = 'failed', replacement_failure_reason = 'predecessor_alive', updated_at = ?
      WHERE id = ? AND state = 'pending'`,
  ).run(now, pending.request_id);
  logger?.info?.({
    event: "availability_takeover_reclaimed",
    params: {
      endpoint_id: input.endpoint_id,
      message_id: pending.message_id,
      resume_request_id: pending.request_id,
      via,
    },
    result: { delivery_id: deliveryId },
    status: "ok",
  });
  return true;
}
