// PRFAQ-0 Phase 1 — substrate event pub/sub (Tasks 1.6).
// In-process pub/sub for kernel-side observers + a SSE bridge stub callable
// from an optional in-process consumer. v1 is purely
// in-process; durable retention + replay backlog land in Phase 6 alongside
// the UI Primitive API.
//
// Logging (Plan §6.5): SSE event publication is INFO once per
// subscriber-count change, not per event. No per-event hot-path logs.

import { randomBytes } from "node:crypto";
import { appendActivityEvent } from "../tldr_agent_diagnostics.mjs";

const EVENT_KIND = Object.freeze({
  MESSAGE_CREATED: "message.created",
  MESSAGE_DELIVERED: "message.delivered",
  MESSAGE_FAILED: "message.failed",
  THREAD_TOUCHED: "thread.touched",
  SCHEDULE_FIRED: "schedule.fired",
});

const subscribers = new Map();
let bridge = null;
let lastSubscriberCount = 0;

function makeEventId() {
  return `evt_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

export function publish(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new TypeError("events.publish: envelope must be an object");
  }
  const event = {
    event_id: envelope.event_id || makeEventId(),
    kind: envelope.kind,
    occurred_at: envelope.occurred_at || new Date().toISOString(),
    workspace_id: envelope.workspace_id,
    data: envelope.data || {},
  };
  // In-process fan-out — no logging in the per-event loop (Plan §6.5).
  const bucket = subscribers.get(event.workspace_id);
  if (bucket) {
    for (const sub of bucket) {
      if (
        !sub.kinds ||
        sub.kinds.length === 0 ||
        sub.kinds.includes(event.kind)
      ) {
        try {
          sub.cb(event);
        } catch {
          /* subscriber faults must not break the publisher */
        }
      }
    }
  }
  if (bridge) {
    try {
      bridge(event);
    } catch {
      /* bridge faults must not break the publisher */
    }
  }
  return event;
}

export function subscribe(workspaceId, kinds, cb) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new TypeError("events.subscribe: workspaceId required");
  }
  if (typeof cb !== "function") {
    throw new TypeError("events.subscribe: cb must be a function");
  }
  const bucket = subscribers.get(workspaceId) || new Set();
  const entry = { kinds: Array.isArray(kinds) ? kinds.slice() : null, cb };
  bucket.add(entry);
  subscribers.set(workspaceId, bucket);
  reportSubscriberCount();
  return () => {
    bucket.delete(entry);
    if (bucket.size === 0) subscribers.delete(workspaceId);
    reportSubscriberCount();
  };
}

function reportSubscriberCount() {
  let count = 0;
  for (const bucket of subscribers.values()) count += bucket.size;
  if (count === lastSubscriberCount) return;
  lastSubscriberCount = count;
  // Boundary log: subscriber-count change only (Plan §6.5).
  try {
    appendActivityEvent({
      type: "substrate_subscribe_events_subscriber_count",
      level: "info",
      data: { subscribers: count },
    });
  } catch {
    /* activity stream failure must not break subscribe path */
  }
}

// Bridge stub callable by an optional in-process consumer.
export function setBridge(fn) {
  bridge = typeof fn === "function" ? fn : null;
}

export function clearBridge() {
  bridge = null;
}

export function retentionDays() {
  const raw = process.env.HELM_SUBSTRATE_EVENT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 7;
  return Math.floor(parsed);
}

// Test-only escape hatch — clears all in-process subscribers + bridge.
// Production code must NOT call this; tests use it to reset between cases.
export function _resetForTests() {
  subscribers.clear();
  bridge = null;
  lastSubscriberCount = 0;
}

export { EVENT_KIND };
