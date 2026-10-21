import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Writable } from "node:stream";

import {
  maskDestination,
  readOwnerCredentials,
  writeOwnerCredentials,
} from "./owner_credentials.mjs";
import { EMAIL_ROUTE } from "./starport_email_route.mjs";
import { createEmailDisconnectMarker } from "./email_disconnect_marker.mjs";
import { tldrAgentHomeFor } from "./store.mjs";
import { projectCapabilities } from "./tldr_capabilities.mjs";
import { probeColdCapabilities } from "./tldr_capability_readers.mjs";

// Linux/WSL `tldr-agents setup|status|repair`. There is no signed app and no
// Aegis helper here, so email is "connected" when the owner credential file
// reads clean (the local client answers status "ready") and an email route is
// active. This never runs install/tldr-agent-bootstrap.sh.

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const UNIT = "helm-tasks.service";
const KEY_FLAGS = /^--(api-?key|key|agentmail-key)(=|$)/;

const fail = (code, message) => Object.assign(new Error(message), { code });

function log(level, event, fields = {}) {
  // stderr: stdout carries the JSON result. Never put the key in `fields`.
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
  );
}

async function defaultRun(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 120_000,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", code: error.code };
  }
}

const agents = (run, args) =>
  run(join(PACKAGE_ROOT, "bin", "tldr-agents"), args);
const tasks = (run, args) => agents(run, ["tasks", ...args]);

// Secret answers are not echoed on a TTY; piped input is one answer per line.
export function createPrompt({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  let muted = false;
  const sink = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: !!input.isTTY });
  const lines = input.isTTY ? null : rl[Symbol.asyncIterator]();
  const ask = async (question, { secret = false } = {}) => {
    if (!lines) {
      // Show the question first; mute only the typed answer.
      if (secret) output.write(question);
      muted = secret;
      const answer = await new Promise((done) =>
        rl.question(secret ? "" : question, done),
      );
      if (secret) output.write("\n");
      muted = false;
      return answer.trim();
    }
    output.write(question);
    const next = await lines.next();
    return next.done ? "" : String(next.value).trim();
  };
  return { ask, close: () => rl.close() };
}

async function collectCredentials(prompt, given) {
  const credentials = {
    apiKey: await prompt.ask("AgentMail API key (hidden): ", { secret: true }),
    inboxId: given.inboxId || (await prompt.ask("AgentMail inbox id: ")),
    ownerAddress: given.ownerAddress || (await prompt.ask("Owner email: ")),
  };
  return credentials;
}

function readCredentials(home) {
  try {
    return { valid: true, credentials: readOwnerCredentials({ home }) };
  } catch (error) {
    return { valid: false, code: error.code ?? "owner_credentials_invalid" };
  }
}

async function unitActive(run) {
  const result = await run("systemctl", ["--user", "is-active", UNIT]);
  return result.ok && result.stdout.trim() === "active";
}

async function defaultPoller() {
  return import("./linux_email_poller.mjs");
}

async function defaultTightbeam(env, home) {
  const { createTightbeamChannel } = await import("./tightbeam_channel.mjs");
  return createTightbeamChannel({
    home: tldrAgentHomeFor({ env, userHome: home }),
  });
}

async function readRoutes(tightbeam) {
  try {
    return await tightbeam.listEmailRoutes();
  } catch {
    return { ok: false };
  }
}

export async function linuxStatus({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  run = defaultRun,
  probe = probeColdCapabilities,
  poller = defaultPoller,
  tightbeam,
} = {}) {
  const cold = await probe();
  const credential = readCredentials(home);
  const [active, pollerState, routes] = await Promise.all([
    unitActive(run),
    poller()
      .then((mod) => mod.linuxEmailPollerStatus({ env, platform }))
      .catch(() => ({ present: false })),
    readRoutes(tightbeam ?? (await defaultTightbeam(env, home))),
  ]);
  const pending = createEmailDisconnectMarker({
    home: tldrAgentHomeFor({ env, userHome: home }),
  }).isPending();
  const previous = cold.data.capabilities;
  const nativeStatus = credential.valid
    ? "ready"
    : credential.code === "owner_credentials_missing"
      ? "unconfigured"
      : "unavailable";
  const capabilities = projectCapabilities({
    messaging: { ok: previous.messaging.state === "ready" },
    tasks: { ok: previous.tasks.state === "ready" },
    nativeStatus,
    appInstalled: true,
    emailRoutes: routes,
    emailDisconnectPending: pending,
  });
  const connected = capabilities.email.state === "connected";
  const state = connected
    ? active && pollerState.runnable === true
      ? "ready"
      : "repair-required"
    : nativeStatus === "unconfigured"
      ? "setup-required"
      : "repair-required";
  log("info", "linux_status", { state, email: capabilities.email.state });
  return {
    ok: true,
    data: {
      state,
      next_action:
        state === "ready"
          ? null
          : state === "setup-required"
            ? "setup"
            : "repair",
      capabilities,
      linux: {
        credential: credential.valid
          ? { valid: true }
          : { valid: false, code: credential.code },
        destination_masked: credential.valid
          ? maskDestination(credential.credentials.ownerAddress)
          : null,
        unit: { name: UNIT, active },
        poller: pollerState,
      },
    },
    error: null,
  };
}

// Setup and repair are the same idempotent steps; the key is asked for only
// when owner.json is missing or refused.
export async function linuxSetup({
  operation = "setup",
  env = process.env,
  home = homedir(),
  platform = process.platform,
  given = {},
  prompt,
  run = defaultRun,
  poller = defaultPoller,
  tightbeam,
  status = linuxStatus,
} = {}) {
  const steps = [];
  const step = async (name, fn) => {
    log("info", "linux_setup_step", { operation, step: name });
    try {
      await fn();
      steps.push({ name, ok: true });
    } catch (error) {
      log("error", "linux_setup_step_failed", {
        operation,
        step: name,
        code: error.code ?? null,
        stack: error.stack,
      });
      throw Object.assign(error, { step: name, steps });
    }
  };
  const checked = async (name, result) => {
    if (!result.ok) throw fail(`${name}_failed`, `${name} failed`);
  };
  try {
    await step("credentials", async () => {
      const current = readCredentials(home);
      if (current.valid) return;
      log("info", "linux_setup_prompt", { reason: current.code });
      const p = prompt ?? createPrompt();
      try {
        writeOwnerCredentials(await collectCredentials(p, given), { home });
      } finally {
        if (!prompt) p.close();
      }
    });
    await step("desired_state", async () =>
      checked(
        "desired_state",
        await tasks(run, [
          "desired-state",
          "set",
          "--mode",
          "live",
          "--outbound-mode",
          "live",
        ]),
      ),
    );
    await step("service", async () =>
      checked("service", await tasks(run, ["service", "update"])),
    );
    // A fresh install has no Tightbeam daemon; the route needs it. Idempotent.
    await step("messaging_bootstrap", async () =>
      checked(
        "messaging_bootstrap",
        await agents(run, ["messaging", "bootstrap"]),
      ),
    );
    await step("email_route", async () => {
      const channel = tightbeam ?? (await defaultTightbeam(env, home));
      const preflight = await channel.preflight();
      if (preflight?.ok === false)
        throw fail("tightbeam_preflight_failed", "tightbeam preflight failed");
      const route = await channel.registerEmailChannel(EMAIL_ROUTE);
      if (route?.ok === false)
        throw fail("email_route_failed", "email route registration failed");
    });
    await step("poller", async () => {
      const mod = await poller();
      await mod.installLinuxEmailPoller({ env, platform });
    });
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: {
        code: error.code ?? "LINUX_SETUP_FAILED",
        message: `${operation} stopped at step ${error.step ?? "unknown"}`,
        retryable: true,
        remediation: "tldr-agents repair --json",
      },
    };
  }
  const final = await status({ env, home, platform, run, poller, tightbeam });
  final.data.steps = steps;
  return final;
}

export async function main(args = process.argv.slice(2)) {
  const [operation, ...rest] = args;
  const given = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (KEY_FLAGS.test(arg)) {
      log("error", "linux_setup_key_argument_refused");
      process.stdout.write(
        `${JSON.stringify({ ok: false, data: null, error: { code: "KEY_ARGUMENT_REFUSED", message: "The AgentMail key is never taken as an argument. Run setup and enter it at the prompt, or pipe it on stdin.", retryable: false, remediation: "tldr-agents setup" } })}\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (arg === "--inbox") given.inboxId = rest[++i];
    else if (arg === "--owner") given.ownerAddress = rest[++i];
    else if (arg !== "--json") {
      process.stdout.write(
        `${JSON.stringify({ ok: false, data: null, error: { code: "STARPORT_OPERATION_UNSUPPORTED", message: `unknown argument ${arg}`, retryable: false, remediation: "Check tldr;" } })}\n`,
      );
      process.exitCode = 2;
      return;
    }
  }
  const result =
    operation === "status"
      ? await linuxStatus()
      : operation === "setup" || operation === "repair"
        ? await linuxSetup({ operation, given })
        : {
            ok: false,
            data: null,
            error: {
              code: "STARPORT_OPERATION_UNSUPPORTED",
              message: `tldr-agents ${operation} needs the signed tldr; app, which Linux does not have. Linux supports setup, status, and repair.`,
              retryable: false,
              remediation: "tldr-agents status",
            },
          };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && basename(process.argv[1]) === "linux_setup.mjs")
  await main();
