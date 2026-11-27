import { expectedPreflightArgs } from "./tightbeam_channel_runtime.mjs";
import {
  echoesTier,
  holdTierEcho,
  tierEchoBackoffPath,
  tierEchoHeld,
  tierEchoWarning,
} from "./tier_echo.mjs";
import {
  lookupProviderMap,
  lookupProviderReplyBinding,
  recordBoundProviderAcceptance,
  recordInboundProviderAcceptance as persistInboundProviderAcceptance,
  recordProviderReplyBinding,
} from "./tightbeam_email_provider_map.mjs";
import { trustedOwnerReplyParent } from "./tightbeam_email_reply_parent.mjs";

const REPLY_BINDING_CAPABILITY = "channels.reply-binding.v1";
const LISTENER_CAPABILITY = "listener.v1";
// The delivery.release outcome tightbeam excludes from attempt counting (as in the Slack settle).
const UNSENT_OUTCOME = "aborted_unsent";
const TIGHTBEAM_CODE = /^[a-z][a-z_]{0,63}$/u;

// Item 49: an idle auto-select claim returns `claim_held` and takes no lease
// (item 41), so only that refusal means the queue is empty. Any other
// failure (permission_denied, a killed or crashed CLI, a missing launcher) is
// a real claim failure the poll must report instead of reading as idle.
export function claimFailure(claimed, latencyMs = null) {
  const reported = claimed?.error?.tightbeam_code ?? claimed?.error?.code;
  const tightbeamCode = TIGHTBEAM_CODE.test(reported ?? "") ? reported : null;
  if (tightbeamCode === "claim_held")
    return Object.freeze({ ok: false, code: "claim_unavailable" });
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "tightbeam_email_claim_failed",
      params: { tightbeam_code: tightbeamCode },
      status: "claim_failed",
      latency_ms: latencyMs,
    })}\n`,
  );
  return Object.freeze({
    ok: false,
    code: "claim_failed",
    tightbeam_code: tightbeamCode,
  });
}

// The claim did not echo the lane's tier (tier_echo.mjs): release it (nothing was sent), hold this
// tier's claims for one backoff period, and warn once. The release is `aborted_unsent`: a plain
// release costs an attempt, and 8 refusals would fail a row that never went out (review r6). It
// reads as an idle claim to the drain; a release that fails is reported, the claim then stays
// leased until it expires.
async function refuseUnechoed({ home, tier, result, release }) {
  const released = await release({
    delivery_id: result.delivery_id,
    token: result.token,
    outcome: UNSENT_OUTCOME,
  });
  holdTierEcho(tierEchoBackoffPath(home, tier));
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...tierEchoWarning(tier, result) })}\n`,
  );
  return released.ok === true
    ? Object.freeze({ ok: false, code: "claim_unavailable" })
    : released;
}

export function createTightbeamEmailDeliveryChannel({
  execute,
  readIdentity,
  home,
  commandFailure,
  authority,
  principalRef,
  endpointSession,
  reportedCapabilities = () => null,
} = {}) {
  let capabilities;

  async function deliveryCapabilities() {
    if (capabilities) return capabilities;
    // A compatible base preflight already lists every daemon capability; a
    // poll tick has a fixed budget, so reuse it instead of two more launches.
    const reported = reportedCapabilities();
    if (Array.isArray(reported)) {
      capabilities = Object.freeze({
        replyBinding: reported.includes(REPLY_BINDING_CAPABILITY),
        listener: reported.includes(LISTENER_CAPABILITY),
      });
      return capabilities;
    }
    const supported = async (capability) => {
      const result = await execute({
        admin: true,
        credentials: null,
        args: [...expectedPreflightArgs(), "--require-capability", capability],
      });
      return result?.ok === true && result.result?.compatible === true;
    };
    capabilities = Object.freeze({
      replyBinding: await supported(REPLY_BINDING_CAPABILITY),
      listener: await supported(LISTENER_CAPABILITY),
    });
    return capabilities;
  }

  async function registeredEmailIdentity() {
    const identity = await readIdentity();
    if (!identity) return null;
    const principal = await execute({
      admin: false,
      credentials: identity,
      args: [
        "principal",
        "register",
        "--authority",
        authority,
        "--external-ref",
        principalRef,
        "--display-name",
        "Owner",
      ],
    });
    if (
      commandFailure(principal) ||
      typeof principal.result?.principal_id !== "string"
    )
      return null;
    const endpoint = await execute({
      admin: false,
      credentials: identity,
      args: [
        "endpoint",
        "register",
        "--authority",
        authority,
        "--principal",
        principal.result.principal_id,
        "--runtime",
        "reference",
        "--session",
        endpointSession,
        "--reference",
        authority,
      ],
    });
    if (
      commandFailure(endpoint) ||
      typeof endpoint.result?.endpoint_id !== "string"
    )
      return null;
    return { identity, endpoint: endpoint.result };
  }

  // The identity and route one claim needs. Kept after a success, so every later claim of the
  // process runs `delivery claim` alone (the notice lane's warm child makes one per wake).
  let resolved = null;
  async function resolveEmailRoute() {
    if (!resolved) {
      const emailIdentity = await registeredEmailIdentity();
      const routes = emailIdentity
        ? await execute({
            admin: false,
            credentials: emailIdentity.identity,
            args: ["channel", "route", "list"],
          })
        : null;
      const route = routes?.result?.routes?.find(
        (candidate) => candidate?.selector === "email",
      );
      if (!emailIdentity || commandFailure(routes) || !route)
        return Object.freeze({
          ok: false,
          code: emailIdentity ? "route_unavailable" : "not_configured",
        });
      resolved = { emailIdentity, route };
    }
    return resolved;
  }

  // tier (ac-jfv.74.1): 0 busy and resume_failed notices, 1 answers to the user, 2 the rest, each
  // its own lane; claim_held when its tier has none. No tier: all tiers.
  async function claimEmailDelivery({ tier } = {}) {
    if (tier !== undefined && tierEchoHeld(tierEchoBackoffPath(home, tier)))
      return Object.freeze({ ok: false, code: "claim_unavailable" });
    const capability = await deliveryCapabilities();
    if (!capability.replyBinding || !capability.listener) {
      return Object.freeze({
        ok: false,
        code: "delivery_capability_unavailable",
      });
    }
    const target = await resolveEmailRoute();
    if (target.ok === false) return target;
    const { emailIdentity, route } = target;
    const startedAt = Date.now();
    const claimed = await execute({
      admin: false,
      credentials: emailIdentity.identity,
      args: [
        "delivery",
        "claim",
        "--endpoint",
        emailIdentity.endpoint.endpoint_id,
        "--channel-route",
        route.route_id,
        "--accept-reply-binding",
        ...(tier === undefined ? [] : ["--tier", String(tier)]),
      ],
    });
    if (!commandFailure(claimed))
      return echoesTier(tier, claimed.result)
        ? Object.freeze({ ok: true, claim: claimed.result })
        : refuseUnechoed({
            home,
            tier,
            result: claimed.result,
            release: releaseEmailDelivery,
          });
    const failure = claimFailure(claimed, Date.now() - startedAt);
    // Anything but an idle claim may mean a stale identity or route: resolve again next time.
    if (failure.code !== "claim_unavailable") resolved = null;
    return failure;
  }

  async function completeEmailDelivery({
    delivery_id: deliveryId,
    token,
    outcome,
    reason,
  }) {
    const identity = await readIdentity();
    if (!identity) return Object.freeze({ ok: false, code: "not_configured" });
    const completed = await execute({
      admin: false,
      credentials: identity,
      args: [
        "delivery",
        "complete",
        deliveryId,
        "--token",
        token,
        "--outcome",
        outcome,
        ...(reason ? ["--reason", reason] : []),
      ],
    });
    return commandFailure(completed)
      ? Object.freeze({ ok: false, code: "complete_failed" })
      : Object.freeze({ ok: true });
  }

  async function releaseEmailDelivery({
    delivery_id: deliveryId,
    token,
    outcome,
  }) {
    const identity = await readIdentity();
    if (!identity) return Object.freeze({ ok: false, code: "not_configured" });
    const released = await execute({
      admin: false,
      credentials: identity,
      args: [
        "delivery",
        "release",
        deliveryId,
        "--token",
        token,
        ...(outcome ? ["--outcome", outcome] : []),
      ],
    });
    return commandFailure(released)
      ? Object.freeze({ ok: false, code: "release_failed" })
      : Object.freeze({ ok: true });
  }

  async function recordProviderAcceptance({ delivery, provider }) {
    if (
      typeof delivery?.reply_binding !== "string" ||
      delivery.reply_binding.length === 0
    ) {
      throw new TypeError(
        "Tightbeam claimed delivery has no opaque reply binding",
      );
    }
    await recordBoundProviderAcceptance(home, delivery, provider);
  }

  async function recordReplyBinding({ delivery }) {
    if (
      typeof delivery?.delivery_id !== "string" ||
      typeof delivery.reply_binding !== "string" ||
      delivery.reply_binding.length === 0
    ) {
      throw new TypeError(
        "Tightbeam claimed delivery has no opaque reply binding",
      );
    }
    await recordProviderReplyBinding(home, delivery);
  }

  async function recordInboundProviderAcceptance({
    binding,
    provider_message_id: providerMessageId,
    provider_thread_id: providerThreadId,
    tightbeam_message_id: tightbeamMessageId,
    tightbeam_conversation_id: tightbeamConversationId,
  }) {
    if (
      typeof binding?.reply_binding !== "string" ||
      binding.reply_binding.length === 0 ||
      typeof providerMessageId !== "string" ||
      providerMessageId.length === 0 ||
      (providerThreadId !== undefined &&
        (typeof providerThreadId !== "string" ||
          providerThreadId.length === 0)) ||
      typeof tightbeamMessageId !== "string" ||
      tightbeamMessageId.length === 0
    ) {
      throw new TypeError("Accepted inbound provider identity is incomplete");
    }
    await persistInboundProviderAcceptance(home, {
      reply_binding: binding.reply_binding,
      provider_message_id: providerMessageId,
      provider_thread_id: providerThreadId,
      tightbeam_message_id: tightbeamMessageId,
      tightbeam_conversation_id: tightbeamConversationId,
    });
  }

  async function findThreadBinding(externalThreadId) {
    const bound = lookupProviderReplyBinding(
      home,
      "external_thread_id",
      externalThreadId,
    );
    return bound ? { reply_binding: bound.reply_binding } : null;
  }
  async function findProviderAcceptanceByDelivery(deliveryId) {
    const bound = lookupProviderReplyBinding(home, "delivery_id", deliveryId);
    if (
      typeof bound?.external_id === "string" &&
      typeof bound.external_thread_id === "string"
    ) {
      return {
        external_id: bound.external_id,
        external_thread_id: bound.external_thread_id,
      };
    }
    const record = lookupProviderMap(home, "delivery_id", deliveryId);
    return record
      ? {
          external_id: record.external_id,
          external_thread_id: record.external_thread_id,
        }
      : null;
  }
  async function findProviderThreadByConversation(conversationId) {
    const bound = lookupProviderReplyBinding(
      home,
      "conversation_id",
      conversationId,
    );
    if (
      typeof bound?.external_id === "string" &&
      typeof bound.external_thread_id === "string"
    ) {
      return {
        external_id:
          bound.current_reply_parent_external_id || bound.external_id,
        external_thread_id: bound.external_thread_id,
      };
    }
    const record = lookupProviderMap(home, "conversation_id", conversationId);
    return record
      ? {
          external_id: record.external_id,
          external_thread_id: record.external_thread_id,
        }
      : null;
  }
  // The broker's reply-parent rule, read from this map (ac-jfv.55).
  async function isOwnerReplyParent(parent) {
    return trustedOwnerReplyParent(home, parent);
  }
  return Object.freeze({
    claimEmailDelivery,
    completeEmailDelivery,
    releaseEmailDelivery,
    recordReplyBinding,
    recordProviderAcceptance,
    recordInboundProviderAcceptance,
    findProviderAcceptanceByDelivery,
    findThreadBinding,
    findProviderThreadByConversation,
    isOwnerReplyParent,
  });
}
