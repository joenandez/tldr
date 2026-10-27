import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SlackApiError, postMessage } from "./slack_api.mjs";
import {
  lookupInboundThread,
  lookupOutboundPost,
  recordOutboundPost,
  recordStandingConversation,
  recordThreadRoot,
} from "./slack_channel_map.mjs";
import {
  recreateSenderChannel,
  resolveSenderChannel,
} from "./slack_owner_channel.mjs";

const DEFAULT_BACKOFF_MS = 30000;
const REQUIRED_CHANNEL_METHODS = [
  "claimSlackDelivery",
  "completeSlackDelivery",
  "releaseSlackDelivery",
];

export const stderrLogger = (entry) =>
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
  );

const isText = (value) => typeof value === "string";

function hasLeaseFields(claim) {
  return isText(claim?.delivery_id) && isText(claim.token);
}

function validMessage(message) {
  return (
    isText(message?.conversation_id) &&
    isText(message.body) &&
    isText(message.sender_principal_id)
  );
}

const hasBinding = (claim) =>
  isText(claim.reply_binding) && claim.reply_binding.length > 0;

function validClaim(claim) {
  return (
    hasLeaseFields(claim) &&
    isText(claim.message_id) &&
    hasBinding(claim) &&
    validMessage(claim.message)
  );
}

function messageText(message) {
  const subject = message.metadata?.subject;
  return isText(subject) && subject.length > 0
    ? `*${subject}*\n${message.body}`
    : message.body;
}

function backoffUntil(ctx) {
  try {
    return (
      Number(JSON.parse(readFileSync(ctx.backoffPath, "utf8")).notBefore) || 0
    );
  } catch {
    return 0;
  }
}

function writeBackoff(ctx, ms) {
  mkdirSync(dirname(ctx.backoffPath), { recursive: true });
  writeFileSync(ctx.backoffPath, JSON.stringify({ notBefore: ctx.now() + ms }));
}

async function resolveTarget(ctx, message) {
  const inbound = message.in_reply_to_message_id
    ? lookupInboundThread(ctx.home, message.in_reply_to_message_id)
    : null;
  if (inbound) return inbound;
  return { channelId: await resolveSenderChannel(ctx, message) };
}

const LOST_CHANNEL_ERRORS = new Set(["channel_not_found", "is_archived"]);
const LOST_THREAD_NOTE = "(earlier thread was lost; replying here)";

async function sendTo(ctx, { channelId, threadTs }, text) {
  return postMessage(
    { channel: channelId, text, thread_ts: threadTs },
    ctx.slackOpts,
  );
}

async function recreateChannel(ctx, message, { lost, reason }) {
  const channelId = await recreateSenderChannel(ctx, message, lost);
  ctx.logger({
    event: "slack_channel_recreated",
    status: "ok",
    params: {
      reason,
      sender_principal: message.sender_principal_id,
      lost_channel: lost,
    },
    result: { channel: channelId },
  });
  return channelId;
}

async function sendWithRecovery(ctx, message, target) {
  const text = messageText(message);
  try {
    // A reply into an existing thread already sits under its subject.
    const sent = target.threadTs ? message.body : text;
    return { target, posted: await sendTo(ctx, target, sent) };
  } catch (error) {
    if (!LOST_CHANNEL_ERRORS.has(error.slackError)) throw error;
    const channelId = await recreateChannel(ctx, message, {
      lost: target.channelId,
      reason: error.slackError,
    });
    const fresh = { channelId };
    const note = target.threadTs ? `${LOST_THREAD_NOTE}\n` : "";
    return { target: fresh, posted: await sendTo(ctx, fresh, note + text) };
  }
}

// Maps the posted root to its reply binding and the channel to its standing
// conversation; idempotent, so a replay re-applies it.
function recordPosted(ctx, claim, { channelId, ts, threadTs }) {
  const { home } = ctx;
  const conversationId = claim.message.conversation_id;
  recordThreadRoot(home, {
    channelId,
    rootTs: threadTs ?? ts,
    replyBinding: claim.reply_binding,
    messageId: claim.message_id,
    conversationId,
    deliveryId: claim.delivery_id,
  });
  recordStandingConversation(home, { channelId, conversationId });
  return { channel: channelId, ts, thread_ts: threadTs ?? null };
}

// A delivery re-offered after its post succeeded (complete failed, or a crash)
// only needs completing: posting again would make a second Slack root (AC-10).
async function post(ctx, claim) {
  const receipt = lookupOutboundPost(ctx.home, claim.delivery_id);
  if (receipt) {
    ctx.logger({
      event: "slack_delivery_post_replayed",
      status: "info",
      params: { delivery_id: claim.delivery_id },
      result: { channel: receipt.channelId, ts: receipt.ts },
    });
    return recordPosted(ctx, claim, receipt);
  }
  const first = await resolveTarget(ctx, claim.message);
  const { target, posted } = await sendWithRecovery(ctx, claim.message, first);
  const record = {
    channelId: target.channelId,
    ts: posted.ts,
    threadTs: target.threadTs,
  };
  // Receipt first: a crash after it re-applies the maps instead of reposting.
  recordOutboundPost(ctx.home, { deliveryId: claim.delivery_id, ...record });
  return recordPosted(ctx, claim, record);
}

// Returns null on success, else a failure result (logged, never thrown).
async function settle({ ctx, claim, call, event, extra }) {
  const { delivery_id, token } = claim;
  const result = await ctx.channel[call]({ delivery_id, token, ...extra });
  if (result?.ok === true) return null;
  ctx.logger({
    event,
    status: "error",
    params: { delivery_id },
    result: { code: result?.code ?? null },
  });
  return { ok: false, delivery_id, error: result?.code ?? event };
}

const complete = (ctx, claim, outcome) =>
  settle({
    ctx,
    claim,
    call: "completeSlackDelivery",
    event: "slack_delivery_complete_failed",
    extra: { outcome },
  });

const release = (ctx, claim) =>
  settle({
    ctx,
    claim,
    call: "releaseSlackDelivery",
    event: "slack_delivery_release_failed",
  });

async function handleFailure(ctx, claim, error) {
  const slack = error instanceof SlackApiError;
  const outcome = slack && error.permanent ? "failed" : "released";
  ctx.logger({
    event: "slack_delivery_failed",
    status: "error",
    params: { delivery_id: claim.delivery_id, method: error.method ?? null },
    result: {
      slack_error: error.slackError ?? null,
      http_status: error.httpStatus ?? null,
      outcome,
      message: slack ? undefined : String(error?.message ?? error),
    },
  });
  const base = { ok: false, delivery_id: claim.delivery_id };
  if (outcome === "failed") {
    const bad = await complete(ctx, claim, "failed");
    return (
      bad ?? {
        ...base,
        error: error.slackError,
        http_status: error.httpStatus,
        retryable: false,
      }
    );
  }
  const retryMs = error.retryAfterMs ?? DEFAULT_BACKOFF_MS;
  if (slack) writeBackoff(ctx, retryMs);
  const bad = await release(ctx, claim);
  if (!slack) throw error;
  return (
    bad ?? {
      ...base,
      error: error.slackError,
      http_status: error.httpStatus,
      retryable: true,
      released: true,
      retry_at: ctx.now() + retryMs,
    }
  );
}

async function rejectInvalidClaim(ctx, claim) {
  if (!hasLeaseFields(claim)) {
    throw Object.assign(
      new TypeError("Tightbeam returned an invalid claimed delivery"),
      { code: "invalid_claimed_delivery" },
    );
  }
  await complete(ctx, claim, "failed");
  return {
    ok: false,
    delivery_id: claim.delivery_id,
    error: "invalid_claimed_delivery",
    retryable: false,
  };
}

async function deliverClaim(ctx, claim) {
  try {
    const posted = await post(ctx, claim);
    rmSync(ctx.backoffPath, { force: true });
    const bad = await complete(ctx, claim, "delivered");
    if (bad) return { ...bad, retryable: true };
    return {
      ok: true,
      delivery_id: claim.delivery_id,
      message_id: claim.message_id,
      ...posted,
    };
  } catch (error) {
    return handleFailure(ctx, claim, error);
  }
}

// An aborted daemon phase or an active backoff claims nothing.
function gate(ctx) {
  if (ctx.signal?.aborted) return { ok: false, code: "aborted" };
  const notBefore = backoffUntil(ctx);
  return notBefore > ctx.now()
    ? { ok: false, code: "backoff", retry_at: notBefore }
    : null;
}

async function deliverOnce(ctx) {
  const gated = gate(ctx);
  if (gated) return gated;
  const claimed = await ctx.channel.claimSlackDelivery();
  if (claimed?.ok !== true) return claimed;
  const { claim } = claimed;
  return validClaim(claim)
    ? deliverClaim(ctx, claim)
    : rejectInvalidClaim(ctx, claim);
}

export function createTightbeamSlackAdapter({
  channel,
  home,
  credentials,
  fetchImpl,
  logger = stderrLogger,
  now = Date.now,
  signal,
  lookupSenderCwd,
} = {}) {
  if (
    !home ||
    REQUIRED_CHANNEL_METHODS.some(
      (name) => typeof channel?.[name] !== "function",
    )
  ) {
    throw new TypeError("Tightbeam Slack adapter dependencies are incomplete");
  }
  const ctx = {
    channel,
    home,
    credentials,
    logger,
    now,
    signal,
    lookupSenderCwd,
    backoffPath: join(home, "slack", "outbound-backoff.json"),
    // An aborted Slack call is retryable, so handleFailure releases the claim.
    slackOpts: { home, credentials, fetchImpl, logger, signal },
  };

  return Object.freeze({ deliverOnce: () => deliverOnce(ctx) });
}
