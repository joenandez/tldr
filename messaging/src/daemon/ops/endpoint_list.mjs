// endpoint.list — docs/protocol.md "Principal and endpoint lifecycle".
//
// A caller-scoped, read-only projection of the endpoints the authenticated
// application registered. The session hooks register one endpoint per
// agent session, so this is where the session facts live: the provider
// session id, the runtime, busy/idle state, launch mode, the workspace
// reference the session reported, and the proven Codex owner pid. A
// sibling component (Helm's scheduler) reads those facts through the CLI
// instead of keeping its own session hooks.
//
// It never creates or changes a row, never returns an endpoint another
// application created, and never returns an endpoint under an authority the
// caller's register_endpoints grant does not cover — the same ownership rule
// endpoint.retirement.get and principal.resolve apply. Closed endpoints are
// omitted unless asked for, because a closed session never returns.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { expandStoredRuntimeIds, runtimeContract } from './resume_shared.mjs';

const FIELDS = new Set(['provider_session_id', 'runtime', 'created_after', 'created_before', 'include_closed', 'limit']);
export const ENDPOINT_LIST_DEFAULT_LIMIT = 100;
export const ENDPOINT_LIST_MAX_LIMIT = 1000;

function malformed(field, message) {
  throw new TightbeamError('malformed_request', message, { field });
}

function optionalString(payload, field) {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) malformed(field, `${field} must be a non-empty string when present`);
  return value;
}

// Stored timestamps are Date#toISOString() strings, which order correctly
// as text. A bound is normalized to that exact shape so the comparison in
// SQL stays a plain string comparison.
function optionalTimestamp(payload, field) {
  const value = optionalString(payload, field);
  if (value === null) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) malformed(field, `${field} must be an ISO-8601 timestamp`);
  return new Date(ms).toISOString();
}

function parsePayload(payload) {
  if (payload === undefined || payload === null) payload = {};
  if (typeof payload !== 'object' || Array.isArray(payload)) malformed('payload', 'endpoint.list payload must be an object');
  const unknown = Object.keys(payload).find((key) => !FIELDS.has(key));
  if (unknown) malformed(unknown, `endpoint.list does not accept ${unknown}`);
  const includeClosed = payload.include_closed ?? false;
  if (typeof includeClosed !== 'boolean') malformed('include_closed', 'include_closed must be a boolean when present');
  const limit = payload.limit ?? ENDPOINT_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ENDPOINT_LIST_MAX_LIMIT) {
    malformed('limit', `limit must be an integer from 1 to ${ENDPOINT_LIST_MAX_LIMIT}`);
  }
  return {
    providerSessionId: optionalString(payload, 'provider_session_id'),
    runtime: optionalString(payload, 'runtime'),
    createdAfter: optionalTimestamp(payload, 'created_after'),
    createdBefore: optionalTimestamp(payload, 'created_before'),
    includeClosed,
    limit,
  };
}

function projection(row) {
  return {
    endpoint_id: row.id,
    principal_id: row.principal_id,
    authority_name: row.authority_name,
    runtime: row.runtime ?? null,
    provider_session_id: row.provider_session_id ?? null,
    state: row.state,
    launch_mode: row.launch_mode ?? null,
    authority_reference: row.authority_reference ?? null,
    owner_process_pid: row.owner_process_pid ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at ?? null,
  };
}

export const endpointListOp = {
  name: 'endpoint.list',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const filters = parsePayload(payload);
    const grant = connection.permissions.get('register_endpoints');
    const authorities = Array.isArray(grant?.allowed_authorities) ? grant.allowed_authorities : [];
    if (authorities.length === 0) return { result: { endpoints: [], truncated: false } };

    const where = ['created_by_app_id = ?', `authority_name IN (${authorities.map(() => '?').join(', ')})`];
    const params = [connection.appId, ...authorities];
    if (filters.providerSessionId !== null) {
      where.push('provider_session_id = ?');
      params.push(filters.providerSessionId);
    }
    if (filters.runtime !== null) {
      // 'claude' and 'claude-code' name one runtime; a filter on either
      // spelling must find rows stored under both.
      const spellings = expandStoredRuntimeIds([filters.runtime], runtimeContract(context).acceptedStoredIds);
      where.push(`runtime IN (${spellings.map(() => '?').join(', ')})`);
      params.push(...spellings);
    }
    if (filters.createdAfter !== null) {
      where.push('created_at >= ?');
      params.push(filters.createdAfter);
    }
    if (filters.createdBefore !== null) {
      where.push('created_at <= ?');
      params.push(filters.createdBefore);
    }
    if (!filters.includeClosed) where.push("state != 'closed'");

    // One extra row answers "was the result cut off" without a COUNT.
    const rows = context.db
      .prepare(
        `SELECT id, principal_id, authority_name, runtime, provider_session_id, state, launch_mode,
                authority_reference, owner_process_pid, created_at, updated_at, closed_at
           FROM endpoints
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...params, filters.limit + 1);
    const truncated = rows.length > filters.limit;
    return { result: { endpoints: rows.slice(0, filters.limit).map(projection), truncated } };
  },
};
