#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { isProcessAlive } from "./lib/process_liveness.mjs";
import { serviceStart, serviceStatus } from "./lib/service.mjs";
import {
  daemonFreshnessStatus as readDaemonFreshnessStatus,
  freshnessSchedulerScriptPath,
} from "./lib/daemon_freshness.mjs";
import { escalateSentinelIncident } from "./lib/sentinel_escalation.mjs";
import { evaluateSentinelHealth } from "./lib/sentinel_health.mjs";
import {
  decideSchedulerRecovery,
  decideSentinelRepair,
} from "./lib/sentinel_repair.mjs";
import { readSentinelReadiness } from "./lib/sentinel_state.mjs";
import { listScopeRegistryV2 } from "./lib/scope_registry_v2.mjs";
import { serviceRestartSafetyReport } from "./lib/service_restart_safety.mjs";
import { lockPath } from "./lib/lock.mjs";
import { helmHomeFor, loadActiveRunsReadOnly } from "./lib/store.mjs";
import {
  bootstrapHooks,
  inspectInstalledHooks,
  _internals as bootstrapHooksInternals,
} from "./lib/bootstrap_hooks.mjs";
import { runSentinelTickSafely } from "./lib/sentinel_tick_safety.mjs";

const SCHEDULER_LABEL = "ai.helm.scheduler";
const SENTINEL_LABEL = "ai.helm.sentinel";
const DEFAULT_OVERDUE_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_TICK_FRESH_MS = 2 * 60 * 1000;
const DEFAULT_STATUS_PROBE_TIMEOUT_MS = 6_000;
const DEFAULT_STATUS_PROBE_RETRY_TIMEOUT_MS = 1_000;
const STATUS_PROBE_PATH = "/livez";
const RUNTIME_HOOK_RUNTIMES = ["claude", "codex"];

function helmHome() {
  return helmHomeFor({ envHome: process.env.HELM_HOME });
}

function nowDate() {
  return process.env.HELM_NOW ? new Date(process.env.HELM_NOW) : new Date();
}

function isoDateInPt(date = nowDate()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(path, fallback = null) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "a" });
}

export function parseLaunchctlPid(text) {
  const match = String(text || "").match(/\bpid\s*=\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

export const pidAlive = isProcessAlive;

function resolveStatusProbeTimeoutMs(
  value = process.env.HELM_SENTINEL_STATUS_PROBE_TIMEOUT_MS,
) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STATUS_PROBE_TIMEOUT_MS;
}

async function probeStatusPort(
  port,
  fetchImpl = globalThis.fetch,
  timeoutMs = resolveStatusProbeTimeoutMs(),
) {
  if (!port || typeof fetchImpl !== "function")
    return { checked: false, ok: null };
  const timeout = resolveStatusProbeTimeoutMs(timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${port}${STATUS_PROBE_PATH}`,
      {
        signal: AbortSignal.timeout(timeout),
      },
    );
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: "debug", event: "TEMP SENTINEL-PROBE", path: STATUS_PROBE_PATH, duration_ms: Date.now() - startedAt, ok: response.ok, status: response.status })}\n`,
    );
    return {
      checked: true,
      ok: response.ok,
      status: response.status,
      timeout_ms: timeout,
    };
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: "warn", event: "TEMP SENTINEL-PROBE", path: STATUS_PROBE_PATH, duration_ms: Date.now() - startedAt, ok: false, error: err?.message || String(err) })}\n`,
    );
    return {
      checked: true,
      ok: false,
      error: err?.message || String(err),
      timeout_ms: timeout,
    };
  }
}

export async function evaluateSchedulerHealth({
  launchctlText,
  statusPort = null,
  pidProbe = pidAlive,
  fetchImpl = globalThis.fetch,
  statusProbeTimeoutMs = DEFAULT_STATUS_PROBE_TIMEOUT_MS,
  statusProbeRetryTimeoutMs = DEFAULT_STATUS_PROBE_RETRY_TIMEOUT_MS,
} = {}) {
  const pid = parseLaunchctlPid(launchctlText);
  const alive = pid ? pidProbe(pid) : false;
  let status = await probeStatusPort(
    statusPort,
    fetchImpl,
    statusProbeTimeoutMs,
  );
  if (alive && status.checked && status.ok === false) {
    const retryTimeoutMs = Math.min(
      resolveStatusProbeTimeoutMs(statusProbeRetryTimeoutMs),
      resolveStatusProbeTimeoutMs(statusProbeTimeoutMs),
    );
    const retryStatus = await probeStatusPort(
      statusPort,
      fetchImpl,
      retryTimeoutMs,
    );
    if (retryStatus.ok === true) {
      status = {
        ...retryStatus,
        confirmed_by_retry: true,
        initial_error: status.error || null,
        initial_status: status.status || null,
        initial_timeout_ms: status.timeout_ms || null,
      };
    } else {
      status = {
        ...retryStatus,
        confirmed_by_retry: false,
        initial_error: status.error || null,
        initial_status: status.status || null,
        initial_timeout_ms: status.timeout_ms || null,
      };
    }
  }
  const ok = alive && (status.checked ? status.ok === true : true);
  return {
    ok,
    pid,
    pid_alive: alive,
    status_probe: status,
    reason: ok
      ? "ok"
      : !pid
        ? "launchd_pid_missing"
        : !alive
          ? "pid_dead"
          : "status_port_unhealthy",
  };
}

function launchctlTarget(uid = process.getuid()) {
  return `gui/${uid}/${SCHEDULER_LABEL}`;
}

function printSchedulerLaunchd() {
  const result = spawnSync("launchctl", ["print", launchctlTarget()], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    text: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function kickstartScheduler() {
  return spawnSync("launchctl", ["kickstart", "-k", launchctlTarget()], {
    encoding: "utf8",
  });
}

// Re-register a scheduler that has been booted out of the launchd domain.
// serviceStart installs the plist if missing, `launchctl bootstrap`s the job,
// then kickstarts it — the full sequence `helm-tasks up` runs, which a bare
// kickstart cannot do for an absent job.
function bootstrapScheduler() {
  try {
    const status = serviceStart(schedulerScriptPath());
    return { status: status?.running ? 0 : 1, stderr: null };
  } catch (err) {
    return { status: 1, stderr: err?.message || String(err) };
  }
}

function restartSchedulerService() {
  return restartLoadedSchedulerService();
}

function waitForSchedulerServiceStatus({
  schedulerScript = schedulerScriptPath(),
  timeoutMs = 5000,
  status = serviceStatus,
  previousPid = null,
  requirePidChange = false,
  pidProbe = pidAlive,
} = {}) {
  const startedAt = Date.now();
  const previousPidNumber = Number(previousPid);
  const hasPreviousPid =
    Number.isInteger(previousPidNumber) && previousPidNumber > 0;
  const ready = (current) => {
    const currentPid = Number(current?.pid);
    if (
      current?.running !== true ||
      !Number.isInteger(currentPid) ||
      currentPid <= 0 ||
      !pidProbe(currentPid)
    ) {
      return false;
    }
    return (
      !requirePidChange || !hasPreviousPid || currentPid !== previousPidNumber
    );
  };
  let current = status(schedulerScript);
  while (!ready(current) && Date.now() - startedAt < timeoutMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    current = status(schedulerScript);
  }
  return current;
}

function restartLoadedSchedulerService({
  kickstart = kickstartScheduler,
  status = serviceStatus,
  pidProbe = pidAlive,
} = {}) {
  try {
    const before = status(schedulerScriptPath());
    const previousPid = Number(before?.pid);
    const requirePidChange =
      Number.isInteger(previousPid) && previousPid > 0 && pidProbe(previousPid);
    const result = kickstart();
    if (result.status !== 0) {
      return { status: result.status, stderr: result.stderr || null };
    }
    const service = waitForSchedulerServiceStatus({
      status,
      previousPid,
      requirePidChange,
      pidProbe,
    });
    const servicePid = Number(service?.pid);
    return {
      status:
        service?.running === true &&
        Number.isInteger(servicePid) &&
        servicePid > 0 &&
        pidProbe(servicePid) &&
        (!requirePidChange || servicePid !== previousPid)
          ? 0
          : 1,
      stderr:
        requirePidChange && servicePid === previousPid
          ? "scheduler_restart_pid_handoff_timeout"
          : null,
      service,
    };
  } catch (err) {
    return { status: 1, stderr: err?.message || String(err) };
  }
}

function schedulerScriptPath() {
  return join(dirname(new URL(import.meta.url).pathname), "helm-tasks.mjs");
}

async function recordLocalEscalation() {
  return {
    ok: true,
    suppressed: true,
    reason: "communication_runtime_retired",
  };
}

async function guardedSentinelSend({
  subject,
  body,
  send = recordLocalEscalation,
}) {
  const readiness = readSentinelReadiness({
    home: helmHome(),
    production: process.env.HELM_SERVICE_MODE !== "fake",
    repairMode: process.env.HELM_SENTINEL_REPAIR_MODE || "off",
  });
  return escalateSentinelIncident({
    home: helmHome(),
    key: `sentinel:${subject}`,
    subject,
    body,
    readiness,
    send,
    window: isoDateInPt(),
  });
}

async function readSchedulerDesiredState() {
  try {
    const { readDesiredState } = await import("./lib/runtime_store.mjs");
    return readDesiredState({ initialize: false });
  } catch (err) {
    return {
      configured: false,
      mode: "disabled",
      lockout: null,
      lockout_active: false,
      allowed_to_start: false,
      reason: err?.code || "desired_state_unreadable",
      error: err?.message || String(err),
    };
  }
}

function schedulerRepairSuppressionReason(readiness) {
  if (readiness?.reason === "desired_state_lockout_active") {
    return readiness.reason;
  }
  if (readiness?.production && readiness?.observe_only) {
    return "production_observe_only";
  }
  return readiness?.reason || "sentinel_repair_not_allowed";
}

function envFlagEnabled(name) {
  const value = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

async function guardedSchedulerKickstart({
  kickstart = kickstartScheduler,
  bootstrap = bootstrapScheduler,
  launchctlStatus = 0,
  health = { ok: false },
} = {}) {
  const desiredState = await readSchedulerDesiredState();
  const readiness = readSentinelReadiness({
    home: helmHome(),
    production: process.env.HELM_SERVICE_MODE !== "fake",
    repairMode: process.env.HELM_SENTINEL_REPAIR_MODE || "off",
  });
  if (!readiness.repair_allowed) {
    const reason = schedulerRepairSuppressionReason(readiness);
    return {
      suppressed: true,
      action: readiness.observe_only ? "observe_only" : "none",
      reason,
      decision: null,
      desired_state: desiredState,
      readiness,
      status: null,
      stderr: null,
    };
  }
  const decision = decideSchedulerRecovery({
    launchctlStatus,
    health,
    allowedToStart: desiredState.allowed_to_start,
  });
  if (decision.action === "suppress" || decision.action === "none") {
    return {
      suppressed: true,
      action: decision.action,
      reason:
        decision.reason === "desired_state_blocked"
          ? desiredState.reason || "desired_state_blocked"
          : decision.reason,
      decision,
      desired_state: desiredState,
      readiness,
      status: null,
      stderr: null,
    };
  }
  // action is "bootstrap" (job de-registered, must re-register) or "kickstart"
  // (registered but dead). Both are gated by allowed_to_start above.
  const result = decision.action === "bootstrap" ? bootstrap() : kickstart();
  return {
    suppressed: false,
    action: decision.action,
    reason: decision.reason,
    decision,
    desired_state: desiredState,
    readiness,
    status: result.status,
    stderr: result.stderr || null,
  };
}

async function guardedDaemonFreshnessRestart({
  service = null,
  readiness = null,
  restartSafety = null,
  restart = restartSchedulerService,
  reloadDriftedTemplate = null,
  daemonFreshnessStatus = readDaemonFreshnessStatus,
} = {}) {
  const schedulerScript = schedulerScriptPath();
  const baseService = service || serviceStatus(schedulerScript);
  const resolvedService = baseService?.daemon_freshness
    ? baseService
    : {
        ...baseService,
        daemon_freshness: daemonFreshnessStatus(
          freshnessSchedulerScriptPath(baseService, schedulerScript),
        ),
      };
  const resolvedReadiness =
    readiness ||
    readSentinelReadiness({
      home: helmHome(),
      production: process.env.HELM_SERVICE_MODE !== "fake",
      repairMode: process.env.HELM_SENTINEL_REPAIR_MODE || "off",
    });
  const resolvedRestartSafety =
    restartSafety || serviceRestartSafetyReport(null);
  const decision = decideSentinelRepair({
    readiness: resolvedReadiness,
    health: { status: "degraded", failing_checks: [] },
    service: resolvedService,
    restartSafety: resolvedRestartSafety,
    production: resolvedReadiness.production !== false,
  });
  if (!decision.allowed) {
    return {
      suppressed: true,
      action: decision.action,
      reason: decision.reason,
      decision,
      readiness: resolvedReadiness,
      restart_safety: resolvedRestartSafety,
      status: null,
      stderr: null,
    };
  }
  void reloadDriftedTemplate;
  const result = restart();
  return {
    suppressed: false,
    action: decision.action,
    reason: decision.reason,
    decision,
    readiness: resolvedReadiness,
    restart_safety: resolvedRestartSafety,
    status: result.status,
    stderr: result.stderr || null,
    service: result.service || null,
  };
}

function readScopeRegistry(registryPath = join(helmHome(), "scopes.json")) {
  const parsed = readJson(registryPath, { scopes: [] });
  return Array.isArray(parsed?.scopes) ? parsed.scopes : [];
}

function readWorkspaceJobs(scopeEntry) {
  const storageRoot =
    scopeEntry?.storage_root ||
    (scopeEntry?.cwd ? join(scopeEntry.cwd, ".helm") : null);
  if (!storageRoot) return [];
  const parsed = readJson(join(storageRoot, "jobs.json"), { jobs: [] });
  return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
}

function runtimeScopeForRegistryEntry(scopeEntry) {
  const scopeId = scopeEntry?.scope_id || scopeEntry?.cwd;
  return {
    scope_id: scopeId,
    cwd: scopeEntry?.cwd || scopeId,
    storage_root:
      scopeEntry?.storage_root ||
      (scopeEntry?.cwd ? join(scopeEntry.cwd, ".helm") : null),
  };
}

function liveActiveRunForJob(scope, jobId, pidProbe = pidAlive) {
  if (!jobId) return null;
  try {
    const entry = loadActiveRunsReadOnly(scope).runs?.[jobId];
    const pid = Number(entry?.pid);
    if (!Number.isFinite(pid) || pid <= 0 || !pidProbe(pid)) return null;
    return {
      run_id: entry?.run_id || null,
      pid,
      started_at: entry?.started_at || null,
    };
  } catch {
    return null;
  }
}

function freshExecutionLease(scope, nowMs, pidProbe = pidAlive) {
  try {
    const lease = readJson(lockPath(scope, "execution.lock"), null);
    const leaseUntilMs = new Date(lease?.lease_until || "").getTime();
    const holderPid = Number(lease?.holder_pid);
    if (!Number.isFinite(leaseUntilMs) || leaseUntilMs <= nowMs) return null;
    if (!Number.isFinite(holderPid) || holderPid <= 0 || !pidProbe(holderPid)) {
      return null;
    }
    return {
      owner: lease.owner || null,
      holder_pid: holderPid,
      lease_until: lease.lease_until,
    };
  } catch {
    return null;
  }
}

export function findOverdueRegisteredJobs({
  now = nowDate(),
  registryPath = join(helmHome(), "scopes.json"),
  overdueGraceMs = DEFAULT_OVERDUE_GRACE_MS,
  pidProbe = pidAlive,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const scopes = readScopeRegistry(registryPath);
  // Only consider scopes the daemon is actually responsible for dispatching.
  // Jobs in disabled or quarantined scopes are overdue by design (one-scope-at-a-
  // time operation parks the rest), so counting them would make the sentinel
  // kickstart-loop the daemon and escalate on intentionally-parked work. Mirror
  // the daemon's dispatch-enabled set from the runtime scope registry.
  let enabledScopeIds;
  try {
    const registry = listScopeRegistryV2({ home: helmHome() });
    enabledScopeIds = new Set(
      registry.entries
        .filter(
          (entry) =>
            entry.dispatch_state === "enabled" &&
            entry.quarantine_state !== "quarantined",
        )
        .map((entry) => entry.scope_id),
    );
  } catch (err) {
    // If the registry can't be read, do not treat any job as overdue; this avoids
    // false-positive kickstarts. Core daemon-health supervision still applies.
    return {
      ok: true,
      checked: false,
      overdue_count: 0,
      overdue: [],
      reason: "scope_registry_unreadable",
      error: err?.message || String(err),
    };
  }
  const overdue = [];
  const suppressed = [];
  for (const scope of scopes) {
    if (!scope?.cwd || !existsSync(scope.cwd)) continue;
    if (!enabledScopeIds.has(scope.scope_id || scope.cwd)) continue;
    const runtimeScope = runtimeScopeForRegistryEntry(scope);
    const scopeExecutionLease = freshExecutionLease(
      runtimeScope,
      nowMs,
      pidProbe,
    );
    for (const job of readWorkspaceJobs(scope)) {
      if (job?.state?.enabled === false) continue;
      // One-shot jobs (transient cell/agent-session handlers, resume jobs) carry a
      // next_run_at that legitimately stays in the past after they fire, so they are
      // not a daemon-dispatch-health signal. Only recurring jobs indicate whether
      // the scheduler is reliably firing scheduled work.
      if (job?.schedule?.type === "once") continue;
      const nextRunAt = job?.state?.next_run_at;
      if (!nextRunAt) continue;
      const dueMs = new Date(nextRunAt).getTime();
      if (!Number.isFinite(dueMs)) continue;
      const overdueMs = nowMs - dueMs;
      if (overdueMs <= overdueGraceMs) continue;
      const liveActiveRun = liveActiveRunForJob(
        runtimeScope,
        job.id || null,
        pidProbe,
      );
      if (liveActiveRun) {
        suppressed.push({
          scope_id: scope.scope_id || scope.cwd,
          cwd: scope.cwd,
          job_id: job.id || null,
          next_run_at: nextRunAt,
          overdue_ms: overdueMs,
          reason: "active_run_alive",
          active_run: liveActiveRun,
        });
        continue;
      }
      if (scopeExecutionLease) {
        suppressed.push({
          scope_id: scope.scope_id || scope.cwd,
          cwd: scope.cwd,
          job_id: job.id || null,
          next_run_at: nextRunAt,
          overdue_ms: overdueMs,
          reason: "scope_dispatch_in_progress",
          execution_lease: scopeExecutionLease,
        });
        continue;
      }
      overdue.push({
        scope_id: scope.scope_id || scope.cwd,
        cwd: scope.cwd,
        job_id: job.id || null,
        next_run_at: nextRunAt,
        overdue_ms: overdueMs,
      });
    }
  }
  overdue.sort((a, b) => b.overdue_ms - a.overdue_ms);
  return {
    ok: overdue.length === 0,
    checked: true,
    overdue_count: overdue.length,
    overdue,
    suppressed_count: suppressed.length,
    suppressed,
  };
}

function sentinelRoot() {
  return join(helmHome(), "sentinel");
}

function statePath() {
  return join(sentinelRoot(), "state.json");
}

function daemonLastTickPath() {
  return join(helmHome(), "daemon", "last-tick.ts");
}

function sentinelPhasePath() {
  return join(sentinelRoot(), "phase.json");
}

function incidentsPath() {
  const date = isoDateInPt();
  return join(sentinelRoot(), "incidents", `${date}.jsonl`);
}

function loadState() {
  return readJson(statePath(), {
    version: "1.0",
    consecutive_unhealthy: 0,
    scheduler_escalated_at: null,
    overdue_jobs: {},
    updated_at: null,
  });
}

function saveState(state) {
  writeJson(statePath(), { ...state, updated_at: new Date().toISOString() });
}

function writeSentinelPhase(patch = {}) {
  writeJson(sentinelPhasePath(), {
    version: "1.0",
    phase: "tick",
    ...patch,
  });
}

function requiredRuntimeHookEvents() {
  return Object.keys(bootstrapHooksInternals.HOOK_FILES || {});
}

function missingRuntimeHookEvents(inspection) {
  const events = inspection?.events || {};
  return requiredRuntimeHookEvents().filter((event) => {
    const value = events[event];
    return !value?.installed;
  });
}

function runtimeHookScriptFailures(inspection) {
  const events = inspection?.events || {};
  return requiredRuntimeHookEvents().filter((event) => {
    const value = events[event];
    return !value?.script_exists || !value?.script_executable;
  });
}

function runtimeHookFailureKey(runtime, now = nowDate()) {
  return `${isoDateInPt(now)}:${runtime}`;
}

function recordRuntimeHookHealFailure(state, row) {
  if (!state.runtime_hook_auto_heal_failures) {
    state.runtime_hook_auto_heal_failures = {};
  }
  const key = runtimeHookFailureKey(row.runtime);
  if (state.runtime_hook_auto_heal_failures[key]) {
    return null;
  }
  appendJsonl(incidentsPath(), row);
  state.runtime_hook_auto_heal_failures[key] = row.ts;
  return incidentsPath();
}

// Inside the unified tldr plugin, the plugin manifest owns every runtime hook
// and Helm has none (Tightbeam's session hooks record the session facts Helm
// reads). The sentinel never touches settings files there. Detect the plugin
// root by its manifest, not by what its hooks.json registers: the check used
// to look for scheduling/hooks/ in hooks.json, which stopped matching when
// the Helm hooks were retired from it.
function runtimeHooksOwnedByPlugin(canonicalCheckout) {
  if (!canonicalCheckout) return false;
  const packageRoot = dirname(canonicalCheckout);
  return (
    existsSync(join(packageRoot, ".claude-plugin", "plugin.json")) ||
    existsSync(join(packageRoot, ".claude-plugin", "hooks", "hooks.json"))
  );
}

async function healRuntimeHooks({
  state,
  runtimes = RUNTIME_HOOK_RUNTIMES,
  inspect = inspectInstalledHooks,
  install = bootstrapHooks,
  canonicalCheckout = process.env.HELM_CANONICAL_CHECKOUT,
} = {}) {
  if (runtimeHooksOwnedByPlugin(canonicalCheckout)) {
    return {
      ok: true,
      skipped: "plugin_owned_runtime_hooks",
      checked_runtimes: [],
      healed_runtimes: [],
      results: {},
    };
  }
  const results = {};
  const healedRuntimes = [];
  for (const runtime of runtimes) {
    let inspection;
    try {
      inspection = inspect({ runtime });
    } catch (err) {
      const error = err?.message || String(err);
      const incidentPath = recordRuntimeHookHealFailure(state, {
        ts: new Date().toISOString(),
        kind: "runtime_hooks_auto_heal_failed",
        runtime,
        reason: "inspect_failed",
        error,
      });
      results[runtime] = {
        ok: false,
        action: "none",
        reason: "inspect_failed",
        error,
        incident_path: incidentPath,
      };
      continue;
    }

    const missingEvents = missingRuntimeHookEvents(inspection);
    const scriptFailures = runtimeHookScriptFailures(inspection);
    const retiredGroups = inspection.retired_groups || [];
    if (scriptFailures.length > 0) {
      const incidentPath = recordRuntimeHookHealFailure(state, {
        ts: new Date().toISOString(),
        kind: "runtime_hooks_auto_heal_failed",
        runtime,
        reason: "hook_script_unavailable",
        file: inspection.file,
        missing_events: missingEvents,
        script_failures: scriptFailures,
        retired_groups: retiredGroups,
        marker: bootstrapHooksInternals.HELM_MARKER,
      });
      results[runtime] = {
        ok: false,
        action: "none",
        reason: "hook_script_unavailable",
        file: inspection.file,
        missing_events: missingEvents,
        script_failures: scriptFailures,
        retired_groups: retiredGroups,
        incident_path: incidentPath,
      };
      continue;
    }

    if (missingEvents.length === 0 && retiredGroups.length === 0) {
      results[runtime] = {
        ok: true,
        action: "none",
        reason: "runtime_hooks_current",
        file: inspection.file,
        missing_events: [],
        retired_groups: [],
      };
      continue;
    }

    let installResult;
    try {
      installResult = install({ action: "install", runtime });
      if (!installResult?.ok) {
        throw new Error(
          installResult?.error?.message ||
            installResult?.error?.code ||
            "bootstrap_hooks_failed",
        );
      }
    } catch (err) {
      const error = err?.message || String(err);
      const incidentPath = recordRuntimeHookHealFailure(state, {
        ts: new Date().toISOString(),
        kind: "runtime_hooks_auto_heal_failed",
        runtime,
        reason: "install_failed",
        file: inspection.file,
        missing_events: missingEvents,
        retired_groups: retiredGroups,
        marker: bootstrapHooksInternals.HELM_MARKER,
        error,
      });
      results[runtime] = {
        ok: false,
        action: "none",
        reason: "install_failed",
        file: inspection.file,
        missing_events: missingEvents,
        retired_groups: retiredGroups,
        error,
        incident_path: incidentPath,
      };
      continue;
    }

    const changes = installResult.report?.[0]?.changes || [];
    appendJsonl(incidentsPath(), {
      ts: new Date().toISOString(),
      kind: "runtime_hooks_auto_healed",
      runtime,
      file: inspection.file,
      missing_events: missingEvents,
      retired_groups: retiredGroups,
      changes,
      marker: installResult.helm_marker || bootstrapHooksInternals.HELM_MARKER,
    });
    healedRuntimes.push(runtime);
    results[runtime] = {
      ok: true,
      action: "healed",
      reason:
        missingEvents.length > 0
          ? "runtime_hooks_missing"
          : "retired_hooks_present",
      file: inspection.file,
      missing_events: missingEvents,
      retired_groups: retiredGroups,
      changes,
      marker: installResult.helm_marker || bootstrapHooksInternals.HELM_MARKER,
    };
  }
  return {
    ok: Object.values(results).every((result) => result.ok),
    checked_runtimes: runtimes,
    healed_runtimes: healedRuntimes,
    results,
  };
}

async function checkOnce({
  statusPort = Number(process.env.HELM_STATUS_PORT || 45173),
  repairMode = process.env.HELM_SENTINEL_REPAIR_MODE || "off",
  production = process.env.HELM_SERVICE_MODE !== "fake",
  now = nowDate(),
  fetchImpl = globalThis.fetch,
  schedulerScript = schedulerScriptPath(),
} = {}) {
  const readiness = readSentinelReadiness({
    home: helmHome(),
    production,
    repairMode,
    now: () => now.toISOString(),
  });
  const service = serviceStatus(schedulerScript);
  const statusProbe = await probeStatusPort(statusPort, fetchImpl);
  const phase = readJson(sentinelPhasePath(), null);
  const health = evaluateSentinelHealth({
    readiness,
    service,
    pidProbe: pidAlive,
    statusProbe,
    lastTickAt: readText(daemonLastTickPath(), null),
    phaseStartedAt: phase?.started_at || null,
    resources: {},
    staleLeases: [],
    overdueJobs: [],
    now,
    thresholds: { tickFreshMs: DEFAULT_TICK_FRESH_MS },
  });
  const repairDecision = decideSentinelRepair({
    readiness,
    health,
    service,
    production,
  });
  return {
    ok: true,
    command: "sentinel_check",
    checked_at: now.toISOString(),
    mode: "single_shot",
    read_only: true,
    service,
    readiness,
    health,
    repair_decision: repairDecision,
  };
}

async function tickOnce({
  statusPort = Number(process.env.HELM_STATUS_PORT || 45173),
  send = recordLocalEscalation,
  kickstart = kickstartScheduler,
  bootstrap = bootstrapScheduler,
  printLaunchd = printSchedulerLaunchd,
  evaluateHealth = evaluateSchedulerHealth,
  daemonFreshnessRestart = guardedDaemonFreshnessRestart,
  runtimeHookHealing = healRuntimeHooks,
  findOverdueJobs = findOverdueRegisteredJobs,
  production = process.env.HELM_SERVICE_MODE !== "fake",
  overdueAlertsEnabled = production
    ? envFlagEnabled("HELM_SENTINEL_OVERDUE_ALERTS")
    : true,
} = {}) {
  const phaseStartedAt = nowDate().toISOString();
  writeSentinelPhase({
    status: "running",
    started_at: phaseStartedAt,
    heartbeat_at: phaseStartedAt,
  });

  const state = loadState();
  const printed = printLaunchd();
  const priorConsecutiveUnhealthy = Number(state.consecutive_unhealthy || 0);
  let health = await evaluateHealth({
    launchctlText: printed.text,
    statusPort,
  });
  let restarted = false;
  if (!health.ok) {
    const kick = await guardedSchedulerKickstart({
      kickstart,
      bootstrap,
      launchctlStatus: printed.status,
      health,
    });
    restarted = !kick.suppressed;
    const firstLiveStatusPortMiss =
      priorConsecutiveUnhealthy === 0 &&
      kick?.suppressed === true &&
      kick?.reason === "status_port_unhealthy_live_pid" &&
      health?.reason === "status_port_unhealthy" &&
      health?.pid_alive === true;
    if (!firstLiveStatusPortMiss) {
      appendJsonl(incidentsPath(), {
        ts: new Date().toISOString(),
        kind: kick.suppressed
          ? "scheduler_unhealthy_restart_suppressed"
          : "scheduler_unhealthy_restart",
        recovery_action: kick.action,
        reason: kick.reason,
        health,
        desired_state: kick.desired_state,
        readiness: kick.readiness,
        decision: kick.decision,
        kickstart_suppressed: kick.suppressed,
        kickstart_status: kick.status,
        kickstart_stderr: kick.stderr,
      });
    }
    if (!kick.suppressed) {
      const after = printLaunchd();
      health = await evaluateHealth({
        launchctlText: after.text,
        statusPort,
      });
    }
  }

  state.consecutive_unhealthy = health.ok
    ? 0
    : Number(state.consecutive_unhealthy || 0) + 1;
  if (state.consecutive_unhealthy >= 3 && !state.scheduler_escalated_at) {
    const escalation = await guardedSentinelSend({
      subject: "[Helm] Scheduler sentinel escalation",
      body: `The external Helm sentinel observed ${state.consecutive_unhealthy} consecutive unhealthy checks.\n\nLast health:\n${JSON.stringify(health, null, 2)}`,
      send,
    });
    state.scheduler_escalated_at = new Date().toISOString();
    appendJsonl(incidentsPath(), {
      ts: state.scheduler_escalated_at,
      kind: "scheduler_escalation",
      escalation,
      health,
    });
  }

  const daemonFreshnessRepair = restarted
    ? {
        suppressed: true,
        action: "none",
        reason: "scheduler_recovered_this_tick",
      }
    : await daemonFreshnessRestart();
  if (
    daemonFreshnessRepair?.suppressed === false ||
    daemonFreshnessRepair?.reason === "active_runs_in_progress"
  ) {
    appendJsonl(incidentsPath(), {
      ts: new Date().toISOString(),
      kind:
        daemonFreshnessRepair.suppressed === false
          ? "daemon_freshness_restart"
          : "daemon_freshness_restart_deferred",
      action: daemonFreshnessRepair.action,
      reason: daemonFreshnessRepair.reason,
      status: daemonFreshnessRepair.status,
      restart_safety: daemonFreshnessRepair.restart_safety || null,
      decision: daemonFreshnessRepair.decision || null,
    });
  }

  const runtimeHookHealingResult = await runtimeHookHealing({ state });

  const overdueJobs = overdueAlertsEnabled
    ? findOverdueJobs()
    : {
        ok: true,
        checked: false,
        reason: "overdue_alerts_disabled",
        overdue_count: 0,
        overdue: [],
      };
  if (!overdueJobs.ok) {
    // Overdue recurring jobs are escalated for visibility, but the sentinel does
    // NOT kickstart the scheduler here. Kickstarting a launchd-managed daemon that
    // is actually alive races KeepAlive and triggers a pidfile-ownership-lost flap.
    // Genuine daemon-down/frozen recovery is handled by the health check above
    // (status-port + pid probe); overdue jobs alone are not a restart trigger.
    if (!state.overdue_jobs) state.overdue_jobs = {};
    const newOverdue = overdueJobs.overdue.filter((job) => {
      const key = `${job.scope_id}:${job.job_id}:${job.next_run_at}`;
      return !state.overdue_jobs[key];
    });
    if (newOverdue.length > 0) {
      const escalation = await guardedSentinelSend({
        subject: `[Helm] Scheduler sentinel found ${newOverdue.length} overdue job(s)`,
        body: [
          "The external Helm sentinel found enabled recurring jobs whose next_run_at is overdue.",
          "",
          `Overdue jobs:\n${JSON.stringify(newOverdue, null, 2)}`,
          "",
          "The sentinel did NOT restart the scheduler (overdue jobs are not a restart trigger). Inspect Helm service health and job history for dispatch failures.",
        ].join("\n"),
        send,
      });
      const ts = new Date().toISOString();
      for (const job of newOverdue) {
        const key = `${job.scope_id}:${job.job_id}:${job.next_run_at}`;
        state.overdue_jobs[key] = ts;
      }
      appendJsonl(incidentsPath(), {
        ts,
        kind: "overdue_registered_jobs",
        overdue_jobs: newOverdue,
        escalation,
      });
    }
  }

  saveState(state);
  writeSentinelPhase({
    status: "completed",
    started_at: phaseStartedAt,
    heartbeat_at: new Date().toISOString(),
  });
  return {
    health,
    restarted,
    daemon_freshness_repair: daemonFreshnessRepair,
    runtime_hook_healing: runtimeHookHealingResult,
    overdue_jobs: overdueJobs,
    state,
  };
}

async function runTickSafely() {
  return runSentinelTickSafely({
    tick: tickOnce,
    recordFailure: (failure) => appendJsonl(incidentsPath(), failure),
  });
}

async function loop() {
  // Keep the process independent of Helm's scheduler. launchd handles restarts.
  await runTickSafely();
  setInterval(() => {
    runTickSafely();
  }, 60_000);
  await new Promise(() => {});
}

export const _internals = {
  SENTINEL_LABEL,
  SCHEDULER_LABEL,
  evaluateSchedulerHealth,
  findOverdueRegisteredJobs,
  guardedSchedulerKickstart,
  guardedDaemonFreshnessRestart,
  healRuntimeHooks,
  guardedSentinelSend,
  parseLaunchctlPid,
  restartLoadedSchedulerService,
  checkOnce,
  tickOnce,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] || "run";
  if (mode === "check") {
    checkOnce()
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      })
      .catch((err) => {
        process.stderr.write(`${err?.stack || err}\n`);
        process.exit(1);
      });
  } else if (mode === "once") {
    tickOnce()
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      })
      .catch((err) => {
        process.stderr.write(`${err?.stack || err}\n`);
        process.exit(1);
      });
  } else {
    loop();
  }
}
