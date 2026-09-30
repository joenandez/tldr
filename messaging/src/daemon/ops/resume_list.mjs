// resume.list — docs/protocol.md "Resume requests". Scoping: the
// `resume_requests` table (the state ownership contract §9) has no
// `runtime_type` column of its own, so a request's "runtime_type" is its
// endpoint's `runtime` — the resume axis schema 2 added, joined on
// `endpoint_id`. It used to be the endpoint's `authority_name`, which
// conflated the resume axis with the trust axis and could not express
// "Academy, over Claude Code" (ws-5, plan phase 4 «Changed contracts»;
// the payload/result field keeps the name `runtime_type` for wire
// compatibility). A missing/null allowed_runtime_types grant means no
// runtime type is allowed (fail-closed, mirroring authority_scope.mjs
// "a missing grant or a null/absent list means no authority is
// allowed"), and a grant value naming no registered runtime is a loud
// permission_denied rather than a silently empty list.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { reapExpired } from './claims_shared.mjs';
import { assertGrantRuntimesRegistered, expandStoredRuntimeIds, runtimeContract, runtimeIdEquals } from './resume_shared.mjs';

export const resumeListOp = {
  name: 'resume.list',
  allowedScopes: ['agent'],
  permission: 'claim_resume_requests',
  handler(context, payload, connection) {
    // F6: proactively return any resume request whose claim lease expired
    // without anyone reclaiming it yet, so a state:'pending' poll sees it
    // immediately rather than waiting for a fresh claim attempt to reap it.
    withTransaction(context.db, () => reapExpired(context.db, 'resume_request', new Date()));

    const runtimeType = payload && payload.runtime_type;
    const state = payload && payload.state;
    if (runtimeType !== undefined && runtimeType !== null && typeof runtimeType !== 'string') {
      throw new TightbeamError('malformed_request', 'runtime_type must be a string when present', { field: 'runtime_type' });
    }
    if (state !== undefined && state !== null && typeof state !== 'string') {
      throw new TightbeamError('malformed_request', 'state must be a string when present', { field: 'state' });
    }

    const grant = connection.permissions.get('claim_resume_requests');
    const allowedRuntimeTypes = grant && Array.isArray(grant.allowed_runtime_types) ? grant.allowed_runtime_types : [];
    // Registry-injected canonicalization (plan W1 «Canonical ids and
    // legacy equivalence»): stored legacy spellings match canonical
    // grants and filters; unknown types keep exact matching.
    const { canonicalize, acceptedStoredIds } = runtimeContract(context);
    assertGrantRuntimesRegistered(context.db, allowedRuntimeTypes, { registry: context.runtimeRegistry });
    const types = runtimeType ? (allowedRuntimeTypes.some((value) => runtimeIdEquals(value, runtimeType, canonicalize)) ? [runtimeType] : []) : allowedRuntimeTypes;

    if (types.length === 0) {
      return { result: { resume_requests: [] } };
    }

    const queryTypes = expandStoredRuntimeIds(types, acceptedStoredIds);
    const placeholders = queryTypes.map(() => '?').join(',');
    const rows = context.db
      .prepare(
        `SELECT r.id AS id, r.endpoint_id AS endpoint_id, r.principal_id AS principal_id, r.session_id AS session_id,
                r.conversation_id AS conversation_id, r.message_id AS message_id, r.reason AS reason, r.state AS state,
                e.runtime AS runtime_type
           FROM resume_requests r
           JOIN endpoints e ON e.id = r.endpoint_id
          WHERE e.runtime IN (${placeholders})
            AND (? IS NULL OR r.state = ?)
          ORDER BY r.created_at ASC`,
      )
      .all(...queryTypes, state ?? null, state ?? null);

    return {
      result: {
        resume_requests: rows.map((row) => ({
          resume_request_id: row.id,
          endpoint_id: row.endpoint_id,
          principal_id: row.principal_id,
          session_id: row.session_id,
          conversation_id: row.conversation_id,
          message_id: row.message_id,
          reason: row.reason,
          runtime_type: row.runtime_type,
          state: row.state,
        })),
      },
    };
  },
};
