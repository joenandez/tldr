// inbox.subscribe — docs/protocol.md "Live notification and event
// frames" (Tightbeam-original protocol amendment; see the internal provenance record).
// Marks the CURRENT connection as a live-notification subscriber for the
// named principal's deliveries. Isolation matches inbox.list: only a
// principal owned by the caller's own application (created_by_app_id ===
// connection.appId) may be subscribed to.

import { TightbeamError } from '../../protocol/envelope.mjs';

export const inboxSubscribeOp = {
  name: 'inbox.subscribe',
  allowedScopes: ['agent'],
  permission: 'read_inbox',
  handler(context, payload, connection) {
    const principalId = payload && payload.principal_id;
    if (typeof principalId !== 'string' || principalId.length === 0) {
      throw new TightbeamError('malformed_request', 'principal_id is required and must be a string', { field: 'principal_id' });
    }

    const principal = context.db.prepare('SELECT id, created_by_app_id FROM principals WHERE id = ?').get(principalId);
    if (!principal || principal.created_by_app_id !== connection.appId) {
      throw new TightbeamError('permission_denied', 'read_inbox is not granted for this principal');
    }

    context.eventBus?.subscribe(principalId, connection);

    return { result: { subscribed: true, principal_id: principalId } };
  },
};
