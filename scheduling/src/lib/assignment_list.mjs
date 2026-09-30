// assignment_list — assignment list projections, scope-local and global.
//
// Every other assignment verb answers for exactly one scope resolved from
// --cwd. A caller that wants "all my assignments" would otherwise have to read
// the scope registry itself and fan out, coupling it to a file Helm does not
// publish. The global read below does that fan-out inside Helm, over the
// registry Helm already owns.
//
// It fails closed: if any registered scope's catalog cannot be read under a
// version this build implements, the whole call is an error naming that scope.
// Returning the scopes that happened to parse would present a partial list as a
// complete one, which is the failure mode a consumer cannot detect.

import { existsSync, readFileSync } from "node:fs";
import { jobsPath, resolveScope } from "./store.mjs";
import { listRegisteredScopes } from "./scopes.mjs";
import { isTerminalWorkStatus, summarizeJobRuns } from "./run_completion.mjs";
import { effectiveCompletionDelivery } from "./assignment_completion_delivery.mjs";

// Catalog shapes this build knows how to read.
export const SUPPORTED_CATALOG_VERSIONS = Object.freeze(["1.0"]);

const isAssignment = (job) =>
  Array.isArray(job.tags) && job.tags.includes("assignment");

// Byte-wise, so ordering never depends on the caller's locale.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function renderSchedule(sched) {
  if (!sched) return "unscheduled";
  if (sched.type === "recurring") return sched.cron || "recurring";
  if (sched.type === "interval") return `every ${sched.every}`;
  if (sched.type === "once")
    return sched.start_at ? `once at ${sched.start_at}` : "once";
  return sched.type || "unscheduled";
}

// Default hides archived; an explicit --status widens or narrows.
export function filterAssignmentsByStatus(jobs, status = "") {
  const statusOf = (job) => job.metadata?.assignment?.status || "active";
  if (status === "all") return jobs;
  if (status === "archived" || status === "active" || status === "disabled") {
    return jobs.filter((job) => statusOf(job) === status);
  }
  return jobs.filter((job) => statusOf(job) !== "archived");
}

// Reads one scope's catalog strictly: unlike the dispatch read path, a catalog
// that is unparseable or versioned beyond this build is an error, not an empty
// list, because "no assignments" and "cannot tell" must not look alike.
export function readScopeCatalog(scope) {
  const path = jobsPath(scope);
  if (!existsSync(path)) return { ok: true, jobs: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      ok: false,
      code: "catalog_unreadable",
      detail: `${path}: ${String(err.message || err)}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "catalog_unreadable",
      detail: `${path}: not a catalog object`,
    };
  }
  const version = String(parsed.version ?? "1.0");
  if (!SUPPORTED_CATALOG_VERSIONS.includes(version)) {
    return {
      ok: false,
      code: "catalog_version_unsupported",
      detail: `${path}: catalog version ${version} is not supported by this build (supported: ${SUPPORTED_CATALOG_VERSIONS.join(", ")})`,
    };
  }
  if (!Array.isArray(parsed.jobs)) {
    return {
      ok: false,
      code: "catalog_unreadable",
      detail: `${path}: catalog has no jobs array`,
    };
  }
  return { ok: true, jobs: parsed.jobs };
}

// Catalog-record accessors, shared with the per-assignment read so the two can
// never publish different values for the same job. All three read the catalog
// record only — none of them opens run history, so they cost nothing beyond the
// catalog read every list already performs.
//
// `last_run_at` is null when the job has never run. It stays null: substituting
// the creation time, the next run time or an epoch would present a job that has
// never run as one that has, and nothing downstream could tell the difference.
export const assignmentLastRunAt = (job) => job.state?.last_run_at || null;
export const assignmentCreatedAt = (job) => job.meta?.created_at || null;
export const assignmentProvider = (job) =>
  job.execution_hints?.provider || null;

// The rest of what the provider needs to run — which agent an Academy job
// executes, which runtime it runs under. Published without `runtime_options`,
// which has its own published field: one fact, one name. Null when the job
// carries no provider configuration at all.
export function assignmentProviderConfig(job) {
  const config = job.execution_hints?.provider_config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const published = {};
  for (const [key, value] of Object.entries(config)) {
    if (key !== "runtime_options") published[key] = value;
  }
  return Object.keys(published).length > 0 ? published : null;
}

export const assignmentDescription = (job) =>
  job.metadata?.assignment?.description ?? job.description ?? "";

// The description is what an assignment is *for*, and it is the one field a
// consumer searching this list has no other way to read. It is published from
// the catalog record — never from the backing skill file, which a list read has
// no business opening once per assignment.
//
// It is bounded because a list read must stay a list read: descriptions are
// authored free text with no length limit, and one long body must not decide
// how big every consumer's global read is. 500 characters holds the
// paragraph-length descriptions this field is written for while capping a
// thousand-assignment read at well under a megabyte. Truncation is disclosed,
// so a consumer knows its match was searched against a bounded string rather
// than silently missing text it was never sent.
export const DESCRIPTION_MAX_CHARS = 500;

function boundedDescription(job) {
  const full = String(assignmentDescription(job) ?? "");
  const characters = [...full];
  if (characters.length <= DESCRIPTION_MAX_CHARS) {
    return { description: full, description_truncated: false };
  }
  return {
    description: characters.slice(0, DESCRIPTION_MAX_CHARS).join(""),
    description_truncated: true,
  };
}

// Scope-local row shape. `last_status` predates the work/dispatch split and
// still carries the dispatch status.
export function localAssignmentRow(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.metadata?.assignment?.status || "active",
    completion_delivery: effectiveCompletionDelivery(job.metadata?.assignment),
    schedule: renderSchedule(job.schedule),
    next_run_at: job.state?.next_run_at || null,
    last_status: job.state?.last_status || null,
  };
}

// Global row: same facts plus the owning scope, with the dispatch status named
// for what it is so a cross-scope reader cannot mistake it for a work outcome.
//
// `last_run_at`, `created_at` and `provider` come from the same record: a
// cross-scope reader that wants them otherwise has to call the per-assignment
// read once per assignment, and one that cannot has only publication order to
// stand in for recency, which it is not.
function globalAssignmentRow(job, scope) {
  return {
    id: job.id,
    name: job.name,
    ...boundedDescription(job),
    status: job.metadata?.assignment?.status || "active",
    completion_delivery: effectiveCompletionDelivery(job.metadata?.assignment),
    schedule: renderSchedule(job.schedule),
    next_run_at: job.state?.next_run_at || null,
    last_run_at: assignmentLastRunAt(job),
    created_at: assignmentCreatedAt(job),
    provider: assignmentProvider(job),
    last_dispatch_status: job.state?.last_status || null,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
  };
}

// Terminal runs for one assignment, read through the same completion projection
// `runs <id>` publishes, so the two reads can never disagree about which runs
// are finished. Bounded by that projection's own history window — no tighter,
// so a caller reading the global list sees exactly the runs the per-assignment
// read would have shown it.
//
// Each entry carries the work outcome beside the id. Helm publishes which runs
// finished and how; which of those outcomes a given consumer acts on is the
// consumer's rule to apply, and it must not need a second call to apply it.
//
// A history that cannot be read is reported, never flattened to an empty list:
// "no terminal runs" and "cannot tell" must not look alike, the same rule the
// catalog read follows above.
function terminalRuns(scope, job) {
  try {
    return {
      ok: true,
      runs: summarizeJobRuns({ scope, jobId: job.id, job })
        .filter((run) => isTerminalWorkStatus(run.work_status))
        .map((run) => ({
          run_id: run.run_id,
          work_status: run.work_status,
          source_scope_id: run.source_scope_id,
          source_cwd: run.source_cwd,
        })),
    };
  } catch (err) {
    return {
      ok: false,
      code:
        err.code === "run_source_conflict"
          ? err.code
          : "run_history_unreadable",
      detail: `${job.id}: run history could not be read: ${String(err.message || err)}`,
    };
  }
}

// Rows for one scope. Returns the scope's first run-history failure instead of
// rows, so one unreadable assignment fails its scope rather than under-reporting.
function rowsForScope(scope, assignments, withTerminalRuns) {
  const rows = [];
  for (const job of assignments) {
    const row = globalAssignmentRow(job, scope);
    if (withTerminalRuns) {
      const found = terminalRuns(scope, job);
      if (!found.ok) return found;
      row.terminal_runs = found.runs;
    }
    rows.push(row);
  }
  return { ok: true, rows };
}

function runsForScope(scope, assignments) {
  const runs = [];
  for (const job of assignments) {
    let summarized;
    try {
      summarized = summarizeJobRuns({ scope, jobId: job.id, job });
    } catch (err) {
      return {
        ok: false,
        code:
          err.code === "run_source_conflict"
            ? err.code
            : "run_history_unreadable",
        detail: `${job.id}: run history could not be read: ${String(err.message || err)}`,
      };
    }
    runs.push(
      ...summarized.map((run) => ({
        ...run,
        assignment_name: job.name,
        source_scope_id: scope.scope_id,
        source_cwd: scope.cwd,
      })),
    );
  }
  return { ok: true, runs };
}

function scopeResolveFailure(entry, err) {
  const scopeId = String(entry?.scope_id ?? entry?.cwd ?? "unknown-scope");
  const cwd = entry?.cwd ?? entry?.scope_id ?? null;
  return {
    scope_id: scopeId,
    cwd,
    code: "scope_resolve_failed",
    detail: `${scopeId} (${String(cwd)}): ${String(err.message || err)}`,
  };
}

// One call over every registered scope. Ordering is ascending by scope_id, then
// name, then id — stable across runs and independent of catalog write order.
//
// `withTerminalRuns` is opt-in: reading every assignment's run history costs
// more than reading catalogs, and it introduces a failure mode (readable
// catalog, unreadable history) that callers who only want the catalog should
// never inherit.
export function listAssignmentsAcrossScopes({
  status = "",
  withTerminalRuns = false,
} = {}) {
  const registered = listRegisteredScopes();
  const seen = new Set();
  const failures = [];
  const rows = [];
  const scopes = [];

  for (const entry of registered) {
    let scope;
    try {
      scope = resolveScope({ cwd: entry.cwd || entry.scope_id });
    } catch (err) {
      failures.push(scopeResolveFailure(entry, err));
      continue;
    }
    if (seen.has(scope.scope_id)) continue;
    seen.add(scope.scope_id);

    const catalog = readScopeCatalog(scope);
    if (!catalog.ok) {
      failures.push({
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        code: catalog.code,
        detail: catalog.detail,
      });
      continue;
    }
    const assignments = filterAssignmentsByStatus(
      catalog.jobs.filter(isAssignment),
      status,
    );
    if (assignments.length === 0) continue;

    const built = rowsForScope(scope, assignments, withTerminalRuns);
    if (!built.ok) {
      failures.push({
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        code: built.code,
        detail: built.detail,
      });
      continue;
    }
    scopes.push({
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      assignment_count: assignments.length,
    });
    rows.push(...built.rows);
  }

  if (failures.length > 0) {
    failures.sort((a, b) => cmp(a.scope_id, b.scope_id));
    return { ok: false, failures, scanned_scopes: seen.size };
  }
  rows.sort(
    (a, b) =>
      cmp(a.scope_id, b.scope_id) || cmp(a.name, b.name) || cmp(a.id, b.id),
  );
  scopes.sort((a, b) => cmp(a.scope_id, b.scope_id));
  return { ok: true, assignments: rows, scopes, scanned_scopes: seen.size };
}

// One call over every registered scope's complete assignment histories. Unlike
// the global list's optional terminal projection, this is deliberately a
// runs-first read: launched and running work stays visible to the inbox.
export function summarizeAssignmentRunsAcrossScopes() {
  const registered = listRegisteredScopes();
  const seen = new Set();
  const failures = [];
  const runs = [];
  const scopes = [];

  for (const entry of registered) {
    let scope;
    try {
      scope = resolveScope({ cwd: entry.cwd || entry.scope_id });
    } catch (err) {
      failures.push(scopeResolveFailure(entry, err));
      continue;
    }
    if (seen.has(scope.scope_id)) continue;
    seen.add(scope.scope_id);

    const catalog = readScopeCatalog(scope);
    if (!catalog.ok) {
      failures.push({
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        code: catalog.code,
        detail: catalog.detail,
      });
      continue;
    }
    const assignments = catalog.jobs.filter(isAssignment);
    if (assignments.length === 0) continue;

    const built = runsForScope(scope, assignments);
    if (!built.ok) {
      failures.push({
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        code: built.code,
        detail: built.detail,
      });
      continue;
    }
    scopes.push({
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      assignment_count: assignments.length,
    });
    runs.push(...built.runs);
  }

  if (failures.length > 0) {
    failures.sort((a, b) => cmp(a.scope_id, b.scope_id));
    return { ok: false, failures, scanned_scopes: seen.size };
  }
  runs.sort(
    (a, b) =>
      cmp(a.source_scope_id, b.source_scope_id) ||
      cmp(a.started_at || "", b.started_at || "") ||
      cmp(a.job_id, b.job_id) ||
      cmp(a.run_id, b.run_id),
  );
  scopes.sort((a, b) => cmp(a.scope_id, b.scope_id));
  return { ok: true, runs, scopes, scanned_scopes: seen.size };
}
