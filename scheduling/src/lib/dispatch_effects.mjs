/**
 * dispatch_effects.mjs — effects and precondition helpers (Halcyon H2).
 *
 * executeDispatchDecision(scope, launch, opts) → { skipped, handle }
 * evaluatePreconditions(job, atIso) → { action }
 * evaluateConditionsSync(job) → { met, reason? }
 */
import { computeNextAfterRun } from "./schedule_eval.mjs";
import { probeNetwork, providerHostFor } from "./network_probe.mjs";
import { bypassesNetworkPrecondition } from "./network_precondition_policy.mjs";
import { infrastructureDeferredSlot } from "./dispatch_infrastructure_marker.mjs";
import { existsSync } from "node:fs";

export function evaluateConditionsSync(job) {
  const conditions = job.conditions;
  if (!conditions) return { met: true };
  if (conditions.file_exists && !existsSync(conditions.file_exists))
    return { met: false, reason: `file_not_found:${conditions.file_exists}` };
  if (conditions.env_set && !process.env[conditions.env_set])
    return { met: false, reason: `env_not_set:${conditions.env_set}` };
  return { met: true };
}

function preconditionsEnabled(job) {
  if (process.env.HELM_DISABLE_NETWORK_PRECONDITION === "1") return false;
  if (bypassesNetworkPrecondition(job)) {
    process.stderr.write(
      `[🪳 TEMP DEFERRAL_AGE] bypassing network precondition for heartbeat job=${job.id}\n`,
    );
    return false;
  }
  return job.schedule?.preconditions?.network === true;
}

function shouldExpireDeferral(job, atIso) {
  if (!job.state?.deferred_since) return false;
  if (job.schedule?.type === "once") return false;
  const next = computeNextAfterRun(
    job,
    job.state.deferred_since,
    job.state.deferred_since,
  );
  if (!next?.next_run_at) return false;
  return new Date(atIso) >= new Date(next.next_run_at);
}

export async function evaluatePreconditions(job, atIso) {
  if (!preconditionsEnabled(job)) return { action: "proceed" };
  let probe;
  try {
    const explicitHost = job.schedule.preconditions.network_host;
    const derivedHost =
      explicitHost || providerHostFor(job.execution_hints?.provider);
    probe = await probeNetwork({
      hosts: derivedHost ? [derivedHost] : undefined,
    });
  } catch {
    return { action: "proceed" };
  }
  if (probe.online) {
    if (job.state?.deferred_since || infrastructureDeferredSlot(job))
      return { action: "coalesce" };
    return { action: "proceed" };
  }
  if (shouldExpireDeferral(job, atIso))
    return { action: "expire_and_skip", reason: "network_deferral_expired" };
  return { action: "defer", reason: probe.reason || "network_offline" };
}

/**
 * executeDispatchDecision — effects layer for a single launch decision.
 * opts.startRunFn(scope, job, launchOpts) must call startRun with lock-retry.
 */
export async function executeDispatchDecision(scope, launch, opts = {}) {
  if (!launch || !launch.job) return null;
  const { job, scheduledAt } = launch;
  const { startRunFn, daemonInstanceId = null, drainCompletions = true } = opts;
  if (typeof startRunFn !== "function")
    throw new Error("executeDispatchDecision: opts.startRunFn is required");
  const handle = await startRunFn(scope, job, {
    reason: "scheduled",
    scheduledAt,
    schedulerScriptPath: opts.schedulerScriptPath,
    jsonOnly: opts.jsonOnly,
    daemonInstanceId,
    baselineUpdatedAt: opts.baselineUpdatedAt ?? job.meta?.updated_at ?? null,
    drainCompletions,
    consumedInfrastructureSlot:
      launch.consumedInfrastructureSlot || scheduledAt,
  });
  return { skipped: handle === null, handle };
}
