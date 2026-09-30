import { existsSync } from "node:fs";
import {
  ensureScopeRuntimeDirs,
  ensureWorkspaceConfigDir,
  jobsPath,
  loadRuntime,
  saveJobs,
} from "./store.mjs";
import {
  registerScope,
  unregisterScope,
  listRegisteredScopes,
} from "./scopes.mjs";
import { heartbeatStatus, removeHeartbeat } from "./heartbeat.mjs";
import { serviceInstall, serviceStart, serviceStatus } from "./service.mjs";
import { runtimeHealth } from "./runtime.mjs";
// R1 (Halcyon Phase-2 3.1): call deleteDueProjectionForScope directly on
// bringWorkspaceDown so orphan projection rows are removed eagerly even when
// bringWorkspaceDown is called without going through unregisterScope.
// unregisterScope already calls it (scopes.mjs:123) as defense-in-depth;
// this direct call covers any future teardown path that bypasses unregisterScope.
import { deleteDueProjectionForScope } from "./dispatch_due_projection_delete.mjs";

export function initWorkspace(scope) {
  ensureWorkspaceConfigDir(scope);
  // Only create jobs.json when it does not exist. Re-writing on every
  // ensureActivation() races concurrent helm-tasks calls: a sibling
  // process that loaded the pre-schedule snapshot can later save it
  // back over a freshly scheduled row, silently dropping new jobs.
  // mutateJobs (catalog.lock) handles all real persistence.
  if (!existsSync(jobsPath(scope))) {
    saveJobs(scope, []);
  }
  return {
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    storage_root: scope.storage_root,
  };
}

export function ensureWorkspaceRuntime(scope) {
  ensureScopeRuntimeDirs(scope);
  return {
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    storage_root: scope.storage_root,
  };
}

export function ensureWorkspaceUp(scope, schedulerScriptPath) {
  initWorkspace(scope);
  ensureWorkspaceRuntime(scope);
  const registered = registerScope(scope);
  let service = serviceStatus(schedulerScriptPath);
  if (!service.installed) service = serviceInstall(schedulerScriptPath);
  if (!service.running) service = serviceStart(schedulerScriptPath);
  const registryEntry =
    listRegisteredScopes().find((entry) => entry.scope_id === scope.scope_id) ||
    null;
  const runtime = loadRuntime(scope);
  const health = runtimeHealth(
    runtime,
    service,
    registered?.registered_at || registryEntry?.registered_at || null,
  );
  return { service, runtime, health };
}

export function bringWorkspaceDown(scope, schedulerScriptPath) {
  const unregistered = unregisterScope(scope);
  // R1: also delete projection rows directly in case bringWorkspaceDown is
  // ever called on a path that bypasses unregisterScope in the future.
  // unregisterScope already calls this (scopes.mjs:123); this is the second
  // call the plan.md §9 R1 note specifies as defense-in-depth.
  deleteDueProjectionForScope(scope.scope_id);
  const heartbeat = removeHeartbeat(scope);
  const service = serviceStatus(schedulerScriptPath);
  return { unregistered, heartbeat, service };
}

export function workspaceStatusSummary(scope, schedulerScriptPath, runtime) {
  const service = serviceStatus(schedulerScriptPath);
  const registryEntry =
    listRegisteredScopes().find((entry) => entry.scope_id === scope.scope_id) ||
    null;
  return {
    service,
    runtime,
    heartbeat: heartbeatStatus(scope),
    health: runtimeHealth(
      runtime,
      service,
      registryEntry?.registered_at || null,
    ),
  };
}
