import { slackTickOnce } from "./daemon_slack_lane.mjs";
import { createWatermarkWakeLane } from "./daemon_urgent_wake.mjs";
import { slackInboxPath } from "./slack_socket_listener.mjs";

// A stat of the inbox every 250 ms: one local syscall, no daemon request (ac-srg29: main thread).
const INBOUND_POLL_MS = 250;

// The inbound lane wakes when the listener appends to the inbox (its mtime moves), so a user's
// Slack message is committed within a poll of socket receipt, not on the next cadence tick
// (ac-jfv.228). The fallback keeps the cadence drain as the safety net: lines a drain left to
// retry, and listener supervision (each tick syncs the listener). Rotation removes the file,
// which is not a move; the listener's next append makes a new one, which is.
export function createSlackInboundWakeLane({
  once,
  isStopped,
  homeExists,
  home,
  waitFn,
  now,
  pollMs = INBOUND_POLL_MS,
  fallbackMs,
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
    watermarkPath: slackInboxPath(home),
    tick: async () => {
      await slackTickOnce({
        home,
        once,
        phaseName: "slack_inbound",
        superviseListener: true,
        ...tick,
      });
    },
  });
}
