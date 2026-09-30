// authority.register — docs/protocol.md "Administrative registration",
// admin-only (docs/security-model.md "Administrative operations"). Creates
// the named trust domain that principal.register / endpoint.register are
// later scoped against (docs/security-model.md "Authority model").

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { isUniqueConstraintError } from './authority_scope.mjs';

export const authorityRegisterOp = {
  name: 'authority.register',
  allowedScopes: ['admin'],
  permission: null,
  handler(context, payload) {
    const name = payload && payload.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TightbeamError('malformed_request', 'name is required and must be a non-empty string', { field: 'name' });
    }
    const description = payload.description;
    if (description !== undefined && description !== null && typeof description !== 'string') {
      throw new TightbeamError('malformed_request', 'description must be a string when present', { field: 'description' });
    }

    const createdAt = new Date().toISOString();

    try {
      withTransaction(context.db, () => {
        context.db
          .prepare('INSERT INTO authorities (name, description, created_at) VALUES (?, ?, ?)')
          .run(name, description ?? null, createdAt);
      });
    } catch (err) {
      // docs/protocol.md authority.register: duplicate name is
      // malformed_request (not identity_conflict, unlike
      // application.register's duplicate-name case).
      if (isUniqueConstraintError(err)) {
        throw new TightbeamError('malformed_request', `an authority named "${name}" is already registered`, { field: 'name' });
      }
      throw err;
    }

    return { result: { name, description: description ?? null, created_at: createdAt } };
  },
};
