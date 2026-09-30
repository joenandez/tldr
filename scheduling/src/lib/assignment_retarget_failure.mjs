// assignment_retarget_failure — what a retarget failure means once the
// destination has already been committed.
//
// The source catalog write is followed by advisory index/projection writes, so
// an exception can reach the caller AFTER the canonical removal is on disk.
// Treating "an exception escaped" as "the move did not land" would then delete
// the destination copy of an assignment that no longer exists in the source —
// losing it from both scopes. So the decision is made from the source catalog
// on disk, and when that evidence is missing or unreadable the destination copy
// is kept and named in the error rather than removed on a guess.

import { loadJobsReadOnly } from "./store.mjs";
import { mutateJobs } from "./scope_runtime.mjs";
import { removeAll } from "./assignment_artifacts.mjs";
import { ASSIGNMENTS_COMMAND } from "./helm_context.mjs";

export function coded(code, message, details = {}, exitCode = 1) {
  return Object.assign(new Error(message), { code, details, exitCode });
}

// The source write failed and the source catalog still holds the assignment.
// Undo the destination so the original stays canonical, and say plainly which
// of the two states the caller is now in.
async function undoCommittedDestination({
  destScope,
  sourceScope,
  owner,
  jobId,
  created,
  cause,
}) {
  const result = await mutateJobs(destScope, owner, (destJobs) => {
    const idx = destJobs.findIndex((j) => j.id === jobId);
    if (idx >= 0) destJobs.splice(idx, 1);
  });
  const leftovers = removeAll(created);
  const undone = result.ok && leftovers.length === 0;
  const reason = String(cause?.message || cause);
  return coded(
    undone ? "retarget_failed" : "retarget_rollback_failed",
    undone
      ? `retarget aborted (${reason}); the assignment is unchanged in ${sourceScope.cwd}`
      : `retarget aborted (${reason}) and the destination copy could not be undone; ${jobId} may now exist in both ${sourceScope.cwd} and ${destScope.cwd}`,
    {
      from_cwd: sourceScope.cwd,
      to_cwd: destScope.cwd,
      // Observed, not assumed: resolveCommittedFailure re-read the catalog.
      original_preserved: true,
      destination_preserved: !undone,
      destination_rolled_back: undone,
      leftovers,
      retryable: undone,
    },
  );
}

// true / false / null(unreadable) — the only evidence that says whether the
// source removal actually landed.
function sourceStillHolds(sourceScope, jobId) {
  try {
    return loadJobsReadOnly(sourceScope).some((j) => j.id === jobId);
  } catch {
    return null;
  }
}

/**
 * Classify a failure that surfaced after the destination catalog was committed.
 * Returns (never throws) the coded error the caller should throw.
 */
export async function resolveCommittedFailure({
  sourceScope,
  destScope,
  owner,
  jobId,
  created,
  cause,
}) {
  const stillInSource = sourceStillHolds(sourceScope, jobId);
  if (stillInSource === true) {
    return undoCommittedDestination({
      destScope,
      sourceScope,
      owner,
      jobId,
      created,
      cause,
    });
  }
  const reason = String(cause?.message || cause);
  const committed = stillInSource === false;
  return coded(
    committed ? "retarget_source_committed" : "retarget_state_unverified",
    committed
      ? `retarget reported a failure (${reason}) after the move already landed; ${jobId} now lives in ${destScope.cwd} and its copy was kept — do not retry, read it with '${ASSIGNMENTS_COMMAND} show ${jobId} --cwd ${destScope.cwd}'`
      : `retarget failed (${reason}) and ${sourceScope.cwd} could not be re-read to tell whether the move landed; the copy in ${destScope.cwd} was kept — inspect both scopes before retrying`,
    {
      from_cwd: sourceScope.cwd,
      to_cwd: destScope.cwd,
      original_preserved: committed ? false : null,
      destination_preserved: true,
      destination_rolled_back: false,
      leftovers: [],
      retryable: false,
    },
  );
}
