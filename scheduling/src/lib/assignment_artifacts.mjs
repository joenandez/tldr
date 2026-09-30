// assignment_artifacts — the per-scope files an assignment owns, and how to
// relocate them.
//
// An assignment's data is spread across four places that are all keyed by the
// scope it lives in: the backing skill directory under the scope cwd, the run
// history JSONL, the run logs, the run-report sidecars, and the runtime-ledger
// rows for handoff runs. Anything that moves an assignment has to move all of
// them or the move silently drops history, so they are enumerated here once.
//
// Copies are additive and every created path is recorded, so a caller that
// fails afterwards can undo exactly what it created.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { helmHome, jobLogsDir } from "./store.mjs";
import { jobHistoryPath, loadJobHistory } from "./read_store.mjs";
import { runtimeStorePath } from "./runtime_store.mjs";
import { withRuntimeStoreTransactionRetry } from "./runtime_store_retry.mjs";

export const assignmentHome = (cwd, slug) =>
  join(cwd, ".helm", "assignments", slug);

// This was the assignment slug contract before Eventide inlined a lossy copy.
export function slugifyForAssignment(name) {
  if (typeof name !== "string" || name.length === 0) return "helm";
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "helm";
}

// Persisted paths may use a historical slug, but must name a local SKILL.md.
export function resolveAssignmentSkillSource({ scope, job }) {
  const root = resolve(scope.cwd, ".helm", "assignments");
  const assignment = job.metadata?.assignment;
  const hasPersisted = Object.prototype.hasOwnProperty.call(
    assignment || {},
    "skill_path",
  );
  const persisted = assignment?.skill_path;
  if (hasPersisted && (typeof persisted !== "string" || !persisted.trim())) {
    throw invalidAssignmentSkillSource();
  }
  const skillPath = hasPersisted
    ? resolve(persisted)
    : join(root, slugifyForAssignment(job.name), "SKILL.md");
  const pathFromRoot = relative(root, skillPath);
  const sourceHome = dirname(skillPath);
  const sourceFromRoot = relative(root, sourceHome);
  if (
    !pathFromRoot ||
    pathFromRoot.startsWith("..") ||
    isAbsolute(pathFromRoot) ||
    !sourceFromRoot ||
    sourceFromRoot.startsWith("..") ||
    isAbsolute(sourceFromRoot) ||
    basename(skillPath) !== "SKILL.md"
  ) {
    throw invalidAssignmentSkillSource();
  }
  if (!existsSync(skillPath) || !statSync(skillPath).isFile()) {
    throw Object.assign(new Error("assignment backing skill is unavailable"), {
      code: "assignment_skill_source_missing",
      exitCode: 1,
    });
  }
  const actualRoot = realpathSync(root);
  const actualSkillPath = realpathSync(skillPath);
  const actualSourceHome = dirname(actualSkillPath);
  const actualSourceFromRoot = relative(actualRoot, actualSourceHome);
  if (
    !actualSourceFromRoot ||
    actualSourceFromRoot.startsWith("..") ||
    isAbsolute(actualSourceFromRoot)
  ) {
    throw invalidAssignmentSkillSource();
  }
  return { home: actualSourceHome, skillPath: actualSkillPath };
}

function invalidAssignmentSkillSource() {
  return Object.assign(new Error("assignment backing skill path is invalid"), {
    code: "assignment_skill_source_invalid",
    exitCode: 1,
  });
}

// Mirrors the run-report sidecar layout owned by run_completion.mjs.
export const runReportPath = (cwd, runId) =>
  join(cwd, ".helm", "runs", "reports", `${runId}.json`);

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

export function runIdsFor(scope, jobId) {
  loadJobHistory(scope, jobId, 1); // materializes the history file if absent
  const path = jobHistoryPath(scope, jobId);
  if (!existsSync(path)) return [];
  const ids = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.run_id) ids.add(event.run_id);
    } catch {
      /* a malformed history line must not block the move */
    }
  }
  return [...ids];
}

// History events embed absolute log paths recorded at run time. The log files
// move with the assignment, so those pointers are repointed; `scope_id`/`cwd`
// are left alone because they record where the run actually happened.
function copyHistory({ sourceScope, destScope, jobId, created }) {
  const from = jobHistoryPath(sourceScope, jobId);
  const to = jobHistoryPath(destScope, jobId);
  if (!existsSync(from)) return;
  const fromLogs = jobLogsDir(sourceScope, jobId);
  const toLogs = jobLogsDir(destScope, jobId);
  const repoint = (paths) => {
    if (!paths || typeof paths !== "object") return paths;
    const next = { ...paths };
    for (const key of ["stdout", "stderr"]) {
      if (typeof next[key] === "string" && next[key].startsWith(fromLogs)) {
        next[key] = `${toLogs}${next[key].slice(fromLogs.length)}`;
      }
    }
    return next;
  };
  const lines = readFileSync(from, "utf8")
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const event = JSON.parse(line);
        if (event.log_paths) event.log_paths = repoint(event.log_paths);
        if (event.payload?.log_paths) {
          event.payload.log_paths = repoint(event.payload.log_paths);
        }
        return JSON.stringify(event);
      } catch {
        return line; // a malformed line moves verbatim rather than vanishing
      }
    });
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, lines.join("\n"), "utf8");
  created.push(to);
}

// Copies every per-scope artifact into the destination, appending each path it
// creates to `created` as it goes so even a partial copy can be undone.
export function copyAssignmentArtifacts({
  sourceScope,
  destScope,
  jobId,
  slug,
  sourceHome = assignmentHome(sourceScope.cwd, slug),
  runIds,
  created,
}) {
  const copyTree = (from, to) => {
    if (!existsSync(from)) return;
    cpSync(from, to, { recursive: true });
    created.push(to);
  };

  copyTree(sourceHome, assignmentHome(destScope.cwd, slug));
  copyHistory({ sourceScope, destScope, jobId, created });
  copyTree(jobLogsDir(sourceScope, jobId), jobLogsDir(destScope, jobId));
  let reports = 0;
  for (const runId of runIds) {
    const from = runReportPath(sourceScope.cwd, runId);
    if (!existsSync(from)) continue;
    const to = runReportPath(destScope.cwd, runId);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    created.push(to);
    reports += 1;
  }
  return reports;
}

// Every artifact path the source scope holds for this assignment, in delete
// order. Used to clear the source once the move is committed.
export function assignmentArtifactPaths({
  scope,
  jobId,
  slug,
  sourceHome = assignmentHome(scope.cwd, slug),
  runIds,
}) {
  return [
    sourceHome,
    jobHistoryPath(scope, jobId),
    jobLogsDir(scope, jobId),
    ...runIds.map((runId) => runReportPath(scope.cwd, runId)),
  ];
}

export function removeAll(paths) {
  const failed = [];
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      failed.push(`${path}: ${String(err.message || err)}`);
    }
  }
  return failed;
}

// A handoff run's terminal record lives only in the runtime ledger, keyed by
// scope, so those rows are re-keyed too or the destination would show such runs
// as started-but-never-finished. Runs in flight are refused before we get here.
export function moveLedgerRuns({ sourceScope, destScope, jobId }) {
  const home = helmHome();
  const path = runtimeStorePath(home);
  if (!existsSync(path)) return { ok: true, moved: 0 };
  const result = withRuntimeStoreTransactionRetry(
    { home, path },
    { context: { stage: "assignment_retarget_ledger", job_id: jobId } },
    (db) => ({
      moved: db
        .prepare(
          "UPDATE logical_runs SET scope_id = ?, updated_at = ? WHERE scope_id = ? AND job_id = ?",
        )
        .run(destScope.scope_id, nowIso(), sourceScope.scope_id, jobId).changes,
    }),
  );
  return result.ok
    ? { ok: true, moved: result.value.moved }
    : {
        ok: false,
        moved: 0,
        error: String(result.error?.message || "unknown"),
      };
}
