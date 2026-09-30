// The tool-boundary notification surface intentionally returns no message
// content.  Exact message.receive is the only body/read/admission boundary.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { openOldestUnreadAdmission } from './delivery_admission.mjs';

function request(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TightbeamError('malformed_request', 'message.notification.next payload must be an object', { field: 'payload' });
  }
  for (const field of ['endpoint_id', 'provider_session_id']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      throw new TightbeamError('malformed_request', `${field} is required and must be a non-empty string`, { field });
    }
  }
  if (!Number.isSafeInteger(payload.process_generation) || payload.process_generation < 1) {
    throw new TightbeamError('malformed_request', 'process_generation is required and must be a positive integer', { field: 'process_generation' });
  }
  for (const field of Object.keys(payload)) {
    if (!['endpoint_id', 'process_generation', 'provider_session_id'].includes(field)) {
      throw new TightbeamError('malformed_request', `message.notification.next declares "${field}", which is not part of its request contract`, { field });
    }
  }
  return payload;
}

export const messageNotificationNextOp = {
  name: 'message.notification.next',
  allowedScopes: ['agent'],
  permission: 'read_inbox',
  handler(context, payload, connection) {
    const input = request(payload);
    const notification = withTransaction(context.db, () => {
      const endpoint = context.db
        .prepare(
          `SELECT id, process_generation, provider_session_id, owner_epoch, owner_launch_token
             FROM endpoints
            WHERE id = ? AND process_generation = ? AND provider_session_id = ?
              AND created_by_app_id = ? AND state IN ('idle', 'busy')`,
        )
        .get(input.endpoint_id, input.process_generation, input.provider_session_id, connection.appId);
      if (!endpoint) {
        throw new TightbeamError('permission_denied', 'message.notification.next is not granted for this exact endpoint owner');
      }
      const next = openOldestUnreadAdmission(context.db, { endpoint });
      return next ? { message_id: next.message_id, attempt: next.attempt, has_external_origin: next.has_external_origin } : null;
    });
    return { result: notification ?? {} };
  },
};
