// The one current-owner receipt, shared by message.receive and the daemon
// push (run_input.mjs): owner-tuple recheck, read_at CAS, linked effects and
// the next admission, all inside the caller's write transaction.

import { TightbeamError } from "../../protocol/envelope.mjs";
import { openOldestUnreadAdmission } from "./delivery_admission.mjs";
import { completeResumeRequestsForMessage } from "./resume_shared.mjs";
import { satisfyBoundReplyWait } from "./message_reply_wait_admission.mjs";
import { earlierAdmittedExistsSql } from "./delivery_admission.mjs";
import { receiveOrderBy } from "./message_shared.mjs";

function exactCurrentOwnerReceipt(db, input, appId) {
  return db
    .prepare(
      `SELECT d.id AS delivery_id, d.read_at, d.admitted_at, m.id AS message_id, m.conversation_id, m.body,
              e.id AS endpoint_id, e.process_generation, e.provider_session_id, e.owner_epoch, e.owner_launch_token
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.message_id = ? AND d.state != 'failed'
          AND e.id = ? AND e.process_generation = ? AND e.provider_session_id = ?
          AND e.created_by_app_id = ? AND e.state IN ('idle', 'busy')
          AND d.admission_opened_at IS NOT NULL AND d.takeover_decided_at IS NULL
          AND d.admission_process_generation = e.process_generation
          AND d.admission_provider_session_id IS e.provider_session_id
          AND d.admission_owner_epoch = e.owner_epoch
          AND d.admission_owner_launch_token IS e.owner_launch_token
          AND (
            d.read_at IS NOT NULL
            OR (
              d.admitted_at IS NULL
              AND NOT ${earlierAdmittedExistsSql("d", "earlier", "earlier.endpoint_id = e.id AND earlier.state != 'failed' AND earlier.read_at IS NULL")}
            )
          )
        ORDER BY ${receiveOrderBy("d")}
        LIMIT 1`,
    )
    .get(
      input.message_id,
      input.endpoint_id,
      input.process_generation,
      input.provider_session_id,
      appId,
    );
}

function admitCurrentOwnerReceipt(db, current, now) {
  const admitted = db
    .prepare(
      `UPDATE deliveries
          SET admitted_at = ?, read_at = ?, updated_at = ?
        WHERE id = ? AND read_at IS NULL AND admitted_at IS NULL AND takeover_decided_at IS NULL
          AND admission_process_generation = ? AND admission_provider_session_id IS ?
          AND admission_owner_epoch = ? AND admission_owner_launch_token IS ?
          AND NOT EXISTS (
            SELECT 1 FROM deliveries d
             WHERE d.id = ?
               AND ${earlierAdmittedExistsSql("d", "earlier", "earlier.endpoint_id = ? AND earlier.state != 'failed' AND earlier.read_at IS NULL")}
          )`,
    )
    .run(
      now,
      now,
      now,
      current.delivery_id,
      current.process_generation,
      current.provider_session_id,
      current.owner_epoch,
      current.owner_launch_token,
      current.delivery_id,
      current.endpoint_id,
    );
  return admitted.changes === 1;
}

export function admitLinkedPresentation(db, current, now) {
  satisfyBoundReplyWait(db, current, now);
  const presentation = db
    .prepare(
      `SELECT p.id AS presentation_id, p.reply_wait_id
         FROM listener_presentations p
         JOIN listeners l ON l.id = p.listener_id AND l.listener_generation = p.listener_generation
        WHERE p.target_delivery_id = ? AND p.message_id = ? AND p.state = 'acked'
          AND l.endpoint_id = ? AND l.process_generation = ? AND l.provider_session_id IS ?
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT 1`,
    )
    .get(
      current.delivery_id,
      current.message_id,
      current.endpoint_id,
      current.process_generation,
      current.provider_session_id,
    );
  if (!presentation) return;
  db.prepare(
    "UPDATE listener_presentations SET admitted_at = COALESCE(admitted_at, ?), updated_at = ? WHERE id = ? AND state = 'acked'",
  ).run(now, now, presentation.presentation_id);
  if (presentation.reply_wait_id) {
    db.prepare(
      `UPDATE reply_waits SET state = 'satisfied', terminal_reason = 'provider_admission', updated_at = ?, closed_at = ?
        WHERE id = ? AND endpoint_id = ? AND process_generation = ? AND state IN ('eligible', 'pending_delivery')`,
    ).run(
      now,
      now,
      presentation.reply_wait_id,
      current.endpoint_id,
      current.process_generation,
    );
  }
}

function openedNextDelivery(db, current) {
  return db
    .prepare(
      `SELECT id
       FROM deliveries
      WHERE endpoint_id = ? AND state != 'failed' AND read_at IS NULL AND admitted_at IS NULL
        AND admission_opened_at IS NOT NULL AND takeover_decided_at IS NULL
        AND admission_process_generation = ? AND admission_provider_session_id IS ?
        AND admission_owner_epoch = ? AND admission_owner_launch_token IS ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    )
    .get(
      current.endpoint_id,
      current.process_generation,
      current.provider_session_id,
      current.owner_epoch,
      current.owner_launch_token,
    );
}

// The push has no hook peek that opened the admission, so it opens the oldest
// one itself, but only for the exact owner it captured before its socket I/O,
// and only while that owner is not observed exited. The receipt runs in the
// same transaction, so this gate also holds for the read_at write.
function openAdmissionForCapturedOwner(db, input, appId) {
  const endpoint = db
    .prepare(
      `SELECT id, process_generation, provider_session_id, owner_epoch, owner_launch_token
       FROM endpoints
      WHERE id = ? AND process_generation = ? AND provider_session_id = ? AND owner_epoch = ? AND owner_launch_token IS ?
        AND created_by_app_id = ? AND state IN ('idle', 'busy') AND owner_process_exited_at IS NULL`,
    )
    .get(
      input.endpoint_id,
      input.process_generation,
      input.provider_session_id,
      input.owner_epoch,
      input.owner_launch_token ?? null,
      appId,
    );
  if (endpoint) openOldestUnreadAdmission(db, { endpoint });
  return Boolean(endpoint);
}

// Receipt committed before its compatibility wake is recoverable: an
// idempotent exact replay must repair the already-open next notification
// without touching durable receipt timestamps.
function replayedReceipt(db, current) {
  const next = openedNextDelivery(db, current);
  return {
    current,
    idempotent_replay: true,
    wake: next
      ? { deliveryId: next.id, sessionId: current.provider_session_id }
      : null,
  };
}

function freshReceipt(db, current) {
  const now = new Date().toISOString();
  if (!admitCurrentOwnerReceipt(db, current, now)) {
    throw new TightbeamError(
      "listener_conflict",
      "current-owner delivery is no longer readable",
    );
  }
  admitLinkedPresentation(db, current, now);
  completeResumeRequestsForMessage(db, {
    messageId: current.message_id,
    principalId: db
      .prepare("SELECT principal_id FROM endpoints WHERE id = ?")
      .get(current.endpoint_id).principal_id,
    endpointId: current.endpoint_id,
    now,
  });
  const next = openOldestUnreadAdmission(db, {
    endpoint: {
      id: current.endpoint_id,
      process_generation: current.process_generation,
      provider_session_id: current.provider_session_id,
      owner_epoch: current.owner_epoch,
      owner_launch_token: current.owner_launch_token,
    },
    now,
  });
  return {
    current,
    idempotent_replay: false,
    wake: next
      ? { deliveryId: next.delivery_id, sessionId: current.provider_session_id }
      : null,
  };
}

/**
 * `input`: message_id, endpoint_id, process_generation, provider_session_id;
 * with `openAdmission` also the captured owner_epoch and owner_launch_token,
 * and the endpoint's oldest unread admission is opened for that exact owner
 * first. Returns null when this exact owner holds no current-owner receipt,
 * else `{ current, idempotent_replay, wake }` (wake: `{ deliveryId, sessionId }` or null).
 * Throws listener_conflict when the read_at CAS loses.
 */
export function recordCurrentOwnerReceipt(
  db,
  input,
  { appId, openAdmission = false },
) {
  const owned =
    !openAdmission || openAdmissionForCapturedOwner(db, input, appId);
  const current = owned ? exactCurrentOwnerReceipt(db, input, appId) : null;
  if (!current) return null;
  return current.read_at
    ? replayedReceipt(db, current)
    : freshReceipt(db, current);
}
