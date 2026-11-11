import { AgentCommandError } from "../../messaging/src/cli/agent_commands.mjs";
import { readHookCredentials } from "../../messaging/src/cli/hook_credentials.mjs";
import { prepareNewAgent } from "../../messaging/src/cli/new_agent.mjs";
import { resolveStateRoot } from "../../messaging/src/protocol/state_root_location.mjs";
import { openHookClient } from "./email_intent_send_commit.mjs";
import {
  THREAD_PREPARING,
  lookupChannelAgent,
  lookupThreadLaunch,
  lookupThreadRoot,
  recordThreadLaunch,
  recordThreadRoot,
} from "./slack_channel_map.mjs";
import { launchedEndpoint, leftMs, nowIso } from "./slack_inbound_legacy.mjs";

// A Slack top-level post starts its session the way `agent send --to
// academy:<name>` does: register the `<runtime>:<cwd>` principal and a
// sessionless placeholder endpoint that carries the Academy agent name. The
// caller commits the post to that endpoint; Tightbeam's resumer then runs
// `academy run <name> --runtime-once <runtime> -- <spawn template>`, and the
// child's SessionStart adopts the placeholder. Nothing here launches a process
// or writes a prompt: the first input is the tldr notification for the post.
//
// Resolves {ok, principal_id, endpoint_id}. {ok:false, code} is a refusal no
// retry fixes (folder missing, runtime not installed); {ok:false, retry:true}
// is a transport or daemon failure the next drain should try again.
export async function prepareSlackSession({
  agentName,
  launch,
  env = process.env,
  logger,
  openClient = openHookClient,
}) {
  const started = Date.now();
  const params = { agent: agentName, runtime: launch?.runtime };
  let client;
  try {
    const stateRoot = resolveStateRoot({ env });
    const authorityName =
      env.TIGHTBEAM_AUTHORITY || readHookCredentials(stateRoot)?.authority_name;
    if (!authorityName) {
      throw Object.assign(new Error("no authority to register under"), {
        code: "session_unavailable",
      });
    }
    client = await openClient(stateRoot);
    const target = await prepareNewAgent(
      client,
      { authority_name: authorityName },
      { runtime: launch.runtime, cwd: launch.cwd },
      {
        academyAgentName: agentName,
        installed: () => true,
        log: (fields) => logger?.(fields),
      }, // academy run resolves the runtime; the launchd daemon PATH is minimal
    );
    logger?.({
      event: "slack_session_prepared",
      status: "ok",
      params,
      result: { endpoint_id: target.endpoint_id },
      latency_ms: Date.now() - started,
    });
    return {
      ok: true,
      principal_id: target.principal_id,
      endpoint_id: target.endpoint_id,
    };
  } catch (error) {
    const refused = error instanceof AgentCommandError;
    logger?.({
      event: "slack_session_prepare_failed",
      status: "error",
      params,
      result: {
        code: error.code ?? null,
        refused,
        message: error.message,
        stack: error.stack,
      },
      latency_ms: Date.now() - started,
    });
    return refused
      ? { ok: false, code: error.code }
      : { ok: false, retry: true, code: error.code ?? "prepare_failed" };
  } finally {
    await client?.close();
  }
}

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

const LATE_TEXT = "I couldn't deliver this in time. Post again to retry.";

const didNotStart = (agent) =>
  `${agent.agentName} did not start in time. Post again to retry.`;

const NO_LAUNCH_TEXT = (name) =>
  `${name} can't start a session yet: no launch info. Run: tldr-agents slack channels add ${name} --launch-cwd <dir> --launch-runtime <claude-code|codex>`;

const paramsOf = (entry, agent) => ({
  channel: entry.channel,
  ts: entry.ts,
  agent: agent.agentName,
});

const sessionOf = (row) => ({
  principal_id: row.principal_id,
  endpoint_id: row.endpoint_id,
});

// When this post was first tried, stored before the placeholder exists (a
// THREAD_PREPARING row), so a prepare that keeps failing still hits the deadline.
function firstAttemptAt(ctx, { key, agent, known }) {
  if (known?.session_key === THREAD_PREPARING) return known.launched_at;
  const launchedAt = nowIso(ctx);
  recordThreadLaunch(ctx.home, {
    ...key,
    endpointId: null,
    principalId: null,
    runtime: agent.launch.runtime,
    launchedAt,
  });
  return launchedAt;
}

// A fresh placeholder from the shared new-session path, recorded before the
// commit so a retry reuses it and never prepares a second. {session, known} or
// {outcome}. A retryable refusal waits only until the launch deadline.
async function prepareSession(ctx, { entry, agent, tell, key, known }) {
  const { home, logger } = ctx;
  const firstAt = firstAttemptAt(ctx, { key, agent, known });
  const prepared = await (ctx.prepareSession ?? prepareSlackSession)({
    agentName: agent.agentName,
    launch: agent.launch,
    env: ctx.env,
    logger,
  });
  // A concurrent drain (a phase timeout does not cancel the one before it) may have
  // recorded this root's endpoint while we awaited: keep theirs, not a second one.
  const raced = prepared.ok && lookupThreadLaunch(home, key);
  if (raced?.endpoint_id) return { session: sessionOf(raced), known: raced };
  if (prepared.ok) {
    recordThreadLaunch(home, {
      ...key,
      endpointId: prepared.endpoint_id,
      principalId: prepared.principal_id,
      runtime: agent.launch.runtime,
      launchedAt: nowIso(ctx),
    });
    return { session: prepared, known: lookupThreadLaunch(home, key) };
  }
  logger?.({
    event: "slack_inbound_launch_failed",
    status: "error",
    params: paramsOf(entry, agent),
    result: { code: prepared.code, retry: prepared.retry === true },
  });
  return {
    outcome: prepared.retry
      ? await retryOrFail(ctx, {
          entry,
          agent,
          tell,
          launchedAt: firstAt,
          code: prepared.code,
        })
      : await tell(`Couldn't start ${agent.agentName}: ${prepared.code}`),
  };
}

// The session a root already has, from its launch row: an endpoint an earlier
// drain recorded, or, for a root launched before the upgrade (a provider id, no
// endpoint), the legacy resolver's answer and its durable deadline, instead of a
// second session. The row is never overwritten until resolved. {session, known},
// {outcome}, or null: no row, a never-prepared one, or an old session that is gone.
async function recordedSession(ctx, { agent, tell, key, known }) {
  if (!known || known.session_key === THREAD_PREPARING) return null;
  const found = await launchedEndpoint(ctx, known, key);
  if (found.endpointId) {
    const row = lookupThreadLaunch(ctx.home, key);
    return { session: sessionOf(row), known: row };
  }
  const waiting = found.retry || leftMs(ctx, known.launched_at) > 0;
  return waiting || found.expired
    ? { outcome: waiting ? "retry" : await tell(didNotStart(agent)) }
    : null;
}

// {session} for the post's placeholder: the one recorded by an earlier drain,
// else a fresh one. Else {outcome}.
async function startSession(ctx, { entry, agent, tell }) {
  const key = { channelId: entry.channel, rootTs: entry.ts };
  const known = lookupThreadLaunch(ctx.home, key);
  const recorded = await recordedSession(ctx, { agent, tell, key, known });
  if (recorded) return recorded;
  if (agent.launch)
    return prepareSession(ctx, { entry, agent, tell, key, known });
  ctx.logger?.({
    event: "slack_inbound_no_launch_spec",
    status: "ok",
    params: paramsOf(entry, agent),
  });
  return { outcome: await tell(NO_LAUNCH_TEXT(agent.agentName)) };
}

// A retry within the launch deadline stays a retry; past it the post fails
// once, in its thread, and the drain moves on.
async function retryOrFail(ctx, { entry, agent, tell, launchedAt, code }) {
  const left = leftMs(ctx, launchedAt);
  if (left > 0) return "retry";
  ctx.logger?.({
    event: "slack_inbound_launch_failed",
    status: "error",
    params: paramsOf(entry, agent),
    result: { code, left_ms: left },
  });
  return tell(didNotStart(agent));
}

// A thread reply whose root has no reply binding yet but was started by name
// goes to that session's endpoint only (the placeholder until its first
// SessionStart): untargeted, the bridge fans out to every session of the agent.
// {route} to send, {outcome} to stop here (retry, or told it was not delivered
// in time), {} to hint.
export async function targetLaunchedThread(ctx, route, tell) {
  const key = { channelId: route.channelId, rootTs: route.threadTs };
  const launched =
    route.kind === "commit" &&
    !route.newRoot &&
    lookupThreadLaunch(ctx.home, key);
  if (!launched) return { route };
  const { endpointId, retry, expired } = await launchedEndpoint(
    ctx,
    launched,
    key,
  );
  ctx.logger?.({
    event: "slack_inbound_thread_reply_targeted",
    status: "ok",
    params: { channel: route.channelId, ts: route.ts },
    result: { targeted: Boolean(endpointId), retry: Boolean(retry) },
  });
  if (retry || expired)
    return { outcome: retry ? "retry" : await tell(LATE_TEXT) };
  return endpointId
    ? { route: { ...route, targetEndpointId: endpointId } }
    : {};
}

// Top-level post (or welcome-thread reply) in a named agent's channel: register
// a placeholder for a new session of that agent, then commit the post to it.
// The daemon's resumer starts the session; its first input is the tldr
// notification for this post, the same block any session gets.
export async function deliverByName(args) {
  const { ctx, entry, agent, eventId, deliver } = args;
  const started = await startSession(ctx, args);
  if (!started.session) return started.outcome;
  const { session, known } = started;
  const agentName = agent.agentName;
  const retry = (code) =>
    retryOrFail(ctx, { ...args, launchedAt: known.launched_at, code });
  const plan = await planRoute(ctx, { entry, agentName, session });
  if (!plan.route) return retry(plan.reason);
  const outcome = await deliver({ ctx, entry, route: plan.route, eventId });
  ctx.logger?.({
    event: "slack_inbound_routed_by_name",
    status: outcome === "retry" ? "error" : "ok",
    params: paramsOf(entry, agent),
    result: { endpoint_id: session.endpoint_id, outcome },
  });
  return outcome === "retry" ? retry("commit_retry") : outcome;
}
