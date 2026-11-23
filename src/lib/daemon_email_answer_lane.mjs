import { createSkipWarner } from "./daemon_lane_skip_warn.mjs";
import { createWatermarkWakeLane } from "./daemon_urgent_wake.mjs";
import { runDaemonOutboundSequence } from "./daemon_mail_child_phases.mjs";

// The answer email lane (tier 1, ac-jfv.74.1): an answer to the user must not wait behind the
// ordinary outbound lane, which sleeps 10 s between ticks and cannot interrupt a send in flight.
// This lane wakes on the user-route watermark (or its 30 s fallback, daemon_urgent_wake.mjs) and
// runs an answer-only drain child: claims `--tier 1` until claim_held, nothing else. One tick at a
// time. A tier-0 notice has its own lane (daemon_email_notice_lane.mjs), so a 25 s answer send
// holds no notice. Tightbeam leases a claimed delivery to one claimant, and a delivery re-offered
// after a lost lease completes from its provider receipt without a second send
// (tightbeam_email_adapter.mjs), so this lane and the ordinary one never send a delivery twice.
//
// The lane polls always and checks per tick that email is connected (the same target check as the
// ordinary lane's drain), so an inbox connected while the daemon runs is picked up.
export function createEmailAnswerLane({
  once,
  isStopped,
  homeExists,
  home,
  waitFn,
  now,
  pollMs,
  fallbackMs,
  watermarkPath,
  daemonInstanceId,
  appendActivityEvent,
  runAnswerSequence = (args) =>
    runDaemonOutboundSequence({ ...args, answerOnly: true }),
  ...sequence
}) {
  const record = (status, extra = {}) => {
    try {
      appendActivityEvent(
        {
          event_type: "daemon_email_answer_lane",
          daemon_instance_id: daemonInstanceId,
          status,
          ...extra,
        },
        { home },
      );
    } catch {
      // Logging is best effort.
    }
  };
  const warnSkip = createSkipWarner({ lane: "answer", record });
  const wake = createWatermarkWakeLane({
    once,
    isStopped,
    homeExists,
    home,
    waitFn,
    now,
    pollMs,
    fallbackMs,
    watermarkPath,
    tick: async () => {
      try {
        const ran = await runAnswerSequence({
          ...sequence,
          daemonInstanceId,
          appendActivityEvent,
        });
        warnSkip(ran?.phaseResults?.[0]?.result);
      } catch (error) {
        // A failed tick must never end the lane; the next wake retries.
        process.stderr.write(
          `tldr daemon email answer lane failed: ${error?.message || error}\n`,
        );
        record("error", {
          event_type: "daemon_email_answer_tick_failed",
          metadata: { error: error?.message || String(error) },
        });
      }
    },
  });
  return async () => {
    record("started");
    try {
      await wake();
    } finally {
      record("stopped");
    }
  };
}
