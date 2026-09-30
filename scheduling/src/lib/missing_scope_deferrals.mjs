import { existsSync, readFileSync } from "node:fs";

import {
  appendActivityEvent,
  loadActivityEventsForScope,
} from "./activity_stream.mjs";
import { isSafeJobId } from "./job_id.mjs";
import { acquireLease, releaseLease, renewLease } from "./lock.mjs";
import {
  appendJobHistoryEvent,
  jobHistoryPath,
  loadJobHistory,
} from "./read_store.mjs";
import { jobsPath, readJsonIfExists, writeJsonAtomic } from "./store.mjs";

const HISTORY_PRESENCE_SCAN_LIMIT = 100;
const ACTIVITY_PRESENCE_SCAN_LIMIT = 10000;

function reconciliationLeaseSec() {
  const configured = Number(process.env.HELM_LEASE_SEC || 90);
  if (!Number.isFinite(configured) || configured <= 0) return 90;
  return Math.max(5, Math.min(configured, 300));
}

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function isStableScheduledAt(value) {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return (
    value === canonical ||
    (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"))
  );
}

function isClassifiableJob(job) {
  return (
    job !== null &&
    typeof job === "object" &&
    !Array.isArray(job) &&
    isSafeJobId(job.id) &&
    job.state !== null &&
    typeof job.state === "object" &&
    !Array.isArray(job.state) &&
    typeof job.state.enabled === "boolean" &&
    isStableScheduledAt(job.state.next_run_at)
  );
}

export function loadClassifiableJobs(scope) {
  const path = jobsPath(scope);
  if (!existsSync(path)) return { jobs: [], trusted: true };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { jobs: [], trusted: false };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.jobs)
  ) {
    return { jobs: [], trusted: false };
  }
  if (!parsed.jobs.every(isClassifiableJob)) {
    return { jobs: [], trusted: false };
  }
  return { jobs: parsed.jobs, trusted: true };
}

function isMissingScopeHistoryEvent(event, job, scheduledAt) {
  return (
    event?.kind === "deferred" &&
    event.reason === "scope_cwd_missing" &&
    event.job_id === job.id &&
    (event.scheduled_at || null) === scheduledAt
  );
}

function deferralKey(jobId, scheduledAt) {
  return `${jobId}\u0000${scheduledAt ?? ""}`;
}

function deferralIndexPath(scope, jobId) {
  return `${jobHistoryPath(scope, jobId)}.scope-cwd-missing-index.json`;
}

function loadDeferralIndex(scope, jobId) {
  const parsed = readJsonIfExists(deferralIndexPath(scope, jobId), null);
  return Array.isArray(parsed?.deferrals) ? parsed.deferrals : [];
}

function saveDeferralIndex(scope, jobId, deferrals) {
  writeJsonAtomic(
    deferralIndexPath(scope, jobId),
    { version: "1.0", deferrals },
    { durable: true },
  );
}

function upsertDeferralIndex(scope, jobId, deferrals, entry) {
  const index = deferrals.findIndex((item) => item.key === entry.key);
  if (index >= 0) deferrals[index] = entry;
  else deferrals.push(entry);
  saveDeferralIndex(scope, jobId, deferrals);
}

export function withMissingScopeCatalogLease(scope, fn) {
  const owner = `scope_cwd_missing_${process.pid}_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2, 8)}`;
  const leaseSec = reconciliationLeaseSec();
  const acquired = acquireLease(scope, owner, leaseSec, "catalog.lock");
  if (!acquired.acquired) return { acquired: false, details: acquired };
  try {
    return {
      acquired: true,
      value: fn({
        renew: () => renewLease(scope, owner, leaseSec, "catalog.lock"),
      }),
    };
  } finally {
    releaseLease(scope, owner, "catalog.lock");
  }
}

export function recordMissingScopeDeferrals(
  scope,
  jobs,
  { renew = () => true } = {},
) {
  if (!renew()) return { complete: false, reason: "lease_lost" };
  const activityEvents = loadActivityEventsForScope(
    scope.scope_id,
    ACTIVITY_PRESENCE_SCAN_LIMIT,
  );
  if (!renew()) return { complete: false, reason: "lease_lost" };
  const activityByDeferral = new Map();
  for (const event of activityEvents) {
    if (
      (event?.type === "job_run_deferred" ||
        event?.event_type === "job_run_deferred") &&
      event.reason === "scope_cwd_missing" &&
      typeof event.job_id === "string"
    ) {
      activityByDeferral.set(
        deferralKey(event.job_id, event.scheduled_at || null),
        event,
      );
    }
  }

  for (const job of jobs) {
    const scheduledAt = job.state.next_run_at;
    const key = deferralKey(job.id, scheduledAt);
    const deferralIndex = loadDeferralIndex(scope, job.id);
    let indexed = deferralIndex.find((entry) => entry.key === key) || null;
    if (!renew()) return { complete: false, reason: "lease_lost" };
    const history = loadJobHistory(
      scope,
      job.id,
      HISTORY_PRESENCE_SCAN_LIMIT,
    ).find((event) => isMissingScopeHistoryEvent(event, job, scheduledAt));
    if (!renew()) return { complete: false, reason: "lease_lost" };
    const activity = activityByDeferral.get(deferralKey(job.id, scheduledAt));
    const deferredAt =
      history?.payload?.deferred_since ||
      history?.ts ||
      activity?.data?.deferred_since ||
      activity?.timestamp ||
      indexed?.deferred_at ||
      nowIso();
    const eventId =
      history?.id ||
      activity?.event_id ||
      indexed?.event_id ||
      `job_${job.id}_deferred_scope_cwd_missing_${scheduledAt || "unscheduled"}`;
    indexed = {
      key,
      event_id: eventId,
      deferred_at: deferredAt,
      history: indexed?.history === true || Boolean(history),
      activity: indexed?.activity === true || Boolean(activity),
    };
    if (
      !deferralIndex.some((entry) => entry.key === key) &&
      (history || activity)
    )
      upsertDeferralIndex(scope, job.id, deferralIndex, indexed);
    if (!indexed.history) {
      appendJobHistoryEvent(scope, job.id, {
        id: eventId,
        ts: deferredAt,
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: job.id,
        run_id: null,
        kind: "deferred",
        status: "deferred",
        reason: "scope_cwd_missing",
        scheduled_at: scheduledAt,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        error: null,
        log_paths: null,
        payload: {
          deferred_since: deferredAt,
          next_run_at: scheduledAt,
        },
      });
      indexed.history = true;
      upsertDeferralIndex(scope, job.id, deferralIndex, indexed);
    }
    if (!renew()) return { complete: false, reason: "lease_lost" };
    if (!indexed.activity) {
      appendActivityEvent({
        event_id: eventId,
        timestamp: deferredAt,
        type: "job_run_deferred",
        kind: "run",
        level: "info",
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: job.id,
        status: "deferred",
        reason: "scope_cwd_missing",
        scheduled_at: scheduledAt,
        data: {
          deferred_since: deferredAt,
          next_run_at: scheduledAt,
        },
      });
      indexed.activity = true;
      upsertDeferralIndex(scope, job.id, deferralIndex, indexed);
    }
  }
  return { complete: true };
}
