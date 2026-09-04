import { expectedPreflightArgs } from "./tightbeam_channel_runtime.mjs";
import {
  lookupProviderMap,
  lookupProviderReplyBinding,
  recordBoundProviderAcceptance,
  recordInboundProviderAcceptance as persistInboundProviderAcceptance,
  recordProviderMap,
  recordProviderReplyBinding,
} from "./tightbeam_email_provider_map.mjs";

const REPLY_BINDING_CAPABILITY = "channels.reply-binding.v1";
const LISTENER_CAPABILITY = "listener.v1";

export function createTightbeamEmailDeliveryChannel({
  execute,
  readIdentity,
  home,
  commandFailure,
  authority,
  principalRef,
  endpointSession,
} = {}) {
  let capabilities;

  async function deliveryCapabilities() {
    if (capabilities) return capabilities;
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

  async function claimEmailDelivery() {
    const emailIdentity = await registeredEmailIdentity();
    if (!emailIdentity)
      return Object.freeze({ ok: false, code: "not_configured" });
    const routes = await execute({
      admin: false,
      credentials: emailIdentity.identity,
      args: ["channel", "route", "list"],
    });
    const route = routes?.result?.routes?.find(
      (candidate) => candidate?.selector === "email",
    );
    if (commandFailure(routes) || !route) {
      return Object.freeze({ ok: false, code: "route_unavailable" });
    }
    const capability = await deliveryCapabilities();
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
        ...(capability.replyBinding ? ["--accept-reply-binding"] : []),
      ],
    });
    return commandFailure(claimed)
      ? Object.freeze({ ok: false, code: "claim_unavailable" })
      : Object.freeze({ ok: true, claim: claimed.result });
  }

  async function completeEmailDelivery({
    delivery_id: deliveryId,
    token,
    outcome,
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
      ],
    });
    return commandFailure(completed)
      ? Object.freeze({ ok: false, code: "complete_failed" })
      : Object.freeze({ ok: true });
  }

  async function recordProviderAcceptance({ delivery, provider }) {
    if (typeof delivery?.reply_binding === "string") {
      await recordBoundProviderAcceptance(home, delivery, provider);
      return;
    }
    const identity = await readIdentity();
    if (!identity) throw new Error("Tightbeam email identity is unavailable");
    const routes = await execute({
      admin: false,
      credentials: identity,
      args: ["channel", "route", "list"],
    });
    const route = routes?.result?.routes?.find(
      (candidate) => candidate?.selector === "email",
    );
    if (commandFailure(routes) || !route)
      throw new Error("Tightbeam email route is unavailable");
    await recordProviderMap(home, {
      delivery_id: delivery.delivery_id,
      message_id: delivery.message_id,
      conversation_id: delivery.message.conversation_id,
      route_id: route.route_id,
      origin_endpoint_id:
        typeof delivery.message?.sender_endpoint_id === "string"
          ? delivery.message.sender_endpoint_id
          : null,
      origin_session_id:
        typeof delivery.message?.sender_session_id === "string"
          ? delivery.message.sender_session_id
          : null,
      external_id: provider.external_id,
      external_thread_id: provider.external_thread_id,
    });
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
  return Object.freeze({
    claimEmailDelivery,
    completeEmailDelivery,
    recordReplyBinding,
    recordProviderAcceptance,
    recordInboundProviderAcceptance,
    findProviderAcceptanceByDelivery,
    findThreadBinding,
    findProviderThreadByConversation,
  });
}
