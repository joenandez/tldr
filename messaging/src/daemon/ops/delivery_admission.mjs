// Delivery admission is deliberately attached to the durable unread row.
// A listener presentation is transport evidence only; a watermark peek is
// the other truthful notification surface.  Both use this one CAS helper.

import { CANCEL_NOTICE_ROUTE_REASON, closedWorkNoticeSql, DELEGATION_NOTICE_ROUTE_REASON } from '../lifecycle_transition.mjs';
import { receivedBeforeSql, receiveOrderBy } from './message_shared.mjs';
import { notificationContext } from './notification_context.mjs';

// Admission order: unread that still asks something first, then what asks
// nothing (closedWorkNoticeSql: a request cancelled or an offer expired before
// receipt, a notice of closed work), each oldest first. So a head whose work
// closed without a receipt never holds the rest of the queue (ac-jfv.217).

/**
 * SQL predicate: unread delivery `earlier` is admitted before `later`.
 * Shaped so the closed-work test runs only on rows received before `later`
 * when `later` asks something (the common case); an endpoint with thousands
 * of unread rows must not pay it per row (ac-jfv.171 perf check).
 */
// closedWorkNoticeSql holds only for a typed notice or a message with an
// open, offer or cancel effect; testing that first keeps plain rows cheap.
export function asksNothingSql(alias) {
  return `(${alias}.route_reason IN ('${DELEGATION_NOTICE_ROUTE_REASON}', '${CANCEL_NOTICE_ROUTE_REASON}')
    OR EXISTS (SELECT 1 FROM message_effects guard_me WHERE guard_me.message_id = ${alias}.message_id
                AND guard_me.effect IN ('open', 'handoff.offer', 'close.cancelled')))
    AND ${closedWorkNoticeSql(alias)}`;
}

// EXISTS an unread row `earlier` (narrowed by `where`) that admission order
// puts ahead of `later`: real work in receive order, then closed-work notices.
// Whether `later` asks nothing is decided once per row, outside the subquery,
// so a backlog never reclassifies the target per candidate.
export function earlierAdmittedExistsSql(later, earlier, where) {
  const asksNothing = (alias) => `(${asksNothingSql(alias)})`;
  const exists = (cond) => `EXISTS (SELECT 1 FROM deliveries ${earlier} WHERE ${where} AND ${cond})`;
  return `(CASE WHEN ${asksNothing(later)}
    THEN ${exists(`(NOT ${asksNothing(earlier)} OR ${receivedBeforeSql(earlier, later)})`)}
    ELSE ${exists(`${receivedBeforeSql(earlier, later)} AND NOT ${asksNothing(earlier)}`)} END)`;
}

// EXISTS an unread row ahead of `later` in receive order that asks something:
// a decided takeover's custody. Its own target may since have closed (still
// launches), and a closed notice ahead of it never strands it.
export function earlierWorkExistsSql(later, earlier, where) {
  return `EXISTS (SELECT 1 FROM deliveries ${earlier} WHERE ${where}
    AND ${receivedBeforeSql(earlier, later)} AND NOT (${asksNothingSql(earlier)}))`;
}

/**
 * The endpoint's unread head in admission order, or null: the oldest row that
 * asks something, else the oldest row. A live oldest row costs one test; a
 * closed prefix is skipped inside SQLite, with no call per row.
 */
export function admissionHead(db, endpointId, { unadmittedOnly = false } = {}) {
  const queue = `FROM deliveries d WHERE d.endpoint_id = ? AND d.state != 'failed' AND d.read_at IS NULL${unadmittedOnly ? " AND d.admitted_at IS NULL" : ""} ORDER BY ${receiveOrderBy("d")}`;
  const head = db.prepare(`SELECT d.id, d.message_id ${queue} LIMIT 1`).get(endpointId) ?? null;
  const closed = head && db.prepare(`SELECT ${asksNothingSql("d")} AS closed FROM deliveries d WHERE d.id = ?`).get(head.id).closed;
  // LIMIT -1 keeps the ordered queue a co-routine: closed work is tested in SQL, row by row, only up to the first live row.
  const live = () => db.prepare(`SELECT d.id, d.message_id FROM (SELECT d.id, d.message_id, d.route_reason, d.source_obligation_id ${queue} LIMIT -1) d WHERE NOT (${asksNothingSql("d")}) LIMIT 1`).get(endpointId);
  return closed ? (live() ?? head) : head;
}

function sameOwner(delivery, endpoint) {
  return (
    delivery.admission_process_generation === endpoint.process_generation &&
    delivery.admission_provider_session_id === endpoint.provider_session_id &&
    delivery.admission_owner_epoch === endpoint.owner_epoch &&
    delivery.admission_owner_launch_token === endpoint.owner_launch_token
  );
}

export function openOldestUnreadAdmission(db, { endpoint, now = new Date().toISOString() }) {
  const head = admissionHead(db, endpoint.id, { unadmittedOnly: true });
  const delivery = head && db
    .prepare(
      `SELECT d.id, d.message_id, admission_opened_at, admission_process_generation, admission_provider_session_id,
              admission_owner_epoch, admission_owner_launch_token, retry_armed_at
              , m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL AS has_external_origin
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.id = ?`,
    )
    .get(head.id);
  if (!delivery) return null;

  if (delivery.admission_opened_at && sameOwner(delivery, endpoint)) {
    return { delivery_id: delivery.id, message_id: delivery.message_id, attempt: delivery.retry_armed_at ? 'retry' : 'initial', has_external_origin: Boolean(delivery.has_external_origin), ...notificationContext(db, delivery.message_id, { deliveryId: delivery.id }) };
  }

  // One open admission per owner: one this owner opened on a delivery that is
  // no longer the head (its work closed before receipt) yields to the head.
  db.prepare(
    `UPDATE deliveries
        SET admission_opened_at = NULL, admission_process_generation = NULL, admission_provider_session_id = NULL,
            admission_owner_epoch = NULL, admission_owner_launch_token = NULL, retry_armed_at = NULL, updated_at = ?
      WHERE endpoint_id = ? AND id != ? AND state != 'failed' AND read_at IS NULL AND admitted_at IS NULL
        AND admission_opened_at IS NOT NULL AND takeover_decided_at IS NULL
        AND admission_process_generation = ? AND admission_provider_session_id IS ?
        AND admission_owner_epoch = ? AND admission_owner_launch_token IS ?`,
  ).run(now, endpoint.id, delivery.id, endpoint.process_generation, endpoint.provider_session_id, endpoint.owner_epoch, endpoint.owner_launch_token);

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
  return { delivery_id: delivery.id, message_id: delivery.message_id, attempt: 'initial', has_external_origin: Boolean(delivery.has_external_origin), ...notificationContext(db, delivery.message_id, { deliveryId: delivery.id }) };
}

// An admission opened before a head that now orders ahead of it (a notice of
// closed work opened first, real work arrived after) moves to that head, so
// the takeover clock always runs on the message a successor must receive.
export function realignStaleAdmissions(db, { now, logger }) {
  const stale = db.prepare(
    `SELECT DISTINCT e.id, e.process_generation, e.provider_session_id, e.owner_epoch, e.owner_launch_token
       FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
      WHERE d.state != 'failed' AND d.read_at IS NULL AND d.admitted_at IS NULL
        AND d.admission_opened_at IS NOT NULL AND d.takeover_decided_at IS NULL
        AND e.state IN ('idle', 'busy')
        AND d.admission_process_generation = e.process_generation
        AND d.admission_provider_session_id IS e.provider_session_id
        AND d.admission_owner_epoch = e.owner_epoch
        AND d.admission_owner_launch_token IS e.owner_launch_token
        AND ${earlierAdmittedExistsSql('d', 'earlier', `earlier.endpoint_id = d.endpoint_id AND earlier.state != 'failed'
             AND earlier.read_at IS NULL AND earlier.admitted_at IS NULL AND earlier.takeover_decided_at IS NULL`)}`,
  ).all();
  for (const endpoint of stale) {
    const opened = openOldestUnreadAdmission(db, { endpoint, now });
    logger?.info?.({ event: 'admission_realigned', params: { endpoint_id: endpoint.id }, result: { delivery_id: opened?.delivery_id ?? null }, status: 'ok' });
  }
}

/**
 * The row receive admits first among `rows` (each carrying delivered_at,
 * delivery_id and asks_nothing): the earliest received that still asks
 * something, else the earliest received.
 */
export function admissionPointer(rows) {
  const live = rows.filter((row) => !row.asks_nothing);
  const earlier = (a, b) => (a.delivered_at < b.delivered_at || (a.delivered_at === b.delivered_at && a.delivery_id < b.delivery_id) ? a : b);
  return (live.length > 0 ? live : rows).reduce(earlier);
}
