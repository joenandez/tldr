import { write } from "./slack_channel_map.mjs";

// How long a notice that fails for a transient reason (rate limit, 5xx, timeout)
// is retried. Minutes: those clear in seconds, and a retry holds the ordered
// inbound drain (every later line waits) or leaves the working status up. Hours
// would be a stall; one tick would drop a notice a blip could still deliver.
export const NOTICE_RETRY_MS = 5 * 60_000;

const ensure = (db) =>
  db.exec(
    "CREATE TABLE IF NOT EXISTS notice_retry (key TEXT PRIMARY KEY, since INTEGER NOT NULL)",
  );

// The first time this notice failed, kept in the DB so a restart keeps the clock.
function failingSince(home, key, now) {
  return write(home, (db) => {
    ensure(db);
    db.prepare(
      "INSERT OR IGNORE INTO notice_retry (key, since) VALUES (?, ?)",
    ).run(key, now);
    return db.prepare("SELECT since FROM notice_retry WHERE key = ?").get(key)
      .since;
  });
}

// The notice is settled (posted, or given up on): forget its clock.
export function noticeSettled(home, key) {
  write(home, (db) => {
    ensure(db);
    db.prepare("DELETE FROM notice_retry WHERE key = ?").run(key);
  });
}

// True when a failed notice must stop being retried: Slack says it can never be
// delivered (the classification slack_api already makes: error.permanent), or a
// transient failure outlasted NOTICE_RETRY_MS. Logs the loss at error level.
export function noticeAbandoned({ ctx, key, error, params }) {
  const now = (ctx.now ?? Date.now)();
  const since = failingSince(ctx.home, key, now);
  const permanent = error.permanent === true;
  if (!permanent && now - since < NOTICE_RETRY_MS) return false;
  ctx.logger?.({
    event: "slack_notice_abandoned",
    status: "error",
    params,
    result: {
      slack_error: error.slackError ?? null,
      reason: permanent ? "permanent" : "deadline",
      failing_since: since,
    },
  });
  noticeSettled(ctx.home, key);
  return true;
}
