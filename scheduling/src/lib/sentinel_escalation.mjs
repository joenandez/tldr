import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { guardOutbound } from "./outbound_guard.mjs";
import { recordSentinelIncident } from "./sentinel_repair.mjs";
import { helmHome } from "./store.mjs";

function nowIso() {
  return new Date().toISOString();
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function statePath(home = helmHome()) {
  return join(home, "sentinel", "escalation-state.json");
}

function writeState({ home, key, window, patch, now }) {
  const path = statePath(home);
  const state = readJson(path, { version: "1.0", escalations: {} });
  const escalations = state.escalations || {};
  const current = escalations[key] || { windows: {} };
  current.windows = {
    ...(current.windows || {}),
    [window]: {
      ...(current.windows?.[window] || {}),
      ...patch,
      updated_at: now,
    },
  };
  current.updated_at = now;
  escalations[key] = current;
  writeJson(path, { version: "1.0", updated_at: now, escalations });
  return { path, state: current.windows[window] };
}

function existingSuppression(existing) {
  if (!existing) return null;
  if (["accepted", "ambiguous", "suppressed"].includes(existing.status)) {
    return existing.status === "ambiguous"
      ? "ambiguous_send_recorded"
      : "escalation_rate_limited";
  }
  return null;
}

export async function escalateSentinelIncident({
  home = helmHome(),
  key,
  subject,
  body,
  readiness = {},
  send,
  window = "default",
  now = nowIso,
} = {}) {
  if (!key) throw new Error("escalateSentinelIncident requires key");
  if (!subject) throw new Error("escalateSentinelIncident requires subject");
  const ts = now();
  const localIncident = recordSentinelIncident({
    home,
    kind: "sentinel_escalation_attempt",
    decision: { key, window },
    readiness,
    now: () => ts,
  });

  if (readiness.desired_state?.lockout_active) {
    const state = writeState({
      home,
      key,
      window,
      now: ts,
      patch: {
        status: "suppressed",
        reason: "controlled_lockout",
        local_incident_path: localIncident.path,
      },
    });
    return {
      ok: true,
      suppressed: true,
      reason: "controlled_lockout",
      local_incident: localIncident,
      escalation_state: state,
    };
  }

  const existing = readJson(statePath(home), { escalations: {} }).escalations?.[
    key
  ]?.windows?.[window];
  const duplicateReason = existingSuppression(existing);
  if (duplicateReason) {
    return {
      ok: true,
      suppressed: true,
      reason: duplicateReason,
      local_incident: localIncident,
      prior_state: existing,
    };
  }

  const guard = await guardOutbound({
    route: "sentinel.escalation",
    channel: "local",
    sideEffectKind: "incident_record",
    data: { incident_key: key },
  });
  if (guard.suppressed) {
    const state = writeState({
      home,
      key,
      window,
      now: ts,
      patch: {
        status: "suppressed",
        reason: guard.reason,
        local_incident_path: localIncident.path,
      },
    });
    return {
      ok: true,
      suppressed: true,
      reason: guard.reason,
      outbound_guard: guard,
      local_incident: localIncident,
      escalation_state: state,
    };
  }

  try {
    const sent = await send({ subject, body });
    if (sent?.suppressed === true) {
      const reason = sent.reason || "local_only_suppressed";
      const state = writeState({
        home,
        key,
        window,
        now: ts,
        patch: {
          status: "suppressed",
          reason,
          local_incident_path: localIncident.path,
        },
      });
      return {
        ok: true,
        suppressed: true,
        reason,
        sent,
        outbound_guard: guard,
        local_incident: localIncident,
        escalation_state: state,
      };
    }
    const state = writeState({
      home,
      key,
      window,
      now: ts,
      patch: {
        status: "accepted",
        reason: "sent",
        message_id: sent?.message_id || sent?.messageId || null,
        thread_id: sent?.thread_id || sent?.threadId || null,
        local_incident_path: localIncident.path,
      },
    });
    return {
      ok: true,
      suppressed: false,
      reason: "sent",
      sent,
      outbound_guard: guard,
      local_incident: localIncident,
      escalation_state: state,
    };
  } catch (err) {
    const ambiguous = err?.ambiguous === true;
    const state = writeState({
      home,
      key,
      window,
      now: ts,
      patch: {
        status: ambiguous ? "ambiguous" : "failure",
        reason: err?.code || err?.message || "send_failed",
        local_incident_path: localIncident.path,
      },
    });
    return {
      ok: ambiguous,
      suppressed: ambiguous,
      reason: ambiguous ? "ambiguous_send_recorded" : "send_failed",
      error: err?.message || String(err),
      outbound_guard: guard,
      local_incident: localIncident,
      escalation_state: state,
    };
  }
}
