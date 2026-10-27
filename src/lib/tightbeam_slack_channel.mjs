import { commandFailure, unavailable } from "./tightbeam_channel_runtime.mjs";
import { SLACK_ROUTE } from "./starport_slack_route.mjs";
import { createSlackDelivery } from "./tightbeam_slack_delivery.mjs";
import {
  OK,
  PERMISSIONS,
  SLACK_APPLICATION,
  SLACK_AUTHORITY,
  createSlackContext,
  fail,
  isIdentityConflict,
  nonEmpty,
  tightbeamCodeOf,
} from "./tightbeam_slack_support.mjs";

export {
  SLACK_APPLICATION,
  SLACK_AUTHORITY,
  SLACK_OPENER_AUTHORITY,
  SLACK_ENDPOINT_SESSION,
  SLACK_PRINCIPAL_REF,
} from "./tightbeam_slack_support.mjs";

async function createAppIdentity({ admin }) {
  let created = await admin(["app", "register", SLACK_APPLICATION]);
  if (isIdentityConflict(created)) {
    created = await admin(["app", "reregister", SLACK_APPLICATION]);
  }
  const { app_id: appId, app_secret: appSecret } = created?.result ?? {};
  if (commandFailure(created) || !nonEmpty(appId) || !nonEmpty(appSecret)) {
    return null;
  }
  return { app_id: appId, app_secret: appSecret };
}

async function ensureIdentity(ctx) {
  const stored = await ctx.safeIdentity();
  if (stored) return stored;
  const created = await createAppIdentity(ctx);
  if (created) await ctx.persistIdentity(created);
  return created;
}

async function routeRegistration(ctx, { identity, route }) {
  const owner = await ctx.registerOwner(identity);
  if (!owner) return null;
  return ctx.asApp(identity, [
    "channel",
    "route",
    "register",
    "--selector",
    route.selector,
    "--label",
    route.label,
    "--principal",
    owner.principal.principal_id,
    "--endpoint",
    owner.endpoint.endpoint_id,
    ...route.capabilities.flatMap((capability) => ["--capability", capability]),
  ]);
}

async function registerSteps(ctx, route) {
  const identity = await ensureIdentity(ctx);
  if (!identity) return unavailable();
  const authority = await ctx.admin(["authority", "register", SLACK_AUTHORITY]);
  const grants = await ctx.admin([
    "app",
    "set-permissions",
    identity.app_id,
    "--permissions-json",
    JSON.stringify(PERMISSIONS),
  ]);
  const authorityOk =
    !commandFailure(authority) || isIdentityConflict(authority);
  if (!authorityOk || commandFailure(grants)) return unavailable();
  const registration = await routeRegistration(ctx, { identity, route });
  const routed = registration && !commandFailure(registration);
  return routed && (await ctx.registerOpener(identity)) ? OK : unavailable();
}

async function registerSlackChannel(ctx, route = SLACK_ROUTE) {
  const finish = ctx.begin("tightbeam_slack_register");
  const result = await registerSteps(ctx, route);
  finish(result.ok ? "ok" : "failed", { selector: route.selector });
  return result;
}

async function listWith(ctx, identity) {
  const listed = await ctx.asApp(identity, ["channel", "route", "list"]);
  if (commandFailure(listed) || !Array.isArray(listed.result?.routes)) {
    return Object.freeze({ ok: false });
  }
  return Object.freeze({
    ok: true,
    routes: listed.result.routes.filter((r) => r?.selector === "slack"),
  });
}

async function listSlackRoutes(ctx) {
  // undefined marks an unreadable identity; null means none stored yet.
  const identity = await ctx.readIdentity().catch(() => undefined);
  if (identity === undefined) return Object.freeze({ ok: false });
  if (identity === null) return Object.freeze({ ok: true, routes: [] });
  return listWith(ctx, identity);
}

// Tightbeam checks and retires each route atomically; a refusal leaves it active.
async function retireRoutes(ctx) {
  const listed = await listSlackRoutes(ctx);
  if (!listed.ok) return fail("route_list_unavailable");
  const identity = await ctx.readIdentity();
  const retirements = await Promise.all(
    listed.routes.map((route) =>
      ctx.asApp(identity, [
        "channel",
        "route",
        "retire",
        route.route_id,
        "--require-no-active-deliveries",
      ]),
    ),
  );
  const refused = retirements.some(
    (r) => tightbeamCodeOf(r) === "route_has_active_deliveries",
  );
  const code = refused
    ? "route_has_active_deliveries"
    : retirements.some(commandFailure) && "route_retire_failed";
  return code ? fail(code) : Object.freeze({ ok: true, state: "retired" });
}

async function retireSlackRoute(ctx) {
  const finish = ctx.begin("tightbeam_slack_retire");
  const result = await retireRoutes(ctx);
  finish(result.ok ? "ok" : result.code);
  return result;
}

export function createTightbeamSlackChannel(options = {}) {
  const ctx = createSlackContext(options);
  const listRoutes = () => listSlackRoutes(ctx);
  return Object.freeze({
    registerSlackChannel: (route) => registerSlackChannel(ctx, route),
    listSlackRoutes: listRoutes,
    retireSlackRoute: () => retireSlackRoute(ctx),
    ...createSlackDelivery({ ctx, listRoutes }),
  });
}
