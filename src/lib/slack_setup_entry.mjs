import { basename } from "node:path";

import { createSlackSetup } from "./slack_setup.mjs";
import {
  resolveAgents,
  runSlackSetup,
  setupRetryCommand,
} from "./slack_setup_flow.mjs";
import { tldrAgentHomeFor } from "./store.mjs";
import { createTightbeamSlackChannel } from "./tightbeam_slack_channel.mjs";

// `tldr-agents setup|status|repair --channel slack` and
// `configure --channel slack disconnect`, the same on macOS and Linux.
// Tokens are only ever pasted into the local setup page: no flag or env var takes one.

const OPERATIONS = new Set(["setup", "status", "repair", "configure"]);
const usage =
  "tldr-agents setup|status|repair|configure --channel slack [--agents <names> | --agents-json <file|-> (rows of {name,cwd,runtime,command})]";

const refuse = (code, message) => ({
  ok: false,
  data: null,
  error: { code, message, retryable: false, remediation: usage },
});

function log(event, status, result) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, status, result })}\n`,
  );
}

const VALUE_FLAGS = {
  "--channel": "channel",
  "--agents": "agents",
  "--agents-json": "agentsJson",
};

function scanSlackArgs(rest) {
  const seen = {
    channel: null,
    disconnect: false,
    unknown: false,
    json: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const [flag, ...inline] = rest[i].split("=");
    if (VALUE_FLAGS[flag]) {
      seen[VALUE_FLAGS[flag]] = inline.length
        ? inline.join("=")
        : (rest[++i] ?? "");
    } else if (rest[i] === "disconnect") seen.disconnect = true;
    else if (rest[i] === "--json") seen.json = true;
    else seen.unknown = true;
  }
  return seen;
}

// Returns { operation } or { refusal }; the argument text is never echoed.
export function parseSlackArgs(args) {
  const [operation, ...rest] = args;
  const scanned = scanSlackArgs(rest);
  const { channel, disconnect, unknown, json } = scanned;
  const { names, launches, bad, error } = resolveAgents(operation, scanned);
  let refusal = null;
  if (!OPERATIONS.has(operation)) {
    refusal = refuse("SLACK_OPERATION_UNSUPPORTED", usage);
  } else if (error) {
    refusal = refuse("SLACK_SETUP_USAGE", error);
  } else if (unknown || bad) {
    refusal = refuse(
      "SLACK_ARGUMENT_REFUSED",
      "Slack tokens and other values are never taken as arguments. Run setup and paste tokens only into the local setup page.",
    );
  } else if (channel !== "slack") {
    refusal = refuse("SLACK_OPERATION_UNSUPPORTED", usage);
  } else if ((operation === "configure") !== disconnect) {
    refusal = refuse(
      "SLACK_OPERATION_UNSUPPORTED",
      "Slack supports: configure --channel slack disconnect",
    );
  }
  return refusal
    ? { refusal }
    : {
        operation: disconnect ? "disconnect" : operation,
        names,
        launches,
        json,
      };
}

// Says only what the cleanup log reported, then the real retry command.
function timeoutMessage({ cleanup }, retry) {
  const did = [];
  if (cleanup?.appDeleted) did.push("The unfinished Slack app was deleted.");
  if (cleanup?.tokenRevoked) did.push("The access token was revoked.");
  return ["Slack setup timed out.", ...did, `Run it again: ${retry}`].join(" ");
}

const stdoutLine = (line) => process.stdout.write(`${line}\n`);
const stderrLine = (line) => process.stderr.write(`${line}\n`);

// Test/drive-only: lets an acceptance drive exercise the setup timeout quickly.
function setupTimeoutMs() {
  const ms = Number(process.env.TLDR_SLACK_SETUP_TIMEOUT_MS);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

// The agent runs setup in the background and reads the link from stdout.
function announcer(json) {
  if (json)
    return ({ url, steps }) =>
      stdoutLine(JSON.stringify({ event: "slack_setup_link", url, steps }));
  return ({ url, steps }) => stdoutLine(`${steps}\n${url}\n`);
}

const CLEANUP_EVENTS = {
  "slack.provision.app_deleted": "appDeleted",
  "slack.provision.config_token_revoked": "tokenRevoked",
};

function noteCleanup(cleanup, { event, status }) {
  if (status === "ok" && CLEANUP_EVENTS[event]) {
    cleanup[CLEANUP_EVENTS[event]] = true;
  }
}

function createCliSlackSetup({ names, launches, json }) {
  const home = tldrAgentHomeFor();
  const channel = createTightbeamSlackChannel({ home });
  const cleanup = { appDeleted: false, tokenRevoked: false };
  const logger = (entry) => {
    noteCleanup(cleanup, entry);
    stderrLine(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
  };
  return {
    ...createSlackSetup({ home, channel, logger }),
    setup: async () => {
      const result = await runSlackSetup({
        ...{ home, channel, names, launches, logger },
        ...{ announce: announcer(json), timeoutMs: setupTimeoutMs() },
        out: json ? stderrLine : stdoutLine,
      });
      return result.ok === false ? { ...result, cleanup } : result;
    },
  };
}

function failureError({ operation, names, launches }, data) {
  const base = { code: data.code, retryable: false };
  if (data.code !== "slack_setup_timeout") {
    return {
      ...base,
      message: `Slack ${operation} did not finish.`,
      remediation: usage,
    };
  }
  const retry = setupRetryCommand(names, launches);
  return { ...base, message: timeoutMessage(data, retry), remediation: retry };
}

export async function runSlackEntry(args, { slack } = {}) {
  const parsed = parseSlackArgs(args);
  if (parsed.refusal) {
    log("slack_entry_refused", "error", { code: parsed.refusal.error.code });
    return { envelope: parsed.refusal, exitCode: 2 };
  }
  try {
    const api = slack ?? createCliSlackSetup(parsed);
    const data = await api[parsed.operation]();
    const ok = data.ok !== false;
    log("slack_entry_result", ok ? "ok" : "error", {
      operation: parsed.operation,
      state: data.state ?? null,
      code: data.code ?? null,
    });
    const error = ok ? null : failureError(parsed, data);
    return {
      envelope: { ok, data: ok ? data : null, error },
      exitCode: ok ? 0 : 1,
    };
  } catch (error) {
    // Only the error code and name are logged: messages may carry request detail.
    const code = typeof error?.code === "string" ? error.code : "SLACK_FAILED";
    log("slack_entry_failed", "error", { code, name: error?.name ?? null });
    return {
      envelope: refuse(code, `Slack ${parsed.operation} failed.`),
      exitCode: 1,
    };
  }
}

if (basename(process.argv[1] ?? "") === "slack_setup_entry.mjs") {
  const args = process.argv.slice(2);
  const { envelope, exitCode } = await runSlackEntry(args);
  // human mode prints a failure as plain text; success output stays JSON
  const plain = exitCode && !args.includes("--json");
  process.stdout.write(
    `${plain ? envelope.error.message : JSON.stringify(envelope)}\n`,
  );
  process.exitCode = exitCode;
}
