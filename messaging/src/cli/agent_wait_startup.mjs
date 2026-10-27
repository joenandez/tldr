import { bindAgentCommand } from "./agent_commands.mjs";
import {
  agentWaitContext,
  cacheHandshakePendingReplyGuard,
} from "./agent_wait_context.mjs";

export function prepareAgentWaitStartup(session, command) {
  if (command.command !== "wait") return { command };
  const boundCommand = bindAgentCommand(session, command);
  return {
    command: boundCommand,
    agentWaitContext: agentWaitContext(session, boundCommand),
  };
}

export function cacheAgentWaitStartup(session, command, handshakeResult) {
  if (command.command === "wait") {
    cacheHandshakePendingReplyGuard(session, handshakeResult, command.actionId);
  }
}

export function agentWaitHandshakeError(error, context) {
  const unsupported = [
    "malformed_request",
    "unknown_field",
    "unsupported_field",
  ];
  if (context && unsupported.includes(error?.code)) {
    return Object.assign(
      new Error(
        "the Tightbeam daemon needs an update to support agent wait; update or repair the messaging daemon and retry",
      ),
      { code: "notification_wait_unavailable" },
    );
  }
  return error;
}
