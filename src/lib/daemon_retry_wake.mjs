// When a user-route lane should tick again after a tick that failed a delivery (ac-jfv.74.1, P0-18
// and P0-19 at load 100+). The fallback claim runs every 30 s from the last tick's start, so a
// delivery offerable 34 s after it failed waited for the tick at 60 s. Two times matter: `retry_at`,
// when a released delivery is offered again, and `held_until`, when the lease of a claim whose
// settle missed its bound ends (a held claim keeps the newer deliveries of its thread waiting).
// Returns ms from now to just after the earliest of them, or null.
const MARGIN_MS = 500;

export function retryWakeInMs(results, now = Date.now()) {
  const times = (results ?? [])
    .flatMap((result) => [
      Number(result?.retry_at),
      Date.parse(result?.held_until),
    ])
    .filter((time) => time > now);
  return times.length ? Math.min(...times) - now + MARGIN_MS : null;
}
