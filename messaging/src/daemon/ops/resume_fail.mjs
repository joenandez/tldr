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
import { classifyHoldableFailure } from '../../../../scheduling/src/lib/holdable_failure.mjs';

export const MAX_RESUME_ATTEMPTS = 8;
// Closed adapter taxonomy. This is positive adapter evidence, never a
// free-form child-process error string.
export const EXACT_SESSION_UNAVAILABLE = 'exact_session_unavailable';
// F34: why the daemon ended a resume of an existing Codex session on purpose
// rather than start a second writer beside the app that holds it. The session
// is fine and its message stays unread; the reason is how the requester is told.
export const CODEX_HOST_UNKNOWN = 'codex_host_unknown';
export const CODEX_QUEUE_REFUSED = 'codex_queue_refused';
export const CODEX_QUEUE_FAILED = 'codex_queue_failed';
export const HOSTED_LAUNCH_FAILURE_REASONS = Object.freeze([CODEX_HOST_UNKNOWN, CODEX_QUEUE_REFUSED, CODEX_QUEUE_FAILED]);
/** The attention source the resumer marks a root with for a daemon-ended hosted resume. */
export const hostedAttentionSource = (reason) => `resume.${reason}`;

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

// ac-jfv.165: a wake refused by a provider usage limit waits for the limit
// instead of spending MAX_RESUME_ATTEMPTS. The reset time comes from Helm's
// own parser, so there is one reading of a `rate_limit_event`.

export const USAGE_LIMIT_REASON = 'usage_limit';
// Claim outcome of a wake held for a limit. Unlike 'backoff', newer mail never cuts it short.
export const LIMIT_BACKOFF_OUTCOME = 'limit_backoff';
// What the sending agent is told when the wake is finally given up on.
export const USAGE_LIMIT_NOTICE = {
  reason: USAGE_LIMIT_REASON,
  event: 'resume.usage_limit_sender_notified',
  body: 'Your message was not delivered to the agent session: its provider usage limit stayed in force for 24 hours (reason: usage_limit). Nothing ran and the message is still unread. Send it again after the limit resets, or ask your user to have an agent run `tldr-agents messaging recovery rewake`.',
};
export const LIMIT_RESET_MARGIN_MS = 60_000;
export const LIMIT_MIN_DELAY_MS = 60_000;
export const LIMIT_MAX_RAMP_MS = 3_600_000;
export const LIMIT_HORIZON_MS = 24 * 3_600_000;

// What a whole captured stream says, by the shared parser's recovery ordering
// (a limit a later successful turn recovered from does not count): null when
// no usage limit is current at exit, else the provider result of one,
// `{ error: 'rate_limit', resets_at? }` (reset in ms).
export function usageLimitFromLines(lines) {
  const found = classifyHoldableFailure(lines, { provider: 'claude' });
  if (!found.holdable || found.reason !== USAGE_LIMIT_REASON) return null;
  return { error: 'rate_limit', ...(found.until ? { resets_at: found.until } : {}) };
}

// A successful turn after a limit or error means the run recovered from it.
/** A usage-limit refusal: stdout's own verdict first; stderr limit text unless stdout recovered, succeeded, or named another error. */
export function limitRefused(diagnostic, providerResult) {
  if (providerResult?.error === 'rate_limit') return true;
  return diagnostic === 'rate_limited' && !providerResult?.recovered && providerResult?.is_error !== false && !providerResult?.error;
}

export function withoutLimitEvidence(result) {
  const rest = { ...result };
  if (rest.error === 'rate_limit') delete rest.error;
  delete rest.resets_at;
  return rest;
}

/**
 * How a limit refusal at `nowMs` is handled. A reset the provider names that
 * is still ahead is always waited for: `{ delayMs }` to reset + 60 s, whatever
 * the age. Otherwise `{ expired: true }` 24 h after the request's first limit
 * refusal (`firstAt`), else a doubling ramp: time since that refusal, clamped
 * to [60 s, 60 min], which keeps a transient 429 fast and a long limit hourly.
 */
export function limitHoldFor({ nowMs, firstAt, resetsAtMs = null }) {
  if (Number.isFinite(resetsAtMs) && resetsAtMs > nowMs)
    return { delayMs: resetsAtMs + LIMIT_RESET_MARGIN_MS - nowMs };
  const firstMs = Date.parse(firstAt) || nowMs;
  if (nowMs >= firstMs + LIMIT_HORIZON_MS)
    return { expired: true, reason: USAGE_LIMIT_REASON };
  return { delayMs: Math.min(Math.max(nowMs - firstMs, LIMIT_MIN_DELAY_MS), LIMIT_MAX_RAMP_MS) };
}

// The earliest limit refusal of the holder endpoint's current unbroken limit episode (ac-4p2j0 r27):
// across every request for that endpoint, whichever one a launch happens to be for. The 24 h clock
// only bounds time with no requester-visible progress, so the episode ends on (1) an earlier launch
// (claimed before this one) that completed and was never stamped by a limit exit, or (2) a
// requester-visible effect the holder's own process sent: an update, complete or delegate/park with a
// body. Acks and presentation acks are delivery rows with no effect, and a daemon-written notice carries
// `notice` in its effect payload and is type 'none', so none of them break it. The refusing claim always counts.
// The effect scan is bounded to the effects of work in the endpoint's own conversations (the
// message_effects_obligation_effect and idx_obligations_conversation_status indexes), like holder_death's progressed().
// shortcut: the completed-launch lookup scans the claims table (no non-partial claims(resource_id) index), once
// per limit refusal; add claims(resource_type, resource_id) to performance_indexes.mjs if claims reach ~10^5 rows.
function episodeFirstAt(db, { requestId, claimId }) {
  const { endpoint_id: endpointId } = db.prepare('SELECT endpoint_id FROM resume_requests WHERE id = ?').get(requestId);
  const { claimed_at: launchAt } = db.prepare('SELECT claimed_at FROM claims WHERE id = ?').get(claimId);
  return db.prepare(
    `WITH episode(id) AS (SELECT id FROM resume_requests WHERE endpoint_id = ?1),
          broken(at) AS (
            SELECT MAX(at) FROM (
              SELECT c.released_at AS at FROM claims c
               WHERE c.resource_type = 'resume_request' AND c.resource_id IN (SELECT id FROM episode)
                 AND c.outcome = 'completed' AND c.limit_refused_at IS NULL AND c.claimed_at < ?2
              UNION ALL
              SELECT m.created_at FROM message_effects me JOIN messages m ON m.id = me.message_id
               WHERE me.obligation_id IN (SELECT o.id FROM obligations o WHERE o.conversation_id IN (SELECT conversation_id FROM resume_requests WHERE endpoint_id = ?1))
                 AND me.effect IN ('update', 'close.fulfilled', 'handoff.offer') AND m.body <> ''
                 AND json_extract(me.effect_payload, '$.notice') IS NULL
                 AND json_extract(me.effect_payload, '$.declaration.sender_endpoint_id') = ?1))
     SELECT MIN(c.limit_refused_at) AS firstAt FROM claims c
      WHERE c.resource_type = 'resume_request' AND c.resource_id IN (SELECT id FROM episode) AND c.limit_refused_at IS NOT NULL
        AND (c.id = ?3 OR c.limit_refused_at > COALESCE((SELECT at FROM broken), ''))`,
  ).get(endpointId, launchAt, claimId).firstAt;
}

// null unless a usage limit alone refused the launch; else limitHoldFor's answer (plus `firstAt`),
// measured from the first refusal of the endpoint's limit episode (episodeFirstAt), this claim stamped first.
// shortcut: claims stay behind on a state export, so each import restarts a
// wake's no-reset window (24 h more per import); a versioned export would fix it.
export function limitOutcome(db, { rateLimited, unavailable, requestId, claimId, nowMs, resetsAtMs }) {
  if (!rateLimited || unavailable) return null;
  db.prepare('UPDATE claims SET limit_refused_at = COALESCE(limit_refused_at, ?) WHERE id = ?').run(new Date(nowMs).toISOString(), claimId);
  const firstAt = episodeFirstAt(db, { requestId, claimId });
  return { ...limitHoldFor({ nowMs, firstAt, resetsAtMs }), firstAt };
}

/** The takeover path's limit decision: the hold, a terminal usage_limit failure 24 h on, or null when no limit alone refused it. */
export function holdIfLimited(db, { row, rateLimited, unavailable = false, requestId, resetsAtMs = null, now }) {
  const limit = limitOutcome(db, { rateLimited, unavailable, requestId, claimId: row.id, nowMs: now.getTime(), resetsAtMs });
  if (limit?.delayMs) return holdClaimForLimit(db, { row, limit, resetsAtMs, now });
  if (!limit?.expired) return null;
  releaseClaim(db, { row, outcome: 'failed', now });
  db.prepare("UPDATE resume_requests SET state = 'failed', replacement_failure_reason = ?, updated_at = ? WHERE id = ? AND state = 'claimed'")
    .run(limit.reason, now.toISOString(), requestId);
  return { state: 'failed', attempt: row.attempt_count, cause: limit.reason };
}

// Holds the live launch's claim until the limit should be over and hands its
// attempt back, so refusals never spend MAX_RESUME_ATTEMPTS.
export function holdClaimForLimit(db, { row, limit, resetsAtMs, now }) {
  const retryAt = new Date(now.getTime() + limit.delayMs).toISOString();
  db.prepare(
    'UPDATE claims SET lease_expires_at = ?, outcome = ?, attempt_count = MAX(attempt_count - 1, 0) WHERE id = ?',
  ).run(retryAt, LIMIT_BACKOFF_OUTCOME, row.id);
  return {
    state: 'backoff',
    attempt: Math.max(row.attempt_count - 1, 0),
    delay_ms: limit.delayMs,
    retry_at: retryAt,
    cause: USAGE_LIMIT_REASON,
    attempt_spent: false,
    resets_at: resetsAtMs,
  };
}

/** One stream-json line, or null when it is not JSON. */
export function jsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
