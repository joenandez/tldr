// principal.register — docs/protocol.md "Principal and endpoint
// lifecycle". Identity may be created only by an application holding
// register_endpoints scoped to a registered authority
// (docs/security-model.md "Authority model": "Tightbeam never infers
// identity... every principal and endpoint fact must arrive as an
// explicit, authenticated call from an application holding the scoped
// register_endpoints grant"). Conflicting verified facts fail closed with
// identity_conflict rather than silently overwriting a prior binding —
// adapted from tldr;'s thread_ownership.mjs fail-closed pattern
// (the behavior inventory §4), mediated through the structural
// unique(authority_name, external_principal_ref) index
// (the state ownership contract §2).
//
// An *identical* repeat by the application that created the row is not a
// conflict: it replays and returns the existing principal_id with
// idempotent_replay: true. The relaxation is keyed on the unique index and
// nothing else — every identity field below, created_by_app_id included,
// must still match, so "last writer wins" never applies and a second
// application sharing the authority scope cannot obtain the first's
// principal_id by restating facts the channel already gave it. Because the
// index is partial on external_principal_ref IS NOT NULL, a registration
// without that ref creates a new row every time and never replays.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';
import { withTransaction } from '../db.mjs';
import { authorityIsAllowed, isUniqueConstraintError } from './authority_scope.mjs';

export const principalRegisterOp = {
  name: 'principal.register',
  allowedScopes: ['agent'],
  permission: 'register_endpoints',
  handler(context, payload, connection) {
    const authorityName = payload && payload.authority_name;
    if (typeof authorityName !== 'string' || authorityName.length === 0) {
      throw new TightbeamError('malformed_request', 'authority_name is required and must be a string', { field: 'authority_name' });
    }
    for (const field of ['external_principal_ref', 'display_name']) {
      const value = payload[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new TightbeamError('malformed_request', `${field} must be a string when present`, { field });
      }
    }

    if (!authorityIsAllowed(connection, 'register_endpoints', authorityName)) {
      throw new TightbeamError('permission_denied', `register_endpoints is not granted for authority "${authorityName}"`);
    }

    const authority = context.db.prepare('SELECT name FROM authorities WHERE name = ?').get(authorityName);
    if (!authority) {
      throw new TightbeamError('malformed_request', `authority "${authorityName}" is not registered`, { field: 'authority_name' });
    }

    const externalRef = payload.external_principal_ref ?? null;
    const displayName = payload.display_name ?? null;
    const principalId = generateId('principal');
    const createdAt = new Date().toISOString();

    try {
      withTransaction(context.db, () => {
        context.db
          .prepare(
            'INSERT INTO principals (id, authority_name, external_principal_ref, display_name, created_by_app_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(principalId, authorityName, externalRef, displayName, connection.appId, createdAt);
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // The insert lost the race (or repeated an earlier one). Read the
      // row the index pointed at and compare the rest of the claim — an
      // identical claim replays, anything else fails closed.
      const existing = context.db
        .prepare('SELECT id, display_name, created_by_app_id FROM principals WHERE authority_name = ? AND external_principal_ref = ?')
        .get(authorityName, externalRef);
      // created_by_app_id is part of the claim: two applications sharing
      // an authority scope hold the same channel-side facts, so an
      // identical payload from the app that did not create the row is a
      // competing claim, not a replay — answering it would hand out a
      // principal_id the caller may then attach its own endpoints to.
      if (!existing || existing.display_name !== displayName || existing.created_by_app_id !== connection.appId) {
        throw new TightbeamError(
          'identity_conflict',
          `principal (${authorityName}, ${externalRef}) is already registered under a different claim`,
          { field: 'external_principal_ref' },
        );
      }
      return { result: { principal_id: existing.id, idempotent_replay: true } };
    }

    return { result: { principal_id: principalId, idempotent_replay: false } };
  },
};
