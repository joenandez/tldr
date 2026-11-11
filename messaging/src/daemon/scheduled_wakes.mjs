// Scheduled wakes: a held attempt's `delegate --at` wake or cap-pass re-wake.
// Helpers take a db handle and never open a transaction, so callers can run
// them inside their own (applyUpdate inserts the wake with the update).
// Timestamps are ISO-8601 UTC strings, same as attempts.created_at, so they
// compare lexicographically.

import { randomUUID } from "node:crypto";

export const SCHEDULED_WAKES_SCHEMA_VERSION = 30;

export function applyScheduledWakesMigration(db) {
  db.exec(`CREATE TABLE scheduled_wakes (
    wake_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES obligations(id),
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    reason TEXT NOT NULL CHECK (reason IN ('at', 'cap')),
    wake_at TEXT NOT NULL,
    fired_at TEXT,
    rewake_at TEXT,
    notified_at TEXT,
    cancelled_at TEXT
  )`);
  db.exec(
    "CREATE INDEX scheduled_wakes_due ON scheduled_wakes(wake_at) WHERE fired_at IS NULL AND cancelled_at IS NULL",
  );
  db.exec(
    "CREATE INDEX scheduled_wakes_attempt ON scheduled_wakes(attempt_id)",
  );
}

export function insertWake(db, { attemptId, endpointId, reason, wakeAt }) {
  const wakeId = `wake_${randomUUID()}`;
  db.prepare(
    "INSERT INTO scheduled_wakes (wake_id, attempt_id, endpoint_id, reason, wake_at) VALUES (?, ?, ?, ?, ?)",
  ).run(wakeId, attemptId, endpointId, reason, wakeAt);
  return wakeId;
}

export const CAP_WAKE_MIN_GAP_MS = 60 * 60 * 1000;

// Invariant D: a held attempt always has a pending wake. Only a pending row
// covers it (a fired, cancelled or notified one does not), and a cap wake
// never lands within an hour of the last time any wake (`at` or `cap`) woke
// the holder: its fire, or its 1 h re-wake (notified_at). So re-waking a
// holder that stops without reporting stays bounded to once an hour.
export function leaveCapWake(db, { attemptId, endpointId, now }) {
  if (hasPendingWake(db, attemptId)) return null;
  const lastFired = db
    .prepare(
      "SELECT MAX(COALESCE(notified_at, fired_at)) AS at FROM scheduled_wakes WHERE attempt_id = ?",
    )
    .get(attemptId).at;
  const floor = lastFired
    ? new Date(Date.parse(lastFired) + CAP_WAKE_MIN_GAP_MS).toISOString()
    : now;
  return insertWake(db, {
    attemptId,
    endpointId,
    reason: "cap",
    wakeAt: floor > now ? floor : now,
  });
}

// An update or complete on the attempt also ends a fired wake that is still
// waiting for its 1 h check: the attempt reported, so nothing is overdue. It
// stamps notified rows too, so the next silence gets its own notice.
export function cancelWakesForAttempt(db, attemptId, now) {
  return db
    .prepare(
      "UPDATE scheduled_wakes SET cancelled_at = ? WHERE attempt_id = ? AND cancelled_at IS NULL",
    )
    .run(now, attemptId).changes;
}

// The requester was already told in this silence: another row of the attempt
// ran its 1 h check and no update or complete has cancelled it since.
export function toldThisSilence(db, wake) {
  return !!db
    .prepare(
      "SELECT 1 FROM scheduled_wakes WHERE attempt_id = ? AND wake_id != ? AND notified_at IS NOT NULL AND cancelled_at IS NULL LIMIT 1",
    )
    .get(wake.attempt_id, wake.wake_id);
}

export function hasPendingWake(db, attemptId) {
  return !!db
    .prepare(
      "SELECT 1 FROM scheduled_wakes WHERE attempt_id = ? AND fired_at IS NULL AND cancelled_at IS NULL LIMIT 1",
    )
    .get(attemptId);
}

export function dueWakes(db, now) {
  return db
    .prepare(
      "SELECT * FROM scheduled_wakes WHERE fired_at IS NULL AND cancelled_at IS NULL AND wake_at <= ? ORDER BY wake_at, wake_id",
    )
    .all(now);
}

export const wakeMessageKey = (wakeId) => `scheduled-wake:${wakeId}`;

export function markFired(db, wakeId, { firedAt, rewakeAt }) {
  db.prepare(
    "UPDATE scheduled_wakes SET fired_at = ?, rewake_at = ? WHERE wake_id = ?",
  ).run(firedAt, rewakeAt, wakeId);
}

export function markNotified(db, wakeId, now) {
  db.prepare(
    "UPDATE scheduled_wakes SET notified_at = ? WHERE wake_id = ?",
  ).run(now, wakeId);
}

const LAUNCH_FAILED_SQL = `EXISTS (
            SELECT 1 FROM resume_requests r JOIN messages m ON m.id = r.message_id
             WHERE r.endpoint_id = w.endpoint_id AND r.state = 'failed'
               AND m.idempotency_key = 'scheduled-wake:' || w.wake_id)`;

// True when the wake's own resume request failed for good.
export function launchFailed(db, wake) {
  return !!db
    .prepare(
      `SELECT ${LAUNCH_FAILED_SQL} AS failed FROM scheduled_wakes w WHERE w.wake_id = ?`,
    )
    .get(wake.wake_id)?.failed;
}

// Fired wakes whose 1 h check is due, or whose wake launch already failed for good.
export function dueRewakes(db, now) {
  return db
    .prepare(
      `SELECT w.* FROM scheduled_wakes w
        WHERE w.fired_at IS NOT NULL AND w.notified_at IS NULL AND w.cancelled_at IS NULL
          AND (w.rewake_at <= ? OR ${LAUNCH_FAILED_SQL})
        ORDER BY w.rewake_at, w.wake_id`,
    )
    .all(now);
}

// An unread scheduled-wake delivery: lets the stale-window check spare the endpoint.
export function hasUnreadScheduledWake(db, endpointId) {
  return !!db
    .prepare(
      "SELECT 1 FROM deliveries WHERE endpoint_id = ? AND route_reason = 'scheduled.wake' AND read_at IS NULL AND state != 'failed' LIMIT 1",
    )
    .get(endpointId);
}

// The cutoff is the v30 row schema_migrations stamped when this database was upgraded.
export function migrationCutoff(db) {
  return (
    db
      .prepare(
        "SELECT applied_at FROM schema_migrations WHERE schema_version = ?",
      )
      .get(SCHEDULED_WAKES_SCHEMA_VERSION)?.applied_at ?? null
  );
}
