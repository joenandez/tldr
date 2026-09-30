import {
  checkRuntimeStoreReadiness,
  readDesiredState,
  readOutboundState,
} from "./runtime_store.mjs";
import { listScopeRegistryV2 } from "./scope_registry_v2.mjs";
import { helmHome } from "./store.mjs";

export const SENTINEL_REPAIR_MODES = Object.freeze([
  "off",
  "restart_loaded_only",
  "reenable_allowed",
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeRepairMode(mode) {
  const value = String(mode || "off").trim();
  if (!SENTINEL_REPAIR_MODES.includes(value)) {
    return {
      ok: false,
      mode: "off",
      reason: "sentinel_repair_mode_invalid",
      supported_modes: SENTINEL_REPAIR_MODES,
    };
  }
  return { ok: true, mode: value, reason: "sentinel_repair_mode_configured" };
}

function registryReadiness({ home }) {
  try {
    const registry = listScopeRegistryV2({ home });
    const enabled = registry.entries.filter(
      (entry) =>
        entry.dispatch_state === "enabled" &&
        entry.quarantine_state !== "quarantined",
    );
    const quarantined = registry.entries.filter(
      (entry) => entry.quarantine_state === "quarantined",
    );
    return {
      ready: true,
      path: registry.path,
      schema_version: registry.metadata.schema_version,
      generation: registry.metadata.generation,
      entry_count: registry.entries.length,
      dispatch_enabled_count: enabled.length,
      quarantined_count: quarantined.length,
      reason: "scope_registry_ready",
    };
  } catch (err) {
    return {
      ready: false,
      path: err?.details?.path || null,
      reason: err?.code || "scope_registry_unready",
      error: err?.message || String(err),
      details: err?.details || null,
    };
  }
}

function productionSafeDefault({ production, desiredState, repairMode }) {
  if (!desiredState.allowed_to_start) {
    return {
      observe_only: true,
      repair_allowed: false,
      reason: desiredState.reason || "desired_state_blocked",
    };
  }
  if (repairMode.mode === "off") {
    return {
      observe_only: true,
      repair_allowed: false,
      reason: "sentinel_repair_mode_off",
    };
  }
  if (repairMode.mode === "reenable_allowed") {
    return {
      observe_only: true,
      repair_allowed: false,
      reason: "sentinel_reenable_not_allowed_in_phase_4",
    };
  }
  if (production && repairMode.mode !== "restart_loaded_only") {
    return {
      observe_only: true,
      repair_allowed: false,
      reason: "production_observe_only",
    };
  }
  return {
    observe_only: false,
    repair_allowed: true,
    reason: "sentinel_restart_loaded_only_allowed",
  };
}

function failClosedBehavior(reason) {
  return {
    observe_only: true,
    repair_allowed: false,
    reason,
  };
}

export function readSentinelReadiness({
  home = helmHome(),
  production = process.env.HELM_SERVICE_MODE !== "fake",
  repairMode = "off",
  now = nowIso,
} = {}) {
  const runtime = checkRuntimeStoreReadiness({ home, initialize: false });
  const desiredState = readDesiredState({ home, initialize: false });
  const outboundState = readOutboundState({ home, initialize: false });
  const registry = registryReadiness({ home });
  const normalizedRepairMode = normalizeRepairMode(repairMode);
  const behavior = !runtime.ok
    ? failClosedBehavior(runtime.code || "runtime_store_unready")
    : !registry.ready
      ? failClosedBehavior(registry.reason || "scope_registry_unready")
      : productionSafeDefault({
          production: Boolean(production),
          desiredState,
          repairMode: normalizedRepairMode,
        });
  const ready =
    runtime.ok &&
    registry.ready &&
    desiredState.ready === true &&
    outboundState.ready === true &&
    normalizedRepairMode.ok;
  const ok =
    ready &&
    desiredState.allowed_to_start &&
    outboundState.mode !== "disabled" &&
    registry.ready;
  const reason = !runtime.ok
    ? runtime.code
    : !registry.ready
      ? registry.reason
      : !desiredState.allowed_to_start
        ? desiredState.reason
        : outboundState.mode === "disabled"
          ? outboundState.configured
            ? "outbound_disabled"
            : outboundState.reason
          : !normalizedRepairMode.ok
            ? normalizedRepairMode.reason
            : behavior.reason;

  return {
    ok,
    ready,
    checked_at: now(),
    production: Boolean(production),
    mode: behavior.observe_only ? "observe_only" : "repair_eligible",
    observe_only: behavior.observe_only,
    repair_allowed: behavior.repair_allowed,
    repair_mode: normalizedRepairMode.mode,
    reason,
    runtime,
    desired_state: desiredState,
    outbound_state: outboundState,
    scope_registry: registry,
  };
}
