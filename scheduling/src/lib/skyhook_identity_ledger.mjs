import { createHash } from "node:crypto";
import { helmHome } from "./store.mjs";
import { withRuntimeStoreTransaction } from "./runtime_store.mjs";

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Key(prefix, fields) {
  const json = JSON.stringify(
    Object.keys(fields)
      .sort()
      .reduce((acc, key) => {
        acc[key] = fields[key] ?? null;
        return acc;
      }, {}),
  );
  return `${prefix}_${createHash("sha256").update(json).digest("hex").slice(0, 32)}`;
}

function markExpiredIdentityClaims(db, identityKey, now) {
  const rows = db
    .prepare(
      "SELECT attempt_id FROM run_attempts WHERE identity_key = ? AND state IN ('claimed', 'launching', 'running') AND deadline_at IS NOT NULL AND deadline_at <= ?",
    )
    .all(identityKey, now);
  for (const row of rows) {
    db.prepare(
      "UPDATE run_attempts SET state = 'lost', status = 'failed', wrapper_state = 'finalized', finished_at = ?, exited_at = ?, terminal_reason = 'identity_claim_expired', terminal_source = 'lost' WHERE attempt_id = ?",
    ).run(now, now, row.attempt_id);
  }
  if (rows.length > 0) {
    const slots = rows.map(() => "?").join(",");
    db.prepare(
      `UPDATE logical_runs SET state = 'lost', status = 'failed', updated_at = ?, finished_at = ?, exited_at = ?, terminal_reason = 'identity_claim_expired', terminal_source = 'lost', status_reason = 'identity_claim_expired' WHERE logical_run_key IN (SELECT logical_run_key FROM run_attempts WHERE attempt_id IN (${slots}))`,
    ).run(now, now, now, ...rows.map((row) => row.attempt_id));
  }
  return rows.map((row) => row.attempt_id);
}

function insertIdentityClaim(db, params) {
  db.prepare(
    "INSERT INTO logical_runs (logical_run_key, scope_id, job_id, slot_key, scheduled_at, status, lease_token, created_at, updated_at, finished_at, status_reason, metadata_json, identity_key, job_kind, state, claimed_at, started_at, last_heartbeat_at, deadline_at, supervisor_version) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, NULL, NULL, NULL, ?, ?, 'claimed', ?, NULL, NULL, ?, 'skyhook-v1')",
  ).run(
    params.logicalRunKey,
    required(params.scopeId, "scopeId"),
    params.jobId,
    params.slotKey,
    params.timestamp,
    params.leaseToken,
    params.timestamp,
    params.timestamp,
    params.identityKey,
    params.jobKind,
    params.timestamp,
    params.deadlineAt,
  );
  db.prepare(
    "INSERT INTO run_attempts (attempt_id, logical_run_key, daemon_instance_id, wrapper_pid, job_pid, process_group_id, wrapper_state, lease_token, started_at, deadline_at, finished_at, status, cleanup_json, identity_key, job_kind, pid, pgid, state, claimed_at, last_heartbeat_at, supervisor_version) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, 'claimed', NULL, ?, ?, NULL, NULL, 'claimed', ?, NULL, 'skyhook-v1')",
  ).run(
    params.attemptId,
    params.logicalRunKey,
    params.daemonInstanceId,
    params.leaseToken,
    params.timestamp,
    params.deadlineAt,
    params.identityKey,
    params.jobKind,
    params.timestamp,
  );
}

export function claimSkyhookIdentity({
  home = helmHome(),
  identityKey,
  scopeId = "skyhook",
  jobId,
  jobKind = "agent",
  attemptId,
  daemonInstanceId,
  leaseToken,
  deadlineAt,
  now = nowIso(),
} = {}) {
  const timestamp = required(now, "now");
  const key = required(identityKey, "identityKey");
  return withRuntimeStoreTransaction({ home }, (db) => {
    const expiredAttemptIds = markExpiredIdentityClaims(db, key, timestamp);
    const live = db
      .prepare(
        "SELECT attempt_id, state, deadline_at FROM run_attempts WHERE identity_key = ? AND state IN ('claimed', 'launching', 'running') ORDER BY claimed_at ASC LIMIT 1",
      )
      .get(key);
    if (live) {
      return {
        claimed: false,
        identity_key: key,
        blocking_attempt_id: live.attempt_id,
        blocking_state: live.state,
        expired_attempt_ids: expiredAttemptIds,
      };
    }
    const normalizedAttemptId = required(attemptId, "attemptId");
    const logicalRunKey = sha256Key("skyhook_identity_claim", {
      identity_key: key,
      attempt_id: normalizedAttemptId,
    });
    insertIdentityClaim(db, {
      scopeId,
      jobId: required(jobId, "jobId"),
      jobKind: required(jobKind, "jobKind"),
      attemptId: normalizedAttemptId,
      daemonInstanceId: required(daemonInstanceId, "daemonInstanceId"),
      leaseToken: required(leaseToken, "leaseToken"),
      deadlineAt,
      timestamp,
      identityKey: key,
      logicalRunKey,
      slotKey: sha256Key("skyhook_identity_slot", {
        identity_key: key,
        attempt_id: normalizedAttemptId,
      }),
    });
    return {
      claimed: true,
      logical_run_key: logicalRunKey,
      attempt_id: normalizedAttemptId,
      state: "claimed",
      identity_key: key,
      expired_attempt_ids: expiredAttemptIds,
    };
  });
}

export function rekeySkyhookIdentityClaim({
  home = helmHome(),
  attemptId,
  identityKey,
  now = nowIso(),
} = {}) {
  const normalizedAttemptId = required(attemptId, "attemptId");
  const key = required(identityKey, "identityKey");
  const timestamp = required(now, "now");
  return withRuntimeStoreTransaction({ home }, (db) => {
    const attempt = db
      .prepare("SELECT logical_run_key FROM run_attempts WHERE attempt_id = ?")
      .get(normalizedAttemptId);
    if (!attempt)
      throw new Error(`run attempt not found: ${normalizedAttemptId}`);
    const expiredAttemptIds = markExpiredIdentityClaims(db, key, timestamp);
    const live = db
      .prepare(
        "SELECT attempt_id, state, deadline_at FROM run_attempts WHERE identity_key = ? AND attempt_id != ? AND state IN ('claimed', 'launching', 'running') ORDER BY claimed_at ASC LIMIT 1",
      )
      .get(key, normalizedAttemptId);
    if (live) {
      return {
        rekeyed: false,
        reason: "identity_in_flight",
        attempt_id: normalizedAttemptId,
        identity_key: key,
        blocking_attempt_id: live.attempt_id,
        blocking_state: live.state,
        expired_attempt_ids: expiredAttemptIds,
      };
    }
    db.prepare(
      "UPDATE run_attempts SET identity_key = ?, last_heartbeat_at = ? WHERE attempt_id = ?",
    ).run(key, timestamp, normalizedAttemptId);
    db.prepare(
      "UPDATE logical_runs SET identity_key = ?, last_heartbeat_at = ?, updated_at = ? WHERE logical_run_key = ?",
    ).run(key, timestamp, timestamp, attempt.logical_run_key);
    return {
      rekeyed: true,
      attempt_id: normalizedAttemptId,
      identity_key: key,
      expired_attempt_ids: expiredAttemptIds,
    };
  });
}

export function annotateSkyhookAttempt({
  home = helmHome(),
  attemptId,
  identityKey,
  jobKind,
  supervisorVersion = "skyhook-shadow-v1",
  now = nowIso(),
} = {}) {
  const normalizedAttemptId = required(attemptId, "attemptId");
  const key = required(identityKey, "identityKey");
  const normalizedJobKind = required(jobKind, "jobKind");
  const timestamp = required(now, "now");
  return withRuntimeStoreTransaction({ home }, (db) => {
    const attempt = db
      .prepare("SELECT logical_run_key FROM run_attempts WHERE attempt_id = ?")
      .get(normalizedAttemptId);
    if (!attempt)
      throw new Error(`run attempt not found: ${normalizedAttemptId}`);
    db.prepare(
      "UPDATE run_attempts SET identity_key = ?, job_kind = ?, supervisor_version = ?, last_heartbeat_at = COALESCE(last_heartbeat_at, ?) WHERE attempt_id = ?",
    ).run(
      key,
      normalizedJobKind,
      supervisorVersion,
      timestamp,
      normalizedAttemptId,
    );
    db.prepare(
      "UPDATE logical_runs SET identity_key = ?, job_kind = ?, supervisor_version = ?, last_heartbeat_at = COALESCE(last_heartbeat_at, ?), updated_at = ? WHERE logical_run_key = ?",
    ).run(
      key,
      normalizedJobKind,
      supervisorVersion,
      timestamp,
      timestamp,
      attempt.logical_run_key,
    );
    return {
      annotated: true,
      attempt_id: normalizedAttemptId,
      identity_key: key,
      job_kind: normalizedJobKind,
    };
  });
}
