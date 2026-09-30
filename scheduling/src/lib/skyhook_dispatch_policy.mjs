import { managedAgentProcessDescriptor } from "./agent_fallback.mjs";

const ACTIVE_LAUNCHES = new Set();
const LAUNCH_TIMESTAMPS = [];
const RAW_AGENT_STARTUP_WINDOW_MS = 30_000;
const MANAGED_PROVIDER_STARTUP_WINDOW_MS = 90_000;

function skyhookDispatchEnabled() {
  return (
    process.env.HELM_SKYHOOK_KILL_SWITCH !== "1" &&
    process.env.HELM_SKYHOOK_DISABLED !== "1"
  );
}

function isManagedProviderJob(job) {
  const provider = job?.execution_hints?.provider;
  return typeof provider === "string" && provider.trim().length > 0;
}

export function skyhookStartupWindowMs(job = null) {
  const raw = Number.parseInt(process.env.HELM_SKYHOOK_STARTUP_WINDOW_MS, 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return isManagedProviderJob(job)
    ? MANAGED_PROVIDER_STARTUP_WINDOW_MS
    : RAW_AGENT_STARTUP_WINDOW_MS;
}

function isSkyhookAgentJob(job) {
  if (managedAgentProcessDescriptor(job?.process || {})) return true;
  return isManagedProviderJob(job);
}

function requiresManagedSession(job) {
  const hints = job?.execution_hints || {};
  return (
    hints.session_required === true ||
    hints.managed === true ||
    Boolean(hints.provider)
  );
}

export function skyhookRolloutEnabledFor(job) {
  if (!skyhookDispatchEnabled()) return false;
  if (managedAgentProcessDescriptor(job?.process || {})) return true;
  if (!isSkyhookAgentJob(job)) return false;
  if (!requiresManagedSession(job)) return false;
  return true;
}

function positiveEnvInt(name, fallback) {
  const raw = Number.parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function acquireSkyhookAdmission(runId, nowMs = Date.now()) {
  const cap = positiveEnvInt("HELM_SKYHOOK_GLOBAL_CAP", 4);
  if (ACTIVE_LAUNCHES.size >= cap) {
    return { admitted: false, reason: "skyhook_global_cap_saturated", cap };
  }

  const windowStart = nowMs - 1000;
  while (LAUNCH_TIMESTAMPS.length > 0 && LAUNCH_TIMESTAMPS[0] < windowStart) {
    LAUNCH_TIMESTAMPS.shift();
  }
  const rate = positiveEnvInt("HELM_SKYHOOK_LAUNCH_RATE_PER_SEC", 4);
  if (LAUNCH_TIMESTAMPS.length >= rate) {
    return { admitted: false, reason: "skyhook_launch_rate_limited", rate };
  }

  ACTIVE_LAUNCHES.add(runId);
  LAUNCH_TIMESTAMPS.push(nowMs);
  return {
    admitted: true,
    release() {
      ACTIVE_LAUNCHES.delete(runId);
    },
  };
}
