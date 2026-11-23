// The provider's arrival time for an inbound user message, persisted as message metadata
// `provider_metadata.provider_received_at` (ISO-8601). The busy line counts from it, clamped
// server-side to [created_at - 60 s, created_at], so a wrong value costs at most 60 s.
export const PROVIDER_RECEIVED_AT_FLAG = "--provider-received-at";

// ISO-8601 string for a parseable time, else null.
export function providerReceivedAtIso(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// A Slack message ts ("1731859200.123456", epoch seconds) as ISO-8601, else null.
export function slackTsToIso(ts) {
  return typeof ts === "string" && /^\d{1,12}(\.\d+)?$/.test(ts)
    ? new Date(Number(ts) * 1000).toISOString()
    : null;
}

// `{ provider_received_at }` for a provider_metadata object, or nothing.
export function receivedAtMetadata(value) {
  const iso = providerReceivedAtIso(value);
  return iso ? { provider_received_at: iso } : {};
}
