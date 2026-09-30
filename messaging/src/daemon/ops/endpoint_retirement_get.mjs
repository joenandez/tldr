import { TightbeamError } from '../../protocol/envelope.mjs';
import { endpointRetirementStatus } from '../endpoint_retirement.mjs';
import { authorityIsAllowed } from './authority_scope.mjs';

export const endpointRetirementGetOp = {
  name: 'endpoint.retirement.get',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => key !== 'endpoint_id')) {
      throw new TightbeamError('malformed_request', 'endpoint.retirement.get accepts only endpoint_id', { field: 'payload' });
    }
    if (typeof payload.endpoint_id !== 'string' || payload.endpoint_id.length === 0) {
      throw new TightbeamError('malformed_request', 'endpoint_id is required and must be a non-empty string', { field: 'endpoint_id' });
    }
    const endpoint = context.db.prepare('SELECT id, authority_name, created_by_app_id FROM endpoints WHERE id = ?').get(payload.endpoint_id);
    if (!endpoint) throw new TightbeamError('endpoint_unknown', `no endpoint registered with id "${payload.endpoint_id}"`);
    if (endpoint.created_by_app_id !== connection.appId || !authorityIsAllowed(connection, 'register_endpoints', endpoint.authority_name)) {
      throw new TightbeamError('permission_denied', 'endpoint retirement status is limited to the creating application');
    }
    return { result: endpointRetirementStatus(context.db, endpoint.id) };
  },
};
