// The daemon's own resume children that are still running (ac-4p2j0 moved this out of resumer.mjs so the
// owner-process pass can read it without importing the resumer).
// Item 48: the daemon's own resume children that are still running, per
// endpoint, for this daemon's lifetime. A claim lease bounds the
// confirmation window, not the child: a resumed `codex exec` that first
// finishes a killed turn outlives its lease, and a second resume of the same
// session beside it fails (Codex) or shares its transcript (Claude). An
// availability takeover therefore waits while any child for the endpoint is
// alive. Kept in memory: a daemon restart forgets children it no longer
// supervises, and the takeover backoff above still bounds that case.

export const liveResumeChildren = new WeakMap();

export function trackResumeChild(context, endpointId, entry) {
  let byEndpoint = liveResumeChildren.get(context);
  if (!byEndpoint) {
    byEndpoint = new Map();
    liveResumeChildren.set(context, byEndpoint);
  }
  const entries = byEndpoint.get(endpointId) ?? new Set();
  entries.add(entry);
  byEndpoint.set(endpointId, entries);
  const untrack = () => {
    entries.delete(entry);
    if (entries.size === 0 && byEndpoint.get(endpointId) === entries)
      byEndpoint.delete(endpointId);
  };
  entry.untrack = untrack;
  return untrack;
}

/** The oldest still-running daemon resume child for an endpoint, or null. */
export function liveResumeChildFor(context, endpointId) {
  const entries = liveResumeChildren.get(context)?.get(endpointId);
  if (!entries || entries.size === 0) return null;
  let oldest = null;
  for (const entry of entries)
    if (oldest === null || entry.startedAtMs < oldest.startedAtMs)
      oldest = entry;
  return oldest;
}

/**
 * Which way the launch behind `capture` (resumer captureLaunchCustody) speaks for `endpoint` NOW, or null:
 * 'registered' (its own registration stamped the latest owner token) or 'unchanged' (nothing has registered
 * since its capture: same token, same owner process tuple; this keeps a launch that died before its hook
 * stamped anything). A newer process that restamps the row without advancing generation or epoch gets null.
 */
export function launchIdentity(endpoint, capture) {
  const token = endpoint.owner_launch_token ?? null;
  if (token !== null && token === capture.launchToken) return "registered";
  const unchanged =
    token === (capture.recordedOwnerToken ?? null) &&
    (endpoint.owner_process_pid ?? null) ===
      (capture.recordedOwnerPid ?? null) &&
    (endpoint.owner_process_start_identity ?? null) ===
      (capture.recordedOwnerStart ?? null);
  return unchanged ? "unchanged" : null;
}

/**
 * A live SUPERVISED child of the endpoint that is the recorded owner ('registered' on the endpoint row), or
 * null: its own 'exit' callback will decide limit versus death for the owner pass's observation. Only
 * 'registered' defers: an 'unchanged' (never-registered) tracked child did not replace an earlier owner,
 * whose real death must be decided now. A hosted-queue child is not one (its 'exit' already ran;
 * settleHostedQueues owns it).
 */
export function liveSupervisedChildFor(context, endpointId, endpoint) {
  for (const entry of liveResumeChildren.get(context)?.get(endpointId) ?? [])
    if (
      !entry.hostedQueue &&
      launchIdentity(endpoint, entry.capture) === "registered"
    )
      return entry;
  return null;
}

/**
 * Placeholder rows an unhinted registration may adopt: not one the daemon is
 * cold-starting a child for while the registrant proves it is another
 * process: its owner facts sit outside every live child's process group (the
 * child is spawned detached, so its group id is its pid; the hook reports it)
 * and it carries none of their launch tokens. Taking it would leave that
 * child, whose launch brief says reply required, on a fresh endpoint with
 * nothing to receive (ac-asrmm). A registrant with no owner facts may be the
 * child that lost its launch env (ac-jfv.27), so it keeps the oldest rule, as
 * do external spawners.
 * After a daemon restart the children are gone from memory, so a launch the
 * previous daemon claimed holds its placeholder until that claim's lease ends
 * (ac-bj3zr); a lost-env child of it then registers fresh and the request
 * relaunches, a bounded duplicate rather than a silent misroute.
 */
export function withoutDaemonReserved(
  context,
  rows,
  { principalId, providerSessionId, launchToken, ownerProcess },
) {
  const byEndpoint = liveResumeChildren.get(context);
  const now = new Date().toISOString();
  const startedAt = context.startedAt
    ? new Date(context.startedAt).toISOString()
    : null;
  const priorLaunch = context.db.prepare(
    `SELECT 1 FROM claims c JOIN resume_requests r ON r.id = c.resource_id
      WHERE c.resource_type = 'resume_request' AND c.state = 'claimed' AND c.outcome IS NULL
        AND r.state = 'claimed' AND r.endpoint_id = ? AND c.claimed_at < ? AND c.lease_expires_at > ?
      LIMIT 1`,
  );
  const isChild = (child) =>
    (launchToken && launchToken === child.capture?.launchToken) ||
    ownerProcess.process_group_id === child.pid;
  const reserved = (row) => {
    const children = [...(byEndpoint?.get(row.id) ?? [])];
    return children.length === 0
      ? Boolean(startedAt && priorLaunch.get(row.id, startedAt, now))
      : Boolean(ownerProcess) && !children.some(isChild);
  };
  const kept = rows.filter((row) => !reserved(row));
  if (kept.length < rows.length) {
    context.logger?.info?.({
      event: "endpoint.register.placeholder_reserved",
      params: {
        principal_id: principalId,
        provider_session_id: providerSessionId,
      },
      result: {
        reserved: rows
          .filter((row) => !kept.includes(row))
          .map((row) => row.id),
      },
      status: "ok",
    });
  }
  return kept;
}
