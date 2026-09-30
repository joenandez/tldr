// Opportunity #3 (reliability review 2026-06-11): bounded dispatch fan-out,
// extracted from daemon.mjs (carve-up per HELM-ARCHITECTURE-DEEPDIVE-V0 §5).
// The daemon used to fork one cold-start dispatch child per due scope per
// tick with only a collapsing stagger between spawns; at fleet scale that is
// a process storm, and an over-budget fan-out aborted mid-loop with the tail
// scopes silently never dispatching.

export const DEFAULT_DISPATCH_LAUNCH_TIMEOUT_MS = 20000;

// Inter-launch stagger for the dispatch_launch fan-out. Spawning every dispatch
// child in one tight burst adds a fork/exec + SQLite-open spike to an already
// busy host, starving the daemon event loop (status-port wedge) and contending
// on the runtime store lock. A small per-launch stagger spreads the burst; it
// is capped at runtime to a fraction of the phase budget. See canary 19:00 PT.
export const DEFAULT_DISPATCH_LAUNCH_STAGGER_MS = Number(
  process.env.HELM_DAEMON_DISPATCH_STAGGER_MS || 150,
);

function yieldToEventLoop() {
  return new Promise((done) => setImmediate(done));
}

// Abortable pause used to stagger the dispatch fan-out. Resolves after `ms`,
// or rejects immediately if the phase signal aborts (tick budget / timeout) so
// a slow stagger never holds the phase open past cancellation.
function staggerWait(ms, signal = null) {
  return new Promise((fulfill, fail) => {
    if (signal?.aborted) {
      fail(signal.reason || new Error("operation aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      fulfill();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      fail(signal?.reason || new Error("operation aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

// Clamp the stagger so the cumulative spread can never exceed half the
// dispatch_launch budget — the fan-out must still finish inside its deadline.
export function effectiveDispatchStaggerMs({
  staggerMs = DEFAULT_DISPATCH_LAUNCH_STAGGER_MS,
  scopeCount = 0,
  budgetMs = DEFAULT_DISPATCH_LAUNCH_TIMEOUT_MS,
} = {}) {
  const requested = Number(staggerMs);
  if (!Number.isFinite(requested) || requested <= 0 || scopeCount <= 1)
    return 0;
  const safeCeiling = Math.floor((budgetMs * 0.5) / scopeCount);
  return Math.max(0, Math.min(requested, safeCeiling));
}

// Default cap on concurrently-running dispatch children. Without it, a tick
// with N due scopes forks N cold-start node processes at once (~10/sec
// sustained at 100 workspaces). Capped scopes are *deferred* — they stay due
// and launch on the next tick, with an activity event for visibility instead
// of a silent drop.
export const DEFAULT_MAX_CONCURRENT_DISPATCHES = 4;

export function maxConcurrentDispatches() {
  const raw = Number(process.env.HELM_MAX_CONCURRENT_DISPATCHES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_MAX_CONCURRENT_DISPATCHES;
}

export async function launchDispatchScopesCooperatively({
  scopes = [],
  signal = null,
  launchDispatch,
  yieldControl = yieldToEventLoop,
  staggerMs = 0,
  waitStagger = staggerWait,
  maxConcurrent = maxConcurrentDispatches(),
  currentInFlightCount = null,
} = {}) {
  let launchedCount = 0;
  const deferred = [];
  let aborted = false;
  const effectiveStaggerMs = effectiveDispatchStaggerMs({
    staggerMs,
    scopeCount: scopes.length,
  });
  for (let i = 0; i < scopes.length; i += 1) {
    const scope = scopes[i];
    if (signal?.aborted) {
      // Opportunity #3: an over-budget fan-out used to throw here, silently
      // discarding the tail. Report the remainder so the daemon can log it;
      // the scopes stay due and launch next tick.
      aborted = true;
      for (const rest of scopes.slice(i)) {
        deferred.push({ scope: rest, reason: "phase_aborted" });
      }
      break;
    }
    if (
      typeof currentInFlightCount === "function" &&
      Number.isFinite(maxConcurrent) &&
      maxConcurrent > 0 &&
      currentInFlightCount() >= maxConcurrent
    ) {
      deferred.push({ scope, reason: "concurrency_cap" });
      continue;
    }
    const launched = launchDispatch(scope);
    if (!launched?.skipped) {
      launchedCount += 1;
      // Keep the in-process status server responsive during broad scope fanout.
      // A large dispatch burst must not block sentinel /health probes.
      // eslint-disable-next-line no-await-in-loop
      await yieldControl();
      if (effectiveStaggerMs > 0 && !signal?.aborted) {
        // Spread the spawn burst so the daemon does not add a fork/exec spike to
        // an already-busy host in a single event-loop turn.
        try {
          // eslint-disable-next-line no-await-in-loop
          await waitStagger(effectiveStaggerMs, signal);
        } catch {
          // Abort during stagger — handled at the top of the next iteration.
        }
      }
    }
  }
  return { launchedCount, deferred, aborted };
}
