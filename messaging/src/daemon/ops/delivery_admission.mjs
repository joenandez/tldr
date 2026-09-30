// Delivery admission is deliberately attached to the durable unread row.
// A listener presentation is transport evidence only; a watermark peek is
// the other truthful notification surface.  Both use this one CAS helper.

function sameOwner(delivery, endpoint) {
  return (
    delivery.admission_process_generation === endpoint.process_generation &&
    delivery.admission_provider_session_id === endpoint.provider_session_id &&
    delivery.admission_owner_epoch === endpoint.owner_epoch &&
    delivery.admission_owner_launch_token === endpoint.owner_launch_token
  );
}

export function openOldestUnreadAdmission(db, { endpoint, now = new Date().toISOString() }) {
  const delivery = db
    .prepare(
      `SELECT d.id, d.message_id, admission_opened_at, admission_process_generation, admission_provider_session_id,
              admission_owner_epoch, admission_owner_launch_token, retry_armed_at
              , m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL AS has_external_origin
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.endpoint_id = ? AND d.state != 'failed' AND d.read_at IS NULL AND d.admitted_at IS NULL
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT 1`,
    )
    .get(endpoint.id);
  if (!delivery) return null;

  if (delivery.admission_opened_at && sameOwner(delivery, endpoint)) {
    return { delivery_id: delivery.id, message_id: delivery.message_id, attempt: delivery.retry_armed_at ? 'retry' : 'initial', has_external_origin: Boolean(delivery.has_external_origin) };
  }

  // An ownership change invalidates a predecessor's clock.  The update is
  // deliberately conditional: an unread delivery may never be reopened
  // after takeover has won, and concurrent receipt/takeover cannot inherit
  // an earlier timestamp.
  const opened = db
    .prepare(
      `UPDATE deliveries
          SET admission_opened_at = ?, admission_process_generation = ?, admission_provider_session_id = ?,
              admission_owner_epoch = ?, admission_owner_launch_token = ?, retry_armed_at = NULL, updated_at = ?
        WHERE id = ? AND read_at IS NULL AND admitted_at IS NULL AND takeover_decided_at IS NULL
          AND (
            admission_opened_at IS NULL
            OR admission_process_generation IS NOT ?
            OR admission_provider_session_id IS NOT ?
            OR admission_owner_epoch IS NOT ?
            OR admission_owner_launch_token IS NOT ?
          )`,
    )
    .run(
      now,
      endpoint.process_generation,
      endpoint.provider_session_id,
      endpoint.owner_epoch,
      endpoint.owner_launch_token,
      now,
      delivery.id,
      endpoint.process_generation,
      endpoint.provider_session_id,
      endpoint.owner_epoch,
      endpoint.owner_launch_token,
    );
  if (opened.changes !== 1) return null;
  return { delivery_id: delivery.id, message_id: delivery.message_id, attempt: 'initial', has_external_origin: Boolean(delivery.has_external_origin) };
}
