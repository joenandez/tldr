// message.acknowledge — docs/protocol.md "Conversations and messages".
// Ownership is by endpoint, not principal (acknowledge_delivery is not
// authority-scoped either; the state ownership contract §1 only names
// register_endpoints/send_as_principal as allowed_authorities-scoped), so
// isolation here is `endpoints.created_by_app_id === connection.appId`.
// Unlike inbox.list/message.read, endpoint_unknown IS a listed error for
// this op — existence is not hidden here. Idempotent: acknowledging an
// already-acknowledged delivery is not an error and does not move
// acknowledged_at. Acknowledging implies the message was read.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';

export const messageAcknowledgeOp = {
  name: 'message.acknowledge',
  allowedScopes: ['agent'],
  permission: 'acknowledge_delivery',
  handler(context, payload, connection) {
    const messageId = payload && payload.message_id;
    const endpointId = payload && payload.endpoint_id;
    const processGeneration = payload && payload.process_generation;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new TightbeamError('malformed_request', 'message_id is required and must be a string', { field: 'message_id' });
    }
    if (typeof endpointId !== 'string' || endpointId.length === 0) {
      throw new TightbeamError('malformed_request', 'endpoint_id is required and must be a string', { field: 'endpoint_id' });
    }
    if (!Number.isInteger(processGeneration) || processGeneration < 1) {
      throw new TightbeamError('malformed_request', 'process_generation is required and must be a positive integer', { field: 'process_generation' });
    }

    const endpoint = context.db.prepare('SELECT id, created_by_app_id, principal_id, process_generation, state FROM endpoints WHERE id = ?').get(endpointId);
    if (!endpoint) {
      throw new TightbeamError('endpoint_unknown', `no endpoint registered with id "${endpointId}"`);
    }
    if (endpoint.created_by_app_id !== connection.appId) {
      throw new TightbeamError('permission_denied', 'acknowledge_delivery is not granted for this endpoint');
    }
    if (endpoint.process_generation !== processGeneration) {
      throw new TightbeamError('obligation_conflict', 'process_generation does not name the endpoint\'s active process', { field: 'process_generation', reason: 'process_generation_stale' });
    }
    if (endpoint.state === 'takeover_pending') {
      throw new TightbeamError('identity_conflict', 'endpoint is takeover_pending; predecessor mutations are fenced', { field: 'endpoint_id' });
    }

    const delivery = context.db
      .prepare("SELECT id, read_at, acknowledged_at FROM deliveries WHERE message_id = ? AND endpoint_id = ? AND state != 'failed'")
      .get(messageId, endpointId);
    if (!delivery) {
      throw new TightbeamError('malformed_request', `no delivery found for message "${messageId}" and endpoint "${endpointId}"`, {
        field: 'message_id',
      });
    }

    const now = new Date().toISOString();
    withTransaction(context.db, () => {
      // Acknowledging is a TRANSPORT fact about the delivery row only.
      // The legacy write that advanced the implicit read/acknowledge
      // obligation rows ended at the lifecycle cutover: an
      // acknowledgement never completes forward work (plan Out-of-Bounds
      // 7); only a message.commit close effect does.
      context.db
        .prepare(
          'UPDATE deliveries SET acknowledged_at = COALESCE(acknowledged_at, ?), read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ?',
        )
        .run(now, now, now, delivery.id);
    });

    return { result: { message_id: messageId, endpoint_id: endpointId, delivery_state: 'acknowledged' } };
  },
};
