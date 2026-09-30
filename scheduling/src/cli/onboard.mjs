import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isIdentityConfigured,
  readIdentity,
  redactIdentity,
  writeIdentity,
} from "../lib/identity.mjs";
import { _internals as workspacesInternals } from "../lib/substrate/workspaces.mjs";
import {
  readAgentDefaults,
  validateAgentDefaults,
} from "../lib/agent_fallback.mjs";
import { installAgentSkills } from "../lib/agent_skills.mjs";
import { TASKS_COMMAND } from "../lib/helm_context.mjs";
const RECONFIGURE_FIELDS = new Set([
  "name",
  "email",
  "workspaces-root",
  "default-workspace",
  "agents",
]);

function makePrompter({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  return {
    ask: (question) => new Promise((done) => rl.question(question, done)),
    close: () => rl.close(),
  };
}

function detectSubspaceWorkspaceResolver() {
  try {
    return typeof workspacesInternals._getRegisteredResolver?.() === "function";
  } catch {
    return false;
  }
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function printDiff(before, after, stdout) {
  for (const key of new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ])) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      stdout.write(
        `  ${key}: ${JSON.stringify(before?.[key])} → ${JSON.stringify(after?.[key])}\n`,
      );
    }
  }
}

function defaultProjectsRoot() {
  for (const candidate of ["Dev", "Code", "Projects", "src"]) {
    const root = join(homedir(), candidate);
    if (existsSync(root)) return root;
  }
  return join(homedir(), "Dev");
}

function agentDefaultsFromFlags(flags, current = null) {
  const existing = readAgentDefaults(current);
  return validateAgentDefaults({
    primary:
      flags["primary-agent"] || flags["default-agent"] || existing.primary,
    secondary: flags["secondary-agent"] || existing.secondary,
    fallback_policy: flags["fallback-policy"] || existing.fallback_policy,
  });
}

async function gatherInitial({ flags, prompter, stdout, nonInteractive }) {
  let name = flags.name || null;
  let email = flags.email || null;
  let workspacesRoot = flags["workspaces-root"] || null;
  const subspaceDetected = detectSubspaceWorkspaceResolver();
  if (nonInteractive) {
    const missing = [!name && "--name", !email && "--email"].filter(Boolean);
    if (missing.length > 0)
      return { ok: false, error: "missing_required_flags", missing };
  } else {
    stdout.write("Setting up Helm task and assignment operations.\n\n");
    if (!name)
      name = (
        await prompter.ask("  1. What should your agents call you?\n     ")
      ).trim();
    if (!email)
      email = (
        await prompter.ask("\n  2. What email should they reach you at?\n     ")
      ).trim();
    if (!subspaceDetected && !workspacesRoot) {
      const detected = defaultProjectsRoot();
      const answer = await prompter.ask(
        `\n  3. Where should Helm create assignment workspaces? [${detected}]\n     `,
      );
      workspacesRoot = answer.trim() || detected;
    }
  }
  if (!subspaceDetected && !workspacesRoot)
    workspacesRoot = defaultProjectsRoot();
  if (!name) return { ok: false, error: "missing_name" };
  if (!email || !email.includes("@"))
    return { ok: false, error: "invalid_email" };
  const defaults = agentDefaultsFromFlags(flags);
  if (!defaults.ok)
    return { ok: false, error: "invalid_agent_defaults", hint: defaults.error };
  return {
    ok: true,
    identity: {
      name,
      email,
      workspaces_root: subspaceDetected ? null : expandHome(workspacesRoot),
      subspace_managed_workspaces: subspaceDetected,
      agent_defaults: defaults.value,
    },
    subspaceDetected,
  };
}

async function gatherReconfigure({
  field,
  flags,
  current,
  prompter,
  stdout,
  nonInteractive,
}) {
  const next = { ...current };
  const ask = async (label, flag, currentValue) => {
    if (flags[flag]) return flags[flag];
    if (nonInteractive) return null;
    const value = await prompter.ask(
      `${label} [current: ${currentValue ?? "(unset)"}]: `,
    );
    return value.trim() || currentValue;
  };
  if (field === "name") next.name = await ask("Name", "name", current.name);
  if (field === "email")
    next.email = await ask("Email", "email", current.email);
  if (field === "workspaces-root") {
    if (detectSubspaceWorkspaceResolver()) {
      next.workspaces_root = null;
      next.subspace_managed_workspaces = true;
      stdout.write(
        "Workspaces root — Subspace-managed; not reconfigurable here.\n",
      );
    } else
      next.workspaces_root = expandHome(
        await ask(
          "Workspaces root",
          "workspaces-root",
          current.workspaces_root,
        ),
      );
  }
  if (field === "default-workspace")
    next.default_workspace = await ask(
      "Default workspace",
      "default-workspace",
      current.default_workspace,
    );
  if (field === "agents") {
    const defaults = agentDefaultsFromFlags(flags, current);
    if (!defaults.ok)
      return {
        ok: false,
        error: "invalid_agent_defaults",
        hint: defaults.error,
      };
    next.agent_defaults = defaults.value;
  }
  if (
    nonInteractive &&
    field !== "agents" &&
    field !== "workspaces-root" &&
    !flags[field]
  ) {
    return {
      ok: false,
      error: "missing_required_flag_for_reconfigure",
      missing: [`--${field}`],
    };
  }
  if (!next.email?.includes("@")) return { ok: false, error: "invalid_email" };
  return { ok: true, identity: next };
}

async function runVerifyStage({
  flags,
  scope,
  doctorExec,
  stdout,
  stderr,
  isRefresh,
}) {
  if (flags["no-verify"]) {
    stdout.write("  ⚠ Verify skipped (--no-verify)\n");
    return { ok: true, verify: { skipped: true } };
  }
  const exec =
    doctorExec ||
    (async (options) =>
      (await import("../lib/doctor/index.mjs")).runDeepDoctor(options));
  const verify = await exec({
    mode: "task_assignment",
    bands: null,
    scope,
    now: Date.now(),
  });
  if (verify?.ok) {
    stdout.write("  ✓ Verified\n");
    return { ok: true, verify };
  }
  const failing = verify?.failing_checks?.[0] || "unknown";
  const hint =
    (await import("../lib/doctor/hint_map.mjs")).hintFor(failing) ||
    `${TASKS_COMMAND} doctor --deep`;
  const message = isRefresh
    ? `Verify failed: ${failing}. Refresh does not repair an existing install; run \`${hint}\` and then re-run \`${TASKS_COMMAND} onboard\`.`
    : `Verify failed: ${failing}. Run \`${hint}\` to retry.`;
  stderr.write(`${message}\n`);
  return { ok: false, verify: verify || { ok: false }, failing, message };
}

export async function runOnboard({
  flags = {},
  scope = null,
  schedulerScriptPath = null,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  skillInstallExec = null,
  doctorExec = null,
  prompterOverride = null,
  ensureWorkspaceUpExec = null,
} = {}) {
  const nonInteractive = Boolean(flags["non-interactive"]);
  const prompter = nonInteractive
    ? null
    : prompterOverride || makePrompter({ stdin, stdout });
  try {
    if (flags.reconfigure) {
      if (!RECONFIGURE_FIELDS.has(flags.reconfigure))
        return {
          ok: false,
          error: "invalid_reconfigure_field",
          hint: `Must be one of ${[...RECONFIGURE_FIELDS].join(" | ")}`,
        };
      const current = readIdentity();
      if (!current)
        return {
          ok: false,
          error: "identity_not_configured",
          hint: `Run \`${TASKS_COMMAND} onboard\` first.`,
        };
      const gathered = await gatherReconfigure({
        field: flags.reconfigure,
        flags,
        current,
        prompter,
        stdout,
        nonInteractive,
      });
      if (!gathered.ok) return gathered;
      stdout.write("\nDiff:\n");
      printDiff(current, gathered.identity, stdout);
      const written = writeIdentity(gathered.identity);
      return {
        ok: true,
        action: "reconfigure",
        field: flags.reconfigure,
        identity: redactIdentity(gathered.identity),
        identity_path: written.path,
      };
    }
    if (isIdentityConfigured()) {
      const skills = (skillInstallExec || installAgentSkills)({ stdout });
      const verified = await runVerifyStage({
        flags,
        scope,
        doctorExec,
        stdout,
        stderr,
        isRefresh: true,
      });
      return verified.ok
        ? {
            ok: true,
            action: "refresh_skills",
            skill_install: skills,
            verify: verified.verify,
          }
        : {
            ok: false,
            action: "refresh_skills",
            error: "verify_failed",
            skill_install: skills,
            verify: verified.verify,
          };
    }
    const gathered = await gatherInitial({
      flags,
      prompter,
      stdout,
      nonInteractive,
    });
    if (!gathered.ok) return gathered;
    const written = writeIdentity(gathered.identity);
    stdout.write(
      `\n  ✓ Identity saved${gathered.subspaceDetected ? "  (Subspace-managed workspaces)" : ""}\n`,
    );
    const skills = (skillInstallExec || installAgentSkills)({ stdout });
    for (const entry of skills.results || [])
      stdout.write(
        `  ${entry.ok ? "✓" : "✗"} Skill ${entry.ok ? "installed" : "skipped"}: ${entry.name}\n`,
      );
    let serviceUp = null;
    try {
      const ensure =
        ensureWorkspaceUpExec ||
        (async (activeScope, path) =>
          (await import("../lib/workspace_service.mjs")).ensureWorkspaceUp(
            activeScope,
            path,
          ));
      serviceUp = await ensure(scope, schedulerScriptPath);
      stdout.write(
        serviceUp?.health?.healthy
          ? "  ✓ Scheduler running\n"
          : `  ⚠ Scheduler start pending — run \`${TASKS_COMMAND} up\` to retry\n`,
      );
    } catch (error) {
      serviceUp = { error: error?.message || String(error) };
      stdout.write(
        `  ⚠ Scheduler start pending — run \`${TASKS_COMMAND} up\` to retry\n`,
      );
    }
    const verified = await runVerifyStage({
      flags,
      scope,
      doctorExec,
      stdout,
      stderr,
      isRefresh: false,
    });
    if (!verified.ok)
      return {
        ok: false,
        action: "onboard",
        error: "verify_failed",
        verify: verified.verify,
        identity: redactIdentity(gathered.identity),
        identity_path: written.path,
        skill_install: skills,
        service_up: serviceUp,
      };
    stdout.write("\n──\n\nYou're done. Task and assignment setup is ready.\n");
    return {
      ok: true,
      action: "onboard",
      mode: "task_assignment",
      identity: redactIdentity(gathered.identity),
      identity_path: written.path,
      skill_install: skills,
      service_up: serviceUp,
      subspace_detected: gathered.subspaceDetected,
      verify: verified.verify,
    };
  } finally {
    prompter?.close();
  }
}
