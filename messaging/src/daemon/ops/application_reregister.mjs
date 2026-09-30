// application.reregister — admin-only credential replacement for an existing
// application. The application id and every row owned by it remain unchanged;
// only the one-way secret hash is replaced and the new secret is returned once.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { generateAppSecret, hashSecret } from '../auth.mjs';

export const applicationReregisterOp = {
  name: 'application.reregister',
  allowedScopes: ['admin'],
  permission: null,
  handler(context, payload) {
    const name = payload && payload.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TightbeamError('malformed_request', 'name is required and must be a non-empty string', { field: 'name' });
    }

    const application = context.db.prepare("SELECT id FROM applications WHERE name = ? AND status = 'active'").get(name);
    if (!application) {
      throw new TightbeamError('application_unknown', `no active application registered with name "${name}"`, { field: 'name' });
    }

    const secret = generateAppSecret();
    context.db.prepare('UPDATE applications SET secret_hash = ? WHERE id = ?').run(hashSecret(secret), application.id);

    return {
      result: {
        app_id: application.id,
        app_secret: secret,
        re_registered: true,
      },
    };
  },
};
