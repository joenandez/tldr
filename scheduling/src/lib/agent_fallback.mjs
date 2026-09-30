import { readIdentity } from "./identity.mjs";

export {
  agentFromCommand,
  ensureSessionCaptureArgs,
  managedAgentProcessDescriptor,
} from "./agent_process_descriptor.mjs";

const SUPPORTED_AGENTS = new Set(["claude", "codex"]);
const FALLBACK_POLICIES = new Set(["always", "never"]);

const CODEX_TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "web_fetch",
  "browser_action",
  "tool_call",
]);

function parseJsonLines(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* ignore non-JSON log lines */
    }
  }
  if (out.length === 0) {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("{")) {
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

export function extractAgentSessionId(agent, text) {
  const events = parseJsonLines(text);
  for (const event of events) {
    if (agent === "claude" && event.session_id) return event.session_id;
    if (agent === "codex" && event.thread_id) return event.thread_id;
  }
  return null;
}

function summarizeError(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 1000);
  try {
    return JSON.stringify(value).slice(0, 1000);
  } catch {
    return String(value).slice(0, 1000);
  }
}

function claudeSawToolCall(event) {
  const content = event?.message?.content;
  return (
    Array.isArray(content) && content.some((item) => item?.type === "tool_use")
  );
}

function codexSawToolCall(event) {
  const itemType = event?.item?.type || null;
  if (itemType && CODEX_TOOL_ITEM_TYPES.has(itemType)) return true;
  return (
    event?.type === "item.started" && itemType && itemType !== "agent_message"
  );
}

export function normalizeAgentName(value) {
  const agent = String(value || "").trim();
  return SUPPORTED_AGENTS.has(agent) ? agent : null;
}

export function fallbackFor(agent, defaults = readAgentDefaults()) {
  const normalized = normalizeAgentName(agent);
  if (!normalized) return null;
  const secondary = normalizeAgentName(defaults.secondary);
  const primary = normalizeAgentName(defaults.primary);
  if (secondary && secondary !== normalized) return secondary;
  if (primary && primary !== normalized) return primary;
  return normalized === "claude" ? "codex" : "claude";
}

export function readAgentDefaults(identity = readIdentity()) {
  const raw = identity?.agent_defaults || {};
  const primary = normalizeAgentName(raw.primary) || "codex";
  const secondary =
    normalizeAgentName(raw.secondary) ||
    (primary === "codex" ? "claude" : "codex");
  const fallbackPolicy = FALLBACK_POLICIES.has(raw.fallback_policy)
    ? raw.fallback_policy
    : "always";
  return {
    primary,
    secondary:
      secondary === primary
        ? primary === "codex"
          ? "claude"
          : "codex"
        : secondary,
    fallback_policy: fallbackPolicy,
  };
}

export function validateAgentDefaults(value) {
  const defaults = value || {};
  const primary = normalizeAgentName(defaults.primary);
  const secondary = normalizeAgentName(defaults.secondary);
  const policy = defaults.fallback_policy || "always";
  if (!primary)
    return {
      ok: false,
      error: "agent_defaults.primary must be claude or codex",
    };
  if (!secondary)
    return {
      ok: false,
      error: "agent_defaults.secondary must be claude or codex",
    };
  if (primary === secondary)
    return {
      ok: false,
      error: "agent_defaults primary and secondary must differ",
    };
  if (!FALLBACK_POLICIES.has(policy))
    return {
      ok: false,
      error: "agent_defaults.fallback_policy must be always or never",
    };
  return { ok: true, value: { primary, secondary, fallback_policy: policy } };
}

function collectPositionals(args, valueOptions) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === "--") {
      out.push(...args.slice(i + 1).map(String));
      break;
    }
    if (valueOptions.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

export function extractAgentPrompt({
  agent,
  args = [],
  stdinText = null,
} = {}) {
  if (typeof stdinText === "string" && stdinText.trim()) return stdinText;
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (agent === "codex") {
    const execIdx = argv.findIndex((arg) => arg === "exec" || arg === "e");
    const scan = execIdx >= 0 ? argv.slice(execIdx + 1) : argv;
    if (scan[0] === "resume") return null;
    const positionals = collectPositionals(
      scan,
      new Set([
        "-c",
        "--config",
        "--enable",
        "--disable",
        "-i",
        "--image",
        "-m",
        "--model",
        "-p",
        "--profile",
        "--profile-v2",
        "-s",
        "--sandbox",
        "-C",
        "--cd",
        "--add-dir",
        "-o",
        "--output-last-message",
        "--output-schema",
        "--color",
      ]),
    );
    const prompt = positionals[positionals.length - 1];
    return prompt && prompt !== "-" ? prompt : null;
  }
  if (agent === "claude") {
    const positionals = collectPositionals(
      argv,
      new Set([
        "--add-dir",
        "--agent",
        "--agents",
        "--allowedTools",
        "--allowed-tools",
        "--append-system-prompt",
        "--betas",
        "--debug-file",
        "--disallowedTools",
        "--disallowed-tools",
        "--effort",
        "--fallback-model",
        "--file",
        "--input-format",
        "--json-schema",
        "--max-budget-usd",
        "--mcp-config",
        "--model",
        "-n",
        "--name",
        "--output-format",
        "--permission-mode",
        "--plugin-dir",
        "--plugin-url",
        "--remote-control",
        "--remote-control-session-name-prefix",
        "-r",
        "--resume",
        "--session-id",
        "--setting-sources",
        "--settings",
        "--system-prompt",
        "--tools",
        "-w",
        "--worktree",
      ]),
    );
    return positionals[positionals.length - 1] || null;
  }
  return null;
}

export function structuredAgentCommand(agent, prompt) {
  if (agent === "codex") {
    return {
      command: "codex",
      args: [
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt,
      ],
    };
  }
  if (agent === "claude") {
    return {
      command: "claude",
      args: [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        prompt,
      ],
    };
  }
  return null;
}

// Command-based agent jobs (job.process.command + literal args, e.g. the
// helm-owner-orchestrator tick) bypass structuredAgentCommand, so their args can
// omit the output flag that makes the agent's session id observable on stdout.
// codex only prints the thread_id (its session id) when invoked with `exec --json`;
// without it, extractAgentSessionId/classifyAgentRun can never capture a session and
// requireAgentSession turns an otherwise-successful run into a `missing_agent_session_id`
// failure. That is the orchestrator tick's persistent-failure loop
// (COE-2026-05-22-orchestrator-tick-persistent-failure). Inject the session-capture
// flag when a command-based agent run is missing it so requireAgentSession can be met.
export function continuationPrompt({
  originalPrompt,
  primaryAgent,
  failureSummary,
  stdoutPath,
  stderrPath,
}) {
  return [
    `Helm is falling back to you because ${primaryAgent} failed while handling this task.`,
    "",
    "Before acting, inspect the current workspace state and any logs named below. The prior agent may have made partial progress.",
    "",
    `Primary failure: ${failureSummary || "(unknown)"}`,
    stdoutPath ? `Primary stdout log: ${stdoutPath}` : null,
    stderrPath ? `Primary stderr log: ${stderrPath}` : null,
    "",
    "Original task:",
    originalPrompt || "(empty)",
  ]
    .filter(Boolean)
    .join("\n");
}

export function classifyAgentRun(agent, result = {}) {
  const events = parseJsonLines(result.stdout);
  let sawModelToolCall = false;
  let terminalFailure = result.status !== "success";
  let failureSummary = result.error || null;
  let rawErrorClass = result.error ? "process_error" : null;
  let sessionId = null;

  for (const event of events) {
    if (agent === "claude") {
      if (!sessionId && event.session_id) sessionId = event.session_id;
      if (claudeSawToolCall(event)) sawModelToolCall = true;
      if (
        event.type === "rate_limit_event" &&
        event.rate_limit_info?.status === "rejected"
      ) {
        terminalFailure = true;
        rawErrorClass = "rate_limit";
        failureSummary = summarizeError(event.rate_limit_info);
      }
      if (event.type === "assistant" && event.error) {
        terminalFailure = true;
        rawErrorClass = event.error;
        failureSummary = summarizeError(
          event.message?.content?.[0]?.text || event.error,
        );
      }
      if (event.type === "result" && event.is_error) {
        terminalFailure = true;
        rawErrorClass = event.api_error_status
          ? `api_${event.api_error_status}`
          : "result_error";
        failureSummary = summarizeError(event.result || event.error || event);
      }
    } else if (agent === "codex") {
      if (!sessionId && event.thread_id) sessionId = event.thread_id;
      if (codexSawToolCall(event)) sawModelToolCall = true;
      if (event.type === "error" || event.type === "turn.failed") {
        terminalFailure = true;
        rawErrorClass = event.type;
        failureSummary = summarizeError(event.message || event.error || event);
      }
    }
  }

  return {
    agent,
    status: terminalFailure ? "failure" : result.status,
    saw_model_tool_call: sawModelToolCall,
    failure_summary: terminalFailure ? failureSummary || "agent failed" : null,
    raw_error_class: rawErrorClass,
    session_id: result.session_id || sessionId || null,
    events_seen: events.length,
  };
}
