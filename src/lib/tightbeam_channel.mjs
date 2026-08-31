import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createTightbeamEmailDeliveryChannel } from "./tightbeam_email_delivery_channel.mjs";
import {
  APPLICATION,
  AUTHORITY,
  ENDPOINT_SESSION,
  PRINCIPAL_REF,
  TIGHTBEAM_CONTRACT,
  commandFailure,
  defaultIdentityStore,
  expectedPreflightArgs,
  inboundKey,
  productionRun,
  unavailable,
} from "./tightbeam_channel_runtime.mjs";
import { createTightbeamWelcomeDispatcher } from "./tightbeam_welcome_dispatch.mjs";

export function createTightbeamChannel({
  run = productionRun,
  loadIdentity,
  saveIdentity,
  command = process.env.TIGHTBEAM_BIN || "tightbeam",
  home = resolve(process.env.TLDR_AGENT_HOME || join(homedir(), ".tldr-agent")),
} = {}) {
  const store = defaultIdentityStore(home);
  const readIdentity = loadIdentity ?? (() => store.load());
  const persistIdentity = saveIdentity ?? ((identity) => store.save(identity));
  const execute = (options) => run({ command, ...options });

  async function preflight() {
    const result = await execute({
      admin: true,
      credentials: null,
      args: expectedPreflightArgs(),
    });
    return commandFailure(result) ? unavailable() : Object.freeze({ ok: true });
  }

  async function registerEmailChannel(route) {
    let identity = await readIdentity();
    if (!identity) {
      const created = await execute({
        admin: true,
        credentials: null,
        args: ["app", "register", APPLICATION],
      });
      if (
        commandFailure(created) ||
        typeof created.result?.app_id !== "string" ||
        typeof created.result?.app_secret !== "string"
      ) {
        return unavailable();
      }
      identity = {
        app_id: created.result.app_id,
        app_secret: created.result.app_secret,
      };
      await persistIdentity(identity);
    }

    const authority = await execute({
      admin: true,
      credentials: null,
      args: ["authority", "register", AUTHORITY],
    });
    if (commandFailure(authority)) return unavailable();
    if (identity.authority_registered !== true) {
      identity = { ...identity, authority_registered: true };
      await persistIdentity(identity);
    }

    const grants = await execute({
      admin: true,
      credentials: null,
      args: [
        "app",
        "set-permissions",
        identity.app_id,
        "--permissions-json",
        JSON.stringify([
          {
            permission: "register_endpoints",
            allowed_authorities: [AUTHORITY],
          },
          { permission: "publish_inbound_messages" },
          { permission: "consume_outbound_requests" },
        ]),
      ],
    });
    if (commandFailure(grants)) return unavailable();

    const principal = await execute({
      admin: false,
      credentials: identity,
      args: [
        "principal",
        "register",
        "--authority",
        AUTHORITY,
        "--external-ref",
        PRINCIPAL_REF,
        "--display-name",
        "Owner",
      ],
    });
    if (
      commandFailure(principal) ||
      typeof principal.result?.principal_id !== "string"
    ) {
      return unavailable();
    }
    const endpoint = await execute({
      admin: false,
      credentials: identity,
      args: [
        "endpoint",
        "register",
        "--authority",
        AUTHORITY,
        "--principal",
        principal.result.principal_id,
        "--runtime",
        "reference",
        "--session",
        ENDPOINT_SESSION,
        "--reference",
        AUTHORITY,
      ],
    });
    if (
      commandFailure(endpoint) ||
      typeof endpoint.result?.endpoint_id !== "string"
    ) {
      return unavailable();
    }
    const registration = await execute({
      admin: false,
      credentials: identity,
      args: [
        "channel",
        "route",
        "register",
        "--selector",
        route.selector,
        "--label",
        route.label,
        "--principal",
        principal.result.principal_id,
        "--endpoint",
        endpoint.result.endpoint_id,
        ...route.capabilities.flatMap((capability) => [
          "--capability",
          capability,
        ]),
      ],
    });
    return commandFailure(registration)
      ? unavailable()
      : Object.freeze({ ok: true });
  }

  async function publishInboundEmail({
    binding,
    provider_message_id: providerMessageId,
    body,
  }) {
    if (
      !binding ||
      typeof binding.conversation_id !== "string" ||
      typeof binding.route_id !== "string" ||
      typeof binding.origin_endpoint_id !== "string" ||
      typeof providerMessageId !== "string" ||
      typeof body !== "string"
    ) {
      return Object.freeze({ ok: false, code: "thread_unmapped" });
    }
    const identity = await readIdentity();
    if (!identity) return Object.freeze({ ok: false, code: "not_configured" });

    const principal = await execute({
      admin: false,
      credentials: identity,
      args: [
        "principal",
        "register",
        "--authority",
        AUTHORITY,
        "--external-ref",
        PRINCIPAL_REF,
        "--display-name",
        "Owner",
      ],
    });
    if (
      commandFailure(principal) ||
      typeof principal.result?.principal_id !== "string"
    ) {
      return Object.freeze({ ok: false, code: "identity_unavailable" });
    }
    const endpoint = await execute({
      admin: false,
      credentials: identity,
      args: [
        "endpoint",
        "register",
        "--authority",
        AUTHORITY,
        "--principal",
        principal.result.principal_id,
        "--runtime",
        "reference",
        "--session",
        ENDPOINT_SESSION,
        "--reference",
        AUTHORITY,
      ],
    });
    if (
      commandFailure(endpoint) ||
      typeof endpoint.result?.endpoint_id !== "string" ||
      !Number.isInteger(endpoint.result?.process_generation)
    ) {
      return Object.freeze({ ok: false, code: "identity_unavailable" });
    }
    const routes = await execute({
      admin: false,
      credentials: identity,
      args: ["channel", "route", "list"],
    });
    const route = routes?.result?.routes?.find(
      (candidate) =>
        candidate?.selector === "email" &&
        candidate?.route_id === binding.route_id,
    );
    if (commandFailure(routes) || !route) {
      return Object.freeze({ ok: false, code: "route_mismatch" });
    }
    const committed = await execute({
      admin: false,
      credentials: identity,
      args: [
        "message",
        "commit",
        "--conversation",
        binding.conversation_id,
        "--from",
        principal.result.principal_id,
        "--body",
        body,
        "--key",
        inboundKey(providerMessageId),
        "--origin-channel-route",
        binding.route_id,
        "--inbound-target-endpoint",
        binding.origin_endpoint_id,
        "--effect",
        "none",
        "--sender-endpoint",
        endpoint.result.endpoint_id,
        "--process-generation",
        String(endpoint.result.process_generation),
      ],
    });
    if (
      commandFailure(committed) ||
      typeof committed.result?.message_id !== "string"
    ) {
      return Object.freeze({ ok: false, code: "publish_failed" });
    }
    return Object.freeze({ ok: true, message_id: committed.result.message_id });
  }

  const dispatchWelcome = createTightbeamWelcomeDispatcher({
    registerEmailChannel,
    readIdentity,
    execute,
    commandFailure,
    unavailable,
    authority: AUTHORITY,
    principalRef: PRINCIPAL_REF,
    endpointSession: ENDPOINT_SESSION,
  });

  const delivery = createTightbeamEmailDeliveryChannel({
    execute,
    readIdentity,
    home,
    commandFailure,
    authority: AUTHORITY,
    principalRef: PRINCIPAL_REF,
    endpointSession: ENDPOINT_SESSION,
  });

  return Object.freeze({
    preflight,
    registerEmailChannel,
    dispatchWelcome,
    publishInboundEmail,
    ...delivery,
  });
}

export const _internals = Object.freeze({
  APPLICATION,
  AUTHORITY,
  ENDPOINT_SESSION,
  PRINCIPAL_REF,
  TIGHTBEAM_CONTRACT,
});
