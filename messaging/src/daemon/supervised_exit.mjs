// Whether one supervised child exit is death evidence for the custody its
// endpoint holds (resumer.mjs exit handler).

// An endpoint a recovery replaced is no longer the one to resume.
export const NOT_SUPERSEDED_ENDPOINT = `NOT EXISTS (
    SELECT 1 FROM resume_requests superseding
     WHERE superseding.endpoint_id = e.id AND superseding.replacement_endpoint_id IS NOT NULL
  )`;

// Why an exit leaves nothing resumable (first rule that holds), or null when
// the session can resume.
const UNRESUMABLE = [
  ["endpoint_unknown", (endpoint) => !endpoint],
  ["endpoint_closed", (endpoint) => endpoint.state === "closed"],
  ["endpoint_superseded", (endpoint) => !endpoint.current],
  ["clean_exit_without_session", (endpoint) => !endpoint.provider_session_id],
];
const unresumable = (endpoint) =>
  UNRESUMABLE.find(([, holds]) => holds(endpoint))?.[0] ?? null;

/**
 * A headless session ends its turn by exiting 0; that is the session
 * stopping, not dying, so the work it holds stays open and the same session
 * is resumed by the next message (ux.md: `stopped` = process exited,
 * resumable; scope SC4/SC9/SC12). The owner-exit reconciler makes the same
 * call for an exit it observes (retirement_executor.mjs). Rules:
 *
 *   abnormal_exit                    the provider's own "session not on this
 *                                    machine" words (also admits the disclosed
 *                                    replacement), a launch whose request
 *                                    failed for good, or a nonzero/signal exit
 *                                    with nothing resumable;
 *   endpoint_unknown/closed/superseded
 *                                    nothing resumable remains to retain;
 *   clean_exit_without_session       the launch never adopted a provider
 *                                    session, so there is nothing to resume.
 *
 * An exit of an endpoint with a bound provider session id retains custody:
 * `clean_exit_resumable_session`, or `abnormal_exit_resumable_session` for a
 * crash or kill (ac-4p2j0): the resumer relaunches a launch that died before
 * its brief, and holder_death.mjs resumes one that died after it.
 */
export function decideSupervisedExit(
  db,
  { endpointId, failed, unavailable = false, terminal = false },
) {
  const openOwnedWork = db
    .prepare(
      "SELECT COUNT(*) AS n FROM obligations WHERE custodian_endpoint_id = ? AND status = 'open'",
    )
    .get(endpointId).n;
  const decide = (rule, retainsCustody) => ({
    rule,
    retainsCustody,
    openOwnedWork,
  });
  // A request that failed for good (attempts, auth, a 24 h usage limit) keeps
  // the old death path: its requester is told now, not after a retry.
  if (failed && (unavailable || terminal))
    return decide("abnormal_exit", false);
  const endpoint = db
    .prepare(
      `SELECT e.state, e.provider_session_id, ${NOT_SUPERSEDED_ENDPOINT} AS current FROM endpoints e WHERE e.id = ?`,
    )
    .get(endpointId);
  const lost = unresumable(endpoint);
  if (lost) return decide(failed ? "abnormal_exit" : lost, false);
  return decide(
    failed ? "abnormal_exit_resumable_session" : "clean_exit_resumable_session",
    true,
  );
}
