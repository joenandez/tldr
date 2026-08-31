function outboundKey(deliveryId) {
  return `tldr-tightbeam-delivery-${deliveryId}`;
}

function canonicalEmailRow(claim, providerThread) {
  const message = claim.message;
  const metadata = { ...(message.metadata || {}) };
  const subject =
    typeof metadata.subject === "string" ? metadata.subject : null;
  delete metadata.subject;
  return {
    message_id: claim.message_id,
    thread_id: message.conversation_id,
    kind: providerThread ? "reply" : "message",
    subject,
    body: message.body,
    metadata,
    idempotency_key: outboundKey(claim.delivery_id),
  };
}

function validClaim(claim) {
  return (
    claim &&
    typeof claim.delivery_id === "string" &&
    typeof claim.message_id === "string" &&
    typeof claim.token === "string" &&
    typeof claim.message?.conversation_id === "string" &&
    typeof claim.message?.body === "string"
  );
}

export function createTightbeamEmailAdapter({ channel, send } = {}) {
  if (
    typeof channel?.claimEmailDelivery !== "function" ||
    typeof channel?.findProviderThreadByConversation !== "function" ||
    typeof channel?.recordProviderAcceptance !== "function" ||
    typeof channel?.completeEmailDelivery !== "function" ||
    typeof send !== "function"
  ) {
    throw new TypeError("Tightbeam email adapter dependencies are incomplete");
  }

  async function deliverOnce({
    sendContext = {},
    afterProviderAccepted,
    afterProviderRecorded,
  } = {}) {
    const claimed = await channel.claimEmailDelivery();
    if (claimed?.ok !== true) return claimed;
    const claim = claimed.claim;
    if (!validClaim(claim)) {
      throw new TypeError("Tightbeam returned an invalid claimed delivery");
    }
    const accepted = await channel.findProviderAcceptanceByDelivery?.(
      claim.delivery_id,
    );
    if (accepted) {
      const completed = await channel.completeEmailDelivery({
        delivery_id: claim.delivery_id,
        token: claim.token,
        outcome: "delivered",
      });
      if (completed?.ok !== true) {
        return {
          ok: false,
          delivery_id: claim.delivery_id,
          error: completed?.code || "complete_failed",
          retryable: true,
        };
      }
      return {
        ok: true,
        delivery_id: claim.delivery_id,
        message_id: claim.message_id,
      };
    }
    const providerThread = await channel.findProviderThreadByConversation(
      claim.message.conversation_id,
    );
    const row = canonicalEmailRow(claim, providerThread);
    let provider;
    try {
      provider = await send(row, {
        ...sendContext,
        ...(providerThread ? { tightbeamProviderParent: providerThread } : {}),
      });
    } catch (error) {
      if (error?.ambiguous === true) throw error;
      await channel.completeEmailDelivery({
        delivery_id: claim.delivery_id,
        token: claim.token,
        outcome: "failed",
      });
      return {
        ok: false,
        delivery_id: claim.delivery_id,
        error: error?.code || "provider_rejected",
      };
    }
    if (
      typeof provider?.external_id !== "string" ||
      typeof provider?.external_thread_id !== "string"
    ) {
      throw new TypeError(
        "email provider accepted without durable identifiers",
      );
    }
    await afterProviderAccepted?.({ claim, provider });
    await channel.recordProviderAcceptance({ delivery: claim, provider });
    await afterProviderRecorded?.({ claim, provider });
    const completed = await channel.completeEmailDelivery({
      delivery_id: claim.delivery_id,
      token: claim.token,
      outcome: "delivered",
    });
    if (completed?.ok !== true) {
      return {
        ok: false,
        delivery_id: claim.delivery_id,
        error: completed?.code || "complete_failed",
        retryable: true,
      };
    }
    return {
      ok: true,
      delivery_id: claim.delivery_id,
      message_id: claim.message_id,
    };
  }

  return Object.freeze({ deliverOnce });
}
