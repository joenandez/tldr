import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The tier echo (ac-jfv.74.1, review r5 finding 2). A lane that claims `--tier N` expects the
// result's `tier_filter` to be N. An older Tightbeam ignores `--tier` (no echo), and would hand a
// notice to an ordinary lane or an ordinary delivery to a notice lane: the lane then releases the
// claim unsent, backs off, and warns once per backoff period. A missing echo on claim_held is
// idle, not a fault (only a claimed delivery is checked).
export const TIER_ECHO_BACKOFF_MS = 30_000;

export const echoesTier = (tier, claim) =>
  tier === undefined || claim?.tier_filter === tier;

export const tierEchoWarning = (tier, claim) => ({
  level: "warn",
  event: "tier_filter_not_echoed",
  status: "warn",
  params: { tier, tier_filter: claim?.tier_filter ?? null },
  result: {
    message:
      "Tightbeam did not apply the tier this lane asked for: it is older than this agent (a half-upgraded install). Upgrade Tightbeam and restart its daemon. The claim was released unsent; the lane backs off.",
  },
});

// The email lanes' backoff, a file per tier under the agent home (a drain child has no memory).
export const tierEchoBackoffPath = (home, tier) =>
  join(home, `tier-echo-backoff-${tier}.json`);

export function tierEchoHeld(path, now = Date.now()) {
  try {
    return Number(JSON.parse(readFileSync(path, "utf8")).notBefore) > now;
  } catch {
    return false;
  }
}

export function holdTierEcho(path, now = Date.now()) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify({ notBefore: now + TIER_ECHO_BACKOFF_MS }),
  );
  renameSync(temp, path);
}
