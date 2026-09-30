import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  hydrateRegisteredScopes,
  hydrateRegisteredScopesLegacy,
  listRegisteredScopesLegacy,
  pruneMissingScopes,
} from "./scopes.mjs";
import { resolveNodeExecutable } from "./node_exec.mjs";
import {
  appendActivityEvent,
  projectHealthStreamState,
  trackHealthTransition,
} from "./activity_stream.mjs";
import {
  helmHome,
  loadRuntime,
  readJsonIfExists,
  resolveScope,
  writeJsonAtomic,
} from "./store.mjs";
import { markDispatchObserved, runtimeHealth } from "./runtime.mjs";
import { reapStaleLease } from "./lock.mjs";
import { writeDaemonFreshness } from "./daemon_freshness.mjs";
import {
  DEFAULT_DISPATCH_LAUNCH_STAGGER_MS,
  DEFAULT_DISPATCH_LAUNCH_TIMEOUT_MS,
  effectiveDispatchStaggerMs,
  launchDispatchScopesCooperatively,
  maxConcurrentDispatches,
} from "./daemon_dispatch_fanout.mjs";
export {
  DEFAULT_MAX_CONCURRENT_DISPATCHES,
  effectiveDispatchStaggerMs,
  launchDispatchScopesCooperatively,
  maxConcurrentDispatches,
} from "./daemon_dispatch_fanout.mjs";
import {
  OWNERSHIP_LOST_CONFIRM_TICKS,
  daemonPidPath,
  evaluateOwnershipLost,
  readDaemonPidFile,
  readDaemonPidFileForHome,
  writePidFileAtomic,
} from "./daemon_pidfile.mjs";
import { isProcessAlive, processStartEvidence } from "./process_liveness.mjs";
import {
  acquireRuntimeStoreLock,
  canonicalHelmHome,
} from "./runtime_store.mjs";
import { emitSafetyEvent } from "./safety_events.mjs";
import { clearDaemonPhaseFailureCause } from "./daemon_quarantine.mjs";
import {
  appendPerfEvent,
  inProcessMemorySample,
} from "./resource_sampler_light.mjs";
import { createDaemonLiveDeltaAttributor } from "./daemon_live_attribution.mjs";
import {
  buildChildSampleRecord,
  classifyChildKind,
} from "./perf_attribution.mjs";
import {
  applyDispatchAdmission,
  classifyScopeDueForDispatch,
  prepareAirlockDispatch,
} from "./daemon_dispatch_airlock.mjs";
import { launchDispatchOnceForAirlock } from "./daemon_dispatch_once.mjs";
import { loadActiveRunsReadOnly, loadDispatchJobsReadOnly } from "./store.mjs";
import { createDispatchExecutor } from "./daemon_dispatch_executor.mjs";
import { runDaemonMaintenanceChild } from "./daemon_child_commands.mjs";
import {
  isGlobalDueAdmissionEnabledForDaemon,
  loadDispatchDueQueryModule,
  loadScopeRegistryV2Module,
  shouldRunRetentionForDaemon,
} from "./daemon_lazy_deps.mjs";
import {
  DEFAULT_DAEMON_PHASE_TIMEOUT_MS,
  phaseTimeoutFor,
} from "./daemon_phase_timeouts.mjs";
import { recordDaemonPhaseFailureSafely } from "./daemon_phase_failure_safety.mjs";
import {
  prepareInfrastructureProtectedDispatch,
  recordInfrastructureDispatchDeferrals,
} from "./dispatch_infrastructure_deferral.mjs";

const ALARM_CHECK_TICKS = 20;
const skippedScopeDispatchState = new Map();
const DISPATCH_CHILD_SINGLE_FLIGHT_MS = Number(
  process.env.HELM_DISPATCH_CHILD_SINGLE_FLIGHT_MS || 30000,
);

async function registryDispatchPlan({ once = false } = {}) {
  if (!once && process.env.HELM_DAEMON_RESIDENT_SQLITE_DISPATCH !== "1") {
    return legacyRegistryDispatchPlan();
  }
  // Default-on H2 due admission uses the N+1-fixed registry plan. The panic
  // lever falls back to the legacy classify-per-scope admission shape.
  if (isGlobalDueAdmissionEnabledForDaemon()) {
    const { registryDispatchPlanFast } = await loadDispatchDueQueryModule();
    return registryDispatchPlanFast();
  }
  let registry;
  try {
    const { listScopeRegistryV2 } = await loadScopeRegistryV2Module();
    registry = listScopeRegistryV2();
  } catch (err) {
    return {
      authoritative: true,
      generation: null,
      dispatchable: [],
      skipped: [
        {
          scope_id: null,
          cwd: null,
          reason: err?.code || "scope_registry_invalid",
          error: err?.message || String(err),
        },
      ],
    };
  }
  if (registry.entries.length === 0) {
    return {
      authoritative: false,
      generation: registry.metadata.generation,
      dispatchable: hydrateRegisteredScopes(),
      skipped: [],
    };
  }
  const dispatchable = [];
  const skipped = [];
  const { explainScopeRegistryV2 } = await loadScopeRegistryV2Module();
  for (const entry of registry.entries) {
    const explanation = explainScopeRegistryV2({ scopeId: entry.scope_id });
    if (explanation.dispatchable) {
      dispatchable.push(resolveScope({ cwd: entry.cwd }));
    } else {
      skipped.push({
        scope_id: entry.scope_id,
        cwd: entry.cwd,
        reason: explanation.reason,
        generation: explanation.generation,
      });
    }
  }
  return {
    authoritative: true,
    generation: registry.metadata.generation,
    dispatchable,
    skipped,
  };
}

function legacyRegistryDispatchPlan() {
  const entries = listRegisteredScopesLegacy();
  const dispatchable = [];
  const skipped = [];
  for (const entry of entries) {
    const scopeId = entry.scope_id || entry.cwd;
    if (entry.quarantine_state === "quarantined") {
      skipped.push({
        scope_id: scopeId,
        cwd: entry.cwd,
        reason: "quarantined",
        generation: entry.registry_generation ?? null,
      });
      continue;
    }
    if (entry.dispatch_state && entry.dispatch_state !== "enabled") {
      skipped.push({
        scope_id: scopeId,
        cwd: entry.cwd,
        reason: "dispatch_disabled",
        generation: entry.registry_generation ?? null,
      });
      continue;
    }
    if (!existsSync(entry.cwd)) {
      skipped.push({
        scope_id: scopeId,
        cwd: entry.cwd,
        reason: "scope_cwd_missing",
        generation: entry.registry_generation ?? null,
      });
      continue;
    }
    dispatchable.push(resolveScope({ cwd: entry.cwd }));
  }
  return {
    authoritative: false,
    generation: null,
    dispatchable,
    skipped,
  };
}

function scopeDispatchSkipKey(skipped) {
  return skipped.scope_id || skipped.cwd || "__registry__";
}

function scopeDispatchSkipSignature(skipped, plan) {
  return JSON.stringify({
    reason: skipped.reason || null,
    generation: skipped.generation ?? plan.generation ?? null,
    authoritative: Boolean(plan.authoritative),
    error: skipped.error || null,
  });
}

function shouldEmitScopeDispatchSkipped(skipped, plan) {
  const key = scopeDispatchSkipKey(skipped);
  const signature = scopeDispatchSkipSignature(skipped, plan);
  if (skippedScopeDispatchState.get(key) === signature) return false;
  skippedScopeDispatchState.set(key, signature);
  return true;
}

function pruneScopeDispatchSkipState(plan) {
  const activeKeys = new Set(plan.skipped.map(scopeDispatchSkipKey));
  for (const key of skippedScopeDispatchState.keys()) {
    if (!activeKeys.has(key)) skippedScopeDispatchState.delete(key);
  }
}

export { readDaemonPidFile };

export function daemonSingletonRecordPath(home = helmHome()) {
  return join(home, "service", "daemon-singleton.json");
}

export function daemonLastTickPath() {
  return join(helmHome(), "daemon", "last-tick.ts");
}

function writeDaemonLastTick() {
  const path = daemonLastTickPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Date().toISOString(), "utf8");
  } catch (err) {
    process.stderr.write(
      `helm daemon last-tick write failed: ${err.message}\n`,
    );
  }
}

function readDaemonSingletonRecord(home) {
  return readJsonIfExists(daemonSingletonRecordPath(home), null);
}

function singletonToken() {
  return `daemon_lock_${randomBytes(16).toString("hex")}`;
}

function processEvidenceMatches(record, current) {
  const recordedStart = record?.process_start?.start_time || null;
  const currentStart = current?.start_time || null;
  return Boolean(
    recordedStart && currentStart && recordedStart === currentStart,
  );
}

function emitSingletonRefusal({
  reason,
  daemonInstanceId,
  holder = null,
  home,
  metadata = {},
}) {
  emitSafetyEvent({
    type: "daemon_singleton_collision",
    subsystem: "daemon_singleton",
    status: "failure",
    errorClass: reason,
    daemonInstanceId,
    metadata: {
      holder_pid: holder,
      attempted_pid: process.pid,
      helm_home: home,
      reason,
      ...metadata,
    },
  });
}

// Runtime-store-lock acquisition is retried briefly so the singleton survives
// *transient* contention — e.g. an orphaned worktree `server run` process doing
// a sub-millisecond scope read while sharing the same HELM_HOME. Without this,
// one unlucky read collision made the daemon refuse to start and launchd would
// relaunch it into the same collision (the runtime_store_lock_held refusal loop).
const RUNTIME_LOCK_ACQUIRE_ATTEMPTS = 4;
const RUNTIME_LOCK_RETRY_MS = 75;

// Synchronous sleep — acquireDaemonSingletonLock runs before the async loop
// starts, so it cannot await. Atomics.wait blocks the thread without spinning.
function sleepSyncMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireDaemonSingletonLock({
  home = helmHome(),
  pid = process.pid,
  daemonInstanceId = `daemon_${Date.now()}`,
  statusPortBind = null,
  pidAlive = isProcessAlive,
  processEvidence = processStartEvidence(pid),
  processEvidenceForPid = processStartEvidence,
  acquireStoreLock = acquireRuntimeStoreLock,
  sleepSync = sleepSyncMs,
  lockAcquireAttempts = RUNTIME_LOCK_ACQUIRE_ATTEMPTS,
  lockRetryMs = RUNTIME_LOCK_RETRY_MS,
} = {}) {
  const bind = statusPortBind || {
    ok: false,
    code: "status_port_not_bound",
    message: "daemon status port was not bound",
  };
  if (!bind.ok) {
    emitSingletonRefusal({
      reason: "status_port_bind_failed",
      daemonInstanceId,
      home,
      metadata: { code: bind.code || "status_port_bind_failed" },
    });
    return {
      acquired: false,
      reason: "status_port_bind_failed",
      code: bind.code || "status_port_bind_failed",
      status_port: bind,
    };
  }

  let releaseStoreLock = null;
  let lockErr = null;
  const attempts = Math.max(1, lockAcquireAttempts);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      releaseStoreLock = acquireStoreLock(home, {
        owner: `daemon-singleton:${pid}`,
        pidAlive,
      });
      lockErr = null;
      break;
    } catch (err) {
      lockErr = err;
      if (attempt < attempts - 1) sleepSync(lockRetryMs);
    }
  }
  if (lockErr) {
    emitSingletonRefusal({
      reason: "runtime_store_lock_held",
      daemonInstanceId,
      holder: lockErr?.details?.holder_pid || null,
      home,
      metadata: {
        code: lockErr?.code || "runtime_store_locked",
        attempts,
      },
    });
    return {
      acquired: false,
      reason: "runtime_store_lock_held",
      code: lockErr?.code || "runtime_store_locked",
      holder: lockErr?.details?.holder_pid || null,
      details: lockErr?.details || {},
    };
  }

  try {
    const canonicalHome = canonicalHelmHome(home);
    const record = readDaemonSingletonRecord(home);
    const recordedPid = Number(record?.pid || 0);
    const pidFilePid = readDaemonPidFileForHome(home);
    const existing = recordedPid || pidFilePid;

    if (existing && existing !== pid && pidAlive(existing)) {
      if (recordedPid && record?.process_start) {
        const currentEvidence = processEvidenceForPid(existing);
        // Only suspect PID reuse on POSITIVE conflicting evidence — a present
        // start_time that differs from the recorded one. A null current
        // start_time (e.g. a transient `ps` failure across sleep/wake) is
        // inconclusive, not proof of reuse, so fall through to
        // singleton_holder_live and keep refusing rather than raising a false
        // pid_reuse alarm against a genuinely-alive holder.
        const conclusiveMismatch =
          currentEvidence?.start_time !== null &&
          currentEvidence?.start_time !== undefined &&
          !processEvidenceMatches(record, currentEvidence);
        if (conclusiveMismatch) {
          emitSingletonRefusal({
            reason: "pid_reuse_suspected",
            daemonInstanceId,
            holder: existing,
            home,
            metadata: {
              canonical_helm_home: canonicalHome,
              recorded_process_start: record.process_start,
              current_process_start: currentEvidence,
            },
          });
          return {
            acquired: false,
            reason: "pid_reuse_suspected",
            holder: existing,
            daemon_instance_id: record.daemon_instance_id || null,
            canonical_helm_home: canonicalHome,
            recorded_process_start: record.process_start,
            current_process_start: currentEvidence,
          };
        }
      }
      emitSingletonRefusal({
        reason: "singleton_holder_live",
        daemonInstanceId,
        holder: existing,
        home,
        metadata: {
          canonical_helm_home: canonicalHome,
        },
      });
      return {
        acquired: false,
        reason: "singleton_holder_live",
        holder: existing,
        daemon_instance_id: record?.daemon_instance_id || null,
        canonical_helm_home: canonicalHome,
      };
    }

    const now = new Date().toISOString();
    const lockToken = singletonToken();
    const singletonRecord = {
      version: "1.0",
      daemon_instance_id: daemonInstanceId,
      canonical_helm_home: canonicalHome,
      pid,
      process_start: processEvidence,
      lock_token: lockToken,
      status_port: bind,
      acquired_at: now,
      updated_at: now,
    };
    writePidFileAtomic(home, pid);
    writeJsonAtomic(daemonSingletonRecordPath(home), singletonRecord);
    return {
      acquired: true,
      holder: pid,
      pid,
      lock_token: lockToken,
      daemon_instance_id: daemonInstanceId,
      canonical_helm_home: canonicalHome,
      status_port: bind,
      process_start: processEvidence,
    };
  } finally {
    try {
      releaseStoreLock?.();
    } catch {
      // best-effort release; acquisition result remains authoritative.
    }
  }
}

export function releaseDaemonSingletonLock({
  home = helmHome(),
  pid = process.pid,
  lock_token: lockToken = null,
} = {}) {
  try {
    const record = readDaemonSingletonRecord(home);
    if (
      record?.pid === pid &&
      (!lockToken || record.lock_token === lockToken)
    ) {
      unlinkSync(daemonSingletonRecordPath(home));
    }
  } catch {
    // best-effort cleanup
  }
  try {
    const owner = readDaemonPidFileForHome(home);
    if (owner === pid) {
      unlinkSync(daemonPidPath(home));
    }
  } catch {
    // best-effort cleanup
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export function daemonProgressPath(home = helmHome()) {
  return join(home, "daemon", "progress.json");
}

export function daemonQuarantinePath(home = helmHome()) {
  return join(home, "daemon", "quarantine.json");
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function phaseResourceSamplesEnabled() {
  return process.env.HELM_DAEMON_PHASE_RESOURCE_SAMPLES === "1";
}

function shouldEmitPhaseResourceSample(name) {
  return name === "dispatch_launch" || phaseResourceSamplesEnabled();
}

async function phaseResourceSampleFields() {
  if (!phaseResourceSamplesEnabled()) return {};
  const memory = inProcessMemorySample();
  const { vmmapSummaryForPid } = await import("./resource_sampler.mjs");
  const footprint = vmmapSummaryForPid(process.pid);
  return {
    memory: {
      ...memory,
      physical_footprint_mb: footprint.physical_footprint_mb,
      physical_footprint_peak_mb: footprint.physical_footprint_peak_mb,
      malloc_large_reusable_mb: footprint.malloc_large_reusable_mb,
      vmmap_ok: footprint.vmmap_ok,
      vmmap_error: footprint.vmmap_error ?? null,
    },
  };
}

function appendDaemonPerfEvent(event) {
  try {
    return appendPerfEvent(event);
  } catch (err) {
    process.stderr.write(`helm daemon perf event failed: ${err.message}\n`);
    return null;
  }
}

function residentDaemonServiceSnapshot() {
  return {
    installed: true,
    loaded: true,
    running: true,
    pid: process.pid,
    live_pid: process.pid,
    live_pid_alive: true,
    health: { healthy: true, reason: "ok" },
    daemon_progress: readDaemonProgress({ home: helmHome() }),
  };
}

export function writeDaemonProgress({
  home = helmHome(),
  daemonInstanceId = null,
  phase = null,
  status = "running",
  message = null,
  startedAt = null,
  heartbeatAt = nowIso(),
  metadata = {},
} = {}) {
  const path = daemonProgressPath(home);
  const prior = readJsonIfExists(path, {});
  const next = {
    version: "1.0",
    daemon_instance_id: daemonInstanceId || prior.daemon_instance_id || null,
    current_phase: phase ?? prior.current_phase ?? null,
    status,
    message,
    started_at: startedAt || prior.started_at || heartbeatAt,
    heartbeat_at: heartbeatAt,
    updated_at: heartbeatAt,
    metadata,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, next);
  } catch (err) {
    const prefix = err?.code ? `${err.code}: ` : "";
    process.stderr.write(
      `helm daemon progress write failed: ${prefix}${err.message}\n`,
    );
  }
  return next;
}

export function readDaemonQuarantine({ home = helmHome() } = {}) {
  return readJsonIfExists(daemonQuarantinePath(home), {
    version: "1.0",
    active: false,
    causes: {},
  });
}

export function recordDaemonPhaseFailure({
  home = helmHome(),
  daemonInstanceId = null,
  phase,
  cause,
  threshold = 3,
  now = nowIso,
} = {}) {
  const path = daemonQuarantinePath(home);
  const current = readDaemonQuarantine({ home });
  const key = `${phase || "unknown"}:${cause || "unknown"}`;
  const at = now();
  const prior = current.causes?.[key] || {};
  const count = Number(prior.count || 0) + 1;
  const quarantined = count >= threshold;
  const next = {
    version: "1.0",
    active: Boolean(current.active || quarantined),
    active_cause: quarantined ? key : current.active_cause || null,
    daemon_instance_id: daemonInstanceId || current.daemon_instance_id || null,
    updated_at: at,
    causes: {
      ...(current.causes || {}),
      [key]: {
        phase: phase || "unknown",
        cause: cause || "unknown",
        count,
        threshold,
        first_seen_at: prior.first_seen_at || at,
        last_seen_at: at,
        quarantined,
      },
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, next);
  if (quarantined) {
    emitSafetyEvent({
      type: "daemon_phase_quarantined",
      subsystem: "daemon",
      status: "failure",
      errorClass: cause || "unknown",
      daemonInstanceId,
      metadata: {
        phase,
        cause,
        count,
        threshold,
      },
    });
  }
  return next;
}

export function readDaemonProgress({
  home = helmHome(),
  staleAfterMs = 15000,
  clock = nowMs,
} = {}) {
  const progress = readJsonIfExists(daemonProgressPath(home), null);
  const quarantine = readDaemonQuarantine({ home });
  if (!progress) {
    return {
      configured: false,
      current_phase: null,
      heartbeat_at: null,
      heartbeat_age_ms: null,
      no_progress: false,
      no_progress_reason: null,
      quarantine,
    };
  }
  const heartbeatMs = Date.parse(progress.heartbeat_at || "");
  const heartbeatAgeMs = Number.isFinite(heartbeatMs)
    ? Math.max(0, clock() - heartbeatMs)
    : null;
  const noProgress =
    progress.status === "running" &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs > staleAfterMs;
  return {
    configured: true,
    ...progress,
    heartbeat_age_ms: heartbeatAgeMs,
    no_progress: noProgress,
    no_progress_reason: noProgress ? "heartbeat_stale" : null,
    quarantine,
  };
}

function timeoutError(phase) {
  const err = new Error(`daemon phase timed out: ${phase}`);
  err.code = "daemon_phase_timeout";
  return err;
}

function tickBudgetError() {
  const err = new Error("daemon tick budget exhausted");
  err.code = "daemon_tick_budget";
  return err;
}

function daemonPhaseFailureCause(err) {
  if (typeof err?.code === "string" && err.code.length > 0) {
    return err.code;
  }
  if (err?.name === "AbortError") return "daemon_phase_aborted";
  if (
    typeof err?.name === "string" &&
    err.name.length > 0 &&
    err.name !== "Error"
  ) {
    return err.name;
  }
  return "daemon_phase_failed";
}

export async function runPhase({
  name,
  timeoutMs,
  parentSignal = null,
  daemonInstanceId = null,
  home = helmHome(),
  fn,
  now = nowIso,
  clock = nowMs,
  recordFailure = recordDaemonPhaseFailure,
} = {}) {
  if (!name) throw new Error("runPhase requires name");
  if (typeof fn !== "function") throw new Error("runPhase requires fn");
  const phaseStartedAt = now();
  writeDaemonProgress({
    home,
    daemonInstanceId,
    phase: name,
    status: "running",
    startedAt: phaseStartedAt,
    heartbeatAt: phaseStartedAt,
  });

  const controller = new AbortController();
  const signal = controller.signal;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  let timer = null;
  let timedOut = false;
  const startedMs = clock();
  try {
    const timeoutPromise =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort(timeoutError(name));
              reject(timeoutError(name));
            }, timeoutMs);
          })
        : null;
    const result = timeoutPromise
      ? await Promise.race([
          fn({
            signal,
            heartbeat: (metadata = {}) =>
              writeDaemonProgress({
                home,
                daemonInstanceId,
                phase: name,
                status: "running",
                startedAt: phaseStartedAt,
                heartbeatAt: now(),
                metadata,
              }),
          }),
          timeoutPromise,
        ])
      : await fn({
          signal,
          heartbeat: (metadata = {}) =>
            writeDaemonProgress({
              home,
              daemonInstanceId,
              phase: name,
              status: "running",
              startedAt: phaseStartedAt,
              heartbeatAt: now(),
              metadata,
            }),
        });
    if (timedOut) throw timeoutError(name);
    const finishedAt = now();
    writeDaemonProgress({
      home,
      daemonInstanceId,
      phase: name,
      status: "completed",
      startedAt: phaseStartedAt,
      heartbeatAt: finishedAt,
      metadata: { duration_ms: Math.max(0, clock() - startedMs) },
    });
    for (const cause of ["daemon_phase_timeout", "daemon_phase_failed"]) {
      clearDaemonPhaseFailureCause({
        daemonInstanceId,
        phase: name,
        cause,
        quarantine: readDaemonQuarantine({ home }),
        quarantinePath: daemonQuarantinePath(home),
        now,
      });
    }
    if (name === "scope_prune") {
      clearDaemonPhaseFailureCause({
        daemonInstanceId,
        phase: name,
        cause: "runtime_schema_newer",
        quarantine: readDaemonQuarantine({ home }),
        quarantinePath: daemonQuarantinePath(home),
        now,
      });
    }
    if (name === "dispatch_launch") {
      for (const cause of [
        "runtime_store_locked",
        "ReferenceError",
        "daemon_phase_aborted",
        "ENOSPC",
        20,
      ]) {
        clearDaemonPhaseFailureCause({
          daemonInstanceId,
          phase: name,
          cause,
          quarantine: readDaemonQuarantine({ home }),
          quarantinePath: daemonQuarantinePath(home),
          now,
        });
      }
    }
    if (shouldEmitPhaseResourceSample(name)) {
      appendDaemonPerfEvent({
        event: "daemon_phase_sample",
        type: "daemon_phase_sample",
        classification: "helm_control_plane",
        daemon_instance_id: daemonInstanceId,
        pid: process.pid,
        phase: name,
        status: "completed",
        duration_ms: Math.max(0, clock() - startedMs),
        ...(await phaseResourceSampleFields()),
      });
    }
    return {
      ok: true,
      phase: name,
      result,
      duration_ms: Math.max(0, clock() - startedMs),
    };
  } catch (err) {
    const cause = daemonPhaseFailureCause(err);
    const finishedAt = now();
    writeDaemonProgress({
      home,
      daemonInstanceId,
      phase: name,
      status: "failed",
      message: err?.message || String(err),
      startedAt: phaseStartedAt,
      heartbeatAt: finishedAt,
      metadata: {
        duration_ms: Math.max(0, clock() - startedMs),
        cause,
      },
    });
    const failureRecord = recordDaemonPhaseFailureSafely({
      recordFailure,
      home,
      daemonInstanceId,
      phase: name,
      cause,
      now,
    });
    if (shouldEmitPhaseResourceSample(name)) {
      appendDaemonPerfEvent({
        event: "daemon_phase_sample",
        type: "daemon_phase_sample",
        classification: "helm_control_plane",
        daemon_instance_id: daemonInstanceId,
        pid: process.pid,
        phase: name,
        status: "failed",
        duration_ms: Math.max(0, clock() - startedMs),
        error: err?.message || String(err),
        cause,
        ...(await phaseResourceSampleFields()),
      });
    }
    return {
      ok: false,
      phase: name,
      error: err?.message || String(err),
      cause,
      timed_out: cause === "daemon_phase_timeout",
      failure_recorded: failureRecord.recorded,
      failure_record_error: failureRecord.error,
      duration_ms: Math.max(0, clock() - startedMs),
    };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", abortFromParent);
  }
}

function scopeArgs(scope) {
  return ["--cwd", scope.cwd];
}

function schedulerWorkingDir(schedulerScriptPath) {
  return resolve(dirname(schedulerScriptPath), "..", "..");
}

function missingScopeReason(scope) {
  if (existsSync(scope.cwd)) return null;
  return "scope_cwd_missing";
}

function spawnDispatchChild(scope, schedulerScriptPath, instanceId) {
  const missingReason = missingScopeReason(scope);
  if (missingReason) {
    return {
      skipped: true,
      scope,
      code: 1,
      signal: null,
      ok: false,
      error: missingReason,
    };
  }

  const child = spawn(
    resolveNodeExecutable(),
    [
      schedulerScriptPath,
      "dispatch",
      ...scopeArgs(scope),
      "--json-only",
      "--no-drain",
      "--daemon-instance-id",
      instanceId,
    ],
    {
      cwd: schedulerWorkingDir(schedulerScriptPath),
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        HELM_DAEMON: "1",
        HELM_DAEMON_PID: String(process.pid),
      },
    },
  );

  return { child };
}

function inprocDispatchRequested() {
  return (
    process.env.HELM_DISPATCH_INPROC === "1" &&
    process.env.HELM_DISPATCH_INPROC_KILL_SWITCH !== "1"
  );
}

async function loadInprocDispatchDeps() {
  const [
    { isInprocDispatchEnabled, launchDispatchOnceInproc, runInprocDispatch },
    { startRun },
  ] = await Promise.all([
    import("./daemon_inproc_dispatch.mjs"),
    import("./dispatch_service.mjs"),
  ]);
  return {
    isInprocDispatchEnabled,
    launchDispatchOnceInproc,
    runInprocDispatch,
    startRun,
  };
}

export async function runDaemonLoop(opts) {
  const schedulerScriptPath = opts.schedulerScriptPath;
  const intervalSec = Number(opts.intervalSec || 10);
  const once = Boolean(opts.once);
  const inFlight = new Map();
  let stopped = false;

  // 3.4: dispatchExecutor is created after instanceId below (needs instanceId for telemetry).
  let singletonLock = null;
  const instanceId = `daemon_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const liveDelta = createDaemonLiveDeltaAttributor({
    daemonInstanceId: instanceId,
    statusPortBind: opts.statusPortBind || null,
  });

  // The optional bounded executor keeps evaluation off-tick; once/kill-switch
  // paths retain their direct launch behavior.
  const inprocDispatchDeps = inprocDispatchRequested()
    ? await loadInprocDispatchDeps()
    : null;
  const dispatchExecutor =
    once || !inprocDispatchDeps
      ? null
      : createDispatchExecutor({
          evaluateFn: async (scope, evalOpts) => {
            // Full per-scope work: load + evaluate + startRun (all off-tick).
            // Mirrors the fire-and-forget body from task 3.3's launchDispatch branch,
            // but now runs in a bounded executor slot so the cap is enforced globally.
            let jobs, activeRunsResult;
            try {
              ({ jobs } = loadDispatchJobsReadOnly(scope));
              activeRunsResult = loadActiveRunsReadOnly(scope);
            } catch (err) {
              process.stderr.write(
                `helm daemon executor load failed for ${scope.scope_id}: ${err?.message || err}\n`,
              );
              return { jobDecisions: [] };
            }
            return inprocDispatchDeps
              .runInprocDispatch(scope, {
                at: evalOpts.at || new Date().toISOString(),
                jobs,
                activeRuns: activeRunsResult,
                startRunFn: inprocDispatchDeps.startRun,
                daemonInstanceId: instanceId,
              })
              .catch((err) => {
                process.stderr.write(
                  `helm daemon executor eval failed for ${scope.scope_id}: ${err?.message || err}\n`,
                );
                return { jobDecisions: [] };
              });
          },
          onDeferred: (entry) => {
            // Visible deferral: mirrors the scope_dispatch_deferred activity event
            // so deferrals are never silent (0 silent drops guarantee).
            appendActivityEvent({
              event_type: "scope_dispatch_deferred",
              daemon_instance_id: instanceId,
              metadata: {
                deferred_scope_count: 1,
                launched_scope_count: 0,
                aborted: false,
                max_concurrent_dispatches: maxConcurrentDispatches(),
                reasons: { concurrency_cap: 1 },
                scope_ids: [entry.scope?.scope_id || null],
              },
            });
          },
        });

  let tickCounter = 0;

  if (once) {
    const earlyPruned = pruneMissingScopes();
    for (const entry of earlyPruned.removed) {
      process.stderr.write(`helm daemon pruned stale ${entry.scope_id}\n`);
    }
  }

  // Singleton guard: refuse to start a second long-running daemon for the same
  // HELM_HOME. `--once` runs (used by tests/dispatch checks) skip the lock so
  // they can coexist with the resident daemon. See COE 2026-05-05.
  if (!once) {
    const home = helmHome();
    if (!existsSync(home)) {
      process.stderr.write(
        `helm daemon refusing to start: HELM_HOME missing (${home})\n`,
      );
      return [];
    }
    const lock = acquireDaemonSingletonLock({
      home,
      daemonInstanceId: instanceId,
      statusPortBind: opts.statusPortBind || null,
    });
    if (!lock.acquired) {
      const holderText = lock.holder ? ` (pid=${lock.holder})` : "";
      const operatorReason =
        lock.reason === "singleton_holder_live"
          ? "already running (singleton_holder_live)"
          : lock.reason;
      process.stderr.write(
        `helm daemon singleton refused${holderText}: ${operatorReason}\n`,
      );
      return [];
    }
    singletonLock = lock;
    liveDelta.checkpoint("singleton_acquired");
  }

  const shutdown = () => {
    stopped = true;
    if (singletonLock) {
      releaseDaemonSingletonLock(singletonLock);
      singletonLock = null;
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", () => {
    if (singletonLock) releaseDaemonSingletonLock(singletonLock);
  });

  appendActivityEvent({
    event_type: "daemon_started",
    daemon_instance_id: instanceId,
    metadata: {
      interval_sec: intervalSec,
      once,
    },
  });
  trackHealthTransition("service", "ok", {
    daemon_instance_id: instanceId,
  });
  try {
    writeDaemonFreshness({ schedulerScriptPath, daemonInstanceId: instanceId });
  } catch (err) {
    process.stderr.write(
      `helm daemon freshness record failed: ${err.message}\n`,
    );
  }

  const startupPruned = pruneMissingScopes();
  for (const entry of startupPruned.removed) {
    process.stderr.write(`helm daemon pruned stale ${entry.scope_id}\n`);
  }

  const launchDispatch = (scope) => {
    const key = scope.scope_id;
    const useScopeSingleFlight = process.env.HELM_SKYHOOK !== "1";
    if (useScopeSingleFlight && inFlight.has(key)) {
      return { skipped: true, scope, reason: "dispatch_child_in_flight" };
    }

    // In-process dispatch (HELM_DISPATCH_INPROC=1) does NOT run here. The
    // continuous loop routes due scopes through the off-tick dispatchExecutor
    // (createDispatchExecutor above), and --once uses launchDispatchOnceInproc.
    // launchDispatch is only reached on the fork path (flag off or kill-switch),
    // so this body is always the fork path — byte-identical to prior behaviour.
    const launched = spawnDispatchChild(scope, schedulerScriptPath, instanceId);
    if (launched.skipped) {
      process.stderr.write(
        `helm daemon skipped ${scope.scope_id}: ${launched.error}\n`,
      );
      return launched;
    }
    const { child } = launched;
    const launchedAtMs = Date.now();

    // Phase 0 firehose cut: emit only launch/error/close (single_flight_released removed).
    // classifyChildKind inspects the dispatch argv — spawnDispatchChild always passes
    // 'dispatch' as the second argv element, making every dispatch child a dispatch_evaluator.
    const dispatchArgv = [schedulerScriptPath, "dispatch"];
    const childKind = classifyChildKind(dispatchArgv);

    const launchRecord = buildChildSampleRecord({
      lifecycle: "launch",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      pid: child.pid || null,
      child_kind: childKind,
      daemon_instance_id: instanceId,
      single_flight_enabled: useScopeSingleFlight,
    });
    if (launchRecord) appendDaemonPerfEvent(launchRecord);

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    let singleFlightTimer = null;
    if (
      useScopeSingleFlight &&
      Number.isFinite(DISPATCH_CHILD_SINGLE_FLIGHT_MS) &&
      DISPATCH_CHILD_SINGLE_FLIGHT_MS > 0
    ) {
      singleFlightTimer = setTimeout(() => {
        if (inFlight.get(key) !== child) return;
        inFlight.delete(key);
        // Activity event still emitted for single-flight release tracking; no perf row.
        appendActivityEvent({
          event_type: "scope_dispatch_single_flight_released",
          daemon_instance_id: instanceId,
          scope_id: scope.scope_id,
          cwd: scope.cwd,
          metadata: {
            dispatch_child_pid: child.pid || null,
            elapsed_ms: DISPATCH_CHILD_SINGLE_FLIGHT_MS,
          },
        });
        // single_flight_released perf row intentionally removed (Phase 0 firehose cut).
      }, DISPATCH_CHILD_SINGLE_FLIGHT_MS);
      singleFlightTimer.unref?.();
    }

    child.on("error", (err) => {
      process.stderr.write(
        `helm daemon failed to spawn ${scope.scope_id}: ${err.message}\n`,
      );
      if (singleFlightTimer) clearTimeout(singleFlightTimer);
      if (useScopeSingleFlight) inFlight.delete(key);
      const errorRecord = buildChildSampleRecord({
        lifecycle: "error",
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        pid: child.pid || null,
        child_kind: childKind,
        daemon_instance_id: instanceId,
        duration_ms: Date.now() - launchedAtMs,
        error: err?.message || String(err),
      });
      if (errorRecord) appendDaemonPerfEvent(errorRecord);
    });

    child.on("close", (code, signal) => {
      if (singleFlightTimer) clearTimeout(singleFlightTimer);
      const releaseStatus =
        useScopeSingleFlight && inFlight.get(key) === child
          ? "released_on_close"
          : useScopeSingleFlight
            ? "already_released"
            : "not_enabled";
      if (useScopeSingleFlight) inFlight.delete(key);
      const closeRecord = buildChildSampleRecord({
        lifecycle: "close",
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        pid: child.pid || null,
        child_kind: childKind,
        daemon_instance_id: instanceId,
        duration_ms: Date.now() - launchedAtMs,
        code,
        signal,
        single_flight_release_status: releaseStatus,
      });
      if (closeRecord) appendDaemonPerfEvent(closeRecord);
    });

    if (useScopeSingleFlight) inFlight.set(key, child);
    return launched;
  };

  const runOnce = async () => {
    const tickBudgetMs = Number(
      opts.tickBudgetMs || process.env.HELM_DAEMON_TICK_BUDGET_MS || 45000,
    );
    const phaseTimeoutMs = Number(
      opts.phaseTimeoutMs ||
        process.env.HELM_DAEMON_PHASE_TIMEOUT_MS ||
        DEFAULT_DAEMON_PHASE_TIMEOUT_MS,
    );
    const dispatchLaunchTimeoutMs = Number(
      opts.dispatchLaunchTimeoutMs ||
        process.env.HELM_DAEMON_DISPATCH_LAUNCH_TIMEOUT_MS ||
        DEFAULT_DISPATCH_LAUNCH_TIMEOUT_MS,
    );
    const tickController = new AbortController();
    const tickTimer = setTimeout(
      () => tickController.abort(tickBudgetError()),
      tickBudgetMs,
    );
    tickTimer.unref?.();
    const runTickPhase = async (
      name,
      fn,
      timeoutMs = phaseTimeoutFor(name, {
        phaseTimeoutMs,
        dispatchLaunchTimeoutMs,
      }),
    ) => {
      const result = await runPhase({
        name,
        timeoutMs,
        parentSignal: tickController.signal,
        daemonInstanceId: instanceId,
        fn,
      });
      if (!result.ok) {
        process.stderr.write(
          `helm daemon phase ${name} failed: ${result.error}\n`,
        );
      }
      liveDelta.phase(name, result);
      return result;
    };
    try {
      await runTickPhase("scope_prune", async () => {
        const pruned = pruneMissingScopes();
        for (const entry of pruned.removed) {
          process.stderr.write(`helm daemon pruned stale ${entry.scope_id}\n`);
        }
      });

      await runTickPhase("health_projection", async ({ heartbeat }) => {
        const service = residentDaemonServiceSnapshot();
        const registry = listRegisteredScopesLegacy();
        for (const entry of registry) {
          heartbeat({ scope_id: entry.scope_id });
          if (!existsSync(entry.cwd)) continue;
          const scope = resolveScope({ cwd: entry.cwd });
          const health = runtimeHealth(
            loadRuntime(scope),
            service,
            entry.registered_at || null,
          );
          const streamState = projectHealthStreamState(health);
          if (!streamState) continue;
          trackHealthTransition(`scope:${entry.scope_id}`, streamState, {
            daemon_instance_id: instanceId,
            scope_id: entry.scope_id,
            cwd: entry.cwd,
            reason: health.reason,
            metadata: {
              dispatch_stale_seconds: health.dispatch_stale_seconds ?? null,
            },
          });
        }
      });

      const scopes = hydrateRegisteredScopesLegacy();
      await runTickPhase("lease_watchdog", async ({ heartbeat }) => {
        for (const scope of scopes) {
          heartbeat({ scope_id: scope.scope_id });
          try {
            const reaped = reapStaleLease(scope);
            if (reaped.reaped) {
              appendActivityEvent({
                event_type: "dispatch_lease_reaped",
                daemon_instance_id: instanceId,
                scope_id: scope.scope_id,
                cwd: scope.cwd,
                metadata: {
                  holder_pid: reaped.holder_pid,
                  owner: reaped.owner,
                  age_sec: reaped.age_sec,
                  killed: reaped.killed,
                },
              });
              process.stderr.write(
                `helm daemon reaped stale lease ${scope.scope_id} (pid=${reaped.holder_pid}, age=${Math.round(reaped.age_sec)}s)\n`,
              );
            }
          } catch (err) {
            process.stderr.write(
              `helm daemon lease watchdog failed for ${scope.scope_id}: ${err.message}\n`,
            );
          }
        }
      });

      // Retention preserves events/logs pruning and runtime-ledger GC/VACUUM.
      await runTickPhase("retention_gc", async ({ signal }) => {
        if (!shouldRunRetentionForDaemon()) return;
        const child = await runDaemonMaintenanceChild({
          schedulerScriptPath,
          command: "retention-gc",
          daemonInstanceId: instanceId,
          signal,
          timeoutMs: phaseTimeoutFor("retention_gc", {
            phaseTimeoutMs,
            dispatchLaunchTimeoutMs,
          }),
        });
        if (!child.ok) {
          throw new Error(child.error || "retention child failed");
        }
        const summary = child.data?.result || null;
        if (summary) {
          process.stderr.write(
            `helm daemon retention sweep: ledger -${summary.ledger.logical_runs_deleted} runs, events -${summary.prune.events_deleted} (${summary.duration_ms}ms)\n`,
          );
        }
      });

      // Phase 1A: reconcile due-projection against jobs.json truth every
      // ALARM_CHECK_TICKS ticks (~200 s). Reuses existing cadence constant.
      await runTickPhase("due_projection_reconcile", async ({ signal }) => {
        if (tickCounter % ALARM_CHECK_TICKS !== 0) return;
        const child = await runDaemonMaintenanceChild({
          schedulerScriptPath,
          command: "due-reconcile",
          daemonInstanceId: instanceId,
          signal,
          timeoutMs: phaseTimeoutFor("due_projection_reconcile", {
            phaseTimeoutMs,
            dispatchLaunchTimeoutMs,
          }),
        });
        if (!child.ok) {
          throw new Error(child.error || "due reconcile child failed");
        }
      });

      tickCounter += 1;
      await runTickPhase("tick_freshness", async () => writeDaemonLastTick());

      const dispatch = await runTickPhase(
        "dispatch_launch",
        async ({ signal }) => {
          const plan = await registryDispatchPlan({ once });
          liveDelta.dispatchScan(plan, dispatchExecutor);
          for (const skipped of plan.skipped) {
            if (!shouldEmitScopeDispatchSkipped(skipped, plan)) continue;
            appendActivityEvent({
              event_type: "scope_dispatch_skipped",
              daemon_instance_id: instanceId,
              scope_id: skipped.scope_id,
              cwd: skipped.cwd,
              reason: skipped.reason,
              metadata: {
                registry_generation: skipped.generation ?? plan.generation,
                authoritative_registry: plan.authoritative,
                error: skipped.error || null,
              },
            });
          }
          pruneScopeDispatchSkipState(plan);
          // Default-on due admission: one indexed query; unavailable = classify.
          const dispatchAtIso = process.env.HELM_NOW
            ? new Date(process.env.HELM_NOW).toISOString()
            : new Date().toISOString();
          const residentSqliteDispatch =
            once || process.env.HELM_DAEMON_RESIDENT_SQLITE_DISPATCH === "1";
          const dueAdmission =
            residentSqliteDispatch && isGlobalDueAdmissionEnabledForDaemon()
              ? (await loadDispatchDueQueryModule()).queryDueScopesFast({
                  atIso: dispatchAtIso,
                })
              : null;
          const dueScopes = dueAdmission?.available ? dueAdmission : null;
          const airlock = await prepareAirlockDispatch({
            plan,
            daemonInstanceId: instanceId,
            appendActivityEvent,
            appendPerfEvent: appendDaemonPerfEvent,
            memorySample: inProcessMemorySample,
            unavailableScopeIds: once ? new Set() : new Set(inFlight.keys()),
            dueScopes,
            globalDueQueryFallbackReason:
              dueAdmission?.available === false
                ? dueAdmission.reason
                : residentSqliteDispatch
                  ? null
                  : "resident_sqlite_dispatch_disabled",
            emitDueShadowSample: residentSqliteDispatch,
          });
          for (const result of airlock.idleSkippedResults) {
            if (result.scope) {
              markDispatchObserved(result.scope, "idle", instanceId);
            }
          }
          const protection = await prepareInfrastructureProtectedDispatch({
            scopes: airlock.dispatchScopes,
            appendActivityEvent,
            daemonInstanceId: instanceId,
          });
          const dispatchScopes = protection.dispatchScopes;
          if (once) {
            // 3.3: once-path also uses the in-process evaluator when flag is on.
            const launchedResults =
              inprocDispatchDeps?.isInprocDispatchEnabled()
                ? await inprocDispatchDeps.launchDispatchOnceInproc({
                    dispatchScopes,
                    startRunFn: inprocDispatchDeps.startRun,
                    loadJobsFn: loadDispatchJobsReadOnly,
                    loadActiveRunsFn: loadActiveRunsReadOnly,
                    daemonInstanceId: instanceId,
                  })
                : await launchDispatchOnceForAirlock({
                    dispatchScopes,
                    schedulerScriptPath,
                    daemonInstanceId: instanceId,
                    spawnDispatchChild,
                    appendPerfEvent: appendDaemonPerfEvent,
                  });
            airlock.recordPrefilterSample({
              launchedScopeCount: launchedResults.filter(
                (result) => result.ok && !result.skipped,
              ).length,
            });
            return [
              ...plan.skipped.map((skipped) => ({
                scope: skipped.scope_id
                  ? resolveScope({ cwd: skipped.cwd || skipped.scope_id })
                  : null,
                ok: true,
                skipped: true,
                reason: skipped.reason,
                registry_generation: skipped.generation ?? plan.generation,
              })),
              ...airlock.idleSkippedResults,
              ...airlock.deferredResults,
              ...protection.deferredResults,
              ...launchedResults,
            ];
          }

          // Enqueue only so evaluation cannot starve other daemon phases.
          if (dispatchExecutor) {
            const atIso = new Date().toISOString();
            let enqueuedCount = 0;
            for (const scope of dispatchScopes) {
              const result = dispatchExecutor.enqueue(scope, {
                at: atIso,
                daemonInstanceId: instanceId,
              });
              if (result?.enqueued) {
                enqueuedCount++;
              }
            }
            // Record the prefilter sample with the enqueue count (not launch count —
            // evaluation happens off-tick; use enqueued as the "admitted" proxy).
            airlock.recordPrefilterSample({
              launchedScopeCount: enqueuedCount,
            });
            return [];
          }

          // Fork path (flag off or kill-switch on): launchDispatchScopesCooperatively
          // handles concurrency cap, stagger, and visible deferrals unchanged.
          const launched = await launchDispatchScopesCooperatively({
            scopes: dispatchScopes,
            signal,
            launchDispatch,
            staggerMs: DEFAULT_DISPATCH_LAUNCH_STAGGER_MS,
            currentInFlightCount: () => inFlight.size,
          });
          if (launched.deferred?.length) {
            const durableDeferral = await recordInfrastructureDispatchDeferrals(
              launched.deferred,
            );
            appendActivityEvent({
              event_type: "scope_dispatch_deferred",
              daemon_instance_id: instanceId,
              metadata: {
                deferred_scope_count: launched.deferred.length,
                launched_scope_count: launched.launchedCount,
                aborted: Boolean(launched.aborted),
                durable_deferral: durableDeferral,
                max_concurrent_dispatches: maxConcurrentDispatches(),
                reasons: launched.deferred.reduce((acc, d) => {
                  acc[d.reason] = (acc[d.reason] || 0) + 1;
                  return acc;
                }, {}),
                scope_ids: launched.deferred
                  .slice(0, 20)
                  .map((d) => d.scope?.scope_id || null),
              },
            });
          }
          airlock.recordPrefilterSample({
            launchedScopeCount: launched.launchedCount,
          });
          return [];
        },
      );
      return dispatch.ok ? dispatch.result : [];
    } finally {
      clearTimeout(tickTimer);
    }
  };

  // Spawner-pid watchdog: if HELM_DAEMON_PARENT_PID is set (only when the daemon
  // was forked by another process — fake-mode service start, test harness, etc.)
  // self-exit when the original parent goes away. Catches the orphan path even
  // when HELM_HOME is preserved on disk, e.g. test runner SIGKILLed before
  // afterEach cleanup. The launchd-managed singleton has no parent-pid tag,
  // so this check is a no-op for production. See COE 2026-05-05.
  const parentPidRaw = process.env.HELM_DAEMON_PARENT_PID;
  const parentPid =
    parentPidRaw && /^\d+$/.test(parentPidRaw) ? Number(parentPidRaw) : null;
  const unownedFakeServiceDaemon =
    process.env.HELM_SERVICE_MODE === "fake" &&
    process.env.HELM_FAKE_SERVICE_DAEMON === "1" &&
    parentPid === null &&
    process.env.HELM_ALLOW_UNOWNED_FAKE_DAEMON !== "1";

  // Consecutive watchdog samples that saw the pidfile owned by a different live
  // pid. Only OWNERSHIP_LOST_CONFIRM_TICKS in a row confirm a real handoff; a
  // single transient/torn read no longer kills a healthy daemon.
  let pidfileMismatchStreak = 0;

  const shouldSelfExit = () => {
    // Self-exit if the HELM_HOME this daemon was bound to has been deleted.
    // Tests use ephemeral HELM_HOME tmp dirs that get rm-rf'd on cleanup; without
    // this check, detached daemons leak as orphans (COE 2026-05-05).
    if (!once && !existsSync(helmHome())) {
      process.stderr.write(
        `helm daemon HELM_HOME deleted (${helmHome()}); exiting\n`,
      );
      appendActivityEvent({
        event_type: "daemon_self_exit",
        daemon_instance_id: instanceId,
        metadata: { reason: "helm_home_missing", helm_home: helmHome() },
      });
      return true;
    }
    if (!once) {
      const boundPid = readDaemonPidFileForHome(helmHome());
      const ownership = evaluateOwnershipLost({
        boundPid,
        selfPid: process.pid,
        streak: pidfileMismatchStreak,
      });
      pidfileMismatchStreak = ownership.streak;
      if (ownership.lost) {
        process.stderr.write(
          `helm daemon pidfile ownership lost (${helmHome()}); exiting\n`,
        );
        appendActivityEvent({
          event_type: "daemon_self_exit",
          daemon_instance_id: instanceId,
          metadata: {
            reason: "pidfile_ownership_lost",
            detail_reason: ownership.reason,
            helm_home: helmHome(),
            bound_pid: boundPid,
            pid: process.pid,
            confirm_ticks: OWNERSHIP_LOST_CONFIRM_TICKS,
          },
        });
        return true;
      }
    }
    if (!once && parentPid !== null && !isProcessAlive(parentPid)) {
      process.stderr.write(
        `helm daemon parent (pid=${parentPid}) gone; exiting\n`,
      );
      appendActivityEvent({
        event_type: "daemon_self_exit",
        daemon_instance_id: instanceId,
        metadata: { reason: "parent_pid_gone", parent_pid: parentPid },
      });
      return true;
    }
    if (!once && unownedFakeServiceDaemon) {
      process.stderr.write(
        "helm fake service daemon missing HELM_DAEMON_PARENT_PID; exiting to avoid orphan\n",
      );
      appendActivityEvent({
        event_type: "daemon_self_exit",
        daemon_instance_id: instanceId,
        metadata: { reason: "unowned_fake_service_daemon" },
      });
      return true;
    }
    return false;
  };

  const sleepUntilNextTick = async () => {
    const deadline = Date.now() + intervalSec * 1000;
    const pollUntilDeadline = async () => {
      if (stopped || Date.now() >= deadline) return;
      const remainingMs = deadline - Date.now();
      // Watchdog checks must run serially so daemon shutdown observes the latest
      // filesystem/parent state before the next dispatch tick.
      await sleep(Math.min(1000, remainingMs));
      if (shouldSelfExit()) {
        stopped = true;
        return;
      }
      await pollUntilDeadline();
    };
    await pollUntilDeadline();
  };

  let onceResults = [];
  const runLoop = async () => {
    if (shouldSelfExit()) return;
    onceResults = await runOnce();
    if (once || stopped) return;
    // Preserve dispatch cadence while still checking shutdown conditions in
    // one-second chunks.
    await sleepUntilNextTick();
    if (!stopped) await runLoop();
  };
  await runLoop();

  if (singletonLock) releaseDaemonSingletonLock(singletonLock);
  return onceResults;
}

export const _internals = {
  launchDispatchScopesCooperatively,
  effectiveDispatchStaggerMs,
  phaseTimeoutFor,
  classifyScopeDueForDispatch,
  applyDispatchAdmission,
};
