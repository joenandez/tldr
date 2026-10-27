import { authTest, connectionsOpen } from "./slack_api.mjs";
import { createSlackProvisioner } from "./slack_app_provision.mjs";
import { readAgentRows } from "./slack_agent_rows.mjs";
import { addSlackChannels } from "./slack_channels_add.mjs";
import {
  recordSlackHealth,
  writeSlackCredentials,
} from "./slack_credentials.mjs";
import { agentChannelKey } from "./slack_owner_channel.mjs";
import { startSlackSetupPage } from "./slack_setup_page.mjs";
import { SLACK_SETUP_LINK_LINE } from "./slack_setup_steps.mjs";

// `setup --channel slack`: start the local page, hand the caller the link and
// one line (the steps live on the page), wait for the page to finish. Links only: this never opens
// a browser. Tokens go browser -> page -> Slack; logs carry outcomes only.

const fail = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
// Words are re-quoted so splitLaunchCommand gives back the same argv.
const word = (text) => (/^[\w@%+=:,./-]+$/u.test(text) ? text : quote(text));
const launchFlags = ({ cwd, runtime, command }) =>
  ` --launch-cwd ${quote(cwd)} --launch-runtime ${runtime} --launch-command ${quote(command.map(word).join(" "))}`;
// Launch info is per agent, so each launching name gets its own command.
const retryCommand = (names, launches) => {
  const add = (rest) => `tldr-agents slack channels add ${rest}`;
  const plain = names.filter((n) => !launches[n]);
  const commands = names
    .filter((n) => launches[n])
    .map((n) => add(`${n}${launchFlags(launches[n])}`));
  if (plain.length) commands.unshift(add(plain.join(" ")));
  return commands.join("; ");
};

// Setup's own retry. Launch rows go inline, so it works after a temp
// --agents-json file is gone or when the rows came from stdin.
export function setupRetryCommand(names, launches = {}) {
  const base = "tldr-agents setup --channel slack";
  const rows = names
    .filter((name) => launches[name])
    .map((name) => ({
      name,
      ...launches[name],
      command: launches[name].command.map(word).join(" "),
    }));
  if (rows.length) {
    return `printf '%s' ${quote(JSON.stringify(rows))} | ${base} --agents-json -`;
  }
  return names.length ? `${base} --agents ${names.join(",")}` : base;
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function registerRoute(ctx) {
  const registered = await attempt(() => ctx.channel.registerSlackChannel());
  const ok = Boolean(registered.value?.ok);
  recordSlackHealth("bot_token", "ok", { home: ctx.home });
  recordSlackHealth("route", ok ? "ok" : "missing", { home: ctx.home });
  ctx.log("slack_setup_register_route", { status: ok ? "ok" : "error" });
  return ok;
}

// Credentials are written before this runs, so a failure here is a notice on
// the page and an error result, never "Slack did not accept that token".
async function createChannels(ctx) {
  const { names } = ctx;
  const added = await attempt(() =>
    addSlackChannels({
      home: ctx.home,
      names,
      launches: ctx.launches,
      fetchImpl: ctx.fetchImpl,
      logger: ctx.logger,
    }),
  );
  const ok = added.ok && added.value.ok;
  ctx.log("slack_setup_channels", {
    status: ok ? "ok" : "error",
    result: { count: names.length },
  });
  return { ok, results: added.value?.results ?? [] };
}

async function followUpProblem(ctx, outcome) {
  if (!(await registerRoute(ctx))) {
    const fix = "Run: tldr-agents repair --channel slack";
    return {
      code: "slack_route_unavailable",
      notice: `Slack is connected, but tldr could not register the Slack route. ${fix}`,
    };
  }
  if (!ctx.names.length) return null;
  const channels = await createChannels(ctx);
  outcome.channels = channels.results;
  const retry = `Run: ${retryCommand(ctx.names, ctx.launches)}`;
  return channels.ok
    ? null
    : {
        code: "slack_channels_failed",
        notice: `Slack is connected, but creating the channels failed. ${retry}`,
      };
}

// Returns what the page shows: a notice on failure and the channels made.
async function afterConnect(ctx, outcome) {
  const problem = await followUpProblem(ctx, outcome);
  const channels = (outcome.channels ?? []).flatMap(
    (c) => c.channel_name ?? [],
  );
  if (!problem) return { channels };
  Object.assign(outcome, {
    failure: fail(problem.code),
    notice: problem.notice,
  });
  return { notice: problem.notice, channels };
}

function stopOnSignal(page) {
  const stop = () => page.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}

function finalResult({ done, outcome, names }, out) {
  if (done.status !== "connected") return fail(`slack_setup_${done.status}`);
  out("Slack: connected");
  if (outcome.notice) out(outcome.notice);
  const channels = names.length ? { channels: outcome.channels } : {};
  if (outcome.failure) return { ...outcome.failure, ...channels };
  const { ownerUserId, teamId } = done;
  return Object.freeze({
    ok: true,
    state: "connected",
    ownerUserId,
    teamId,
    ...channels,
  });
}

const AGENTS_USAGE =
  "--agents <names> and --agents-json <file|-> are setup-only and cannot be combined.";

// "-" reads stdin. Rows are validated here, before any Slack work.
function tryAgentsJson(source) {
  try {
    return readAgentRows(source);
  } catch (error) {
    return { error: error.message };
  }
}

// --agents names (no launch) or --agents-json rows (launch per name); never both.
export function resolveAgents(operation, { agents, agentsJson }) {
  if (agentsJson !== undefined) {
    const clash = operation !== "setup" || agents !== undefined;
    return clash ? { error: AGENTS_USAGE } : tryAgentsJson(agentsJson);
  }
  const names = (agents ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const bad = agents !== undefined && (operation !== "setup" || !names.length);
  return { names, launches: {}, bad };
}

// announce({ url, steps }) shows the link at once; out(line) prints status lines.
export async function runSlackSetup({
  home,
  channel,
  names = [],
  launches = {},
  announce,
  out,
  fetchImpl,
  logger,
  timeoutMs,
}) {
  const log = (event, extra = {}) => logger?.({ event, ...extra });
  if (names.some((name) => !agentChannelKey(name))) {
    return fail("SLACK_CHANNEL_NAME_INVALID");
  }
  const ctx = { home, channel, names, launches, fetchImpl, logger, log };
  const outcome = {};
  const apiOpts = { fetchImpl, logger };
  const page = await startSlackSetupPage({
    provision: createSlackProvisioner({ fetchImpl, logger }),
    validate: {
      authTest: ({ botToken }) =>
        authTest({ ...apiOpts, credentials: { botToken } }),
      connectionsOpen: ({ appToken }) =>
        connectionsOpen({ ...apiOpts, credentials: { appToken } }),
    },
    writeCredentials: (credentials) =>
      writeSlackCredentials(credentials, { home, logger }),
    onConnected: () => afterConnect(ctx, outcome),
    timeoutMs,
    logger,
  });
  log("slack_setup_start", { status: "start", params: { port: page.port } });
  announce({ url: page.url, steps: SLACK_SETUP_LINK_LINE });
  const release = stopOnSignal(page);
  const done = await page.done;
  release();
  log("slack_setup_finished", { status: done.status });
  return finalResult({ done, outcome, names }, out);
}
