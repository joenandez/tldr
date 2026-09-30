// assignment_retarget — move an assignment to another scope without breaking it.
//
// An assignment is a job in one scope's catalog plus a backing skill directory
// under that scope's cwd, plus per-scope run history, run logs and run reports.
// Moving it is therefore a multi-file, two-catalog operation, and the invariant
// that matters is continuity: the id and the run history must survive, because
// the documented alternative (create-new + archive-old) at least tells the
// caller the id changed. A move that loses history is worse than no move.
//
// Failure design, in the order the work happens:
//   1. everything validated before either lease is taken;
//   2. the SOURCE catalog lease is held across the whole move, so nothing else
//      can mutate the assignment mid-flight;
//   3. inside it, the DESTINATION lease is taken, artifacts are copied, and the
//      destination catalog is committed. Any failure here rolls back the copied
//      artifacts and throws before the source catalog is written — the original
//      assignment and its history are untouched;
//   4. only then is the entry removed from the source catalog. Whether that
//      removal landed is decided by RE-READING the source catalog, never by the
//      fact that an exception escaped: the source write is followed by advisory
//      index/projection writes, so an exception can arrive after the canonical
//      removal is already on disk. Rolling back the destination on that
//      evidence would delete the only surviving copy. So:
//        - id still in the source  → the move did not land; the destination is
//          rolled back (retarget_failed, or retarget_rollback_failed when the
//          undo itself fails, never a silent duplicate);
//        - id gone from the source → the move DID land; the destination is kept
//          and reported as retarget_source_committed;
//        - source unreadable       → the destination is kept and reported as
//          retarget_state_unverified. Keeping a copy beats guessing.
//
// Artifacts are copied (not moved) and the source copies are deleted last, so
// no window exists where the data lives nowhere.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadActiveRunsReadOnly, resolveScope } from "./store.mjs";
import { mutateJobs } from "./scope_runtime.mjs";
import { summarizeJobRuns } from "./run_completion.mjs";
import { DEFAULT_REPORT_CMD } from "./helm_context.mjs";
import {
  coded,
  resolveCommittedFailure,
} from "./assignment_retarget_failure.mjs";
import {
  assignmentArtifactPaths,
  assignmentHome,
  copyAssignmentArtifacts,
  moveLedgerRuns,
  removeAll,
  resolveAssignmentSkillSource,
  runIdsFor,
  slugifyForAssignment,
} from "./assignment_artifacts.mjs";

const isAssignment = (job) =>
  Array.isArray(job.tags) && job.tags.includes("assignment");

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

// Resolves --to-cwd into a scope, rejecting anything that cannot hold an
// assignment. Nothing is written before this passes.
export function resolveDestinationScope(sourceScope, toCwd) {
  if (typeof toCwd !== "string" || !toCwd.trim()) {
    throw coded(
      "to_cwd_required",
      "--to-cwd <path> is required (the working directory to move the assignment to)",
      {},
      2,
    );
  }
  const target = resolve(toCwd.trim());
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw coded(
      "invalid_destination",
      `destination working directory does not exist: ${target}`,
      { to_cwd: target },
      2,
    );
  }
  const destScope = resolveScope({ cwd: target });
  if (destScope.scope_id === sourceScope.scope_id) {
    throw coded(
      "invalid_destination",
      `assignment already lives in ${destScope.cwd}`,
      { to_cwd: destScope.cwd },
      2,
    );
  }
  return destScope;
}

// Same record, new home: only the scope-derived paths change so id, schedule
// and state (including run_count inputs) carry over untouched.
function rewriteForScope(job, destScope, slug) {
  const next = JSON.parse(JSON.stringify(job));
  const newSkillPath = join(assignmentHome(destScope.cwd, slug), "SKILL.md");
  next.metadata = next.metadata || {};
  next.metadata.assignment = next.metadata.assignment || {};
  next.metadata.assignment.skill_path = newSkillPath;
  if (next.prompt?.type === "inline" && typeof next.prompt.value === "string") {
    next.prompt = {
      ...next.prompt,
      value: `Run the skill at ${newSkillPath} and follow it.`,
    };
  }
  if (next.process?.cwd) next.process.cwd = destScope.cwd;
  next.meta = { ...(next.meta || {}), updated_at: nowIso() };
  return { job: next, skillPath: newSkillPath };
}

function assertDestinationFree(destJobs, { name, slug, destScope, jobId }) {
  // Ids are the continuity guarantee, so a destination that already holds this
  // id is a collision even when the record wears a different name — pushing
  // would leave two rows answering to one id.
  if (destJobs.some((j) => j.id === jobId)) {
    throw coded(
      "duplicate_id",
      `${destScope.cwd} already holds a job with id ${jobId}`,
      { to_cwd: destScope.cwd, job_id: jobId },
    );
  }
  const nameClash = destJobs.find((j) => j.name === name && j.id !== jobId);
  if (nameClash) {
    throw coded(
      "duplicate_name",
      `assignment name already exists in ${destScope.cwd}: ${name}`,
      { to_cwd: destScope.cwd },
    );
  }
  const slugClash = destJobs.find(
    (j) =>
      isAssignment(j) &&
      j.id !== jobId &&
      slugifyForAssignment(j.name) === slug,
  );
  if (slugClash) {
    throw coded(
      "duplicate_slug",
      `assignment slug "${slug}" already in use in ${destScope.cwd} (collides with "${slugClash.name}")`,
      { to_cwd: destScope.cwd },
    );
  }
  if (existsSync(assignmentHome(destScope.cwd, slug))) {
    throw coded(
      "destination_occupied",
      `${assignmentHome(destScope.cwd, slug)} already exists; move or remove it first`,
      { path: assignmentHome(destScope.cwd, slug) },
    );
  }
}

async function commitDestination({ destScope, owner, retargeted, prepare }) {
  const result = await mutateJobs(destScope, owner, (destJobs) => {
    prepare(destJobs);
    destJobs.push(retargeted);
  });
  if (!result.ok) {
    throw coded(
      "scope_busy",
      `destination scope is unavailable, try again: ${destScope.cwd}`,
      {
        scope_id: destScope.scope_id,
        reason: result.details?.reason || "lease_unavailable",
        retryable: true,
      },
    );
  }
}

// active-runs.json only knows about runs the dispatcher supervises to
// completion. A handoff run clears its active-run seconds after start while the
// agent session it launched keeps working, and that session reports into the
// cwd it was launched from — so moving out from under it strands the report in
// a scope that no longer owns the assignment. A run whose work_status is still
// "launched" is exactly that state: handed off, nothing reported yet.
function assertNoOpenSession(sourceScope, jobId) {
  const open = summarizeJobRuns({ scope: sourceScope, jobId }).find(
    (run) => run.work_status === "launched",
  );
  if (!open) return;
  throw coded(
    "assignment_has_open_session",
    `assignment ${jobId} handed run ${open.run_id} to an agent session that has not reported yet; moving it now would strand that session's report in ${sourceScope.cwd}. Wait for the session to finish (it reports with '${DEFAULT_REPORT_CMD} --run ${open.run_id} --job ${jobId} --status ok|fail'), then retry`,
    {
      run_id: open.run_id,
      session_id: open.session_id || null,
      started_at: open.started_at || null,
      terminal_reason: open.terminal_reason || null,
      retryable: true,
    },
  );
}

// Moves `jobId` from sourceScope to destScope. Throws a coded error on every
// failure path; the caller maps `code`/`details` onto the CLI envelope.
export async function retargetAssignment({
  sourceScope,
  destScope,
  jobId,
  owner,
}) {
  const active = loadActiveRunsReadOnly(sourceScope).runs?.[jobId];
  if (active) {
    throw coded(
      "assignment_busy",
      `assignment ${jobId} has a run in flight; retry once it finishes`,
      { run_id: active.run_id || null, retryable: true },
    );
  }
  assertNoOpenSession(sourceScope, jobId);

  // `committed` is set only once the destination catalog write has landed, so
  // it is exactly the marker for "a failure from here must undo the copy".
  let committed = null;
  let sourceResult;
  try {
    sourceResult = await mutateJobs(sourceScope, owner, async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx < 0) {
        throw coded("not_found", `no assignment matching "${jobId}"`);
      }
      const job = jobs[idx];
      const slug = slugifyForAssignment(job.name);
      const source = resolveAssignmentSkillSource({ scope: sourceScope, job });
      const runIds = runIdsFor(sourceScope, jobId);
      const { job: retargeted, skillPath } = rewriteForScope(
        job,
        destScope,
        slug,
      );

      const created = [];
      let reports = 0;
      try {
        await commitDestination({
          destScope,
          owner,
          retargeted,
          prepare: (destJobs) => {
            assertDestinationFree(destJobs, {
              name: job.name,
              slug,
              destScope,
              jobId,
            });
            reports = copyAssignmentArtifacts({
              sourceScope,
              destScope,
              jobId,
              slug,
              sourceHome: source.home,
              runIds,
              created,
            });
          },
        });
      } catch (err) {
        removeAll(created);
        throw err;
      }

      committed = { created };
      jobs.splice(idx, 1);
      return {
        id: jobId,
        name: job.name,
        slug,
        skill_path: skillPath,
        source_home: source.home,
        next_run_at: retargeted.state?.next_run_at || null,
        run_ids: runIds,
        reports,
      };
    });
  } catch (err) {
    if (!committed) throw err;
    throw await resolveCommittedFailure({
      destScope,
      sourceScope,
      owner,
      jobId,
      created: committed.created,
      cause: err,
    });
  }

  if (!sourceResult.ok) {
    if (committed) {
      throw await resolveCommittedFailure({
        destScope,
        sourceScope,
        owner,
        jobId,
        created: committed.created,
        cause: coded("scope_busy", "source catalog lease was lost"),
      });
    }
    throw coded(
      "scope_busy",
      `source scope is unavailable, try again: ${sourceScope.cwd}`,
      {
        scope_id: sourceScope.scope_id,
        reason: sourceResult.details?.reason || "lease_unavailable",
        retryable: true,
      },
    );
  }

  // The move is committed. What remains is repair work whose failure degrades
  // history rather than endangering it, so it is reported, not thrown.
  const moved = sourceResult.value;
  const slug = moved.slug;
  const ledger = moveLedgerRuns({ sourceScope, destScope, jobId });
  const leftovers = removeAll(
    assignmentArtifactPaths({
      scope: sourceScope,
      jobId,
      slug,
      sourceHome: moved.source_home,
      runIds: moved.run_ids,
    }),
  );
  const warnings = leftovers.map(
    (detail) => `source_cleanup_failed: ${detail} — safe to delete manually`,
  );
  if (!ledger.ok) {
    warnings.push(
      `ledger_rekey_failed: ${ledger.error} — handoff runs recorded before the move may not list in ${destScope.cwd}`,
    );
  }

  return {
    id: moved.id,
    name: moved.name,
    slug,
    from: { scope_id: sourceScope.scope_id, cwd: sourceScope.cwd },
    to: { scope_id: destScope.scope_id, cwd: destScope.cwd },
    skill_path: moved.skill_path,
    next_run_at: moved.next_run_at,
    moved: {
      run_count: moved.run_ids.length,
      run_reports: moved.reports,
      ledger_runs: ledger.moved,
    },
    warnings,
  };
}
