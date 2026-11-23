import { join } from "node:path";

import {
  recordLaneResult,
  slackOutboundChannel,
  slackTickOnce,
} from "./daemon_slack_lane.mjs";
import { retryWakeInMs } from "./daemon_retry_wake.mjs";
import { createWatermarkWakeLane } from "./daemon_urgent_wake.mjs";
import { outboundLogger } from "./slack_outbound_diagnostics.mjs";
import { createTightbeamSlackAdapter } from "./tightbeam_slack_adapter.mjs";
import { TLDR_AGENT_SLACK_ANSWER } from "./tldr_agent_daemon_phase_timeouts.mjs";

const LANE = "slack_answer";

// Its own file: the normal lane's backoff (any Slack failure) never gates this lane.
export const answerBackoffPath = (home) =>
  join(home, "slack", "answer-outbound-backoff.json");

// One answer tick (tier 1, the answers to the user): claim `--tier 1`, post, complete, and claim
// again while claims succeed (one adapter per delivery: its post deadline serves one claim).
// A failed delivery does not end the claiming: an earlier failure never holds a newer reply
// (P0-19). It ends at claim_held, a claim that holds no delivery (backoff, abort), a delivery
// offered again within the tick, or the end of the phase. Logs each delivery, never an idle claim.
const endsClaiming = (result, seen, signal) =>
  !result.delivery_id || seen.has(result.delivery_id) || signal?.aborted;

export async function runSlackAnswerOnce({
  home,
  daemonInstanceId,
  signal,
  channel = slackOutboundChannel(home),
  fetchImpl,
  postTimeoutMs = TLDR_AGENT_SLACK_ANSWER.postTimeoutMs,
  leaseMs = TLDR_AGENT_SLACK_ANSWER.leaseMs,
  lookupMs = TLDR_AGENT_SLACK_ANSWER.lookupMs,
  settleMs = TLDR_AGENT_SLACK_ANSWER.settleMs,
}) {
  const results = [];
  const seen = new Set();
  for (;;) {
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop -- one claim at a time; each ends before the next.
      result = await createTightbeamSlackAdapter({
        channel,
        home,
        fetchImpl,
        logger: outboundLogger(home),
        tier: 1,
        postTimeoutMs,
        leaseMs,
        lookupMs,
        settleMs,
        backoffPath: answerBackoffPath(home),
      }).deliverOnce();
    } catch (error) {
      recordLaneResult({ home, lane: LANE, daemonInstanceId, error });
      return results;
    }
    results.push(result);
    const idle = result.ok !== true && result.code === "claim_unavailable";
    if (!idle) recordLaneResult({ home, lane: LANE, daemonInstanceId, result });
    if (endsClaiming(result, seen, signal)) return results;
    seen.add(result.delivery_id);
  }
}

// The answer lane: the shared watermark wake, each wake running one answer tick.
export function createSlackAnswerLane({
  once,
  isStopped,
  homeExists,
  home,
  waitFn,
  now,
  pollMs,
  fallbackMs,
  watermarkPath,
  runSlackAnswer = runSlackAnswerOnce,
  ...tick
}) {
  return createWatermarkWakeLane({
    once,
    isStopped,
    homeExists,
    home,
    waitFn,
    now,
    pollMs,
    fallbackMs,
    watermarkPath,
    tick: async () =>
      retryWakeInMs(
        await slackTickOnce({
          home,
          once,
          phaseName: LANE,
          ...tick,
          runSlackTick: runSlackAnswer,
        }),
      ),
  });
}
