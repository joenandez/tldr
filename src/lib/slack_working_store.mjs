import { write as writeMap } from "./slack_channel_map.mjs";

// One row per (channel, thread root) whose owner message still waits for the
// agent's first post. Written through the migrating open, so a DB that predates
// the table gains it instead of failing a read.
const COLUMNS = `channel_id AS channelId, thread_ts AS threadTs, ts,
  accepted_at AS acceptedAt, last_set_at AS lastSetAt, message_id AS messageId,
  cleared_at AS clearedAt, last_checked_at AS lastCheckedAt`;

// A repeat of the same owner message (a retried drain) changes nothing, so a
// stuck retry cannot restart the age clock. A new message in the thread restarts
// the wait; lastSetAt 0 makes the next sweep set the status at once.
export function trackWorking(
  home,
  { channelId, threadTs, ts, now = Date.now() },
) {
  writeMap(home, (db) =>
    db
      .prepare(
        // reacted is unused since ac-jfv.71 (no hourglass); kept so a rollback can read the table
        `INSERT INTO slack_working (channel_id, thread_ts, ts, reacted, accepted_at, last_set_at)
           VALUES (?, ?, ?, 0, ?, 0)
         ON CONFLICT (channel_id, thread_ts) DO UPDATE SET
           ts = excluded.ts, accepted_at = excluded.accepted_at, last_set_at = 0,
           message_id = NULL, cleared_at = 0, last_checked_at = 0
         WHERE slack_working.ts != excluded.ts`,
      )
      .run(channelId, threadTs, ts, now),
  );
}

// Every write after an await is conditional, in the statement itself, on the exact
// message the caller decided about: a newer message in the thread (another ts) is
// never touched by a decision about an older one. Returns the rows changed.
const update = (home, { set, params, key: { channelId, threadTs, ts } }) =>
  writeMap(home, (db) =>
    db
      .prepare(
        `UPDATE slack_working SET ${set} WHERE channel_id = ? AND thread_ts = ? AND ts = ?`,
      )
      .run(...params, channelId, threadTs, ts),
  ).changes;

export const noteWorkingMessage = (
  home,
  { channelId, threadTs, ts, messageId },
) =>
  update(home, {
    set: "message_id = ?",
    params: [messageId],
    key: { channelId, threadTs, ts },
  });

export const touchWorking = (home, key, at) =>
  update(home, { set: "last_set_at = ?", params: [at], key });

// The visit that last looked the row's session up: the sweep goes least-recent first.
export const markWorkingChecked = (home, key, at) =>
  update(home, { set: "last_checked_at = ?", params: [at], key });

// Terminal: the sweep never refreshes the row again; it re-clears and deletes it later.
// The first clear time stays, so a repeat clear cannot postpone the delayed one.
// 0 changes: the row is gone or is a newer message's, and there is nothing to clear.
export const markWorkingCleared = (home, key, at) =>
  update(home, {
    set: "cleared_at = CASE WHEN cleared_at = 0 THEN ? ELSE cleared_at END",
    params: [at],
    key,
  });

export function lookupWorking(home, { channelId, threadTs }) {
  return writeMap(
    home,
    (db) =>
      db
        .prepare(
          `SELECT ${COLUMNS} FROM slack_working WHERE channel_id = ? AND thread_ts = ?`,
        )
        .get(channelId, threadTs) ?? null,
  );
}

export function listWorking(home) {
  return writeMap(home, (db) =>
    db
      .prepare(`SELECT ${COLUMNS} FROM slack_working ORDER BY accepted_at`)
      .all(),
  );
}

// Only the terminal row of this message: a newer message's row is kept.
export function deleteWorking(home, { channelId, threadTs, ts }) {
  writeMap(home, (db) =>
    db
      .prepare(
        "DELETE FROM slack_working WHERE channel_id = ? AND thread_ts = ? AND ts = ? AND cleared_at > 0",
      )
      .run(channelId, threadTs, ts),
  );
}
