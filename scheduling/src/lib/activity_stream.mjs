import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  appendJsonLine,
  canonicalEventsPathFor,
  daemonHealthStatePath,
  ensureGlobalRuntimeDirs,
  eventsRoot,
  readJsonIfExists,
  writeJsonAtomic,
} from "./store.mjs";
import { appendPublicEvent } from "./read_store.mjs";
import {
  publicEventFromActivity,
  publicHistoryEventFromActivity,
} from "./public_contract.mjs";
export { renderActivityMessage } from "./activity_messages.mjs";
import { renderActivityMessage } from "./activity_messages.mjs";

function nowIso() {
  return new Date().toISOString();
}

function stringifyError(error) {
  if (error === null || error === undefined) return null;
  return String(error);
}

function canonicalDefaults() {
  return {
    event_id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    timestamp: nowIso(),
    scope_id: null,
    scope_hash: null,
    cwd: null,
    job_id: null,
    run_id: null,
    kind: null,
    type: null,
    level: "info",
    status: null,
    reason: null,
    scheduled_at: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    pid: null,
    error: null,
    source: null,
    data: {},
    event_type: null,
    message: null,
  };
}

export const ACTIVITY_EVENT_TAXONOMY = Object.freeze({
  comms_inbound_webhook_success: {
    description: "Webhook delivery normalized successfully.",
    data: Object.freeze({
      external_message_id: "string|null",
      substrate_message_id: "string|null",
      thread_id: "string|null",
      latency_ms: "number",
    }),
  },
  comms_inbound_webhook_hmac_rejected: {
    description:
      "Webhook delivery rejected because the HMAC signature did not match.",
    data: Object.freeze({
      request_id: "string|null",
      remote_addr: "string|null",
    }),
  },
  comms_inbound_webhook_malformed: {
    description:
      "Webhook delivery rejected because the payload could not be parsed.",
    data: Object.freeze({
      request_id: "string|null",
      reason: "string",
    }),
  },
  comms_inbound_webhook_normalize_failed: {
    description:
      "Webhook delivery failed while normalizing into the canonical inbound row.",
    data: Object.freeze({
      request_id: "string|null",
      error: "string",
    }),
  },
  comms_inbound_webhook_bind_failed: {
    description: "Webhook listener failed to bind its configured local port.",
    data: Object.freeze({
      port: "number",
      reason: "string",
    }),
  },
});

function inferKind(type) {
  if (!type) return null;
  if (type.startsWith("job_run_")) return "run";
  if (type === "job_catchup_overflow") return "run";
  if (type === "job_auto_paused") return "run";
  if (type === "job_due_detected") return "event";
  if (type.startsWith("job_")) return "job";
  if (type.startsWith("dispatch_")) return "dispatch";
  if (type.startsWith("notification_")) return "notification";
  if (type.startsWith("runtime_health_")) return "health";
  if (type.startsWith("scope_")) return "scope";
  if (type === "workspace_down") return "workspace";
  if (type.startsWith("service_")) return "service";
  if (type === "prune_completed") return "prune";
  if (type.startsWith("heartbeat_")) return "heartbeat";
  if (type.startsWith("daemon_")) return "daemon";
  if (type.startsWith("comms_inbound_webhook_")) return "webhook";
  return "event";
}

function normalizedData(partial) {
  const data = { ...(partial.data || {}) };
  if (partial.daemon_instance_id !== undefined)
    data.daemon_instance_id = partial.daemon_instance_id;
  if (partial.metadata !== undefined) data.metadata = partial.metadata;
  if (partial.log_paths !== undefined) data.log_paths = partial.log_paths;
  if (partial.notification_results !== undefined)
    data.notification_results = partial.notification_results;
  if (partial.command !== undefined) data.command = partial.command;
  if (partial.args !== undefined) data.args = partial.args;
  if (partial.file_path !== undefined) data.file_path = partial.file_path;
  return data;
}

export function appendActivityEvent(partial) {
  ensureGlobalRuntimeDirs();
  const event = {
    ...canonicalDefaults(),
    ...partial,
    type: partial.type || partial.event_type || null,
    kind: partial.kind || inferKind(partial.type || partial.event_type || null),
    error: stringifyError(partial.error),
    data: normalizedData(partial),
  };
  event.event_type = event.type;
  event.message = partial.message || renderActivityMessage(event);
  appendJsonLine(canonicalEventsPathFor(event.timestamp), event);
  appendPublicEvent(publicEventFromActivity(event));
  return event;
}

export function loadActivityEvents(limit = 2000) {
  ensureGlobalRuntimeDirs();
  let files = [];
  try {
    files = readdirSync(eventsRoot());
  } catch {
    files = [];
  }
  const out = [];
  const dayFiles = files.filter((file) => file.endsWith(".jsonl")).sort();
  for (const file of dayFiles) {
    const path = join(eventsRoot(), file);
    const raw = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (const line of raw) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
  }
  return out.slice(-limit);
}

export function loadActivityEventsForScope(scopeId, limit = 10000) {
  ensureGlobalRuntimeDirs();
  let files = [];
  try {
    files = readdirSync(eventsRoot());
  } catch {
    files = [];
  }
  const out = [];
  const dayFiles = files.filter((file) => file.endsWith(".jsonl")).sort();
  for (const file of dayFiles) {
    const path = join(eventsRoot(), file);
    const raw = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (const line of raw) {
      if (!line.includes(scopeId)) continue; // fast pre-filter
      try {
        const event = JSON.parse(line);
        if (event.scope_id === scopeId) out.push(event);
      } catch {}
    }
  }
  return out.slice(-limit);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function eventTimestamp(event) {
  return event?.timestamp || event?.created_at || null;
}

function parseJsonLine(line) {
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function collectMatchingEventsFromTail(path, type, remaining, max = Infinity) {
  const out = [];
  if (remaining <= 0) return out;
  let fd = null;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const chunkSize = 16 * 1024;
    let position = size;
    let carry = "";
    let scanned = 0;
    while (position > 0 && out.length < remaining && scanned < max) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      readSync(fd, buffer, 0, length, position);
      scanned += length;
      const text = buffer.toString("utf8") + carry;
      const lines = text.split("\n");
      carry = lines.shift() || "";
      for (let i = lines.length - 1; i >= 0 && out.length < remaining; i -= 1) {
        const event = parseJsonLine(lines[i]);
        if (event?.event_type === type || event?.type === type) out.push(event);
      }
    }
    if (out.length < remaining && carry) {
      const event = parseJsonLine(carry);
      if (event?.event_type === type || event?.type === type) out.push(event);
    }
  } catch {
    return out;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

export function tailEventsByType(
  type,
  { limit = 1, withinDays = 1, now = new Date(), maxBytes = null } = {},
) {
  const max = Math.max(0, Number(limit) || 0);
  const days = Math.max(0, Number(withinDays) || 0);
  if (!type || max === 0 || days === 0) return [];
  const root = eventsRoot();
  if (!existsSync(root)) return [];

  let files = [];
  try {
    files = readdirSync(root)
      .filter((file) => file.endsWith(".jsonl"))
      .filter((file) => {
        const day = file.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
        const cutoff = new Date(now);
        cutoff.setUTCDate(cutoff.getUTCDate() - days);
        return day >= dateKey(cutoff) && day <= dateKey(now);
      })
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const out = [];
  const parsedMaxBytes = Number(maxBytes);
  const perFileMaxBytes =
    Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
      ? parsedMaxBytes
      : Infinity;
  for (const file of files) {
    const path = join(root, file);
    const matches = collectMatchingEventsFromTail(
      path,
      type,
      max - out.length,
      perFileMaxBytes,
    );
    out.push(...matches);
    if (out.length >= max) break;
  }
  return out
    .sort((a, b) =>
      String(eventTimestamp(b) || "").localeCompare(
        String(eventTimestamp(a) || ""),
      ),
    )
    .slice(0, max);
}

function loadHealthState() {
  return (
    readJsonIfExists(daemonHealthStatePath(), {
      version: "1.0",
      states: {},
    }) || { version: "1.0", states: {} }
  );
}

function saveHealthState(states) {
  ensureGlobalRuntimeDirs();
  writeJsonAtomic(daemonHealthStatePath(), { version: "1.0", states });
}

function healthEventType(nextState) {
  if (nextState === "dispatch_stale") return "runtime_health_dispatch_stale";
  if (nextState === "service_not_running")
    return "runtime_health_service_not_running";
  if (nextState === "ok") return "runtime_health_ok";
  return null;
}

export function trackHealthTransition(key, nextState, partial = {}) {
  if (!key || !nextState) return null;
  const current = loadHealthState();
  const previous = current.states[key] || null;
  current.states[key] = nextState;
  saveHealthState(current.states);

  if (nextState === "ok") {
    if (!previous || previous === "ok") return null;
  } else if (previous === nextState) {
    return null;
  }

  const type = healthEventType(nextState);
  if (!type) return null;
  return appendActivityEvent({
    ...partial,
    type,
    level: nextState === "ok" ? "info" : "error",
    status: nextState === "ok" ? "success" : "failure",
  });
}

export function projectHealthStreamState(health) {
  if (!health) return null;
  if (health.reason === "dispatch_stale") return "dispatch_stale";
  if (health.reason === "service_not_running") return "service_not_running";
  if (health.healthy) return "ok";
  return null;
}

export function filterActivityEvents(events, opts = {}) {
  const scopeId = opts.scopeId || null;
  const jobId = opts.jobId || null;
  const levels = opts.levels || new Set(["info", "error"]);
  return events.filter((event) => {
    if (levels && !levels.has(event.level)) return false;
    if (scopeId && event.scope_id !== scopeId) return false;
    if (jobId && event.job_id !== jobId) return false;
    return true;
  });
}

export function formatActivityLine(event) {
  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${time} ${event.message}`;
}

export function projectRunHistoryEvents(events, scopeId, jobId, limit = 20) {
  const projected = events
    .filter((event) => event.scope_id === scopeId && event.job_id === jobId)
    .map(publicHistoryEventFromActivity)
    .filter(Boolean)
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  return projected.slice(-limit);
}
