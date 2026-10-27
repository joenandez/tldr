// Shared helper: does a connection's permission grant cover a given
// authority name? Used by every op scoped to `allowed_authorities`
// (docs/security-model.md Permission catalog #1 register_endpoints, #2
// send_as_principal). A missing grant or a null/absent allowed_authorities
// list means no authority is allowed — permission scope is always an
// explicit allow-list, never inferred (docs/security-model.md "Authority
// model": never trust client-declared scope).

import { TightbeamError } from '../../protocol/envelope.mjs';

export function authorityIsAllowed(connection, permissionName, authorityName) {
  const grant = connection.permissions.get(permissionName);
  if (!grant) return false;
  return Array.isArray(grant.allowed_authorities) && grant.allowed_authorities.includes(authorityName);
}

export function isUniqueConstraintError(err) {
  return Boolean(err) && err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message ?? '');
}

// Rule A participant role. A route-admitted principal joins a conversation only
// to author inbound messages: requireParticipant refuses it as any other kind of
// participant and the ordinary participant fan-out skips its endpoints, so the
// bridge never receives an agent message unless the sender selects its route.
export const ROUTE_ADMITTED_ROLE = 'route_admitted';

// The sender check for an inbound `none` commit. Rule A: a bridge's own route
// principal joins the conversation it injects into. Every such commit by a
// principal of one of the app's routes, already a participant or not, must name
// that app's ACTIVE route for that principal, so a retired route ends the ingress.
export function requireInboundAuthor(db, { appId, routeId, principalId, conversationId }) {
  if (db.prepare('SELECT 1 FROM channel_routes WHERE app_id = ? AND principal_id = ? LIMIT 1').get(appId, principalId)) {
    const route = db
      .prepare("SELECT id FROM channel_routes WHERE id = ? AND app_id = ? AND principal_id = ? AND state = 'active'")
      .get(typeof routeId === 'string' ? routeId : null, appId, principalId);
    if (!route) {
      throw new TightbeamError('permission_denied', "a channel route principal's inbound commit requires its active origin_channel_route_id", { field: 'origin_channel_route_id' });
    }
    db.prepare('INSERT INTO conversation_participants (conversation_id, principal_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(
      conversationId,
      principalId,
      ROUTE_ADMITTED_ROLE,
      new Date().toISOString(),
    );
  }
  if (!db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND principal_id = ?').get(conversationId, principalId)) {
    throw new TightbeamError('conversation_binding_conflict', `principal "${principalId}" is not a participant of conversation "${conversationId}"`);
  }
}
