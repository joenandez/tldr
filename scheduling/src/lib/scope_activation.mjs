// scope_activation — shared "make this scope actually dispatch" helpers.
//
// A stored job only fires when its scope is registered in the dispatch
// rotation AND the supervised service is running and healthy. Both steps live
// here so every CLI noun performs them the same way instead of re-deriving the
// preconditions (and silently storing jobs that can never run).

import { fileURLToPath } from "node:url";
import { runActivation } from "./activation_service.mjs";
import { ensureWorkspaceRuntime } from "./workspace_service.mjs";
import { registerScope } from "./scopes.mjs";

// The supervised service is always the scheduler entrypoint, whichever CLI
// noun asked for activation.
export function schedulerEntrypoint() {
  return fileURLToPath(new URL("../helm-tasks.mjs", import.meta.url));
}

export function activationRepairCommands(scope) {
  const script = schedulerEntrypoint();
  const target = `--cwd ${scope.cwd}`;
  return {
    service_status: `node ${script} service status --deep ${target}`,
    ensure: `node ${script} ensure ${target}`,
    restart: `node ${script} service restart`,
  };
}

// Register the scope without touching the service. Cheap enough to run on
// every create so a stored job is never stranded in an unregistered scope.
export function registerScopeForDispatch(scope) {
  ensureWorkspaceRuntime(scope);
  return registerScope(scope);
}

// Full activation: refuse to start when the operator disabled the runtime,
// then register the scope and ensure the supervised service is up.
export async function ensureScopeActivation(scope) {
  const { assertDesiredStateAllowsStart, assertHelmHomeSafe } = await import(
    "./runtime_store.mjs"
  );
  assertDesiredStateAllowsStart({ initialize: false });
  assertHelmHomeSafe();
  return runActivation(scope, {
    schedulerScriptPath: schedulerEntrypoint(),
    repairCommands: activationRepairCommands,
  });
}
