function parseMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function ageMs(value, nowMs) {
  const parsed = parseMs(value);
  if (parsed === null) return null;
  return Math.max(0, nowMs - parsed);
}

function check(name, ok, details = {}) {
  return {
    name,
    ok: Boolean(ok),
    reason: ok ? "ok" : details.reason || `${name}_failed`,
    ...details,
  };
}

function serviceChecks(service = {}) {
  return [
    check("service_installed", service.installed === true, {
      reason: "service_not_installed",
    }),
    check("service_enabled", service.enabled !== false, {
      reason: "service_disabled",
    }),
    check("service_loaded", service.loaded !== false, {
      reason: "service_unloaded",
    }),
    check("service_running", service.running === true, {
      reason: "service_not_running",
    }),
  ];
}

function pidCheck({ service = {}, pidProbe }) {
  const pid = Number(service.pid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return check("pid_liveness", false, { reason: "pid_missing", pid: null });
  }
  const alive = pidProbe ? pidProbe(pid) : true;
  return check("pid_liveness", alive === true, {
    reason: "pid_dead_or_zombie",
    pid,
  });
}

function freshnessCheck({
  name,
  at,
  nowMs,
  thresholdMs,
  missingReason,
  staleReason,
}) {
  const observedAgeMs = ageMs(at, nowMs);
  if (observedAgeMs === null) {
    return check(name, false, { reason: missingReason, age_ms: null });
  }
  return check(name, observedAgeMs <= thresholdMs, {
    reason: staleReason,
    age_ms: observedAgeMs,
    threshold_ms: thresholdMs,
  });
}

function resourceChecks(resources = {}, thresholds = {}) {
  const checks = [];
  if (resources.rss_mb !== undefined) {
    checks.push(
      check("rss_limit", resources.rss_mb <= thresholds.maxRssMb, {
        reason: "rss_limit_exceeded",
        rss_mb: resources.rss_mb,
        threshold_mb: thresholds.maxRssMb,
      }),
    );
  }
  if (resources.rss_slope_mb_per_min !== undefined) {
    checks.push(
      check(
        "rss_slope_limit",
        resources.rss_slope_mb_per_min <= thresholds.maxRssSlopeMbPerMin,
        {
          reason: "rss_slope_limit_exceeded",
          rss_slope_mb_per_min: resources.rss_slope_mb_per_min,
          threshold_mb_per_min: thresholds.maxRssSlopeMbPerMin,
        },
      ),
    );
  }
  if (resources.child_count !== undefined) {
    checks.push(
      check(
        "child_count_limit",
        resources.child_count <= thresholds.maxChildren,
        {
          reason: "child_count_limit_exceeded",
          child_count: resources.child_count,
          threshold: thresholds.maxChildren,
        },
      ),
    );
  }
  if (resources.max_child_age_ms !== undefined) {
    checks.push(
      check(
        "child_age_limit",
        resources.max_child_age_ms <= thresholds.maxChildAgeMs,
        {
          reason: "child_age_limit_exceeded",
          max_child_age_ms: resources.max_child_age_ms,
          threshold_ms: thresholds.maxChildAgeMs,
        },
      ),
    );
  }
  return checks;
}

function readinessStatus(readiness = {}) {
  if (readiness.desired_state?.lockout_active) return "locked_out";
  if (readiness.scope_registry?.quarantined_count > 0) return "quarantined";
  if (readiness.repair_allowed) return "repair_eligible";
  if (!readiness.ok || readiness.observe_only) return "blocked";
  return "healthy";
}

function healthyStatus(status, readiness = {}) {
  if (status === "healthy") return true;
  return (
    status === "repair_eligible" &&
    readiness.repair_mode === "restart_loaded_only"
  );
}

export function evaluateSentinelHealth({
  readiness,
  service = {},
  pidProbe = () => true,
  statusProbe = { checked: false, ok: true },
  lastTickAt = null,
  phaseStartedAt = null,
  resources = {},
  staleLeases = [],
  overdueJobs = [],
  now = new Date(),
  thresholds = {},
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const limits = {
    tickFreshMs: 2 * 60 * 1000,
    phaseFreshMs: 5 * 60 * 1000,
    maxRssMb: 1024,
    maxRssSlopeMbPerMin: 128,
    maxChildren: 25,
    maxChildAgeMs: 10 * 60 * 1000,
    ...thresholds,
  };
  const checks = [
    check("sentinel_readiness", readiness?.ready === true, {
      reason: readiness?.reason || "sentinel_readiness_blocked",
    }),
    ...serviceChecks(service),
    pidCheck({ service, pidProbe }),
    check("status_port", statusProbe.checked ? statusProbe.ok === true : true, {
      reason: "status_port_unhealthy",
      status: statusProbe.status || null,
    }),
    freshnessCheck({
      name: "tick_freshness",
      at: lastTickAt,
      nowMs,
      thresholdMs: limits.tickFreshMs,
      missingReason: "tick_missing",
      staleReason: "tick_stale",
    }),
    freshnessCheck({
      name: "phase_age",
      at: phaseStartedAt,
      nowMs,
      thresholdMs: limits.phaseFreshMs,
      missingReason: "phase_missing",
      staleReason: "phase_stale",
    }),
    ...resourceChecks(resources, limits),
    check("stale_leases", staleLeases.length === 0, {
      reason: "stale_leases_present",
      stale_lease_count: staleLeases.length,
      stale_leases: staleLeases,
    }),
    check("overdue_jobs", overdueJobs.length === 0, {
      reason: "overdue_jobs_present",
      overdue_job_count: overdueJobs.length,
      overdue_jobs: overdueJobs,
    }),
  ];
  const failing = checks.filter((entry) => !entry.ok);
  const status = failing.length === 0 ? readinessStatus(readiness) : "degraded";
  return {
    ok: failing.length === 0 && healthyStatus(status, readiness),
    status,
    reason: failing[0]?.reason || readiness?.reason || "ok",
    checked_at: new Date(nowMs).toISOString(),
    checks,
    failing_checks: failing,
  };
}
