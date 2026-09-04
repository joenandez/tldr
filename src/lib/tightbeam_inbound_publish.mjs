const RAW_REPLY_AUTHORITY_FIELDS = Object.freeze([
  "conversation_id",
  "route_id",
  "origin_endpoint_id",
  "origin_session_id",
]);

function hasRawReplyAuthority(binding) {
  return RAW_REPLY_AUTHORITY_FIELDS.some((field) => field in binding);
}

export function createTightbeamInboundPublisher({
  execute,
  readIdentity,
  commandFailure,
  delivery,
}) {
  return async function publishInboundEmail({
    binding,
    provider_message_id: providerMessageId,
    provider_thread_id: providerThreadId,
    body,
  }) {
    const hasReplyBinding =
      binding &&
      typeof binding.reply_binding === "string" &&
      binding.reply_binding.length > 0;
    if (hasReplyBinding && hasRawReplyAuthority(binding)) {
      return Object.freeze({ ok: false, code: "invalid_binding" });
    }
    if (hasReplyBinding) {
      if (typeof providerMessageId !== "string" || typeof body !== "string") {
        return Object.freeze({ ok: false, code: "thread_unmapped" });
      }
      const identity = await readIdentity();
      if (!identity)
        return Object.freeze({ ok: false, code: "not_configured" });
      const published = await execute({
        admin: false,
        credentials: identity,
        args: [
          "channel",
          "reply",
          "publish",
          "--reply-binding",
          binding.reply_binding,
          "--body",
          body,
          "--external-event-id",
          providerMessageId,
          "--provider-metadata-json",
          JSON.stringify({ channel: "email" }),
        ],
      });
      if (
        commandFailure(published) ||
        typeof published.result?.message_id !== "string"
      ) {
        return Object.freeze({ ok: false, code: "publish_failed" });
      }
      try {
        await delivery.recordInboundProviderAcceptance({
          binding,
          provider_message_id: providerMessageId,
          provider_thread_id: providerThreadId,
          tightbeam_message_id: published.result.message_id,
          tightbeam_conversation_id: published.result.conversation_id,
        });
      } catch {
        return Object.freeze({
          ok: false,
          code: "reply_parent_persist_failed",
        });
      }
      // Tightbeam owns canonical routing and delivery choice. Preserve its
      // result verbatim; the adapter only advances provider reply continuity.
      return Object.freeze({ ok: true, ...published.result });
    }
    return Object.freeze({
      ok: false,
      code: binding ? "invalid_binding" : "thread_unmapped",
    });
  };
}
