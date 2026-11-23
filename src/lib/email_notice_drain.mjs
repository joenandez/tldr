import { pumpNotices } from "./notice_pump.mjs";

const isIdle = (result) =>
  result?.ok !== true && result?.code === "claim_unavailable";

// The notice lane's send: cut at `ms`, and an ambiguous failure (the provider may hold the send,
// this cut included) is handed to the adapter as a plain failure, which releases the delivery. The
// next claim sends under the same idempotency key, so nothing is lost and the provider never sends
// twice. The answer and ordinary lanes keep the adapter's rule: an ambiguous send is left to its
// lease.
export function withSendTimeout(send, ms) {
  return (row, context) => {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error("notice send timed out"), {
              code: "notice_send_timeout",
            }),
          ),
        ms,
      );
    });
    return Promise.race([send(row, context), deadline])
      .catch((error) => {
        if (error?.ambiguous === true) error.ambiguous = false;
        throw error;
      })
      .finally(() => clearTimeout(timer));
  };
}

const outboundError = (code) =>
  code === "invalid_claimed_delivery"
    ? "tightbeam_invalid_claimed_delivery"
    : "tightbeam_delivery_failed";

// The counts of a tick, in the shape a poll child reports its outbound drain.
function summarize(results, timings) {
  const claimed = results.filter((result) => !isIdle(result));
  const delivered = claimed.filter((r) => r?.ok === true).length;
  const released = claimed.filter((r) => r?.released === true).length;
  const failures = claimed.filter((r) => r?.ok !== true && !r?.released);
  const counts = {
    attempted: claimed.length,
    delivered,
    failed: failures.length,
    ...(released ? { released } : {}),
  };
  const thrown = failures.find((r) => r?.thrown)?.thrown;
  const last = failures.at(-1);
  if (!last) return { ok: true, ...counts, timings };
  return {
    ok: false,
    error: thrown ? outboundError(thrown.code) : outboundError(last.error),
    ...(last.delivery_id ? { delivery_id: last.delivery_id } : {}),
    ...(last.code === "claim_failed"
      ? { cause: "claim_failed", tightbeam_code: last.tightbeam_code ?? null }
      : {}),
    ...counts,
    timings,
  };
}

// One notice tick (tier 0): claims until claim_held and sends each claimed notice in its own task,
// at most `limit` at once (notice_pump.mjs). `deadlineMs` stops new claims. claim_ms and send_ms
// are the slowest claim and the slowest send of the tick; total_ms the tick.
export async function drainNotices({ adapter, deadlineMs = null, limit = 4 }) {
  const startedAt = Date.now();
  const timings = { claim_ms: 0, send_ms: 0 };
  const runOne = async ({ onClaimed }) => {
    const claimStartedAt = Date.now();
    let claimedAt = null;
    try {
      return await adapter.deliverOnce({
        tier: 0,
        afterReplyBindingRecorded: async () => {
          claimedAt = Date.now();
          onClaimed();
        },
      });
    } finally {
      const endedAt = Date.now();
      timings.claim_ms = Math.max(
        timings.claim_ms,
        (claimedAt ?? endedAt) - claimStartedAt,
      );
      if (claimedAt)
        timings.send_ms = Math.max(timings.send_ms, endedAt - claimedAt);
    }
  };
  const results = await pumpNotices({
    runOne,
    limit,
    stopped: () => deadlineMs !== null && Date.now() > deadlineMs,
  });
  return summarize(results, { ...timings, total_ms: Date.now() - startedAt });
}
