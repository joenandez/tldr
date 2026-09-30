import { createHash } from "node:crypto";
import { helmHome } from "./store.mjs";
import {
  withRuntimeStore,
  withRuntimeStoreTransaction,
} from "./runtime_store.mjs";
import { managedAgentProcessDescriptor } from "./agent_fallback.mjs";
import { appendActivityEvent } from "./activity_stream.mjs";
import { runSatisfiedReportSidecar } from "./effective_owner_completion.mjs";
import {
  setDueProjectionActiveRunInTxn,
  clearDueProjectionActiveRunInTxn,
} from "./dispatch_due_projection.mjs";

export {
  annotateSkyhookAttempt,
  claimSkyhookIdentity,
  rekeySkyhookIdentityClaim,
} from "./skyhook_identity_ledger.mjs";
export {
  listSkyhookTerminalHistoryEvents,
  releaseSkyhookIdentity,
  transitionSkyhookAttempt,
} from "./skyhook_ledger.mjs";

export const SKYHOOK_RUN_STATES = Object.freeze([
  "due",
  "claimed",
  "launching",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "lost",
  "cancelled",
]);

export const RUN_ATTEMPT_LAUNCH_GRACE_MS = 10_000;
export const RUN_ATTEMPT_FINALIZATION_GRACE_MS = 10_000;
const RETRYABLE_LOGICAL_STATUSES = new Set([
  "failed",
  "interrupted",
  "lost",
  "timed_out",
]);
const TERMINAL_LOGICAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "interrupted",
  "lost",
  "timed_out",
  "cancelled",
  "skipped",
  "quarantined",
]);

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeRetryMaxAttempts(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function isRetryableTerminalLogicalRun(row) {
  if (!row) return false;
  return (
    RETRYABLE_LOGICAL_STATUSES.has(row.status) ||
    RETRYABLE_LOGICAL_STATUSES.has(row.state)
  );
}

function isTerminalLogicalRun(row) {
  if (!row) return false;
  return (
    TERMINAL_LOGICAL_STATUSES.has(row.status) ||
    TERMINAL_LOGICAL_STATUSES.has(row.state)
  );
}

function sha256Key(prefix, payload) {
  return `${prefix}_sha256:${createHash("sha256")
    .update(stableJson(payload))
    .digest("hex")}`;
}

function sha256Value(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function deriveSlotKey({
  scheduleId,
  scheduleExpression,
  scheduleTimezone,
  scheduledAt,
} = {}) {
  const normalized = {
    schedule_id: requireNonEmptyString(scheduleId, "scheduleId"),
    schedule_expression: requireNonEmptyString(
      scheduleExpression,
      "scheduleExpression",
    ),
    schedule_timezone: requireNonEmptyString(
      scheduleTimezone,
      "scheduleTimezone",
    ),
    scheduled_at: requireNonEmptyString(scheduledAt, "scheduledAt"),
  };
  return sha256Key("slot", normalized);
}

export function deriveLogicalRunKey({ scopeId, jobId, slotKey } = {}) {
  const normalized = {
    scope_id: requireNonEmptyString(scopeId, "scopeId"),
    job_id: requireNonEmptyString(jobId, "jobId"),
    slot_key: requireNonEmptyString(slotKey, "slotKey"),
  };
  return sha256Key("logical_run", normalized);
}

export function deriveSideEffectKey({
  namespace,
  logicalEventKey,
  effect,
  channel,
  recipient,
  templateVersion = null,
} = {}) {
  const normalized = {
    namespace: requireNonEmptyString(namespace, "namespace"),
    logical_event_key: requireNonEmptyString(
      logicalEventKey,
      "logicalEventKey",
    ),
    effect: requireNonEmptyString(effect, "effect"),
    channel: requireNonEmptyString(channel, "channel"),
    recipient: requireNonEmptyString(recipient, "recipient"),
    template_version:
      templateVersion === null || templateVersion === undefined
        ? null
        : requireNonEmptyString(templateVersion, "templateVersion"),
  };
  return sha256Key("side_effect", normalized);
}

function nowIso() {
  return new Date().toISOString();
}

function claimedAttemptWithinLaunchGrace(attempt, now) {
  const claimedAt =
    Date.parse(attempt.claimed_at || attempt.started_at || "") || null;
  const observedAt = Date.parse(now);
  if (!claimedAt || !Number.isFinite(observedAt)) return false;
  return observedAt - claimedAt <= RUN_ATTEMPT_LAUNCH_GRACE_MS;
}

export function runningAttemptWithinFinalizationGrace(attempt, now) {
  let cleanup = null;
  try {
    cleanup = attempt.cleanup_json ? JSON.parse(attempt.cleanup_json) : null;
  } catch {
    cleanup = null;
  }
  const detectedAt = Date.parse(cleanup?.detected_at || "");
  const observedAt = Date.parse(now);
  return (
    attempt.terminal_reason === "running_process_missing_pending" &&
    Number.isFinite(detectedAt) &&
    Number.isFinite(observedAt) &&
    observedAt - detectedAt <= RUN_ATTEMPT_FINALIZATION_GRACE_MS
  );
}

// Pooled connection; ledger operations formerly opened a fresh connection.
function runWithRuntimeStore(home, fn) {
  return withRuntimeStore({ home }, fn);
}

function appendActivityEventForHome(home, event) {
  const previousHome = process.env.HELM_HOME;
  process.env.HELM_HOME = home;
  try {
    return appendActivityEvent(event);
  } finally {
    if (previousHome === undefined) delete process.env.HELM_HOME;
    else process.env.HELM_HOME = previousHome;
  }
}

function scheduleExpressionFromJob(job) {
  if (job?.schedule?.type === "interval") {
    return `interval:${requireNonEmptyString(job.schedule.every, "schedule.every")}`;
  }
  if (job?.schedule?.type === "recurring") {
    return `cron:${requireNonEmptyString(job.schedule.cron, "schedule.cron")}`;
  }
  if (job?.schedule?.type === "once") {
    return `once:${requireNonEmptyString(
      job.schedule.start_at || job.schedule.once_at,
      "schedule.start_at",
    )}`;
  }
  return requireNonEmptyString(job?.schedule?.type, "schedule.type");
}

export function ledgerIdentityForJob({ scope, job, scheduledAt }) {
  const scheduleTimezone = job?.schedule?.timezone || "UTC";
  const scheduleExpression = scheduleExpressionFromJob(job);
  const slotKey = deriveSlotKey({
    scheduleId: job.id,
    scheduleExpression,
    scheduleTimezone,
    scheduledAt,
  });
  const logicalRunKey = deriveLogicalRunKey({
    scopeId: scope.scope_id,
    jobId: job.id,
    slotKey,
  });
  return {
    slot_key: slotKey,
    logical_run_key: logicalRunKey,
    schedule_id: job.id,
    schedule_expression: scheduleExpression,
    schedule_timezone: scheduleTimezone,
  };
}

function skyhookLedgerMetadataEnabled(job) {
  if (
    process.env.HELM_SKYHOOK_SHADOW === "1" ||
    process.env.HELM_SKYHOOK === "1"
  ) {
    return true;
  }
  if (
    process.env.HELM_SKYHOOK_KILL_SWITCH === "1" ||
    process.env.HELM_SKYHOOK_DISABLED === "1"
  ) {
    return false;
  }
  return Boolean(managedAgentProcessDescriptor(job?.process || {}));
}

function skyhookJobKindForJob(job) {
  if (
    job?.metadata?.session_id ||
    /^helm-resume-/.test(String(job?.id || "")) ||
    managedAgentProcessDescriptor(job?.process || {})
  ) {
    return "agent_resume";
  }
  if (job?.execution_hints?.provider) return "agent_spawn";
  return "bounded_command";
}

function skyhookIdentityKeyForJob({ scope, job }) {
  const sessionId = job?.metadata?.session_id || null;
  if (sessionId) return `session:${sessionId}`;
  const overlapKey = job?.schedule?.overlap_key || job?.metadata?.overlap_key;
  if (overlapKey) return `overlap:${overlapKey}`;
  return `job:${scope.scope_id}:${job.id}`;
}

export function claimLogicalRun({
  home = helmHome(),
  scopeId,
  sourceScopeId = scopeId,
  sourceCwd = null,
  jobId,
  scheduleId,
  scheduleExpression,
  scheduleTimezone,
  scheduledAt,
  attemptId,
  daemonInstanceId,
  leaseToken,
  deadlineAt = null,
  metadata = null,
  identityKey = null,
  jobKind = null,
  supervisorVersion = null,
  retryMaxAttempts = 0,
  now = nowIso(),
} = {}) {
  const slotKey = deriveSlotKey({
    scheduleId,
    scheduleExpression,
    scheduleTimezone,
    scheduledAt,
  });
  const logicalRunKey = deriveLogicalRunKey({ scopeId, jobId, slotKey });
  const normalizedAttemptId = requireNonEmptyString(attemptId, "attemptId");
  const normalizedLeaseToken = requireNonEmptyString(leaseToken, "leaseToken");
  const normalizedDaemonInstanceId = requireNonEmptyString(
    daemonInstanceId,
    "daemonInstanceId",
  );
  const timestamp = requireNonEmptyString(now, "now");
  const metadataJson = metadata === null ? null : stableJson(metadata);
  const normalizedRetryMaxAttempts =
    normalizeRetryMaxAttempts(retryMaxAttempts);
  const normalizedIdentityKey =
    identityKey === null || identityKey === undefined
      ? null
      : requireNonEmptyString(identityKey, "identityKey");
  const normalizedJobKind =
    jobKind === null || jobKind === undefined
      ? null
      : requireNonEmptyString(jobKind, "jobKind");

  return runWithRuntimeStore(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare(
          "SELECT logical_run_key, status, state FROM logical_runs WHERE logical_run_key = ?",
        )
        .get(logicalRunKey);
      let recoveringTerminal = false;
      let recoveredStatus = null;
      if (existing) {
        const retryableTerminal = isRetryableTerminalLogicalRun(existing);
        if (retryableTerminal) {
          const recovery = db
            .prepare(
              `
                SELECT
                  COUNT(*) AS attempt_count,
                  SUM(
                    CASE
                      WHEN COALESCE(state, status) IN ('claimed', 'launching', 'running')
                        OR status IN ('claimed', 'running')
                      THEN 1
                      ELSE 0
                    END
                  ) AS active_count,
                  SUM(
                    CASE
                      WHEN COALESCE(state, status) = 'succeeded'
                        OR status = 'succeeded'
                      THEN 1
                      ELSE 0
                    END
                  ) AS succeeded_count
                FROM run_attempts
                WHERE logical_run_key = ?
              `,
            )
            .get(logicalRunKey);
          const attemptCount = Number(recovery?.attempt_count || 0);
          if (attemptCount === 0) {
            db.exec("COMMIT");
            return {
              claimed: false,
              logical_run_key: logicalRunKey,
              slot_key: slotKey,
              attempt_id: normalizedAttemptId,
              status: existing.status,
              state: existing.state,
              reason: "duplicate_logical_run",
              terminal_duplicate: true,
            };
          }
          const retryBudgetRemaining =
            attemptCount < 1 + normalizedRetryMaxAttempts;
          recoveringTerminal =
            attemptCount > 0 &&
            retryBudgetRemaining &&
            Number(recovery?.active_count || 0) === 0 &&
            Number(recovery?.succeeded_count || 0) === 0;
          if (!recoveringTerminal) {
            db.exec("COMMIT");
            return {
              claimed: false,
              logical_run_key: logicalRunKey,
              slot_key: slotKey,
              attempt_id: normalizedAttemptId,
              status: existing.status,
              state: existing.state,
              reason: "retry_exhausted",
              terminal_duplicate: true,
            };
          }
          recoveredStatus = existing.status;
        }
        if (!recoveringTerminal) {
          db.exec("COMMIT");
          return {
            claimed: false,
            logical_run_key: logicalRunKey,
            slot_key: slotKey,
            attempt_id: normalizedAttemptId,
            status: existing.status,
            state: existing.state,
            reason: "duplicate_logical_run",
            terminal_duplicate: isTerminalLogicalRun(existing),
          };
        }
      }
      if (normalizedIdentityKey) {
        const expiredAttemptIds = markExpiredIdentityClaims(
          db,
          normalizedIdentityKey,
          timestamp,
        );
        const liveIdentity = db
          .prepare(
            `
              SELECT attempt_id, state, deadline_at
              FROM run_attempts
              WHERE identity_key = ?
                AND state IN ('claimed', 'launching', 'running')
              ORDER BY claimed_at ASC
              LIMIT 1
            `,
          )
          .get(normalizedIdentityKey);
        if (liveIdentity) {
          db.exec("COMMIT");
          return {
            claimed: false,
            logical_run_key: logicalRunKey,
            slot_key: slotKey,
            attempt_id: normalizedAttemptId,
            status: liveIdentity.state,
            reason: "identity_in_flight",
            identity_key: normalizedIdentityKey,
            blocking_attempt_id: liveIdentity.attempt_id,
            expired_attempt_ids: expiredAttemptIds,
          };
        }
      }

      if (recoveringTerminal) {
        db.prepare(
          `
            UPDATE logical_runs
            SET status = 'claimed',
                state = 'claimed',
                lease_token = ?,
                updated_at = ?,
                claimed_at = ?,
                started_at = NULL,
                last_heartbeat_at = NULL,
                deadline_at = ?,
                finished_at = NULL,
                exited_at = NULL,
                exit_code = NULL,
                terminal_reason = NULL,
                terminal_source = NULL,
                status_reason = 'retry_claimed',
                identity_key = ?,
                job_kind = ?,
                supervisor_version = ?,
                metadata_json = ?
            WHERE logical_run_key = ?
          `,
        ).run(
          normalizedLeaseToken,
          timestamp,
          timestamp,
          deadlineAt,
          normalizedIdentityKey,
          normalizedJobKind,
          supervisorVersion,
          metadataJson,
          logicalRunKey,
        );
      } else {
        db.prepare(
          `
            INSERT INTO logical_runs (
              logical_run_key,
              scope_id,
              job_id,
              slot_key,
              scheduled_at,
              status,
              lease_token,
              created_at,
              updated_at,
              state,
              claimed_at,
              identity_key,
              job_kind,
              supervisor_version,
              metadata_json,
              source_scope_id,
              source_cwd
            )
            VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          logicalRunKey,
          requireNonEmptyString(scopeId, "scopeId"),
          requireNonEmptyString(jobId, "jobId"),
          slotKey,
          requireNonEmptyString(scheduledAt, "scheduledAt"),
          normalizedLeaseToken,
          timestamp,
          timestamp,
          timestamp,
          normalizedIdentityKey,
          normalizedJobKind,
          supervisorVersion,
          metadataJson,
          sourceScopeId,
          sourceCwd,
        );
      }

      db.prepare(
        `
          INSERT INTO run_attempts (
            attempt_id,
            logical_run_key,
            daemon_instance_id,
            lease_token,
            started_at,
            deadline_at,
            status,
            state,
            claimed_at,
            identity_key,
            job_kind,
            supervisor_version
          )
          VALUES (?, ?, ?, ?, ?, ?, 'claimed', 'claimed', ?, ?, ?, ?)
        `,
      ).run(
        normalizedAttemptId,
        logicalRunKey,
        normalizedDaemonInstanceId,
        normalizedLeaseToken,
        timestamp,
        deadlineAt,
        timestamp,
        normalizedIdentityKey,
        normalizedJobKind,
        supervisorVersion,
      );
      // Suppress this job in the due projection while its run is in flight.
      setDueProjectionActiveRunInTxn(
        db,
        scopeId,
        jobId,
        logicalRunKey,
        timestamp,
      );
      db.exec("COMMIT");
      return {
        claimed: true,
        logical_run_key: logicalRunKey,
        slot_key: slotKey,
        attempt_id: normalizedAttemptId,
        status: "claimed",
        recovered_terminal: recoveringTerminal,
        recovered_interrupted:
          recoveringTerminal && recoveredStatus === "interrupted",
        recovered_status: recoveredStatus,
      };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  });
}

export function claimLogicalRunForJob({
  home = helmHome(),
  scope,
  job,
  scheduledAt,
  attemptId,
  daemonInstanceId,
  leaseToken,
  deadlineAt = null,
  now = nowIso(),
} = {}) {
  const identity = ledgerIdentityForJob({ scope, job, scheduledAt });
  const shadow = skyhookLedgerMetadataEnabled(job);
  return claimLogicalRun({
    home,
    scopeId: scope.scope_id,
    sourceScopeId: scope.scope_id,
    sourceCwd: scope.cwd,
    jobId: job.id,
    scheduleId: identity.schedule_id,
    scheduleExpression: identity.schedule_expression,
    scheduleTimezone: identity.schedule_timezone,
    scheduledAt,
    attemptId,
    daemonInstanceId,
    leaseToken,
    deadlineAt,
    metadata: job.metadata || null,
    identityKey: shadow ? skyhookIdentityKeyForJob({ scope, job }) : null,
    jobKind: shadow ? skyhookJobKindForJob(job) : null,
    supervisorVersion: shadow ? "skyhook-shadow-v1" : null,
    retryMaxAttempts: job.retry?.max_attempts,
    now,
  });
}

export function recordRunAttemptRunning({
  home = helmHome(),
  attemptId,
  wrapperPid = null,
  jobPid = null,
  processGroupId = null,
  wrapperState = "post_exec",
  now = nowIso(),
} = {}) {
  const normalizedAttemptId = requireNonEmptyString(attemptId, "attemptId");
  const timestamp = requireNonEmptyString(now, "now");
  return runWithRuntimeStore(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const attempt = db
        .prepare(
          "SELECT attempt_id, logical_run_key FROM run_attempts WHERE attempt_id = ?",
        )
        .get(normalizedAttemptId);
      if (!attempt) {
        throw new Error(`run attempt not found: ${normalizedAttemptId}`);
      }
      db.prepare(
        `
          UPDATE run_attempts
          SET
            wrapper_pid = ?,
            job_pid = ?,
            process_group_id = ?,
            pid = ?,
            pgid = ?,
            wrapper_state = ?,
            status = 'running',
            state = 'running',
            last_heartbeat_at = ?
          WHERE attempt_id = ?
        `,
      ).run(
        wrapperPid,
        jobPid,
        processGroupId,
        jobPid,
        processGroupId,
        requireNonEmptyString(wrapperState, "wrapperState"),
        timestamp,
        normalizedAttemptId,
      );
      db.prepare(
        `
          UPDATE logical_runs
          SET status = 'running',
              state = 'running',
              started_at = COALESCE(started_at, ?),
              last_heartbeat_at = ?,
              updated_at = ?
          WHERE logical_run_key = ?
        `,
      ).run(timestamp, timestamp, timestamp, attempt.logical_run_key);
      db.exec("COMMIT");
      return { updated: true, attempt_id: normalizedAttemptId };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  });
}

function logicalStatusForResult(status, error = null) {
  if (status === "success" || status === "succeeded") return "succeeded";
  if (status === "timeout" || String(error || "").startsWith("timeout after "))
    return "timed_out";
  if (status === "lost") return "lost";
  if (status === "skipped") return "skipped";
  if (status === "quarantined") return "quarantined";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

export function finalizeRunAttempt({
  home = helmHome(),
  attemptId,
  status,
  error = null,
  cleanup = null,
  exitCode = null,
  terminalSource = null,
  signalSource = null,
  startupWindowMs = null,
  now = nowIso(),
} = {}) {
  const normalizedAttemptId = requireNonEmptyString(attemptId, "attemptId");
  const timestamp = requireNonEmptyString(now, "now");
  const logicalStatus = logicalStatusForResult(status, error);
  const attemptStatus =
    logicalStatus === "succeeded"
      ? "succeeded"
      : logicalStatus === "timed_out"
        ? "timed_out"
        : logicalStatus === "interrupted"
          ? "interrupted"
          : "failed";
  const logicalRunStatus =
    logicalStatus === "lost" ? "interrupted" : logicalStatus;
  return runWithRuntimeStore(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const attempt = db
        .prepare(
          `SELECT
             ra.logical_run_key,
             ra.status AS attempt_status,
             ra.state AS attempt_state,
             lr.scope_id,
             lr.job_id,
             lr.status AS logical_run_status,
             lr.state AS logical_run_state
           FROM run_attempts ra
           JOIN logical_runs lr ON lr.logical_run_key = ra.logical_run_key
           WHERE ra.attempt_id = ?`,
        )
        .get(normalizedAttemptId);
      if (!attempt) {
        throw new Error(`run attempt not found: ${normalizedAttemptId}`);
      }
      const existingAttemptState =
        attempt.attempt_state || attempt.attempt_status || null;
      if (
        existingAttemptState === "succeeded" &&
        logicalStatus !== "succeeded"
      ) {
        process.stderr.write(
          `[runtime_ledger] terminal overwrite skipped run=${normalizedAttemptId} existing=succeeded requested=${logicalStatus} reason=${error || "none"} source=${terminalSource || "unknown"} at=${timestamp}\n`,
        );
        db.exec("COMMIT");
        return {
          finalized: false,
          attempt_id: normalizedAttemptId,
          logical_run_key: attempt.logical_run_key,
          status: "succeeded",
        };
      }
      db.prepare(
        `
          UPDATE run_attempts
          SET
            status = ?,
            state = ?,
            wrapper_state = 'finalized',
            finished_at = ?,
            exited_at = ?,
            exit_code = COALESCE(?, exit_code),
            terminal_reason = ?,
            terminal_source = ?,
            signal_source = COALESCE(?, signal_source),
            startup_window_ms = COALESCE(?, startup_window_ms),
            cleanup_json = ?
          WHERE attempt_id = ?
        `,
      ).run(
        attemptStatus,
        logicalStatus,
        timestamp,
        timestamp,
        exitCode,
        error,
        terminalSource,
        signalSource,
        startupWindowMs,
        cleanup === null ? null : stableJson(cleanup),
        normalizedAttemptId,
      );
      db.prepare(
        `
          UPDATE logical_runs
          SET
            status = ?,
            state = ?,
            updated_at = ?,
            finished_at = ?,
            exited_at = ?,
            exit_code = COALESCE(?, exit_code),
            terminal_reason = ?,
            terminal_source = ?,
            status_reason = ?
          WHERE logical_run_key = ?
        `,
      ).run(
        logicalRunStatus,
        logicalStatus,
        timestamp,
        timestamp,
        timestamp,
        exitCode,
        error,
        terminalSource,
        error,
        attempt.logical_run_key,
      );
      // Make the completed job eligible in the due projection again.
      clearDueProjectionActiveRunInTxn(
        db,
        attempt.scope_id,
        attempt.job_id,
        timestamp,
      );
      db.exec("COMMIT");
      return {
        finalized: true,
        attempt_id: normalizedAttemptId,
        logical_run_key: attempt.logical_run_key,
        status: logicalStatus,
      };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  });
}

// Fail-soft report evidence preserves lost-run protection on errors.
function effectiveOwnerCompletionFor(home, attempt) {
  try {
    const reportVerdict = runSatisfiedReportSidecar({
      home,
      scopeId: attempt?.scope_id || null,
      runId: attempt?.attempt_id || null,
      jobId: attempt?.job_id || null,
    });
    if (reportVerdict.satisfied) return reportVerdict;
    return { satisfied: false };
  } catch {
    return { satisfied: false };
  }
}

export function reconcileRuntimeLedger({
  home = helmHome(),
  now = nowIso(),
  pidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  appendActivity = appendActivityEventForHome,
} = {}) {
  const timestamp = requireNonEmptyString(now, "now");
  const reconcileStartedMs = Date.now();
  let scanFinishedMs = reconcileStartedMs;
  let commitFinishedMs = reconcileStartedMs;
  const result = runWithRuntimeStore(home, (db) => {
    const interrupted = [];
    const terminalEvents = [];
    const attempts = db
      .prepare(
        `
          SELECT
            a.attempt_id,
            a.logical_run_key,
            a.status,
            a.state,
            a.wrapper_pid,
            a.job_pid,
            a.pid,
            a.deadline_at,
            a.claimed_at,
            a.started_at,
            a.terminal_reason,
            a.cleanup_json,
            l.scope_id,
            l.job_id,
            l.scheduled_at,
            l.metadata_json
          FROM run_attempts a
          JOIN logical_runs l ON l.logical_run_key = a.logical_run_key
          WHERE COALESCE(a.state, a.status) IN ('claimed', 'launching', 'running')
             OR a.status IN ('claimed', 'running')
        `,
      )
      .all();
    scanFinishedMs = Date.now();

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const attempt of attempts) {
        let reason = null;
        let targetState = "lost";
        let targetStatus = "interrupted";
        let terminalSource = "lost";
        const state = attempt.state || attempt.status;
        if (attempt.deadline_at && attempt.deadline_at <= timestamp) {
          reason = "deadline_exceeded";
          targetState = "timed_out";
          targetStatus = "timed_out";
          terminalSource = "reaper";
        } else if (
          state === "claimed" &&
          !attempt.wrapper_pid &&
          !attempt.pid
        ) {
          if (claimedAttemptWithinLaunchGrace(attempt, timestamp)) continue;
          reason = "claimed_without_wrapper";
        } else if (
          state === "launching" &&
          !attempt.wrapper_pid &&
          !attempt.pid
        ) {
          reason = "launching_without_pid";
        } else if (state === "running") {
          const wrapperPid = attempt.wrapper_pid || attempt.pgid;
          const jobPid = attempt.job_pid || attempt.pid;
          const wrapperAlive =
            Number.isInteger(wrapperPid) &&
            wrapperPid > 0 &&
            pidAlive(wrapperPid);
          const jobAlive =
            Number.isInteger(jobPid) && jobPid > 0 && pidAlive(jobPid);
          if (!wrapperAlive && !jobAlive) {
            if (runningAttemptWithinFinalizationGrace(attempt, timestamp))
              continue;
            if (attempt.terminal_reason !== "running_process_missing_pending") {
              const pendingUpdate = db
                .prepare(
                  `
                  UPDATE run_attempts
                  SET terminal_reason = 'running_process_missing_pending',
                      terminal_source = 'reconciler',
                      cleanup_json = ?
                  WHERE attempt_id = ?
                    AND COALESCE(state, status) = 'running'
                `,
                )
                .run(
                  stableJson({
                    reconciliation: "running_process_missing_pending",
                    detected_at: timestamp,
                  }),
                  attempt.attempt_id,
                );
              if (pendingUpdate.changes > 0) {
                process.stderr.write(
                  `[🪳 TEMP CANARY_LOST_RECONCILE] reconciler marked pending run=${attempt.attempt_id} job=${attempt.job_id || "unknown"} detected_at=${timestamp}\n`,
                );
              }
              continue;
            }
            reason = "running_process_missing";
            // Only an owned successful report sidecar proves work completion.
            const effective = effectiveOwnerCompletionFor(home, attempt);
            if (effective.satisfied) {
              reason = "report_sidecar_satisfied";
              targetState = "succeeded";
              targetStatus = "succeeded";
              terminalSource = "reconciler";
            }
          }
        }
        if (!reason) continue;
        const terminalUpdate = db
          .prepare(
            `
            UPDATE run_attempts
            SET status = ?,
                state = ?,
                wrapper_state = 'finalized',
                finished_at = ?,
                exited_at = ?,
                terminal_reason = ?,
                terminal_source = ?,
                cleanup_json = ?
            WHERE attempt_id = ?
              AND (
                COALESCE(state, status) IN ('claimed', 'launching', 'running')
                OR status IN ('claimed', 'running')
              )
          `,
          )
          .run(
            targetStatus,
            targetState,
            timestamp,
            timestamp,
            reason,
            terminalSource,
            stableJson({ reconciliation: reason }),
            attempt.attempt_id,
          );
        if (terminalUpdate.changes === 0) {
          process.stderr.write(
            `[🪳 TEMP CANARY_LOST_RECONCILE] reconciler skipped stale terminal snapshot run=${attempt.attempt_id} job=${attempt.job_id || "unknown"} reason=${reason} at=${timestamp}\n`,
          );
          continue;
        }
        db.prepare(
          `
            UPDATE logical_runs
            SET status = ?,
                state = ?,
                updated_at = ?,
                finished_at = ?,
                exited_at = ?,
                terminal_reason = ?,
                terminal_source = ?,
                status_reason = ?
            WHERE logical_run_key = ?
          `,
        ).run(
          targetStatus,
          targetState,
          timestamp,
          timestamp,
          timestamp,
          reason,
          terminalSource,
          reason,
          attempt.logical_run_key,
        );
        terminalEvents.push({
          type: "job_run_terminal",
          kind: "run",
          level:
            targetState === "timed_out"
              ? "error"
              : targetState === "succeeded"
                ? "info"
                : "warn",
          scope_id: attempt.scope_id || null,
          job_id: attempt.job_id || null,
          run_id: attempt.attempt_id,
          status: targetState,
          reason,
          scheduled_at: attempt.scheduled_at || null,
          finished_at: timestamp,
          error: targetState === "succeeded" ? null : reason,
          data: {
            terminal_source: terminalSource,
            reconciler: true,
            effective_owner_satisfied: targetState === "succeeded",
          },
        });
        // Effective-owner success is not an interruption.
        if (targetState !== "succeeded") interrupted.push(attempt.attempt_id);
      }
      db.exec("COMMIT");
      commitFinishedMs = Date.now();
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
    return {
      interrupted_attempt_ids: interrupted,
      interrupted_count: interrupted.length,
      terminal_events: terminalEvents,
    };
  });
  const activityStartedMs = Date.now();
  const activityEventErrors = [];
  for (const event of result.terminal_events) {
    try {
      appendActivity(home, event);
    } catch (err) {
      activityEventErrors.push({
        run_id: event.run_id || null,
        message: err?.message || String(err),
      });
    }
  }
  const activityFinishedMs = Date.now();
  if (
    result.interrupted_count > 0 ||
    activityFinishedMs - reconcileStartedMs >= 100
  ) {
    const scanMs = Math.max(0, scanFinishedMs - reconcileStartedMs);
    const updateMs = Math.max(0, commitFinishedMs - scanFinishedMs);
    const activityMs = Math.max(0, activityFinishedMs - activityStartedMs);
    process.stderr.write(
      `[🪳 TEMP RUNTIME_RECONCILE] attempts=${result.terminal_events.length} interrupted=${result.interrupted_count} scan_ms=${scanMs} update_ms=${updateMs} activity_ms=${activityMs} activity_errors=${activityEventErrors.length}\n`,
    );
  }
  return {
    interrupted_attempt_ids: result.interrupted_attempt_ids,
    interrupted_count: result.interrupted_count,
    activity_event_error_count: activityEventErrors.length,
    activity_event_errors: activityEventErrors,
  };
}

export function claimSkyhookRun({
  home = helmHome(),
  scopeId,
  sourceScopeId = scopeId,
  sourceCwd = null,
  jobId,
  scheduledAt = nowIso(),
  attemptId,
  daemonInstanceId,
  leaseToken,
  identityKey,
  jobKind,
  logicalRunKey = null,
  slotKey = null,
  deadlineAt = null,
  supervisorVersion = "skyhook-v1",
  metadata = null,
  now = nowIso(),
} = {}) {
  const timestamp = requireNonEmptyString(now, "now");
  const normalizedAttemptId = requireNonEmptyString(attemptId, "attemptId");
  const normalizedIdentityKey = requireNonEmptyString(
    identityKey,
    "identityKey",
  );
  const normalizedJobKind = requireNonEmptyString(jobKind, "jobKind");
  const normalizedSlotKey =
    slotKey ||
    sha256Key("skyhook_slot", {
      scope_id: scopeId,
      job_id: jobId,
      scheduled_at: scheduledAt,
    });
  const normalizedLogicalRunKey =
    logicalRunKey ||
    sha256Key("skyhook_logical_run", {
      scope_id: scopeId,
      job_id: jobId,
      slot_key: normalizedSlotKey,
    });
  const normalizedLeaseToken = requireNonEmptyString(leaseToken, "leaseToken");
  const normalizedDaemonInstanceId = requireNonEmptyString(
    daemonInstanceId,
    "daemonInstanceId",
  );

  const params = {
    scopeId,
    sourceScopeId,
    sourceCwd,
    jobId,
    scheduledAt,
    normalizedAttemptId,
    normalizedIdentityKey,
    normalizedJobKind,
    normalizedSlotKey,
    normalizedLogicalRunKey,
    normalizedLeaseToken,
    normalizedDaemonInstanceId,
    deadlineAt,
    supervisorVersion,
    metadata,
    timestamp,
  };

  return withRuntimeStoreTransaction({ home }, (db) =>
    insertSkyhookRunClaim(db, params),
  );
}

function insertSkyhookRunClaim(db, params) {
  const {
    scopeId,
    sourceScopeId,
    sourceCwd,
    jobId,
    scheduledAt,
    normalizedAttemptId,
    normalizedIdentityKey,
    normalizedJobKind,
    normalizedSlotKey,
    normalizedLogicalRunKey,
    normalizedLeaseToken,
    normalizedDaemonInstanceId,
    deadlineAt,
    supervisorVersion,
    metadata,
    timestamp,
  } = params;
  const existing = db
    .prepare(
      "SELECT logical_run_key, state, status FROM logical_runs WHERE logical_run_key = ?",
    )
    .get(normalizedLogicalRunKey);
  if (existing) {
    return {
      claimed: false,
      logical_run_key: normalizedLogicalRunKey,
      attempt_id: normalizedAttemptId,
      state: existing.state || existing.status,
      reason: "duplicate_logical_run",
    };
  }

  const expiredAttemptIds = markExpiredIdentityClaims(
    db,
    normalizedIdentityKey,
    timestamp,
  );
  const liveIdentity = db
    .prepare(
      `
        SELECT attempt_id, state, deadline_at
        FROM run_attempts
        WHERE identity_key = ?
          AND state IN ('claimed', 'launching', 'running')
        ORDER BY claimed_at ASC
        LIMIT 1
      `,
    )
    .get(normalizedIdentityKey);
  if (liveIdentity) {
    return {
      claimed: false,
      logical_run_key: normalizedLogicalRunKey,
      attempt_id: normalizedAttemptId,
      state: liveIdentity.state,
      reason: "identity_in_flight",
      identity_key: normalizedIdentityKey,
      blocking_attempt_id: liveIdentity.attempt_id,
      expired_attempt_ids: expiredAttemptIds,
    };
  }

  db.prepare(
    `
        INSERT INTO logical_runs (
          logical_run_key,
          scope_id,
          job_id,
          slot_key,
          scheduled_at,
          status,
          lease_token,
          created_at,
          updated_at,
          finished_at,
          status_reason,
          metadata_json,
          identity_key,
          job_kind,
          state,
          claimed_at,
          started_at,
          last_heartbeat_at,
          deadline_at,
          supervisor_version,
          source_scope_id,
          source_cwd
        )
        VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, NULL, NULL, ?, ?, ?, 'claimed', ?, NULL, NULL, ?, ?, ?, ?)
      `,
  ).run(
    normalizedLogicalRunKey,
    requireNonEmptyString(scopeId, "scopeId"),
    requireNonEmptyString(jobId, "jobId"),
    normalizedSlotKey,
    requireNonEmptyString(scheduledAt, "scheduledAt"),
    normalizedLeaseToken,
    timestamp,
    timestamp,
    metadata === null ? null : stableJson(metadata),
    normalizedIdentityKey,
    normalizedJobKind,
    timestamp,
    deadlineAt,
    supervisorVersion,
    sourceScopeId,
    sourceCwd,
  );

  db.prepare(
    `
        INSERT INTO run_attempts (
          attempt_id,
          logical_run_key,
          daemon_instance_id,
          wrapper_pid,
          job_pid,
          process_group_id,
          wrapper_state,
          lease_token,
          started_at,
          deadline_at,
          finished_at,
          status,
          cleanup_json,
          identity_key,
          job_kind,
          pid,
          pgid,
          state,
          claimed_at,
          last_heartbeat_at,
          supervisor_version
        )
        VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, 'claimed', NULL, ?, ?, NULL, NULL, 'claimed', ?, NULL, ?)
      `,
  ).run(
    normalizedAttemptId,
    normalizedLogicalRunKey,
    normalizedDaemonInstanceId,
    normalizedLeaseToken,
    timestamp,
    deadlineAt,
    normalizedIdentityKey,
    normalizedJobKind,
    timestamp,
    supervisorVersion,
  );

  return {
    claimed: true,
    logical_run_key: normalizedLogicalRunKey,
    attempt_id: normalizedAttemptId,
    state: "claimed",
    expired_attempt_ids: expiredAttemptIds,
  };
}

export function readSkyhookAttempt({ home = helmHome(), attemptId } = {}) {
  const normalizedAttemptId = requireNonEmptyString(attemptId, "attemptId");
  return runWithRuntimeStore(home, (db) =>
    db
      .prepare(
        `
          SELECT
            a.*,
            l.scope_id,
            l.job_id,
            l.scheduled_at,
            l.status AS logical_status,
            l.state AS logical_state
          FROM run_attempts a
          JOIN logical_runs l ON l.logical_run_key = a.logical_run_key
          WHERE a.attempt_id = ?
        `,
      )
      .get(normalizedAttemptId),
  );
}

function markExpiredIdentityClaims(db, identityKey, now) {
  const rows = db
    .prepare(
      `
        SELECT attempt_id
        FROM run_attempts
        WHERE identity_key = ?
          AND state IN ('claimed', 'launching', 'running')
          AND deadline_at IS NOT NULL
          AND deadline_at <= ?
      `,
    )
    .all(identityKey, now);
  for (const row of rows) {
    db.prepare(
      `
        UPDATE run_attempts
        SET state = 'lost',
            status = 'failed',
            wrapper_state = 'finalized',
            finished_at = ?,
            exited_at = ?,
            terminal_reason = 'identity_claim_expired',
            terminal_source = 'lost'
        WHERE attempt_id = ?
      `,
    ).run(now, now, row.attempt_id);
  }
  if (rows.length > 0) {
    db.prepare(
      `
        UPDATE logical_runs
        SET state = 'lost',
            status = 'failed',
            updated_at = ?,
            finished_at = ?,
            exited_at = ?,
            terminal_reason = 'identity_claim_expired',
            terminal_source = 'lost',
            status_reason = 'identity_claim_expired'
        WHERE logical_run_key IN (
          SELECT logical_run_key FROM run_attempts WHERE attempt_id IN (${rows
            .map(() => "?")
            .join(",")})
        )
      `,
    ).run(now, now, now, ...rows.map((row) => row.attempt_id));
  }
  return rows.map((row) => row.attempt_id);
}

function outboundSuppressionReason(status) {
  if (status === "accepted") return "already_accepted";
  if (status === "ambiguous") return "ambiguous_requires_reconciliation";
  if (status === "attempting") return "attempt_in_progress";
  if (status === "dry_run") return "dry_run_recorded";
  if (status === "blocked") return "blocked";
  return "duplicate_side_effect";
}

export function prepareOutboundEffect({
  home = helmHome(),
  namespace,
  logicalRunKey = null,
  logicalEventKey,
  effect,
  channel,
  recipient,
  payload,
  renderInputs = {},
  templateVersion = null,
  renderedPayloadRef = null,
  initialStatus = "attempting",
  now = nowIso(),
} = {}) {
  const sideEffectKey = deriveSideEffectKey({
    namespace,
    logicalEventKey,
    effect,
    channel,
    recipient,
    templateVersion,
  });
  const payloadHash = sha256Value(payload ?? null);
  const renderInputsHash = sha256Value(renderInputs ?? null);
  const timestamp = requireNonEmptyString(now, "now");
  const normalizedStatus = requireNonEmptyString(
    initialStatus,
    "initialStatus",
  );

  return runWithRuntimeStore(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare("SELECT * FROM outbound_effects WHERE side_effect_key = ?")
        .get(sideEffectKey);
      if (existing) {
        if (
          existing.payload_hash !== payloadHash ||
          existing.render_inputs_hash !== renderInputsHash
        ) {
          db.prepare(
            `
              UPDATE outbound_effects
              SET status = 'blocked',
                  updated_at = ?
              WHERE side_effect_key = ?
            `,
          ).run(timestamp, sideEffectKey);
          db.exec("COMMIT");
          return {
            allowed: false,
            side_effect_key: sideEffectKey,
            status: "blocked",
            reason: "payload_changed_for_side_effect_key",
          };
        }
        db.exec("COMMIT");
        return {
          allowed: false,
          side_effect_key: sideEffectKey,
          status: "suppressed_duplicate",
          reason: outboundSuppressionReason(existing.status),
          existing_status: existing.status,
        };
      }

      db.prepare(
        `
          INSERT INTO outbound_effects (
            side_effect_key,
            namespace,
            logical_run_key,
            logical_event_key,
            channel,
            recipient,
            status,
            payload_hash,
            render_inputs_hash,
            template_version,
            first_rendered_payload_ref,
            attempt_count,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `,
      ).run(
        sideEffectKey,
        requireNonEmptyString(namespace, "namespace"),
        logicalRunKey,
        requireNonEmptyString(logicalEventKey, "logicalEventKey"),
        requireNonEmptyString(channel, "channel"),
        requireNonEmptyString(recipient, "recipient"),
        normalizedStatus,
        payloadHash,
        renderInputsHash,
        templateVersion,
        renderedPayloadRef,
        timestamp,
        timestamp,
      );
      db.exec("COMMIT");
      return {
        allowed: normalizedStatus === "attempting",
        side_effect_key: sideEffectKey,
        status: normalizedStatus,
        payload_hash: payloadHash,
        render_inputs_hash: renderInputsHash,
      };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  });
}

export function recordOutboundEffectSuccess({
  home = helmHome(),
  sideEffectKey,
  providerMessageId = null,
  now = nowIso(),
} = {}) {
  const key = requireNonEmptyString(sideEffectKey, "sideEffectKey");
  const timestamp = requireNonEmptyString(now, "now");
  return runWithRuntimeStore(home, (db) => {
    const result = db
      .prepare(
        `
          UPDATE outbound_effects
          SET status = 'accepted',
              attempt_count = attempt_count + 1,
              last_provider_message_id = ?,
              updated_at = ?
          WHERE side_effect_key = ?
        `,
      )
      .run(providerMessageId, timestamp, key);
    return { updated: result.changes === 1, side_effect_key: key };
  });
}

export function recordOutboundEffectFailure({
  home = helmHome(),
  sideEffectKey,
  ambiguous = false,
  error = null,
  now = nowIso(),
} = {}) {
  const key = requireNonEmptyString(sideEffectKey, "sideEffectKey");
  const timestamp = requireNonEmptyString(now, "now");
  const status = ambiguous ? "ambiguous" : "failed_definite";
  return runWithRuntimeStore(home, (db) => {
    const result = db
      .prepare(
        `
          UPDATE outbound_effects
          SET status = ?,
              attempt_count = attempt_count + 1,
              updated_at = ?,
              first_rendered_payload_ref = COALESCE(first_rendered_payload_ref, ?)
          WHERE side_effect_key = ?
        `,
      )
      .run(status, timestamp, error, key);
    return { updated: result.changes === 1, side_effect_key: key, status };
  });
}

export function getOutboundEffect({ home = helmHome(), sideEffectKey } = {}) {
  const key = requireNonEmptyString(sideEffectKey, "sideEffectKey");
  return runWithRuntimeStore(home, (db) =>
    db
      .prepare("SELECT * FROM outbound_effects WHERE side_effect_key = ?")
      .get(key),
  );
}

export function listOutboundEffects({
  home = helmHome(),
  status = null,
  limit = 100,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return runWithRuntimeStore(home, (db) => {
    if (status) {
      return db
        .prepare(
          `
            SELECT
              side_effect_key,
              namespace,
              logical_run_key,
              logical_event_key,
              channel,
              recipient,
              status,
              payload_hash,
              render_inputs_hash,
              template_version,
              attempt_count,
              last_provider_message_id,
              created_at,
              updated_at
            FROM outbound_effects
            WHERE status = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `,
        )
        .all(status, boundedLimit);
    }
    return db
      .prepare(
        `
          SELECT
            side_effect_key,
            namespace,
            logical_run_key,
            logical_event_key,
            channel,
            recipient,
            status,
            payload_hash,
            render_inputs_hash,
            template_version,
            attempt_count,
            last_provider_message_id,
            created_at,
            updated_at
          FROM outbound_effects
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(boundedLimit);
  });
}
