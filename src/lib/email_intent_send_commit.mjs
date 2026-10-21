// Commits a reviewed send draft as one Tightbeam `agent send --to user
// --channel email` message. The draft id is the command's supplied actionId,
// which Tightbeam's commitKey turns into the message idempotency key, so a
// repeated or crash-retried confirm replays the same message. The raw
// --idempotency-key flag is not accepted by agent commands and is not used;
// no Tightbeam protocol, op, or agent-command flag changes here.
import {
  loadAgentSession,
  parseAgentCommand,
  runAgentCommand,
} from "../../messaging/src/cli/agent_commands.mjs";
import { readHookCredentials } from "../../messaging/src/cli/hook_credentials.mjs";
import { connect } from "../../messaging/src/client/client.mjs";
import { resolveStateRoot } from "../../messaging/src/protocol/state_root_location.mjs";

export const DRAFT_SEND_REASON =
  "Send the retained email request the user reviewed and confirmed";

export function draftSendCommand(draft) {
  return parseAgentCommand(
    [
      "send",
      "--to",
      "user",
      "--subject",
      draft.subject,
      "--reason",
      DRAFT_SEND_REASON,
      "--body",
      draft.content,
      "--channel",
      "email",
      "--no-reply",
    ],
    { actionId: draft.id },
  );
}

// The same app handshake the Tightbeam CLI performs with the hook credentials.
async function openHookClient(stateRoot) {
  const credentials = readHookCredentials(stateRoot);
  if (!credentials?.app_id || !credentials?.app_secret) {
    throw Object.assign(
      new Error("Tightbeam is not bootstrapped for agent sessions"),
      {
        code: "session_unavailable",
      },
    );
  }
  const client = await connect(stateRoot);
  try {
    await client.handshake({
      appId: credentials.app_id,
      credential: { kind: "app", app_secret: credentials.app_secret },
    });
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}

function sendOutcome(result) {
  return {
    message_id: result.message_id,
    conversation_id: result.conversation_id,
    outcome: result.outcome,
    channel_deliveries: (result.channel_deliveries ?? []).map(
      ({ selector, state }) => ({
        selector,
        state,
      }),
    ),
  };
}

// The key is derived from the draft id and the unchanged invocation, never the
// session, so Tightbeam raises idempotency_collision only when a message
// under this draft's key already exists with a different payload
// (lifecycle_transition.mjs findIdempotentReplay). A retry from a later
// session opens a new conversation and lands here: the draft was committed.
const ALREADY_COMMITTED = Object.freeze({
  message_id: null,
  conversation_id: null,
  outcome: "already_committed",
  channel_deliveries: [],
});

function preserveCodedJsonError(error) {
  const coded = error?.error;
  if (
    error?.ok !== false ||
    typeof coded?.code !== "string" ||
    typeof coded?.message !== "string"
  ) {
    return error;
  }
  return Object.assign(new Error(coded.message), { code: coded.code });
}

export function createTightbeamDraftSender({
  env = process.env,
  stateRoot = resolveStateRoot({ env }),
  loadSession = () => loadAgentSession(stateRoot, { env }),
  openClient = () => openHookClient(stateRoot),
} = {}) {
  return async function commitSend(draft) {
    const command = draftSendCommand(draft);
    const session = loadSession();
    const client = await openClient();
    try {
      return sendOutcome(await runAgentCommand(client, session, command));
    } catch (error) {
      error = preserveCodedJsonError(error);
      if (error?.code !== "idempotency_collision") throw error;
      return ALREADY_COMMITTED;
    } finally {
      await client.close();
    }
  };
}
