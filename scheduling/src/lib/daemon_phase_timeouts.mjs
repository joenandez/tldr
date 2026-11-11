import { DEFAULT_DISPATCH_LAUNCH_TIMEOUT_MS } from "./daemon_dispatch_fanout.mjs";

export const DEFAULT_DAEMON_PHASE_TIMEOUT_MS = 5000;
// 10 s usage fetch + 5 s sync keychain read + 10 s notice send, with margin.
export const HELD_RELEASE_PHASE_TIMEOUT_MS = 30_000;

function numericTimeout(value, fallback) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : fallback;
}

export function phaseTimeoutFor(
  name,
  {
    phaseTimeoutMs = DEFAULT_DAEMON_PHASE_TIMEOUT_MS,
    dispatchLaunchTimeoutMs = process.env
      .HELM_DAEMON_DISPATCH_LAUNCH_TIMEOUT_MS,
  } = {},
) {
  const baseTimeoutMs = numericTimeout(
    phaseTimeoutMs,
    DEFAULT_DAEMON_PHASE_TIMEOUT_MS,
  );
  if (name === "held_release")
    return Math.max(baseTimeoutMs, HELD_RELEASE_PHASE_TIMEOUT_MS);
  if (name !== "dispatch_launch") return baseTimeoutMs;
  const dispatchTimeoutMs = numericTimeout(
    dispatchLaunchTimeoutMs,
    DEFAULT_DISPATCH_LAUNCH_TIMEOUT_MS,
  );
  return Math.max(baseTimeoutMs, dispatchTimeoutMs);
}
