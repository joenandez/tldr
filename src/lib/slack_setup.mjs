import { rmSync } from "node:fs";
import { join } from "node:path";

import { AUTH_ERRORS, authTest } from "./slack_api.mjs";
import { deleteSlackChannelMap } from "./slack_channel_map.mjs";
import {
  SlackCredentialsError,
  deleteSlackCredentials,
  readSlackCredentials,
  recordSlackHealth,
} from "./slack_credentials.mjs";

// Slack status, repair and disconnect (setup is slack_setup_flow.mjs). Pure
// over injected io; tokens are never logged or printed.

export const SLACK_MANIFEST = Object.freeze(
  JSON.parse(String.raw`{
  "display_information": {
    "name": "tldr",
    "description": "Messages between you and your tldr agents"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "tldr",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "groups:write",
        "groups:history",
        "im:write",
        "im:history"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "message.groups",
        "message.im"
      ]
    },
    "interactivity": {
      "is_enabled": false
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}`),
);

// Scopes, one reason each (docs.slack.dev/reference/scopes): chat:write posts;
// groups:write creates private channels and invites; groups:history backs
// message.groups; im:write opens the owner DM; im:history backs message.im.
// The owner is the installing user from OAuth, so no users:read* scope.
// groups:read is never needed (no info/list calls).

const SETUP = "Run setup --channel slack";
const FIX_SLACK = "Say Fix Slack";
const needsAttention = (remediation, reason) => ({
  state: "needs_attention",
  remediation,
  ...(reason ? { reason } : {}),
});
const STATUS_BY_KIND = {
  absent: { state: "not_connected", remediation: SETUP },
  credentials_unreadable: needsAttention(`${SETUP} again`),
  no_owner: needsAttention(`${SETUP} again`, "slack_owner_missing"),
  token_invalid: needsAttention(`${SETUP} again`),
  unreachable: needsAttention(FIX_SLACK, "slack_unreachable"),
  route_missing: needsAttention(FIX_SLACK, "slack_route_missing"),
  ok: { state: "connected", remediation: null },
};
// What a check found, kept for offline `status --json` (AC-6). Unreachable is
// transient and records nothing.
const HEALTH_BY_KIND = {
  token_invalid: { bot_token: "invalid" },
  route_missing: { bot_token: "ok", route: "missing" },
  ok: { bot_token: "ok", route: "ok" },
};
const REPAIR_BY_KIND = {
  route_missing: null,
  ok: "restart_listener_hint",
  unreachable: "restart_listener_hint",
};

function recordHealth(ctx, kind) {
  for (const [fact, value] of Object.entries(HEALTH_BY_KIND[kind] ?? {}))
    recordSlackHealth(fact, value, { home: ctx.home });
}

const fail = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

const apiOpts = (ctx, credentials) => ({
  credentials,
  fetchImpl: ctx.fetchImpl,
  logger: ctx.logger,
});

function readCredentialsState(ctx) {
  try {
    const credentials = readSlackCredentials({ home: ctx.home });
    if (!credentials) return { kind: "absent" };
    return credentials.ownerUserId ? { credentials } : { kind: "no_owner" };
  } catch (error) {
    if (!(error instanceof SlackCredentialsError)) throw error;
    return { kind: "credentials_unreadable" };
  }
}

async function routeRegistered(ctx) {
  const listed = await ctx.channel.listSlackRoutes();
  return (
    !!listed?.ok && (listed.routes ?? []).some((r) => r.selector === "slack")
  );
}

async function probe(ctx) {
  const read = readCredentialsState(ctx);
  if (!read.credentials) return read;
  const auth = await attempt(() => authTest(apiOpts(ctx, read.credentials)));
  if (!auth.ok) {
    const permanent =
      auth.error.permanent !== false && AUTH_ERRORS.has(auth.error.slackError);
    return { kind: permanent ? "token_invalid" : "unreachable" };
  }
  return { kind: (await routeRegistered(ctx)) ? "ok" : "route_missing" };
}

async function diagnose(ctx) {
  const found = await probe(ctx);
  recordHealth(ctx, found.kind);
  return found;
}

async function status(ctx) {
  const { kind } = await diagnose(ctx);
  const result = Object.freeze({ ...STATUS_BY_KIND[kind] });
  ctx.log("slack_status_checked", {
    status: "ok",
    result: { kind, state: result.state },
  });
  return result;
}

async function repair(ctx) {
  const { kind } = await diagnose(ctx);
  ctx.log("slack_repair_diagnosed", { status: "ok", result: { kind } });
  if (kind === "route_missing") {
    const registered = await ctx.channel.registerSlackChannel();
    if (registered?.ok) recordHealth(ctx, "ok");
    return Object.freeze({
      action: "reregistered_route",
      ok: !!registered?.ok,
    });
  }
  if (REPAIR_BY_KIND[kind]) {
    const message =
      "Slack looks reachable. Restart the tldr daemon to restart the Slack listener.";
    return Object.freeze({ action: REPAIR_BY_KIND[kind], message });
  }
  const message = `${SETUP} again and follow the link it prints.`;
  return Object.freeze({ action: "setup", message });
}

async function disconnect(ctx) {
  const retired = await ctx.channel.retireSlackRoute();
  // Keep credentials while the route is live: active deliveries drain through
  // the outbound lane, and any other failure would leave a route with no lane.
  if (!retired?.ok) {
    const code = retired?.code ?? "route_retire_failed";
    ctx.log("slack_disconnect_refused", { status: "error", result: { code } });
    return fail(code);
  }
  deleteSlackCredentials({ home: ctx.home, logger: ctx.logger });
  deleteSlackChannelMap(ctx.home);
  rmSync(join(ctx.home, "slack"), { recursive: true, force: true });
  ctx.log("slack_disconnect_done", { status: "ok" });
  return Object.freeze({ ok: true, state: "not_connected" });
}

export function createSlackSetup({ home, channel, fetchImpl, logger }) {
  const log = (event, extra = {}) => logger?.({ event, ...extra });
  const ctx = { home, channel, fetchImpl, logger, log };
  return Object.freeze({
    status: () => status(ctx),
    repair: () => repair(ctx),
    disconnect: () => disconnect(ctx),
  });
}
