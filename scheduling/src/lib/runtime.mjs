import { join } from "node:path";
import {
  helmHome,
  loadRuntime,
  readJsonIfExists,
  saveRuntime,
} from "./store.mjs";
import { isProcessAlive, isSameProcessAlive } from "./process_liveness.mjs";

// Opportunity #6 (reliability review 2026-06-11): health must bind PID
// liveness to start-time identity. A bare kill(pid, 0) probe reported a
// dead daemon healthy when an unrelated process reused its PID
// (COE-2026-05-16A / 05-20 shape). When the daemon singleton record carries
// start-time evidence for this pid, require it to match; without evidence,
// fall back to bare liveness (never falsely unhealthy on a transient read).
function daemonPidIdentityAlive(pid, { pidProbe, sameProcessAlive }) {
  if (!pidProbe(pid)) return false;
  const record = readJsonIfExists(
    join(helmHome(), "service", "daemon-singleton.json"),
    null,
  );
  if (!record || Number(record.pid) !== Number(pid)) return true;
  const recordedStart = record?.process_start?.start_time || null;
  if (!recordedStart) return true;
  return sameProcessAlive(pid, recordedStart);
}

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function nowMs() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).getTime()
    : Date.now();
}

function staleThresholdSec() {
  return Number(process.env.HELM_STALE_SEC || 120);
}

function runningThresholdSec() {
  return Number(process.env.HELM_RUNNING_STALE_SEC || 14400);
}

function dispatchCriticalQuarantine(service) {
  const quarantine = service?.daemon_progress?.quarantine;
  if (!quarantine?.active) return null;
  const causes = quarantine.causes || {};
  const activeCause = quarantine.active_cause || null;
  const entries = Object.entries(causes);
  const activeEntry = activeCause ? causes[activeCause] : null;
  const candidates = activeEntry ? [[activeCause, activeEntry]] : entries;
  return (
    candidates.find(([key, entry]) => {
      const phase = entry?.phase || String(key).split(":")[0];
      return entry?.quarantined && phase === "dispatch_launch";
    }) || null
  );
}

export function markDispatchStarted(scope, daemonInstanceId) {
  const current = loadRuntime(scope) || {};
  const next = {
    ...current,
    last_dispatch_started_at: nowIso(),
    last_dispatch_status: "running",
    daemon_instance_id: daemonInstanceId || current.daemon_instance_id || null,
    daemon_pid: Number(process.env.HELM_DAEMON_PID || process.pid),
    last_error: null,
    updated_at: nowIso(),
  };
  saveRuntime(scope, next);
  return next;
}

export function markDispatchFinished(
  scope,
  status,
  error = null,
  daemonInstanceId = null,
) {
  const current = loadRuntime(scope) || {};
  const next = {
    ...current,
    last_dispatch_finished_at: nowIso(),
    last_dispatch_status: status,
    daemon_instance_id: daemonInstanceId || current.daemon_instance_id || null,
    daemon_pid: Number(process.env.HELM_DAEMON_PID || process.pid),
    last_error: error,
    updated_at: nowIso(),
  };
  saveRuntime(scope, next);
  return next;
}

export function markDispatchObserved(
  scope,
  reason = "observed",
  daemonInstanceId = null,
) {
  const current = loadRuntime(scope) || {};
  const next = {
    ...current,
    last_dispatch_observed_at: nowIso(),
    last_dispatch_observed_reason: reason,
    last_dispatch_status: reason,
    daemon_instance_id: daemonInstanceId || current.daemon_instance_id || null,
    daemon_pid: Number(process.env.HELM_DAEMON_PID || process.pid),
    updated_at: nowIso(),
  };
  saveRuntime(scope, next);
  return next;
}

export function runtimeHealth(
  runtime,
  service,
  registeredAt = null,
  opts = {},
) {
  const pidProbe = opts.pidProbe || isProcessAlive;
  const sameProcessAlive = opts.sameProcessAlive || isSameProcessAlive;
  const threshold = staleThresholdSec();
  const runningThreshold = runningThresholdSec();
  const now = nowMs();

  if (!service.installed) {
    return {
      healthy: false,
      reason: "service_not_installed",
      dispatch_stale_seconds: null,
    };
  }
  if (!service.running) {
    return {
      healthy: false,
      reason: "service_not_running",
      dispatch_stale_seconds: null,
    };
  }

  const runtimePid = Number(runtime?.daemon_pid || 0);
  const servicePid = Number(service?.pid || 0);
  const hasRuntimePid = Number.isFinite(runtimePid) && runtimePid > 0;
  const hasServicePid = Number.isFinite(servicePid) && servicePid > 0;
  const pidRotated =
    hasRuntimePid && hasServicePid && runtimePid !== servicePid;

  if (
    hasRuntimePid &&
    !pidRotated &&
    !daemonPidIdentityAlive(runtimePid, { pidProbe, sameProcessAlive })
  ) {
    return {
      healthy: false,
      reason: "service_not_running",
      dispatch_stale_seconds: null,
    };
  }

  if (pidRotated) {
    return {
      healthy: true,
      reason: "service_starting",
      dispatch_stale_seconds: null,
    };
  }

  const dispatchQuarantine = dispatchCriticalQuarantine(service);
  if (dispatchQuarantine) {
    return {
      healthy: false,
      reason: "dispatch_phase_quarantined",
      dispatch_stale_seconds: null,
      quarantine_cause: dispatchQuarantine[0],
    };
  }

  if (!runtime?.last_dispatch_finished_at) {
    if (
      runtime?.last_dispatch_status === "running" &&
      runtime?.last_dispatch_started_at
    ) {
      const runningAgeSec = Math.floor(
        (now - new Date(runtime.last_dispatch_started_at).getTime()) / 1000,
      );
      if (runningAgeSec <= runningThreshold) {
        return {
          healthy: true,
          reason: "dispatch_running",
          dispatch_stale_seconds: runningAgeSec,
        };
      }
      return {
        healthy: false,
        reason: "dispatch_stale",
        dispatch_stale_seconds: runningAgeSec,
      };
    }
    if (
      runtime?.last_dispatch_observed_reason === "idle" &&
      runtime?.last_dispatch_observed_at
    ) {
      const idleAgeSec = Math.floor(
        (now - new Date(runtime.last_dispatch_observed_at).getTime()) / 1000,
      );
      if (idleAgeSec <= threshold) {
        return {
          healthy: true,
          reason: "dispatch_idle",
          dispatch_stale_seconds: idleAgeSec,
        };
      }
    }
    if (!registeredAt) {
      return {
        healthy: true,
        reason: "service_running_no_scope_runtime",
        dispatch_stale_seconds: null,
      };
    }
    const ageSec = Math.floor((now - new Date(registeredAt).getTime()) / 1000);
    if (ageSec <= threshold) {
      return {
        healthy: true,
        reason: "service_starting",
        dispatch_stale_seconds: null,
      };
    }
    return {
      healthy: false,
      reason: "runtime_missing",
      dispatch_stale_seconds: null,
    };
  }

  if (
    runtime.last_dispatch_status === "running" &&
    runtime.last_dispatch_started_at
  ) {
    const runningAgeSec = Math.floor(
      (now - new Date(runtime.last_dispatch_started_at).getTime()) / 1000,
    );
    if (runningAgeSec <= runningThreshold) {
      return {
        healthy: true,
        reason: "dispatch_running",
        dispatch_stale_seconds: runningAgeSec,
      };
    }
    return {
      healthy: false,
      reason: "dispatch_stale",
      dispatch_stale_seconds: runningAgeSec,
    };
  }

  const staleSec = Math.floor(
    (now - new Date(runtime.last_dispatch_finished_at).getTime()) / 1000,
  );
  if (
    runtime.last_dispatch_observed_reason === "idle" &&
    runtime.last_dispatch_observed_at
  ) {
    const idleAgeSec = Math.floor(
      (now - new Date(runtime.last_dispatch_observed_at).getTime()) / 1000,
    );
    if (staleSec > threshold) {
      if (idleAgeSec <= threshold) {
        return {
          healthy: true,
          reason: "dispatch_idle",
          dispatch_stale_seconds: idleAgeSec,
        };
      }
      return {
        healthy: false,
        reason: "dispatch_stale",
        dispatch_stale_seconds: idleAgeSec,
      };
    }
  }
  if (staleSec > threshold) {
    return {
      healthy: false,
      reason: "dispatch_stale",
      dispatch_stale_seconds: staleSec,
    };
  }
  return { healthy: true, reason: "ok", dispatch_stale_seconds: staleSec };
}
