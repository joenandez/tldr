// Operation dispatch table: keyed by op name, each entry declares its
// required scope(s) and required permission. Trivially extensible: a later
// workstream adds a handler module and calls registerOp() without
// touching src/daemon/server.mjs.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { loadPermissions } from './handshake.mjs';

export function createOpTable() {
  return new Map();
}

/**
 * @param {Map} table
 * @param {object} def
 * @param {string} def.name - operation name, e.g. "daemon.status"
 * @param {boolean} [def.requiresAuth=true] - false only for protocol.handshake
 * @param {string[]} [def.allowedScopes] - subset of ['admin','agent']; required when requiresAuth is true
 * @param {string|null} [def.permission] - permission name required on an agent-scoped connection (admin connections skip this check, they hold no per-app permission rows)
 * @param {(context, payload, connection) => { result: object, capabilities?: string[] }} def.handler
 */
export function registerOp(table, def) {
  if (table.has(def.name)) {
    throw new Error(`operation already registered: ${def.name}`);
  }
  table.set(def.name, { requiresAuth: true, allowedScopes: ['admin', 'agent'], permission: null, ...def });
}

/**
 * Dispatches one validated request envelope against the op table.
 * Auth-sequencing order matches docs/protocol.md "Handshake":
 * 1. Any non-handshake op on an unauthenticated connection -> unauthenticated.
 * 2. Unknown op name -> malformed_request.
 * 3. Connection scope not permitted for this op -> permission_denied.
 * 4. Agent-scoped connection missing the required permission -> permission_denied.
 */
export function dispatch(table, { envelope, connection, context }) {
  if (envelope.op !== 'protocol.handshake' && !connection.authenticated) {
    throw new TightbeamError('unauthenticated', 'protocol.handshake must succeed before calling any other operation');
  }

  const def = table.get(envelope.op);
  if (!def) {
    throw new TightbeamError('malformed_request', `unknown operation: ${envelope.op}`, { field: 'op' });
  }

  if (def.requiresAuth !== false) {
    if (!def.allowedScopes.includes(connection.scope)) {
      throw new TightbeamError('permission_denied', `operation ${envelope.op} is not permitted for scope ${connection.scope}`);
    }
    if (connection.scope === 'agent') {
      // A re-registration replaces the application's secret hash. Bind each
      // authenticated connection to the hash accepted at handshake so an old
      // credential cannot retain authority through an already-open socket.
      if (connection.credentialHash !== null) {
        const application = context.db.prepare('SELECT secret_hash, status FROM applications WHERE id = ?').get(connection.appId);
        if (!application || application.status !== 'active' || application.secret_hash !== connection.credentialHash) {
          throw new TightbeamError('identity_unverified', 'app credential is no longer current');
        }
      }
      // F2: permissions cached at handshake could not be revoked from an
      // already-open connection. Re-read this app's application_permissions
      // rows on every request (one indexed SELECT by app_id) so a
      // permissions.set revocation is authoritative starting with the very
      // next request on every open connection, not just new ones
      // (docs/security-model.md). The handshake result payload still uses
      // its own load, unaffected by this.
      connection.permissions = loadPermissions(context.db, connection.appId);
      if (def.permission && !connection.permissions.has(def.permission)) {
        throw new TightbeamError('permission_denied', `missing required permission: ${def.permission}`);
      }
    }
  }

  const outcome = def.handler(context, envelope.payload, connection, envelope);
  return { result: outcome.result ?? {}, capabilities: outcome.capabilities };
}
