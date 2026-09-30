// application.permissions.set — docs/protocol.md "Administrative
// registration", admin-only. Full replace of one application's permission
// grant set (the state ownership contract §1: unique(app_id, permission), one
// grant row per permission name; the row's allowed_authorities /
// allowed_runtime_types arrays are that permission's entire allow-list).

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';

// Verbatim from docs/security-model.md "Permission catalog".
const KNOWN_PERMISSIONS = new Set([
  'register_endpoints',
  'send_as_principal',
  'read_inbox',
  'acknowledge_delivery',
  'manage_obligations',
  'consume_outbound_requests',
  'publish_inbound_messages',
  'claim_resume_requests',
  'read_health',
]);

function validateGrant(grant, index) {
  if (typeof grant !== 'object' || grant === null || Array.isArray(grant)) {
    throw new TightbeamError('malformed_request', `permissions[${index}] must be an object`, { field: 'permissions' });
  }
  if (typeof grant.permission !== 'string' || !KNOWN_PERMISSIONS.has(grant.permission)) {
    throw new TightbeamError('malformed_request', `permissions[${index}].permission is not a recognized permission name`, {
      field: 'permissions',
    });
  }
  for (const field of ['allowed_authorities', 'allowed_runtime_types']) {
    const value = grant[field];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
      throw new TightbeamError('malformed_request', `permissions[${index}].${field} must be an array of strings when present`, {
        field,
      });
    }
  }
  return {
    permission: grant.permission,
    allowed_authorities: grant.allowed_authorities ?? null,
    allowed_runtime_types: grant.allowed_runtime_types ?? null,
  };
}

export const applicationPermissionsSetOp = {
  name: 'application.permissions.set',
  allowedScopes: ['admin'],
  permission: null,
  handler(context, payload) {
    const appId = payload && payload.app_id;
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new TightbeamError('malformed_request', 'app_id is required and must be a string', { field: 'app_id' });
    }
    if (!Array.isArray(payload.permissions)) {
      throw new TightbeamError('malformed_request', 'permissions is required and must be an array', { field: 'permissions' });
    }

    const app = context.db.prepare('SELECT id FROM applications WHERE id = ?').get(appId);
    if (!app) {
      throw new TightbeamError('malformed_request', `no application registered with id "${appId}"`, { field: 'app_id' });
    }

    const grants = payload.permissions.map(validateGrant);
    // Reject two grant rows for the same permission name up front: the
    // full-replace insert below would otherwise hit the unique(app_id,
    // permission) index mid-transaction for an error the caller could
    // have avoided by not repeating a permission name in one call.
    const seen = new Set();
    for (const grant of grants) {
      if (seen.has(grant.permission)) {
        throw new TightbeamError('malformed_request', `duplicate permission "${grant.permission}" in one permissions.set call`, {
          field: 'permissions',
        });
      }
      seen.add(grant.permission);
    }

    const createdAt = new Date().toISOString();
    withTransaction(context.db, () => {
      context.db.prepare('DELETE FROM application_permissions WHERE app_id = ?').run(appId);
      const insert = context.db.prepare(
        'INSERT INTO application_permissions (app_id, permission, allowed_authorities, allowed_runtime_types, created_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const grant of grants) {
        insert.run(
          appId,
          grant.permission,
          grant.allowed_authorities ? JSON.stringify(grant.allowed_authorities) : null,
          grant.allowed_runtime_types ? JSON.stringify(grant.allowed_runtime_types) : null,
          createdAt,
        );
      }
    });

    return { result: { app_id: appId, permissions: grants } };
  },
};
