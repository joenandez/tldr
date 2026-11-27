import { execFileSync } from "node:child_process";
import { loadActiveRunsReadOnly, resolveScope } from "./store.mjs";
import { listRegisteredScopes } from "./scopes.mjs";
import { isProcessAlive, processStartEvidence } from "./process_liveness.mjs";

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
    } else if (survivesServiceRestart(run)) {
      ignoredActiveRuns.push({ ...run, ignore_reason: "own_process_group" });
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
        pid_start_time: entry?.pid_start_time || null,
        started_at: entry?.started_at || null,
      });
    }
  }
  return active.sort((a, b) =>
    `${a.scope_id}\0${a.job_id}`.localeCompare(`${b.scope_id}\0${b.job_id}`),
  );
}

// launchd's kickstart -k and bootout signal only the job's own process group,
// and Helm spawns every run detached (its own group), so the run itself
// outlives a restart (ac-4ow1m; probe: k1k work/ac-4ow1m/probe). What a
// restart does kill is the run's launcher, which may still hold its output
// pipes, its startup observer, or its timeout_sec timer. So a run is safe only
// once its launcher is gone (parent is launchd, ppid 1): the next daemon's
// reaper then finalizes it from the run's own exit record, as after any
// handoff. Fail closed on anything unproven: the recorded pid must still have
// the start time captured at spawn. systemd's default KillMode=control-group
// kills the whole cgroup, so this holds on macOS only.
function survivesServiceRestart(run) {
  if (process.platform !== "darwin" || !run.pid_start_time) return false;
  if (processStartEvidence(run.pid).start_time !== run.pid_start_time) {
    return false;
  }
  const { pgid, ppid } = processGroupAndParent(run.pid);
  return pgid === run.pid && ppid === 1;
}

function processGroupAndParent(pid) {
  try {
    const [pgid, ppid] = execFileSync(
      "ps",
      ["-o", "pgid=,ppid=", "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split(/\s+/u)
      .map(Number);
    return { pgid, ppid };
  } catch {
    return {};
  }
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
