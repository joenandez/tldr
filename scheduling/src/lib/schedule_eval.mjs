const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function toDate(nowIso = null) {
  if (nowIso) return new Date(nowIso);
  if (process.env.HELM_NOW) return new Date(process.env.HELM_NOW);
  return new Date();
}

export function parseEvery(value) {
  const m = String(value || "").match(/^(\d+)([smhd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[u];
  return n * mult;
}

function parseField(token, min, max) {
  const set = new Set();
  const addRange = (start, end, step = 1) => {
    for (let i = start; i <= end; i += step) set.add(i);
  };

  if (token === "*") {
    addRange(min, max, 1);
    return set;
  }

  for (const part of token.split(",")) {
    const [base, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step <= 0) return null;

    if (base === "*") {
      addRange(min, max, step);
      continue;
    }

    if (base.includes("-")) {
      const [s, e] = base.split("-").map(Number);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s > e) return null;
      addRange(s, e, step);
      continue;
    }

    const v = Number(base);
    if (!Number.isFinite(v)) return null;
    set.add(v);
  }

  for (const v of set) {
    if (v < min || v > max) return null;
  }

  return set;
}

export function parseCron(expr) {
  const parts = String(expr || "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = [];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]);
    if (!parsed) return null;
    fields.push(parsed);
  }
  return fields;
}

// Opportunity #10: memoized cron parse and per-timezone formatters. The old
// next-run path re-parsed the cron and built a fresh Intl.DateTimeFormat for
// every probed minute (up to ~532k constructions per call).
const cronParseCache = new Map();
function parseCronCached(expr) {
  const key = String(expr || "").trim();
  if (cronParseCache.has(key)) return cronParseCache.get(key);
  if (cronParseCache.size > 500) cronParseCache.clear();
  const parsed = parseCron(key);
  cronParseCache.set(key, parsed);
  return parsed;
}

const tzFormatterCache = new Map();
function tzFormatter(timezone) {
  let fmt = tzFormatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    if (tzFormatterCache.size > 100) tzFormatterCache.clear();
    tzFormatterCache.set(timezone, fmt);
  }
  return fmt;
}

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function dateInTimezoneParts(date, timezone) {
  const parts = Object.fromEntries(
    tzFormatter(timezone)
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    dow: WEEKDAY_MAP[parts.weekday],
  };
}

export function cronMatches(date, cronExpr, timezone) {
  const parsed = parseCronCached(cronExpr);
  if (!parsed) return false;
  const p = dateInTimezoneParts(date, timezone);
  return (
    parsed[0].has(p.minute) &&
    parsed[1].has(p.hour) &&
    parsed[2].has(p.day) &&
    parsed[3].has(p.month) &&
    parsed[4].has(p.dow)
  );
}

// ---- Opportunity #10: direct-field next-run computation -----------------
// Replaces the minute-by-minute scan (≈532k iterations + an Intl construct
// each for sparse crons, hard 370-day horizon, and two DST bugs: a
// spring-forward gap time returned null → the job silently stopped
// scheduling, and a fall-back duplicated hour could fire twice).
// Semantics preserved from the scanner: day-of-month AND day-of-week (the
// existing matcher's behavior), candidates begin at the minute after `from`.
// DST contract: a wall time wiped out by spring-forward fires once at the
// instant the gap ends; a wall time duplicated by fall-back fires only at
// its first UTC instant.

function wallMsOf(wall) {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

function wallPartsAt(ms, timezone) {
  return dateInTimezoneParts(new Date(ms), timezone);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dowOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// All UTC instants whose wall clock in `timezone` equals `wall`. Two entries
// for a fall-back duplicated time, none for a spring-forward gap.
function utcInstantsForWall(wall, timezone) {
  const targetMs = wallMsOf(wall);
  let guess = targetMs;
  for (let i = 0; i < 4; i++) {
    const observed = wallMsOf(wallPartsAt(guess, timezone));
    if (observed === targetMs) break;
    guess += targetMs - observed;
  }
  const instants = [];
  // Probe ±1h/±30m around the converged guess: DST deltas are 60 or 30 min.
  for (const cand of new Set([
    guess - 3_600_000,
    guess - 1_800_000,
    guess,
    guess + 1_800_000,
    guess + 3_600_000,
  ])) {
    if (wallMsOf(wallPartsAt(cand, timezone)) === targetMs) {
      instants.push(cand);
    }
  }
  return { instants: instants.sort((a, b) => a - b), guess };
}

// First instant at/after the spring-forward jump that wiped out `wall`:
// minute-scan a ±3h window around the converged guess (rare path, cached
// formatter, ≤360 iterations).
function gapEndInstant(wall, timezone, guess) {
  const targetMs = wallMsOf(wall);
  for (let t = guess - 3 * 3_600_000; t <= guess + 3 * 3_600_000; t += 60_000) {
    if (wallMsOf(wallPartsAt(t, timezone)) >= targetMs) return t;
  }
  return null;
}

// Next wall-clock {year,month,day,hour,minute} at/after `start` matching the
// parsed cron fields. Pure integer arithmetic; guard covers >4 years of days
// (enough for Feb-29 crons) before declaring the schedule impossible.
function nextMatchingWall(fields, start) {
  const minutes = [...fields[0]].sort((a, b) => a - b);
  const hours = [...fields[1]].sort((a, b) => a - b);
  let { year, month, day } = start;
  let startHour = start.hour;
  let startMinute = start.minute;
  const bumpDay = () => {
    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    startHour = 0;
    startMinute = 0;
  };
  for (let guard = 0; guard < 1700; guard++) {
    if (!fields[3].has(month)) {
      month += 1;
      day = 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      startHour = 0;
      startMinute = 0;
      continue;
    }
    if (!fields[2].has(day) || !fields[4].has(dowOf(year, month, day))) {
      bumpDay();
      continue;
    }
    for (const hour of hours) {
      if (hour < startHour) continue;
      const minuteFloor = hour === startHour ? startMinute : 0;
      for (const minute of minutes) {
        if (minute < minuteFloor) continue;
        return { year, month, day, hour, minute };
      }
    }
    bumpDay();
  }
  return null;
}

function incrementWallMinute(wall) {
  const d = new Date(wallMsOf(wall) + 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

export function computeNextForRecurring(cronExpr, timezone, fromIso) {
  const fields = parseCronCached(cronExpr);
  if (!fields) return null;
  const fromTime = new Date(fromIso).getTime();
  if (!Number.isFinite(fromTime)) return null;
  const fromMs = Math.floor(fromTime / 60_000) * 60_000 + 60_000;
  let startWall = wallPartsAt(fromMs, timezone);
  for (let hop = 0; hop < 5000; hop++) {
    const wall = nextMatchingWall(fields, startWall);
    if (!wall) return null;
    const { instants, guess } = utcInstantsForWall(wall, timezone);
    if (instants.length > 0) {
      // Fall-back duplicate: only the first occurrence counts. If that
      // occurrence already passed (we are inside/after the repeated hour),
      // this wall time has fired — skip it entirely rather than double-fire.
      if (instants[0] >= fromMs) return new Date(instants[0]).toISOString();
    } else {
      // Spring-forward gap: fire at the moment the gap ends.
      const t = gapEndInstant(wall, timezone, guess);
      if (t !== null && t >= fromMs) return new Date(t).toISOString();
    }
    startWall = incrementWallMinute(wall);
  }
  return null;
}

export function computeInitialNextRun(job, nowIso = null) {
  const now = toDate(nowIso);
  const tz =
    job.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (job.schedule.type === "once") {
    return job.schedule.start_at || null;
  }
  if (job.schedule.type === "recurring") {
    const start = job.schedule.start_at ? new Date(job.schedule.start_at) : now;
    const from = start > now ? start.toISOString() : now.toISOString();
    return computeNextForRecurring(job.schedule.cron, tz, from);
  }
  if (job.schedule.type === "interval") {
    const ms = parseEvery(job.schedule.every);
    if (!ms) return null;
    const start = job.schedule.start_at ? new Date(job.schedule.start_at) : now;
    return start.toISOString();
  }
  return null;
}

export function isDue(job, nowIso = null) {
  const now = toDate(nowIso);
  if (!job.state.enabled) return { due: false, reason: "disabled" };
  if (job.schedule.end_at && now > new Date(job.schedule.end_at)) {
    return { due: false, reason: "past_end_at" };
  }

  const next =
    job.state.next_run_at || computeInitialNextRun(job, now.toISOString());
  if (!next) return { due: false, reason: "no_next_run" };
  if (now >= new Date(next))
    return { due: true, reason: "due", scheduled_at: next };
  return { due: false, reason: "not_due", scheduled_at: next };
}

export function previewNextRuns(job, count, fromIso) {
  const results = [];
  if (job.schedule.type === "once") {
    if (
      job.schedule.start_at &&
      job.state?.enabled !== false &&
      !job.state?.last_run_at
    ) {
      results.push(job.schedule.start_at);
    }
    return results;
  }
  let cursor = fromIso;
  const tz =
    job.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (let i = 0; i < count; i++) {
    let next;
    if (job.schedule.type === "recurring") {
      next = computeNextForRecurring(job.schedule.cron, tz, cursor);
    } else if (job.schedule.type === "interval") {
      const ms = parseEvery(job.schedule.every);
      if (!ms) break;
      if (i === 0 && job.state?.next_run_at) {
        next = job.state.next_run_at;
      } else {
        next = new Date(new Date(cursor).getTime() + ms).toISOString();
      }
    }
    if (!next) break;
    results.push(next);
    cursor = next;
  }
  return results;
}

function applyJitter(nextRunAt, jitterSec) {
  if (!jitterSec || !nextRunAt) return nextRunAt;
  const jitterMs = Math.floor(Math.random() * jitterSec * 1000);
  return new Date(new Date(nextRunAt).getTime() + jitterMs).toISOString();
}

export function computeNextAfterRun(job, scheduledAtIso, _finishedAtIso) {
  const jitterSec = job.schedule?.jitter_sec || 0;

  if (job.schedule.type === "once") {
    return { next_run_at: null, enabled: false };
  }

  if (job.schedule.type === "recurring") {
    const tz =
      job.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const next = computeNextForRecurring(job.schedule.cron, tz, scheduledAtIso);
    return {
      next_run_at: applyJitter(next, jitterSec),
      enabled: true,
    };
  }

  if (job.schedule.type === "interval") {
    const ms = parseEvery(job.schedule.every);
    if (!ms) return { next_run_at: null, enabled: false };
    const next = new Date(
      new Date(scheduledAtIso).getTime() + ms,
    ).toISOString();
    return { next_run_at: applyJitter(next, jitterSec), enabled: true };
  }

  return { next_run_at: null, enabled: false };
}
