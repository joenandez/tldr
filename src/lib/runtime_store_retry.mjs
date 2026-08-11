/**
 * Reusable bounded-retry wrapper around withRuntimeStoreTransaction.
 *
 * Phase 1A (and later 1B/2) writers outside dispatch_service.mjs need the
 * same SQLITE_BUSY retry discipline: BEGIN IMMEDIATE + bounded exponential
 * wait + structured error on exhaustion. Extracting it here satisfies the
 * plan's risk-row requirement ("extract/export withRuntimeStoreLockRetry or
 * provide an exported bounded-retry wrapper around withRuntimeStoreTransaction")
 * and is the single implementation that dispatch_service.mjs's private helpers
 * delegate to.
 *
 * Sync signature:
 *   withRuntimeStoreTransactionRetry(
 *     storeArgs,     // { home?, path? } passed to withRuntimeStoreTransaction
 *     options,       // { context?, retryMs?, intervalMs?, onRetry?, onExhausted? }
 *     fn,            // (db) => value  (same shape as withRuntimeStoreTransaction)
 *   ) => { ok: true, value } | { ok: false, error, details }
 *
 * Async signature:
 *   withRuntimeStoreTransactionRetryAsync(
 *     storeArgs,
 *     options,       // same options shape, async onRetry/onExhausted ok too
 *     fn,            // (db) => value | Promise<value>
 *   ) => Promise<{ ok: true, value } | { ok: false, error, details }>
 *
 * Never throws on SQLITE_BUSY exhaustion — returns { ok: false }.
 * Always throws on non-busy errors (schema errors, constraint violations, …).
 *
 * options.onRetry({ attempt, elapsedMs, error, details })    — called before each retry sleep
 * options.onExhausted({ attempt, elapsedMs, error, details }) — called on exhaustion;
 *   `error` is the caught busy error so callers can extract lock-holder details
 */

import { withRuntimeStoreTransaction } from "./runtime_store.mjs";

const DEFAULT_RETRY_MS = Number(process.env.HELM_RUNTIME_LOCK_RETRY_MS ?? 600);
const DEFAULT_INTERVAL_MS = Number(
  process.env.HELM_RUNTIME_LOCK_RETRY_INTERVAL_MS ?? 75,
);

/**
 * Detect an SQLite busy / advisory-lock contention error.
 *
 * Demonstrated empirically (node v22 node:sqlite):
 *   err.code    === "ERR_SQLITE_ERROR"
 *   err.errcode === 5              (SQLITE_BUSY)
 *   err.errstr  === "database is locked"
 *
 * Also matches the advisory-lock code used by runtime_store.mjs itself.
 */
export function isBusyError(err) {
  if (err?.code === "runtime_store_locked") return true;
  // node:sqlite SQLITE_BUSY: code=ERR_SQLITE_ERROR, errcode=5
  if (err?.code === "ERR_SQLITE_ERROR" && err?.errcode === 5) return true;
  return false;
}

export function sleepMsSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

export function sleepMsAsync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jitter-scaled sleep: uniform [0.5, 1.5) × intervalMs, clamped to budget. */
function jitteredSleep(intervalMs, remainingMs) {
  const raw = intervalMs * (0.5 + Math.random());
  return Math.min(raw, remainingMs);
}

function resolveOptions(options) {
  const retryMs =
    options?.retryMs ??
    (Number.isFinite(DEFAULT_RETRY_MS) && DEFAULT_RETRY_MS >= 0
      ? DEFAULT_RETRY_MS
      : 600);
  const intervalMs =
    options?.intervalMs ??
    (Number.isFinite(DEFAULT_INTERVAL_MS) && DEFAULT_INTERVAL_MS > 0
      ? DEFAULT_INTERVAL_MS
      : 75);
  const context = options?.context ?? {};
  const onRetry = options?.onRetry ?? null;
  const onExhausted = options?.onExhausted ?? null;
  return { retryMs, intervalMs, context, onRetry, onExhausted };
}

/**
 * Run `fn(db)` inside a BEGIN IMMEDIATE transaction, retrying on SQLITE_BUSY
 * for up to `retryMs` milliseconds with jittered `intervalMs` between attempts.
 * Bound is time-only: retries continue until elapsedMs >= retryMs.
 *
 * @param {object|null} storeArgs  - forwarded to withRuntimeStoreTransaction
 *   ({ home?, path? }); pass null to skip the real transaction wrapper
 *   (test-only: lets tests exercise retry logic without a real DB).
 * @param {object} options
 * @param {object} [options.context]        - logged with contention events
 * @param {number} [options.retryMs]        - total retry window (default 600 ms)
 * @param {number} [options.intervalMs]     - base sleep between retries (default 75 ms)
 * @param {Function} [options.onRetry]      - called on each retry before sleeping
 * @param {Function} [options.onExhausted]  - called on final exhaustion
 * @param {Function} fn  - receives an open DatabaseSync db; return value
 *   becomes { ok: true, value }.
 * @returns {{ ok: true, value: * } | { ok: false, error: Error, details: object }}
 */
export function withRuntimeStoreTransactionRetry(storeArgs, options, fn) {
  const { retryMs, intervalMs, context, onRetry, onExhausted } =
    resolveOptions(options);

  const startedMs = Date.now();
  let attempt = 1;

  for (;;) {
    try {
      // storeArgs === null is a test escape-hatch: call fn directly so tests
      // can inject busy errors without needing a real SQLite database.
      const remainingMs = Math.max(0, retryMs - (Date.now() - startedMs));
      const attemptStoreArgs =
        storeArgs === null
          ? null
          : {
              ...storeArgs,
              busyTimeoutMs: Math.min(intervalMs, remainingMs),
            };
      const value =
        attemptStoreArgs === null
          ? fn(null)
          : withRuntimeStoreTransaction(attemptStoreArgs, fn);
      return { ok: true, value };
    } catch (err) {
      if (!isBusyError(err)) throw err;

      const elapsedMs = Date.now() - startedMs;
      const canRetry = elapsedMs < retryMs;

      process.stderr.write(
        `[TEMP RUNTIME_STORE_RETRY] busy stage=${context.stage ?? "unknown"} attempt=${attempt} canRetry=${canRetry}\n`,
      );

      if (!canRetry) {
        const details = {
          code: err?.code ?? "runtime_store_locked",
          action: "defer_nonfatal",
          attempts: attempt,
          elapsed_ms: elapsedMs,
        };
        if (onExhausted)
          onExhausted({ attempt, elapsedMs, error: err, details });
        return { ok: false, error: err, details };
      }

      const sleepBudget = retryMs - elapsedMs;
      if (onRetry) onRetry({ attempt, elapsedMs, error: err, details: null });
      sleepMsSync(jitteredSleep(intervalMs, sleepBudget));
      attempt += 1;
    }
  }
}

/**
 * Async variant of withRuntimeStoreTransactionRetry.
 * fn may be sync or async; sleep between retries uses setTimeout.
 *
 * @param {object|null} storeArgs
 * @param {object} options
 * @param {Function} fn  - (db) => value | Promise<value>
 * @returns {Promise<{ ok: true, value: * } | { ok: false, error: Error, details: object }>}
 */
export async function withRuntimeStoreTransactionRetryAsync(
  storeArgs,
  options,
  fn,
) {
  const { retryMs, intervalMs, context, onRetry, onExhausted } =
    resolveOptions(options);

  const startedMs = Date.now();
  let attempt = 1;

  for (;;) {
    try {
      // Sequential awaits are the point: each retry attempt must complete
      // before deciding whether the busy window allows another.
      let value;
      const remainingMs = Math.max(0, retryMs - (Date.now() - startedMs));
      const attemptStoreArgs =
        storeArgs === null
          ? null
          : {
              ...storeArgs,
              busyTimeoutMs: Math.min(intervalMs, remainingMs),
            };
      if (attemptStoreArgs === null) {
        // eslint-disable-next-line no-await-in-loop
        value = await fn(null);
      } else {
        // eslint-disable-next-line no-await-in-loop
        value = await Promise.resolve(
          withRuntimeStoreTransaction(attemptStoreArgs, fn),
        );
      }
      return { ok: true, value };
    } catch (err) {
      if (!isBusyError(err)) throw err;

      const elapsedMs = Date.now() - startedMs;
      const canRetry = elapsedMs < retryMs;

      process.stderr.write(
        `[TEMP RUNTIME_STORE_RETRY] busy stage=${context.stage ?? "unknown"} attempt=${attempt} canRetry=${canRetry}\n`,
      );

      if (!canRetry) {
        const details = {
          code: err?.code ?? "runtime_store_locked",
          action: "defer_nonfatal",
          attempts: attempt,
          elapsed_ms: elapsedMs,
        };
        if (onExhausted)
          onExhausted({ attempt, elapsedMs, error: err, details });
        return { ok: false, error: err, details };
      }

      const sleepBudget = retryMs - elapsedMs;
      if (onRetry) onRetry({ attempt, elapsedMs, error: err, details: null });
      // eslint-disable-next-line no-await-in-loop
      await sleepMsAsync(jitteredSleep(intervalMs, sleepBudget));
      attempt += 1;
    }
  }
}
