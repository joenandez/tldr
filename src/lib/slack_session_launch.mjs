import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { withoutSessionEnv } from "../../messaging/src/protocol/session_env.mjs";
import { listTightbeamSessions } from "../../scheduling/src/lib/tightbeam_sessions.mjs";

// Fixed text: the post body never rides on argv; the session reads it from
// its inbox.
export const LAUNCH_BOOT_PROMPT =
  "tldr started this session for a new Slack post. Run `tldr-agents messaging agent inbox --unread`, receive the newest message with `agent receive --message <id>`, and answer it with `agent reply`.";

// The permission mode comes from the stored launch command (Academy owns it);
// tldr adds no permission or sandbox flag.
const RUNTIME_ARGS = {
  "claude-code": (sessionKey) => [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--session-id",
    sessionKey,
    LAUNCH_BOOT_PROMPT,
  ],
  // The agent home is not a git repo; the flag must follow exec.
  codex: () => ["exec", "--skip-git-repo-check", "--json", LAUNCH_BOOT_PROMPT],
};

// Holds only the Codex thread id; child output never reaches disk (AC-18).
export const launchIdPath = (home, sessionKey) =>
  join(home, "slack", "launches", `${sessionKey}.id`);

// Codex has no --session-id: its thread id is the first thread.started line of
// the exec --json stdout (Academy prints non-JSON lines first). This detached
// sieve writes only that id, then drains the rest so the child never blocks.
const ID_SCAN_BYTES = 65_536;
const ID_SIEVE = `
const fs = require("node:fs");
const path = process.argv[1];
let buf = "";
let seen = 0;
let open = true;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!open) return;
  seen += chunk.length;
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "thread.started" && typeof event.thread_id === "string") {
      fs.writeFileSync(path + ".tmp", event.thread_id, { mode: 0o600 });
      fs.renameSync(path + ".tmp", path);
      open = false;
      return;
    }
  }
  if (seen > ${ID_SCAN_BYTES}) open = false;
});
`;

// sessionKey -> non-zero exit code of a launch child, so a launch that died
// before registering fails the post at once.
// shortcut: in-process only; after a daemon restart the 60 s deadline still
// applies. Upgrade by persisting the code on the thread_launch row.
const launchExits = new Map();

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function launchProblem({ cwd, runtime, command } = {}) {
  if (!isAbsolute(String(cwd)) || !isDir(cwd)) {
    return ["launch_cwd_missing", "launch cwd is not an existing absolute dir"];
  }
  if (!Object.hasOwn(RUNTIME_ARGS, runtime)) {
    return ["launch_runtime_unsupported", `runtime ${runtime}`];
  }
  const empty = !Array.isArray(command) || !command[0];
  return empty ? ["launch_command_empty", "launch command is empty"] : null;
}

function childEnvFrom(env) {
  const childEnv = withoutSessionEnv(env);
  // HELM_HOME is a root, not session identity; sandbox runs depend on it.
  if (env.HELM_HOME) childEnv.HELM_HOME = env.HELM_HOME;
  childEnv.TIGHTBEAM_LAUNCH_MODE = "non_interactive";
  return childEnv;
}

// Resolves after the child's "spawn" event, or with the spawn error.
function startChild(spawnImpl, [command, ...args], options) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, options);
    child.once("error", (error) => resolve({ error }));
    child.once("spawn", () => {
      child.unref();
      resolve({ child });
    });
  });
}

function startIdSieve(spawnImpl, idPath) {
  mkdirSync(dirname(idPath), { recursive: true, mode: 0o700 });
  return startChild(spawnImpl, [process.execPath, "-e", ID_SIEVE, idPath], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

export async function launchAgentSession({
  home,
  launch,
  sessionKey,
  env = process.env,
  spawnImpl = spawn,
  logger,
}) {
  const problem = launchProblem(launch);
  const failed = (code, message) => {
    logger?.({
      event: "slack_session_launch_failed",
      status: "error",
      params: { runtime: launch?.runtime, session_key: sessionKey },
      result: { code },
    });
    return { ok: false, code, message };
  };
  if (problem) return failed(...problem);
  const argv = [...launch.command, ...RUNTIME_ARGS[launch.runtime](sessionKey)];
  logger?.({
    event: "slack_session_launch_started",
    status: "ok",
    params: {
      runtime: launch.runtime,
      argv0: launch.command[0],
      session_key: sessionKey,
    },
  });
  const started = await spawnSession(spawnImpl, {
    ...{ argv, launch, env, logger },
    idPath: launchIdPath(home, sessionKey),
    params: { runtime: launch.runtime, session_key: sessionKey },
  });
  return started.error
    ? failed("launch_spawn_failed", started.error.code ?? "spawn error")
    : { ok: true, pid: started.child.pid };
}

// Resolves {child} or {error}. Claude's id is the --session-id in argv, so
// only Codex output is read, and only through the sieve.
async function spawnSession(
  spawnImpl,
  { argv, launch, env, logger, idPath, params },
) {
  const sieve =
    launch.runtime === "codex" ? await startIdSieve(spawnImpl, idPath) : null;
  if (sieve?.error) return sieve;
  try {
    const started = await startChild(spawnImpl, argv, {
      cwd: launch.cwd,
      env: childEnvFrom(env),
      detached: true,
      stdio: ["ignore", sieve?.child.stdin ?? "ignore", "ignore"],
    });
    // Exit status only: stderr is discarded, so this is the safe diagnostic.
    started.child?.once("exit", (code, signal) => {
      if (code !== 0) launchExits.set(params.session_key, code);
      logger?.({
        event: "slack_session_launch_exited",
        status: code === 0 ? "ok" : "error",
        params,
        result: { code, signal },
      });
    });
    return started;
  } finally {
    // The child holds its own copy; closing ours lets the sieve see EOF.
    sieve?.child.stdin.destroy();
  }
}

function codexThreadId(idPath) {
  try {
    return readFileSync(idPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export async function findLaunchedSession({
  home,
  runtime,
  sessionKey,
  env = process.env,
  listSessions,
}) {
  const providerId =
    runtime === "codex"
      ? codexThreadId(launchIdPath(home, sessionKey))
      : sessionKey;
  // Checked after the listing: a child that exited after registering is fine.
  const notYet = () =>
    launchExits.has(sessionKey)
      ? { status: "exited", code: "launch_exited" }
      : { status: "pending" };
  if (!providerId) return notYet();
  const list =
    listSessions ?? ((filters) => listTightbeamSessions(filters, { env }));
  const found = await list({ sessionId: providerId });
  if (!found.ok) return { status: "lookup_failed", code: found.error };
  // Exact id only: never "newest by name".
  const session = found.sessions.find(
    (s) => s.session_id === providerId && s.endpoint_id,
  );
  return session ? { status: "registered", session } : notYet();
}

export async function waitForLaunchedSession({
  home,
  runtime,
  sessionKey,
  env,
  listSessions,
  timeoutMs = 30_000,
  intervalMs = 250,
  sleep = delay,
  now = Date.now,
  logger,
}) {
  // Wall clock, not summed sleeps: each lookup is a CLI call that takes time too.
  const started = now();
  const latencyMs = () => now() - started;
  const query = { home, runtime, sessionKey, env, listSessions };
  let found;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- sequential poll.
    found = await findLaunchedSession(query);
    if (found.status === "registered") {
      logger?.({
        event: "slack_session_registered",
        status: "ok",
        params: { runtime, session_key: sessionKey },
        result: { endpoint_id: found.session.endpoint_id },
        latency_ms: latencyMs(),
      });
      return { ok: true, session: found.session, latencyMs: latencyMs() };
    }
    if (found.status !== "pending" || latencyMs() >= timeoutMs) break;
    // eslint-disable-next-line no-await-in-loop -- sequential poll.
    await sleep(intervalMs);
  }
  const code = found.code ?? "launch_registration_timeout";
  logger?.({
    event: "slack_session_launch_timeout",
    status: "error",
    params: { runtime, session_key: sessionKey },
    result: { code },
    latency_ms: latencyMs(),
  });
  return { ok: false, code, latencyMs: latencyMs() };
}
