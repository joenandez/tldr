// A single poison delivery must never occupy the whole tick: drain every
// claimable delivery (bounded) instead of stopping after the first one.
export const MAX_OUTBOUND_DELIVERIES_PER_POLL = 10;

// Worst-case time one claimed send needs (the 25 s Aegis outbound socket
// timeout plus the Tightbeam CLI calls); the drain claims again only when at
// least this much of the outbound deadline remains.
export const OUTBOUND_SEND_BUDGET_MS = 40000;

const HALT = true;

const outOfTime = (deadlineMs) =>
  deadlineMs !== null && deadlineMs - Date.now() < OUTBOUND_SEND_BUDGET_MS;

const isIdle = (outcome) =>
  outcome?.ok !== true && outcome?.code === "claim_unavailable";

// One claim of the drain's tier (ac-jfv.74.1: the ordinary drain is tier 2, the answer drain tier
// 1; none: all tiers): its claim and send times go to `timings`; the outcome or the thrown error
// comes back.
async function claimOnce(state) {
  const startedAt = Date.now();
  let claimedAt = null;
  try {
    const outcome = await state.adapter.deliverOnce({
      tier: state.tier,
      afterReplyBindingRecorded: async (recorded) => {
        claimedAt = Date.now();
        await state.onReplyBindingRecorded(recorded);
      },
    });
    return { outcome };
  } catch (error) {
    return { error };
  } finally {
    state.timings.claim_ms += (claimedAt ?? Date.now()) - startedAt;
    if (claimedAt) state.timings.send_ms += Date.now() - claimedAt;
  }
}

// Counts a claimed delivery; true when the drain must stop.
function tally(state, outcome) {
  state.counts.attempted += 1;
  if (outcome?.ok === true) state.counts.delivered += 1;
  // Released to Tightbeam for its backoff retry: not a failure.
  else if (outcome?.released === true) state.released += 1;
  // Skipped by policy: another channel delivered the message (ac-jfv.55).
  else if (outcome?.skipped === true) state.skipped += 1;
  else {
    state.counts.failed += 1;
    state.lastFailure = outcome;
    // Item 49: a failed claim (not an empty queue) is an outbound failure,
    // and claiming again in the same tick would only repeat it.
    return outcome?.code === "claim_failed";
  }
  return false;
}

// One claim attempt; true when the drain stops.
async function claimStep(state) {
  if (outOfTime(state.deadlineMs)) {
    state.stoppedForDeadline = true;
    return HALT;
  }
  const { outcome, error } = await claimOnce(state);
  if (error) {
    state.thrown = error;
    return HALT;
  }
  return isIdle(outcome) || tally(state, outcome);
}

export async function drainOutboundDeliveries({
  adapter,
  onReplyBindingRecorded,
  deadlineMs = null,
  tier,
}) {
  // claim_ms: until the claim and its reply binding are in hand (or an idle claim answers);
  // send_ms: the rest of a claimed delivery (send, record, complete).
  const state = {
    adapter,
    onReplyBindingRecorded,
    deadlineMs,
    tier,
    counts: { attempted: 0, delivered: 0, failed: 0 },
    timings: { claim_ms: 0, send_ms: 0 },
    released: 0,
    skipped: 0,
    stoppedForDeadline: false,
    lastFailure: null,
    thrown: null,
  };
  const startedAt = Date.now();
  let halted = false;
  while (!halted && state.counts.attempted < MAX_OUTBOUND_DELIVERIES_PER_POLL) {
    // eslint-disable-next-line no-await-in-loop -- one claim at a time.
    halted = await claimStep(state);
  }
  return {
    counts: {
      ...state.counts,
      ...(state.released ? { released: state.released } : {}),
      ...(state.skipped ? { skipped: state.skipped } : {}),
      ...(state.stoppedForDeadline ? { stopped_for_deadline: true } : {}),
    },
    lastFailure: state.lastFailure,
    thrown: state.thrown,
    timings: { ...state.timings, total_ms: Date.now() - startedAt },
  };
}
