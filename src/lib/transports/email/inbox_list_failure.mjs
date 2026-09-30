import { appendActivityEvent } from "../../tldr_agent_diagnostics.mjs";

// Item 41: every inbox read failure was reported as `inbox_list_failed` with
// the underlying cause discarded. Keep which path failed (bounded enums and
// numbers only) so the failed tick's diagnostic can record it.
export function inboxListFailureCause(error) {
  if (error?.code === "inbox_poll_timeout") return { cause: "poll_timeout" };
  if (error?.message === "inbox_list_failed" && !error?.code)
    return { cause: "listing_malformed" };
  const bridge = error?.bridge;
  if (!bridge || typeof bridge.cause !== "string") return { cause: "unknown" };
  const detail = { cause: bridge.cause };
  if (Number.isFinite(bridge.elapsed_ms)) detail.bridge_ms = bridge.elapsed_ms;
  if (Number.isInteger(bridge.exit_code))
    detail.bridge_exit_code = bridge.exit_code;
  if (bridge.signal) detail.bridge_signal = bridge.signal;
  if (bridge.broker_code) detail.broker_code = bridge.broker_code;
  return detail;
}

// Item 41: the native bridge exits non-zero when its own socket timeout
// fires (2 s before item 14, 4.5 s for inbox reads since Aegis 1.1.1), and the
// next tick is about 11 s away. Listing the inbox is an idempotent read, so
// one poll may retry one failed page read once, for that cause only, when the
// time left still fits a useful bridge attempt. With the longer bridge
// timeout this retry should be rare; `retried` on each tick shows how rare.
export const INBOX_LIST_RETRY_CAUSE = "bridge_exit_nonzero";
// Time kept back after the retry for the message reads and the state write.
export const INBOX_LIST_RETRY_RESERVE_MS = 2_000;
// About twice the median live bridge read (767 ms on 2026-09-29).
export const INBOX_LIST_RETRY_MIN_MS = 1_500;

function bridgeDetail(error) {
  const { cause, bridge_ms, bridge_exit_code } = inboxListFailureCause(error);
  return { cause, bridge_ms, bridge_exit_code };
}

// One diagnostic per decision and outcome; only a failing read gets here.
function logRetry(scope, outcome, data, level = "info") {
  appendActivityEvent({
    type: "transport_email_inbox_poll_list_failed",
    level,
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: { outcome, ...data },
  });
}

// A message read that fails leaves the message for the next tick's recovery;
// log why, once per failed read (item 14), so bridge timeouts stay visible.
export function logInboxMessageReadFailure(scope, error, latencyMs) {
  appendActivityEvent({
    type: "transport_email_inbox_poll_message_read_failed",
    level: "warn",
    scope_id: scope?.scope_id ?? null,
    cwd: scope?.cwd ?? null,
    data: {
      outcome: "failed",
      ...inboxListFailureCause(error),
      latency_ms: latencyMs,
    },
  });
}

// `read({ brokerTimeoutMs, raceTimeoutMs })` performs one page read. The first
// read uses the caller's usual timeouts; the retry is bounded by the budget
// left before `deadlineMs` (the poll tick's), or before `startedAtMs +
// budgetMs` (the inbox poll's own budget) when that comes first.
export function createInboxListRetry({
  deadlineMs = null,
  budgetMs,
  brokerTimeoutMs,
  scope = null,
  now = Date.now,
}) {
  const startedAtMs = now();
  const limits = [startedAtMs + budgetMs];
  if (Number.isFinite(deadlineMs)) limits.push(deadlineMs);
  const endMs = Math.min(...limits);
  let retried = 0;

  async function readPage(read) {
    const attemptStartedAt = now();
    try {
      return await read({ brokerTimeoutMs, raceTimeoutMs: budgetMs });
    } catch (error) {
      if (retried > 0 || error?.bridge?.cause !== INBOX_LIST_RETRY_CAUSE)
        throw error;
      const retryBudgetMs = endMs - now() - INBOX_LIST_RETRY_RESERVE_MS;
      const first = {
        ...bridgeDetail(error),
        latency_ms: now() - attemptStartedAt,
      };
      if (retryBudgetMs < INBOX_LIST_RETRY_MIN_MS) {
        logRetry(scope, "blocked", { ...first, retried: 0 }, "warn");
        throw error;
      }
      retried = 1;
      logRetry(scope, "retry", { ...first, attempt: 1 }, "warn");
      const retryStartedAt = now();
      try {
        const listed = await read({
          brokerTimeoutMs: Math.min(brokerTimeoutMs, retryBudgetMs),
          raceTimeoutMs: Math.min(budgetMs, retryBudgetMs),
        });
        logRetry(scope, "success", {
          retried,
          latency_ms: now() - retryStartedAt,
        });
        return listed;
      } catch (retryError) {
        logRetry(
          scope,
          "failed",
          {
            ...bridgeDetail(retryError),
            retried,
            latency_ms: now() - retryStartedAt,
          },
          "warn",
        );
        throw retryError;
      }
    }
  }

  return Object.freeze({ readPage, retries: () => retried });
}
