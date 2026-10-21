// host.wake.result — session_hosts.v1. A host reports what it did with a
// host.wake_requested. Record-only: one structured log, no state change. The
// wake id must name a resume request or delivery whose endpoint is bound to
// the caller's own application name.

import { TightbeamError } from '../../protocol/envelope.mjs';

const OUTCOMES = new Set(['prompted', 'busy', 'not_hosted', 'failed']);
const MAX_DETAIL_LENGTH = 256;

export const hostWakeResultOp = {
  name: 'host.wake.result',
  allowedScopes: ['agent'],
  permission: 'host_sessions',
  handler(context, payload, connection) {
    const wakeId = payload && payload.wake_id;
    const outcome = payload && payload.outcome;
    const detail = payload && payload.detail;
    if (typeof wakeId !== 'string' || wakeId.length === 0 || wakeId.length > 128) {
      throw new TightbeamError('malformed_request', 'wake_id is required and must be a string', { field: 'wake_id' });
    }
    if (!OUTCOMES.has(outcome)) {
      throw new TightbeamError('malformed_request', `outcome must be one of ${[...OUTCOMES].join(', ')}`, { field: 'outcome' });
    }
    if (detail !== undefined && detail !== null && typeof detail !== 'string') {
      throw new TightbeamError('malformed_request', 'detail must be a string when present', { field: 'detail' });
    }

    const endpoint = context.db
      .prepare(
        `SELECT e.id AS endpoint_id, e.host_name AS host_name
           FROM endpoints e
          WHERE e.id IN (SELECT endpoint_id FROM resume_requests WHERE id = ?1 UNION SELECT endpoint_id FROM deliveries WHERE id = ?1)`,
      )
      .get(wakeId);
    const app = context.db.prepare('SELECT name FROM applications WHERE id = ?').get(connection.appId);
    if (!endpoint || !endpoint.host_name || endpoint.host_name !== app?.name) {
      throw new TightbeamError('permission_denied', 'wake_id does not name a session bound to this host');
    }

    context.logger?.info({
      event: 'host.wake_result',
      params: { wake_id: wakeId, endpoint_id: endpoint.endpoint_id, host_name: endpoint.host_name },
      result: { outcome, ...(detail ? { detail: detail.slice(0, MAX_DETAIL_LENGTH) } : {}) },
      status: 'ok',
    });
    return { result: { recorded: true } };
  },
};
