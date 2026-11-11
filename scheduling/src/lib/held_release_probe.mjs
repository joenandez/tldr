// Usage probe: for usage_limit holds not yet due, ask the provider and pull release forward or push it out.
import {
  isDue,
  memory,
  patchHolds,
  PROBE_EVERY_MS,
} from "./held_release_core.mjs";

const usageLimited = (loaded) =>
  loaded.flatMap(({ scope, holds }) =>
    holds
      .filter((job) => job.state.held.reason === "usage_limit")
      .map((job) => ({ scope, job, provider: job.state.held.provider })),
  );

// usage_limit holds of a provider that are not yet due, so a probe could change the outcome.
function collectWaiting(loaded, now) {
  const limited = usageLimited(loaded);
  const live = new Set(limited.map((l) => l.provider));
  for (const provider of memory.permanent)
    if (!live.has(provider)) memory.permanent.delete(provider);
  const waiting = new Map();
  for (const { scope, job, provider } of limited) {
    if (isDue(job.state.held, now)) continue;
    waiting.set(provider, [...(waiting.get(provider) ?? []), { scope, job }]);
  }
  return waiting;
}

const shouldProbe = (provider, now) =>
  !memory.permanent.has(provider) &&
  now - (memory.lastProbe.get(provider) ?? -Infinity) >= PROBE_EVERY_MS;

export function mutatorFor(result, now) {
  if (result.state === "available")
    return (held) =>
      Object.assign(held, { until: now, release_requested_by: "usage_check" });
  if (result.state === "limited" && result.resets_at)
    return (held) => {
      // A reset already past is no release time (fgp.58): the hold keeps its backoff.
      if (result.resets_at > Math.max(held.until ?? 0, now))
        held.until = result.resets_at;
    };
  return null;
}

async function applyToTargets(targets, mutate) {
  for (const { scope, job } of targets) {
    // eslint-disable-next-line no-await-in-loop -- one scope lease at a time
    await patchHolds(scope, "held_usage_check", [
      {
        jobId: job.id,
        slot: job.state.held.slot,
        apply: (fresh) => mutate(fresh.state.held),
      },
    ]);
    mutate(job.state.held);
  }
}

export async function probeUsage(loaded, now, { usage, log }) {
  const waiting = collectWaiting(loaded, now);
  let probed = 0;
  for (const [provider, targets] of waiting) {
    if (!shouldProbe(provider, now)) continue;
    memory.lastProbe.set(provider, now);
    probed += 1;
    // eslint-disable-next-line no-await-in-loop -- one provider at a time
    const result = await usage(provider, { now: () => now, log });
    if (result.permanent) memory.permanent.add(provider);
    const mutate = mutatorFor(result, now);
    // eslint-disable-next-line no-await-in-loop -- one provider at a time
    if (mutate) await applyToTargets(targets, mutate);
  }
  return probed;
}
