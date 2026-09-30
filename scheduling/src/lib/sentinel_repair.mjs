import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { helmHome } from "./store.mjs";
import {
  classifyFreshnessActiveRuns,
  daemonFreshnessPidHandoffDecision,
} from "./sentinel_freshness_safety.mjs";

function nowIso() {
  return new Date().toISOString();
}

function dateKey(iso) {
  return String(iso).slice(0, 10);
}

export function sentinelIncidentPath({
  home = helmHome(),
  now = nowIso(),
} = {}) {
  return join(home, "sentinel", "incidents", `${dateKey(now)}.jsonl`);
}

function appendJsonl(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload)}\n`, { flag: "a" });
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function repairStatePath(home = helmHome()) {
  return join(home, "sentinel", "repair-state.json");
}

export function recordSentinelIncident({
  home = helmHome(),
  kind,
  severity = null,
  decision,
  service = null,
  readiness = null,
  health = null,
  details = null,
  now = nowIso,
} = {}) {
  const ts = now();
  const path = sentinelIncidentPath({ home, now: ts });
  appendJsonl(path, {
    ts,
    kind,
    severity,
    decision,
    service,
    readiness,
    health,
    details,
  });
  return { path, ts };
}

function serviceLoadedButDead(service = {}, health = {}) {
  const loaded = service.loaded !== false;
  const installed = service.installed === true;
  const enabled = service.enabled !== false;
  const notRunning = service.running !== true;
  const deadPid = health.failing_checks?.some(
    (entry) => entry.name === "pid_liveness",
  );
  return installed && enabled && loaded && (notRunning || deadPid);
}

export function decideSentinelRepair({
  readiness = {},
  health = {},
  service = {},
  restartSafety = null,
  production = readiness.production !== false,
} = {}) {
  if (service.daemon_freshness?.restart_required === true) {
    if (readiness.desired_state?.lockout_active) {
      return {
        allowed: false,
        action: "none",
        reason: "desired_state_lockout_active",
      };
    }
    if (readiness.desired_state?.allowed_to_start === false) {
      return {
        allowed: false,
        action: "none",
        reason: readiness.desired_state.reason || "desired_state_blocked",
      };
    }
    if (readiness.scope_registry?.quarantined_count > 0) {
      return {
        allowed: false,
        action: "none",
        reason: "scope_quarantined",
      };
    }
    if (service.installed !== true) {
      return {
        allowed: false,
        action: "none",
        reason: "service_not_installed",
      };
    }
    if (service.enabled === false) {
      return {
        allowed: false,
        action: "none",
        reason: "service_disabled_reenable_forbidden_phase_4",
      };
    }
    if (service.loaded === false) {
      return {
        allowed: false,
        action: "none",
        reason: "service_unloaded_reenable_forbidden_phase_4",
      };
    }
    if (service.running !== true) {
      return {
        allowed: false,
        action: "none",
        reason: "daemon_freshness_waiting_for_running_service",
      };
    }
    const handoffDecision = daemonFreshnessPidHandoffDecision(service);
    if (handoffDecision) return handoffDecision;
    const activeRuns = Array.isArray(restartSafety?.active_runs)
      ? restartSafety.active_runs
      : null;
    if (activeRuns === null) {
      return {
        allowed: false,
        action: "none",
        reason: "restart_safety_unavailable",
      };
    }
    const classified = classifyFreshnessActiveRuns(activeRuns, {
      service,
      health,
    });
    if (classified.blocking_active_runs.length > 0) {
      return {
        allowed: false,
        action: "none",
        reason: "active_runs_in_progress",
        active_runs: classified.blocking_active_runs,
        ignored_active_runs: [
          ...(restartSafety?.ignored_active_runs || []),
          ...classified.ignored_active_runs,
        ],
        quiet_window: classified.quiet_window,
      };
    }
    return {
      allowed: true,
      action: "restart_stale_daemon",
      reason: "daemon_freshness_restart_required",
      ignored_active_runs: [
        ...(restartSafety?.ignored_active_runs || []),
        ...classified.ignored_active_runs,
      ],
      quiet_window: classified.quiet_window,
    };
  }
  if (production && !readiness.repair_allowed) {
    return {
      allowed: false,
      action: "observe_only",
      reason: "production_observe_only",
    };
  }
  if (readiness.desired_state?.lockout_active) {
    return {
      allowed: false,
      action: "none",
      reason: "desired_state_lockout_active",
    };
  }
  if (readiness.scope_registry?.quarantined_count > 0) {
    return {
      allowed: false,
      action: "none",
      reason: "scope_quarantined",
    };
  }
  if (!readiness.repair_allowed) {
    return {
      allowed: false,
      action: "none",
      reason: readiness.reason || "sentinel_repair_not_allowed",
    };
  }
  if (service.installed !== true) {
    return {
      allowed: false,
      action: "none",
      reason: "service_not_installed",
    };
  }
  if (service.enabled === false) {
    return {
      allowed: false,
      action: "none",
      reason: "service_disabled_reenable_forbidden_phase_4",
    };
  }
  if (service.loaded === false) {
    return {
      allowed: false,
      action: "none",
      reason: "service_unloaded_reenable_forbidden_phase_4",
    };
  }
  if (serviceLoadedButDead(service, health)) {
    return {
      allowed: true,
      action: "restart_loaded_service",
      reason: "loaded_service_dead_restart_allowed",
    };
  }
  return {
    allowed: false,
    action: "none",
    reason: "service_not_repairable",
  };
}

// Offline→online self-heal decision for the scheduler launchd job. Distinguishes
// "de-registered" (launchctl print failed → job absent from the domain) from
// "registered but dead". A kickstart only works on a registered job, so a
// booted-out scheduler (the Sev2 where it vanished after a crash-loop) needs a
// bootstrap (re-register) — which is what required a manual `helm-tasks up`.
// Gated by allowedToStart (desired-state), mirroring the existing kickstart gate
// rather than the production observe-only repair gate, since the sentinel tick
// already acts in production via kickstart.
export function decideSchedulerRecovery({
  launchctlStatus,
  health = {},
  allowedToStart = false,
} = {}) {
  if (health.ok) {
    return { action: "none", reason: "scheduler_healthy" };
  }
  if (!allowedToStart) {
    return { action: "suppress", reason: "desired_state_blocked" };
  }
  if (launchctlStatus !== 0) {
    return { action: "bootstrap", reason: "scheduler_deregistered" };
  }
  if (health.reason === "status_port_unhealthy") {
    return {
      action: "suppress",
      reason: "status_port_unhealthy_live_pid",
    };
  }
  return { action: "kickstart", reason: "scheduler_registered_unhealthy" };
}

export function executeSentinelRepair({
  decision,
  restart,
  dryRun = true,
  serviceMode = process.env.HELM_SERVICE_MODE || "unknown",
} = {}) {
  if (!decision?.allowed) {
    return {
      ok: true,
      executed: false,
      reason: decision?.reason || "repair_not_allowed",
    };
  }
  if (dryRun) {
    return {
      ok: true,
      executed: false,
      dry_run: true,
      action: decision.action,
      reason: "repair_dry_run",
    };
  }
  if (serviceMode !== "fake") {
    return {
      ok: false,
      executed: false,
      action: decision.action,
      reason: "repair_execution_requires_isolated_fake_service",
    };
  }
  const result = restart();
  return {
    ok: result?.status === 0,
    executed: true,
    action: decision.action,
    status: result?.status ?? null,
    stderr: result?.stderr || null,
  };
}

export function recordSentinelRepairResult({
  home = helmHome(),
  key,
  result,
  decision,
  service = null,
  readiness = null,
  health = null,
  failureThreshold = 3,
  window = "default",
  now = nowIso,
} = {}) {
  if (!key) throw new Error("recordSentinelRepairResult requires key");
  const ts = now();
  const path = repairStatePath(home);
  const state = readJson(path, { version: "1.0", repairs: {} });
  const repairs = state.repairs || {};
  const existing = repairs[key] || {
    consecutive_failures: 0,
    incident_windows: {},
  };
  const success = result?.ok === true;
  const consecutiveFailures = success
    ? 0
    : Number(existing.consecutive_failures || 0) + 1;
  const thresholdReached = !success && consecutiveFailures >= failureThreshold;
  const incidentAlreadyRecorded = Boolean(existing.incident_windows?.[window]);
  let incident = null;
  if (thresholdReached && !incidentAlreadyRecorded) {
    incident = recordSentinelIncident({
      home,
      kind: "sentinel_repair_failure_threshold",
      decision,
      service,
      readiness,
      health,
      now: () => ts,
    });
  }
  repairs[key] = {
    consecutive_failures: consecutiveFailures,
    last_result: result || null,
    last_decision: decision || null,
    updated_at: ts,
    allow_retry: !thresholdReached,
    quarantined: thresholdReached,
    incident_windows: {
      ...(existing.incident_windows || {}),
      ...(incident ? { [window]: incident.path } : {}),
    },
  };
  writeJson(path, {
    version: "1.0",
    updated_at: ts,
    repairs,
  });
  return {
    key,
    path,
    state: repairs[key],
    incident,
  };
}
