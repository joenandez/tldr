// Polling receipt has no listener presentation. Resolve its human expectation
// through the daemon's canonical binding event, after exact delivery admission.
export function satisfyBoundReplyWait(db, current, now) {
  db.prepare(
    `UPDATE reply_waits
        SET state = 'satisfied', terminal_reason = 'provider_admission', updated_at = ?, closed_at = ?
      WHERE endpoint_id = ? AND process_generation = ? AND provider_session_id IS ?
        AND state IN ('eligible', 'pending_delivery')
        AND binding_id IN (
          SELECT event.binding_id
            FROM reply_binding_events event
            JOIN reply_bindings binding ON binding.id = event.binding_id
            JOIN messages message ON message.id = event.committed_message_id
           WHERE event.committed_message_id = ?
             AND binding.target_endpoint_id = reply_waits.endpoint_id
             AND binding.source_message_id = message.in_reply_to_message_id
        )`,
  ).run(
    now,
    now,
    current.endpoint_id,
    current.process_generation,
    current.provider_session_id,
    current.message_id,
  );
}
