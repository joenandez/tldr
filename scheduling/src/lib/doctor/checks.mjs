import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { hintFor } from "./hint_map.mjs";
import { daemonLastTickPath } from "../daemon.mjs";

export function _resetCheckMemos() {
  // No check memoizes its result any more.
}

function hasCommandOnPath(command) {
  return (process.env.PATH || "").split(":").some((directory) => {
    try {
      return statSync(join(directory, command)).isFile();
    } catch {
      return false;
    }
  });
}

export async function check_daemon_tick_advancing({ now = Date.now() } = {}) {
  const path = daemonLastTickPath();
  if (!existsSync(path)) {
    return {
      ok: false,
      value: { last_tick_age_s: null },
      hint: hintFor("daemon_tick_advancing"),
      error: "no_tick_file",
    };
  }
  const timestamp = Date.parse(readFileSync(path, "utf8").trim());
  if (!Number.isFinite(timestamp)) {
    return {
      ok: false,
      value: { last_tick_age_s: null },
      hint: hintFor("daemon_tick_advancing"),
      error: "unparseable_timestamp",
    };
  }
  const age = Math.max(0, Math.floor((now - timestamp) / 1000));
  return {
    ok: age < 150,
    value: {
      last_tick_age_s: age,
      last_tick_ts: new Date(timestamp).toISOString(),
    },
    hint: age < 150 ? null : hintFor("daemon_tick_advancing"),
  };
}

// Helm has no runtime hooks: Tightbeam's session hooks record the session
// facts Helm reads. A Helm-owned entry left in a runtime's hook settings
// would fire a second hook for the same event (and point at a script that
// no longer ships), so its presence fails the check.
async function evaluateRetiredHooks(runtime, name) {
  const available =
    hasCommandOnPath(runtime) ||
    existsSync(
      join(
        homedir(),
        `.${runtime}`,
        runtime === "claude" ? "settings.json" : "hooks.json",
      ),
    );
  if (!available)
    return {
      ok: true,
      skipped: true,
      reason: `${runtime}_not_on_path`,
      value: { runtime },
    };

  const { inspectInstalledHooks } = await import("../bootstrap_hooks.mjs");
  const inspection = inspectInstalledHooks({ runtime });
  const retiredGroups = inspection?.retired_groups || [];
  if (retiredGroups.length > 0) {
    return {
      ok: false,
      value: { runtime, file: inspection?.file, retired_groups: retiredGroups },
      hint: hintFor(name),
      error: `retired_helm_hooks_present: ${retiredGroups
        .map((group) => group.event)
        .join(",")}`,
    };
  }
  return {
    ok: true,
    value: { runtime, file: inspection?.file, retired_groups: [] },
  };
}

export async function check_claude_retired_hooks_absent() {
  return evaluateRetiredHooks("claude", "claude_retired_hooks_absent");
}

export async function check_codex_retired_hooks_absent() {
  return evaluateRetiredHooks("codex", "codex_retired_hooks_absent");
}

// Helm reads session facts from Tightbeam through the tightbeam CLI. This
// asks for one session endpoint to prove that path answers.
export async function check_session_source_tightbeam() {
  const { listTightbeamSessions } = await import("../tightbeam_sessions.mjs");
  const started = Date.now();
  const result = await listTightbeamSessions({ limit: 1 });
  const latency_ms = Date.now() - started;
  return result.ok
    ? { ok: true, value: { source: "tightbeam", latency_ms } }
    : {
        ok: false,
        value: { source: "tightbeam", latency_ms, message: result.message },
        hint: hintFor("session_source_tightbeam"),
        error: result.error,
      };
}

export async function check_resolve_workspace_smoke() {
  const { resolveWorkspace, _internals } = await import(
    "../substrate/workspaces.mjs"
  );
  if (_internals?._getRegisteredResolver?.()) {
    return {
      ok: true,
      value: { source: "subspace-hook-registered" },
      gates_in_mode_override: false,
    };
  }
  const root = mkdtempSync(join(tmpdir(), "helm-doctor-workspace-"));
  try {
    mkdirSync(join(root, "smoke"));
    const result = resolveWorkspace("smoke", { workspacesRoot: root });
    const ok = result?.ok === true && result?.cwd === join(root, "smoke");
    return ok
      ? { ok: true, value: { source: result.source, cwd_ends_with: "smoke" } }
      : {
          ok: false,
          value: result,
          hint: hintFor("resolve_workspace_smoke"),
          error: result?.error || "resolver_unexpected_shape",
        };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function skillStatus(runtimeDirectory, name) {
  const root = join(homedir(), runtimeDirectory, "skills", name);
  const file = join(root, "SKILL.md");
  try {
    if (lstatSync(root).isSymbolicLink()) readlinkSync(root);
    return existsSync(file) && statSync(file).isFile()
      ? { ok: true }
      : { ok: false, path: file };
  } catch {
    return { ok: false, path: file };
  }
}

export async function check_skill_mirror_resolvable() {
  const runtimes = [[".claude", "claude"]];
  if (hasCommandOnPath("codex") || existsSync(join(homedir(), ".codex")))
    runtimes.push([".codex", "codex"]);
  const names = ["helm-tasks"];
  const broken = runtimes.flatMap(([directory, runtime]) =>
    names
      .map((name) => ({ runtime, name, ...skillStatus(directory, name) }))
      .filter((result) => !result.ok),
  );
  return broken.length === 0
    ? {
        ok: true,
        value: { resolved: runtimes.length * names.length, broken: 0 },
      }
    : {
        ok: false,
        value: { resolved: 0, broken: broken.length, broken_detail: broken },
        hint: hintFor("skill_mirror_resolvable"),
        error: "broken_or_missing_skills",
      };
}
