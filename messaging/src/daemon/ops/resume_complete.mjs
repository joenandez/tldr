// resume.complete — docs/protocol.md "Resume requests". Terminal,
// durable, idempotent: a replay with the same token that already
// completed this claim returns the same result. Token-only
// authorization (no additional runtime_type scope re-check) matches
// delivery.complete/.release — the bearer token proves the caller
// already held a validly-scoped claim; protocol.md's error list for this
// operation is permission_denied (wrong token) / claim_expired only.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { releaseClaim, verifyClaimToken } from './claims_shared.mjs';

export const resumeCompleteOp = {
  name: 'resume.complete',
  allowedScopes: ['agent'],
  permission: 'claim_resume_requests',
  handler(context, payload) {
    const resumeRequestId = payload && payload.resume_request_id;
    const token = payload && payload.token;
    if (typeof resumeRequestId !== 'string' || resumeRequestId.length === 0) {
      throw new TightbeamError('malformed_request', 'resume_request_id is required and must be a string', { field: 'resume_request_id' });
    }

    const now = new Date();
    const outcome = withTransaction(context.db, () => {
      const { row, alreadyResolved } = verifyClaimToken(context.db, { resourceType: 'resume_request', resourceId: resumeRequestId, token, now });

      if (alreadyResolved) {
        if (row.outcome !== 'completed') {
          throw new TightbeamError('claim_expired', 'this claim was already resolved with a different outcome');
        }
        return { resume_request_id: resumeRequestId, state: 'completed' };
      }

      releaseClaim(context.db, { row, outcome: 'completed', now });
      context.db.prepare("UPDATE resume_requests SET state = 'completed', updated_at = ? WHERE id = ?").run(now.toISOString(), resumeRequestId);

      return { resume_request_id: resumeRequestId, state: 'completed' };
    });

    return { result: outcome };
  },
};
