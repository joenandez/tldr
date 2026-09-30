// resume.claim — docs/protocol.md "Resume requests". "runtime_type" is
// the resume request's endpoint's `runtime` (ws-5, plan phase 4: the
// resume axis, not the authority_name trust axis it used to infer); see
// resume_list.mjs's header comment. A resume request
// that exists but does not match the caller's allowed_runtime_types (or
// the payload's own runtime_type filter), or one already in a terminal
// state, returns resume_handler_unavailable — never permission_denied —
// per docs/protocol.md's documented error list for this operation.
// Lease acquisition reuses claims_shared.mjs (resource_type =
// 'resume_request'), the same reap-then-insert primitive delivery.claim
// uses.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { acquireClaim, resolveLeaseMs } from './claims_shared.mjs';
import { assertGrantRuntimesRegistered, expandStoredRuntimeIds, runtimeContract, runtimeIdEquals } from './resume_shared.mjs';

const TERMINAL_STATES = new Set(['completed', 'failed']);

const RESUME_REQUEST_FIELDS = `r.id AS id, r.endpoint_id AS endpoint_id, r.principal_id AS principal_id, r.session_id AS session_id,
       r.conversation_id AS conversation_id, r.message_id AS message_id, r.reason AS reason,
       r.authority_reference AS authority_reference, r.state AS state, e.runtime AS runtime_type`;

export const resumeClaimOp = {
  name: 'resume.claim',
  allowedScopes: ['agent'],
  permission: 'claim_resume_requests',
  handler(context, payload, connection) {
    const resumeRequestId = payload && payload.resume_request_id;
    const runtimeType = payload && payload.runtime_type;
    if (resumeRequestId !== undefined && resumeRequestId !== null && (typeof resumeRequestId !== 'string' || resumeRequestId.length === 0)) {
      throw new TightbeamError('malformed_request', 'resume_request_id must be a string when present', { field: 'resume_request_id' });
    }
    if (runtimeType !== undefined && runtimeType !== null && typeof runtimeType !== 'string') {
      throw new TightbeamError('malformed_request', 'runtime_type must be a string when present', { field: 'runtime_type' });
    }
    const leaseMs = resolveLeaseMs(payload.lease_ms);

    const grant = connection.permissions.get('claim_resume_requests');
    const allowedRuntimeTypes = grant && Array.isArray(grant.allowed_runtime_types) ? grant.allowed_runtime_types : [];
    // The canonicalization contract comes from the registry snapshot on
    // the context (plan W1 «Canonical ids and legacy equivalence»): a
    // stored 'claude' row matches a ['claude-code'] grant and vice versa,
    // while unknown endpoint-registered types keep exact-string matching.
    const { canonicalize, acceptedStoredIds } = runtimeContract(context);
    // A grant value naming no registered runtime is a misconfiguration,
    // not an empty queue: fail loudly and name it rather than answering
    // resume_handler_unavailable (plan phase 4 «Changed contracts»).
    assertGrantRuntimesRegistered(context.db, allowedRuntimeTypes, { registry: context.runtimeRegistry });
    const now = new Date();

    const outcome = withTransaction(context.db, () => {
      let row;
      if (resumeRequestId) {
        row = context.db
          .prepare(`SELECT ${RESUME_REQUEST_FIELDS} FROM resume_requests r JOIN endpoints e ON e.id = r.endpoint_id WHERE r.id = ?`)
          .get(resumeRequestId);
        if (!row) {
          throw new TightbeamError('malformed_request', `no resume request registered with id "${resumeRequestId}"`, {
            field: 'resume_request_id',
          });
        }
        const typeAllowed =
          allowedRuntimeTypes.some((value) => runtimeIdEquals(value, row.runtime_type, canonicalize)) &&
          (!runtimeType || runtimeIdEquals(runtimeType, row.runtime_type, canonicalize));
        if (!typeAllowed || TERMINAL_STATES.has(row.state)) {
          throw new TightbeamError('resume_handler_unavailable', 'no pending resume request matches the caller\'s allowed runtime types');
        }
      } else {
        const types = runtimeType ? (allowedRuntimeTypes.some((value) => runtimeIdEquals(value, runtimeType, canonicalize)) ? [runtimeType] : []) : allowedRuntimeTypes;
        if (types.length === 0) {
          throw new TightbeamError('resume_handler_unavailable', 'no pending resume request matches the caller\'s allowed runtime types');
        }
        // Excludes resume requests with an actively-held (unexpired) claim
        // from the candidate set, so auto-select finds the oldest FREE-or-
        // expired request rather than the globally oldest row — see the
        // matching comment in delivery_claim.mjs's auto-select query.
        //
        // The IN list carries every stored spelling of each granted type:
        // legacy alias rows stay claimable without rewriting their cells.
        const queryTypes = expandStoredRuntimeIds(types, acceptedStoredIds);
        const placeholders = queryTypes.map(() => '?').join(',');
        row = context.db
          .prepare(
            `SELECT ${RESUME_REQUEST_FIELDS}
               FROM resume_requests r
               JOIN endpoints e ON e.id = r.endpoint_id
               LEFT JOIN claims c ON c.resource_type = 'resume_request' AND c.resource_id = r.id AND c.state = 'claimed' AND c.lease_expires_at > ?
              WHERE e.runtime IN (${placeholders})
                AND r.state IN ('pending', 'claimed')
                AND c.id IS NULL
              ORDER BY r.created_at ASC, r.id ASC
              LIMIT 1`,
          )
          .get(now.toISOString(), ...queryTypes);
        if (!row) {
          throw new TightbeamError('resume_handler_unavailable', 'no pending resume request matches the caller\'s allowed runtime types');
        }
      }

      const claim = acquireClaim(context.db, { resourceType: 'resume_request', resourceId: row.id, leaseMs, now });
      context.db.prepare("UPDATE resume_requests SET state = 'claimed', updated_at = ? WHERE id = ?").run(now.toISOString(), row.id);

      return {
        resume_request_id: row.id,
        endpoint_id: row.endpoint_id,
        principal_id: row.principal_id,
        session_id: row.session_id,
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        reason: row.reason,
        authority_reference: row.authority_reference,
        runtime_type: row.runtime_type,
        state: 'claimed',
        token: claim.token,
        lease_expires_at: claim.leaseExpiresAt,
      };
    });

    return { result: outcome };
  },
};
