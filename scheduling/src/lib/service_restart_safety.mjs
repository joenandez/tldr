import { execFileSync } from "node:child_process";
import { loadActiveRunsReadOnly, resolveScope } from "./store.mjs";
import { listRegisteredScopes } from "./scopes.mjs";
import { isProcessAlive } from "./process_liveness.mjs";

export function serviceRestartSafetyReport(currentScope) {
  const scopesById = new Map();
  const addScope = (candidate) => {
    const cwd = candidate?.cwd || candidate?.scope_id;
    if (!cwd) return;
    try {
      const scope = resolveScope({ cwd });
      scopesById.set(scope.scope_id, scope);
    } catch {
      // Ignore malformed legacy scope rows. The current scope is still checked.
    }
  };

  addScope(currentScope);
  try {
    for (const registered of listRegisteredScopes()) addScope(registered);
  } catch {
    // A corrupt registry should not make service restart impossible.
  }

  const runs = liveActiveRuns([...scopesById.values()]);
  const callerPid = process.pid;
  const activeRuns = [];
  const ignoredActiveRuns = [];
  for (const run of runs) {
    if (isAncestorProcess(run.pid, callerPid)) {
      ignoredActiveRuns.push({ ...run, ignore_reason: "caller_ancestor" });
    } else {
      activeRuns.push(run);
    }
  }

  return {
    active_runs: activeRuns,
    ignored_active_runs: ignoredActiveRuns,
  };
}

function liveActiveRuns(scopes) {
  const active = [];
  for (const scope of scopes) {
    const activeRuns = loadActiveRunsReadOnly(scope).runs || {};
    for (const [jobId, entry] of Object.entries(activeRuns)) {
      if (!isProcessAlive(entry?.pid)) continue;
      active.push({
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: jobId,
        run_id: entry?.run_id || null,
        pid: Number(entry.pid),
      });
    }
  }
  return active.sort((a, b) =>
    `${a.scope_id}\0${a.job_id}`.localeCompare(`${b.scope_id}\0${b.job_id}`),
  );
}

function parentPid(pid) {
  try {
    const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Number(output);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function isAncestorProcess(candidatePid, callerPid) {
  const candidate = Number(candidatePid);
  let current = Number(callerPid);
  if (!Number.isFinite(candidate) || candidate <= 0) return false;
  if (!Number.isFinite(current) || current <= 0) return false;
  for (let depth = 0; depth < 64 && current > 0; depth += 1) {
    if (current === candidate) return true;
    const next = parentPid(current);
    if (!next || next === current) return false;
    current = next;
  }
  return false;
}
