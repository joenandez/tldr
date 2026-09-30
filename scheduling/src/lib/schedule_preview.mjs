// HELM-REQ-9 — preview schedule input without creating a job.
//
// Composers need to show a schedule's plain-language summary, its resolved
// timezone, and the next occurrences before anything is submitted. This
// module composes Helm's existing scheduling authority — buildScheduleFromFlags
// (normalization) + normalizeJob/validateJob (validation + timezone
// resolution) + previewNextRuns (occurrence computation) — against an unsaved,
// in-memory job. Nothing here writes: no catalog lease, no store access.

import { normalizeJob, validateJob } from "./job_service.mjs";
import { buildScheduleFromFlags } from "./schedule_flags.mjs";
import { previewNextRuns } from "./schedule_eval.mjs";
import { describeDstWarnings } from "./schedule_dst.mjs";

const PREVIEW_JOB_ID = "schedule-preview";
const PREVIEW_COMMAND = "true";
const NO_FUTURE_OCCURRENCE = "schedule_no_future_occurrence";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DURATION_UNITS = {
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
};

function invalid(message, schedule, errors) {
  return {
    ok: false,
    code: "invalid_schedule",
    message,
    data: { schedule: schedule || null, errors },
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function humanizeEvery(every) {
  const match = String(every || "").match(/^(\d+)([smhd])$/);
  if (!match) return String(every);
  const count = Number(match[1]);
  const unit = DURATION_UNITS[match[2]];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function wallTimeIn(iso, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} at ${parts.hour}:${parts.minute}`;
}

// Plain-language rendering of Helm's own cron field layout. Prose only — the
// occurrences themselves always come from previewNextRuns.
function describeCron(cron, timezone) {
  const [minute, hour, dom, month, dow] = String(cron).trim().split(/\s+/);
  const suffix = `(${timezone})`;
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (
    everyMinutes &&
    hour === "*" &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    return `Every ${everyMinutes[1]} minutes ${suffix}`;
  }
  const isFixedTime = /^\d+$/.test(minute) && /^\d+$/.test(hour);
  const at = isFixedTime ? `at ${pad2(hour)}:${pad2(minute)}` : null;
  if (at && month === "*" && dom === "*" && dow === "*") {
    return `Every day ${at} ${suffix}`;
  }
  if (at && month === "*" && dom === "*" && /^[0-6]$/.test(dow)) {
    return `Every ${WEEKDAYS[Number(dow)]} ${at} ${suffix}`;
  }
  if (at && month === "*" && dow === "*" && /^\d+$/.test(dom)) {
    return `Every month on day ${Number(dom)} ${at} ${suffix}`;
  }
  return `Cron "${cron}" ${suffix}`;
}

function summarize(schedule, firstRun) {
  const timezone = schedule.timezone;
  if (schedule.type === "once") {
    return `Once on ${wallTimeIn(schedule.start_at, timezone)} (${timezone})`;
  }
  if (schedule.type === "interval") {
    const from = firstRun ? wallTimeIn(firstRun, timezone) : null;
    const every = `Every ${humanizeEvery(schedule.every)}`;
    return from ? `${every}, starting ${from} (${timezone})` : every;
  }
  if (schedule.type === "recurring") {
    return describeCron(schedule.cron, timezone);
  }
  return `Schedule of type "${schedule.type}" (${timezone})`;
}

/**
 * Preview an unsaved schedule described by CLI flags.
 *
 * @param {object} args
 * @param {Record<string, unknown>} args.flags parsed CLI flags
 * @param {{cwd: string}} args.scope resolving scope (used for normalization only)
 * @param {number} args.count how many occurrences to project
 * @param {string} args.fromIso project occurrences from this instant
 * @returns {null|{ok: true, data: object}|{ok: false, code: string, message: string, data: object}}
 *   `null` when the flags carry no schedule at all, so the caller can raise its
 *   own missing-input error.
 */
export function previewScheduleFromFlags({ flags, scope, count, fromIso }) {
  let schedule;
  try {
    schedule = buildScheduleFromFlags(flags);
  } catch (error) {
    return invalid(error?.message || "schedule input is invalid", null, [
      "schedule_input_invalid",
    ]);
  }
  if (!schedule) return null;

  const job = normalizeJob(
    {
      id: PREVIEW_JOB_ID,
      process: { command: PREVIEW_COMMAND },
      schedule,
    },
    scope,
  );
  const scheduleErrors = validateJob(job, { scope }).errors.filter((code) =>
    String(code).startsWith("schedule_"),
  );
  if (scheduleErrors.length > 0) {
    return invalid(
      `schedule is invalid: ${scheduleErrors.join(", ")}`,
      job.schedule,
      scheduleErrors,
    );
  }

  const nextRuns = previewNextRuns(job, count, fromIso);
  if (nextRuns.length === 0) {
    return invalid("schedule has no future occurrence", job.schedule, [
      NO_FUTURE_OCCURRENCE,
    ]);
  }

  return {
    ok: true,
    data: {
      schedule: job.schedule,
      summary: summarize(job.schedule, nextRuns[0]),
      timezone: job.schedule.timezone,
      count,
      next_runs: nextRuns,
      // Daylight-saving semantics for the occurrences above. Always present:
      // an empty `warnings` list is Helm reporting that it checked.
      dst: describeDstWarnings({
        schedule: job.schedule,
        occurrences: nextRuns,
      }),
    },
  };
}
