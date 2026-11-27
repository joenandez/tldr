// `agent request --action-id`: the CLI side of a replay. The daemon is asked first (message.action_replay,
// read-only), so a retry that replays existing work resolves and registers no recipient and creates nothing.

/**
 * The notification channels a request names. A retry that replays must not need the channels to
 * be available now, so a failed selection falls back to the channels the caller typed and its error
 * is held for new work (lookupReplay throws it when nothing replays).
 */
export async function channelSelection(command, select) {
  if (command.notify !== "user") return { channels: null };
  try {
    return { channels: await select() };
  } catch (error) {
    const typed = command.channels.includes("all")
      ? []
      : [...new Set(command.channels)].sort();
    return { channels: typed.length > 0 ? typed : null, error };
  }
}

/**
 * What the commit and the lookup must agree on: the metadata (the notification channels, and the
 * `--to` as typed, which is what a replay compares) and the completion mode.
 */
export function requestShape(
  command,
  { channels: notificationChannels, error: channelError },
) {
  const completionMode = notificationChannels
    ? "delivery_confirmed"
    : command.completionMode;
  if (!notificationChannels && !command.explicitActionId)
    return { metadata: null, completionMode, channelError };
  return {
    completionMode,
    channelError,
    metadata: {
      tightbeam_agent: {
        ...(notificationChannels
          ? { notification_channels: notificationChannels }
          : {}),
        ...(command.explicitActionId ? { request_to: command.explicitTo } : {}),
      },
    },
  };
}

/**
 * Where the commit goes. An action-id request lets the commit create its conversation, so a replay
 * creates none; any other request uses the conversation made for it first.
 */
export async function commitAddress(command, target, conversationFor) {
  if (!command.explicitActionId)
    return { conversation_id: (await conversationFor()).conversation_id };
  return {
    destination_principal_id: target.principal_id,
    conversation_metadata: { subject: command.subject, reason: command.reason },
    action_id: command.explicitActionId,
  };
}

/** The work the action id already opened (`replay: true` plus the commit's replay result), or `{ replay: false }` (throwing a channel error held for new work). */
export async function lookupReplay(link, command, shape) {
  const found = command.explicitActionId
    ? await lookupAction(link, command, shape)
    : { replay: false };
  if (!found.replay && shape.channelError) throw shape.channelError;
  return found;
}

function lookupAction({ client, session }, command, shape) {
  return client.request("message.action_replay", {
    sender_principal_id: session.principal_id,
    action_id: command.explicitActionId,
    body: command.body,
    ...(shape.metadata ? { metadata: shape.metadata } : {}),
    conversation_metadata: { subject: command.subject, reason: command.reason },
    obligation_effect: {
      completion_mode: shape.completionMode,
      sender_endpoint_id: session.endpoint_id,
      process_generation: session.process_generation,
    },
  });
}

/** The CLI result of a request that replayed existing work. */
export const replayedRequest = (result) => ({
  outcome: "committed",
  message_id: result.message_id,
  conversation_id: result.conversation_id,
  work_id: result.root_id,
  thread_id: result.conversation_id,
  idempotent_replay: true,
  ...(result.replay_args_differ ? { replay_args_differ: true } : {}),
});
