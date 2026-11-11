// Classifies a failed agent run's stdout lines as holdable (usage limit / provider outage) or not.
const USAGE_LIMIT = /usage limit|try again at/i;
const OUTAGE_TEXT = /overloaded|server_error|(?:status|http)\D{0,3}5\d\d/i;
const RETRY_AT =
  /try again at\s+(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4})\s+)?)?(\d{1,2}):(\d{2})\s*([AP]M)/i;
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const NOT_HOLDABLE = {
  holdable: false,
  reason: null,
  until: null,
  evidence: null,
};
const hold = (reason, until, evidence) => ({
  holdable: true,
  reason,
  until,
  evidence,
});

function parseLines(lines) {
  return (lines || []).flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event && typeof event === "object" ? [event] : [];
    } catch {
      return []; // tolerate non-JSON launcher/recap lines
    }
  });
}

// Next local moment matching "[Mon DD[, YYYY]] H:MM AM|PM" after now; null if unparseable.
export function parseRetryAt(text, now) {
  const m = RETRY_AT.exec(text || "");
  if (!m) return null;
  const [, mon, day, year, hh, mm, ampm] = m;
  const hour = (Number(hh) % 12) + (ampm.toUpperCase() === "PM" ? 12 : 0);
  const base = new Date(now);
  const month = mon
    ? MONTHS.indexOf(mon.slice(0, 3).toLowerCase())
    : base.getMonth();
  const d = mon ? Number(day) : base.getDate();
  const y = year ? Number(year) : base.getFullYear();
  // no year given and already past: roll to the next day (time only) or next year (dated)
  const roll = year ? 0 : 1;
  const at = (n) => (mon ? [y + n, month, d] : [y, month, d + n]);
  const first = new Date(...at(0), hour, Number(mm)).getTime();
  const until =
    first > now ? first : new Date(...at(roll), hour, Number(mm)).getTime();
  return month >= 0 && until > now ? until : null;
}

function errorText(event) {
  const parts = [
    event.message,
    event.error?.message,
    event.error,
    event.result,
    event.api_error,
  ];
  return parts.filter((p) => typeof p === "string").join(" ");
}

function status(event) {
  return Number(
    event.api_error_status ?? event.status ?? event.error?.status ?? 0,
  );
}

function claudeRateLimit(event) {
  const info = event.rate_limit_info;
  if (event.type !== "rate_limit_event" || info?.status !== "rejected")
    return null;
  // the run kept working on overage, so the limit did not stop it
  if (info.isUsingOverage === true || info.overageStatus === "allowed")
    return null;
  const until = Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : null;
  return hold("usage_limit", until, "rate_limit_event:rate_limit_info.status");
}

function isFailure(event, provider) {
  if (provider === "codex")
    return event.type === "error" || event.type === "turn.failed";
  if (event.type === "assistant") return Boolean(event.error);
  return event.type === "result" && Boolean(event.is_error);
}

function classifyFailure(event, provider, now) {
  const text = errorText(event);
  if (provider === "codex" && USAGE_LIMIT.test(text)) {
    return hold(
      "usage_limit",
      parseRetryAt(text, now),
      `${event.type}:message`,
    );
  }
  const byStatus = status(event) >= 500;
  if (!byStatus && !OUTAGE_TEXT.test(text)) return null;
  return hold(
    "provider_outage",
    null,
    `${event.type}:${byStatus ? "status" : "message"}`,
  );
}

// Evidence only counts if it is the run's final stop: a later successful turn
// (claude assistant without error, codex turn.completed) means it recovered.
const recovered = (event, provider) =>
  provider === "codex"
    ? event.type === "turn.completed"
    : event.type === "assistant" && !event.error;

function classifyEvent(event, provider, now) {
  if (provider === "claude" && event.type === "rate_limit_event")
    return claudeRateLimit(event);
  return isFailure(event, provider)
    ? classifyFailure(event, provider, now)
    : null;
}

// Events after the run's last successful turn: anything earlier was recovered from.
function sinceRecovery(events, provider) {
  const last = events.findLastIndex((e) => recovered(e, provider));
  return events.slice(last + 1);
}

// A usage limit wins over an outage when both appear in one run.
// Codex classifies only its last failure event; claude keeps every post-recovery signal.
export function classifyHoldableFailure(
  lines,
  { provider, now = Date.now() } = {},
) {
  if (provider !== "claude" && provider !== "codex") return NOT_HOLDABLE;
  let events = sinceRecovery(parseLines(lines), provider);
  if (provider === "codex")
    events = events.filter((e) => isFailure(e, provider)).slice(-1);
  const found = events
    .map((event) => classifyEvent(event, provider, now))
    .filter(Boolean);
  return (
    found.find((r) => r.reason === "usage_limit") || found[0] || NOT_HOLDABLE
  );
}
