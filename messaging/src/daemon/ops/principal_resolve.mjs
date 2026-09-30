// principal.resolve — a deliberately narrow, caller-scoped identity read.
// It never creates identity and never exposes a principal or endpoint the
// current application could not use in a following canonical commit.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { authorityIsAllowed } from './authority_scope.mjs';

function malformed(field, message) {
  throw new TightbeamError('malformed_request', message, { field });
}

export const principalResolveOp = {
  name: 'principal.resolve',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const authorityName = payload?.authority_name;
    const externalRef = payload?.external_principal_ref;
    const requireEndpoint = payload?.require_endpoint ?? false;
    if (typeof authorityName !== 'string' || authorityName.length === 0) malformed('authority_name', 'authority_name is required and must be a string');
    if (typeof externalRef !== 'string' || externalRef.length === 0) malformed('external_principal_ref', 'external_principal_ref is required and must be a string');
    if (typeof requireEndpoint !== 'boolean') malformed('require_endpoint', 'require_endpoint must be a boolean when present');
    if (!authorityIsAllowed(connection, 'register_endpoints', authorityName)) {
      throw new TightbeamError('permission_denied', `register_endpoints is not granted for authority "${authorityName}"`);
    }
    if (!context.db.prepare('SELECT name FROM authorities WHERE name = ?').get(authorityName)) {
      malformed('authority_name', `authority "${authorityName}" is not registered`);
    }

    const principals = context.db
      .prepare(
        'SELECT id FROM principals WHERE authority_name = ? AND external_principal_ref = ? AND created_by_app_id = ? ORDER BY id ASC',
      )
      .all(authorityName, externalRef, connection.appId);
    if (principals.length === 0) {
      throw new TightbeamError('principal_not_found', 'no caller-owned principal matches that stable agent reference');
    }
    if (principals.length > 1) {
      throw new TightbeamError('principal_ambiguous', 'more than one caller-owned principal matches that stable agent reference');
    }
    const principal = principals[0];
    const endpoints = context.db
      .prepare("SELECT id FROM endpoints WHERE principal_id = ? AND created_by_app_id = ? AND state != 'closed' ORDER BY id ASC")
      .all(principal.id, connection.appId);
    if (requireEndpoint && endpoints.length === 0) {
      throw new TightbeamError('endpoint_not_found', 'the matched agent has no eligible endpoint for tracked work');
    }
    if (requireEndpoint && endpoints.length > 1) {
      throw new TightbeamError('endpoint_ambiguous', 'the matched agent has more than one eligible endpoint for tracked work');
    }
    const result = { principal_id: principal.id };
    if (requireEndpoint) result.endpoint_id = endpoints[0].id;
    return { result };
  },
};
