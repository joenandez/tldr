// Mirrors the macOS broker's inbound rejections: automationFlags and
// providerEventType in AegisEnrollmentProvider.swift, authorize_message in
// native/aegis-broker/src/inbound.rs. A rejected message never reaches `messages`.

const FORWARD_HEADERS = [
  "forwarded",
  "resent-from",
  "x-forwarded-for",
  "x-original-from",
];
const BAD_LABELS = new Set([
  "spam",
  "blocked",
  "bounced",
  "complained",
  "complaint",
  "rejected",
]);
const BAD_EVENTS = new Set([
  "message.received.spam",
  "message.received.blocked",
  "message.bounced",
  "message.complained",
  "message.rejected",
]);

function normalizedHeaders(message) {
  const headers = {};
  const raw = message?.headers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return headers;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string"))
      headers[key.toLowerCase()] = value.join(", ");
  }
  return headers;
}

const clean = (value) => (typeof value === "string" ? value.trim() : "");

export function isRejectedInbound(message) {
  const h = normalizedHeaders(message);
  const forwarded = FORWARD_HEADERS.some((name) => h[name] !== undefined);
  const autoSubmitted = h["auto-submitted"]?.trim().toLowerCase();
  const contentType = (h["content-type"] ?? "").toLowerCase();
  const automated =
    (autoSubmitted !== undefined && autoSubmitted !== "no") ||
    clean(h["list-id"]) !== "" ||
    ["bulk", "junk", "list"].includes(clean(h.precedence).toLowerCase()) ||
    h["x-failed-recipients"] !== undefined ||
    (contentType.includes("multipart/report") &&
      contentType.includes("delivery-status"));
  const labels = Array.isArray(message?.labels) ? message.labels : [];
  const badLabel = labels.some((l) => BAD_LABELS.has(clean(l).toLowerCase()));
  const event = [message?.event, message?.event_type, message?.eventType].find(
    (v) => typeof v === "string" && v !== "",
  );
  return forwarded || automated || badLabel || BAD_EVENTS.has(event);
}

// https, or http to a loopback host, so the key never rides plain http to a remote.
export function validAgentmailRoot(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  const host = url.hostname;
  return (
    url.protocol === "http:" &&
    (host === "localhost" ||
      host === "[::1]" ||
      /^127(\.\d{1,3}){3}$/.test(host))
  );
}
