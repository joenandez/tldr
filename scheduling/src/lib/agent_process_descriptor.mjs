const SUPPORTED_AGENTS = new Set(["claude", "codex"]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh"]);

function basename(command) {
  return typeof command === "string" ? command.split("/").pop() : null;
}

export function agentFromCommand(command) {
  const base = basename(command);
  return SUPPORTED_AGENTS.has(base) ? base : null;
}

function academySelectedAgent(args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (argv[0] !== "run" || !argv[1]) return null;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--agent") {
      const value = String(argv[i + 1] || "").trim();
      return SUPPORTED_AGENTS.has(value) ? value : null;
    }
    if (arg.startsWith("--agent=")) {
      const value = arg.slice("--agent=".length).trim();
      return SUPPORTED_AGENTS.has(value) ? value : null;
    }
  }
  return "claude";
}

function shellCommandIndex(args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  for (let i = 0; i < argv.length - 1; i += 1) {
    const arg = argv[i];
    if (arg === "-c" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("c"))) {
      return i + 1;
    }
  }
  return -1;
}

function shellSelectedAgent(args) {
  const idx = shellCommandIndex(args);
  if (idx < 0) return null;
  const commandText = String(args[idx] || "").trimStart();
  const match = commandText.match(
    /^(?:exec\s+)?(?:[A-Za-z_][\w]*=\S+\s+)*(?:\S+\/)?(claude|codex)\b/,
  );
  return match ? match[1] : null;
}

export function managedAgentProcessDescriptor({ command, args = [] } = {}) {
  const directAgent = agentFromCommand(command);
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (directAgent) {
    return { agent: directAgent, command, args: argv, wrapper: null };
  }
  if (basename(command) === "academy") {
    const agent = academySelectedAgent(argv);
    if (agent) return { agent, command, args: argv, wrapper: "academy" };
  }
  if (SHELL_COMMANDS.has(basename(command))) {
    const agent = shellSelectedAgent(argv);
    if (agent) return { agent, command, args: argv, wrapper: "shell" };
  }
  return null;
}

function splitAcademyAgentArgs(args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const delimiter = argv.indexOf("--");
  if (delimiter < 0) return { prefix: argv, agentArgs: [] };
  return {
    prefix: argv.slice(0, delimiter + 1),
    agentArgs: argv.slice(delimiter + 1),
  };
}

function addCodexShellCapture(commandText) {
  if (/\bcodex\b[^\n;|&<>]*\s--json\b/.test(commandText)) {
    return commandText;
  }
  return commandText.replace(/\bcodex\s+(exec|e)\b/, "codex $1 --json");
}

function addClaudeShellCapture(commandText) {
  const hasVerbose = /\bclaude\b[^\n;|&<>]*\s--verbose\b/.test(commandText);
  const hasOutputFormat =
    /\bclaude\b[^\n;|&<>]*\s--output-format(?:=|\s+)/.test(commandText);
  const capture = [];
  if (!hasVerbose) capture.push("--verbose");
  if (!hasOutputFormat) capture.push("--output-format", "stream-json");
  if (capture.length === 0) return commandText;
  return commandText.replace(/\bclaude\b/, `claude ${capture.join(" ")}`);
}

function ensureShellSessionCaptureArgs(agent, args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const idx = shellCommandIndex(argv);
  if (idx < 0) return argv;
  const next = argv.slice();
  if (agent === "codex") next[idx] = addCodexShellCapture(next[idx]);
  if (agent === "claude") next[idx] = addClaudeShellCapture(next[idx]);
  return next;
}

export function ensureSessionCaptureArgs(agent, args, wrapper = null) {
  if (wrapper === "academy") {
    const { prefix, agentArgs } = splitAcademyAgentArgs(args);
    return [...prefix, ...ensureSessionCaptureArgs(agent, agentArgs)];
  }
  if (wrapper === "shell") return ensureShellSessionCaptureArgs(agent, args);
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (agent === "claude") {
    const hasOutputFormat =
      argv.includes("--output-format") ||
      argv.some((arg) => arg.startsWith("--output-format="));
    const hasVerbose = argv.includes("--verbose");
    const capture = [];
    if (!hasVerbose) capture.push("--verbose");
    if (!hasOutputFormat) capture.push("--output-format", "stream-json");
    return capture.length > 0 ? [...capture, ...argv] : argv;
  }
  if (agent === "codex" && !argv.includes("--json")) {
    const execIdx = argv.findIndex((arg) => arg === "exec" || arg === "e");
    if (execIdx >= 0) {
      const next = argv.slice();
      next.splice(execIdx + 1, 0, "--json");
      return next;
    }
  }
  return argv;
}
