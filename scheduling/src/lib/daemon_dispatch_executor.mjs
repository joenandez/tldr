/**
 * daemon_dispatch_executor.mjs — Halcyon H2 task 3.4.
 *
 * Off-tick bounded executor: the tick's dispatch_launch phase ENQUEUES due
 * scopes (fast, O(n due)); a separate bounded async executor DRAINS them
 * so evaluation can never starve heartbeat / health / reap tick phases.
 *
 * Flag: HELM_DISPATCH_INPROC=1 (same gate as 3.1 / 3.3 — no new env vars)
 * Kill-switch: HELM_DISPATCH_INPROC_KILL_SWITCH=1 → executor disabled (null)
 *
 * Design:
 *   createDispatchExecutor(opts) → executor | null
 *
 *   When disabled (flag off / kill-switch on) the factory returns null so the
 *   caller falls back to the existing fork path unchanged.
 *
 *   When enabled the returned executor has:
 *     enqueue(scope, evalOpts) — O(1) push onto a FIFO queue; returns synchronously.
 *     stats()                  — {inFlight, queued, total, deferred} snapshot.
 *     close()                  — stops the drain loop; safe to call multiple times.
 *
 *   The drain loop runs on setImmediate turns so every event-loop iteration
 *   between evaluation starts is free for other phases (health probes, timers,
 *   I/O callbacks, etc.).
 *
 *   Cap: at most maxConcurrent evaluations run concurrently. Additional scopes
 *   are either:
 *     (a) held in the queue and drained as slots free, OR
 *     (b) when the queue is already committed and an overflow policy demands it,
 *         emitted as a structured concurrency_cap deferral via onDeferred().
 *
 *   The queue model: all enqueued scopes are held and drained in order as
 *   capacity frees. onDeferred() is called only for scopes that are explicitly
 *   REJECTED at enqueue-time due to a configurable maxQueued ceiling (default
 *   unlimited — scopes wait in the queue). This preserves the existing
 *   "every due job is either launched or visibly deferred" invariant from
 *   daemon_dispatch_fanout.mjs:72-130.
 *
 * Starvation prevention:
 *   The drain loop uses setImmediate (not process.nextTick) so each drain step
 *   yields to the macrotask queue. Heartbeat timers, I/O callbacks, and other
 *   phases all run between drain steps. Even with maxConcurrent evaluations
 *   in flight, the async evaluations themselves await promises so the Node event
 *   loop remains responsive throughout.
 *
 * Fanout cap (FA-5):
 *   maxConcurrent defaults to maxConcurrentDispatches() from
 *   daemon_dispatch_fanout.mjs — exactly the same bound the fork path used.
 *   The existing HELM_MAX_CONCURRENT_DISPATCHES env is respected unchanged.
 */

import { maxConcurrentDispatches } from "./daemon_dispatch_fanout.mjs";

// ---------------------------------------------------------------------------
// Flag lever — same as 3.1 / 3.3 (no new env vars)
// ---------------------------------------------------------------------------

function isExecutorEnabled() {
  return (
    process.env.HELM_DISPATCH_INPROC === "1" &&
    process.env.HELM_DISPATCH_INPROC_KILL_SWITCH !== "1"
  );
}

/**
 * Exported so tests can assert the default-enabled state.
 * true = executor is active when the flag is on; false = flag off disables it.
 */
export const EXECUTOR_ENABLED_DEFAULT = true;

// ---------------------------------------------------------------------------
// Executor factory
// ---------------------------------------------------------------------------

/**
 * Create a bounded off-tick dispatch executor.
 *
 * @param {object}   opts
 * @param {number}   [opts.maxConcurrent]  - max concurrent evaluations (default: maxConcurrentDispatches())
 * @param {number}   [opts.maxQueued]      - max queue depth before deferral (default: Infinity)
 * @param {Function} opts.evaluateFn       - async (scope, evalOpts) => {jobDecisions}
 * @param {Function} [opts.onDeferred]     - called with {scope, reason, at} for each dropped/deferred scope
 * @param {Function} [opts.onDrainStep]    - hook called after each drain step (for tests)
 * @returns {object|null} executor or null when disabled
 */
export function createDispatchExecutor({
  maxConcurrent = maxConcurrentDispatches(),
  maxQueued = Infinity,
  evaluateFn,
  onDeferred = null,
  onDrainStep = null,
} = {}) {
  // Return null when flag is off or kill-switch is on — caller uses fork path.
  if (!isExecutorEnabled()) return null;

  if (typeof evaluateFn !== "function") {
    throw new TypeError(
      "createDispatchExecutor: opts.evaluateFn must be a function",
    );
  }

  // FIFO queue of {scope, evalOpts} entries
  const queue = [];
  let inFlight = 0;
  let totalEnqueued = 0;
  let totalDeferred = 0;
  let closed = false;
  let drainScheduled = false;
  // Single-flight guard: tracks scope_ids currently queued or in-flight.
  // Prevents the same scope from being enqueued twice in the same drain window.
  const pendingScopeIds = new Set();

  // Schedule a drain step on the next setImmediate turn.
  // setImmediate yields to the macrotask queue between each evaluation launch,
  // which keeps the event loop free for heartbeat timers and I/O.
  function scheduleDrain() {
    if (drainScheduled || closed) return;
    drainScheduled = true;
    setImmediate(drainStep);
  }

  function drainStep() {
    drainScheduled = false;
    if (closed) return;

    // Launch as many queued items as the cap allows
    while (queue.length > 0 && inFlight < maxConcurrent) {
      const entry = queue.shift();
      inFlight++;
      // Run the evaluation promise; decrement inFlight and schedule another
      // drain when it finishes so the next waiting scope gets a slot.
      evaluateFn(entry.scope, entry.evalOpts)
        .catch((_err) => {
          // Evaluation errors are already handled inside evaluateFn (per-job
          // try/catch in runInprocDispatch); absorb any outer rejection here
          // so the executor never crashes from a single evaluation failure.
        })
        .finally(() => {
          inFlight--;
          pendingScopeIds.delete(entry.scope.scope_id);
          // Schedule the next drain step so waiting queue entries get a slot.
          scheduleDrain();
        });
    }

    if (onDrainStep) onDrainStep({ queueLength: queue.length, inFlight });
  }

  return {
    /**
     * Enqueue a scope for evaluation. Returns synchronously (O(1) push).
     * When the queue is full (maxQueued), the scope is immediately deferred
     * with reason "concurrency_cap" and onDeferred() is called.
     *
     * @param {object} scope    - {scope_id, cwd, storage_root}
     * @param {object} evalOpts - {at, jobs, activeRuns, ...} passed to evaluateFn
     */
    enqueue(scope, evalOpts = {}) {
      if (closed) return { skipped: true, reason: "executor_closed" };

      // Single-flight: skip if this scope is already queued or in-flight.
      // The scope stays due and will be picked up by the NEXT tick's enqueue.
      if (pendingScopeIds.has(scope.scope_id)) {
        return { skipped: true, reason: "dispatch_child_in_flight" };
      }

      if (queue.length >= maxQueued) {
        // Queue is at capacity: emit a visible deferral, don't silently drop.
        totalDeferred++;
        if (typeof onDeferred === "function") {
          onDeferred({
            scope,
            reason: "concurrency_cap",
            at: evalOpts.at || new Date().toISOString(),
          });
        }
        return { skipped: true, reason: "concurrency_cap" };
      }

      totalEnqueued++;
      pendingScopeIds.add(scope.scope_id);
      queue.push({ scope, evalOpts });
      scheduleDrain();
      return { enqueued: true };
    },

    /**
     * Snapshot of current executor state.
     * @returns {{inFlight: number, queued: number, total: number, deferred: number}}
     */
    stats() {
      return {
        inFlight,
        queued: queue.length,
        total: totalEnqueued,
        deferred: totalDeferred,
        pendingCount: pendingScopeIds.size,
      };
    },

    /**
     * Stop accepting new work and cancel pending drain steps.
     * In-flight evaluations run to completion.
     */
    close() {
      closed = true;
    },
  };
}
