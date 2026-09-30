/**
 * Shared schedule-flag builder used by helm-tasks and helm-assignments.
 *
 * Extracted from src/helm-tasks.mjs:2034-2086 so both binaries produce
 * identical schedule{} objects without duplicating the implementation.
 *
 * nowDate() is defined here (not in helm-tasks) and re-exported so
 * helm-tasks can import it and drop its local copy — preventing two
 * divergent definitions from drifting apart.
 */
import { parseEvery } from "./schedule_eval.mjs";

/**
 * Returns the current date, honoring the HELM_NOW test-clock hook.
 * @returns {Date}
 */
export function nowDate() {
  return process.env.HELM_NOW ? new Date(process.env.HELM_NOW) : new Date();
}

/**
 * Build a schedule{} object from parsed CLI flags.
 *
 * Accepted flags (all optional):
 *   --in <duration>           e.g. "2m", "1h", "1d" → once, start_at = now + duration
 *   --at / --once-at <iso>    → once, start_at = <iso>
 *   --cron <expr>             → recurring
 *   --every <duration>        → interval
 *   --end-at <iso>
 *   --timezone <tz>
 *   --max-catchup-runs <n>
 *   --missed-run-policy <str>
 *   --misfire-grace-sec <n>
 *   --max-catchup-cost <n>
 *   --estimated-catchup-cost <n>
 *   --overlap-policy <str>
 *   --jitter-sec <n>
 *   --no-network-check
 *   --network-host <host>
 *
 * Returns a schedule object when at least one schedule flag is present,
 * or null when no schedule flags were provided.
 *
 * @param {Record<string, unknown>} flags
 * @returns {{ type: string, [key: string]: unknown } | null}
 */
export function buildScheduleFromFlags(flags) {
  const schedule = {};
  const now = nowDate();

  if (flags["once-at"] || flags.at) {
    schedule.type = "once";
    schedule.start_at = flags["once-at"] || flags.at;
  } else if (flags.in) {
    const ms = parseEvery(flags.in);
    if (!ms) throw new Error("--in must be a duration like 2m/1h/1d");
    schedule.type = "once";
    schedule.start_at = new Date(now.getTime() + ms).toISOString();
  } else if (flags.cron) {
    schedule.type = "recurring";
    schedule.cron = flags.cron;
  } else if (flags.every) {
    schedule.type = "interval";
    schedule.every = flags.every;
  }

  if (flags["end-at"]) schedule.end_at = flags["end-at"];
  if (flags.timezone) schedule.timezone = flags.timezone;
  if (flags["max-catchup-runs"] !== undefined)
    schedule.max_catchup_runs = Number(flags["max-catchup-runs"]);
  if (flags["missed-run-policy"] !== undefined)
    schedule.missed_run_policy = flags["missed-run-policy"];
  if (flags["misfire-grace-sec"] !== undefined)
    schedule.misfire_grace_sec = Number(flags["misfire-grace-sec"]);
  if (flags["max-catchup-cost"] !== undefined)
    schedule.max_catchup_cost = Number(flags["max-catchup-cost"]);
  if (flags["estimated-catchup-cost"] !== undefined)
    schedule.estimated_catchup_cost = Number(flags["estimated-catchup-cost"]);
  if (flags["overlap-policy"] !== undefined)
    schedule.overlap_policy = flags["overlap-policy"];
  if (flags["jitter-sec"] !== undefined)
    schedule.jitter_sec = Number(flags["jitter-sec"]);

  if (flags["no-network-check"]) {
    schedule.preconditions = {
      ...(schedule.preconditions || {}),
      network: false,
    };
  }
  if (flags["network-host"]) {
    schedule.preconditions = {
      network: true,
      ...(schedule.preconditions || {}),
      network_host: String(flags["network-host"]),
    };
  }

  return Object.keys(schedule).length > 0 ? schedule : null;
}
