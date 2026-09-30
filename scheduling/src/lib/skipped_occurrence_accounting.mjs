import { createHash } from "node:crypto";

import { appendActivityEvent, tailEventsByType } from "./activity_stream.mjs";
import {
  appendJobHistoryEvent,
  jobHistoryPath,
  loadJobHistory,
} from "./read_store.mjs";
import { readJsonIfExists, writeJsonAtomic } from "./store.mjs";

const PRESENCE_SCAN_LIMIT = 200;
const ACTIVITY_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const INDEX_VERSION = "2.0";
const MAX_ACCOUNTED_OCCURRENCES = 1024;

function nowIso() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).toISOString()
    : new Date().toISOString();
}

function accountingKey(scopeId, jobId, scheduledAt, reason) {
  return `${scopeId}\u0000${jobId}\u0000${scheduledAt || ""}\u0000${reason || ""}`;
}

function eventIdentity(key) {
  const token = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return {
    eventId: `run_skip_${token}_skipped`,
    runId: `skip_${token}`,
  };
}

function indexPath(scope, jobId) {
  return `${jobHistoryPath(scope, jobId)}.skipped-occurrence-index.json`;
}

function loadIndex(scope, jobId) {
  return readJsonIfExists(indexPath(scope, jobId), null);
}

function normalizedIndex(raw) {
  const entries =
    raw?.entries &&
    typeof raw.entries === "object" &&
    !Array.isArray(raw.entries)
      ? { ...raw.entries }
      : {};
  if (raw?.accounting?.key && !entries[raw.accounting.key]) {
    entries[raw.accounting.key] = { ...raw.accounting };
  }
  const ordered = Array.isArray(raw?.order)
    ? raw.order.filter((key) => typeof key === "string" && entries[key])
    : [];
  for (const key of Object.keys(entries)) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return {
    entries,
    order: ordered,
    legacy: raw?.version !== INDEX_VERSION,
  };
}

function pruneIndex(index) {
  while (index.order.length > MAX_ACCOUNTED_OCCURRENCES) {
    const removed = index.order.shift();
    delete index.entries[removed];
  }
}

function saveIndex(scope, jobId, index, latestKey) {
  pruneIndex(index);
  writeJsonAtomic(
    indexPath(scope, jobId),
    {
      version: INDEX_VERSION,
      entries: index.entries,
      order: index.order,
      // Keep the latest v1-shaped record for downgrade/read compatibility.
      accounting: index.entries[latestKey] || null,
    },
    { durable: true },
  );
}

function historyEvent({
  scope,
  job,
  eventId,
  runId,
  recordedAt,
  scheduledAt,
  reason,
}) {
  return {
    id: eventId,
    ts: recordedAt,
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    job_id: job.id,
    run_id: runId,
    kind: "skipped",
    status: "skipped",
    reason,
    scheduled_at: scheduledAt,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    error: null,
    log_paths: null,
    payload: {
      metadata:
        job.metadata &&
        typeof job.metadata === "object" &&
        !Array.isArray(job.metadata)
          ? job.metadata
          : {},
    },
  };
}

export function recordSkippedOccurrence({
  scope,
  job,
  scheduledAt,
  reason,
  activityType = "job_run_skipped",
  daemonInstanceId = null,
}) {
  const key = accountingKey(scope.scope_id, job.id, scheduledAt, reason);
  const index = normalizedIndex(loadIndex(scope, job.id));
  const priorAccounting = index.entries[key] || null;
  const identity = eventIdentity(key);
  const accounting = priorAccounting
    ? { ...priorAccounting }
    : {
        key,
        event_id: identity.eventId,
        run_id: identity.runId,
        recorded_at: nowIso(),
        history: false,
        activity: false,
        activity_type: activityType,
      };
  const presenceScans = { history: 0, activity: 0 };
  let indexChanged = index.legacy || !priorAccounting;
  if (!accounting.activity_type) {
    accounting.activity_type = activityType;
    indexChanged = true;
  }

  let durableHistoryEvent = null;
  const shouldRepairLegacy = index.legacy;
  if (!accounting.history && (priorAccounting || shouldRepairLegacy)) {
    presenceScans.history += 1;
    durableHistoryEvent = loadJobHistory(
      scope,
      job.id,
      PRESENCE_SCAN_LIMIT,
    ).find((entry) => entry?.id === accounting.event_id);
    if (durableHistoryEvent) {
      accounting.history = true;
      accounting.recorded_at = durableHistoryEvent.ts || accounting.recorded_at;
      indexChanged = true;
    }
  }
  if (!accounting.activity && (priorAccounting || shouldRepairLegacy)) {
    presenceScans.activity += 1;
    const durableActivityEvent = tailEventsByType(accounting.activity_type, {
      limit: PRESENCE_SCAN_LIMIT,
      withinDays: 2,
      now: new Date(accounting.recorded_at),
      maxBytes: ACTIVITY_SCAN_MAX_BYTES,
    }).find((entry) => entry?.event_id === accounting.event_id);
    if (durableActivityEvent) {
      accounting.activity = true;
      if (!durableHistoryEvent) {
        accounting.recorded_at =
          durableActivityEvent.timestamp || accounting.recorded_at;
      }
      indexChanged = true;
    }
  }

  const event =
    durableHistoryEvent ||
    historyEvent({
      scope,
      job,
      eventId: accounting.event_id,
      runId: accounting.run_id,
      recordedAt: accounting.recorded_at,
      scheduledAt,
      reason,
    });
  index.entries[key] = accounting;
  if (!index.order.includes(key)) index.order.push(key);
  if (!priorAccounting && (!accounting.history || !accounting.activity)) {
    // Claim the deterministic identity before either append. A crash after an
    // append leaves an incomplete entry that the next tick can repair.
    saveIndex(scope, job.id, index, key);
    indexChanged = false;
  }
  if (!accounting.history) {
    appendJobHistoryEvent(scope, job.id, event);
    accounting.history = true;
    indexChanged = true;
  }
  if (!accounting.activity) {
    appendActivityEvent({
      event_id: accounting.event_id,
      timestamp: accounting.recorded_at,
      type: accounting.activity_type,
      kind: "run",
      level: "info",
      daemon_instance_id: daemonInstanceId,
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      run_id: accounting.run_id,
      status: "skipped",
      reason,
      scheduled_at: scheduledAt,
      data: { metadata: event.payload.metadata },
    });
    accounting.activity = true;
    indexChanged = true;
  }
  index.entries[key] = accounting;
  if (indexChanged) {
    saveIndex(scope, job.id, index, key);
  }

  return {
    history_event: event,
    accounting: { ...accounting },
    presence_scans: presenceScans,
  };
}
