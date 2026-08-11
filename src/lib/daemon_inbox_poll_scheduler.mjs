import { performance } from "node:perf_hooks";

const POLL_INTERVAL_MS = 15_000;

// This is the retained daemon-local scheduler extracted from daemon.mjs so the
// oversized inherited loop does not grow. Wall time owns due timestamps;
// performance.now() owns sleep/wake gap detection and is injectable in tests.
export function createInboxPollScheduler({
  nowMs = () => Date.now(),
  monotonicNowMs = () => performance.now(),
} = {}) {
  const states = new Map();
  const stateFor = (inboxId) => {
    if (typeof inboxId !== "string" || inboxId.trim().length === 0) {
      throw new TypeError("inbox poll scheduler requires a stable inbox key");
    }
    const key = inboxId.trim();
    if (!states.has(key)) {
      states.set(key, {
        inFlight: false,
        lastObservedMonotonicMs: null,
        lastPollStartedAtMs: null,
        nextPollAtMs: 0,
      });
    }
    return states.get(key);
  };
  return {
    nextDecision(
      inboxId,
      { atMs = nowMs(), monotonicMs = monotonicNowMs() } = {},
    ) {
      const state = stateFor(inboxId);
      if (state.inFlight) {
        return {
          shouldPoll: false,
          skipped: true,
          reason: "poll_skipped_in_flight",
          nextPollAtMs: state.nextPollAtMs,
          catchUpReason: null,
        };
      }
      const priorMonotonicMs = state.lastObservedMonotonicMs;
      state.lastObservedMonotonicMs = monotonicMs;
      let catchUpReason = null;
      if (
        priorMonotonicMs !== null &&
        monotonicMs - priorMonotonicMs > POLL_INTERVAL_MS * 2
      ) {
        catchUpReason = "monotonic_gap";
      } else if (state.lastPollStartedAtMs === null) {
        catchUpReason = "daemon_start";
      }
      const shouldPoll = catchUpReason !== null || atMs >= state.nextPollAtMs;
      return {
        shouldPoll,
        skipped: false,
        reason: catchUpReason ? "catch_up" : shouldPoll ? "due" : "not_due",
        nextPollAtMs: state.nextPollAtMs,
        catchUpReason,
      };
    },

    recordPollStarted(inboxId, { atMs = nowMs(), catchUpReason = null } = {}) {
      const state = stateFor(inboxId);
      const priorDeadlineMs = state.nextPollAtMs;
      state.inFlight = true;
      state.lastPollStartedAtMs = atMs;
      if (catchUpReason || priorDeadlineMs <= 0) {
        state.nextPollAtMs = atMs + POLL_INTERVAL_MS;
      } else {
        state.nextPollAtMs = priorDeadlineMs + POLL_INTERVAL_MS;
        while (state.nextPollAtMs <= atMs) {
          state.nextPollAtMs += POLL_INTERVAL_MS;
        }
      }
      return {
        nextPollAtMs: state.nextPollAtMs,
        catchUpReason,
      };
    },

    recordPollFinished(inboxId) {
      const state = stateFor(inboxId);
      state.inFlight = false;
      return state;
    },
  };
}
