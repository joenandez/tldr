import { postMessage } from "./slack_api.mjs";
import {
  hasProcessedEvent,
  lookupChannelAgent,
  lookupThreadRoot,
  markEventProcessed,
  recordInboundThread,
  recordThreadRoot,
} from "./slack_channel_map.mjs";
import {
  deliverByName,
  targetLaunchedThread,
} from "./slack_inbound_by_name.mjs";
import {
  parseEntry,
  readPending,
  resolveOwner,
  rotateIfDrained,
  sweepRotated,
  writeCursor,
} from "./slack_inbox.mjs";

// Tightbeam refusals that retrying cannot fix; anything else (transport,
// not_configured, unknown) is retried on the next drain. A retired or expired
// reply binding is permission_denied (channel_reply_publish.mjs).
const PERMANENT_CODES = new Set([
  "permission_denied",
  "malformed_request",
  "conversation_unknown",
  "conversation_closed",
  "idempotency_collision",
  "conversation_binding_conflict",
]);
const HINT_TEXT =
  "I can't route this. Reply in an agent's thread, or post in an agent's channel.";

// A thread reply goes to the session that owns its root (AC-20).
function threadRoute(home, entry) {
  const { channel: channelId, ts, thread_ts: threadTs } = entry;
  const common = { channelId, ts, threadTs };
  const root = lookupThreadRoot(home, { channelId, rootTs: threadTs });
  if (root?.replyBinding)
    return { ...common, kind: "reply", replyBinding: root.replyBinding };
  if (root?.conversationId)
    return { ...common, kind: "commit", conversationId: root.conversationId };
  return null;
}

const isTopLevel = ({ ts, thread_ts: rootTs }) => !rootTs || rootTs === ts;

function send(channel, route, text) {
  const id = `slack:${route.channelId}:${route.ts}`;
  if (route.kind === "reply")
    return channel.publishSlackReply({
      reply_binding: route.replyBinding,
      body: text,
      external_event_id: id,
    });
  return channel.commitSlackMessage({
    conversation_id: route.conversationId,
    body: text,
    idempotency_key: id,
    ...(route.targetEndpointId && {
      target_endpoint_id: route.targetEndpointId,
    }),
  });
}

async function hint(ctx, entry, text = HINT_TEXT) {
  const { home, credentials, fetchImpl, logger, signal } = ctx;
  try {
    await postMessage(
      {
        channel: entry.channel,
        text,
        thread_ts: entry.thread_ts ?? entry.ts,
      },
      { home, credentials, fetchImpl, logger, signal },
    );
  } catch (error) {
    logger?.({
      event: "slack_inbound_hint_failed",
      status: "error",
      params: { channel: entry.channel, ts: entry.ts },
      result: { slack_error: error.slackError ?? null },
    });
  }
}

async function hintAndMark({ ctx, entry, eventId }, text) {
  await hint(ctx, entry, text);
  markEventProcessed(ctx.home, eventId);
  return "hinted";
}

async function refused({ ctx, entry, route, result, eventId }) {
  const code = result.tightbeam_code;
  // A by-name target that vanished is a retry (the next drain re-checks), not a refusal.
  const permanent =
    PERMANENT_CODES.has(code) &&
    !(route.targetEndpointId && route.newRoot && code === "permission_denied");
  ctx.logger?.({
    event: "slack_inbound_send_failed",
    status: "error",
    params: { channel: route.channelId, ts: route.ts, kind: route.kind },
    result: {
      code: result.code,
      tightbeam_code: result.tightbeam_code ?? null,
      permanent,
    },
  });
  // A reused conversation may predate this target's session: open a new one.
  if (route.reusedConversation && code === "permission_denied")
    recordThreadRoot(ctx.home, {
      channelId: route.channelId,
      rootTs: route.ts,
    });
  return permanent ? hintAndMark({ ctx, entry, eventId }) : "retry";
}

async function deliver({ ctx, entry, route, eventId }) {
  const { home } = ctx;
  const result = await send(ctx.channel, route, entry.text ?? "");
  if (!result.ok) return refused({ ctx, entry, route, result, eventId });
  if (route.newRoot) {
    ctx.logger?.({
      event: "slack_inbound_published",
      status: "ok",
      params: { channel: route.channelId, ts: route.ts },
      result: {
        path: route.kind === "reply" ? "reply_binding" : "bridge_commit",
      },
    });
  }
  if (route.newRoot)
    recordThreadRoot(home, {
      channelId: route.channelId,
      rootTs: route.ts,
      conversationId: route.conversationId,
    });
  recordInboundThread(home, {
    messageId: result.message_id,
    channelId: route.channelId,
    threadTs: route.threadTs,
  });
  markEventProcessed(home, eventId);
  return route.kind === "reply" ? "published" : "committed";
}

async function deliverThreadReply(ctx, entry, eventId) {
  const planned = threadRoute(ctx.home, entry);
  const { route, outcome } = planned
    ? await targetLaunchedThread(ctx, planned)
    : {};
  if (outcome) return outcome;
  return route
    ? deliver({ ctx, entry, route, eventId })
    : hintAndMark({ ctx, entry, eventId });
}

// Returns one of: published, committed, hinted, skipped, pending, retry.
async function handle(ctx, entry, owner) {
  const eventId = entry.event_id ?? `slack:${entry.channel}:${entry.ts}`;
  if (entry.user !== owner || hasProcessedEvent(ctx.home, eventId))
    return "skipped";
  const agent = lookupChannelAgent(ctx.home, entry.channel);
  // Slack is for named agents only: a channel with no agent row routes nothing.
  if (!agent) {
    ctx.logger?.({
      event: "slack_inbound_unrouted",
      status: "ok",
      params: { channel: entry.channel, ts: entry.ts },
      result: { reason: "no_agent_channel" },
    });
    return hintAndMark({ ctx, entry, eventId });
  }
  // The welcome post says "reply in a thread, or post here": both mean the agent.
  const byName = isTopLevel(entry) || entry.thread_ts === agent.welcomeTs;
  const tell = (text) => hintAndMark({ ctx, entry, eventId }, text);
  return byName
    ? deliverByName({ ctx, entry, agent, eventId, deliver, tell })
    : deliverThreadReply(ctx, entry, eventId);
}

function outcomeFor(ctx, entry, owner) {
  if (!entry) return "skipped";
  // An aborted daemon phase stops the drain; the line is retried next tick.
  return ctx.signal?.aborted ? "retry" : handle(ctx, entry, owner);
}

// A launch still starting is waiting, not failing: ok stays true.
function stopDrain(counts, entry, outcome) {
  if (outcome === "retry") counts.ok = false;
  else counts.pending += 1;
  counts.stopped_at = `slack:${entry.channel}:${entry.ts}`;
}

async function drain(options) {
  const ctx = { ...options };
  const started = Date.now();
  const owner = resolveOwner(ctx);
  if (!owner) {
    ctx.logger?.({ event: "slack_inbound_not_ready", status: "skipped" });
    return Object.freeze({ ok: false, not_ready: true });
  }
  const counts = {
    ok: true,
    published: 0,
    committed: 0,
    hinted: 0,
    skipped: 0,
    pending: 0,
  };
  sweepRotated(ctx);
  for (const { raw, end } of readPending(ctx.home)) {
    const entry = parseEntry(raw);
    // lines must be handled in order; a retryable failure stops the drain
    // eslint-disable-next-line no-await-in-loop
    const outcome = await outcomeFor(ctx, entry, owner);
    if (outcome === "retry" || outcome === "pending") {
      stopDrain(counts, entry, outcome);
      break;
    }
    counts[outcome] += 1;
    writeCursor(ctx.home, end);
  }
  if (counts.ok) rotateIfDrained(ctx);
  ctx.logger?.({
    event: "slack_inbound_drained",
    status: counts.ok ? "ok" : "error",
    result: counts,
    latency_ms: Date.now() - started,
  });
  return Object.freeze(counts);
}

export function createSlackInboundLane(options) {
  return Object.freeze({ drainOnce: () => drain(options) });
}
