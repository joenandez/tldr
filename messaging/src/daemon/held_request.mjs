// A held request's context (ac-4p2j0, scheduled wakes): the attempt's root,
// the message that opened it, and the requester's endpoint.

export const rootOf = (db, attempt) => {
  let node = attempt;
  while (node && node.role !== "root" && node.parent_id) {
    node = db
      .prepare("SELECT * FROM obligations WHERE id = ?")
      .get(node.parent_id);
  }
  return node?.role === "root" ? node : null;
};

// The attempt's root and the message that opened it, plus the requester's
// endpoint from that message's audit; null when no open message is recorded.
export function requestContext(db, attempt) {
  const root = attempt ? rootOf(db, attempt) : null;
  const opening = root
    ? db
        .prepare(
          `SELECT m.id, m.app_id, m.sender_principal_id, me.effect_payload
             FROM message_effects me JOIN messages m ON m.id = me.message_id
            WHERE me.obligation_id = ? AND me.effect = 'open' ORDER BY m.rowid LIMIT 1`,
        )
        .get(root.id)
    : null;
  if (!opening) return null;
  let requesterEndpointId = null;
  try {
    requesterEndpointId =
      JSON.parse(opening.effect_payload)?.declaration?.sender_endpoint_id ??
      null;
  } catch {
    // An unreadable audit leaves the requester unknown; the wake still goes out.
  }
  return { root, opening, requesterEndpointId };
}
