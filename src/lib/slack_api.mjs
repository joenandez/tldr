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
    maybeSent = false,
  }) {
    super(`slack ${method} failed: ${slackError}`);
    this.name = "SlackApiError";
    this.method = method;
    this.slackError = slackError;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.permanent = !retryable;
    this.retryAfterMs = retryAfterMs;
    // The request left this process and no answer came: Slack may hold it (ac-jfv.59).
    this.maybeSent = maybeSent;
  }
}

const KEY_FOR_KIND = {
  bot: "botToken",
  app: "appToken",
  config: "configToken",
};
// The default for a read or a setup call. A chat.postMessage sets its own (slack_post_parts):
// under load this limit, not the outbound tick's deadline, would decide it (ac-jfv.59).
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
export function untilAborted(promise, signal) {
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
export function abortError(method, signal, maybeSent = true) {
  return new SlackApiError({
    method,
    slackError: signal?.aborted ? "aborted" : "request_timeout",
    retryable: true,
    maybeSent,
  });
}

// A failure of the connection before any request could leave: nothing reached Slack.
const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

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
  // Out of time before the request was made: it never left.
  if (bounded.aborted) throw abortError(method, signal, false);
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
  } catch (error) {
    if (bounded.aborted) throw abortError(method, signal);
    // the raw network error may echo request details; keep only the class
    throw new SlackApiError({
      method,
      slackError: "network_error",
      retryable: true,
      maybeSent: !NOT_SENT_CODES.has(error?.cause?.code ?? error?.code),
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

// marker (a short string) rides in the post's metadata so findMarkedPost can find the post
// again when Slack took it but the answer never came back (ac-jfv.59).
export async function postMessage({ channel, text, thread_ts, marker }, opts) {
  const metadata = marker
    ? JSON.stringify({ event_type: "tldr_post", event_payload: { marker } })
    : undefined;
  const r = await slackFetch(
    "chat.postMessage",
    { channel, text, thread_ts, metadata },
    opts,
  );
  return { channel: r.channel, ts: r.ts };
}

// How many pages of 200 a look reads before giving up as incomplete.
const MAX_LOOKUP_PAGES = 20;

// The post carrying marker, or null. Looks in the thread, or in the channel for a root post,
// following Slack's cursor so a busy thread cannot hide it. groups:history and im:history
// are in the manifest, so the read needs no scope the app lacks.
export async function findMarkedPost(
  { channel, thread_ts, marker, oldest },
  opts,
) {
  let cursor;
  for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
    const common = {
      channel,
      oldest,
      include_all_metadata: true,
      limit: 200,
      cursor,
    };
    // eslint-disable-next-line no-await-in-loop -- each page names the next.
    const r = await (thread_ts
      ? slackFetch("conversations.replies", { ...common, ts: thread_ts }, opts)
      : slackFetch("conversations.history", common, opts));
    const hit = (r.messages ?? []).find(
      (m) => m.metadata?.event_payload?.marker === marker,
    );
    if (hit) return { channel, ts: hit.ts };
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) return null;
  }
  throw new SlackApiError({
    method: thread_ts ? "conversations.replies" : "conversations.history",
    slackError: "lookup_incomplete",
    retryable: true,
  });
}

// The working indicator: the thread status (Slack clears it on the app's next
// reply and after 2 minutes).
export const WORKING_STATUS = "is working...";

export function setThreadStatus({ channel, thread_ts, status }, opts) {
  return slackFetch(
    "assistant.threads.setStatus",
    { channel_id: channel, thread_ts, status },
    opts,
  );
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
