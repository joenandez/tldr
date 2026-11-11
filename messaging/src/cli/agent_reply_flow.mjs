// `agent reply` on tracked work (thread-followups A1/A2). A reply to a user
// request never closes it: while the ack is pending it is the ack, afterwards
// an `update` posted to the origin. Only `complete` closes. Once the work is
// closed a reply is a `none` follow-up with no reply wait, and `send --thread`
// uses the same commit (agent_follow_up.mjs).

import {
  AgentCommandError,
  commitKey,
  correspondenceResult,
  readChannelDeliveries,
  runWorkCommand,
  selectedOutboundChannels,
  withDeliveryWarning,
  workChain,
} from "./agent_commands.mjs";
import { tightbeamRecipeCommand } from "./package_context.mjs";
import { routeOpenTo, slackChannelAdded } from "../protocol/session_env.mjs";

// An explicit Slack choice is refused before any write unless the agent is named and added.
export function requireSlackAdded(name) {
  if (!routeOpenTo("slack", name)) {
    throw new AgentCommandError(
      "slack_named_agents_only",
      "Slack is for Academy agents. This session has no agent name.",
    );
  }
  if (!slackChannelAdded(name)) {
    throw new AgentCommandError(
      "slack_channel_not_added",
      `Slack is opt-in and ${name} has no Slack channel. Run: tldr-agents slack channels add ${name}`,
    );
  }
}

export const isClosedChain = (chain) =>
  Boolean(chain.resolution) || chain.status === "done";
const userChains = (chains, conversationId) =>
  chains.filter(
    (chain) =>
      chain.conversation_id === conversationId &&
      typeof chain.user_origin_message_id === "string",
  );

// The chain a conversation's follow-up answers: any open user request first, else the newest user request.
export async function conversationUserChain(client, conversationId) {
  const view = await client.request("lifecycle.view", {
    conversation_id: conversationId,
  });
  const chains = userChains(view.chains ?? [], conversationId);
  return {
    chains: view.chains ?? [],
    user:
      chains.find((chain) => !isClosedChain(chain)) ?? chains.at(-1) ?? null,
  };
}

// A user-origin message goes to every available route; the origin route always rides along because it alone confirms.
export async function allRoutesWithOrigin(client, session, originMessageId) {
  const origin = (
    await client.request("message.read", {
      message_id: originMessageId,
      principal_id: session.principal_id,
      endpoint_id: session.endpoint_id,
    })
  ).origin_channel_selector;
  // Companion copies are best-effort: an empty companion set must never block the origin answer.
  const selectors = await selectedOutboundChannels(client, []).catch(
    (error) => {
      if (error?.code === "no_outbound_channels" && typeof origin === "string")
        return [];
      throw error;
    },
  );
  return typeof origin === "string" && !selectors.includes(origin)
    ? [...selectors, origin].sort()
    : selectors;
}

// `none`, never a reply wait (await_reply: false is required), to every channel plus the origin's when the thread has one (ac-jfv.50).
export async function commitClosedFollowUp(
  client,
  session,
  { conversationId, inReplyTo, originMessageId, body, key },
) {
  return client.request("message.commit", {
    sender_principal_id: session.principal_id,
    conversation_id: conversationId,
    ...(inReplyTo ? { in_reply_to_message_id: inReplyTo } : {}),
    body,
    idempotency_key: key,
    ...(originMessageId
      ? {
          channel_selectors: await allRoutesWithOrigin(
            client,
            session,
            originMessageId,
          ),
        }
      : {}),
    await_reply: false,
    obligation_effect: {
      type: "none",
      sender_endpoint_id: session.endpoint_id,
      process_generation: session.process_generation,
    },
  });
}

const ackOwed = (chain) =>
  Boolean(chain.ack_due_at) &&
  !chain.ack_accepted_at &&
  Boolean(chain.ack_message_id);
// An ack already on its way to the user is not sent again (521.14).
export const ackPending = (chain) =>
  chain.status !== "done" && !chain.ack_in_flight && ackOwed(chain);
const stillOpenNote = (workId) =>
  `Request still open; close it with ${tightbeamRecipeCommand()} agent complete --work ${workId}.`;

async function replyChain({ client, session }, message) {
  if (message.root_obligation_id)
    return workChain(client, message.root_obligation_id);
  // Own outbound in a thread: the lifecycle view finds the request it answers.
  if (message.sender_principal_id !== session.principal_id) return null;
  return (await conversationUserChain(client, message.conversation_id)).user;
}

function guardUserReply(command, message, chain) {
  if (
    chain.conversation_id !== message.conversation_id ||
    (message.origin_channel_selector &&
      chain.user_origin_message_id !== command.messageId)
  ) {
    throw new AgentCommandError(
      "reply_target_mismatch",
      "this message is not the canonical user request for this work; reply to its original message or use agent complete --work with the notification work ID",
    );
  }
  if (
    command.noReply ||
    command.channels.some((selector) => selector !== "origin")
  ) {
    throw new AgentCommandError(
      "reply_policy_unavailable",
      `Reply to this user request without --no-reply or --channel. For a progress acknowledgement use agent ack --work ${chain.root_obligation_id} --body "<progress>"; for the final result use agent complete --work ${chain.root_obligation_id} --body "<result>".`,
    );
  }
}

async function closedFollowUp({ client, session }, command, chain) {
  const toOrigin = typeof chain.user_origin_message_id === "string";
  const result = await commitClosedFollowUp(client, session, {
    conversationId: chain.conversation_id,
    inReplyTo: command.messageId,
    originMessageId: toOrigin ? chain.user_origin_message_id : null,
    body: command.body,
    key: commitKey("reply", command, "message"),
  });
  const sent = correspondenceResult(result, {
    subject: chain.subject ?? null,
    noReply: true,
    workId: chain.root_obligation_id,
  });
  if (!toOrigin || command.waitDeliveryMs) return sent;
  return withDeliveryWarning({
    ...sent,
    ...(await readChannelDeliveries(client, result.message_id)),
  });
}

// Still-open user work: the ack while it is pending, else an update to the origin. Never a close.
async function continueOpenWork({ client, session, runOnce }, command, chain) {
  const workId = chain.root_obligation_id;
  const base = ackPending(chain)
    ? await runOnce(client, session, {
        ...command,
        command: "ack",
        workId,
      })
    : await runWorkCommand(
        client,
        session,
        { ...command, workId },
        chain,
        "update",
      );
  return { ...base, guidance: stillOpenNote(workId) };
}

/**
 * Routes a reply that lands on tracked work.
 * @returns {Promise<{result: object}|{chain: object|null}>} `result` when handled here; `chain` hands the already-read agent work chain back to the caller.
 */
export async function replyOnWork(io, command, message) {
  const chain = await replyChain(io, message);
  const closed = Boolean(chain) && isClosedChain(chain);
  const sameThread = chain?.conversation_id === message.conversation_id;
  const userWork =
    typeof chain?.user_origin_message_id === "string" ||
    Boolean(message.origin_channel_selector);
  if (closed && sameThread)
    return { result: await closedFollowUp(io, command, chain) };
  if (!chain || closed || !userWork) return { chain };
  guardUserReply(command, message, chain);
  return { result: await continueOpenWork(io, command, chain) };
}

const shortId = (id) =>
  String(id ?? "")
    .replace(/^cnv_/, "")
    .slice(0, 8);

/**
 * `send --thread` by a thread participant that is owed nothing and has no work left open
 * in the conversation: a `none` follow-up, to the user's origin channel when the thread has one.
 * Returns null while any work is open, so this never speaks into a live request.
 */
export async function sendClosedFollowUp({ client, session }, command, thread) {
  const { chains, user } = await conversationUserChain(
    client,
    thread.conversation_id,
  );
  if (chains.some((chain) => !isClosedChain(chain))) return null;
  // An agent-started user thread has no request: the header's newest user-facing message anchors the channel (521.13).
  const inReplyTo = user
    ? user.user_origin_message_id
    : (thread.user_anchor_message_id ?? null);
  const result = await commitClosedFollowUp(client, session, {
    conversationId: thread.conversation_id,
    inReplyTo,
    originMessageId: inReplyTo,
    body: command.body,
    key: commitKey("send", command, `follow-up:${thread.conversation_id}`),
  });
  const confirmation = [
    "Sent",
    "follow-up",
    ...(thread.subject?.trim() ? [thread.subject] : []),
    shortId(result.conversation_id),
    "no reply required",
  ].join(" · ");
  const sent = {
    outcome: "committed",
    message_id: result.message_id,
    conversation_id: result.conversation_id,
    thread_id: result.conversation_id,
    reply_policy: "no reply required",
    subject: thread.subject ?? null,
    thread_short_id: shortId(result.conversation_id),
    work_id: chains.at(-1)?.root_obligation_id ?? null,
    confirmation,
  };
  return user
    ? withDeliveryWarning({
        ...sent,
        ...(await readChannelDeliveries(client, result.message_id)),
      })
    : sent;
}
