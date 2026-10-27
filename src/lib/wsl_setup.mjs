import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { mergeIni } from "./ini_merge.mjs";

// WSL platform steps for `tldr-agents setup|status`. Windows settings and the
// systemd flag are all written first, so one WSL restart applies every change.
// All commands go through the injected `run`; nothing here needs Windows to test.

const TASK_NAME = "Start WSL";
const WSLCONFIG = {
  wsl2: { vmIdleTimeout: "28800000" },
  general: { instanceIdleTimeout: "-1" },
};
const BOOT = { boot: { systemd: "true" } };
// shortcut: unverified minimum for `[general] instanceIdleTimeout`; advice only, never a gate.
const MIN_WSL_VERSION = [2, 4, 0];
const RESTART_MESSAGE =
  "Close all WSL terminals. Run `wsl --shutdown` in PowerShell. Open WSL. Run `tldr-agents setup` again.";
const NEEDS_TERMINAL = "WSL_SUDO_NEEDS_TERMINAL";

const fail = (code, message) => Object.assign(new Error(message), { code });
const readOr = (file, fallback = "") =>
  existsSync(file) ? readFileSync(file, "utf8") : fallback;
const sameText = (a, b) => a.trimEnd() === b.trimEnd();

export function detectWsl({
  env = process.env,
  osrelease = "/proc/sys/kernel/osrelease",
} = {}) {
  return Boolean(env.WSL_DISTRO_NAME) || /microsoft/i.test(readOr(osrelease));
}

function defaultRunInherit(command, args) {
  return { ok: spawnSync(command, args, { stdio: "inherit" }).status === 0 };
}

function context(options) {
  const ctx = {
    env: process.env,
    runInherit: defaultRunInherit,
    hasTty: Boolean(process.stdin.isTTY),
    wslConfPath: "/etc/wsl.conf",
    pid1CommPath: "/proc/1/comm",
    advise: (line) => process.stderr.write(`${line}\n`),
    ...options,
  };
  return { ...ctx, user: ctx.env.USER ?? userInfo().username };
}

async function windowsProfile(ctx) {
  const echoed = await ctx.run("cmd.exe", ["/c", "echo %USERPROFILE%"]);
  const windowsPath = echoed.stdout.trim();
  if (!echoed.ok || !windowsPath) return null;
  const mapped = await ctx.run("wslpath", ["-u", windowsPath]);
  return mapped.ok && mapped.stdout.trim() ? mapped.stdout.trim() : null;
}

async function wslconfigState(ctx) {
  const profile = await windowsProfile(ctx);
  if (!profile) return { found: false, done: false };
  const path = join(profile, ".wslconfig");
  const current = readOr(path);
  const merged = mergeIni(current, WSLCONFIG);
  return { found: true, path, merged, done: sameText(current, merged) };
}

const logonTaskExists = async (ctx) =>
  (await ctx.run("schtasks.exe", ["/Query", "/TN", TASK_NAME])).ok;

const systemdRunning = (ctx) => readOr(ctx.pid1CommPath).trim() === "systemd";

async function lingerEnabled(ctx) {
  const shown = await ctx.run("loginctl", ["show-user", ctx.user]);
  return shown.ok && /^Linger=yes$/m.test(shown.stdout);
}

// `wsl.exe --version` prints UTF-16, which arrives with NUL bytes between letters.
async function wslVersion(ctx) {
  const out = await ctx.run("wsl.exe", ["--version"]);
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(out.stdout.replace(/\0/g, ""));
  return out.ok && found ? found.slice(1, 4).map(Number) : null;
}

const versionIsCurrent = (version) =>
  version !== null &&
  version
    .join(".")
    .localeCompare(MIN_WSL_VERSION.join("."), undefined, { numeric: true }) >=
    0;

export async function wslPlatformStatus(options) {
  const ctx = context(options);
  const [config, task, version, linger] = await Promise.all([
    wslconfigState(ctx),
    logonTaskExists(ctx),
    wslVersion(ctx),
    lingerEnabled(ctx),
  ]);
  const checks = {
    wsl_wslconfig: config.done,
    wsl_logon_task: task,
    wsl_systemd: systemdRunning(ctx),
    wsl_linger: linger,
  };
  return {
    version: version?.join(".") ?? null,
    checks,
    missing: Object.keys(checks).filter((name) => !checks[name]),
  };
}

async function ensureSystemdFlag(ctx) {
  const current = readOr(ctx.wslConfPath);
  const merged = mergeIni(current, BOOT);
  if (sameText(current, merged)) return;
  const dir = mkdtempSync(join(tmpdir(), "wsl-conf-"));
  const staged = join(dir, "wsl.conf");
  try {
    writeFileSync(staged, merged);
    // A piped run cannot prompt; `sudo -n` works only if sudo needs no password.
    const copied = ctx.hasTty
      ? await ctx.runInherit("sudo", ["cp", staged, ctx.wslConfPath])
      : await ctx.run("sudo", ["-n", "cp", staged, ctx.wslConfPath]);
    if (!copied.ok)
      throw fail(
        ctx.hasTty ? "wsl_conf_write_failed" : NEEDS_TERMINAL,
        "could not write wsl.conf with administrator rights",
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function applyWslconfig(ctx, state) {
  const config = await wslconfigState(ctx);
  if (!config.found)
    throw fail("wsl_profile_not_found", "Windows profile not found");
  if (config.done) return;
  writeFileSync(config.path, config.merged);
  state.restart = true;
}

async function ensureLogonTask(ctx) {
  if (await logonTaskExists(ctx)) return;
  const distro = ctx.env.WSL_DISTRO_NAME;
  const created = await ctx.run("schtasks.exe", [
    "/Create",
    "/TN",
    TASK_NAME,
    "/SC",
    "ONLOGON",
    "/TR",
    `wsl.exe ${distro ? `-d ${distro} ` : ""}-e true`,
  ]);
  if (!created.ok)
    throw fail("wsl_logon_task_failed", "could not create the logon task");
}

async function adviseVersion(ctx) {
  if (!versionIsCurrent(await wslVersion(ctx)))
    ctx.advise("Run `wsl --update` in PowerShell to update WSL.");
}

async function ensureSystemd(ctx, state) {
  if (systemdRunning(ctx)) return;
  await ensureSystemdFlag(ctx);
  state.restart = true;
}

async function ensureLinger(ctx) {
  if (await lingerEnabled(ctx)) return;
  const enabled = await ctx.run("loginctl", ["enable-linger", ctx.user]);
  if (!enabled.ok) throw fail("wsl_linger_failed", "could not enable linger");
}

const restartRequired = (steps) => ({
  ok: true,
  data: {
    state: "restart-required",
    next_action: "restart-wsl",
    message: RESTART_MESSAGE,
    steps,
  },
  error: null,
});

const needsTerminal = () => ({
  ok: false,
  data: null,
  error: {
    code: NEEDS_TERMINAL,
    message: "Setup needs administrator rights to turn on systemd in WSL.",
    retryable: true,
    remediation: "Run `tldr-agents setup` again in a terminal.",
  },
});

// Returns null when the platform is ready, or a final setup result to return as is.
export async function wslPlatformSteps({ step, steps, ...options }) {
  const ctx = context(options);
  const state = { restart: false };
  try {
    await step("wsl_wslconfig", () => applyWslconfig(ctx, state));
    await step("wsl_logon_task", () => ensureLogonTask(ctx));
    await step("wsl_version", () => adviseVersion(ctx));
    await step("wsl_systemd", () => ensureSystemd(ctx, state));
    if (systemdRunning(ctx)) await step("wsl_linger", () => ensureLinger(ctx));
  } catch (error) {
    if (error.code === NEEDS_TERMINAL) return needsTerminal();
    throw error;
  }
  return state.restart ? restartRequired(steps) : null;
}
