const DEFAULT_DAEMON_FRESHNESS_PID_HANDOFF_GRACE_MS = 5 * 60 * 1000;

function finiteNonNegativeMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function currentRepairTimeMs() {
  const override = Date.parse(process.env.HELM_NOW || "");
  return Number.isFinite(override) ? override : Date.now();
}

export function daemonFreshnessPidHandoffDecision(service = {}) {
  const freshness = service.daemon_freshness || {};
  const currentPid = Number(service.live_pid || service.pid);
  const recordedPid = Number(freshness.pid);
  if (service.running !== true) return null;
  if (!Number.isInteger(currentPid) || currentPid <= 0) return null;
  if (!Number.isInteger(recordedPid) || recordedPid <= 0) return null;
  if (currentPid === recordedPid) return null;

  const recordedAtMs = Date.parse(freshness.recorded_at || "");
  if (!Number.isFinite(recordedAtMs)) return null;
  const ageMs = Math.max(0, currentRepairTimeMs() - recordedAtMs);
  const graceMs = finiteNonNegativeMs(
    process.env.HELM_SENTINEL_DAEMON_FRESHNESS_PID_HANDOFF_GRACE_MS,
    DEFAULT_DAEMON_FRESHNESS_PID_HANDOFF_GRACE_MS,
  );
  if (ageMs > graceMs) return null;

  return {
    allowed: false,
    action: "none",
    reason: "daemon_freshness_waiting_for_current_pid",
    current_pid: currentPid,
    recorded_pid: recordedPid,
    recorded_at: freshness.recorded_at || null,
    age_ms: ageMs,
    grace_ms: graceMs,
  };
}

function activeRunBlockReason(run = {}) {
  const jobId = String(run.job_id || "");
  const priorityClass =
    run.priority_class || run.metadata?.priority_class || run.priority || null;
  if (jobId.startsWith("helm-resume-") || priorityClass === "p0_inbox_resume") {
    return "p0_inbox_resume_active";
  }
  if (!run.scope_id || !run.job_id || !run.run_id) {
    return "active_run_identity_unknown";
  }
  const pid = Number(run.pid);
  if (!Number.isFinite(pid) || pid <= 0) return "active_run_pid_unknown";
  return null;
}

function daemonFreshnessQuietWindow(service = {}, health = {}) {
  const progress = service.daemon_progress || {};
  const runtime = service.runtime || {};
  const store = service.runtime_store_observation || {};
  const serviceHealth = service.health || {};
  const heartbeatAge = Number(progress.heartbeat_age_ms);
  const heartbeatFresh =
    !Number.isFinite(heartbeatAge) || heartbeatAge <= 2 * 60 * 1000;
  const progressFresh =
    progress.no_progress !== true &&
    (progress.status === "completed" || progress.status === undefined) &&
    heartbeatFresh;
  const dispatchIdle =
    runtime.last_dispatch_status === "idle" ||
    runtime.last_dispatch_observed_reason === "idle" ||
    serviceHealth.reason === "dispatch_idle" ||
    health.reason === "dispatch_idle";
  const runtimeStoreOk =
    !store.status ||
    store.status === "ok" ||
    store.reason === "runtime_store_available";
  const serviceHealthy =
    serviceHealth.healthy === true ||
    serviceHealth.reason === "dispatch_idle" ||
    health.ok === true ||
    health.reason === "dispatch_idle";

  return progressFresh && dispatchIdle && runtimeStoreOk && serviceHealthy;
}

export function classifyFreshnessActiveRuns(
  activeRuns,
  { service, health } = {},
) {
  const quietWindow = daemonFreshnessQuietWindow(service, health);
  if (!quietWindow) {
    return {
      blocking_active_runs: activeRuns,
      ignored_active_runs: [],
      quiet_window: false,
    };
  }

  const blocking = [];
  const ignored = [];
  for (const run of activeRuns) {
    const reason = activeRunBlockReason(run);
    if (reason) blocking.push({ ...run, block_reason: reason });
    else {
      ignored.push({
        ...run,
        ignore_reason: "quiet_window_non_blocking_active_run",
      });
    }
  }
  return {
    blocking_active_runs: blocking,
    ignored_active_runs: ignored,
    quiet_window: true,
  };
}
