// Shared resume-request logic that is not one operation's alone:
// completion (driven by message.read, not by any resume.* operation) and
// the allowed_runtime_types grant check that resume.claim and resume.list
// both apply.
//
// Completion rule (plan phase 4 «Completion»): a resume request completes
// on the resumed session's first `message.read` of the request's
// `message_id`, THROUGH the endpoint the request targets — not at
// SessionStart, where the session has read nothing yet, not on any
// endpoint revival, and not on a sibling session's read. "Completed"
// therefore means that session came back AND read the message, which is
// strictly stronger than what `resume.complete` asserts. This supersedes
// docs/Tightbeam-Hooks-&-Responsibilities-Alignment.md's SessionStart
// wording by an explicit recorded plan decision.

import { TightbeamError } from '../../protocol/envelope.mjs';
import { CANONICAL_RUNTIME_IDS } from '../../runtimes/builtins.mjs';
import { acceptedStoredIds as acceptedStoredIdsPure, canonicalizeRuntimeId as canonicalizeRuntimeIdPure } from '../../runtimes/registry.mjs';

/**
 * Completes the non-terminal resume requests that (messageId,
 * principalId, endpointId) identifies, releasing the claim the resumer
 * (or an external adapter) holds on each, and closing a Case D(b)
 * placeholder endpoint that has nothing behind it. Returns the completed
 * resume_request ids.
 *
 * R5a: `endpointId` is REQUIRED and matched against
 * `resume_requests.endpoint_id`. Completion means the resumed TARGET came
 * back and read its message, which is strictly stronger than "someone
 * under this principal read it". The reader's endpoint is verified by
 * message.read before it gets here, and `deliveries` carries it, so
 * nothing is inferred. Without that scope a sibling window — or a
 * principal-level `tightbeam read` — could suppress the recovery of a
 * dead session (the tick never starts it) or falsely confirm a spawn
 * before the child had read anything. A caller that cannot name an
 * endpoint completes nothing here; `resume.complete` stays the documented
 * plug-in point for a runtime that cannot report one.
 *
 * Case D(b) still works, and for a better reason than before: a spawned
 * session ADOPTS its placeholder (src/daemon/ops/endpoint_register.mjs),
 * so the reader's endpoint IS the request's endpoint and the scoped match
 * succeeds.
 *
 * Placeholder cleanup: an endpoint with a NULL `provider_session_id` has
 * nothing behind it. Left open, it would collect a fresh resume request
 * (and a fresh spawn) for every later message to that principal, forever.
 * `createDeliveriesForRecipients` already excludes `state = 'closed'`
 * from fan-out, so closing it is the whole fix. It is reachable when an
 * application reads on the placeholder's own behalf — an external runtime
 * that uses the API and registers no session of its own.
 *
 * Callers run this inside their own write transaction (message.read's).
 */
export function completeResumeRequestsForMessage(db, { messageId, principalId, endpointId, now, resumeRequestId = null }) {
  if (typeof endpointId !== 'string' || endpointId.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT r.id AS id, r.endpoint_id AS endpoint_id, e.provider_session_id AS provider_session_id
         FROM resume_requests r
         JOIN endpoints e ON e.id = r.endpoint_id
        WHERE r.message_id = ? AND r.principal_id = ? AND r.endpoint_id = ?
          AND (? IS NULL OR r.id = ?)
          AND r.state IN ('pending', 'claimed')
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(messageId, principalId, endpointId, resumeRequestId, resumeRequestId);
  if (rows.length === 0) return [];

  const releaseClaimRow = db.prepare(
    "UPDATE claims SET state = 'released', outcome = 'completed', released_at = ? WHERE resource_type = 'resume_request' AND resource_id = ? AND state = 'claimed'",
  );
  const completeRequest = db.prepare("UPDATE resume_requests SET state = 'completed', updated_at = ? WHERE id = ?");
  const closePlaceholder = db.prepare(
    "UPDATE endpoints SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND provider_session_id IS NULL AND state != 'closed'",
  );

  for (const row of rows) {
    releaseClaimRow.run(now, row.id);
    completeRequest.run(now, row.id);
    if (row.provider_session_id === null) closePlaceholder.run(now, now, row.endpoint_id);
  }
  return rows.map((row) => row.id);
}

// --- the canonicalization contract, injected at every comparison site -----
//
// Every exact-string runtime comparison in the resume/endpoint surface
// goes through these three helpers instead of a consumer-local alias map:
// consumers pass the registry snapshot's own canonicalizeRuntimeId /
// acceptedStoredIds (plan W1 «Canonical ids and legacy equivalence»).
// Where a caller has no registry on its context — unit fixtures only;
// the daemon always wires one — the pure leaf functions are the same
// contract over the builtin space.

/** The canonicalization pair a context carries, or the pure builtin one. */
export function runtimeContract(context) {
  const registry = context && context.runtimeRegistry;
  return {
    canonicalize: registry ? registry.canonicalizeRuntimeId : canonicalizeRuntimeIdPure,
    acceptedStoredIds: registry ? registry.acceptedStoredIds : acceptedStoredIdsPure,
  };
}

/**
 * Whether two STORED runtime spellings name the same runtime. Equal
 * strings compare equal unchanged — that is what keeps unknown,
 * endpoint-registered types ('reference', an adapter's own id) behaving
 * exactly as before. Known ids additionally compare equal across the
 * legacy-equivalence classes ('claude' ≡ 'claude-code'). Two DIFFERENT
 * unknown ids never alias to each other: canonicalize returns null for
 * both, and null is never equal.
 */
export function runtimeIdEquals(a, b, canonicalize) {
  if (a === b) return true;
  if (typeof canonicalize !== 'function') return false;
  const canonicalA = canonicalize(a);
  return canonicalA !== null && canonicalA === canonicalize(b);
}

/**
 * Every stored spelling that must match `ids` in a SQL IN list: each id
 * itself plus, for known ids, its legacy aliases. Unknown ids contribute
 * exactly themselves, so external-strategy grants and filters keep their
 * wire-exact behavior.
 */
export function expandStoredRuntimeIds(ids, acceptedStoredIds) {
  const accept = typeof acceptedStoredIds === 'function' ? acceptedStoredIds : acceptedStoredIdsPure;
  return [...new Set(ids.flatMap((id) => accept(id) ?? [id]))];
}

/**
 * Fails loudly on an `allowed_runtime_types` grant value that names no
 * registered runtime (plan phase 4, «Changed contracts»): the grant
 * values used to hold authority names and now hold runtime names, with no
 * compatibility shim. A stale value would otherwise silently produce
 * `resume_handler_unavailable` — "there is nothing for you" — for a
 * caller whose real problem is a misconfigured grant.
 *
 * "Registered" is every stored spelling of every runtime record the
 * registry snapshot holds (canonical ids AND their legacy aliases — a
 * persisted ["claude"] grant stays valid after the daemon learns to say
 * claude-code), plus every runtime some endpoint has actually registered
 * under, so an external runtime the daemon cannot start (the documented
 * plug-in point) is still a valid grant value. The diagnostic names the
 * offending value and the daemon-managed runtimes only — never the other
 * runtimes on this daemon, which would be cross-app state in a response
 * (docs/protocol.md «Diagnostics rule»).
 */
export function assertGrantRuntimesRegistered(db, allowedRuntimeTypes, { registry } = {}) {
  if (!Array.isArray(allowedRuntimeTypes) || allowedRuntimeTypes.length === 0) return;
  // No snapshot on the context (unit fixtures only): the builtin space is
  // the same truth the pure contract serves.
  const recordIds = registry ? registry.list().map((record) => record.id) : [...CANONICAL_RUNTIME_IDS];
  const accept = registry ? registry.acceptedStoredIds : acceptedStoredIdsPure;
  const registered = new Set();
  for (const id of recordIds) {
    for (const spelling of accept(id) ?? [id]) registered.add(spelling);
  }
  for (const row of db.prepare('SELECT DISTINCT runtime FROM endpoints WHERE runtime IS NOT NULL').all()) registered.add(row.runtime);

  const offenders = allowedRuntimeTypes.filter((value) => !registered.has(value));
  if (offenders.length === 0) return;
  const daemonNames = registry
    ? registry
        .list()
        .filter((record) => record.resumeStrategy === 'daemon')
        .map((record) => record.id)
    : [...CANONICAL_RUNTIME_IDS];
  const managedNames = daemonNames.join(', ');
  throw new TightbeamError(
    'permission_denied',
    `claim_resume_requests grants allowed_runtime_types value${offenders.length > 1 ? 's' : ''} ` +
      `${offenders.map((value) => JSON.stringify(value)).join(', ')} matching no registered runtime ` +
      `(this daemon starts ${managedNames}; any other runtime must have a registered endpoint before it can be claimed for)`,
  );
}
