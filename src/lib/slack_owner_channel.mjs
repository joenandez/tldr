import { join } from "node:path";
import { listTightbeamSessions } from "../../scheduling/src/lib/tightbeam_sessions.mjs";
import { withRouteLock } from "./email_disconnect_marker.mjs";
import { SlackApiError, createPrivateChannel, invite } from "./slack_api.mjs";
import {
  lookupAgentChannel,
  lookupChannelAgent,
  lookupLatestReplyBinding,
  lookupSenderAgent,
  lookupSenderChannel,
  recordAgentChannel,
  recordSenderAgent,
  recordSenderChannel,
} from "./slack_channel_map.mjs";
import { readSlackCredentials } from "./slack_credentials.mjs";

// The Owner channel's name and its one human member.

const slugOf = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

// The agent_channel key: `slack channels add <name>` must slug the same way.
export const agentChannelKey = slugOf;

// The lock `slack channels add` holds per name; creating a name's channel takes it too.
export const agentChannelLockPath = (home, key) =>
  join(home, `slack-channel-${key}.lock`);

// Under the daemon's 35 s phase; a busy lock is a retryable failure, so the claim is released.
const NAME_LOCK_TIMEOUT_MS = 20_000;
const NAME_BUSY = {
  code: "SLACK_CHANNEL_BUSY",
  message: "Another process is creating this agent's channel.",
};
const withNameLock = (ctx, key, fn) =>
  withRouteLock(agentChannelLockPath(ctx.home, key), fn, {
    timeoutMs: NAME_LOCK_TIMEOUT_MS,
    busy: NAME_BUSY,
  }).catch((error) => {
    if (error?.code !== NAME_BUSY.code) throw error;
    throw new SlackApiError({
      method: "conversations.create",
      slackError: "channel_busy",
      retryable: true,
    });
  });

// The sender's endpoint carries its Academy agent name, if it has one.
// endpoint.list is caller-scoped to the hooks' credentials, which the tightbeam
// CLI reads from the shared state root, so this sees hook endpoints.
export async function lookupSenderCwd(message) {
  if (typeof message.sender_session_id !== "string") return null;
  const found = await listTightbeamSessions({
    sessionId: message.sender_session_id,
    includeClosed: true,
  });
  if (!found.ok) throw new Error(found.error);
  return (
    found.sessions.find((s) => s.endpoint_id === message.sender_endpoint_id) ??
    found.sessions[0] ??
    null
  );
}

// Slack is for Academy agents only (2026-10-26). Permanent: the delivery completes failed.
const namedAgentsOnly = () =>
  new SlackApiError({
    method: "resolve_channel",
    slackError: "slack_named_agents_only",
  });

// A failed lookup is not "unnamed": the claim is released and retried.
async function senderSession(
  { lookupSenderCwd: lookup = lookupSenderCwd, logger },
  message,
) {
  try {
    return (await lookup(message)) ?? {};
  } catch (error) {
    logger({
      event: "slack_sender_name_lookup_failed",
      status: "warn",
      params: { sender_principal: message.sender_principal_id },
      result: { message: String(error?.message ?? error) },
    });
    throw new SlackApiError({
      method: "endpoint.list",
      slackError: "sender_lookup_failed",
      retryable: true,
    });
  }
}

// Invited until the channel's first root lands, so a failed first invite
// heals on the retry; after that, never again per send.
export async function inviteOwner(ctx, channelId) {
  if (lookupLatestReplyBinding(ctx.home, channelId)) return;
  const owner = (ctx.credentials ?? readSlackCredentials({ home: ctx.home }))
    ?.ownerUserId;
  if (owner) await invite(channelId, [owner], ctx.slackOpts);
}

// The sender's agent channel key, or "" when it has no Academy name.
// A named principal is looked up once, ever; an unnamed one on each send.
async function senderKey(ctx, message) {
  const principal = message.sender_principal_id;
  const cached = lookupSenderAgent(ctx.home, principal)?.agentName;
  if (cached) return cached;
  const session = await senderSession(ctx, message);
  const key = agentChannelKey(session.academy_agent_name);
  if (key) {
    recordSenderAgent(ctx.home, { senderPrincipal: principal, agentName: key });
  }
  return key;
}

// Creates the named agent's channel and maps it by sender and by name.
async function createChannel(ctx, message, key) {
  const principal = message.sender_principal_id;
  const tag = principal.replace(/^prn_/, "").slice(0, 6);
  // A lost (archived) channel keeps its name, so a second re-create needs a third name.
  // Slices keep every candidate within Slack's 80-char limit and distinct.
  const names = [
    key,
    `${key.slice(0, 73)}-${tag}`,
    `${key.slice(0, 64)}-${tag}-${ctx.now().toString(36)}`,
  ];
  let created;
  for (const name of names) {
    try {
      // eslint-disable-next-line no-await-in-loop -- names are tried in order.
      created = await createPrivateChannel(name, ctx.slackOpts);
      break;
    } catch (error) {
      if (error.slackError !== "name_taken" || name === names.at(-1)) {
        throw error;
      }
    }
  }
  // Mapped before the invite, so a failed invite's retry reuses this channel.
  const record = { channelId: created.id, channelName: created.name };
  recordSenderChannel(ctx.home, { senderPrincipal: principal, ...record });
  recordAgentChannel(ctx.home, { agentName: key, ...record });
  await inviteOwner(ctx, created.id);
  return created.id;
}

// Reuse-by-name repeats per send: debug only.
function logResolved(ctx, message, channel) {
  ctx.logger({
    event: "slack_channel_resolved",
    status: "debug",
    params: {
      path: "reuse_by_name",
      sender_principal: message.sender_principal_id,
    },
    result: { channel },
  });
}

async function useExisting(ctx, channelId) {
  await inviteOwner(ctx, channelId);
  return channelId;
}

// Slack is opt-in: only `slack channels add` makes an agent's channel. Permanent: the delivery completes failed.
const channelNotAdded = (key) => {
  const error = new SlackApiError({
    method: "resolve_channel",
    slackError: "slack_channel_not_added",
  });
  error.message = `slack channel for ${key} was never added: run tldr-agents slack channels add ${key}`;
  return error;
};

export async function resolveSenderChannel(ctx, message) {
  const known = lookupSenderChannel(ctx.home, message.sender_principal_id);
  // Already part of a named agent's channel: no tightbeam lookup per send.
  if (known && lookupChannelAgent(ctx.home, known.channelId)) {
    return useExisting(ctx, known.channelId);
  }
  const key = await senderKey(ctx, message);
  if (!key) throw namedAgentsOnly();
  const found = lookupAgentChannel(ctx.home, key);
  if (!found) throw channelNotAdded(key);
  logResolved(ctx, message, found.channelId);
  return useExisting(ctx, found.channelId);
}

// Another session's re-create may already have swapped the mapping: reuse it.
// It re-checks under the name lock so two re-creates make one channel.
export async function recreateSenderChannel(ctx, message, lost) {
  const key = await senderKey(ctx, message);
  if (!key) throw namedAgentsOnly();
  return withNameLock(ctx, key, async () => {
    const known = lookupAgentChannel(ctx.home, key);
    if (!known) throw channelNotAdded(key);
    if (known.channelId !== lost) return known.channelId;
    return createChannel(ctx, message, key);
  });
}
