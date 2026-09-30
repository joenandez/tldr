// channel.route.register / channel.route.list / channel.route.retire — durable
// descriptor records for application-owned channel endpoints. Routes deliberately store no
// provider configuration or health state: availability is derived from the
// application's existing active state and its endpoint's live state.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';
import { withTransaction } from '../db.mjs';
import { CHANNEL_ROUTE_CAPABILITIES, validateChannelRouteDescriptor } from '../channel_route_contract.mjs';
import { isUniqueConstraintError } from './authority_scope.mjs';

function malformed(field, message) {
  throw new TightbeamError('malformed_request', message, { field });
}

function validateDescriptor(payload) {
  const descriptor = validateChannelRouteDescriptor({
    selector: payload?.selector,
    label: payload?.label,
    capabilities: payload?.capabilities,
  });
  if (!descriptor.ok) malformed(descriptor.field, descriptor.message);
  return descriptor;
}

function routeAvailability(row) {
  return row.app_status === 'active' && (row.endpoint_state === 'idle' || row.endpoint_state === 'busy');
}

function resultRoute(row, { idempotentReplay } = {}) {
  const result = {
    route_id: row.id,
    selector: row.selector,
    label: row.label,
    capabilities: JSON.parse(row.capabilities),
    available: routeAvailability(row),
  };
  if (idempotentReplay !== undefined) result.idempotent_replay = idempotentReplay;
  return result;
}

const ROUTE_SELECT = `SELECT r.id, r.app_id, r.principal_id, r.endpoint_id, r.selector, r.label, r.capabilities, r.state,
                              a.status AS app_status, e.state AS endpoint_state
                         FROM channel_routes r
                         JOIN applications a ON a.id = r.app_id
                         JOIN endpoints e ON e.id = r.endpoint_id`;

// Read paths (list, conflict detection) only ever see live claims: a
// retired route's selector/endpoint claim is free, exactly like the
// active-only partial unique indexes schema 14 added.
const ACTIVE_ROUTE_SELECT = `${ROUTE_SELECT} WHERE r.state = 'active'`;

function ownedRouteInputs(context, connection, principalId, endpointId) {
  const principal = context.db.prepare('SELECT id FROM principals WHERE id = ? AND created_by_app_id = ?').get(principalId, connection.appId);
  if (!principal) malformed('principal_id', `no principal registered with id "${principalId}"`);

  const endpoint = context.db
    .prepare('SELECT id, principal_id FROM endpoints WHERE id = ? AND created_by_app_id = ?')
    .get(endpointId, connection.appId);
  if (!endpoint) malformed('endpoint_id', `no endpoint registered with id "${endpointId}"`);
  if (endpoint.principal_id !== principalId) {
    malformed('endpoint_id', 'endpoint_id does not belong to principal_id');
  }
}

function existingRouteConflict(context, connection, claim) {
  const existing = context.db
    .prepare(`${ACTIVE_ROUTE_SELECT} AND (r.selector = ? OR r.endpoint_id = ?) ORDER BY r.selector ASC LIMIT 1`)
    .get(claim.selector, claim.endpointId);
  if (
    existing
    && existing.app_id === connection.appId
    && existing.principal_id === claim.principalId
    && existing.endpoint_id === claim.endpointId
    && existing.selector === claim.selector
    && existing.label === claim.label
    && existing.capabilities === claim.capabilities
  ) {
    return existing;
  }
  throw new TightbeamError('identity_conflict', 'channel route is already registered under a different claim', { field: 'selector' });
}

export const channelRouteRegisterOp = {
  name: 'channel.route.register',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const descriptor = validateDescriptor(payload);
    const selector = payload.selector;
    const label = payload.label;
    const principalId = payload?.principal_id;
    const endpointId = payload?.endpoint_id;
    if (typeof principalId !== 'string' || principalId.length === 0) malformed('principal_id', 'principal_id is required and must be a string');
    if (typeof endpointId !== 'string' || endpointId.length === 0) malformed('endpoint_id', 'endpoint_id is required and must be a string');
    const capabilities = descriptor.capabilities;
    ownedRouteInputs(context, connection, principalId, endpointId);

    const claim = { selector, label, principalId, endpointId, capabilities: JSON.stringify(capabilities) };
    const routeId = generateId('channel_route');
    const now = new Date().toISOString();
    try {
      withTransaction(context.db, () => {
        context.db
          .prepare(
            `INSERT INTO channel_routes
              (id, app_id, principal_id, endpoint_id, selector, label, capabilities, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(routeId, connection.appId, principalId, endpointId, selector, label, claim.capabilities, now, now);
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      return { result: resultRoute(existingRouteConflict(context, connection, claim), { idempotentReplay: true }) };
    }

    const created = context.db.prepare(`${ROUTE_SELECT} WHERE r.id = ?`).get(routeId);
    return { result: resultRoute(created, { idempotentReplay: false }) };
  },
};

export const channelRouteListOp = {
  name: 'channel.route.list',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload = {}) {
    const availableOnly = payload.available_only ?? false;
    if (typeof availableOnly !== 'boolean') malformed('available_only', 'available_only must be a boolean when present');
    const requiredCapability = payload.required_capability ?? null;
    if (requiredCapability !== null && (typeof requiredCapability !== 'string' || !CHANNEL_ROUTE_CAPABILITIES.includes(requiredCapability))) {
      malformed('required_capability', 'required_capability must be send or reply when present');
    }

    const routes = context.db.prepare(`${ACTIVE_ROUTE_SELECT} ORDER BY r.selector ASC`).all().map((row) => resultRoute(row));
    return {
      result: {
        routes: routes.filter((route) => (!availableOnly || route.available) && (!requiredCapability || route.capabilities.includes(requiredCapability))),
      },
    };
  },
};

export const channelRouteRetireOp = {
  name: 'channel.route.retire',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const routeId = payload && payload.route_id;
    if (typeof routeId !== 'string' || routeId.length === 0) {
      malformed('route_id', 'route_id is required and must be a string');
    }

    // Existence-hiding, matching message.delivery.list's convention: an
    // unknown route and a foreign-owned route both answer permission_denied,
    // never not_found, so a caller cannot use this op to probe which route
    // ids exist.
    const route = context.db.prepare('SELECT id, app_id, state, retired_at FROM channel_routes WHERE id = ?').get(routeId);
    if (!route || route.app_id !== connection.appId) {
      throw new TightbeamError('permission_denied', 'register_endpoints is not granted for this route');
    }

    if (route.state === 'retired') {
      return { result: { route_id: routeId, state: 'retired', retired_at: route.retired_at } };
    }

    const retiredAt = new Date().toISOString();
    withTransaction(context.db, () => {
      context.db
        .prepare("UPDATE channel_routes SET state = 'retired', retired_at = ?, updated_at = ? WHERE id = ?")
        .run(retiredAt, retiredAt, routeId);
      // Historical replies stay readable through their event ledger, but a
      // retired transport descriptor must not retain authority for a fresh
      // external event. channel.reply.publish checks its replay ledger
      // first, so this does not disturb an already committed retry.
      context.db
        .prepare(
          `UPDATE reply_bindings
              SET state = 'retired', retired_at = ?, retired_reason = 'channel_route_retired'
            WHERE channel_route_id = ? AND state = 'active'`,
        )
        .run(retiredAt, routeId);
    });

    return { result: { route_id: routeId, state: 'retired', retired_at: retiredAt } };
  },
};
