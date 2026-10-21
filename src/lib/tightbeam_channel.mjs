import { resolve } from "node:path";
import { createTightbeamEmailDeliveryChannel } from "./tightbeam_email_delivery_channel.mjs";
import { createTightbeamInboundPublisher } from "./tightbeam_inbound_publish.mjs";
import {
  APPLICATION,
  AUTHORITY,
  ENDPOINT_SESSION,
  PRINCIPAL_REF,
  TIGHTBEAM_COMPATIBILITY,
  commandFailure,
  debugIdentity,
  defaultIdentityStore,
  expectedPreflightArgs,
  identityInvalid,
  launcherUnavailable,
  productionRun,
  tightbeamInvocation,
  unavailable,
} from "./tightbeam_channel_runtime.mjs";
import { helmHome } from "./store.mjs";

export function createTightbeamChannel({
  run = productionRun,
  loadIdentity,
  saveIdentity,
  command,
  commandPrefix,
  home = resolve(helmHome()),
} = {}) {
  const store = defaultIdentityStore(home);
  const readIdentity = loadIdentity ?? (() => store.load());
  const persistIdentity = saveIdentity ?? ((identity) => store.save(identity));
  const invocation = tightbeamInvocation({ command, commandPrefix });
  const execute = (options) => run({ ...invocation, ...options });

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

  // Capabilities the daemon reported in the last compatible preflight.
  let reportedCapabilities = null;

  async function preflight() {
    reportedCapabilities = null;
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
    if (result?.ok !== true) return result;
    const observed = result.result?.observed?.capabilities;
    reportedCapabilities = Array.isArray(observed) ? [...observed] : null;
    return Object.freeze({ ok: true });
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

  // Messaging health: doctor is read-only by construction and needs no
  // credentials; only its verdict leaves this adapter.
  async function doctor() {
    const result = await execute({
      admin: false,
      credentials: null,
      args: ["doctor"],
    });
    return Object.freeze({ ok: result?.ok === true });
  }

  // Active routes only (retired routes disappear from the list). Without a
  // stored bridge identity no route can exist, so nothing is launched.
  async function listEmailRoutes() {
    let identity;
    try {
      identity = await readIdentity();
    } catch {
      return Object.freeze({ ok: false });
    }
    if (!identity) return Object.freeze({ ok: true, routes: [] });
    const listed = await execute({
      admin: false,
      credentials: identity,
      args: ["channel", "route", "list"],
    });
    if (commandFailure(listed) || !Array.isArray(listed.result?.routes)) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({ ok: true, routes: listed.result.routes });
  }

  // Runs one owner command per active email route. Null when the routes
  // cannot be listed; no route (or no identity) runs nothing.
  async function onEmailRoutes(routeArgs) {
    const listed = await listEmailRoutes();
    if (!listed.ok) return null;
    const routeIds = listed.routes
      .filter((route) => route?.selector === "email")
      .map((route) => route.route_id);
    if (routeIds.length === 0) return [];
    const identity = await readIdentity();
    return Promise.all(
      routeIds.map((routeId) =>
        execute({
          admin: false,
          credentials: identity,
          args: ["channel", "route", ...routeArgs(routeId)],
        }),
      ),
    );
  }

  // Read-only disconnect impact: this bridge's pending and claimed email
  // deliveries across its active email routes.
  async function emailRouteImpact() {
    const impacts = await onEmailRoutes((routeId) => ["impact", routeId]);
    if (impacts === null || impacts.some(commandFailure)) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      pending_deliveries: impacts.reduce(
        (sum, impact) => sum + impact.result.pending_deliveries,
        0,
      ),
      claimed_deliveries: impacts.reduce(
        (sum, impact) => sum + impact.result.claimed_deliveries,
        0,
      ),
    });
  }

  // Tightbeam checks and retires each route atomically, so a refusal leaves
  // that route active. No active email route left means an earlier retire
  // already won.
  async function retireEmailRoute() {
    const retirements = await onEmailRoutes((routeId) => [
      "retire",
      routeId,
      "--require-no-active-deliveries",
    ]);
    if (retirements === null) {
      return Object.freeze({ ok: false, code: "route_list_unavailable" });
    }
    if (
      retirements.some(
        (retired) =>
          retired?.error?.tightbeam_code === "route_has_active_deliveries" ||
          retired?.error?.code === "route_has_active_deliveries",
      )
    ) {
      return Object.freeze({ ok: false, code: "route_has_active_deliveries" });
    }
    if (retirements.some(commandFailure)) {
      return Object.freeze({ ok: false, code: "route_retire_failed" });
    }
    return Object.freeze({ ok: true, state: "retired" });
  }

  const delivery = createTightbeamEmailDeliveryChannel({
    execute,
    readIdentity,
    home,
    commandFailure,
    authority: AUTHORITY,
    principalRef: PRINCIPAL_REF,
    endpointSession: ENDPOINT_SESSION,
    reportedCapabilities: () => reportedCapabilities,
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
    doctor,
    listEmailRoutes,
    emailRouteImpact,
    retireEmailRoute,
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
});
