import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helmHome } from "./store.mjs";

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

let dispatchDueQueryModulePromise = null;
let scopeRegistryV2ModulePromise = null;

export function loadDispatchDueQueryModule() {
  dispatchDueQueryModulePromise ??= import("./dispatch_due_query.mjs");
  return dispatchDueQueryModulePromise;
}

export function loadScopeRegistryV2Module() {
  scopeRegistryV2ModulePromise ??= import("./scope_registry_v2.mjs");
  return scopeRegistryV2ModulePromise;
}

export function isGlobalDueAdmissionEnabledForDaemon() {
  return process.env.HELM_DISPATCH_DUE_QUERY_KILL_SWITCH !== "1";
}

function retentionStatePathForDaemon() {
  return join(helmHome(), "service", "retention-state.json");
}

export function shouldRunRetentionForDaemon({
  now = Date.now(),
  intervalMs = RETENTION_INTERVAL_MS,
} = {}) {
  let state = null;
  try {
    state = JSON.parse(readFileSync(retentionStatePathForDaemon(), "utf8"));
  } catch {
    state = null;
  }
  const lastMs = state?.last_run_at ? Date.parse(state.last_run_at) : NaN;
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= intervalMs;
}
