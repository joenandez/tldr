import { statSync } from "node:fs";

import { userRouteSignalPath } from "../../messaging/src/protocol/user_route_signal.mjs";
import { tightbeamStateRootFor } from "./store.mjs";

const POLL_MS = 1000;
export const FALLBACK_MS = 30_000;

// Written by the Tightbeam daemon on every user-route delivery insert (ac-jfv.74.1); we poll its mtime.
export const urgentWatermarkPath = (stateRoot = tightbeamStateRootFor()) =>
  userRouteSignalPath(stateRoot);

// An fs stat, no daemon request. null: no file yet, which is not a move.
export const mtimeOf = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

// A tick that throws is logged, never ends the lane. Resolves what the tick returned.
async function runTick(tick, reason) {
  try {
    return await tick(reason);
  } catch (error) {
    process.stderr.write(
      `tldr daemon urgent wake tick failed: ${error?.message || error}\n`,
    );
    return undefined;
  }
}

// Why the lane ticks now, or null: the watermark moved, a probe is due, or the fallback period passed.
function wakeReason({ moved, probeAt, sinceTickMs, nowMs, fallbackMs }) {
  if (moved) return "watermark";
  if (nowMs >= probeAt) return "probe";
  return sinceTickMs >= fallbackMs ? "fallback" : null;
}

// One poll: stat the watermark, and tick when it moved, a probe is due, or the fallback period passed.
async function pollOnce(state, { tick, watermarkPath, fallbackMs, now }) {
  const current = mtimeOf(watermarkPath);
  const reason = wakeReason({
    moved: current !== null && current !== state.seen,
    probeAt: state.probeAt,
    sinceTickMs: now() - state.lastTickAt,
    nowMs: now(),
    fallbackMs,
  });
  if (!reason) return;
  state.seen = current ?? state.seen;
  // A probe is not a fallback claim: the 30 s cadence goes on from the last one.
  if (reason !== "probe") state.lastTickAt = now();
  if (now() >= state.probeAt) state.probeAt = Infinity; // served by this tick
  const wakeInMs = await runTick(tick, reason);
  if (wakeInMs > 0) state.probeAt = Math.min(state.probeAt, now() + wakeInMs);
}

// The wake shared by the four user-route lanes (Slack and email, answer and notice). Each `pollMs`
// it stats the watermark (a local stat, no daemon request); a move runs `tick("watermark")` at
// once, and with no move `tick("fallback")` runs at most once per `fallbackMs`, counted from the
// last tick's start. One tick at a time: the lane's next poll waits for it, and a move that lands
// during a tick is served right after it (the watermark seen is taken before the tick). A long
// answer send holds only its own lane, never a notice lane (each tier has its own consumer).
// A tick may return a number of ms (daemon_retry_wake.mjs): one more tick, a "probe", runs then, for
// a delivery it failed that becomes offerable before the fallback. Idle lanes never probe.
// Stop (or --once) waits for the tick in flight. `waitFn` and `now` are injectable for tests.
export function createWatermarkWakeLane({
  tick,
  once,
  isStopped,
  homeExists,
  home,
  waitFn,
  now = Date.now,
  pollMs = POLL_MS,
  fallbackMs = FALLBACK_MS,
  watermarkPath = urgentWatermarkPath(),
}) {
  return async () => {
    const state = {
      seen: mtimeOf(watermarkPath),
      lastTickAt: -Infinity,
      probeAt: Infinity,
    };
    do {
      // Yield a macrotask so an instant waitFn can never starve the other lanes.
      // eslint-disable-next-line no-await-in-loop -- once per poll.
      await new Promise((resolveYield) => setImmediate(resolveYield));
      // eslint-disable-next-line no-await-in-loop -- one tick at a time.
      await pollOnce(state, { tick, watermarkPath, fallbackMs, now });
      if (!once && !isStopped()) {
        // eslint-disable-next-line no-await-in-loop -- one cheap poll per cadence.
        await waitFn(pollMs);
      }
    } while (!once && !isStopped() && homeExists(home));
  };
}
