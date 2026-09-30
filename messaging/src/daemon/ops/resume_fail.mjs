// resume.fail — docs/protocol.md "Resume requests". retry-then-terminal
// shape adapted from tldr;'s comms_dispatcher.mjs (see the internal provenance record):
// a `retryable: true` failure with attempts remaining returns the
// request to 'pending' (releasing this claim so a fresh resume.claim can
// re-acquire it, incrementing the claims table's attempt_count); a
// non-retryable failure, or a retryable one with attempts exhausted, is
// terminal ('failed'). MAX_RESUME_ATTEMPTS mirrors tldr;'s
// DISPATCH_MAX_ATTEMPTS (8) — a tuned operational parameter carried over
// as this repository's own default, not an architectural fact.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { withTransaction } from '../db.mjs';
import { releaseClaim, verifyClaimToken } from './claims_shared.mjs';

export const MAX_RESUME_ATTEMPTS = 8;
// Closed adapter taxonomy. This is positive adapter evidence, never a
// free-form child-process error string.
export const EXACT_SESSION_UNAVAILABLE = 'exact_session_unavailable';

export const resumeFailOp = {
  name: 'resume.fail',
  allowedScopes: ['agent'],
  permission: 'claim_resume_requests',
  handler(context, payload) {
    const resumeRequestId = payload && payload.resume_request_id;
    const token = payload && payload.token;
    const retryable = Boolean(payload && payload.retryable);
    const reason = payload && payload.reason;
    if (typeof resumeRequestId !== 'string' || resumeRequestId.length === 0) {
      throw new TightbeamError('malformed_request', 'resume_request_id is required and must be a string', { field: 'resume_request_id' });
    }

    const now = new Date();
    const outcome = withTransaction(context.db, () => {
      const { row, alreadyResolved } = verifyClaimToken(context.db, { resourceType: 'resume_request', resourceId: resumeRequestId, token, now });

      if (alreadyResolved) {
        if (row.outcome !== 'failed') {
          throw new TightbeamError('claim_expired', 'this claim was already resolved with a different outcome');
        }
        const current = context.db.prepare('SELECT state FROM resume_requests WHERE id = ?').get(resumeRequestId);
        return { resume_request_id: resumeRequestId, state: current.state };
      }

      const attemptsExhausted = row.attempt_count >= MAX_RESUME_ATTEMPTS;
      const terminal = !retryable || attemptsExhausted;
      const nextState = terminal ? 'failed' : 'pending';

      releaseClaim(context.db, { row, outcome: 'failed', now });
      context.db.prepare(
        `UPDATE resume_requests
            SET state = ?,
                replacement_failure_reason = CASE WHEN ? = 'failed' AND ? = 0 AND ? = ? THEN ? ELSE replacement_failure_reason END,
                updated_at = ?
          WHERE id = ?`,
      ).run(nextState, nextState, retryable ? 1 : 0, reason ?? null, EXACT_SESSION_UNAVAILABLE, EXACT_SESSION_UNAVAILABLE, now.toISOString(), resumeRequestId);

      return { resume_request_id: resumeRequestId, state: nextState };
    });

    return { result: outcome };
  },
};
