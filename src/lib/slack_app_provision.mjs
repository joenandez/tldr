import { SlackApiError, slackFetch } from "./slack_api.mjs";
import { SLACK_MANIFEST } from "./slack_setup.mjs";

// Path A: create the Slack app with a one-time configuration token, then
// exchange the OAuth code for the bot token. Secrets live only in the
// provisioner's closure; errors and logs carry reasons, never values.

export const PROVISION_BOT_SCOPES = Object.freeze([
  "chat:write",
  "groups:write",
  "groups:history",
  "im:write",
  "im:history",
]);

export function provisionManifest({ redirectUrl }) {
  const manifest = structuredClone(SLACK_MANIFEST);
  manifest.oauth_config = {
    ...manifest.oauth_config,
    scopes: { bot: [...PROVISION_BOT_SCOPES] },
    redirect_urls: [redirectUrl],
  };
  return manifest;
}

const fail = (method, slackError) =>
  new SlackApiError({ method, slackError, retryable: false });

// Slack ignores the Bearer header on oauth.v2.access, so the config token
// doubles as slackFetch's required credential there; every call logs token_kind config.
const call = (s, { method, body, token }) =>
  slackFetch(method, body, {
    credentials: { configToken: token },
    token: "config",
    fetchImpl: s.fetchImpl,
    baseUrl: s.baseUrl,
    logger: s.logger,
    signal: s.signal,
  });

async function createApp(s, { configToken: token, redirectUrl, state }) {
  const method = "apps.manifest.create";
  if (s.created) throw fail(method, "app_already_created");
  if (typeof token !== "string" || !token.startsWith("xoxe.")) {
    throw fail(method, "invalid_config_token");
  }
  const r = await call(s, {
    method,
    body: {
      manifest: JSON.stringify(provisionManifest({ redirectUrl })),
      generate_app_token: true,
    },
    token,
  });
  const { client_id: id, client_secret: secret } = r.credentials ?? {};
  if (!r.app_id || !id || !secret || !r.oauth_authorize_url) {
    throw fail(method, "bad_create_response");
  }
  s.created = true;
  s.appId = r.app_id;
  s.configToken = token;
  s.client = { id, secret };
  const authorizeUrl = new URL(r.oauth_authorize_url);
  authorizeUrl.searchParams.set("redirect_uri", redirectUrl);
  authorizeUrl.searchParams.set("state", state);
  s.logger?.({
    event: "slack.provision.app_created",
    status: "ok",
    result: { has_app_token: Boolean(r.app_token) },
  });
  return {
    appId: r.app_id,
    teamId: r.team_id,
    authorizeUrl: authorizeUrl.toString(),
    appToken: r.app_token ?? null,
    appSettingsUrl: `https://api.slack.com/apps/${r.app_id}/general`,
  };
}

async function exchangeCode(s, { code, redirectUrl }) {
  const method = "oauth.v2.access";
  if (!s.client || !s.configToken) throw fail(method, "not_created");
  const r = await call(s, {
    method,
    body: {
      client_id: s.client.id,
      client_secret: s.client.secret,
      code,
      redirect_uri: redirectUrl,
    },
    token: s.configToken,
  });
  if (!r.access_token?.startsWith("xoxb-") || !r.authed_user?.id) {
    throw fail(method, "bad_exchange_response");
  }
  s.client = null; // the code is single-use; the secret has no further job
  s.logger?.({ event: "slack.provision.code_exchanged", status: "ok" });
  return {
    botToken: r.access_token,
    ownerUserId: r.authed_user.id,
    teamId: r.team?.id ?? null,
    botUserId: r.bot_user_id ?? null,
    appId: r.app_id ?? null,
  };
}

async function revokeConfigToken(s) {
  const token = s.configToken;
  s.configToken = null;
  if (!token) return;
  try {
    await call(s, { method: "auth.revoke", body: {}, token });
    s.logger?.({ event: "slack.provision.config_token_revoked", status: "ok" });
  } catch (error) {
    s.logger?.({
      event: "slack.provision.config_token_revoked",
      status: "error",
      result: { slack_error: error.slackError ?? "unknown" },
    });
  }
}

// Setup abandoned before the install finished: delete the half-made app, then
// revoke the config token, so no orphan "tldr" app stays and a retry makes one.
async function abandonApp(s) {
  if (s.configToken && s.appId) {
    const event = "slack.provision.app_deleted";
    try {
      await call(s, {
        method: "apps.manifest.delete",
        body: { app_id: s.appId },
        token: s.configToken,
      });
      s.logger?.({ event, status: "ok" });
    } catch (error) {
      const result = { slack_error: error.slackError ?? "unknown" };
      s.logger?.({ event, status: "error", result });
    }
  }
  await revokeConfigToken(s);
}

export function createSlackProvisioner(options = {}) {
  // Secrets live only in this private state: configToken, and client until
  // the code is exchanged.
  const s = { ...options, configToken: null, client: null, created: false };
  return {
    createApp: (args) => createApp(s, args),
    exchangeCode: (args) => exchangeCode(s, args),
    revokeConfigToken: () => revokeConfigToken(s),
    abandonApp: () => abandonApp(s),
  };
}
