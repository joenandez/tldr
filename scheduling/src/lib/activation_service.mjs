import { listRegisteredScopes } from "./scopes.mjs";
import { ensureWorkspaceUp } from "./workspace_service.mjs";

function activationHealth(service, runtimeHealth) {
  if (service?.health?.reason === "scheduler_service_template_drift") {
    return runtimeHealth;
  }
  if (service?.health?.healthy === false) {
    return {
      ...service.health,
      service_health: service.health,
      runtime_health: runtimeHealth || null,
    };
  }
  return runtimeHealth;
}

export function activationPayload(scope, service, health, opts = {}) {
  const registryEntry =
    listRegisteredScopes().find((entry) => entry.scope_id === scope.scope_id) ||
    null;
  const effectiveHealth = activationHealth(service, health);
  const willDispatch = Boolean(
    registryEntry && service?.running && effectiveHealth?.healthy,
  );
  const repair =
    typeof opts.repairCommands === "function"
      ? opts.repairCommands(scope)
      : null;
  return {
    scope_registered: Boolean(registryEntry),
    service_running: Boolean(service?.running),
    health: effectiveHealth,
    will_dispatch: willDispatch,
    repair: willDispatch ? null : repair,
  };
}

export function runActivation(scope, opts = {}) {
  const data = ensureWorkspaceUp(scope, opts.schedulerScriptPath);
  return activationPayload(scope, data.service, data.health, opts);
}
