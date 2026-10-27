import { randomUUID } from "node:crypto";

import {
  lookupChannelAgent,
  lookupThreadLaunch,
  lookupThreadRoot,
  recordThreadLaunch,
  recordThreadRoot,
} from "./slack_channel_map.mjs";
import {
  findLaunchedSession,
  launchAgentSession,
  waitForLaunchedSession,
} from "./slack_session_launch.mjs";

// In-drain wait for a fresh session to register; the drain shares a 35 s phase.
const REGISTER_WAIT_MS = 8_000;
// Past this since launch a still-unregistered session counts as failed.
const LAUNCH_DEADLINE_MS = 60_000;

// The post's own conversation: a retry finds the one recorded before the
// commit (a fresh one would trip idempotency_collision), else one is opened
// with the target's principal so the daemon accepts the target endpoint.
async function conversationFor(ctx, { entry, session, agentName }) {
  const { home, logger } = ctx;
  const rootTs = entry.ts;
  const channelId = entry.channel;
  const known = lookupThreadRoot(home, { channelId, rootTs })?.conversationId;
  if (known) return { conversationId: known, reused: true };
  const channelName = lookupChannelAgent(home, channelId)?.channelName;
  const opened = await ctx.channel.openSlackConversation({
    target_principal_id: session.principal_id,
    subject: `Slack #${channelName ?? agentName}`,
  });
  if (!opened.ok) {
    logger?.({
      event: "slack_inbound_open_failed",
      status: "error",
      params: { channel: channelId, ts: rootTs, agent: agentName },
      result: { code: opened.code, tightbeam_code: opened.tightbeam_code },
    });
    return { reason: opened.code };
  }
  const conversationId = opened.conversation_id;
  recordThreadRoot(home, { channelId, rootTs, conversationId });
  logger?.({
    event: "slack_inbound_conversation_opened",
    status: "ok",
    params: {
      channel: channelId,
      ts: rootTs,
      endpoint_id: session.endpoint_id,
    },
    result: { conversation_id: conversationId },
  });
  return { conversationId };
}

// {route} when the post can go now, else {reason} (the caller retries).
export async function planRoute(ctx, { entry, agentName, session }) {
  if (!session.principal_id) return { reason: "no_principal" };
  const opened = await conversationFor(ctx, { entry, session, agentName });
  if (opened.reason) return opened;
  return {
    route: {
      channelId: entry.channel,
      ts: entry.ts,
      // a welcome-thread reply answers in that thread
      threadTs: entry.thread_ts ?? entry.ts,
      conversationId: opened.conversationId,
      reusedConversation: opened.reused === true,
      newRoot: true,
      kind: "commit",
      targetEndpointId: session.endpoint_id,
    },
  };
}

const NO_LAUNCH_TEXT = (name) =>
  `${name} can't start a session yet: no launch info. Run: tldr-agents slack channels add ${name} --launch-cwd <dir> --launch-runtime <claude-code|codex> --launch-command <command>`;

const paramsOf = (entry, agent) => ({
  channel: entry.channel,
  ts: entry.ts,
  agent: agent.agentName,
});

// The uuid is recorded before the spawn: a drain retry reuses it, never
// relaunches. Null when a row already exists.
function claimLaunch(ctx, key, runtime) {
  const sessionKey = randomUUID();
  const inserted = recordThreadLaunch(ctx.home, {
    ...key,
    sessionKey,
    runtime,
    launchedAt: new Date((ctx.now ?? Date.now)()).toISOString(),
  });
  return inserted ? sessionKey : null;
}

// {launched} once the spawn started, else {outcome}.
async function startLaunch(ctx, { entry, agent, tell }) {
  const { home, logger } = ctx;
  const params = paramsOf(entry, agent);
  if (!agent.launch) {
    logger?.({ event: "slack_inbound_no_launch_spec", status: "ok", params });
    return { outcome: await tell(NO_LAUNCH_TEXT(agent.agentName)) };
  }
  const key = { channelId: entry.channel, rootTs: entry.ts };
  const sessionKey = claimLaunch(ctx, key, agent.launch.runtime);
  const spawned = sessionKey
    ? await (ctx.launchSession ?? launchAgentSession)({
        home,
        launch: agent.launch,
        sessionKey,
        env: ctx.env,
        logger,
      })
    : { ok: true };
  if (spawned.ok) return { launched: lookupThreadLaunch(home, key) };
  logger?.({
    event: "slack_inbound_launch_failed",
    status: "error",
    params,
    result: { code: spawned.code },
  });
  return {
    outcome: await tell(`Couldn't start ${agent.agentName}: ${spawned.code}`),
  };
}

const leftMs = (ctx, launched) =>
  Math.max(
    0,
    Date.parse(launched.launchedAt) +
      LAUNCH_DEADLINE_MS -
      (ctx.now ?? Date.now)(),
  );

const failureText = (name, code) =>
  code === "launch_exited"
    ? `${name} could not start. Post again to retry.`
    : `${name} did not start in time. Post again to retry.`;

// Any wait that is not ok retries until the launch deadline, then fails, so
// one stuck post never blocks the drain forever.
function waitVerdict(waited, left) {
  if (waited.code === "launch_exited") return "failed";
  return left > 0 ? "pending" : "failed";
}

async function failLaunch(ctx, { entry, agent, tell, code, left }) {
  ctx.logger?.({
    event: "slack_inbound_launch_failed",
    status: "error",
    params: paramsOf(entry, agent),
    result: { code, left_ms: left },
  });
  return tell(failureText(agent.agentName, code));
}

// {session} once registered; else {outcome}: the line is done or must wait.
async function awaitSession(ctx, { entry, agent, launched, tell }) {
  const { logger } = ctx;
  const left = leftMs(ctx, launched);
  const waited = await (ctx.waitForSession ?? waitForLaunchedSession)({
    home: ctx.home,
    runtime: launched.runtime,
    sessionKey: launched.sessionKey,
    env: ctx.env,
    listSessions: ctx.listSessions,
    timeoutMs: Math.min(REGISTER_WAIT_MS, left),
    logger,
  });
  if (waited.ok) return { session: waited.session };
  const verdict = waitVerdict(waited, left);
  if (verdict === "pending") {
    logger?.({
      event: "slack_inbound_launch_pending",
      status: "ok",
      params: paramsOf(entry, agent),
      result: { code: waited.code, left_ms: left },
    });
    // lookup errors retry the line; a plain registration timeout just waits
    const lookup = waited.code !== "launch_registration_timeout";
    return { outcome: lookup ? "retry" : "pending" };
  }
  const code = waited.code;
  return { outcome: await failLaunch(ctx, { entry, agent, tell, code, left }) };
}

// A thread reply whose root has no reply binding yet but was launched by name
// goes to that launched endpoint only: untargeted, the bridge fans out to every
// session of the agent. {route} to send, {outcome:"retry"} to wait, {} to hint.
export async function targetLaunchedThread(ctx, route) {
  const threadCommit = route.kind === "commit" && !route.newRoot;
  const launched =
    threadCommit &&
    lookupThreadLaunch(ctx.home, {
      channelId: route.channelId,
      rootTs: route.threadTs,
    });
  if (!launched) return { route };
  const found = await (ctx.findSession ?? findLaunchedSession)({
    home: ctx.home,
    runtime: launched.runtime,
    sessionKey: launched.sessionKey,
    env: ctx.env,
    listSessions: ctx.listSessions,
  });
  ctx.logger?.({
    event: "slack_inbound_thread_reply_targeted",
    status: found.status === "lookup_failed" ? "error" : "ok",
    params: { channel: route.channelId, ts: route.ts },
    result: { found: found.status },
  });
  if (found.status === "registered")
    return { route: { ...route, targetEndpointId: found.session.endpoint_id } };
  return found.status === "lookup_failed" ? { outcome: "retry" } : {};
}

// A session without a principal retries only until the launch deadline.
async function planFailure(ctx, { entry, agent, tell, plan, started }) {
  const left = leftMs(ctx, started.launched);
  if (plan.reason !== "no_principal" || left > 0) return "retry";
  const code = plan.reason;
  return failLaunch(ctx, { entry, agent, tell, code, left });
}

// Top-level post (or welcome-thread reply) in a named agent's channel: start a
// new session of that agent for it, then commit the post to that session's endpoint.
export async function deliverByName(args) {
  const { ctx, entry, agent, eventId, deliver } = args;
  const known = lookupThreadLaunch(ctx.home, {
    channelId: entry.channel,
    rootTs: entry.ts,
  });
  const started = known ? { launched: known } : await startLaunch(ctx, args);
  const waiting = started.launched
    ? await awaitSession(ctx, { ...args, launched: started.launched })
    : started;
  if (!waiting.session) return waiting.outcome;
  const { session } = waiting;
  const agentName = agent.agentName;
  const plan = await planRoute(ctx, { entry, agentName, session });
  if (!plan.route) return planFailure(ctx, { ...args, plan, started });
  const outcome = await deliver({ ctx, entry, route: plan.route, eventId });
  ctx.logger?.({
    event: "slack_inbound_routed_by_name",
    status: outcome === "retry" ? "error" : "ok",
    params: paramsOf(entry, agent),
    result: {
      endpoint_id: session.endpoint_id,
      session_key: started.launched.sessionKey,
      outcome,
    },
  });
  return outcome;
}
