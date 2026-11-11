// Pure timing math for held runs (usage-limit / provider-outage holds). Times are ms epoch.
const MIN = 60_000;
const NEXT_SLOT_MARGIN_MS = 5 * MIN;
const ONCE_DEFAULT_MS = 24 * 60 * MIN;
const BACKOFF_MIN = [5, 10, 20, 40, 60];
const STAGGER_MS = 60_000;

// Stored jobs hold unset grace as null (job_service normalizeJob); the 300 s default lives only
// in dispatch_evaluator, so only an integer counts as explicit.
const hasExplicitGrace = (job) =>
  Number.isInteger(job?.schedule?.misfire_grace_sec);

/** @returns {number} deadline ms. nextSlot (ms|null) is the next cron slot after `slot`. */
export function computeHeldDeadline(job, slot, nextSlot) {
  const cap = Number.isFinite(nextSlot)
    ? nextSlot - NEXT_SLOT_MARGIN_MS
    : Infinity;
  let deadline;
  if (hasExplicitGrace(job))
    deadline = slot + job.schedule.misfire_grace_sec * 1000;
  else deadline = Number.isFinite(nextSlot) ? cap : slot + ONCE_DEFAULT_MS;
  return Math.min(deadline, cap);
}

/** A usage-limit reset still ahead of the hold's last failure. A reset at or before it already passed
 * (server lag, clock skew), so it is no release time: backoff applies, like a limit with no time (fgp.58). */
export const knownReset = (held) =>
  held.reason === "usage_limit" &&
  Number.isFinite(held.until) &&
  held.until > (held.last_failed_at ?? held.since ?? -Infinity);

/**
 * Next retry time (ms). Limit with a known reset: until. Otherwise backoff 5,10,20,40,60 min indexed by
 * `attempts`, measured from the last failed attempt (`last_failed_at`, else `since`).
 * `now` is only the last resort base when neither is set.
 * @returns {number}
 */
export function nextHeldRetry(held, now) {
  if (knownReset(held)) return held.until;
  const base = held.last_failed_at ?? held.since ?? now;
  const idx = Math.min(held.attempts ?? 0, BACKOFF_MIN.length - 1);
  return base + BACKOFF_MIN[idx] * MIN;
}

/** Brief-tagged first, then slot ascending, 60 s apart from `now`. @returns {{job: object, release_at: number}[]} */
export function orderAndStagger(heldJobs, now) {
  const isBrief = (j) => ((j.tags || []).includes("brief") ? 0 : 1);
  return [...heldJobs]
    .sort(
      (a, b) =>
        isBrief(a) - isBrief(b) || a.state.held.slot - b.state.held.slot,
    )
    .map((job, i) => ({ job, release_at: now + i * STAGGER_MS }));
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// The reconciler's reasons for an attempt that never spawned (a restart between claim and spawn).
const NEVER_STARTED = new Set([
  "claimed_without_wrapper",
  "launching_without_pid",
]);

/** Copy for a hold ended by a ledger refusal: the slot's release ran, unless its last attempt was lost.
 * First match wins. An unreadable terminal proves nothing ran (.49); running_process_missing means the process
 * was gone (it may have completed), only its result is missing (.47). */
const REFUSAL_COPY = [
  [(t) => t?.unreadable, "could not run again; gave up"],
  [(t) => t?.terminal_source !== "lost", "already ran"],
  [
    (t) => NEVER_STARTED.has(t.terminal_reason),
    "interrupted before it started; gave up",
  ],
  [
    (t) => t.terminal_reason === "running_process_missing",
    "ended; its result was not recorded",
  ],
  [() => true, "interrupted; its result was lost"],
];
const refusalMessage = (terminal) =>
  REFUSAL_COPY.find(([hit]) => hit(terminal))[1];

/** "gave up: usage limit until 02:00" | "gave up: provider outage" (" until HH:MM" only for a usage limit with a known reset), local time.
 * A hold ended by a ledger refusal (`refusal` set) was not given up on a limit: see refusalMessage.
 * `terminal` is the slot's logical-run {terminal_reason, terminal_source}. @returns {string} */
export function gaveUpMessage(held, refusal = null, terminal = null) {
  // A release that was lost (its outcome never reached the hold) is not a limit give-up, even past the deadline.
  if (refusal || terminal?.terminal_source === "lost")
    return refusalMessage(terminal);
  const what =
    held.reason === "provider_outage" ? "provider outage" : "usage limit";
  // Only a usage limit has a reset time; an outage hold has just backoff retries.
  return knownReset(held)
    ? `gave up: ${what} until ${hhmm(held.until)}`
    : `gave up: ${what}`;
}
