import { randomBytes } from "node:crypto";
import {
  mutateTldrAgentInbound,
  readTldrAgentInbound,
} from "./tldr_agent_inbound_lifecycle.mjs";

const DEFAULT_LEASE_MS = 60_000;

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? null : parsed;
}

export function claimTldrAgentInbound({
  scope,
  messageId,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  token = randomBytes(16).toString("hex"),
} = {}) {
  if (!scope || !messageId) {
    return { ok: false, claimed: false, error: "claim_identity_required" };
  }
  const nowMs = now.getTime();
  const claimedAt = now.toISOString();
  const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
  let claimed = false;
  let blockingClaim = null;
  const next = mutateTldrAgentInbound({
    scope,
    messageId,
    now,
    mutate(prior) {
      const existing = prior.lease || null;
      const existingExpiry = timestamp(existing?.lease_expires_at);
      if (
        existing?.state === "claimed" &&
        existing?.token &&
        existingExpiry !== null &&
        existingExpiry > nowMs
      ) {
        blockingClaim = existing;
        return {};
      }
      claimed = true;
      return {
        state: "claimed",
        lease: {
          version: 1,
          state: "claimed",
          token,
          claimed_at: claimedAt,
          lease_expires_at: leaseExpiresAt,
          attempt_count: (Number(existing?.attempt_count) || 0) + 1,
          released_at: null,
          outcome: null,
        },
      };
    },
  });
  if (!claimed) {
    return {
      ok: true,
      claimed: false,
      blocking_lease_expires_at: blockingClaim?.lease_expires_at || null,
    };
  }
  const persisted = readTldrAgentInbound(scope, messageId);
  if (next?.lease?.token !== token || persisted?.lease?.token !== token) {
    return {
      ok: false,
      claimed: false,
      error: "dispatch_claim_persist_failed",
    };
  }
  return { ok: true, claimed: true, token };
}

export function releaseTldrAgentInbound({
  scope,
  messageId,
  token,
  outcome,
  now = new Date(),
} = {}) {
  if (!scope || !messageId || !token) {
    return { ok: false, released: false, error: "claim_identity_required" };
  }
  let released = false;
  mutateTldrAgentInbound({
    scope,
    messageId,
    now,
    mutate(prior) {
      const existing = prior.lease || null;
      if (existing?.state !== "claimed" || existing?.token !== token) {
        return {};
      }
      released = true;
      return {
        lease: {
          ...existing,
          state: "released",
          token: null,
          lease_expires_at: null,
          released_at: now.toISOString(),
          outcome: outcome || "unknown",
        },
      };
    },
  });
  const persisted = readTldrAgentInbound(scope, messageId);
  if (
    !released ||
    persisted?.lease?.state !== "released" ||
    persisted?.lease?.token
  ) {
    return {
      ok: false,
      released: false,
      error: "dispatch_claim_release_failed",
    };
  }
  return { ok: true, released: true };
}

export const TLDR_AGENT_INBOUND_CLAIM_POLICY = Object.freeze({
  lease_ms: DEFAULT_LEASE_MS,
});
