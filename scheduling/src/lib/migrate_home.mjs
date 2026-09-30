// `helm-tasks system migrate-home`: rewrite the absolute paths Helm stores
// under its home after the home directory itself has been renamed (Phase E,
// item 19: ~/.helm -> ~/.tldr-agents/helm).
//
// The rename is the caller's job (the state-root migration orchestrator). This
// command only rewrites stored values that begin with the old home prefix so
// they begin with the new one:
//
//   runtime.sqlite  scope_registry.storage_root
//                   scope_registry.source_json (the imported scopes.json row)
//                   scope_registry_metadata.last_backup_path
//   scopes.json     scopes[].storage_root (the sentinel trusts this value)
//   workspaces/*/scope.json   storage_root
//   identity.json   agentmail_key_path (legacy field)
//
// History (logical_runs.metadata_json, events, run logs) is left alone and only
// counted; the ~/.helm compatibility symlink covers it.
//
// Contract (E4 calls this): every stored value is planned before anything is
// written; the database changes commit in one transaction; each file is
// replaced atomically (sibling temp file, then rename). A second run finds
// nothing to rewrite and reports already_migrated. A --dry-run may also run
// before the rename, reading the stores at --from. Exit codes: 0 success,
// 2 usage error, 3 refusal, 1 unexpected failure.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { TASKS_COMMAND } from "./helm_context.mjs";
import { isProcessAlive } from "./process_liveness.mjs";
import {
  emptyRewrites,
  planFileRewrites,
  rewritePathPrefix,
  rewriteRegistry,
  workspaceDirs,
  writeFileRewrites,
} from "./migrate_home_rewrites.mjs";

export { rewritePathPrefix };

export const MIGRATE_HOME_COMMAND = "system migrate-home";
export const MIGRATE_HOME_USAGE =
  `${TASKS_COMMAND} system migrate-home --from <old-helm-home-abs-path> --to <new-helm-home-abs-path> [--dry-run] --json`;

export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_FAILED = 1;

const MAX_REPORTED_SKIPS = 50;

export class MigrateHomeError extends Error {
  constructor(code, message, { exitCode = EXIT_FAILED, details = {} } = {}) {
    super(message);
    this.name = "MigrateHomeError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function defaultLogger(record) {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function stripTrailingSlashes(path) {
  const trimmed = String(path).replace(/\/+$/, "");
  return trimmed || "/";
}

export function validateMigrateHomeArgs({ from, to } = {}) {
  const usage = (message, details = {}) =>
    new MigrateHomeError("usage_error", message, {
      exitCode: EXIT_USAGE,
      details: { usage: MIGRATE_HOME_USAGE, ...details },
    });
  if (typeof from !== "string" || from.length === 0) {
    throw usage("--from <old-helm-home-abs-path> is required");
  }
  if (typeof to !== "string" || to.length === 0) {
    throw usage("--to <new-helm-home-abs-path> is required");
  }
  if (!isAbsolute(from)) throw usage("--from must be an absolute path", { from });
  if (!isAbsolute(to)) throw usage("--to must be an absolute path", { to });
  const normalizedFrom = stripTrailingSlashes(resolve(from));
  const normalizedTo = stripTrailingSlashes(resolve(to));
  if (normalizedFrom === normalizedTo) {
    throw usage("--from and --to must differ", {
      from: normalizedFrom,
      to: normalizedTo,
    });
  }
  // A target inside the old prefix would still match the old prefix after
  // the rewrite, so a second run would rewrite it again.
  if (rewritePathPrefix(normalizedTo, normalizedFrom, normalizedTo) !== null) {
    throw usage("--to must not be inside --from", {
      from: normalizedFrom,
      to: normalizedTo,
    });
  }
  return { from: normalizedFrom, to: normalizedTo };
}

const HELM_HOME_MARKERS = ["runtime.sqlite", "scopes.json", "workspaces"];

function holdsHelmData(path) {
  return HELM_HOME_MARKERS.some((name) => existsSync(join(path, name)));
}

function assertTargetIsHelmHome(to) {
  let stat;
  try {
    stat = statSync(to);
  } catch {
    throw new MigrateHomeError(
      "target_missing",
      `--to ${to} does not exist; rename the old Helm home to it first`,
      { exitCode: EXIT_REFUSED, details: { to } },
    );
  }
  if (!stat.isDirectory()) {
    throw new MigrateHomeError(
      "target_not_directory",
      `--to ${to} is not a directory`,
      { exitCode: EXIT_REFUSED, details: { to } },
    );
  }
  if (!holdsHelmData(to)) {
    throw new MigrateHomeError(
      "target_not_helm_home",
      `--to ${to} holds no Helm data (none of ${HELM_HOME_MARKERS.join(", ")})`,
      { exitCode: EXIT_REFUSED, details: { to, markers: HELM_HOME_MARKERS } },
    );
  }
}

// Same test as service_restart_safety.mjs, over every workspace under the
// target home: a run is active when its active-runs.json entry names a live pid.
export function findActiveHelmRuns(to, { pidAlive = isProcessAlive } = {}) {
  const active = [];
  for (const dir of workspaceDirs(to)) {
    const path = join(dir, "active-runs.json");
    if (!existsSync(path)) continue;
    let runs;
    try {
      runs = JSON.parse(readFileSync(path, "utf8"))?.runs;
    } catch {
      continue;
    }
    if (!runs || typeof runs !== "object" || Array.isArray(runs)) continue;
    for (const [jobId, entry] of Object.entries(runs)) {
      if (!pidAlive(entry?.pid)) continue;
      active.push({
        workspace: dir,
        job_id: jobId,
        run_id: entry?.run_id || null,
        pid: Number(entry.pid),
      });
    }
  }
  return active;
}

export function migrateHelmHome({
  from: rawFrom,
  to: rawTo,
  dryRun = false,
  pidAlive = isProcessAlive,
  now = () => new Date().toISOString(),
  logger = defaultLogger,
} = {}) {
  const startedAt = Date.now();
  const log = (event, fields = {}) =>
    logger({ event, ts: new Date().toISOString(), ...fields });
  const refuse = (err) => {
    log("helm.migrate_home.refused", {
      status: "refused",
      result: { code: err.code, exit_code: err.exitCode },
      latency_ms: Date.now() - startedAt,
    });
    throw err;
  };

  let from;
  let to;
  try {
    ({ from, to } = validateMigrateHomeArgs({ from: rawFrom, to: rawTo }));
  } catch (err) {
    return refuse(err);
  }
  log("helm.migrate_home.start", {
    status: "started",
    params: { from, to, dry_run: Boolean(dryRun) },
  });

  try {
    // A dry run before the rename (the orchestrator's preflight) reads the
    // stores at --from and reports what the real run would rewrite after it.
    if (!(dryRun && !existsSync(to) && holdsHelmData(from))) {
      assertTargetIsHelmHome(to);
    }
  } catch (err) {
    return refuse(err);
  }
  const root = existsSync(to) ? to : from;

  const activeRuns = findActiveHelmRuns(root, { pidAlive });
  if (activeRuns.length > 0) {
    return refuse(
      new MigrateHomeError(
        "active_runs_in_progress",
        `refusing to migrate the Helm home while ${activeRuns.length} Helm run(s) are active`,
        { exitCode: EXIT_REFUSED, details: { active_runs: activeRuns } },
      ),
    );
  }

  const rewrites = emptyRewrites();
  const skipped = [];
  const fileWrites = planFileRewrites({ from, to, root, rewrites, skipped });
  const registry = rewriteRegistry(join(root, "runtime.sqlite"), {
    from,
    to,
    rewrites,
    dryRun,
    now,
  });
  if (registry.committedLatencyMs !== null) {
    log("helm.migrate_home.db_committed", {
      status: "ok",
      result: {
        scope_registry_storage_root: rewrites.scope_registry_storage_root,
        scope_registry_source_json: rewrites.scope_registry_source_json,
        scope_registry_last_backup_path:
          rewrites.scope_registry_last_backup_path,
      },
      latency_ms: registry.committedLatencyMs,
    });
  }

  if (!dryRun && fileWrites.length > 0) {
    const filesStarted = Date.now();
    let written;
    try {
      written = writeFileRewrites(fileWrites);
    } catch (err) {
      log("helm.migrate_home.files_failed", {
        status: "error",
        result: { written: err.written, planned: fileWrites.length },
        error: { message: err?.message || String(err), stack: err?.stack },
      });
      throw new MigrateHomeError(
        "migrate_home_failed",
        `rewrote ${err.written} of ${fileWrites.length} files before failing: ${err?.message || err}; rerun to finish (the command is idempotent)`,
        {
          exitCode: EXIT_FAILED,
          details: { written: err.written, planned: fileWrites.length, rewrites },
        },
      );
    }
    log("helm.migrate_home.files_written", {
      status: "ok",
      result: { written },
      latency_ms: Date.now() - filesStarted,
    });
  }

  const total = Object.values(rewrites).reduce((sum, n) => sum + n, 0);
  const data = {
    dry_run: Boolean(dryRun),
    already_migrated: total === 0,
    from,
    to,
    read_from: root,
    rewrites,
    left_as_history: { logical_runs_metadata_json: registry.historyReferences },
    skipped: skipped.slice(0, MAX_REPORTED_SKIPS),
    skipped_count: skipped.length,
  };
  log("helm.migrate_home.done", {
    status: "ok",
    result: {
      dry_run: data.dry_run,
      already_migrated: data.already_migrated,
      rewrites,
      skipped_count: skipped.length,
    },
    latency_ms: Date.now() - startedAt,
  });
  return data;
}
