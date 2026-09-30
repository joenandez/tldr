// application.register — docs/protocol.md "Administrative registration",
// admin-only (docs/security-model.md "Administrative operations").
// Issues a new app_id and a one-time app_secret; only a scrypt hash of the
// secret is ever stored.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateId } from '../../protocol/ids.mjs';
import { hashSecret, generateAppSecret } from '../auth.mjs';
import { withTransaction } from '../db.mjs';

function isUniqueConstraintError(err) {
  return err && err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message ?? '');
}

export const applicationRegisterOp = {
  name: 'application.register',
  allowedScopes: ['admin'],
  permission: null,
  handler(context, payload) {
    const name = payload && payload.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TightbeamError('malformed_request', 'name is required and must be a non-empty string', { field: 'name' });
    }

    const appId = generateId('application');
    const secret = generateAppSecret();
    const secretHash = hashSecret(secret);
    const createdAt = new Date().toISOString();

    try {
      withTransaction(context.db, () => {
        context.db
          .prepare('INSERT INTO applications (id, name, secret_hash, status, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(appId, name, secretHash, 'active', createdAt);
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new TightbeamError('identity_conflict', `an application named "${name}" is already registered`, { field: 'name' });
      }
      throw err;
    }

    return { result: { app_id: appId, app_secret: secret } };
  },
};
