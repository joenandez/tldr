// message.delivery.list — a read-only, sender-authorized projection of the
// ordinary delivery rows created for channel routes. It intentionally has no
// aggregate outcome: each row remains the transport state machine's truth.

import { TightbeamError } from '../../protocol/envelope.mjs';

export const messageDeliveryListOp = {
  name: 'message.delivery.list',
  allowedScopes: ['admin', 'agent'],
  permission: null,
  handler(context, payload, connection) {
    const messageId = payload?.message_id;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new TightbeamError('malformed_request', 'message_id is required and must be a non-empty string', { field: 'message_id' });
    }
    const message = context.db.prepare('SELECT id, app_id FROM messages WHERE id = ?').get(messageId);
    if (!message || (connection.scope !== 'admin' && message.app_id !== connection.appId)) {
      throw new TightbeamError('permission_denied', 'message delivery status is not granted for this message');
    }
    const deliveries = context.db
      .prepare(
        `SELECT d.id AS delivery_id, d.state AS state, r.selector AS selector, r.label AS label
           FROM deliveries d
           JOIN channel_routes r ON r.id = d.channel_route_id
          WHERE d.message_id = ?
          ORDER BY r.selector ASC, d.id ASC`,
      )
      .all(messageId);
    return { result: { message_id: messageId, channel_deliveries: deliveries } };
  },
};
