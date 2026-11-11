// Shared helpers for the held_release phase: process memory, logging, due/expiry rules, lease-safe patching, history events.
import { nextHeldRetry } from "./held_state.mjs";
import { mutateJobs, withCatalogLease } from "./scope_runtime.mjs";
import { statSync } from "node:fs";
import { jobsPath, loadJobsReadOnly } from "./store.mjs";

export const PROBE_EVERY_MS = 5 * 60_000;
export const STAGGER_MS = 60_000;

// Process-local: a daemon restart re-probes at most once and re-sweeps once (holds themselves are on disk).
export const memory = {
  swept: false,
  lastProbe: new Map(),
  permanent: new Set(),
  logged: new Map(),
  released: new Set(), // holdKey of holds this process released
  inflight: new Set(), // holdKey of releases whose completion has not settled (state model rule 4)
  loadFailed: new Map(), // scope_id -> the load error last logged (once per problem)
};
export function resetHeldReleaseMemory() {
  Object.assign(memory, { swept: false });
  memory.lastProbe.clear();
  memory.permanent.clear();
  memory.logged.clear();
  memory.released.clear();
  memory.inflight.clear();
  memory.loadFailed.clear();
}

// Logs a per-hold condition once, and again only when it changes (another reason, slot or attempt).
// Process memory is enough: held_release runs only in the resident daemon's tick (a restart repeats it once).
export function logOnce(log, { scope, job, event, status, reason }) {
  const held = job.state.held;
  const signature = `${event}:${reason}:${held.slot}:${held.attempts ?? 0}`;
  const key = `${scope.scope_id}:${job.id}`;
  if (memory.logged.get(key) === signature) return;
  memory.logged.set(key, signature);
  log(event, status, { job: job.id, reason, slot: held.slot });
}

// log(event, status, fields, error?)
export function defaultLog(event, status, ...details) {
  const [fields, error] = details;
  const line = { event, status, ...fields };
  if (error) line.error = { message: error.message, stack: error.stack };
  process.stderr.write(`[helm held] ${JSON.stringify(line)}\n`);
}

// Epoch ms on the repo clock, which honors HELM_NOW like the dispatch path.
export const heldNow = () =>
  process.env.HELM_NOW ? Date.parse(process.env.HELM_NOW) : Date.now();
export const iso = (ms) => new Date(ms).toISOString();
export const isDue = (held, now) =>
  Boolean(held.release_requested_by) || nextHeldRetry(held, now) <= now;
export const releaseBy = (held) =>
  ["command", "usage_check"].includes(held.release_requested_by)
    ? held.release_requested_by
    : "reset";

// New cron slot already due while held: the old hold must not also run. A once-job has no next slot.
export function isExpired(job, now) {
  const held = job.state.held;
  const next =
    job.schedule?.type === "once" ? NaN : Date.parse(job.state.next_run_at);
  return (
    now >= held.deadline ||
    (Number.isFinite(next) && next > held.slot && next <= now)
  );
}

// loadJobsReadOnly reads "no catalog" when existsSync fails for any reason; here only ENOENT is no catalog,
// any other stat error (EACCES on its directory, unmounted) is a load failure (fgp.53).
function readJobs(scope) {
  try {
    statSync(jobsPath(scope));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return loadJobsReadOnly(scope);
}

// A scope that cannot be read is skipped (logged once per problem, the daemon ticks every second); the caller
// treats the result as partial (a missing scope's holds are unknown, not gone: fgp.50).
export function loadHolds(scopes, log) {
  const loaded = [];
  for (const scope of scopes) {
    try {
      const jobs = readJobs(scope);
      loaded.push({ scope, jobs, holds: jobs.filter((j) => j.state?.held) });
      if (memory.loadFailed.delete(scope.scope_id))
        log("held_release.load_recovered", "info", {
          scope_id: scope.scope_id,
        });
    } catch (error) {
      const problem = error?.code ?? error?.message ?? String(error);
      if (memory.loadFailed.get(scope.scope_id) === problem) continue;
      memory.loadFailed.set(scope.scope_id, problem);
      log(
        "held_release.load_failed",
        "error",
        { scope_id: scope.scope_id },
        error,
      );
    }
  }
  return loaded;
}

// Re-reads each job under the catalog lease, so a patch never overwrites newer state (fresh baseline).
// Returns what apply() returned for each hold whose slot still matches.
export async function patchHolds(scope, owner, changes) {
  const applied = [];
  const result = await mutateJobs(scope, owner, (jobs) => {
    for (const { jobId, slot, apply } of changes) {
      const job = jobs.find((j) => j.id === jobId);
      if (job?.state?.held?.slot === slot)
        applied.push({ jobId, value: apply(job) });
    }
  });
  return result?.ok ? applied : [];
}

export const holdKey = (scope, job) => {
  const held = job.state.held;
  return `${scope.scope_id}:${job.id}:${held.slot}:${held.attempts ?? 0}`;
};

// A read under the catalog lease: no save. @returns the job's current hold, or null (gone, or the lease is busy: retry next tick).
export async function readHold(scope, owner, jobId) {
  const result = await withCatalogLease(
    scope,
    owner,
    () => loadJobsReadOnly(scope).find((j) => j.id === jobId)?.state?.held,
  );
  return (result.ok && result.value) || null;
}

export function historyEvent({ scope, jobId, kind, held }, extra) {
  return {
    id: `job_${jobId}_${kind}_${held.slot}_${held.attempts ?? 0}`,
    ts: iso(heldNow()),
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: jobId,
    run_id: held.run_id ?? null,
    kind,
    scheduled_at: iso(held.slot),
    ...extra,
  };
}
