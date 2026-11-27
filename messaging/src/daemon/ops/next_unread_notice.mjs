// ac-kf9rt v2 R1: a mid-session body is read at the reply (message.read with
// endpoint_id) or an ack (message.acknowledge), not only at message.receive.
// After such a read the endpoint's next unread admission opens for its live
// current owner and that delivery's notice is published, as message.receive
// does; its notice was held while the read one was older and unread.
// Idempotent: the admission CAS reopens nothing for the same owner, and
// readers dedupe a repeated notice line by (delivery_id, attempt).

import { openOldestUnreadAdmission } from "./delivery_admission.mjs";
import { publishSessionNotice } from "./session_notice.mjs";

/** Inside the read's transaction. Returns the wake to publish after commit, or null. */
export function openNextUnreadForLiveOwner(db, endpointId) {
  const endpoint = db
    .prepare(
      `SELECT id, process_generation, provider_session_id, owner_epoch, owner_launch_token
       FROM endpoints
      WHERE id = ? AND provider_session_id IS NOT NULL
        AND state IN ('idle', 'busy') AND owner_process_exited_at IS NULL`,
    )
    .get(endpointId);
  if (!endpoint) return null;
  const next = openOldestUnreadAdmission(db, { endpoint });
  return next
    ? { deliveryId: next.delivery_id, sessionId: endpoint.provider_session_id }
    : null;
}

/** After commit. `context`: db, stateRoot, logger. */
export function publishNextUnread(
  context,
  wake,
  { op, messageId, endpointId },
) {
  context.logger?.debug?.({
    event: "read_next_unread_notice",
    params: { op, message_id: messageId, endpoint_id: endpointId },
    result: { next_delivery_id: wake?.deliveryId ?? null },
    status: "ok",
  });
  if (!wake) return;
  publishSessionNotice(context.db, {
    stateRoot: context.stateRoot,
    ...wake,
    wake: "next_unread",
    logger: context.logger,
  });
}
