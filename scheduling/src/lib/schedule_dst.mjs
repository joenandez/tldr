// schedule_dst — daylight-saving disclosure for a projected schedule.
//
// Helm owns the scheduling authority, so Helm owns telling a caller when a
// schedule's local time is not what it looks like. Two local times exist that a
// wall clock cannot name unambiguously:
//
//   * ambiguous — the clock falls back, so the local time happens twice, and
//     only one of the two instants is the run;
//   * nonexistent — the clock springs forward, so the requested local time
//     never happens that day, and the run lands somewhere else.
//
// Both are computed here from the occurrences Helm already projected, using the
// platform's own timezone database through Intl. No occurrence logic lives in a
// consumer, and nothing here changes when a run fires — this module only
// describes what the projection already decided.

const DAY_MS = 86_400_000;

function partsFormatter(timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function zoneParts(format, instantMs) {
  const parts = Object.fromEntries(
    format
      .formatToParts(new Date(instantMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts;
}

function localDate(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localTime(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Offset of the zone at one instant, as (local-clock-read-as-UTC) - instant.
function offsetMsAt(format, instantMs) {
  const parts = zoneParts(format, instantMs);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instantMs;
}

// Every instant whose local clock reads exactly this wall time. Zero of them
// means the wall time does not exist; two mean it happens twice. Probing the
// offset a day either side covers both sides of any transition, which is all a
// single wall time can straddle.
function instantsForWallTime(format, { year, month, day, hour, minute }) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const found = new Set();
  for (const probe of [asUtc - DAY_MS, asUtc + DAY_MS]) {
    const candidate = asUtc - offsetMsAt(format, probe);
    const back = zoneParts(format, candidate);
    if (
      back.year === year &&
      back.month === month &&
      back.day === day &&
      back.hour === hour &&
      back.minute === minute
    ) {
      found.add(candidate);
    }
  }
  return [...found].sort((left, right) => left - right);
}

// The local time-of-day the schedule asks for, when it asks for one at all.
// Only a fixed-time cron names a wall time; an interval names a period, and a
// `once` schedule names an instant, and neither can be nonexistent.
function requestedTimeOfDay(schedule) {
  if (schedule?.type !== "recurring" || !schedule.cron) return null;
  const [minute, hour] = String(schedule.cron).trim().split(/\s+/);
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  return { hour: Number(hour), minute: Number(minute) };
}

function ambiguousWarning(timezone, parts, occurrenceAt, instants) {
  const time = localTime(parts.hour, parts.minute);
  const date = localDate(parts);
  return {
    code: "local_time_ambiguous",
    timezone,
    local_date: date,
    local_time: time,
    occurrence_at: occurrenceAt,
    runs_at_local_time: time,
    alternatives_at: instants.map((instant) => new Date(instant).toISOString()),
    message: `${time} on ${date} happens twice in ${timezone} because the clock falls back; this run fires once, at ${occurrenceAt}.`,
  };
}

function nonexistentWarning(timezone, parts, occurrenceAt, requested) {
  const requestedTime = localTime(requested.hour, requested.minute);
  const actualTime = localTime(parts.hour, parts.minute);
  const date = localDate(parts);
  return {
    code: "local_time_nonexistent",
    timezone,
    local_date: date,
    local_time: requestedTime,
    occurrence_at: occurrenceAt,
    runs_at_local_time: actualTime,
    alternatives_at: [],
    message: `${requestedTime} does not exist on ${date} in ${timezone} because the clock springs forward; this run fires at ${actualTime} local time instead.`,
  };
}

/**
 * Describe the daylight-saving risks in a set of projected occurrences.
 *
 * @param {object} args
 * @param {{timezone: string, type?: string, cron?: string}} args.schedule normalized schedule
 * @param {string[]} args.occurrences ISO instants previewNextRuns projected
 * @returns {{timezone: string, warnings: object[]}} empty `warnings` means checked and clear
 */
export function describeDstWarnings({ schedule, occurrences }) {
  const timezone = schedule?.timezone || "UTC";
  const warnings = [];
  let format;
  try {
    format = partsFormatter(timezone);
  } catch {
    // An unresolvable zone is the validator's failure to report, not ours.
    return { timezone, warnings };
  }
  const requested = requestedTimeOfDay(schedule);
  const seen = new Set();
  for (const occurrence of occurrences || []) {
    const instantMs = Date.parse(occurrence);
    if (Number.isNaN(instantMs)) continue;
    const parts = zoneParts(format, instantMs);
    const instants = instantsForWallTime(format, parts);
    if (instants.length > 1) {
      warnings.push(ambiguousWarning(timezone, parts, occurrence, instants));
    } else if (
      requested &&
      (parts.hour !== requested.hour || parts.minute !== requested.minute) &&
      instantsForWallTime(format, { ...parts, ...requested }).length === 0
    ) {
      warnings.push(nonexistentWarning(timezone, parts, occurrence, requested));
    }
  }
  return {
    timezone,
    warnings: warnings.filter((warning) => {
      const key = `${warning.code} ${warning.local_date} ${warning.local_time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}
