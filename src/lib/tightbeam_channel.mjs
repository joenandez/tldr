import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createTightbeamEmailDeliveryChannel } from "./tightbeam_email_delivery_channel.mjs";
import { createTightbeamInboundPublisher } from "./tightbeam_inbound_publish.mjs";
import {
  APPLICATION,
  AUTHORITY,
  ENDPOINT_SESSION,
  PRINCIPAL_REF,
  TIGHTBEAM_COMPATIBILITY,
  WELCOME_APPLICATION,
  WELCOME_ENDPOINT_SESSION,
  commandFailure,
  debugIdentity,
  defaultIdentityStore,
  expectedPreflightArgs,
  identityInvalid,
  launcherUnavailable,
  productionRun,
  unavailable,
} from "./tightbeam_channel_runtime.mjs";
import {
  createTightbeamWelcomeDispatcher,
  createTightbeamWelcomeIdentityManager,
} from "./tightbeam_welcome_dispatch.mjs";

export function createTightbeamChannel({
  run = productionRun,
  loadIdentity,
  saveIdentity,
  command = process.env.TIGHTBEAM_BIN ||
    join(
      process.env.HOME ?? homedir(),
      ".tightbeam",
      "install",
      "bin",
      "tightbeam",
    ),
  home = resolve(process.env.TLDR_AGENT_HOME || join(homedir(), ".tldr-agent")),
} = {}) {
  const store = defaultIdentityStore(home);
  const readIdentity = loadIdentity ?? (() => store.load());
  const persistIdentity = saveIdentity ?? ((identity) => store.save(identity));
  const execute = (options) => run({ command, ...options });

  async function acquireApplicationCredential(application, identityKind) {
    let result = await execute({
      admin: true,
      credentials: null,
      args: ["app", "register", application],
    });
    if (result?.error?.code !== "TIGHTBEAM_APPLICATION_IDENTITY_CONFLICT") {
      return { result, reregistered: false };
    }
    debugIdentity(`${identityKind}_identity_reregistering`, { application });
    result = await execute({
      admin: true,
      credentials: null,
      args: ["app", "reregister", application],
    });
    return { result, reregistered: true };
  }

  async function preflight() {
    const result = await execute({
      admin: true,
      credentials: null,
      args: expectedPreflightArgs(),
    });
    if (result === null) return launcherUnavailable();
    if (result?.result?.compatible === false) {
      return unavailable(
        (result.result.checks ?? [])
          .filter((check) => check?.ok === false)
          .map((check) => check.field),
      );
    }
    return result?.ok === true ? Object.freeze({ ok: true }) : result;
  }

  async function registerEmailChannel(route) {
    let identity;
    try {
      identity = await readIdentity();
    } catch (error) {
      if (error?.code !== "TLDR_EMAIL_IDENTITY_INVALID") throw error;
      debugIdentity("identity_integrity_failed", { code: error.code });
      return identityInvalid();
    }
    if (!identity) {
      const acquisition = await acquireApplicationCredential(
        APPLICATION,
        "bridge",
      );
      const created = acquisition.result;
      if (
        commandFailure(created) ||
        typeof created.result?.app_id !== "string" ||
        typeof created.result?.app_secret !== "string"
      ) {
        if (acquisition.reregistered && created?.ok === false) return created;
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

  const ensureWelcomeIdentity = createTightbeamWelcomeIdentityManager({
    readIdentity,
    persistIdentity,
    execute,
    commandFailure,
    unavailable,
    identityInvalid,
    debugIdentity,
    acquireApplicationCredential,
    application: WELCOME_APPLICATION,
    authority: AUTHORITY,
  });

  const dispatchWelcome = createTightbeamWelcomeDispatcher({
    registerEmailChannel,
    ensureWelcomeIdentity,
    readIdentity,
    execute,
    commandFailure,
    unavailable,
    authority: AUTHORITY,
    principalRef: PRINCIPAL_REF,
    welcomeEndpointSession: WELCOME_ENDPOINT_SESSION,
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
  const publishInboundEmail = createTightbeamInboundPublisher({
    execute,
    readIdentity,
    commandFailure,
    delivery,
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
  TIGHTBEAM_COMPATIBILITY,
  WELCOME_APPLICATION,
  WELCOME_ENDPOINT_SESSION,
});
