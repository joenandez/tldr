import { join } from "node:path";

import {
  recordLaneResult,
  slackOutboundChannel,
  slackTickOnce,
} from "./daemon_slack_lane.mjs";
import { retryWakeInMs } from "./daemon_retry_wake.mjs";
import {
  createWatermarkWakeLane,
  mtimeOf,
  urgentWatermarkPath,
} from "./daemon_urgent_wake.mjs";
import { pumpNotices } from "./notice_pump.mjs";
import { outboundLogger } from "./slack_outbound_diagnostics.mjs";
import { createTightbeamSlackAdapter } from "./tightbeam_slack_adapter.mjs";
import {
  TLDR_AGENT_SLACK_NOTICE,
  tldrAgentSlackNoticeClaimWindowMs,
} from "./tldr_agent_daemon_phase_timeouts.mjs";

const LANE = "slack_notice";
const MAX_CONCURRENT_NOTICES = 4;

// Its own file, written only for a Slack 429: any other failure must not hold a notice, and no
// other lane's backoff gates this one.
export const noticeBackoffPath = (home) =>
  join(home, "slack", "notice-outbound-backoff.json");

// One notice tick (tier 0: busy and resume_failed notices): claims `--tier 0` and sends each
// claimed notice in its own task, at most 4 claiming or posting at once per tick (notice_pump.mjs;
// a task in its settle call holds no slot), and at most 2 of them claiming. A task detached at the
// window keeps running, so the next tick may add its own: up to 8 claiming or posting, 4 claiming,
// across two ticks. After a claim_held it claims again only when the user-route watermark moves,
// so a notice due while a send is slow is not held to the tick's end. At `claimWindowMs` the tick
// ends without waiting for the sends in flight (notice_pump.mjs `deadlineAt`): a due notice is
// claimed by the next tick, never behind a slow complete, and the tick never reaches its phase.
// One adapter per delivery: its 8 s post deadline serves one claim. Notices take no thread lock (withThreadTurn).
// Logs each claimed delivery, never an idle claim. Resolves with the result of every claimed
// delivery (the closing idle claim is not one).
export async function runSlackNoticeOnce({
  home,
  daemonInstanceId,
  signal,
  channel = slackOutboundChannel(home),
  fetchImpl,
  limit = MAX_CONCURRENT_NOTICES,
  postTimeoutMs = TLDR_AGENT_SLACK_NOTICE.postTimeoutMs,
  leaseMs = TLDR_AGENT_SLACK_NOTICE.leaseMs,
  lookupMs = TLDR_AGENT_SLACK_NOTICE.lookupMs,
  settleMs = TLDR_AGENT_SLACK_NOTICE.settleMs,
  watermarkPath = urgentWatermarkPath(),
  claimWindowMs = tldrAgentSlackNoticeClaimWindowMs(),
  watchMs,
  carry = [],
}) {
  const deadlineAt = Date.now() + claimWindowMs;
  const runOne = async ({ onClaimed, onSettling }) => {
    let result;
    try {
      result = await createTightbeamSlackAdapter({
        channel,
        home,
        fetchImpl,
        logger: outboundLogger(home),
        tier: 0,
        onClaimed,
        onSettling,
        postTimeoutMs,
        leaseMs,
        lookupMs,
        settleMs,
        backoffPath: noticeBackoffPath(home),
      }).deliverOnce();
    } catch (error) {
      recordLaneResult({ home, lane: LANE, daemonInstanceId, error });
      return { ok: false, thrown: error };
    }
    const idle = result.ok !== true && result.code === "claim_unavailable";
    if (!idle) recordLaneResult({ home, lane: LANE, daemonInstanceId, result });
    return result;
  };
  const results = await pumpNotices({
    runOne,
    limit,
    stopped: () => signal?.aborted,
    stamp: () => mtimeOf(watermarkPath),
    watchMs,
    deadlineAt,
    onLate: (result) => carry.push(result),
  });
  // What the sends detached by an earlier tick ended with: their held_until still wakes the lane.
  return [...carry.splice(0), ...results].filter(
    (r) => r.code !== "claim_unavailable",
  );
}

// The notice lane: the shared watermark wake, each wake running one notice tick.
export function createSlackNoticeLane({
  once,
  isStopped,
  homeExists,
  home,
  waitFn,
  now,
  pollMs,
  fallbackMs,
  watermarkPath,
  runSlackNotice = runSlackNoticeOnce,
  ...tick
}) {
  const carry = []; // results of sends a tick left in flight at its window
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
          runSlackTick: (args) =>
            runSlackNotice({ ...args, watermarkPath, carry }),
        }),
      ),
  });
}
