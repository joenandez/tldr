// A closed root's immutable resolution as lifecycle.view projects it, plus who
// closed it and when (ac-2ih35): update/complete/park on closed work refuse
// with work_closed naming this, instead of sending agents to recovery.

import {
  CHANNEL_CONSUMER_ABSENT,
  CHANNEL_ROUTE_RETIRED,
} from "./claims_shared.mjs";

const CLOSER =
  "SELECT json_extract(e.effect_payload, '$.declaration.sender_endpoint_id') AS closed_by FROM message_effects e";

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} root a closed obligations row with role 'root'
 */
export function rootResolution(db, root) {
  // The closer is the sender of the effect whose commit closed the root; every
  // root write is guarded by status = 'open', so root.updated_at is the close
  // time. A completion names its message. A cancel closed either in the
  // transaction that wrote its effect (direct: no staged confirmation) or in
  // the one that completed (or policy-skipped, ac-jfv.55) its confirmation
  // delivery's claim (staged), both stamping the same now; a released claim is
  // never rewritten (a delivery's own updated_at moves on read). A staged copy
  // the sweep or a route retire ended closes with no claim, and its failed row
  // is stamped with that now and never read again (ac-jfv.239). An operator
  // cancel writes no effect.
  // shortcut: two staged confirmations completing in the same millisecond tie, and state export/import drops claims (ac-vup83); store the closing message id if that matters.
  const closing =
    root.resolution === "fulfilled"
      ? db
          .prepare(
            `${CLOSER} WHERE e.message_id = ? AND e.effect = 'close.fulfilled'`,
          )
          .get(root.resolution_message_id)
      : root.resolution === "cancelled"
        ? db
            .prepare(
              `WITH staged AS (SELECT id, message_id, failure_cause, updated_at FROM deliveries WHERE source_obligation_id = ? AND route_reason = 'close.delivery_confirmed')
               ${CLOSER} WHERE e.obligation_id = ? AND e.effect = 'close.cancelled' AND (
                 (e.created_at = ? AND e.message_id NOT IN (SELECT message_id FROM staged))
                 OR e.message_id IN (SELECT s.message_id FROM staged s JOIN claims c ON c.resource_type = 'delivery' AND c.resource_id = s.id
                                      WHERE (c.outcome = 'completed' OR c.outcome LIKE 'skipped:%') AND c.released_at = ?)
                 OR e.message_id IN (SELECT message_id FROM staged WHERE failure_cause IN ('${CHANNEL_CONSUMER_ABSENT}', '${CHANNEL_ROUTE_RETIRED}') AND updated_at = ?))`,
            )
            .get(
              root.id,
              root.id,
              root.updated_at,
              root.updated_at,
              root.updated_at,
            )
        : null;
  return {
    resolution: root.resolution,
    message_id: root.resolution_message_id,
    outcome: root.resolution_outcome,
    reason: root.resolution_reason,
    source: root.resolution_source,
    replacement_id: root.resolution_replacement_id,
    closed_by_endpoint_id: closing?.closed_by ?? null,
    // Every root write is guarded by status = 'open', so the last one is the
    // close; a delivery-confirmed close staged its effect earlier.
    closed_at: root.updated_at,
  };
}
