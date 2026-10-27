// protocol.handshake — docs/protocol.md "Handshake", the architecture contract §4.
// Must be the first frame on every connection. Verifies an app credential
// (scrypt-hashed secret) or an admin credential (single-use filesystem
// nonce) and binds the connection's scope/app_id for its lifetime.

import { TightbeamError, BASELINE_CAPABILITIES } from '../../protocol/envelope.mjs';
import { verifySecret, verifyAndConsumeAdminNonce } from '../auth.mjs';
import { pendingReplyGuard } from '../agent_wait_context.mjs';

// F2: exported so registry.mjs's dispatch() can re-read this connection's
// application_permissions rows on every request, not just at handshake —
// a revoked permission must take effect on the connection's very next
// request, not only on its next reconnect (docs/security-model.md).
export function loadPermissions(db, appId) {
  const rows = db
    .prepare('SELECT permission, allowed_authorities, allowed_runtime_types FROM application_permissions WHERE app_id = ?')
    .all(appId);
  const permissions = new Map();
  for (const row of rows) {
    permissions.set(row.permission, {
      allowed_authorities: row.allowed_authorities ? JSON.parse(row.allowed_authorities) : null,
      allowed_runtime_types: row.allowed_runtime_types ? JSON.parse(row.allowed_runtime_types) : null,
    });
  }
  return permissions;
}

function permissionsToResult(permissions) {
  return [...permissions.entries()].map(([permission, grant]) => ({
    permission,
    allowed_authorities: grant.allowed_authorities,
    allowed_runtime_types: grant.allowed_runtime_types,
  }));
}

function agentWaitContext(payload) {
  if (!Object.hasOwn(payload, 'agent_wait_context')) return null;
  const value = payload.agent_wait_context;
  const fields = ['endpoint_id', 'provider_session_id', 'process_generation', 'wait_action_id'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TightbeamError('malformed_request', 'agent_wait_context must be a plain object', { field: 'agent_wait_context' });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TightbeamError('malformed_request', 'agent_wait_context must be a plain object', { field: 'agent_wait_context' });
  }
  if (Object.keys(value).sort().join() !== [...fields].sort().join()) {
    throw new TightbeamError('malformed_request', 'agent_wait_context must contain exactly endpoint_id, provider_session_id, process_generation, and wait_action_id', { field: 'agent_wait_context' });
  }
  if (typeof value.endpoint_id !== 'string' || value.endpoint_id.length === 0) {
    throw new TightbeamError('malformed_request', 'agent_wait_context.endpoint_id must be a non-empty string', { field: 'agent_wait_context.endpoint_id' });
  }
  if (typeof value.provider_session_id !== 'string' || value.provider_session_id.length === 0) {
    throw new TightbeamError('malformed_request', 'agent_wait_context.provider_session_id must be a non-empty string', { field: 'agent_wait_context.provider_session_id' });
  }
  if (!Number.isSafeInteger(value.process_generation) || value.process_generation < 1) {
    throw new TightbeamError('malformed_request', 'agent_wait_context.process_generation must be a positive integer', { field: 'agent_wait_context.process_generation' });
  }
  if (typeof value.wait_action_id !== 'string' || value.wait_action_id.length === 0 || value.wait_action_id.length > 512) {
    throw new TightbeamError('malformed_request', 'agent_wait_context.wait_action_id must be a non-empty string of at most 512 characters', { field: 'agent_wait_context.wait_action_id' });
  }
  return value;
}

function handleAppCredential(context, payload, connection, envelope) {
  const { app_id: appId } = envelope;
  const secret = payload.credential.app_secret;

  if (typeof appId !== 'string' || appId.length === 0) {
    throw new TightbeamError('malformed_request', 'app_id is required for an app credential handshake', { field: 'app_id' });
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TightbeamError('malformed_request', 'credential.app_secret is required', { field: 'credential.app_secret' });
  }

  const row = context.db.prepare('SELECT id, secret_hash, status FROM applications WHERE id = ?').get(appId);
  // Unknown app_id and a bad secret return the same error so a caller
  // cannot use handshake to probe which app_ids exist.
  if (!row || row.status !== 'active' || !verifySecret(secret, row.secret_hash)) {
    throw new TightbeamError('identity_unverified', 'app credential could not be verified');
  }

  const waitContext = agentWaitContext(payload);
  const guard = waitContext
    ? pendingReplyGuard(context.db, {
        appId,
        endpointId: waitContext.endpoint_id,
        providerSessionId: waitContext.provider_session_id,
        processGeneration: waitContext.process_generation,
        actionId: waitContext.wait_action_id,
      })
    : null;
  const permissions = loadPermissions(context.db, appId);
  connection.authenticated = true;
  connection.scope = 'agent';
  connection.appId = appId;
  connection.credentialHash = row.secret_hash;
  connection.permissions = permissions;

  return {
    result: {
      scope: 'agent',
      app_id: appId,
      permissions: permissionsToResult(permissions),
      protocol_version: context.protocolVersion,
      state_schema_version: context.schemaVersion,
      ...(waitContext ? { pending_reply_guard: guard } : {}),
    },
    capabilities: BASELINE_CAPABILITIES,
  };
}

function handleAdminCredential(context, payload, connection, envelope) {
  if (Object.hasOwn(payload, 'agent_wait_context')) {
    throw new TightbeamError('permission_denied', 'agent_wait_context requires an app credential');
  }
  const nonce = payload.credential.nonce;

  if (envelope.app_id !== null) {
    throw new TightbeamError('malformed_request', 'app_id must be null for an admin credential handshake', { field: 'app_id' });
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new TightbeamError('malformed_request', 'credential.nonce is required', { field: 'credential.nonce' });
  }

  if (!verifyAndConsumeAdminNonce(context.adminNoncePath, nonce)) {
    throw new TightbeamError('identity_unverified', 'admin nonce could not be verified');
  }

  connection.authenticated = true;
  connection.scope = 'admin';
  connection.appId = null;
  connection.permissions = new Map();

  return {
    result: {
      scope: 'admin',
      app_id: null,
      protocol_version: context.protocolVersion,
      state_schema_version: context.schemaVersion,
    },
    capabilities: BASELINE_CAPABILITIES,
  };
}

export const handshakeOp = {
  name: 'protocol.handshake',
  requiresAuth: false,
  handler(context, payload, connection, envelope) {
    if (connection.authenticated) {
      throw new TightbeamError('malformed_request', 'this connection has already completed protocol.handshake');
    }

    const credential = payload && payload.credential;
    if (typeof credential !== 'object' || credential === null) {
      throw new TightbeamError('malformed_request', 'credential is required', { field: 'credential' });
    }

    if (credential.kind === 'app') return handleAppCredential(context, payload, connection, envelope);
    if (credential.kind === 'admin') return handleAdminCredential(context, payload, connection, envelope);

    throw new TightbeamError('malformed_request', 'credential.kind must be "app" or "admin"', { field: 'credential.kind' });
  },
};
