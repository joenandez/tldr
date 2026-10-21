import {
  OwnerCredentialsError,
  maskDestination,
  readOwnerCredentials,
} from "./owner_credentials.mjs";
import {
  isRejectedInbound,
  validAgentmailRoot,
} from "./agentmail_inbound_policy.mjs";

// Linux/WSL stand-in for the macOS Aegis broker: calls AgentMail directly with
// the owner's local key. Result shapes and error codes match aegis_client.mjs.
// Endpoints mirror native/aegis-broker/macos/AegisEnrollmentProvider.swift.
// The key never appears in a log, an error message, or a result.

// Options the local client reads; aegis_client.mjs allows them on every call.
export const LOCAL_OPTIONS = ["platform", "fetch", "home", "logger"];
// Linux/WSL has no Aegis broker, so it talks to AgentMail with a local key.
export const usesLocalClient = ({ platform = process.platform } = {}) =>
  platform === "linux";

export const DEFAULT_AGENTMAIL_BASE_URL = "https://api.agentmail.to/v0";
const BODY_MAX_BYTES = 32_768;

function codedError(code, ambiguous = false) {
  const error = new Error(code);
  error.code = code;
  if (ambiguous) error.ambiguous = true;
  return error;
}

export function normalizeMailbox(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const angle = /<([^<>]*)>$/.exec(raw);
  const mailbox = (angle ? angle[1] : raw).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(mailbox) || mailbox.length > 320)
    return null;
  return mailbox.toLowerCase();
}

function senderOf(message) {
  const from = message?.from;
  return normalizeMailbox(
    typeof from === "string" ? from : (from?.address ?? from?.email),
  );
}

function providerId(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "." ||
    value === ".." ||
    Buffer.byteLength(value) > 256 ||
    /[/\\\p{Cc}]/u.test(value)
  )
    throw codedError("INVALID_REQUEST");
  return encodeURIComponent(value);
}

function context({
  home,
  logger,
  fetch: fetchImpl,
  baseUrl,
  env = process.env,
}) {
  const root = (
    baseUrl ??
    env.TLDR_AGENTMAIL_BASE_URL ??
    DEFAULT_AGENTMAIL_BASE_URL
  ).replace(/\/+$/, "");
  if (!validAgentmailRoot(root)) throw codedError("INVALID_REQUEST");
  let credentials;
  try {
    credentials = readOwnerCredentials({ home, logger });
  } catch (error) {
    if (error instanceof OwnerCredentialsError)
      throw codedError("CREDENTIAL_UNAVAILABLE");
    throw error;
  }
  return {
    ...credentials,
    owner: normalizeMailbox(credentials.ownerAddress),
    root,
    inbox: `${root}/inboxes/${providerId(credentials.inboxId)}`,
    fetchImpl: fetchImpl ?? globalThis.fetch,
    logger,
  };
}

// outbound POSTs that may have reached AgentMail are marked ambiguous.
async function call(
  ctx,
  {
    method = "GET",
    url,
    query,
    body,
    idempotencyKey,
    timeoutMs,
    outbound = false,
    event,
  },
) {
  const target = new URL(url);
  for (const [name, value] of Object.entries(query ?? {}))
    if (value !== undefined && value !== null && value !== "")
      target.searchParams.set(name, String(value));
  const headers = {
    authorization: `Bearer ${ctx.apiKey}`,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const startedAt = Date.now();
  let status = null;
  try {
    let response;
    try {
      response = await ctx.fetchImpl(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 15_000)),
      });
    } catch {
      throw codedError("BROKER_UNAVAILABLE", outbound);
    }
    status = response.status;
    if (status === 404) throw codedError("INVALID_REQUEST");
    if (status === 401 || status === 403)
      throw codedError("CREDENTIAL_UNAVAILABLE");
    if (status === 429 || status >= 500)
      throw codedError("PROVIDER_UNAVAILABLE", outbound);
    if (status < 200 || status >= 300) throw codedError("INVALID_REQUEST");
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        ctx.logger?.({ event, status, latency_ms: Date.now() - startedAt });
        return parsed;
      }
    } catch {
      // falls through to the malformed-response error below
    }
    throw codedError("PROVIDER_UNAVAILABLE", outbound);
  } catch (error) {
    ctx.logger?.({
      event,
      status,
      code: error.code,
      ambiguous: error.ambiguous === true,
      latency_ms: Date.now() - startedAt,
    });
    throw error;
  }
}

function deliveryOf(result) {
  if (
    typeof result.message_id !== "string" ||
    typeof result.thread_id !== "string"
  )
    throw codedError("PROVIDER_UNAVAILABLE", true);
  return { messageId: result.message_id, threadId: result.thread_id };
}

async function trustedParent(ctx, { parent, thread, timeoutMs }) {
  let message;
  try {
    message = await call(ctx, {
      url: `${ctx.inbox}/messages/${providerId(parent)}`,
      timeoutMs,
      event: "agentmail_validate_parent",
    });
  } catch (error) {
    // A parent the provider does not know is not a trusted parent.
    throw error.code === "INVALID_REQUEST"
      ? codedError("REPLY_PARENT_UNAUTHORIZED")
      : error;
  }
  if (message.thread_id !== thread || senderOf(message) !== ctx.owner)
    throw codedError("REPLY_PARENT_UNAUTHORIZED");
}

export async function localOutbound(
  { operation, payload, timeoutMs },
  deps = {},
) {
  const ctx = context(deps);
  const content = { text: payload.body };
  if (payload.html) content.html = payload.html;
  if (operation === "send_owner_message") {
    const body = { to: ctx.owner, ...content };
    if (payload.subject !== undefined) body.subject = payload.subject;
    return deliveryOf(
      await call(ctx, {
        method: "POST",
        url: `${ctx.inbox}/messages/send`,
        body,
        idempotencyKey: payload.idempotency_key,
        timeoutMs,
        outbound: true,
        event: "agentmail_send",
      }),
    );
  }
  const parent = payload.parent_message_id;
  await trustedParent(ctx, { parent, thread: payload.thread_id, timeoutMs });
  const delivery = deliveryOf(
    await call(ctx, {
      method: "POST",
      url: `${ctx.inbox}/messages/${providerId(parent)}/reply`,
      body: { to: [ctx.owner], ...content },
      idempotencyKey: payload.idempotency_key,
      timeoutMs,
      outbound: true,
      event: "agentmail_reply",
    }),
  );
  if (delivery.threadId !== payload.thread_id)
    throw codedError("PROVIDER_UNAVAILABLE", true);
  return delivery;
}

function boundedText(value) {
  const bytes = Buffer.from(typeof value === "string" ? value : "");
  if (bytes.length <= BODY_MAX_BYTES)
    return { text: bytes.toString("utf8"), truncated: false };
  return {
    text: bytes.subarray(0, BODY_MAX_BYTES).toString("utf8").replace(/�+$/, ""),
    truncated: true,
  };
}

function projectMessage(message) {
  const { text, truncated } = boundedText(
    message.extracted_text ?? message.text ?? message.body ?? message.preview,
  );
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.length
    : Number(message.attachment_count) || 0;
  return {
    messageId: message.message_id,
    threadId: message.thread_id,
    senderAuthorized: true,
    subject:
      typeof message.subject === "string"
        ? message.subject.slice(0, 998)
        : null,
    text,
    timestamp: message.timestamp,
    inReplyTo: message.in_reply_to ?? null,
    attachmentCount: Math.max(0, Math.min(100, attachments)),
    bodyTruncated: truncated,
  };
}

// Only owner-sent messages pass; others are listed as rejected, the way the
// broker never lets an unauthorized message into `messages`.
function splitByOwner(ctx, list) {
  const messages = [];
  const rejectedMessageIds = [];
  for (const message of list) {
    const complete = ["message_id", "thread_id", "timestamp"].every(
      (k) => typeof message?.[k] === "string",
    );
    if (
      complete &&
      senderOf(message) === ctx.owner &&
      !isRejectedInbound(message)
    )
      messages.push(projectMessage(message));
    else if (typeof message?.message_id === "string") {
      rejectedMessageIds.push(message.message_id);
      ctx.logger?.({
        event: "agentmail_inbound_rejected",
        message_id: message.message_id,
      });
    }
  }
  return { messages, rejectedMessageIds };
}

export async function localInbound(
  { operation, payload, timeoutMs },
  deps = {},
) {
  const ctx = context(deps);
  if (operation === "poll_bound_inbox") {
    const limit = Math.max(1, Math.min(25, Number(payload.limit) || 25));
    const result = await call(ctx, {
      url: `${ctx.inbox}/messages`,
      query: {
        after: payload.after,
        limit,
        ascending: "true",
        page_token: payload.cursor,
      },
      timeoutMs,
      event: "agentmail_poll",
    });
    const nextCursor = result.next_page_token ?? result.nextPageToken;
    return {
      ...splitByOwner(
        ctx,
        Array.isArray(result.messages) ? result.messages : [],
      ),
      nextCursor:
        typeof nextCursor === "string" && nextCursor ? nextCursor : null,
    };
  }
  if (operation === "get_bound_message") {
    const result = await call(ctx, {
      url: `${ctx.inbox}/messages/${providerId(payload.message_id)}`,
      timeoutMs,
      event: "agentmail_get_message",
    });
    return { ...splitByOwner(ctx, [result]), nextCursor: null };
  }
  const result = await call(ctx, {
    url: `${ctx.inbox}/threads/${providerId(payload.thread_id)}`,
    timeoutMs,
    event: "agentmail_get_thread",
  });
  return {
    ...splitByOwner(ctx, Array.isArray(result.messages) ? result.messages : []),
    nextCursor: null,
  };
}

// Status and setup state read the local file only. A valid file is "ready";
// no file is "unconfigured"; a loose or broken file fails closed.
function localState(deps) {
  try {
    const { ownerAddress } = readOwnerCredentials({
      home: deps.home,
      logger: deps.logger,
    });
    return { state: "ready", ownerAddress };
  } catch (error) {
    if (error?.code === "owner_credentials_missing")
      return { state: "unconfigured", ownerAddress: null };
    if (error instanceof OwnerCredentialsError)
      throw codedError("CREDENTIAL_UNAVAILABLE");
    throw error;
  }
}

export async function localStatus(deps = {}) {
  return localState(deps).state;
}

export async function localSetupState(deps = {}) {
  const { state, ownerAddress } = localState(deps);
  return Object.freeze({
    state,
    destination_masked: ownerAddress ? maskDestination(ownerAddress) : null,
    expires_at: null,
    verify_available_at: null,
    resend_available_at: null,
  });
}
