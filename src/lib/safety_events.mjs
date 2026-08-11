import { appendActivityEvent } from "./tldr_agent_diagnostics.mjs";

const SECRET_KEY_PATTERN =
  /(authorization|body|content|cookie|hmac|payload|secret|token|url|webhook)/i;

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? "[redacted]"
      : sanitizeValue(child);
  }
  return out;
}

export function redactSafetyMetadata(metadata = {}) {
  return sanitizeValue(metadata) || {};
}

export function emitSafetyEvent({
  type,
  phase = "phase-0.5",
  subsystem,
  status,
  errorClass = null,
  daemonInstanceId = null,
  scope = null,
  level = status === "success" || status === "allowed" ? "info" : "warn",
  metadata = {},
  eventHome,
} = {}) {
  const ts = new Date().toISOString();
  const redactedMetadata = redactSafetyMetadata(metadata);
  const event = appendActivityEvent(
    {
      type,
      ts,
      kind: "safety",
      level,
      status,
      phase,
      subsystem,
      error_class: errorClass,
      daemon_instance_id: daemonInstanceId || undefined,
      scope_id: scope?.scope_id || undefined,
      cwd: scope?.cwd || undefined,
      data: redactedMetadata,
      metadata: redactedMetadata,
    },
    { home: eventHome },
  );
  event.ts = event.ts || event.timestamp;
  return event;
}
