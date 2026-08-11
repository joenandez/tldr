import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  appendActivityEvent,
  tldrAgentDiagnosticsRoot,
} from "./tldr_agent_diagnostics.mjs";
import {
  applyBeaconStopPolicy,
  listPendingBeaconObligationsForSession,
} from "./tldr_agent_beacon_marker.mjs";
import { reconcileBeaconObligation } from "./tldr_agent_beacon_message_evidence.mjs";
import { sessionDir } from "./identity_state.mjs";
import { writeJsonAtomic } from "./store.mjs";
import { withFileMutex } from "./substrate/file_mutex.mjs";

const BEACON_STOP_BLOCK_CAP = 3;
const UNRESOLVED_EVENT = "beacon_followup_unresolved";
const UNAVAILABLE_EVENT = "beacon_stop_gate_unavailable";

function safeObligationId(value) {
  const id = String(value ?? "");
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "[redacted-obligation]";
}

function safeIds(markers) {
  return markers.map((marker) => safeObligationId(marker.obligationId));
}

function renderPendingNotice(markers) {
  const obligations = markers.map((marker) => {
    const count = Math.max(1, Number(marker.stopBlockCount) || 0);
    return `${safeObligationId(marker.obligationId)} (block ${count} of ${BEACON_STOP_BLOCK_CAP})`;
  });
  return `[tldr; Beacon] Stop blocked: a deferred outcome email is still owed for ${obligations.join(
    ", ",
  )}. Complete or cancel the exact obligation, then stop again.`;
}

function renderForceAllowNotice(markers) {
  return `[tldr; Beacon] Stop allowed after ${BEACON_STOP_BLOCK_CAP} blocked attempts. Obligation(s) ${safeIds(
    markers,
  ).join(", ")} remain pending and were recorded for recovery.`;
}

function availabilityPath(sessionId) {
  return join(sessionDir(sessionId), "beacon-stop-gate-errors.json");
}

function readAvailabilityState(sessionId) {
  try {
    const value = JSON.parse(readFileSync(availabilityPath(sessionId), "utf8"));
    const count = Number(value?.count);
    return {
      count:
        Number.isInteger(count) && count >= 0
          ? Math.min(count, BEACON_STOP_BLOCK_CAP)
          : 0,
      firstFailureAt:
        typeof value?.first_failure_at === "string"
          ? value.first_failure_at
          : null,
    };
  } catch {
    return { count: 0, firstFailureAt: null };
  }
}

function writeAvailabilityState(sessionId, { count, firstFailureAt }) {
  writeJsonAtomic(
    availabilityPath(sessionId),
    {
      version: 1,
      count: Math.min(count, BEACON_STOP_BLOCK_CAP),
      first_failure_at: firstFailureAt,
    },
    { durable: true },
  );
}

export function clearBeaconStopAvailabilityErrors(sessionId) {
  try {
    unlinkSync(availabilityPath(sessionId));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function eventExists(home, eventId, _partitionTimestamp) {
  const root = tldrAgentDiagnosticsRoot(home);
  if (!existsSync(root)) return false;
  try {
    return readdirSync(root)
      .filter((file) => file.endsWith(".jsonl"))
      .some((file) =>
        readFileSync(join(root, file), "utf8")
          .split("\n")
          .some((line) => {
            if (!line.includes(eventId)) return false;
            try {
              return JSON.parse(line).event_id === eventId;
            } catch {
              return false;
            }
          }),
      );
  } catch {
    return false;
  }
}

function appendDiagnosticOnce(home, event, _partitionTimestamp) {
  const lockPath = join(
    tldrAgentDiagnosticsRoot(home),
    ".beacon-stop-diagnostic.lock",
  );
  return withFileMutex(lockPath, () => {
    if (eventExists(home, event.event_id, _partitionTimestamp)) return false;
    appendActivityEvent(event, { home, durable: true });
    return true;
  });
}

function availabilityKey(sessionId, firstFailureAt) {
  return createHash("sha256")
    .update(`${String(sessionId)}\0${firstFailureAt}`)
    .digest("hex")
    .slice(0, 24);
}

function obligationDiagnosticKey(obligationId) {
  return createHash("sha256")
    .update(String(obligationId))
    .digest("hex")
    .slice(0, 24);
}

function runAvailabilityFallback(options) {
  const { sessionId, home, afterDiagnostic } = options;
  const prior = readAvailabilityState(sessionId);
  const firstFailureAt =
    prior.firstFailureAt ?? options.now?.() ?? new Date().toISOString();
  if (prior.count < BEACON_STOP_BLOCK_CAP) {
    const count = prior.count + 1;
    writeAvailabilityState(sessionId, { count, firstFailureAt });
    return {
      action: "block",
      pending: [],
      notice: `[tldr; Beacon] Stop blocked because deferred-email obligations could not be checked safely (attempt ${count} of ${BEACON_STOP_BLOCK_CAP}). Retry Stop; tldr; will force-allow after the bounded check window.`,
    };
  }

  if (!prior.firstFailureAt) {
    writeAvailabilityState(sessionId, {
      count: BEACON_STOP_BLOCK_CAP,
      firstFailureAt,
    });
  }
  const key = availabilityKey(sessionId, firstFailureAt);
  appendDiagnosticOnce(
    home,
    {
      event_id: `beacon-stop-unavailable:${key}`,
      type: UNAVAILABLE_EVENT,
      level: "error",
      status: "unresolved",
      data: { availability_key: key, block_count: BEACON_STOP_BLOCK_CAP },
    },
    firstFailureAt,
  );
  afterDiagnostic?.();
  return {
    action: "allow",
    pending: [],
    notice:
      "[tldr; Beacon] Deferred-email obligations could not be checked; Stop was force-allowed after the bounded safety window and the availability failure was recorded for recovery.",
  };
}

function scopeFor(entry, home) {
  return {
    scope_id: entry.scopeId,
    cwd: process.cwd(),
    storage_root: join(home, "workspaces", entry.scopeId),
    legacy_storage_root: join(home, "legacy"),
  };
}

function markerOptions(options) {
  return {
    home: options.home,
    path: options.path,
    retryMs: options.retryMs,
    intervalMs: options.intervalMs,
    afterStopCountMutation: options.afterStopCountMutation
      ? () => {
          try {
            options.afterStopCountMutation();
          } catch (error) {
            error.beaconInjectedStopFault = true;
            throw error;
          }
        }
      : undefined,
  };
}

export function runBeaconStopGate(options = {}) {
  const { sessionId, home } = options;
  if (!sessionId || !home)
    return { action: "allow", pending: [], notice: null };
  if (options.preflightError) {
    return runAvailabilityFallback(options);
  }

  const listPending =
    options.listPending ?? listPendingBeaconObligationsForSession;
  const reconcileMarker = options.reconcileMarker ?? reconcileBeaconObligation;
  const applyPolicy = options.applyPolicy ?? applyBeaconStopPolicy;
  let pending;
  try {
    pending = listPending({ sessionId }, markerOptions(options));
    for (const entry of pending) {
      reconcileMarker(entry.marker, {
        home,
        path: options.path,
        sessionId,
        scope: scopeFor(entry, home),
        retryMs: options.retryMs,
        intervalMs: options.intervalMs,
      });
    }
  } catch (error) {
    if (error?.beaconInjectedStopFault) throw error;
    return runAvailabilityFallback(options);
  }
  options.afterReconciliation?.();

  let policy;
  try {
    policy = applyPolicy({ sessionId }, markerOptions(options));
  } catch (error) {
    if (error?.beaconInjectedStopFault) throw error;
    return runAvailabilityFallback(options);
  }
  if (!policy?.ok) return runAvailabilityFallback(options);
  clearBeaconStopAvailabilityErrors(sessionId);
  if (policy.action === "block") {
    return {
      action: "block",
      pending: policy.markers,
      notice: renderPendingNotice(policy.markers),
    };
  }
  if (policy.markers.length === 0) {
    return { action: "allow", pending: [], notice: null };
  }

  const entriesById = new Map(
    pending.map((entry) => [entry.marker.obligationId, entry]),
  );
  for (const marker of policy.markers) {
    const entry = entriesById.get(marker.obligationId);
    appendDiagnosticOnce(
      home,
      {
        event_id: `beacon-unresolved:${obligationDiagnosticKey(marker.obligationId)}`,
        type: UNRESOLVED_EVENT,
        level: "error",
        status: "unresolved",
        scope_id: entry?.scopeId ?? null,
        data: {
          obligation_id: safeObligationId(marker.obligationId),
          block_count: BEACON_STOP_BLOCK_CAP,
        },
      },
      marker.createdAt,
    );
    options.afterDiagnostic?.(marker);
  }
  return {
    action: "allow",
    pending: policy.markers,
    notice: renderForceAllowNotice(policy.markers),
  };
}
