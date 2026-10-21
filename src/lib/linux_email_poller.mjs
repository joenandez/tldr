import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { tldrAgentHomeFor } from "./store.mjs";
import { defaultTightbeamStateRoot } from "./tldr_agent_source_plist.mjs";

// Linux/WSL replaces the macOS launchd poll daemon with one Helm job that runs
// the poll-only daemon once a minute (B5 spike: FR/spikes/b5.md). One tick
// runs both lanes, inbound publish and outbound drain, in a fresh process.
// Helm owns the cadence, overlap policy, and run history.

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const POLLER_JOB_ID = "tldr-email-poll";
const CRON = "* * * * *";
const OVERLAP_POLICY = "forbid";
const TIMEOUT_SEC = 55;

const fail = (code, message) => Object.assign(new Error(message), { code });

function defaultLog(level, event, fields = {}) {
  // Never put env values or the AgentMail key in `fields`.
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
  );
}

async function defaultRun(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 60_000,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", code: error.code };
  }
}

// The daemon refuses to start while its own lifecycle store is missing or
// disabled; this is separate from the Helm scheduler's desired state.
async function defaultEnsureLifecycle(agentHome) {
  const store = await import("./tldr_agent_lifecycle_store.mjs");
  store.initializeLifecycleStore({ home: agentHome });
  const state = store.readLifecycleDesiredState({ home: agentHome });
  if (state.allowed_to_start) return state;
  return store.setLifecycleDesiredState({
    home: agentHome,
    mode: "live",
    reason: "linux_email_poller",
  });
}

function resolveContext({
  env,
  home,
  agentHome,
  tightbeamStateRoot,
  packageRoot,
  nodePath,
}) {
  const userHome = home ?? env.HOME ?? homedir();
  return {
    home: userHome,
    agentHome: agentHome ?? tldrAgentHomeFor({ env, userHome }),
    tightbeamStateRoot: tightbeamStateRoot ?? defaultTightbeamStateRoot(),
    packageRoot: packageRoot ?? PACKAGE_ROOT,
    nodePath: nodePath ?? process.execPath,
  };
}

// Same values as the macOS plist, set explicitly: a Helm job inherits the
// scheduler's env, not the agent root. TIGHTBEAM_BIN names the Node entrypoint
// because the libexec launcher's payload check has no hash on Linux.
function desiredJob(ctx, env) {
  return {
    command: ctx.nodePath,
    args: [join(ctx.packageRoot, "src", "helm-daemon.mjs"), "--once"],
    env: {
      TLDR_AGENT_HOME: ctx.agentHome,
      HELM_HOME: ctx.agentHome,
      TLDR_AGENT_DAEMON_MODE: "poll-only",
      HELM_CANONICAL_SQLITE: "1",
      PATH: `${dirname(ctx.nodePath)}:/usr/local/bin:/usr/bin:/bin`,
      TIGHTBEAM_BIN: join(ctx.packageRoot, "messaging", "bin", "tightbeam"),
      TIGHTBEAM_STATE_ROOT: ctx.tightbeamStateRoot,
      // Stub override for container proofs; absent in a real install.
      ...(env.TLDR_AGENTMAIL_BASE_URL
        ? { TLDR_AGENTMAIL_BASE_URL: env.TLDR_AGENTMAIL_BASE_URL }
        : {}),
    },
  };
}

const tasks = (run, ctx, args) =>
  run(join(ctx.packageRoot, "bin", "tldr-agents"), ["tasks", ...args]);

async function readJob(run, ctx) {
  const result = await tasks(run, ctx, [
    "get",
    "--id",
    POLLER_JOB_ID,
    "--cwd",
    ctx.home,
  ]);
  try {
    return JSON.parse(result.stdout)?.data?.job ?? null;
  } catch {
    return null;
  }
}

const sameJob = (job, want) =>
  job?.process?.command === want.command &&
  JSON.stringify(job.process.args) === JSON.stringify(want.args) &&
  JSON.stringify(job.process.env) === JSON.stringify(want.env) &&
  job.schedule?.cron === CRON &&
  job.schedule?.overlap_policy === OVERLAP_POLICY;

const paused = (job) => job?.state?.enabled === false;

export async function installLinuxEmailPoller({
  env = process.env,
  platform = process.platform,
  run = defaultRun,
  log = defaultLog,
  ensureLifecycle = defaultEnsureLifecycle,
  ...context
} = {}) {
  if (platform !== "linux") {
    throw fail("unsupported_platform", "the email poller job is Linux-only");
  }
  const ctx = resolveContext({ env, ...context });
  try {
    await ensureLifecycle(ctx.agentHome);
  } catch (error) {
    log("error", "linux_email_poller_lifecycle_blocked", {
      error_code: error.code ?? null,
    });
    throw fail(
      "poller_lifecycle_blocked",
      "the poll daemon lifecycle does not allow start",
    );
  }
  const want = desiredJob(ctx, env);
  const existing = await readJob(run, ctx);
  const same = sameJob(existing, want);
  if (same && !paused(existing)) {
    log("info", "linux_email_poller_unchanged", { id: POLLER_JOB_ID });
    return { ok: true, kind: "helm-job", id: POLLER_JOB_ID, changed: false };
  }
  if (!same) await registerJob(run, ctx, want, existing, log);
  // Helm keeps an operator pause across --replace, so resume it explicitly:
  // a paused poll job means owner replies never arrive.
  if (paused(existing)) {
    const resumed = await tasks(run, ctx, [
      "resume",
      "--cwd",
      ctx.home,
      "--id",
      POLLER_JOB_ID,
    ]);
    if (!resumed.ok) {
      log("error", "linux_email_poller_resume_failed", {
        id: POLLER_JOB_ID,
        exit_code: resumed.code ?? null,
      });
      throw fail(
        "poller_resume_failed",
        "Helm refused to resume the email poller job",
      );
    }
    log("info", "linux_email_poller_resumed", { id: POLLER_JOB_ID });
  }
  return { ok: true, kind: "helm-job", id: POLLER_JOB_ID, changed: true };
}

async function registerJob(run, ctx, want, existing, log) {
  const result = await tasks(run, ctx, [
    "schedule",
    "--cwd",
    ctx.home,
    "--id",
    POLLER_JOB_ID,
    "--cron",
    CRON,
    "--overlap-policy",
    OVERLAP_POLICY,
    "--timeout-sec",
    String(TIMEOUT_SEC),
    "--env-json",
    JSON.stringify(want.env),
    "--tags",
    "tldr,email-poll",
    ...(existing ? ["--replace"] : []),
    "--command",
    want.command,
    "--",
    ...want.args,
  ]);
  if (!result.ok) {
    log("error", "linux_email_poller_register_failed", {
      id: POLLER_JOB_ID,
      exit_code: result.code ?? null,
    });
    throw fail("poller_register_failed", "Helm refused the email poller job");
  }
  log("info", "linux_email_poller_registered", {
    id: POLLER_JOB_ID,
    replaced: Boolean(existing),
  });
}

export async function linuxEmailPollerStatus({
  env = process.env,
  platform = process.platform,
  run = defaultRun,
  ...context
} = {}) {
  const absent = { present: false, kind: null, id: null };
  if (platform !== "linux") return absent;
  const ctx = resolveContext({ env, ...context });
  const job = await readJob(run, ctx);
  if (!job) return absent;
  return {
    present: true,
    kind: "helm-job",
    id: POLLER_JOB_ID,
    // Runnable means Helm will dispatch it every minute: not paused, and on
    // the schedule repair installs.
    runnable: !paused(job) && job.schedule?.cron === CRON,
    detail: {
      cron: job.schedule?.cron ?? null,
      enabled: job.state?.enabled !== false,
      next_run_at: job.state?.next_run_at ?? null,
      last_status: job.state?.last_status ?? null,
    },
  };
}
