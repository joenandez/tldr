// message.receive's last receipt path: a live session's own unread delivery.

import { TightbeamError } from "../../protocol/envelope.mjs";
import { markExactDeliveryRead } from "./message_read.mjs";
import { receiveOrderBy, receivedBeforeSql } from "./message_shared.mjs";

// Any live session receives any delivery addressed to it (Joe, 2026-10-25;
// ac-jfv.26/.27). Launch kind, admission windows, and claimed resume requests
// only decide how tldr shows a message; receipt needs the asker to be the
// endpoint's current process. The other receipt paths keep their bookkeeping
// when they match; this one reads only unread deliveries, oldest first.
export function exactLiveSessionReceipt(db, input, appId) {
  return db
    .prepare(
      `SELECT d.id AS delivery_id, m.id AS message_id, m.conversation_id, m.body,
              e.id AS endpoint_id, e.process_generation, e.provider_session_id
         FROM deliveries d
         JOIN messages m ON m.id = d.message_id
         JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.message_id = ? AND d.state != 'failed' AND d.read_at IS NULL
          AND e.id = ? AND e.process_generation = ? AND e.provider_session_id = ?
          AND e.created_by_app_id = ? AND e.state IN ('idle', 'busy')
          AND NOT EXISTS (
            SELECT 1 FROM deliveries earlier
             WHERE earlier.endpoint_id = e.id AND earlier.state != 'failed'
               AND earlier.read_at IS NULL
               AND ${receivedBeforeSql("earlier", "d")}
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

// Reads the delivery (which completes its resume requests). A daemon resume
// claimed for it stays recorded as served by this process, as ordinary
// recovery records it.
export function admitLiveSessionReceipt(db, live, input) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE resume_requests
        SET admitted_at = ?, admitted_process_generation = ?, admitted_provider_session_id = ?, updated_at = ?
      WHERE endpoint_id = ? AND message_id = ? AND state = 'claimed'
        AND admitted_at IS NULL AND admitted_process_generation IS NULL AND admitted_provider_session_id IS NULL`,
  ).run(
    now,
    input.process_generation,
    input.provider_session_id,
    now,
    live.endpoint_id,
    live.message_id,
  );
  if (
    !markExactDeliveryRead(db, {
      deliveryId: live.delivery_id,
      endpointId: live.endpoint_id,
      now,
    })
  ) {
    throw new TightbeamError(
      "listener_conflict",
      "live session delivery is no longer readable",
    );
  }
  return now;
}

// The receive boundary log names the receipt path that admitted the message.
export function logReceiptAdmitted(logger, input, result) {
  logger?.info?.({
    event: "message_receive_admitted",
    params: {
      message_id: input.message_id,
      endpoint_id: input.endpoint_id,
      process_generation: input.process_generation,
    },
    result,
    status: "ok",
  });
}
