import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";

import { tldrCopilotRuntimeManifest } from "../../messaging/src/runtimes/copilot_contract.mjs";

// tldr's own `copilot` runtime registration, shared by Linux setup and the
// macOS setup/repair path. It registers the realpath of the running
// package's .copilot-plugin/hooks/hooks.json, asks the daemon to replace a
// stale record only after an identity_conflict (the daemon decides whether
// that record is tldr's own) unless a Claude Code plugin install still owns
// the binding, and then checks Academy's launch check: the
// local `hooks install --dry-run` must report this exact file as verified.

export const COPILOT_RUNTIME_RETRY = "tldr-agents setup";

const execFileAsync = promisify(execFile);

function log(level, event, fields) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
  );
}

const fail = (code, message) =>
  Object.assign(new Error(message), {
    code,
    remediation: COPILOT_RUNTIME_RETRY,
  });

function parsed(result) {
  try {
    return JSON.parse(result?.stdout ?? "");
  } catch {
    return null;
  }
}

// A `run`-shaped command runner: { ok, stdout } with stdout kept on failure,
// because the messaging CLI prints its --json error there.
export async function runCommand(command, args) {
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

const CLAUDE_PLUGIN_NOTE =
  "Claude Code's tldr plugin owns the Copilot binding.";

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// The hooks file `hooks install --dry-run` verifies for the stored record.
async function verifiedCopilotFile(messaging) {
  const report =
    parsed(
      await messaging([
        "hooks",
        "install",
        "--runtime",
        "copilot",
        "--dry-run",
        "--json",
      ]),
    )?.result?.report ?? [];
  return (
    report.find(
      (entry) => entry.runtime === "copilot" && entry.status === "verified",
    )?.file ?? null
  );
}

// Academy's resolver prefers a Claude Code plugin install, so a stored record
// that still verifies under ~/.claude/plugins/ is never replaced.
async function claudePluginBinding(messaging, home) {
  const file = await verifiedCopilotFile(messaging);
  const plugins = join(home, ".claude", "plugins");
  const roots = [plugins, realpathOrNull(plugins)].filter(Boolean);
  return file && roots.some((root) => file.startsWith(`${root}${sep}`))
    ? file
    : null;
}

// Register, and after an identity_conflict either keep a Claude plugin
// binding or send one replace request (the daemon decides if it is stale).
async function registerManifest({ hooksFile, messaging, home }) {
  const dir = mkdtempSync(join(tmpdir(), "tldr-copilot-runtime-"));
  const manifest = join(dir, "copilot.json");
  const register = async (extra) =>
    parsed(
      await messaging(["runtime", "register", manifest, "--json", ...extra]),
    );
  try {
    writeFileSync(
      manifest,
      JSON.stringify(tldrCopilotRuntimeManifest(hooksFile)),
      { mode: 0o600 },
    );
    const first = await register([]);
    if (first?.error?.code !== "identity_conflict") return { result: first };
    const kept = await claudePluginBinding(messaging, home);
    if (!kept)
      log("info", "copilot_runtime_replace_requested", {
        hooks_file: hooksFile,
      });
    return kept ? { kept } : { result: await register(["--replace-stale"]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `messaging(args)` runs tldr's messaging CLI and resolves to { ok, stdout }.
export async function registerOwnCopilotRuntime({
  packageRoot,
  messaging,
  home = homedir(),
}) {
  const hooksFile = realpathSync(
    join(packageRoot, ".copilot-plugin", "hooks", "hooks.json"),
  );
  const { result, kept } = await registerManifest({
    hooksFile,
    messaging,
    home,
  });
  if (kept) {
    const outcome = {
      hooks_file: hooksFile,
      replayed: false,
      replaced: false,
      kept_existing: kept,
      note: CLAUDE_PLUGIN_NOTE,
    };
    log("info", "copilot_runtime_kept_existing", outcome);
    return outcome;
  }
  if (result?.ok !== true) {
    log("error", "copilot_runtime_register_failed", {
      hooks_file: hooksFile,
      code: result?.error?.code ?? null,
    });
    throw fail(
      "copilot_runtime_register_failed",
      `Copilot runtime registration failed (${result?.error?.code ?? "no response"})`,
    );
  }
  if ((await verifiedCopilotFile(messaging)) !== hooksFile) {
    log("error", "copilot_runtime_unverified", { hooks_file: hooksFile });
    throw fail(
      "copilot_runtime_unverified",
      `Copilot hooks for ${hooksFile} did not verify after registration`,
    );
  }
  const outcome = {
    hooks_file: hooksFile,
    replayed: result.result.replayed === true,
    replaced: result.result.replaced === true,
  };
  log("info", "copilot_runtime_registered", outcome);
  return outcome;
}
