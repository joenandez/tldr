import {
  readSlackCredentials,
  recordSlackHealth,
} from "./slack_credentials.mjs";

// The only module that sends Slack HTTP requests or reads Slack tokens.
// Errors never include token values; callers decide whether to retry.

const TRANSIENT_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

// Slack's answers for a token that will never work again.
export const AUTH_ERRORS = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "not_authed",
  "token_expired",
]);

export class SlackApiError extends Error {
  constructor({
    method,
    slackError,
    httpStatus = null,
    retryable = false,
    retryAfterMs = null,
  }) {
    super(`slack ${method} failed: ${slackError}`);
    this.name = "SlackApiError";
    this.method = method;
    this.slackError = slackError;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.permanent = !retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const KEY_FOR_KIND = {
  bot: "botToken",
  app: "appToken",
  config: "configToken",
};
// Several calls fit in one 35 s daemon phase and its 60 s claim lease.
export const REQUEST_TIMEOUT_MS = 10_000;

function resolveToken({ method, token, home, credentials }) {
  const creds =
    credentials !== undefined ? credentials : readSlackCredentials({ home });
  const value = creds?.[KEY_FOR_KIND[token]];
  if (!value) throw new SlackApiError({ method, slackError: "not_connected" });
  return value;
}

function formBody(body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params.toString();
}

function retryAfterMsOf(response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function failureFor(method, response, payload) {
  const httpStatus = response.status;
  const slackError = payload?.error ?? `http_${httpStatus}`;
  // HTTP status decides first: any 4xx but 429 was clearly not sent (AC-14).
  const rejected = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
  const retryable =
    !rejected &&
    (httpStatus === 429 ||
      httpStatus >= 500 ||
      TRANSIENT_ERRORS.has(slackError));
  const retryAfterMs = retryable ? retryAfterMsOf(response) : null;
  return new SlackApiError({
    method,
    slackError:
      payload?.error && httpStatus < 500 ? slackError : `http_${httpStatus}`,
    httpStatus,
    retryable,
    retryAfterMs,
  });
}

// Settles when the signal aborts even if fetchImpl ignores it.
function untilAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Timeout or caller abort: the request may have reached Slack, so retry.
function abortError(method, signal) {
  return new SlackApiError({
    method,
    slackError: signal?.aborted ? "aborted" : "request_timeout",
    retryable: true,
  });
}

async function send({
  method,
  body,
  tokenValue,
  fetchImpl,
  baseUrl,
  signal,
  timeoutMs,
}) {
  const bounded = AbortSignal.any(
    [AbortSignal.timeout(timeoutMs), signal].filter(Boolean),
  );
  let response;
  try {
    response = await untilAborted(
      fetchImpl(`${baseUrl}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenValue}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: formBody(body),
        signal: bounded,
      }),
      bounded,
    );
  } catch {
    if (bounded.aborted) throw abortError(method, signal);
    // the raw network error may echo request details; keep only the class
    throw new SlackApiError({
      method,
      slackError: "network_error",
      retryable: true,
    });
  }
  const payload = await untilAborted(response.json(), bounded).catch(
    () => null,
  );
  if (payload === null && bounded.aborted) throw abortError(method, signal);
  if (response.ok && payload?.ok === true) return payload;
  throw failureFor(method, response, payload);
}

// A call with the stored credentials records its token's health for offline
// status (AC-6); setup's candidate tokens are passed in and record nothing.
function recordTokenHealth({ token, home, credentials, error, logger }) {
  if (credentials !== undefined) return;
  const dead = AUTH_ERRORS.has(error?.slackError) && error.permanent;
  if (error && !dead) return;
  try {
    recordSlackHealth(`${token}_token`, dead ? "invalid" : "ok", { home });
  } catch (caught) {
    logger?.({
      event: "slack.health.record_failed",
      status: "error",
      result: { message: caught.message },
    });
  }
}

// An error the caller expects (e.g. already_in_channel) is routine, not a failure.
const callStatus = (error, expectedErrors) => {
  if (!error) return "ok";
  return expectedErrors.includes(error.slackError) ? "debug" : "error";
};

export async function slackFetch(
  method,
  body = {},
  {
    token = "bot",
    home,
    credentials,
    fetchImpl = globalThis.fetch,
    baseUrl = "https://slack.com/api",
    logger,
    signal,
    timeoutMs = REQUEST_TIMEOUT_MS,
    expectedErrors = [],
  } = {},
) {
  const started = Date.now();
  let error = null;
  try {
    const tokenValue = resolveToken({ method, token, home, credentials });
    return await send({
      method,
      body,
      tokenValue,
      fetchImpl,
      baseUrl,
      signal,
      timeoutMs,
    });
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    recordTokenHealth({ token, home, credentials, error, logger });
    logger?.({
      event: "slack.api.call",
      status: callStatus(error, expectedErrors),
      params: { method, token_kind: token },
      result: {
        ok: !error,
        slack_error: error?.slackError ?? null,
        http_status: error?.httpStatus ?? null,
      },
      latency_ms: Date.now() - started,
    });
  }
}

export async function authTest(opts) {
  const r = await slackFetch("auth.test", {}, opts);
  return { userId: r.user_id, teamId: r.team_id, botId: r.bot_id };
}

export async function postMessage({ channel, text, thread_ts }, opts) {
  const r = await slackFetch(
    "chat.postMessage",
    { channel, text, thread_ts },
    opts,
  );
  return { channel: r.channel, ts: r.ts };
}

export async function createPrivateChannel(name, opts) {
  const r = await slackFetch(
    "conversations.create",
    { name, is_private: true },
    opts,
  );
  return { id: r.channel.id, name: r.channel.name };
}

export async function invite(channel, userIds, opts) {
  try {
    await slackFetch(
      "conversations.invite",
      { channel, users: userIds.join(",") },
      { ...opts, expectedErrors: ["already_in_channel"] },
    );
  } catch (error) {
    if (error.slackError !== "already_in_channel") throw error;
  }
  return true;
}

export async function connectionsOpen(opts) {
  return (
    await slackFetch("apps.connections.open", {}, { ...opts, token: "app" })
  ).url;
}
