import { basename } from "node:path";

import {
  SlackChannelsError,
  addSlackChannels,
  parseLaunchSpec,
} from "./slack_channels_add.mjs";
import { readAgentRows } from "./slack_agent_rows.mjs";
import { tldrAgentHomeFor } from "./store.mjs";

// `tldr-agents slack channels add <name>...` or `--agents-json <file|->` [--json]
const usage = [
  "tldr-agents slack channels add <name>... [--launch-cwd <dir> --launch-runtime <claude-code|codex> --launch-command <shell-quoted command>] [--json]",
  "tldr-agents slack channels add --agents-json <file|-> [--json]",
].join("\n");

const VALUE_FLAGS = {
  "--launch-cwd": "cwd",
  "--launch-runtime": "runtime",
  "--launch-command": "command",
  "--agents-json": "agentsJson",
};

function log(event, status, params) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, status, params })}\n`,
  );
}

const failure = (code, message) => ({
  ok: false,
  data: null,
  error: { code, message, retryable: false, remediation: usage },
});

function humanLine(r) {
  if (r.error) return `${r.name}: failed (${r.error})`;
  const state = r.created ? "created" : "already set up";
  const launch = r.launch === "stored" ? ", launch info stored" : "";
  return `#${r.channel_name} ${state}${r.welcomed ? ", welcome posted" : ""}${launch}`;
}

// Splits `--flag value` / `--flag=value` flags from names; anything else dashed is unknown.
function scanChannelsArgs(rest) {
  const seen = { names: [], values: {}, json: false, unknown: false };
  for (let i = 0; i < rest.length; i += 1) {
    const [flag, ...inline] = rest[i].split("=");
    if (rest[i] === "--json") seen.json = true;
    else if (VALUE_FLAGS[flag]) {
      seen.values[VALUE_FLAGS[flag]] = inline.length
        ? inline.join("=")
        : rest[++i];
    } else if (rest[i].startsWith("-")) seen.unknown = true;
    else seen.names.push(rest[i]);
  }
  return seen;
}

const usageError = (message) =>
  new SlackChannelsError("SLACK_CHANNELS_USAGE", message);

// Launch info is per agent: all three flags, one name.
function launchesFor({ launch, names }) {
  const given = Object.keys(launch).length;
  if (!given) return {};
  if (given < 3) {
    throw usageError(
      "Pass --launch-cwd, --launch-runtime and --launch-command together.",
    );
  }
  if (names.length !== 1)
    throw usageError("Launch flags apply to one agent name.");
  return { [names[0]]: parseLaunchSpec(launch) };
}

// --agents-json rows carry names and launch info, so neither may come as flags too.
function agentsFromJson({ names, launch, agentsJson }, readInput) {
  if (names.length || Object.keys(launch).length) {
    throw usageError(
      "--agents-json cannot be combined with agent names or --launch-* flags.",
    );
  }
  return readAgentRows(agentsJson, readInput);
}

export function parseChannelsArgs(args, { readInput } = {}) {
  const [area, verb, ...rest] = args;
  const { values, ...seen } = scanChannelsArgs(rest);
  const { agentsJson, ...launch } = values;
  const { names, json } = seen;
  try {
    if (area !== "channels" || verb !== "add" || seen.unknown) {
      throw usageError(usage);
    }
    if (agentsJson !== undefined) {
      const rows = agentsFromJson({ names, launch, agentsJson }, readInput);
      return { ...rows, json, error: null };
    }
    if (!names.length) throw usageError(usage);
    return {
      names,
      json,
      launches: launchesFor({ launch, names }),
      error: null,
    };
  } catch (error) {
    return { names, json, error: failure(error.code, error.message) };
  }
}

export async function runChannelsEntry(
  args,
  { fetchImpl, home, readInput } = {},
) {
  const parsed = parseChannelsArgs(args, { readInput });
  if (parsed.error) return { envelope: parsed.error, exitCode: 2, lines: [] };
  try {
    const data = await addSlackChannels({
      home: home ?? tldrAgentHomeFor(),
      names: parsed.names,
      launches: parsed.launches,
      fetchImpl,
      logger: ({ event, status, params }) => log(event, status, params),
    });
    return {
      envelope: { ok: data.ok, data, error: null },
      exitCode: data.ok ? 0 : 1,
      lines: data.results.map(humanLine),
    };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "SLACK_FAILED";
    log("slack_channels_entry_failed", "error", { code, stack: error?.stack });
    return {
      envelope: failure(code, error?.message ?? "Slack channels add failed."),
      exitCode: 1,
      lines: [],
    };
  }
}

if (
  process.argv[1] &&
  basename(process.argv[1]) === "slack_channels_entry.mjs"
) {
  const args = process.argv.slice(2);
  const { envelope, exitCode, lines } = await runChannelsEntry(args);
  const json = args.includes("--json");
  if (json) process.stdout.write(`${JSON.stringify(envelope)}\n`);
  else if (envelope.ok) process.stdout.write(`${lines.join("\n")}\n`);
  else {
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
    process.stderr.write(
      `${envelope.error?.message ?? "Some channels failed."}\n`,
    );
  }
  process.exitCode = exitCode;
}
