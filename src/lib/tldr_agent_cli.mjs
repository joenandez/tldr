import { createProductionDependencies } from "./tldr_agent_runtime.mjs";
import {
  dispatchTldrAgentFollowup,
  FOLLOWUP_COMMANDS,
  FOLLOWUP_COMMAND_SCHEMAS,
  FOLLOWUP_CONTENT_VALUE_FLAGS,
  FOLLOWUP_ERROR_CATALOG,
} from "./tldr_agent_followup_cli.mjs";
import { dispatchOwnerCommand as dispatchOwnerCommandAdapter } from "./tldr_agent_owner_cli.mjs";
import { dispatchTldrAgentDiagnostics } from "./tldr_agent_diagnostic_cli.mjs";
import { createTldrAgentEnvelopeHelpers } from "./tldr_agent_cli_envelope.mjs";
import {
  AGENT_COMMANDS as BASE_AGENT_COMMANDS,
  COMMAND_SCHEMAS as BASE_COMMAND_SCHEMAS,
  OWNER_COMMANDS as BASE_OWNER_COMMANDS,
} from "./tldr_agent_cli_contract.mjs";
const OWNER_COMMANDS = BASE_OWNER_COMMANDS;
const AGENT_COMMANDS = Object.freeze([
  ...BASE_AGENT_COMMANDS,
  ...FOLLOWUP_COMMANDS,
]);
const COMMAND_SCHEMAS = Object.freeze({
  ...BASE_COMMAND_SCHEMAS,
  ...FOLLOWUP_COMMAND_SCHEMAS,
});

const ERROR_CATALOG = Object.freeze({
  RECIPIENT_FORBIDDEN: [
    "tldr; chooses the configured owner internally.",
    false,
  ],
  COMMAND_UNKNOWN: ["Unknown tldr; command.", false],
  ARGUMENT_INVALID: ["The command arguments are invalid.", false],
  NOT_CONFIGURED: ["tldr; is not configured.", false],
  RUNTIME_UNSUPPORTED: ["tldr; v1 requires macOS.", false],
  RUNTIME_NOT_READY: [
    "This agent runtime is not ready for exact-session replies.",
    false,
  ],
  RUNTIME_STORE_CORRUPT: ["tldr; stopped: runtime store corrupt.", false],
  UPDATE_UNAVAILABLE: ["No verified tldr; update is available.", false],
  DAEMON_QUIESCE_TIMEOUT: ["tldr; daemon did not stop in time.", true],
  DAEMON_UNAVAILABLE: ["tldr; could not safely restart.", true],
  SESSION_IDENTITY_MISSING: [
    "No durable invoking agent session was found.",
    false,
  ],
  THREAD_UNKNOWN: ["No trusted thread is available in this session.", false],
  THREAD_OWNER_MISMATCH: [
    "This thread belongs to another agent session.",
    false,
  ],
  UNREAD_REQUIRED: ["Read the pending owner message before replying.", false],
  PROVIDER_UNAVAILABLE: ["Messaging is temporarily unavailable.", true],
  PROVIDER_SEND_FAILED: ["The message could not be delivered.", true],
  ...FOLLOWUP_ERROR_CATALOG,
});
const FORBIDDEN_FLAGS = new Set([
  "--address",
  "--from",
  "--target",
  "--target-uri",
  "--recipient",
  "--reply-to",
  "--sender",
  "--to",
  "--cc",
  "--bcc",
  "--header",
  "--headers",
]);
const CONTENT_VALUE_FLAGS = new Set([
  "--subject",
  "--body",
  "--body-file",
  "--idempotency-key",
  "--thread",
  ...FOLLOWUP_CONTENT_VALUE_FLAGS,
]);

const { success, failure } = createTldrAgentEnvelopeHelpers(ERROR_CATALOG);

export function findForbiddenRecipientSelector(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string") continue;
    const flag = arg.split("=", 1)[0];
    if (FORBIDDEN_FLAGS.has(flag)) return arg;
    if (
      CONTENT_VALUE_FLAGS.has(flag) &&
      arg === flag &&
      typeof args[index + 1] === "string" &&
      !args[index + 1].startsWith("--")
    ) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && arg.includes("://")) return arg;
  }
  return null;
}

function commandFromArgs(args) {
  if (args[0] === "inbox" && args[1] === "get") {
    return { name: "inbox get", rest: args.slice(2) };
  }
  if (args[0] === "logs" && args[1] === "purge") {
    return { name: "logs purge", rest: args.slice(2) };
  }
  if (args[0] === "diagnostics" && ["create", "inspect"].includes(args[1])) {
    return { name: `diagnostics ${args[1]}`, rest: args.slice(2) };
  }
  if (["followup", "session"].includes(args[0]) && args[1])
    return { name: `${args[0]} ${args[1]}`, rest: args.slice(2) };
  return { name: args[0] || "setup", rest: args.slice(1) };
}

function parseFlags(args, allowed) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) return null;
    const [name, inline] = arg.split(/=(.*)/s, 2);
    if (!allowed.includes(name)) return null;
    if (
      [
        "--json",
        "--help",
        "--help-json",
        "--agent-safe",
        "--deep",
        "--foreground",
      ].includes(name)
    ) {
      if (inline !== undefined) return null;
      flags[name] = true;
      continue;
    }
    const value = inline ?? args[++index];
    if (typeof value !== "string" || value.length === 0) return null;
    flags[name] = value;
  }
  return flags;
}

function bodyFromFlags(flags, readBodyFile) {
  const inline = flags["--body"];
  const file = flags["--body-file"];
  if (Boolean(inline) === Boolean(file)) return null;
  try {
    return inline ?? readBodyFile(file);
  } catch {
    return null;
  }
}

function projectKernelError(result) {
  const code = result?.error?.code;
  if (code === "blocked_unread" || code === "blocked_unread_repeated") {
    return failure("UNREAD_REQUIRED", {
      remediation: "tldr-agent inbox get --thread <trusted-thread-id> --json",
    });
  }
  if (code === "owner_not_ready") {
    return failure("NOT_CONFIGURED", {
      remediation: "tldr-agent setup",
    });
  }
  if (code === "agentmail_unreachable") {
    return failure("PROVIDER_UNAVAILABLE");
  }
  return failure("PROVIDER_SEND_FAILED");
}

function safeStatus(result) {
  if (result?.ok === false) {
    return failure(result.code, {
      remediation:
        result.code === "NOT_CONFIGURED" ? "tldr-agent setup" : undefined,
    });
  }
  const data = result?.data ?? result ?? {};
  const remediation = ["tldr-agent setup", "tldr-agent doctor"].includes(
    data.remediation,
  )
    ? data.remediation
    : null;
  return success({
    readiness: data.readiness ?? "unknown",
    runtime: data.runtime ?? "unknown",
    daemon: data.daemon ?? "unknown",
    ...(remediation ? { remediation } : {}),
  });
}

function dispatchOwnerCommand(name, rest, deps) {
  return dispatchOwnerCommandAdapter({
    name,
    rest,
    deps,
    schemas: COMMAND_SCHEMAS,
    parseFlags,
    success,
    failure,
  });
}

function ownershipFailure(ownership, sessionId) {
  if (!ownership?.ok) return "THREAD_OWNER_MISMATCH";
  if (
    ownership.first_reply ||
    ownership.override ||
    ownership.owner_session_id !== sessionId
  ) {
    return ownership.owner_session_id
      ? "THREAD_OWNER_MISMATCH"
      : "THREAD_UNKNOWN";
  }
  return null;
}

async function dispatchSend(name, rest, deps) {
  const flags = parseFlags(rest, COMMAND_SCHEMAS[name]);
  if (!flags) return failure("ARGUMENT_INVALID");
  const body = bodyFromFlags(flags, deps.readBodyFile);
  if (body === null) return failure("ARGUMENT_INVALID");
  if (name === "send" && !flags["--subject"]) {
    return failure("ARGUMENT_INVALID");
  }
  const context = await deps.resolveContext();
  if (context?.runtimeUnsupported) return failure("RUNTIME_UNSUPPORTED");
  if (!context?.owner) {
    return failure("NOT_CONFIGURED", { remediation: "tldr-agent setup" });
  }
  if (!context?.sessionId) return failure("SESSION_IDENTITY_MISSING");
  if (context.runtimeReady === false) {
    return failure("RUNTIME_NOT_READY", { remediation: "tldr-agent doctor" });
  }

  const threadId = flags["--thread"];
  if (name === "reply") {
    if (!threadId) return failure("THREAD_UNKNOWN");
    const ownership = await deps.assertReplyOwnership({
      scope: context.scope,
      threadId,
      sessionId: context.sessionId,
    });
    const ownershipError = ownershipFailure(ownership, context.sessionId);
    if (ownershipError) return failure(ownershipError);
  }

  const result = await deps.dispatchMessage({
    kind: name === "send" ? "new" : "reply",
    tldrAgentReplyCandidate: name === "reply",
    owner: context.owner,
    sessionId: context.sessionId,
    scope: context.scope,
    threadId: threadId ?? null,
    subject: flags["--subject"] ?? null,
    body,
    idempotencyKey: flags["--idempotency-key"] ?? null,
  });
  if (!result?.ok) return projectKernelError(result);
  if (result.data?.outbound_guard?.suppressed === true) {
    return failure("PROVIDER_SEND_FAILED");
  }
  const messageId = result.data?.message_id ?? result.data?.message?.message_id;
  return success({ message_id: messageId ?? null, status: "sent" });
}

async function dispatchInbox(rest, deps) {
  const flags = parseFlags(rest, COMMAND_SCHEMAS["inbox get"]);
  if (!flags) return failure("ARGUMENT_INVALID");
  const context = await deps.resolveContext();
  const threadId = flags["--thread"];
  if (context?.runtimeUnsupported) return failure("RUNTIME_UNSUPPORTED");
  if (!context?.sessionId) return failure("SESSION_IDENTITY_MISSING");
  if (!threadId) return failure("THREAD_UNKNOWN");
  const ownership = await deps.assertReplyOwnership({
    scope: context.scope,
    threadId,
    sessionId: context.sessionId,
  });
  const ownershipError = ownershipFailure(ownership, context.sessionId);
  if (ownershipError) return failure(ownershipError);
  const pending = await deps.resolvePendingMessage({
    scope: context.scope,
    threadId,
    sessionId: context.sessionId,
  });
  if (!pending?.ok || !pending.messageId) return failure("THREAD_UNKNOWN");
  const result = await deps.getInboxMessage({
    scope: context.scope,
    messageId: pending.messageId,
  });
  if (!result?.ok) return failure("THREAD_UNKNOWN");
  return success({
    message_id: result.data?.message_id ?? null,
    subject: result.data?.subject ?? null,
    body: result.data?.body ?? "",
    status: "read",
  });
}

export async function dispatchTldrAgent(args = [], dependencies = {}) {
  if (findForbiddenRecipientSelector(args)) {
    return failure("RECIPIENT_FORBIDDEN");
  }
  const { name, rest } = commandFromArgs(args);
  if (![...AGENT_COMMANDS, ...OWNER_COMMANDS].includes(name)) {
    return failure("COMMAND_UNKNOWN");
  }
  const deps = { ...createProductionDependencies(), ...dependencies };
  if (name === "send" || name === "reply") {
    return dispatchSend(name, rest, deps);
  }
  if (name === "inbox get") return dispatchInbox(rest, deps);
  if (
    name === "logs" ||
    name === "logs purge" ||
    name === "diagnostics create" ||
    name === "diagnostics inspect"
  ) {
    return dispatchTldrAgentDiagnostics({
      name,
      rest,
      deps,
      schema: COMMAND_SCHEMAS[name],
      parseFlags,
      success,
      failure,
    });
  }
  if (FOLLOWUP_COMMANDS.includes(name)) {
    return dispatchTldrAgentFollowup(name, rest, deps, {
      parseFlags,
      success,
      failure,
    });
  }
  if (name === "status") {
    const flags = parseFlags(rest, COMMAND_SCHEMAS.status);
    if (!flags) return failure("ARGUMENT_INVALID");
    if (!flags["--agent-safe"]) return dispatchOwnerCommand(name, rest, deps);
    return safeStatus(await deps.getAgentSafeStatus());
  }
  if (OWNER_COMMANDS.includes(name))
    return dispatchOwnerCommand(name, rest, deps);
  return failure("ARGUMENT_INVALID");
}

export function renderTldrAgentHelp(command = null, { json = false } = {}) {
  if (command && COMMAND_SCHEMAS[command]) {
    const schema = {
      product: "tldr;",
      command: `tldr-agent ${command}`,
      flags: COMMAND_SCHEMAS[command],
    };
    if (json) return `${JSON.stringify(schema, null, 2)}\n`;
    return `Usage: ${schema.command} ${schema.flags.join(" ")}\n`;
  }
  const schema = {
    product: "tldr;",
    command: "tldr-agent",
    owner_commands: OWNER_COMMANDS,
    agent_commands: AGENT_COMMANDS,
  };
  if (json) return `${JSON.stringify(schema, null, 2)}\n`;
  return [
    "tldr;",
    "",
    "Usage: tldr-agent <command>",
    "",
    `Owner commands: ${OWNER_COMMANDS.join(", ")}`,
    `Agent commands: ${AGENT_COMMANDS.join(", ")}`,
    "",
  ].join("\n");
}
