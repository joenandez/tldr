import { join } from "node:path";

import {
  recordLaneResult,
  slackOutboundChannel,
  slackTickOnce,
} from "./daemon_slack_lane.mjs";
import { retryWakeInMs } from "./daemon_retry_wake.mjs";
import { createWatermarkWakeLane } from "./daemon_urgent_wake.mjs";
import { pumpNotices } from "./notice_pump.mjs";
import { outboundLogger } from "./slack_outbound_diagnostics.mjs";
import { createTightbeamSlackAdapter } from "./tightbeam_slack_adapter.mjs";
import { TLDR_AGENT_SLACK_NOTICE } from "./tldr_agent_daemon_phase_timeouts.mjs";

const LANE = "slack_notice";
const MAX_CONCURRENT_NOTICES = 4;

// Its own file, written only for a Slack 429: any other failure must not hold a notice, and no
// other lane's backoff gates this one.
export const noticeBackoffPath = (home) =>
  join(home, "slack", "notice-outbound-backoff.json");

// One notice tick (tier 0: busy and resume_failed notices): claims `--tier 0` until claim_held and
// sends each claimed notice in its own task, at most 4 at once (notice_pump.mjs). One adapter per
// delivery: its 8 s post deadline serves one claim. Notices take no thread lock (withThreadTurn).
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
}) {
  const runOne = async ({ onClaimed }) => {
    let result;
    try {
      result = await createTightbeamSlackAdapter({
        channel,
        home,
        fetchImpl,
        logger: outboundLogger(home),
        tier: 0,
        onClaimed,
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
  });
  return results.filter((r) => r.code !== "claim_unavailable");
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
          runSlackTick: runSlackNotice,
        }),
      ),
  });
}
