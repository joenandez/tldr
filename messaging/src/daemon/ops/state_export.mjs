// state.export — docs/protocol.md "State movement", admin-only. Full or
// scoped ({ scope: { app_id } }) snapshot of Tightbeam's own state for
// migration/backup, with a hashed manifest (the product plan «Migration
// Plan»). Never includes secret_hash/app_secret/admin nonce material
// (docs/protocol.md "Diagnostics rule" — the one exception it carves out
// for state.export is scope, not the secret exclusion, which still
// applies). See src/daemon/migration_records.mjs's header comment for the
// table-selection and redaction decisions.

import { randomBytes } from 'node:crypto';

import { TightbeamError } from '../../protocol/envelope.mjs';
import { TABLE_ORDER, fetchExportRecords, computeContentHash, findExportAllowlistDrift } from '../migration_records.mjs';

/**
 * An export document that silently omits a table or a column is
 * indistinguishable from a complete one, and the export IS this product's
 * rollback path. So the allowlist is checked against the live schema before
 * anything is read: on drift the export refuses to emit at all, naming what
 * drifted, rather than hand back a backup that quietly dropped state.
 */
function requireAllowlistMatchesSchema(context) {
  const drift = findExportAllowlistDrift(context.db);
  if (drift.length === 0) return;
  context.logger?.error({
    event: 'state_export_allowlist_drift',
    params: { daemon_schema_version: context.schemaVersion },
    result: 'refused',
    status: 'error',
    drift,
  });
  throw new TightbeamError(
    'migration_incompatible',
    `state.export cannot produce a complete document: its table allowlist has drifted from this daemon's schema — ${drift.join('; ')}`,
  );
}

function validatePayload(payload) {
  const scope = payload && payload.scope;
  if (scope === undefined || scope === null) return null;
  if (typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TightbeamError('malformed_request', 'scope must be an object when present', { field: 'scope' });
  }
  if (scope.app_id !== undefined && (typeof scope.app_id !== 'string' || scope.app_id.length === 0)) {
    throw new TightbeamError('malformed_request', 'scope.app_id must be a non-empty string when present', { field: 'scope.app_id' });
  }
  return scope.app_id ?? null;
}

export const stateExportOp = {
  name: 'state.export',
  allowedScopes: ['admin'],
  permission: null,
  handler(context, payload) {
    const appId = validatePayload(payload);
    requireAllowlistMatchesSchema(context);

    const records = fetchExportRecords(context.db, { appId });

    const recordCounts = {};
    for (const table of TABLE_ORDER) recordCounts[table] = records[table].length;

    const contentHash = computeContentHash(records);

    return {
      result: {
        export_id: 'exp_' + randomBytes(16).toString('hex'),
        manifest: {
          source_product: 'tightbeam',
          source_revision: context.daemonVersion,
          schema_version: context.schemaVersion,
          record_counts: recordCounts,
          content_hash: contentHash,
          created_at: new Date().toISOString(),
        },
        records,
      },
    };
  },
};
