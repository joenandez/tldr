import { isAbsolute } from "node:path";
import { statSync } from "node:fs";

import { withRouteLock } from "./email_disconnect_marker.mjs";
import { createPrivateChannel, invite, postMessage } from "./slack_api.mjs";
import {
  lookupAgentChannel,
  markAgentChannelWelcomed,
  recordAgentChannel,
  recordAgentLaunch,
} from "./slack_channel_map.mjs";
import { readSlackCredentials } from "./slack_credentials.mjs";
import {
  agentChannelKey,
  agentChannelLockPath,
} from "./slack_owner_channel.mjs";

// `tldr-agents slack channels add <name>...`: one private channel per name,
// the owner invited, one welcome post. Safe to rerun; tldr knows no Academy.

export class SlackChannelsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SlackChannelsError";
    this.code = code;
  }
}

export const welcomeText = (name) =>
  `${name} posts here. Reply in a thread, or post here to reach ${name}.`;

export const LAUNCH_RUNTIMES = ["claude-code", "codex"];

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// One shell word: bare runs, '...', "..." (backslash escapes), or \x.
const WORD_RE = /(?:[^\s'"\\]+|'[^']*'|"(?:[^"\\]|\\.)*"|\\.)+/gsu;
const PART_RE = /'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/gsu;

// Shell-style words, so a quoted path may hold spaces; nothing is expanded.
// null when a quote is left open.
export function splitLaunchCommand(text) {
  if (text.replace(WORD_RE, "").trim()) return null;
  return (text.match(WORD_RE) ?? []).map((word) =>
    word.replace(PART_RE, (_, single, double, escaped) =>
      double === undefined
        ? (single ?? escaped)
        : double.replace(/\\(.)/gsu, "$1"),
    ),
  );
}

// Launch info is opaque to tldr: the command is split into words, never run here.
export function parseLaunchSpec({ cwd, runtime, command }) {
  const invalid = (message) =>
    new SlackChannelsError("SLACK_LAUNCH_INVALID", message);
  if (typeof cwd !== "string" || !isAbsolute(cwd) || !isDirectory(cwd)) {
    throw invalid(
      "launch cwd must be an absolute path to an existing directory.",
    );
  }
  if (!LAUNCH_RUNTIMES.includes(runtime)) {
    throw invalid(
      `launch runtime must be one of: ${LAUNCH_RUNTIMES.join(", ")}.`,
    );
  }
  const argv = typeof command === "string" ? splitLaunchCommand(command) : [];
  if (!argv) throw invalid("launch command has an unclosed quote.");
  if (!argv.length) throw invalid("launch command must not be empty.");
  return { cwd, runtime, command: argv };
}

// Setup rows: [{ name, cwd, runtime, command }] -> names plus launch info per name.
export function parseAgentRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("expected a JSON array of {name,cwd,runtime,command}.");
  }
  if (!rows.length) throw new Error("no agents.");
  const launches = {};
  for (const row of rows) {
    if (typeof row?.name !== "string" || !row.name.trim()) {
      throw new Error("a row has no name.");
    }
    launches[row.name.trim()] = parseLaunchSpec(row);
  }
  return { names: Object.keys(launches), launches };
}

// A taken name (or an archived channel that keeps its name) falls back to a tagged one.
async function createNamed(key, opts) {
  const tag = Math.random().toString(36).slice(2, 8);
  const candidates = [key, `${key.slice(0, 73)}-${tag}`];
  let lastError;
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- candidates are tried in order.
      return await createPrivateChannel(candidate, opts);
    } catch (error) {
      if (error.slackError !== "name_taken") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function ensureChannel({ home, key, slackOpts }) {
  const existing = lookupAgentChannel(home, key);
  if (existing) return { row: existing, created: false };
  const made = await createNamed(key, slackOpts);
  // Recorded before invite/welcome, so a crash after this reuses the channel.
  recordAgentChannel(home, {
    agentName: key,
    channelId: made.id,
    channelName: made.name,
  });
  return { row: lookupAgentChannel(home, key), created: true };
}

async function addOne({ home, name, key, launch, slackOpts, ownerUserId }) {
  const { row, created } = await ensureChannel({ home, key, slackOpts });
  if (launch) recordAgentLaunch(home, { agentName: key, launch });
  await invite(row.channelId, [ownerUserId], slackOpts);
  const welcome = row.welcomeTs === null || row.welcomeTs === undefined;
  if (welcome) {
    const posted = await postMessage(
      { channel: row.channelId, text: welcomeText(name) },
      slackOpts,
    );
    markAgentChannelWelcomed(home, { agentName: key, welcomeTs: posted.ts });
  }
  return {
    name,
    key,
    channel_id: row.channelId,
    channel_name: row.channelName,
    created,
    welcomed: welcome,
    launch: launch ? "stored" : "unchanged",
  };
}

// Setup, a hire and a retry can add one name at once: one at a time per name,
// so the later call reuses the earlier one's channel and welcome.
const NAME_BUSY = {
  code: "SLACK_CHANNEL_BUSY",
  message: "Another channels add for this name is still running.",
};
const addOneLocked = (args) =>
  withRouteLock(agentChannelLockPath(args.home, args.key), () => addOne(args), {
    timeoutMs: 20_000,
    busy: NAME_BUSY,
  });

// Runtime and argv[0] only: keeps the payload small.
const launchLogParams = (launch) =>
  launch ? { runtime: launch.runtime, command0: launch.command[0] } : {};

function plan(names) {
  const seen = new Map();
  for (const name of names) {
    const key = agentChannelKey(name);
    if (!key) {
      throw new SlackChannelsError(
        "SLACK_CHANNEL_NAME_INVALID",
        `"${name}" has no letters or digits to name a channel with.`,
      );
    }
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen].map(([key, name]) => ({ key, name }));
}

// Resolves to { ok, results } where each result is the per-name outcome or
// { name, key, error }. Rows recorded before a failure stay recorded.
export async function addSlackChannels({
  home,
  names,
  launches = {},
  credentials,
  fetchImpl,
  logger = () => {},
  signal,
}) {
  const entries = plan(names);
  const creds = credentials ?? readSlackCredentials({ home, logger });
  if (!creds?.ownerUserId) {
    throw new SlackChannelsError(
      "SLACK_NOT_CONFIGURED",
      "Slack is not set up (no credentials or owner). Run: tldr-agents setup --channel slack",
    );
  }
  const slackOpts = { home, credentials: creds, fetchImpl, logger, signal };
  logger({
    event: "slack_channels_add_started",
    status: "info",
    params: { names: entries.map((e) => e.key) },
  });
  const results = [];
  for (const entry of entries) {
    try {
      // eslint-disable-next-line no-await-in-loop -- names are added in order.
      const outcome = await addOneLocked({
        home,
        ...entry,
        launch: launches[entry.name],
        slackOpts,
        ownerUserId: creds.ownerUserId,
      });
      logger({
        event: "slack_channels_add_name",
        status: "info",
        params: {
          key: outcome.key,
          channel_name: outcome.channel_name,
          created: outcome.created,
          welcomed: outcome.welcomed,
          launch: outcome.launch,
          ...launchLogParams(launches[entry.name]),
        },
      });
      results.push(outcome);
    } catch (error) {
      const code = error.slackError ?? error.code ?? "SLACK_FAILED";
      logger({
        event: "slack_channels_add_name",
        status: "error",
        params: { key: entry.key, code, stack: error.stack },
      });
      results.push({ name: entry.name, key: entry.key, error: code });
    }
  }
  const ok = results.every((r) => !r.error);
  logger({
    event: "slack_channels_add_result",
    status: ok ? "info" : "error",
    params: { count: results.length, ok },
  });
  return { ok, results };
}
