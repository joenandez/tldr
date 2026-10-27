import { createHash, timingSafeEqual } from "node:crypto";

// Request plumbing for the local setup page: body reader, HTML sender and the
// Host/Origin/key refusal check.

const MAX_BODY = 4096;
export const OAUTH_PATH = "/slack/oauth";

const digest = (value) => createHash("sha256").update(String(value)).digest();
const sameSecret = (a, b) => timingSafeEqual(digest(a), digest(b));

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))),
    );
    req.on("error", reject);
  });
}

export function send(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // not no-referrer: Chrome then sends `Origin: null` on our own form POSTs
    "Referrer-Policy": "same-origin",
  });
  res.end(html);
}

export function refusalReason({ req, url, port, key }) {
  const supplied = url.searchParams.get(
    url.pathname === OAUTH_PATH ? "state" : "key",
  );
  const { host, origin = `http://127.0.0.1:${port}` } = req.headers;
  const checks = [
    [host !== `127.0.0.1:${port}`, "bad_host"],
    [origin !== `http://127.0.0.1:${port}`, "bad_origin"],
    [supplied === null || !sameSecret(supplied, key), "bad_key"],
  ];
  return checks.find(([failed]) => failed)?.[1] ?? "";
}

export const formValue = async (req, name) =>
  (await readForm(req)).get(name)?.trim();

// Browsers ask for the icon without the key: answer quietly, never serve state.
export const isIconRequest = ({ req, url, port }) =>
  req.method === "GET" &&
  url.pathname === "/favicon.ico" &&
  req.headers.host === `127.0.0.1:${port}`;

// stop() awaits settled() so cleanup sees whatever an in-flight request made.
export function createLock() {
  const running = new Set();
  const exclusive = async (work) => {
    const run = work();
    running.add(run);
    try {
      await run;
    } finally {
      running.delete(run);
    }
  };
  const settled = () => Promise.allSettled(running);
  return { exclusive, settled, isBusy: () => running.size > 0 };
}

// After connect the original tab's next reload still gets "Slack: connected".
export function closeServer(server, graceMs) {
  const close = () => {
    server.close();
    server.closeAllConnections();
  };
  if (graceMs) setTimeout(close, graceMs).unref();
  else close();
}

export const REJECTED_TOKEN =
  "Slack did not accept that token. Generate a new one and try again.";

const MALFORMED_TOKEN =
  "That is not an access token. It starts with xoxe. Copy it again from Slack.";

export const createTokenProblem = (error) =>
  error?.slackError === "invalid_config_token"
    ? MALFORMED_TOKEN
    : REJECTED_TOKEN;

export const logError = (log, event, error) =>
  log(event, "error", { name: error?.name, slack_error: error?.slackError });

export function createConfigFlow(ctx) {
  const { key, session, provision, log, page, redirectUrl, exclusive } = ctx;

  const createApp = (configToken, res) =>
    exclusive(async () => {
      try {
        const app = await provision.createApp({
          configToken,
          redirectUrl,
          state: key,
        });
        Object.assign(session, app, { appCreated: true });
        log("app_created", "ok");
        page(res);
      } catch (error) {
        logError(log, "create_failed", error);
        page(res, createTokenProblem(error));
      }
    });

  return async (req, res) => {
    const configToken = session.authorizeUrl
      ? undefined
      : await formValue(req, "configToken");
    if (session.authorizeUrl) page(res);
    else if (configToken) await createApp(configToken, res);
    else page(res, "Paste the access token first.");
  };
}
