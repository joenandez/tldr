/**
 * daemon_inproc_dispatch.mjs — Halcyon H2 task 3.3.
 *
 * In-process bounded evaluator: runs evaluateScopeDispatch in-daemon and calls
 * startRun (which spawns only the agent-run child) instead of forking a
 * cold-start `node … dispatch` evaluator child.
 *
 * Flag: HELM_DISPATCH_INPROC=1
 * Kill-switch: HELM_DISPATCH_INPROC_KILL_SWITCH=1 → fall back to fork path.
 *
 * Reuses the same flag as task 3.1 (dispatch_due_query.mjs) — the same
 * HELM_DISPATCH_INPROC/HELM_DISPATCH_INPROC_KILL_SWITCH levers gate both the
 * global due-query (3.1) and the in-process evaluator (3.3).
 *
 * Fanout cap semantics: callers (daemon.mjs launchDispatch) pass runInprocDispatch
 * through launchDispatchScopesCooperatively — the existing concurrency cap,
 * stagger, and per-scope single-flight semantics (inFlight map) remain the
 * outer bound on how many scopes run in parallel. runInprocDispatch is called
 * per-scope by launchDispatch, exactly as spawnDispatchChild was.
 *
 * Fault isolation: evaluateScopeDispatch wraps each job in try/catch (implemented
 * in dispatch_evaluator.mjs). The per-launch startRunFn call is also wrapped
 * here so a startRun failure defers that job but never aborts the batch.
 *
 * Agent-run-only spawning: startRunFn === startRun from dispatch_service.mjs.
 * startRun spawns an agent-run child (or command child), but its argv never
 * includes "dispatch" — so classifyChildKind returns "agent_run", not
 * "dispatch_evaluator". No dispatch_evaluator children are spawned when the
 * in-process path is active.
 *
 * Once-path (daemon.run --once): launchDispatchOnceInproc replaces
 * launchDispatchOnceForAirlock when the flag is on. It runs evaluateScopeDispatch
 * + startRun in-process for each scope and awaits the agent-run completions,
 * returning the same result shape as the fork-path once launcher.
 */

import { evaluateScopeDispatch } from "./dispatch_evaluator.mjs";
import { persistInprocScheduleDecision } from "./dispatch_service.mjs";

// ---------------------------------------------------------------------------
// Flag lever for the in-process evaluator path.
// ---------------------------------------------------------------------------

/**
 * Returns true when the in-process evaluator path is active.
 * This is intentionally separate from default-on due-query admission.
 */
export function isInprocDispatchEnabled() {
  return (
    process.env.HELM_DISPATCH_INPROC === "1" &&
    process.env.HELM_DISPATCH_INPROC_KILL_SWITCH !== "1"
  );
}

// ---------------------------------------------------------------------------
// In-process evaluator — per-scope entry point
// ---------------------------------------------------------------------------

/**
 * Run the in-process dispatch evaluator for one scope.
 *
 * @param {object} scope          - {scope_id, cwd, storage_root}
 * @param {object} opts
 * @param {string} opts.at        - ISO timestamp (dispatch clock)
 * @param {Array}  opts.jobs      - job array from loadDispatchJobsReadOnly
 * @param {object} opts.activeRuns - activeRuns.runs map from loadActiveRunsReadOnly
 * @param {Function} opts.startRunFn - (scope, job, launchOpts) → handle | null
 *                                    Injects startRun from dispatch_service.mjs.
 * @param {Function} [opts.persistScheduleDecisionFn] - durable non-launch finalizer
 * @param {Function} [opts.spawnDispatchFn] - kept for kill-switch parity tests only;
 *                                            NEVER called by the in-process path.
 * @param {string}  [opts.daemonInstanceId] - passed through to startRunFn
 * @param {number}  [opts.maxCatchupRuns]   - default 1
 * @param {boolean} [opts.dryRun]           - default false
 * @returns {Promise<{jobDecisions: Array}>}
 */
export async function runInprocDispatch(scope, opts = {}) {
  const {
    at,
    jobs = [],
    activeRuns = {},
    startRunFn,
    persistScheduleDecisionFn = persistInprocScheduleDecision,
    daemonInstanceId = null,
    maxCatchupRuns = 1,
    dryRun = false,
  } = opts;

  // Normalize activeRuns: callers may pass the full loadActiveRunsReadOnly
  // result ({version, runs: {...}}) or just the runs map directly.
  const activeRunsMap =
    activeRuns &&
    typeof activeRuns.runs === "object" &&
    !Array.isArray(activeRuns.runs)
      ? activeRuns.runs
      : activeRuns;
  const observedSourceSlots = new Map(
    jobs.map((job) => [job.id, job.state?.next_run_at || null]),
  );
  const baselineUpdatedAt = new Map(
    jobs.map((job) => [job.id, job.meta?.updated_at ?? null]),
  );

  // evaluate — per-job errors produce error_deferred (never batch abort).
  const { jobDecisions } = await evaluateScopeDispatch(scope, {
    at,
    jobs,
    activeRuns: activeRunsMap,
    maxCatchupRuns,
    dryRun,
  });

  if (dryRun) return { jobDecisions };

  // Persist ordinary deferrals and schedule-advancing non-launches, then start
  // launch decisions.
  // Per-job failures defer only that decision and never abort the batch.
  for (const decision of jobDecisions) {
    if (decision.action !== "launch") {
      try {
        // eslint-disable-next-line no-await-in-loop -- Catalog mutations are serialized per decision.
        const persisted = await persistScheduleDecisionFn(scope, decision, {
          baselineUpdatedAt: baselineUpdatedAt.get(decision.job_id) ?? null,
          observedSourceSlot: observedSourceSlots.get(decision.job_id) ?? null,
          daemonInstanceId,
        });
        if (
          (persisted.persistence_required || persisted.schedule_advanced) &&
          !persisted.ok
        ) {
          decision.action = "error_deferred";
          decision.reason = persisted.retryable_conflict
            ? "schedule_persist_conflict"
            : "schedule_persist_failed";
          decision.retryable = persisted.retryable_conflict === true;
          decision.error = persisted.error;
        }
      } catch (error) {
        decision.action = "error_deferred";
        decision.reason = "schedule_persist_failed";
        decision.error = error;
      }
      continue;
    }
    const { job, scheduledAt } = decision;
    try {
      if (typeof startRunFn !== "function") {
        // No startRunFn injected — record structured deferral
        decision.action = "error_deferred";
        decision.reason = "missing_start_run_fn";
        decision.error = new Error(
          "runInprocDispatch: opts.startRunFn is required",
        );
        continue;
      }
      // startRunFn === startRun from dispatch_service.mjs.
      // startRun spawns only the agent-run child (argv never contains "dispatch"),
      // so classifyChildKind returns "agent_run" — 0 dispatch_evaluator children.
      // eslint-disable-next-line no-await-in-loop
      const handle = await startRunFn(scope, job, {
        reason: "scheduled",
        scheduledAt,
        daemonInstanceId,
        baselineUpdatedAt: baselineUpdatedAt.get(job.id) ?? null,
        drainCompletions: false, // daemon path: fire-and-forget (--no-drain equivalent)
        consumedInfrastructureSlot:
          observedSourceSlots.get(job.id) ?? scheduledAt,
      });

      if (handle === null) {
        // concurrency_saturated — startRun emits its own deferral activity event
        decision.action = "error_deferred";
        decision.reason = "concurrency_saturated";
        decision.error = new Error("startRun: concurrency saturated");
      } else if (handle && handle.skipped) {
        // eslint-disable-next-line no-await-in-loop -- Catalog mutations are serialized per decision.
        const persisted = await persistScheduleDecisionFn(scope, decision, {
          baselineUpdatedAt: baselineUpdatedAt.get(job.id) ?? null,
          observedSourceSlot: observedSourceSlots.get(job.id) ?? scheduledAt,
          handle,
          daemonInstanceId,
        });
        if (persisted.schedule_advanced && persisted.ok) {
          decision.action = "skipped";
          decision.reason = handle.reason;
          decision.schedulePersisted = true;
        } else {
          decision.action = "error_deferred";
          decision.reason = persisted.retryable_conflict
            ? "schedule_persist_conflict"
            : persisted.schedule_advanced
              ? "schedule_persist_failed"
              : handle.reason || "run_skipped";
          decision.retryable = persisted.retryable_conflict === true;
          decision.error =
            persisted.error ||
            new Error(`startRun: skipped — ${handle.reason}`);
        }
      } else {
        // Success: agent-run child launched. Attach handle for callers that want
        // to observe run completion (e.g. --once path that drains results).
        decision.handle = handle;
        decision.runId = handle?.runId ?? null;
      }
    } catch (err) {
      // startRun threw — per-job deferral, never batch abort.
      decision.action = "error_deferred";
      decision.reason = "start_run_error";
      decision.error = err;
    }
  }

  return { jobDecisions };
}

// ---------------------------------------------------------------------------
// Once-path in-process launcher
// ---------------------------------------------------------------------------

/**
 * In-process equivalent of launchDispatchOnceForAirlock.
 * Called when HELM_DISPATCH_INPROC=1 and daemon.run --once.
 *
 * Runs runInprocDispatch for each scope in parallel (mirrors the Promise.all
 * shape of the fork once-path) and returns results in the same shape:
 *   [{scope, ok, skipped, reason?}]
 *
 * @param {object} opts
 * @param {Array}  opts.dispatchScopes  - admitted scope objects
 * @param {Function} opts.startRunFn    - injected startRun from dispatch_service.mjs
 * @param {Function} opts.loadJobsFn    - injected loadDispatchJobsReadOnly
 * @param {Function} opts.loadActiveRunsFn - injected loadActiveRunsReadOnly
 * @param {string}  [opts.daemonInstanceId]
 * @returns {Promise<Array<{scope, ok, skipped, reason?}>>}
 */
export async function launchDispatchOnceInproc({
  dispatchScopes = [],
  startRunFn,
  loadJobsFn,
  loadActiveRunsFn,
  daemonInstanceId = null,
}) {
  const at = new Date().toISOString();

  return Promise.all(
    dispatchScopes.map(async (scope) => {
      try {
        const { jobs } = loadJobsFn(scope);
        const activeRunsResult = loadActiveRunsFn(scope);

        const { jobDecisions } = await runInprocDispatch(scope, {
          at,
          jobs,
          activeRuns: activeRunsResult,
          startRunFn,
          daemonInstanceId,
          drainCompletions: false,
        });

        // Wait for all agent-run completions so --once can report final status.
        const completionPromises = jobDecisions
          .filter((d) => d.action === "launch" && d.handle?.completion)
          .map((d) => d.handle.completion.catch(() => null));
        await Promise.all(completionPromises);

        const launched = jobDecisions.some(
          (d) => d.handle !== null && d.handle !== undefined,
        );
        return { scope, ok: true, skipped: !launched };
      } catch (err) {
        return {
          scope,
          ok: false,
          skipped: false,
          error: err?.message || String(err),
        };
      }
    }),
  );
}
