import { openProviderMap } from "./tightbeam_email_provider_map.mjs";

export const REPLY_PARENT_MISSING = "email_reply_parent_missing";

// The Aegis broker's reply-parent rule (AegisEnrollmentProvider.swift validateParent): a parent is
// trusted only when the owner sent it in that same thread. Owner-sent mail reaches the provider map
// only as an accepted inbound reply event, so that event is the owner proof. ac-jfv.69 (a parent the
// bound inbox itself sent to the owner) would widen the broker and this predicate together.
// The lane records the reply binding first, which creates the event table, so it always exists here.
export function trustedOwnerReplyParent(home, parent) {
  const valid =
    typeof parent?.external_id === "string" &&
    typeof parent.external_thread_id === "string";
  const db = valid ? openProviderMap(home, { readOnly: true }) : null;
  if (!db) return false;
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM provider_reply_parent_event
            WHERE provider_message_id = ? AND provider_thread_id = ?`,
        )
        .get(parent.external_id, parent.external_thread_id),
    );
  } finally {
    db.close();
  }
}

// How long an email copy waits for a sibling copy still in flight before it gives up and sends
// a fresh root: Slack lands avg 10 s, max 308 s after the email claim (7 days to 11-26).
export const SIBLING_WAIT_MS = 5 * 60 * 1000;
const IN_FLIGHT = new Set(["pending", "claimed"]);

// What the other channel copies say about this one: "carried" (one delivered), "wait" (one still
// in flight and the message is young), or "alone" (none can carry it: send a fresh root).
export function siblingVerdict(claim, now = Date.now()) {
  const siblings = Array.isArray(claim.sibling_channels)
    ? claim.sibling_channels
    : [];
  if (siblings.some((sibling) => sibling.state === "delivered"))
    return "carried";
  const age = now - Date.parse(claim.message?.created_at);
  return siblings.some((sibling) => IN_FLIGHT.has(sibling.state)) &&
    age < SIBLING_WAIT_MS
    ? "wait"
    : "alone";
}

const settled = (claim, settle, fields) =>
  settle?.ok === true
    ? { ok: false, delivery_id: claim.delivery_id, ...fields }
    : {
        ok: false,
        delivery_id: claim.delivery_id,
        error: settle?.code || "complete_failed",
        retryable: true,
      };

// Decide an email copy before the broker refuses it REPLY_PARENT_UNAUTHORIZED (ac-jfv.55).
// A trusted parent (or none): reply as before. No owner parent: skip the copy with its reason when
// another channel delivered the message, wait (release unsent, decide again) while one is still in
// flight, or send a fresh same-subject root (providerThread null), so nothing is lost.
export async function decideReplyParent(channel, claim) {
  const providerThread = await channel.findProviderThreadByConversation(
    claim.message.conversation_id,
  );
  if (
    !providerThread ||
    typeof channel.isOwnerReplyParent !== "function" ||
    (await channel.isOwnerReplyParent(providerThread))
  )
    return { providerThread };
  const verdict = siblingVerdict(claim);
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "tightbeam_email_reply_parent_missing",
      params: {
        delivery_id: claim.delivery_id,
        message_id: claim.message_id,
        sibling_channels: claim.sibling_channels ?? [],
      },
      result: { carried: "skipped", wait: "deferred", alone: "fresh_root" }[
        verdict
      ],
      status: "ok",
    })}\n`,
  );
  if (verdict === "alone") return { providerThread: null };
  const key = { delivery_id: claim.delivery_id, token: claim.token };
  const wait = verdict === "wait";
  // Wait: a plain release counts an attempt, so Tightbeam backs off (30, 60, 120 s ...): re-claims
  // at ~30, 90, 210 s, then past the wait a fresh root, using at most 4 of the 8 attempts.
  const settle = wait
    ? await channel.releaseEmailDelivery(key)
    : await channel.completeEmailDelivery({
        ...key,
        outcome: "failed",
        reason: REPLY_PARENT_MISSING,
      });
  return {
    result: settled(claim, settle, {
      error: REPLY_PARENT_MISSING,
      ...(wait ? { released: true, deferred: true } : { skipped: true }),
    }),
  };
}
