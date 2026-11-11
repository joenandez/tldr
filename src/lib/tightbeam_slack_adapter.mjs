import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SlackApiError, abortError } from "./slack_api.mjs";
import {
  lookupInboundThread,
  lookupThreadRootByConversation,
  lookupOutboundPost,
  recordOutboundPost,
} from "./slack_channel_map.mjs";
import {
  recreateSenderChannel,
  resolveSenderChannel,
} from "./slack_owner_channel.mjs";
import {
  claimDelivery,
  gate,
  leaseStart,
  postBudget,
  postDeadline,
  trackedFetch,
  writeBackoff,
  hasLeaseFields,
  messageText,
  timed,
  validClaim,
} from "./slack_delivery_claim.mjs";
import {
  noteOutboundAttempt,
  priorOutboundAttempt,
} from "./slack_outbound_attempt.mjs";
import { recordPosted } from "./slack_post_record.mjs";
import { resumeParts } from "./slack_overflow_resume.mjs";
import {
  LOST_CHANNEL_ERRORS,
  earlierRootTarget,
} from "./slack_post_lookup.mjs";
import { postInParts } from "./slack_post_parts.mjs";
import { withThreadLock } from "./slack_thread_lock.mjs";
import { clearThreadWorking } from "./slack_working.mjs";
import {
  UNSENT_OUTCOME,
  beforeWrite,
  complete,
  failureOutcome,
  release,
  releaseUnsent,
} from "./tightbeam_slack_settle.mjs";

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

async function resolveTarget(ctx, message) {
  const inbound = message.in_reply_to_message_id
    ? lookupInboundThread(ctx.home, message.in_reply_to_message_id)
    : null;
  if (inbound) return inbound;
  const root = lookupThreadRootByConversation(
    ctx.home,
    message.conversation_id,
  );
  if (root) return root;
  return { channelId: await resolveSenderChannel(ctx, message) };
}

const LOST_THREAD_NOTE = "(earlier thread was lost; replying here)";

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
  // Not awaited by postInParts: the receipt must not wait on Slack. clearWorking marks
  // the row terminal before its first await; the sweep re-clears if this is cut short.
  const onRoot = (root) =>
    Promise.resolve(clearWorking(ctx, root)).catch((error) =>
      ctx.logger({
        event: "slack_working_clear_crashed",
        status: "error",
        params: { channel: root.channelId, thread_ts: root.threadTs },
        result: { message: error.message, stack: error.stack },
      }),
    );
  const sending = { ...ctx, onRoot };
  try {
    // A reply into an existing thread already sits under its subject.
    const sent = (target.note ?? "") + (target.threadTs ? message.body : text);
    const posted = await postInParts(sending, target, sent);
    return { target, posted };
  } catch (error) {
    // A lost channel after the root posted cannot be re-posted without a second root.
    if (error.partial || !LOST_CHANNEL_ERRORS.has(error.slackError))
      throw error;
    const channelId = await recreateChannel(ctx, message, {
      lost: target.channelId,
      reason: error.slackError,
    });
    const note = target.threadTs ? `${LOST_THREAD_NOTE}\n` : "";
    const fresh = { channelId, note };
    // The note is part of the text a resume or a retry must split the same way.
    noteOutboundAttempt(ctx.home, ctx.deliveryId, fresh);
    return {
      target: fresh,
      posted: await postInParts(sending, fresh, note + text),
    };
  }
}

// The post is out: a thread's working indicator is done. Never fails the delivery.
// replayedTs: a replay passes its receipt's post ts, so a newer owner message is spared.
const clearWorking = (ctx, { channelId, threadTs }, postedTs) =>
  threadTs
    ? clearThreadWorking(
        ctx.slackOpts,
        { channelId, threadTs, postedTs },
        "replied",
      )
    : null;

// A delivery re-offered after its post succeeded (complete failed, or a crash)
// only needs completing: posting again would make a second Slack root (AC-10).
async function post(ctx, claim) {
  const receipt = lookupOutboundPost(ctx.home, claim.delivery_id);
  if (receipt) {
    // Out of time with parts still to send: nothing new can go out, so it does not count.
    if (receipt.sent !== null && ctx.signal?.aborted)
      throw abortError("claim", ctx.signal, false);
    ctx.logger({
      event: "slack_delivery_post_replayed",
      status: "info",
      params: { delivery_id: claim.delivery_id, parts_sent: receipt.sent },
      result: { channel: receipt.channelId, ts: receipt.ts },
    });
    const posted = recordPosted(ctx, claim, { ...receipt, late: true });
    await clearWorking(ctx, receipt, receipt.ts);
    if (receipt.sent !== null) await resumeParts(ctx, claim, receipt);
    return posted;
  }
  // Out of time and nothing sent: skip the slow lookups, release at once (ac-jfv.87).
  if (ctx.signal?.aborted) throw abortError("claim", ctx.signal);
  // A retry keeps a post it finds where an earlier try may have posted; else it posts where
  // the maps point now (they may have moved), and sendAndKeep notes that place too.
  const prior = priorOutboundAttempt(ctx.home, claim.delivery_id);
  const earlier = prior
    ? await beforeWrite(ctx, earlierRootTarget(ctx, prior))
    : null;
  const first =
    earlier ??
    (await beforeWrite(
      ctx,
      timed(ctx, "resolve_ms", () => resolveTarget(ctx, claim.message)),
    ));
  let started = false;
  // The post and the row's clear take their turn with a failure notice in this thread.
  const turn = withThreadLock({ home: ctx.home, ...first }, () => {
    // A turn that comes after the deadline must not write: its claim is already released.
    if (ctx.signal?.aborted) throw abortError("claim", ctx.signal);
    started = true;
    return sendAndKeep(ctx, claim, { first, prior });
  });
  return beforeWrite(ctx, turn, () => !started);
}

// The first post of a delivery and its receipt, inside the thread's turn.
async function sendAndKeep(base, claim, { first, prior }) {
  // Noted before the first send: a retry, or a daemon that died mid-post, then looks for the
  // earlier try in Slack, where it went, before it sends again.
  noteOutboundAttempt(base.home, claim.delivery_id, first);
  const ctx = { ...base, priorAttemptAt: prior?.startedAt ?? null };
  // Receipt first: a crash after it re-applies the maps instead of reposting.
  // The root's post already cleared the indicator (postInParts onRoot).
  const keep = (record) =>
    timed(ctx, "record_ms", async () => {
      recordOutboundPost(ctx.home, {
        deliveryId: claim.delivery_id,
        ...record,
      });
      return recordPosted(ctx, claim, record);
    });
  try {
    const { target, posted } = await timed(ctx, "slack_ms", () =>
      sendWithRecovery(ctx, claim.message, first),
    );
    return keep({
      channelId: target.channelId,
      ts: posted.ts,
      threadTs: target.threadTs,
      late: posted.recovered,
    });
  } catch (error) {
    // The root is out: map it and keep the receipt so no retry posts a second root.
    if (error.partial) await keep(error.partial);
    throw error;
  }
}

async function handleFailure(ctx, claim, error) {
  const slack = error instanceof SlackApiError;
  const outcome = failureOutcome(ctx, error);
  ctx.logger({
    event: "slack_delivery_failed",
    status: "error",
    params: { delivery_id: claim.delivery_id, method: error.method ?? null },
    result: {
      slack_error: error.slackError ?? null,
      http_status: error.httpStatus ?? null,
      outcome,
      parts_sent: error.partial?.sent,
      message: String(error?.message ?? error),
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
  if (outcome === UNSENT_OUTCOME) return releaseUnsent(ctx, claim, error);
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
  ctx.sent = false;
  try {
    const posted = await post(ctx, claim);
    rmSync(ctx.backoffPath, { force: true });
    const bad = await timed(ctx, "complete_ms", () =>
      complete(ctx, claim, "delivered"),
    );
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

async function deliverOnce(ctx) {
  const gated = gate(ctx);
  if (gated) return gated;
  const started = Date.now();
  // Set on ctx itself, not a copy: trackedFetch marks ctx.sent on this same object.
  ctx.timings = {};
  const timings = () => ({ ...ctx.timings, total_ms: Date.now() - started });
  try {
    const claimStartedAt = Date.now();
    const claimed = await timed(ctx, "claim_ms", () => claimDelivery(ctx));
    if (claimed?.ok !== true) return { ...claimed, timings: timings() };
    const { claim } = claimed;
    ctx.deadline.start(
      postBudget(ctx, leaseStart(claim, ctx.leaseMs, claimStartedAt)),
    );
    const result = await (validClaim(claim)
      ? deliverClaim(
          Object.assign(ctx, { deliveryId: claim.delivery_id }),
          claim,
        )
      : rejectInvalidClaim(ctx, claim));
    return { ...result, timings: timings() };
  } catch (error) {
    // A tick that throws keeps its timings for the failed-tick event.
    if (error && typeof error === "object") error.timings = timings();
    throw error;
  } finally {
    ctx.deadline.stop();
  }
}

export function createTightbeamSlackAdapter({
  channel,
  home,
  credentials,
  fetchImpl,
  logger = stderrLogger,
  now = Date.now,
  signal: outerSignal,
  // The post's own deadline, started once the claim is in hand (ac-jfv.59).
  postTimeoutMs,
  leaseMs,
  postCallTimeoutMs,
  lookupSenderCwd,
  sleep: sleepOption,
} = {}) {
  if (
    !home ||
    REQUIRED_CHANNEL_METHODS.some(
      (name) => typeof channel?.[name] !== "function",
    )
  ) {
    throw new TypeError("Tightbeam Slack adapter dependencies are incomplete");
  }
  const deadline = postDeadline(outerSignal, postTimeoutMs);
  const { signal } = deadline;
  // An aborted tick ends a retry wait at once (it rejects), posting no more parts.
  const sleep = sleepOption ?? ((ms) => delay(ms, null, { signal }));
  const ctx = {
    sent: false, // a Slack request of the current claim was started
    channel,
    home,
    credentials,
    logger,
    now,
    signal,
    deadline,
    postTimeoutMs,
    leaseMs,
    postCallTimeoutMs,
    lookupSenderCwd,
    sleep,
    backoffPath: join(home, "slack", "outbound-backoff.json"),
  };
  // An aborted Slack call is retryable, so handleFailure releases the claim.
  ctx.slackOpts = {
    home,
    credentials,
    fetchImpl: trackedFetch(ctx, signal, fetchImpl),
    logger,
    signal,
  };

  return Object.freeze({ deliverOnce: () => deliverOnce(ctx) });
}
