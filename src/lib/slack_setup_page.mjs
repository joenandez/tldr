import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import {
  OAUTH_PATH,
  closeServer,
  REJECTED_TOKEN,
  createLock,
  createConfigFlow,
  logError,
  formValue,
  isIconRequest,
  refusalReason,
  send,
} from "./slack_setup_http.mjs";
import { renderSlackSetupPage } from "./slack_setup_steps.mjs";

// Local setup page: 127.0.0.1 only, one-time key, Host/Origin checks. Tokens
// go browser -> this process -> Slack checks -> credentials writer. Logs carry
// event names and outcomes only, never a token, code, key, or body.

const OAUTH_RETRY =
  'Slack did not finish the install. Press "Install to Slack" again.';

const FOLLOW_UP_FAILED = "Slack is connected, but a follow-up step failed.";

const STOPPED = "Setup stopped. Run tldr-agents setup --channel slack again.";

// Credentials are saved by now: a follow-up failure is a notice, never "bad token".
async function followUp({ session, onConnected, log }) {
  session.connected = true;
  try {
    const { ownerUserId, teamId } = session;
    const { notice, channels } = await onConnected({ ownerUserId, teamId });
    Object.assign(session, { notice, channels });
  } catch (error) {
    logError(log, "on_connected_failed", error);
    session.notice = FOLLOW_UP_FAILED;
  }
  log("connected", "ok");
}

// Returns a user-facing problem string, or undefined once connected.
async function validateAndSave(ctx) {
  const { session, validate, writeCredentials, log } = ctx;
  // the original tab keeps refreshing (no "Try again") while checks are in flight
  session.checking = true;
  try {
    const auth = await validate.authTest({ botToken: session.botToken });
    const teamId = auth.teamId ?? session.teamId;
    await validate.connectionsOpen({ appToken: session.appToken });
    // stop() abandons the app once this request settles: never save for it
    if (session.stopped) {
      session.checking = false;
      return STOPPED;
    }
    await writeCredentials({
      botToken: session.botToken,
      appToken: session.appToken,
      ownerUserId: session.ownerUserId,
      teamId,
    });
    session.teamId = teamId;
  } catch (error) {
    session.checking = false;
    logError(log, "validation_failed", error);
    return REJECTED_TOKEN;
  }
  // only now is the app kept for good: a failed check above leaves the token to delete it
  await ctx
    .revokeToken()
    .catch((error) => logError(log, "revoke_failed", error));
  await followUp(ctx);
  return undefined;
}

const connect = async (ctx, res) => ctx.page(res, await validateAndSave(ctx));

function createExchange(ctx) {
  const { session, provision, log, page, redirectUrl } = ctx;
  return (code, res) =>
    ctx.exclusive(async () => {
      try {
        const { botToken, ownerUserId, teamId } = await provision.exchangeCode({
          code,
          redirectUrl,
        });
        Object.assign(session, { botToken, ownerUserId, teamId });
        if (session.appToken) await connect(ctx, res);
        else page(res);
      } catch (error) {
        logError(log, "exchange_failed", error);
        page(res, OAUTH_RETRY);
      }
    });
}

function createTokenFlows(ctx) {
  const { session, log, page, exclusive } = ctx;
  const exchange = createExchange(ctx);

  async function oauth(url, res) {
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) {
      log("oauth_denied", "refused");
      page(res, OAUTH_RETRY);
    } else if (session.botToken) page(res);
    else await exchange(code, res);
  }

  async function postAppToken(req, res) {
    const typed = session.botToken && (await formValue(req, "appToken"));
    session.appToken = typed || session.appToken;
    if (!session.botToken) page(res);
    else if (session.appToken) await exclusive(() => connect(ctx, res));
    else page(res, "Paste the xapp- token first.");
  }

  return { oauth, postAppToken };
}

function createHandler(ctx) {
  const { key, session, port, log, stop } = ctx;
  const origin = `http://127.0.0.1:${port}`;
  const redirectUrl = `${origin}${OAUTH_PATH}`;
  const refuse = (res, reason) => {
    log("refused", "refused", { reason });
    send(res, 403, "Forbidden");
  };
  const page = (res, error) => {
    if (session.connected) res.once("finish", () => stop("connected"));
    send(res, error ? 400 : 200, renderSlackSetupPage({ key, session, error }));
  };
  const { lock } = ctx;
  const flowCtx = { ...ctx, ...lock, page, redirectUrl };
  const postConfigToken = createConfigFlow(flowCtx);
  const flows = createTokenFlows(flowCtx);

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    const reason = refusalReason({ req, url, port, key });
    const route = `${req.method} ${url.pathname}`;
    const posts = {
      "POST /config-token": () => postConfigToken(req, res),
      "POST /app-token": () => flows.postAppToken(req, res),
    };
    const routes = {
      "GET /": () => page(res),
      [`GET ${OAUTH_PATH}`]: () => flows.oauth(url, res),
      ...(lock.isBusy() ? {} : posts),
    };
    if (isIconRequest({ req, url, port })) res.writeHead(204).end();
    else if (reason) refuse(res, reason);
    else if (session.connected) page(res);
    else await (routes[route] ?? (() => send(res, 404, "Not found")))();
  }

  return (req, res) =>
    handle(req, res).catch((error) => {
      log("request_failed", "error", { name: error?.name });
      send(res, error?.status ?? 500, "Something went wrong.");
    });
}

export async function startSlackSetupPage({
  provision,
  validate,
  writeCredentials,
  onConnected = async () => ({}),
  timeoutMs = 15 * 60 * 1000,
  graceMs = 8000,
  logger,
}) {
  const key = randomBytes(24).toString("base64url");
  const session = { appCreated: false, revoked: false, connected: false };
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const log = (event, status, params) =>
    logger?.({
      event: `slack.setup_page.${event}`,
      status,
      params,
      result: status,
    });

  // revoked stays false until the install succeeds, so abandon only fires then
  async function retireApp(method) {
    if (session.appCreated && !session.revoked) {
      session.revoked = true;
      await provision[method]();
    }
  }
  const revokeToken = () => retireApp("revokeConfigToken");
  const lock = createLock();

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const redirectUrl = `${origin}${OAUTH_PATH}`;
  server.on(
    "request",
    createHandler({
      ...{ key, session, provision, validate, port, log, revokeToken, lock },
      ...{ writeCredentials, onConnected, stop: (status) => stop(status) },
    }),
  );

  function stop(status = "stopped") {
    if (!session.stopped) {
      session.stopped = true;
      clearTimeout(timer);
      closeServer(server, status === "connected" ? graceMs : 0);
      const { ownerUserId, teamId } = session;
      const result = { status, ownerUserId, teamId };
      // an in-flight request settles first: it may create the app, never save it
      lock
        .settled()
        .then(() => retireApp("abandonApp"))
        .catch(() => {})
        .finally(() => {
          if (status !== "connected") log(status, "stopped");
          finish(result);
        });
    }
    return done;
  }
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  timer.unref();

  log("started", "ok", { port });
  return {
    url: `${origin}/?key=${key}`,
    port,
    redirectUrl,
    done,
    stop: () => stop("stopped"),
  };
}
