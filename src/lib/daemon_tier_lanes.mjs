import { createEmailAnswerLane } from "./daemon_email_answer_lane.mjs";
import { createEmailNoticeLane } from "./daemon_email_notice_lane.mjs";
import {
  createSlackAnswerLane,
  runSlackAnswerOnce,
} from "./daemon_slack_answer_lane.mjs";
import {
  createSlackNoticeLane,
  runSlackNoticeOnce,
} from "./daemon_slack_notice_lane.mjs";
import {
  tldrAgentSlackAnswerPhaseTimeout,
  tldrAgentSlackNoticePhaseTimeout,
} from "./tldr_agent_daemon_phase_timeouts.mjs";

// The four user-route lanes (ac-jfv.74.1): one consumer per tier beside the ordinary lanes
// (tier 2), each on its own claim, lease, backoff and phase, so no send in one tier delays
// another. Answers (tier 1) and notices (tier 0), Slack and email; all four share the watermark
// wake (daemon_urgent_wake.mjs): `pollMs`, `fallbackMs` and `watermarkPath` are test seams of it.
export function createTierLanes({
  home,
  once,
  daemonInstanceId,
  slackListener,
  runPhase,
  waitFn,
  homeExists,
  isStopped,
  emailSequenceArgs,
  runSlackAnswer = runSlackAnswerOnce,
  runSlackNotice = runSlackNoticeOnce,
  runAnswerEmailSequence,
  emailNoticeWarm,
  slackAnswerPhaseTimeoutMs = tldrAgentSlackAnswerPhaseTimeout(),
  slackNoticePhaseTimeoutMs = tldrAgentSlackNoticePhaseTimeout(),
  pollMs,
  fallbackMs,
  watermarkPath,
}) {
  const wake = { waitFn, pollMs, fallbackMs, watermarkPath };
  const lane = { home, once, homeExists, isStopped, ...wake };
  const slack = { daemonInstanceId, slackListener, runPhase };
  return {
    slackAnswerLane: createSlackAnswerLane({
      ...lane,
      ...slack,
      runSlackAnswer,
      phaseTimeoutMs: slackAnswerPhaseTimeoutMs,
    }),
    slackNoticeLane: createSlackNoticeLane({
      ...lane,
      ...slack,
      runSlackNotice,
      phaseTimeoutMs: slackNoticePhaseTimeoutMs,
    }),
    emailAnswerLane: createEmailAnswerLane({
      ...emailSequenceArgs,
      ...lane,
      runAnswerSequence: runAnswerEmailSequence,
    }),
    emailNoticeLane: createEmailNoticeLane({
      ...emailSequenceArgs,
      ...lane,
      ...(emailNoticeWarm ? { warm: emailNoticeWarm } : {}),
    }),
  };
}
