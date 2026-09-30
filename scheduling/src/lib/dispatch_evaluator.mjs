/** Pure dispatch decisions (Halcyon H2); job state is mutated in place. */
import {
  computeInitialNextRun,
  computeNextAfterRun,
  parseEvery,
  computeNextForRecurring,
} from "./schedule_eval.mjs";
import {
  evaluateConditionsSync,
  evaluatePreconditions,
} from "./dispatch_effects.mjs";
import {
  infrastructureDeferredSlot,
  migrateLegacyInfrastructureMarker,
} from "./dispatch_infrastructure_marker.mjs";

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function clearOrdinaryDeferral(job) {
  job.state.deferred_since = job.state.deferred_reason = null;
}

export function dueScheduleSlots(job, atIso, maxCatchupRuns) {
  if (!job.state.enabled) return { due: false, slots: [], reason: "disabled" };
  let scheduledAt = job.state.next_run_at || computeInitialNextRun(job, atIso);
  if (!scheduledAt) return { due: false, slots: [], reason: "no_next_run" };
  if (new Date(atIso) < new Date(scheduledAt))
    return {
      due: false,
      slots: [],
      reason: "not_due",
      next_run_at: scheduledAt,
    };

  const atMs = new Date(atIso).getTime();
  const scheduledMs = new Date(scheduledAt).getTime();
  const infrastructureProtected =
    infrastructureDeferredSlot(job) === scheduledAt;
  const missed = atMs > scheduledMs;
  const policy = job.schedule?.missed_run_policy || "skip";
  const defaultGraceSec = Number.isInteger(job.schedule?.misfire_grace_sec)
    ? job.schedule.misfire_grace_sec
    : 300;

  if (
    missed &&
    policy === "skip" &&
    !infrastructureProtected &&
    atMs > scheduledMs + defaultGraceSec * 1000
  ) {
    return {
      due: false,
      slots: [],
      skipped: [{ scheduled_at: scheduledAt, reason: "missed_run_skipped" }],
      skip_state: advanceAfterOverflow(job, scheduledAt, atIso),
    };
  }

  if (missed && policy === "run_once_if_missed") {
    const deadline = job.schedule?.run_once_deadline_at
      ? new Date(job.schedule.run_once_deadline_at).getTime()
      : null;
    const graceSec = Number.isInteger(job.schedule?.misfire_grace_sec)
      ? job.schedule.misfire_grace_sec
      : 0;
    const withinDeadline = deadline === null || atMs <= deadline;
    const withinGrace = atMs <= scheduledMs + graceSec * 1000;
    if (!withinDeadline || (!withinGrace && !infrastructureProtected)) {
      const next =
        job.schedule.type === "once"
          ? { next_run_at: null, enabled: false }
          : advanceAfterOverflow(job, scheduledAt, atIso);
      return {
        due: false,
        slots: [],
        skipped: [
          { scheduled_at: scheduledAt, reason: "missed_run_grace_expired" },
        ],
        skip_state: next,
      };
    }
  }

  if (missed && policy === "latest_only") {
    const dueSlots = dueSlotsThrough(job, scheduledAt, atIso);
    if (dueSlots.length > 1) {
      return {
        due: true,
        slots: dueSlots.slice(-1),
        skipped: dueSlots
          .slice(0, -1)
          .map((s) => ({ scheduled_at: s, reason: "latest_only_coalesced" })),
        overflow: false,
        overflow_next: null,
      };
    }
  }

  const slots = [];
  let overflowNext = null;
  let overflowReason = "catchup_overflow";
  const estimatedCost = Number.isFinite(job.schedule?.estimated_catchup_cost)
    ? job.schedule.estimated_catchup_cost
    : 0;
  const maxCost = Number.isFinite(job.schedule?.max_catchup_cost)
    ? job.schedule.max_catchup_cost
    : null;

  while (scheduledAt && new Date(atIso) >= new Date(scheduledAt)) {
    if (
      job.schedule.end_at &&
      new Date(scheduledAt) > new Date(job.schedule.end_at)
    )
      break;
    if (
      policy === "bounded_catchup" &&
      maxCost !== null &&
      estimatedCost > 0 &&
      (slots.length + 1) * estimatedCost > maxCost
    ) {
      overflowNext = scheduledAt;
      overflowReason = "catchup_cost_cap";
      break;
    }
    if (slots.length >= maxCatchupRuns) {
      overflowNext = scheduledAt;
      break;
    }
    slots.push(scheduledAt);
    const next = computeNextAfterRun(job, scheduledAt, scheduledAt);
    if (!next.enabled || !next.next_run_at) {
      scheduledAt = null;
      break;
    }
    scheduledAt = next.next_run_at;
  }

  if (
    slots.length === 0 &&
    job.schedule.end_at &&
    new Date(atIso) > new Date(job.schedule.end_at)
  )
    return { due: false, slots: [], reason: "past_end_at" };

  return {
    due: slots.length > 0,
    slots,
    overflow: Boolean(overflowNext),
    overflow_next: overflowNext,
    overflow_reason: overflowReason,
  };
}

function dueSlotsThrough(job, firstScheduledAt, atIso) {
  const slots = [];
  let scheduledAt = firstScheduledAt;
  while (scheduledAt && new Date(atIso) >= new Date(scheduledAt)) {
    if (
      job.schedule.end_at &&
      new Date(scheduledAt) > new Date(job.schedule.end_at)
    )
      break;
    slots.push(scheduledAt);
    const next = computeNextAfterRun(job, scheduledAt, scheduledAt);
    if (!next.enabled || !next.next_run_at) break;
    scheduledAt = next.next_run_at;
  }
  return slots;
}

export function advanceAfterOverflow(job, firstSkippedAt, atIso) {
  if (job.schedule.type === "once")
    return { next_run_at: null, enabled: false };
  if (job.schedule.type === "interval") {
    const ms = parseEvery(job.schedule.every);
    if (!ms) return { next_run_at: null, enabled: false };
    const base = new Date(firstSkippedAt).getTime();
    const nowMs = new Date(atIso).getTime();
    const jumps = Math.floor((nowMs - base) / ms) + 1;
    return {
      next_run_at: new Date(base + jumps * ms).toISOString(),
      enabled: true,
    };
  }
  if (job.schedule.type === "recurring") {
    return {
      next_run_at: computeNextForRecurring(
        job.schedule.cron,
        job.schedule.timezone,
        atIso,
      ),
      enabled: true,
    };
  }
  return { next_run_at: null, enabled: false };
}

export async function evaluateScopeDispatch(
  scope,
  { at, jobs, activeRuns = {}, maxCatchupRuns = 1, dryRun = false } = {},
) {
  const jobDecisions = [];
  for (const job of jobs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const d = await _evaluateOneJob(
        job,
        at,
        activeRuns,
        maxCatchupRuns,
        dryRun,
      );
      if (d) jobDecisions.push(d);
    } catch (err) {
      jobDecisions.push({
        job,
        job_id: job.id,
        action: "error_deferred",
        reason: "evaluation_error",
        error: err,
        slots: [],
      });
    }
  }
  return { jobDecisions };
}

async function _evaluateOneJob(
  job,
  at,
  activeRuns,
  maxCatchupRuns,
  dryRun = false,
) {
  if (!job.state.next_run_at)
    job.state.next_run_at = computeInitialNextRun(job, at);
  migrateLegacyInfrastructureMarker(job);

  const activeRun = activeRuns[job.id];
  const nextRunMs = job.state.next_run_at
    ? new Date(job.state.next_run_at).getTime()
    : NaN;

  if (
    activeRun &&
    Number.isFinite(nextRunMs) &&
    new Date(at).getTime() >= nextRunMs
  )
    return {
      job,
      job_id: job.id,
      action: "in_flight",
      scheduledAt: job.state.next_run_at,
      activeRunId: activeRun.run_id || null,
    };

  const effectiveMaxCatchup =
    job.schedule.max_catchup ?? job.schedule.max_catchup_runs ?? maxCatchupRuns;
  const due = dueScheduleSlots(job, at, effectiveMaxCatchup);

  if (due.reason === "past_end_at") {
    job.state.enabled = false;
    job.state.next_run_at = null;
    job.state.last_status = "skipped";
    job.meta.updated_at = nowIso();
    return { job, job_id: job.id, action: "past_end_at" };
  }

  if (
    !dryRun &&
    Array.isArray(due.skipped) &&
    due.skipped.length > 0 &&
    due.skip_state
  ) {
    job.state.enabled = due.skip_state.enabled;
    job.state.next_run_at = due.skip_state.next_run_at;
    job.state.last_status = "skipped";
    job.meta.updated_at = nowIso();
  }

  if (!due.due) {
    if (Array.isArray(due.skipped) && due.skipped.length > 0)
      return { job, job_id: job.id, action: "no_slots", skipped: due.skipped };
    return null;
  }

  if (activeRun)
    return {
      job,
      job_id: job.id,
      action: "in_flight",
      scheduledAt: due.slots[0],
      activeRunId: activeRun.run_id || null,
    };

  if (dryRun) {
    return {
      job,
      job_id: job.id,
      action: "launch",
      slots: due.slots,
      scheduledAt: due.slots[0],
      overflow: due.overflow,
      overflow_next: due.overflow_next,
      overflow_reason: due.overflow_reason,
      skipped: due.skipped || [],
      precheck: { action: "proceed" },
      dryRun: true,
    };
  }

  const precheck = await evaluatePreconditions(job, at);

  if (precheck.action === "defer") {
    if (!job.state.deferred_since) job.state.deferred_since = due.slots[0];
    job.state.deferred_reason = precheck.reason;
    job.meta.updated_at = nowIso();
    return {
      job,
      job_id: job.id,
      action: "defer",
      reason: precheck.reason,
      scheduledAt: due.slots[0],
    };
  }

  if (precheck.action === "expire_and_skip") {
    const lastSlot = due.slots[due.slots.length - 1];
    const next = computeNextAfterRun(job, lastSlot, nowIso());
    job.state.next_run_at = next.next_run_at;
    job.state.last_status = "skipped";
    if (!next.enabled) job.state.enabled = false;
    clearOrdinaryDeferral(job);
    job.meta.updated_at = nowIso();
    return {
      job,
      job_id: job.id,
      action: "expire_and_skip",
      reason: precheck.reason,
      slots: due.slots,
    };
  }

  let slotsToProcess = due.slots;
  let suppressOverflow = false;
  let coalesced = [];
  if (precheck.action === "coalesce") {
    coalesced = due.slots
      .slice(0, -1)
      .map((s) => ({ scheduled_at: s, reason: "coalesced_into_latest" }));
    slotsToProcess = due.slots.slice(-1);
    suppressOverflow = true;
    clearOrdinaryDeferral(job);
    job.meta.updated_at = nowIso();
  }

  const condResult = evaluateConditionsSync(job);
  if (!condResult.met) {
    const lastSlot = slotsToProcess[slotsToProcess.length - 1];
    const next = computeNextAfterRun(job, lastSlot, nowIso());
    job.state.next_run_at = next.next_run_at;
    job.state.last_status = "skipped";
    if (!next.enabled) job.state.enabled = false;
    job.meta.updated_at = nowIso();
    return {
      job,
      job_id: job.id,
      action: "condition_miss",
      reason: condResult.reason,
      slots: slotsToProcess,
      scheduledAt: slotsToProcess[0],
    };
  }

  const skipped = [...(due.skipped || []), ...coalesced];
  return {
    job,
    job_id: job.id,
    action: "launch",
    slots: slotsToProcess,
    scheduledAt: slotsToProcess[0],
    overflow: !suppressOverflow && due.overflow,
    overflow_next: due.overflow_next,
    overflow_reason: due.overflow_reason,
    skipped,
    precheck,
  };
}

export { executeDispatchDecision } from "./dispatch_effects.mjs";
export {
  evaluateConditionsSync,
  evaluatePreconditions,
} from "./dispatch_effects.mjs";
