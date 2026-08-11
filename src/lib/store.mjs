import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeJsonAtomic, appendJsonLine } from "./durable_file_io.mjs";

// Pure: derive a linked git-worktree's name (or null for the primary checkout
// or a non-repo). A linked worktree's git-dir lives under <main>/.git/worktrees/
// <name> while common-dir is the shared <main>/.git, so they differ; for the
// primary checkout they are the same path.
export function deriveWorktreeName({ gitDir, commonDir, toplevel } = {}) {
  if (!gitDir || !commonDir || !toplevel) return null;
  if (resolve(gitDir) === resolve(commonDir)) return null;
  const name = String(toplevel).split("/").filter(Boolean).pop();
  return name || null;
}

// tldr; never resolves state through ambient Helm configuration.
export function helmHomeFor({ tldrAgentHome, userHome = homedir() } = {}) {
  if (tldrAgentHome) return tldrAgentHome;
  return join(userHome, ".tldr-agent");
}

// Retained internals receive HELM_HOME only after Coffee has resolved its own root.
export function privateTldrAgentCompatibilityEnv(home = helmHome()) {
  return { TLDR_AGENT_HOME: home, HELM_HOME: home };
}

let _worktreeCache = { cwd: null, name: null };
// Detect the current linked-worktree name from the invocation cwd, cached per
// cwd (git subprocess, so we avoid re-running it on every helmHome() call).
// Safe fallback to null when git is unavailable or this is not a repo. Service
// mutation safety uses this identity independently from tldr; state roots.
export function worktreeName() {
  const cwd = process.cwd();
  if (_worktreeCache.cwd === cwd) return _worktreeCache.name;
  let name = null;
  try {
    const run = (args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    name = deriveWorktreeName({
      gitDir: resolve(cwd, run(["rev-parse", "--git-dir"])),
      commonDir: resolve(cwd, run(["rev-parse", "--git-common-dir"])),
      toplevel: run(["rev-parse", "--show-toplevel"]),
    });
  } catch {
    name = null;
  }
  _worktreeCache = { cwd, name };
  return name;
}

export function helmHome() {
  return helmHomeFor({
    tldrAgentHome: process.env.TLDR_AGENT_HOME,
  });
}

export function globalRuntimeRoot(home = helmHome()) {
  return home;
}

export function serviceRoot(home = helmHome()) {
  return join(globalRuntimeRoot(home), "service");
}

export function eventsRoot(home = helmHome()) {
  return join(globalRuntimeRoot(home), "events");
}

export function workspacesRoot(home = helmHome()) {
  return join(globalRuntimeRoot(home), "workspaces");
}

export function scopesRegistryPath() {
  return join(globalRuntimeRoot(), "scopes.json");
}

export function daemonHealthStatePath() {
  return join(serviceRoot(), "health-state.json");
}

export function secretsPath() {
  return join(globalRuntimeRoot(), "secrets.json");
}

export function resolveScope({ cwd = process.cwd() }) {
  if (typeof cwd !== "string") {
    throw new TypeError(
      `resolveScope: cwd must be a string, received ${typeof cwd} (${cwd}). Did you pass --cwd without a value?`,
    );
  }
  // Canonicalize via realpath so callers passing a symlink alias (e.g. `/var`
  // on macOS where `process.cwd()` returns `/private/var`) hash to the same
  // scope as ambient process.cwd(). Falls back to resolve() if the path
  // doesn't exist yet (e.g. init creating a fresh workspace).
  const projectRoot = canonicalizeCwd(cwd);
  const base = {
    cwd: projectRoot,
    scope_id: projectRoot,
  };
  return {
    ...base,
    storage_root: scopeRuntimeRoot(base),
    legacy_storage_root: join(projectRoot, ".helm"),
  };
}

export const TLDR_AGENT_SCOPE_ID = "tldr-agent";

// Coffee's public runtime has one installation-global canonical namespace.
// Keep cwd on the scope for exact resume, but never derive persistence or
// legacy-import paths from that cwd.
export function resolveTldrAgentScope({
  cwd = process.cwd(),
  tldrAgentHome = helmHome(),
} = {}) {
  if (typeof cwd !== "string") {
    throw new TypeError(
      `resolveTldrAgentScope: cwd must be a string, received ${typeof cwd}`,
    );
  }
  const root = resolve(tldrAgentHome);
  return {
    cwd: canonicalizeCwd(cwd),
    scope_id: TLDR_AGENT_SCOPE_ID,
    storage_root: root,
    legacy_storage_root: join(root, "legacy"),
  };
}

function canonicalizeCwd(cwd) {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function scopeHash(scopeOrId) {
  const id = typeof scopeOrId === "string" ? scopeOrId : scopeOrId.scope_id;
  return createHash("sha1").update(String(id)).digest("hex");
}

export function scopeRuntimeRoot(scope) {
  return join(workspacesRoot(), scopeHash(scope));
}

export function scopeMetaPath(scope) {
  return join(scopeRuntimeRoot(scope), "scope.json");
}

export function jobsPath(scope) {
  return join(scope.storage_root, "jobs.json");
}

export function dispatchIndexPath(scope) {
  return join(scope.storage_root, "jobs.dispatch-index.json");
}

export function runtimePath(scope) {
  return join(scopeRuntimeRoot(scope), "runtime.json");
}

export function activeRunsPath(scope) {
  return join(scopeRuntimeRoot(scope), "active-runs.json");
}

export function reaperStatePath(scope) {
  return join(scopeRuntimeRoot(scope), "reaper-state.json");
}

export function heartbeatMetaPath(scope) {
  return join(scopeRuntimeRoot(scope), "heartbeat.json");
}

export function locksDir(scope) {
  return join(scopeRuntimeRoot(scope), "locks");
}

export function logsDir(scope) {
  return join(scopeRuntimeRoot(scope), "logs");
}

export function jobLogsDir(scope, jobId) {
  return join(logsDir(scope), String(jobId));
}

export function runLogPaths(scope, jobId, runId) {
  const base = join(jobLogsDir(scope, jobId), String(runId));
  return {
    stdout: `${base}.stdout.log`,
    stderr: `${base}.stderr.log`,
  };
}

export function canonicalEventsPathFor(ts = Date.now(), home = helmHome()) {
  const day = new Date(ts).toISOString().slice(0, 10);
  return join(eventsRoot(home), `${day}.jsonl`);
}

export function ensureGlobalRuntimeDirs(home = helmHome()) {
  // prettier-ignore
  for (const path of [globalRuntimeRoot(home), "messages", "sessions", "logs", "run"].map((name) => name.startsWith("/") ? name : join(globalRuntimeRoot(home), name))) mkdirSync(path, { recursive: true, mode: 0o700 });
  mkdirSync(serviceRoot(home), { recursive: true });
  mkdirSync(eventsRoot(home), { recursive: true });
  mkdirSync(workspacesRoot(home), { recursive: true });
}

export function ensureWorkspaceConfigDir(scope) {
  mkdirSync(scope.storage_root, { recursive: true });
}

export function legacyWorkspaceStorageRoot(scope) {
  const cwd = typeof scope === "string" ? scope : scope?.cwd;
  if (!cwd) return null;
  return join(resolve(cwd), ".helm");
}

export function saveScopeMeta(scope) {
  ensureGlobalRuntimeDirs();
  mkdirSync(scopeRuntimeRoot(scope), { recursive: true });
  const path = scopeMetaPath(scope);
  writeJsonAtomic(path, {
    version: "1.0",
    scope_id: scope.scope_id,
    scope_hash: scopeHash(scope),
    cwd: scope.cwd,
    storage_root: scope.storage_root,
    updated_at: new Date().toISOString(),
  });
}

export function ensureScopeRuntimeDirs(scope) {
  ensureGlobalRuntimeDirs();
  mkdirSync(scopeRuntimeRoot(scope), { recursive: true });
  mkdirSync(locksDir(scope), { recursive: true });
  mkdirSync(logsDir(scope), { recursive: true });
  saveScopeMeta(scope);
}

export function ensureSchedulerDirs(scope) {
  ensureWorkspaceConfigDir(scope);
  ensureScopeRuntimeDirs(scope);
}

export function readJsonIfExists(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export { writeJsonAtomic, appendJsonLine };

export function loadJobs(scope) {
  ensureWorkspaceConfigDir(scope);
  return loadJobsReadOnly(scope);
}

export function loadJobsReadOnly(scope) {
  if (!existsSync(jobsPath(scope))) return [];
  const parsed = JSON.parse(readFileSync(jobsPath(scope), "utf8"));
  if (!parsed || !Array.isArray(parsed.jobs)) return [];
  return parsed.jobs;
}

function compactDispatchJob(job) {
  return {
    id: job?.id,
    state: {
      enabled: job?.state?.enabled,
      next_run_at: job?.state?.next_run_at,
      infrastructure_deferred_slot: job?.state?.infrastructure_deferred_slot,
      infrastructure_deferred_reason:
        job?.state?.infrastructure_deferred_reason,
    },
    meta: {
      updated_at: job?.meta?.updated_at,
    },
  };
}

export function compactDispatchIndexForJobs(jobs) {
  return {
    version: "1.0",
    source: "jobs.json",
    jobs: Array.isArray(jobs) ? jobs.map(compactDispatchJob) : [],
  };
}

function jobsSourceStat(scope) {
  try {
    const source = statSync(jobsPath(scope));
    return {
      source_mtime_ms: source.mtimeMs,
      source_size_bytes: source.size,
    };
  } catch {
    return {
      source_mtime_ms: null,
      source_size_bytes: null,
    };
  }
}

export function saveDispatchIndex(scope, jobs) {
  writeJsonAtomic(dispatchIndexPath(scope), {
    ...compactDispatchIndexForJobs(jobs),
    ...jobsSourceStat(scope),
  });
}

export function loadDispatchIndexReadOnly(scope) {
  if (!existsSync(dispatchIndexPath(scope))) {
    return {
      ok: false,
      reason: "missing_dispatch_index",
      jobs: null,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(dispatchIndexPath(scope), "utf8"));
    if (!parsed || !Array.isArray(parsed.jobs)) {
      return {
        ok: false,
        reason: "invalid_dispatch_index",
        jobs: null,
      };
    }
    const source = jobsSourceStat(scope);
    if (
      parsed.source_mtime_ms !== null &&
      parsed.source_mtime_ms !== undefined &&
      source.source_mtime_ms !== null &&
      parsed.source_mtime_ms !== source.source_mtime_ms
    ) {
      return {
        ok: false,
        reason: "stale_dispatch_index",
        jobs: null,
      };
    }
    if (
      parsed.source_size_bytes !== null &&
      parsed.source_size_bytes !== undefined &&
      source.source_size_bytes !== null &&
      parsed.source_size_bytes !== source.source_size_bytes
    ) {
      return {
        ok: false,
        reason: "stale_dispatch_index",
        jobs: null,
      };
    }
    return {
      ok: true,
      reason: "dispatch_index",
      jobs: parsed.jobs,
    };
  } catch {
    return {
      ok: false,
      reason: "invalid_dispatch_index",
      jobs: null,
    };
  }
}

export function loadDispatchJobsReadOnly(scope) {
  const indexed = loadDispatchIndexReadOnly(scope);
  if (indexed.ok) {
    return {
      jobs: indexed.jobs,
      dispatchIndexStatus: "hit",
      dispatchIndexReason: indexed.reason,
    };
  }
  const jobs = loadJobsReadOnly(scope);
  try {
    saveDispatchIndex(scope, jobs);
  } catch {
    // Rebuildable advisory index; the full catalog read remains authoritative.
  }
  return {
    jobs,
    dispatchIndexStatus: "fallback_full_jobs",
    dispatchIndexReason: indexed.reason,
  };
}

export function saveJobs(scope, jobs, { durable = false } = {}) {
  ensureWorkspaceConfigDir(scope);
  writeJsonAtomic(jobsPath(scope), { version: "1.0", jobs }, { durable });
  saveDispatchIndex(scope, jobs);
}

export function loadRuntime(scope) {
  return readJsonIfExists(runtimePath(scope), null);
}

export function saveRuntime(scope, runtime) {
  ensureScopeRuntimeDirs(scope);
  writeJsonAtomic(runtimePath(scope), runtime);
}

export function loadActiveRuns(scope) {
  ensureScopeRuntimeDirs(scope);
  return loadActiveRunsReadOnly(scope);
}

// Opportunity #9: trusted variant for the reaper. A transient unreadable /
// corrupt active-runs.json must be distinguishable from a genuinely empty
// one — treating it as empty evicted every hang sample and restarted every
// hang timer. Missing file = trusted empty; unparseable = untrusted.
export function loadActiveRunsTrusted(scope) {
  const path = activeRunsPath(scope);
  if (!existsSync(path)) {
    return { version: "1.0", runs: {}, trusted: true };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.runs !== "object" ||
    Array.isArray(parsed.runs)
  ) {
    return { version: "1.0", runs: {}, trusted: false };
  }
  return { version: parsed.version || "1.0", runs: parsed.runs, trusted: true };
}

// Opportunity #9: per-run heartbeat file. The dispatcher exposes this path
// to the child as HELM_RUN_HEARTBEAT_PATH; any process that touches it is
// treated as alive by the reaper even when CPU and log signals are flat
// (e.g. an agent blocked on a long model call).
export function runHeartbeatPath(scope, runId) {
  return join(scopeRuntimeRoot(scope), "heartbeats", `${runId}.heartbeat`);
}

export function loadActiveRunsReadOnly(scope) {
  const path = activeRunsPath(scope);
  const parsed = readJsonIfExists(path, {
    version: "1.0",
    runs: {},
  });
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.runs !== "object" ||
    Array.isArray(parsed.runs)
  ) {
    return { version: "1.0", runs: {} };
  }
  return { version: parsed.version || "1.0", runs: parsed.runs };
}

export function saveActiveRuns(scope, runs) {
  ensureScopeRuntimeDirs(scope);
  writeJsonAtomic(activeRunsPath(scope), { version: "1.0", runs });
}

export function setActiveRun(scope, jobId, entry) {
  const current = loadActiveRuns(scope);
  current.runs[jobId] = entry;
  saveActiveRuns(scope, current.runs);
}

export function clearActiveRun(scope, jobId) {
  const current = loadActiveRuns(scope);
  delete current.runs[jobId];
  saveActiveRuns(scope, current.runs);
}

export function loadReaperState(scope) {
  const parsed = readJsonIfExists(reaperStatePath(scope), {
    version: "1.0",
    samples: {},
  });
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.samples !== "object" ||
    Array.isArray(parsed.samples)
  ) {
    return { version: "1.0", samples: {} };
  }
  return { version: parsed.version || "1.0", samples: parsed.samples };
}

export function saveReaperState(scope, samples) {
  ensureScopeRuntimeDirs(scope);
  writeJsonAtomic(reaperStatePath(scope), { version: "1.0", samples });
}

export function loadHeartbeatMeta(scope) {
  return readJsonIfExists(heartbeatMetaPath(scope), null);
}

export function saveHeartbeatMeta(scope, meta) {
  ensureScopeRuntimeDirs(scope);
  writeJsonAtomic(heartbeatMetaPath(scope), meta);
}

export function loadScopesRegistry() {
  ensureGlobalRuntimeDirs();
  const parsed = readJsonIfExists(scopesRegistryPath(), {
    version: "1.0",
    scopes: [],
  });
  if (!parsed || !Array.isArray(parsed.scopes))
    return { version: "1.0", scopes: [] };
  return parsed;
}

export function saveScopesRegistry(scopes) {
  ensureGlobalRuntimeDirs();
  writeJsonAtomic(scopesRegistryPath(), { version: "1.0", scopes });
}

export function pruneOldData(retainDays, dryRun = false) {
  const cutoff = new Date(Date.now() - retainDays * 86400000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  let eventsDeleted = 0;
  let logFilesDeleted = 0;
  let bytesFreed = 0;

  const evDir = eventsRoot();
  if (existsSync(evDir)) {
    for (const file of readdirSync(evDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const fileDate = file.replace(".jsonl", "");
      if (fileDate < cutoffDate) {
        const fullPath = join(evDir, file);
        try {
          const stat = statSync(fullPath);
          bytesFreed += stat.size;
          if (!dryRun) unlinkSync(fullPath);
          eventsDeleted++;
        } catch {
          /* file may have been removed concurrently */
        }
      }
    }
  }

  const wsRoot = workspacesRoot();
  if (existsSync(wsRoot)) {
    for (const wsHash of readdirSync(wsRoot)) {
      const logsBase = join(wsRoot, wsHash, "logs");
      if (!existsSync(logsBase)) continue;
      for (const jobDir of readdirSync(logsBase)) {
        const jobLogsPath = join(logsBase, jobDir);
        try {
          for (const runFile of readdirSync(jobLogsPath)) {
            const fullPath = join(jobLogsPath, runFile);
            try {
              const stat = statSync(fullPath);
              if (stat.mtime < cutoff) {
                bytesFreed += stat.size;
                if (!dryRun) unlinkSync(fullPath);
                logFilesDeleted++;
              }
            } catch {
              /* skip inaccessible files */
            }
          }
        } catch {
          /* skip inaccessible dirs */
        }
      }
    }
  }

  return {
    events_deleted: eventsDeleted,
    log_files_deleted: logFilesDeleted,
    bytes_freed: bytesFreed,
  };
}
