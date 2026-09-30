// endpoint.close — docs/protocol.md "Principal and endpoint lifecycle".
// Terminal: closing an already-closed endpoint is idempotent (only
// permission_denied / endpoint_unknown are listed as errors for this op —
// no identity_conflict — so a repeat close is a no-op success, not an
// error, unlike endpoint.state.set reasserting a busy/idle/dead state on
// a closed endpoint). This is also the only way to reach `closed`:
// endpoint.state.set rejects it, so the terminal fact and its closed_at
// bookkeeping are always written together.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { authorityIsAllowed } from './authority_scope.mjs';
import { withTransaction } from '../db.mjs';

export const endpointCloseOp = {
  name: 'endpoint.close',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const endpointId = payload && payload.endpoint_id;
    const processGeneration = payload && payload.process_generation;
    if (typeof endpointId !== 'string' || endpointId.length === 0) {
      throw new TightbeamError('malformed_request', 'endpoint_id is required and must be a string', { field: 'endpoint_id' });
    }
    if (!Number.isInteger(processGeneration) || processGeneration < 1) {
      throw new TightbeamError('malformed_request', 'process_generation is required and must be a positive integer', { field: 'process_generation' });
    }

    const endpoint = context.db.prepare('SELECT id, authority_name, state, closed_at, created_by_app_id, process_generation FROM endpoints WHERE id = ?').get(endpointId);
    if (!endpoint) {
      throw new TightbeamError('endpoint_unknown', `no endpoint registered with id "${endpointId}"`);
    }

    if (!authorityIsAllowed(connection, 'register_endpoints', endpoint.authority_name)) {
      throw new TightbeamError('permission_denied', `register_endpoints is not granted for authority "${endpoint.authority_name}"`);
    }
    // F3: two applications sharing the same authority scope must not be
    // able to modify each other's endpoints — authority scope alone is
    // not ownership.
    if (endpoint.created_by_app_id !== connection.appId) {
      throw new TightbeamError('permission_denied', `register_endpoints is not granted for authority "${endpoint.authority_name}"`);
    }
    if (endpoint.process_generation !== processGeneration) {
      throw new TightbeamError('obligation_conflict', 'process_generation does not name the endpoint\'s active process', { field: 'process_generation', reason: 'process_generation_stale' });
    }
    if (endpoint.state === 'takeover_pending') {
      throw new TightbeamError('identity_conflict', 'endpoint is takeover_pending; predecessor mutations are fenced', { field: 'endpoint_id' });
    }

    if (endpoint.state === 'closed') {
      return { result: { endpoint_id: endpointId, state: 'closed', closed_at: endpoint.closed_at } };
    }

    const closedAt = new Date().toISOString();
    withTransaction(context.db, () => {
      context.db.prepare("UPDATE endpoints SET state = 'closed', updated_at = ?, closed_at = ? WHERE id = ?").run(closedAt, closedAt, endpointId);
      // A reply target is a concrete endpoint, not only a principal. Its
      // closure ends fresh reply authority immediately while preserving the
      // immutable event ledger for exact retries.
      context.db
        .prepare(
          `UPDATE reply_bindings
              SET state = 'retired', retired_at = ?, retired_reason = 'target_endpoint_closed'
            WHERE target_endpoint_id = ? AND state = 'active'`,
        )
        .run(closedAt, endpointId);
      // Cascade: a closed endpoint can never again satisfy an active
      // channel_routes row bound to it, so retire every such row now
      // rather than leaving its selector/endpoint claim permanently stuck
      // (AC 3.1.2 — a selector must become re-registrable once its only
      // route's endpoint closes).
      context.db
        .prepare("UPDATE channel_routes SET state = 'retired', retired_at = ?, updated_at = ? WHERE endpoint_id = ? AND state = 'active'")
        .run(closedAt, closedAt, endpointId);
      context.db
        .prepare(
          `UPDATE reply_bindings
              SET state = 'retired', retired_at = ?, retired_reason = 'channel_route_retired'
            WHERE channel_route_id IN (SELECT id FROM channel_routes WHERE endpoint_id = ?) AND state = 'active'`,
        )
        .run(closedAt, endpointId);
    });

    return { result: { endpoint_id: endpointId, state: 'closed', closed_at: closedAt } };
  },
};
