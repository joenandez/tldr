#!/usr/bin/env node
// helm-assignments — skill-backed assignment management CLI.
// Dispatches on the same json_io shape as helm-tasks (always-JSON + --pretty).
// Implements all verbs: create / list / show / path / update / archive /
//   unarchive / run / runs / logs.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, output, fail } from "./lib/json_io.mjs";
import { ASSIGNMENTS_COMMAND, TASKS_COMMAND } from "./lib/helm_context.mjs";
import { resolveScope, loadJobsReadOnly, runLogPaths } from "./lib/store.mjs";
import { mutateJobs } from "./lib/scope_runtime.mjs";
import {
  normalizeJob,
  validateJob,
  setNextIfMissing,
} from "./lib/job_service.mjs";
import { buildScheduleFromFlags } from "./lib/schedule_flags.mjs";
import {
  assignmentHome,
  resolveAssignmentSkillSource,
  slugifyForAssignment,
} from "./lib/assignment_artifacts.mjs";
import {
  historyForJob,
  resolveRunForLogs,
} from "./lib/observability_service.mjs";
import { runJobNow } from "./lib/dispatch_service.mjs";
import { findRunCompletion } from "./lib/run_completion.mjs";
import {
  activationRepairCommands,
  ensureScopeActivation,
  registerScopeForDispatch,
} from "./lib/scope_activation.mjs";
import {
  resolveDestinationScope,
  retargetAssignment,
} from "./lib/assignment_retarget.mjs";
import {
  assignmentDescription,
  assignmentLastRunAt,
  assignmentProvider,
  assignmentProviderConfig,
  filterAssignmentsByStatus,
  listAssignmentsAcrossScopes,
  localAssignmentRow,
  renderSchedule,
} from "./lib/assignment_list.mjs";
import { handleAssignmentRuns } from "./lib/assignment_runs.mjs";
import {
  applyProviderPatch,
  resolveAssignmentUpdateInput,
  restoreSkillUpdate,
  writeSkillUpdate,
} from "./lib/assignment_update_input.mjs";
import {
  applyRuntimeOptions,
  publishedRuntimeOptions,
  readRuntimeOptionFlags,
  runtimeOptionCapabilities,
  storedRuntimeOptions,
  validateRuntimeOptions,
} from "./lib/runtime_options.mjs";
import {
  COMPLETION_DELIVERY_MODES,
  completionDeliveryInput,
  effectiveCompletionDelivery,
} from "./lib/assignment_completion_delivery.mjs";

const isAssignment = (j) =>
  Array.isArray(j.tags) && j.tags.includes("assignment");

function academyProviderConfigFromFlags(flags) {
  const config = {};
  if (flags["academy-agent"] !== undefined)
    config.academy_agent =
      flags["academy-agent"] === "null" ? null : flags["academy-agent"];
  if (flags["academy-runtime"] !== undefined)
    config.academy_runtime =
      flags["academy-runtime"] === "null" ? null : flags["academy-runtime"];
  return Object.keys(config).length > 0 ? config : null;
}

// Applies a provider-configuration patch to what is already stored. A `null`
// value clears its key (the literal "null" convention this CLI already uses for
// runtime options); everything the patch does not mention survives, so changing
// one field never silently drops the rest.
function mergeProviderConfig(existing, patch) {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function applyProviderConfig(job, patch) {
  const merged = mergeProviderConfig(
    job.execution_hints?.provider_config,
    patch,
  );
  job.execution_hints = { ...(job.execution_hints || {}) };
  if (merged) job.execution_hints.provider_config = merged;
  else delete job.execution_hints.provider_config;
}

// ─── scopeOwner — opaque lease-owner string for catalog.lock ─────────────────
function scopeOwner(verb) {
  return `assign-${verb}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

// ─── copyDirRecursive — non-atomic dir copy for --skill adoption ──────────────
// Modeled on src/cli/onboard.mjs:863-879 (copyDirRecursive).
function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      copyFileSync(s, d);
      try {
        chmodSync(d, st.mode & 0o777);
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── scaffoldSkillMd — atomic single-file write (writeEmailConfig pattern) ───
function scaffoldSkillMd(skillPath, homeDir, { name, slug, description, id }) {
  mkdirSync(homeDir, { recursive: true });
  const lines = [
    `---`,
    `name: ${slug}`,
    `description: ${description}`,
    `assignment_id: ${id}`,
    `---`,
    ``,
    `# ${name}`,
    ``,
    `> This is the backing skill for Helm Assignment "${name}" (${id}).`,
    `> It lives at .helm/assignments/${slug}/SKILL.md and you (the running agent)`,
    `> may edit it; changes take effect on the next run.`,
    ``,
    `## Goal`,
    `${description}`,
    ``,
    `## Steps`,
    `1. <author the actual instructions here>`,
    ``,
    `## References`,
    `- (add files under references/ and link them)`,
    ``,
  ];
  const body = lines.join("\n");
  const tmp = `${skillPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, skillPath);
}

// ─── identityResolve — resolve <id|name> among assignment jobs ───────────────
// Returns {job} on success, {error:"not_found"} or {error:"ambiguous",matches}.
function identityResolve(jobs, q) {
  const byId = jobs.find((j) => j.id === q);
  if (byId) return { job: byId };
  const byName = jobs.filter((j) => j.name === q);
  if (byName.length === 1) return { job: byName[0] };
  if (byName.length > 1) return { error: "ambiguous", matches: byName };
  return { error: "not_found" };
}

// ─── identityFailOrJob — resolve or emit fail + exit ─────────────────────────
function identityFailOrJob(cmd, assignments, q, pretty) {
  const res = identityResolve(assignments, q);
  if (res.error === "ambiguous") {
    const names = res.matches.map((m) => m.name).join(", ");
    fail(
      cmd,
      "ambiguous_name",
      `error: ambiguous "${q}" matches: ${names}`,
      {},
      pretty,
    );
    process.exit(1);
  }
  if (res.error === "not_found" || !res.job) {
    fail(
      cmd,
      "not_found",
      `error: no assignment matching "${q}" (try: ${ASSIGNMENTS_COMMAND} list)`,
      {},
      pretty,
    );
    process.exit(1);
  }
  return res.job;
}

// ─── runtimeOptionsOrFail — validate runtime options or emit fail + exit ─────
// Rejects an option the provider does not accept instead of dropping it, so a
// caller never believes a setting took effect that the launch will not carry.
function runtimeOptionsOrFail(
  cmd,
  { flags, provider, providerConfig, existing },
  pretty,
) {
  const read = readRuntimeOptionFlags(flags, cmd === "create");
  const result = read.error
    ? read
    : validateRuntimeOptions({
        provider,
        providerConfig,
        patch: read.patch,
        existing,
      });
  if (result.error) {
    fail(
      cmd,
      result.error.code,
      result.error.message,
      result.error.details || {},
      pretty,
    );
    process.exit(2);
  }
  return {
    changed: Boolean(read.present),
    options: result.options,
    patch: read.patch || null,
  };
}

// ─── activateOrFail — --activate gate; nothing is written unless it passes ───
async function activateOrFail(cmd, scope, pretty) {
  let activation;
  try {
    activation = await ensureScopeActivation(scope);
  } catch (err) {
    fail(
      cmd,
      err.code || "activation_failed",
      String(err.message || err),
      { ...(err.details || {}), repair: activationRepairCommands(scope) },
      pretty,
    );
    process.exit(err.exitCode || 1);
  }
  if (!activation.will_dispatch) {
    fail(
      cmd,
      "runtime_unhealthy",
      `scheduler runtime unhealthy: ${activation.health?.reason || "unknown"}`,
      { activation },
      pretty,
    );
    process.exit(1);
  }
  return activation;
}

// ─── Verb: create ─────────────────────────────────────────────────────────────
async function handleCreate(flags, pretty) {
  const cmd = "create";
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });

  // ── Validate name ────────────────────────────────────────────────────────
  const name = typeof flags.name === "string" ? flags.name.trim() : "";
  if (!name) {
    fail(cmd, "name_required", "--name is required", {}, pretty);
    process.exit(1);
  }

  // ── Build + validate schedule (required; writes nothing on failure) ──────
  let schedule;
  try {
    schedule = buildScheduleFromFlags(flags);
  } catch (err) {
    fail(
      cmd,
      "invalid_schedule",
      `invalid schedule: ${err.message}`,
      {},
      pretty,
    );
    process.exit(2);
  }
  if (!schedule) {
    fail(
      cmd,
      "invalid_schedule",
      "invalid schedule: a schedule flag is required (--in, --at, --cron, or --every)",
      {},
      pretty,
    );
    process.exit(2);
  }

  const completionDelivery = completionDeliveryInput(
    flags["completion-delivery"],
    { required: true },
  );
  if (completionDelivery.error) {
    fail(
      cmd,
      completionDelivery.error === "required"
        ? "completion_delivery_required"
        : "completion_delivery_invalid",
      `--completion-delivery must be one of: ${COMPLETION_DELIVERY_MODES.join("|")}`,
      {},
      pretty,
    );
    process.exit(2);
  }

  // ── Derive paths ─────────────────────────────────────────────────────────
  const slug = slugifyForAssignment(name);
  const home = assignmentHome(scope.cwd, slug);
  const skillPath = join(home, "SKILL.md");
  const id = `assignment-${randomBytes(16).toString("hex")}`;
  const description =
    typeof flags.description === "string" ? flags.description : "";

  // ── Validate --skill source before writing anything ────────────────────
  let skillSrc = null;
  if (flags.skill) {
    skillSrc = resolve(String(flags.skill));
    if (!existsSync(skillSrc)) {
      fail(
        cmd,
        "skill_not_found",
        `backing skill not found at ${skillSrc}`,
        {},
        pretty,
      );
      process.exit(1);
    }
  }

  // ── Pre-validate job record (validates provider, schedule, etc.) ─────────
  // Validate BEFORE materializing anything so failures write nothing to disk.
  const provider = typeof flags.provider === "string" ? flags.provider : null;
  const executionHints = { provider, session_required: true, managed: true };
  const providerConfig = academyProviderConfigFromFlags(flags);
  if (providerConfig) executionHints.provider_config = providerConfig;
  const runtime = runtimeOptionsOrFail(
    cmd,
    { flags, provider, providerConfig, existing: null },
    pretty,
  );
  const jobInput = {
    id,
    name,
    prompt: {
      type: "inline",
      value: `Run the skill at ${skillPath} and follow it.`,
    },
    schedule,
    execution_hints: applyRuntimeOptions(
      executionHints,
      runtime.options,
      runtime.patch,
    ),
    tags: ["assignment"],
    metadata: {
      assignment: {
        skill_path: skillPath,
        status: "active",
        description,
        completion_delivery: completionDelivery.value,
      },
    },
  };

  const job = normalizeJob(jobInput, scope);
  setNextIfMissing(job);
  const validation = validateJob(job, { scope });
  if (!validation.valid) {
    fail(
      cmd,
      "validation_failed",
      `invalid schedule: ${validation.errors.join(", ")}`,
      { errors: validation.errors },
      pretty,
    );
    process.exit(2);
  }

  // ── Activate before writing anything, so a runtime that cannot dispatch
  //    never yields an assignment the caller could believe is enabled. ──────
  const activation = flags.activate
    ? await activateOrFail(cmd, scope, pretty)
    : null;

  // ── Acquire catalog.lock; re-verify constraints; materialize; persist ────
  // Ordering nuance:
  //   1. Validate everything possible before taking the lock (above).
  //   2. Inside the lock, re-check name (TOCTOU fix) and slug (new).
  //   3. Then materialize the skill dir (so a failing check leaves nothing).
  //   4. Push the job in-place; mutateJobs calls saveJobs automatically.
  //   5. If materialization or saveJobs throws, rollback the freshly created
  //      dir before surfacing the error. createdHome is only set after a
  //      successful dir write so a failing name/slug check never triggers
  //      rollback of a pre-existing dir with the same slug.
  let createdHome = null;
  const owner = scopeOwner("create");
  let createResult;
  try {
    createResult = await mutateJobs(scope, owner, async (jobs) => {
      // Re-check name collision on the locked snapshot (TOCTOU fix).
      if (jobs.some((j) => isAssignment(j) && j.name === name)) {
        throw Object.assign(
          new Error(`assignment name already exists: ${name}`),
          { code: "duplicate_name", exitCode: 1 },
        );
      }
      // Reject slug collisions from names that differ but share a slug
      // (e.g. "Daily Check" and "Daily!Check" both slugify to "daily-check").
      const slugConflict = jobs.find(
        (j) => isAssignment(j) && slugifyForAssignment(j.name) === slug,
      );
      if (slugConflict) {
        throw Object.assign(
          new Error(
            `assignment slug "${slug}" already in use (collides with "${slugConflict.name}")`,
          ),
          { code: "duplicate_slug", exitCode: 1 },
        );
      }
      // Materialize backing skill dir. createdHome is set only after success so
      // a pre-existing dir with the same slug is never accidentally deleted.
      if (skillSrc) {
        const st = statSync(skillSrc);
        if (st.isDirectory()) {
          copyDirRecursive(skillSrc, home);
        } else {
          mkdirSync(home, { recursive: true });
          copyFileSync(skillSrc, skillPath);
        }
      } else {
        scaffoldSkillMd(skillPath, home, { name, slug, description, id });
      }
      createdHome = home;
      // Push job in-place; mutateJobs calls saveJobs after this callback.
      jobs.push(job);
    });
  } catch (err) {
    // Rollback: only if WE successfully created the dir in this invocation.
    if (createdHome !== null && existsSync(createdHome)) {
      try {
        rmSync(createdHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    fail(cmd, err.code || "create_failed", err.message, {}, pretty);
    process.exit(err.exitCode ?? 1);
  }

  if (!createResult.ok) {
    // Lease contention — callback never ran, so no dir was created.
    fail(cmd, "scope_busy", "scope is busy, try again", {}, pretty);
    process.exit(1);
  }

  // Register the scope so a stored assignment is never stranded in a scope the
  // daemon never visits. --activate already registered it via activation.
  const warnings = [];
  if (!activation) {
    try {
      registerScopeForDispatch(scope);
    } catch (err) {
      warnings.push(
        `scope_register_failed: ${String(err.message || err)} — run '${TASKS_COMMAND} up --cwd ${scope.cwd}' to register manually`,
      );
    }
  }

  // `errors` is reserved for the failure envelope ({code,message}, non-empty
  // only when ok:false). Non-fatal warnings ride in `data`, matching
  // helm-tasks' add/update envelope.
  output(
    cmd,
    true,
    {
      id,
      name,
      slug,
      skill_path: skillPath,
      schedule: job.schedule,
      next_run_at: job.state.next_run_at,
      runtime_options: publishedRuntimeOptions(job),
      storage_root: scope.storage_root,
      warnings,
      ...(activation ? { activation } : {}),
    },
    [],
    pretty,
  );
}

// ─── Verb: list ───────────────────────────────────────────────────────────────
// --all-scopes answers for every registered scope in one call; without it the
// read stays scope-local, resolved from --cwd like every other verb.
// --with-terminal-runs additionally opens each assignment's run history, so it
// is opt-in and only meaningful on the global read.
function handleList(flags, pretty) {
  const cmd = "list";
  const status = flags.status || "";
  const withTerminalRuns = Boolean(flags["with-terminal-runs"]);
  if (flags["all-scopes"]) {
    handleGlobalList(cmd, { status, withTerminalRuns }, pretty);
    return;
  }
  if (withTerminalRuns) {
    fail(
      cmd,
      "invalid_flag",
      "--with-terminal-runs requires --all-scopes",
      {},
      pretty,
    );
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });

  // Tag filter first: only assignment-tagged jobs.
  // Do NOT copy the lifecycle_status filter from helm-tasks:4537-4539.
  const jobs = filterAssignmentsByStatus(
    loadJobsReadOnly(scope).filter(isAssignment),
    status,
  );
  output(cmd, true, { assignments: jobs.map(localAssignmentRow) }, [], pretty);
}

// A scope whose catalog — or, with --with-terminal-runs, whose run history —
// cannot be read fails the whole call, naming that scope, rather than
// publishing the scopes that happened to parse as a complete list.
function handleGlobalList(cmd, { status, withTerminalRuns }, pretty) {
  const result = listAssignmentsAcrossScopes({ status, withTerminalRuns });
  if (!result.ok) {
    output(
      cmd,
      false,
      {
        failed_scopes: result.failures,
        scanned_scopes: result.scanned_scopes,
      },
      result.failures.map((entry) => ({
        code: entry.code,
        message: entry.detail,
      })),
      pretty,
    );
    process.exit(1);
  }
  output(
    cmd,
    true,
    {
      assignments: result.assignments,
      scopes: result.scopes,
      scanned_scopes: result.scanned_scopes,
    },
    [],
    pretty,
  );
}

// ─── Verb: show ───────────────────────────────────────────────────────────────
function handleShow(flags, positionals, pretty) {
  const cmd = "show";
  const q = positionals[1];
  if (!q) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });
  const jobs = loadJobsReadOnly(scope).filter(isAssignment);
  const job = identityFailOrJob(cmd, jobs, q, pretty);

  const events = historyForJob(scope, job.id, 100);
  const runCount = events.filter((e) => e.kind === "completed").length;

  output(
    cmd,
    true,
    {
      assignment: {
        id: job.id,
        name: job.name,
        description: assignmentDescription(job),
        status: job.metadata?.assignment?.status || "active",
        completion_delivery: effectiveCompletionDelivery(
          job.metadata?.assignment,
        ),
        skill_path: job.metadata?.assignment?.skill_path || null,
        provider: assignmentProvider(job),
        provider_config: assignmentProviderConfig(job),
        runtime_options: publishedRuntimeOptions(job),
        schedule: renderSchedule(job.schedule),
        schedule_raw: job.schedule,
        next_run_at: job.state?.next_run_at || null,
        last_run_at: assignmentLastRunAt(job),
        last_status: job.state?.last_status || null,
        run_count: runCount,
      },
    },
    [],
    pretty,
  );
}

// ─── Verb: path ───────────────────────────────────────────────────────────────
function handlePath(flags, positionals, pretty) {
  const cmd = "path";
  const q = positionals[1];
  if (!q) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });
  const jobs = loadJobsReadOnly(scope).filter(isAssignment);
  const job = identityFailOrJob(cmd, jobs, q, pretty);
  const skillPath = job.metadata?.assignment?.skill_path || null;
  output(cmd, true, { skill_path: skillPath }, [], pretty);
}

// ─── Verb: skill ──────────────────────────────────────────────────────────────
// Publishes the backing instruction body through Helm so consumers never need
// filesystem access to an assignment home.
function handleSkill(flags, positionals, pretty) {
  const cmd = "skill";
  const q = positionals[1];
  if (!q) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });
  const jobs = loadJobsReadOnly(scope).filter(isAssignment);
  const job = identityFailOrJob(cmd, jobs, q, pretty);
  const skillPath = job.metadata?.assignment?.skill_path;

  if (typeof skillPath !== "string" || skillPath.length === 0) {
    fail(
      cmd,
      "skill_path_missing",
      "assignment has no backing skill path",
      {},
      pretty,
    );
    process.exit(1);
  }

  let stats;
  try {
    stats = statSync(skillPath);
  } catch (err) {
    const code =
      err?.code === "ENOENT" ? "skill_not_found" : "skill_unreadable";
    const message =
      code === "skill_not_found"
        ? "backing skill was not found"
        : "backing skill cannot be accessed";
    fail(cmd, code, message, {}, pretty);
    process.exit(1);
  }
  if (!stats.isFile()) {
    fail(cmd, "skill_not_file", "backing skill is not a file", {}, pretty);
    process.exit(1);
  }

  let content;
  try {
    content = readFileSync(skillPath, "utf8");
  } catch {
    fail(cmd, "skill_unreadable", "cannot read backing skill", {}, pretty);
    process.exit(1);
  }
  output(
    cmd,
    true,
    {
      assignment_id: job.id,
      content,
      content_encoding: "utf-8",
      byte_length: Buffer.byteLength(content, "utf8"),
    },
    [],
    pretty,
  );
}

// ─── Verb: runs ───────────────────────────────────────────────────────────────
// ─── Verb: completion ─────────────────────────────────────────────────────────
// Takes a positional <run-id> and publishes that run's completion record.
function handleCompletion(flags, positionals, pretty) {
  const cmd = "completion";
  const runId = positionals[1];
  if (!runId) {
    fail(cmd, "missing_arg", "<run-id> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });
  const jobs = loadJobsReadOnly(scope).filter(isAssignment);
  const completion = findRunCompletion({ scope, jobs, runId });
  if (!completion) {
    fail(cmd, "not_found", `no run found for run-id "${runId}"`, {}, pretty);
    process.exit(1);
  }
  output(cmd, true, { completion }, [], pretty);
}

// ─── Verb: logs ───────────────────────────────────────────────────────────────
// Takes a positional <run-id> and finds the matching assignment job history.
function handleLogs(flags, positionals, pretty) {
  const cmd = "logs";
  const runId = positionals[1];
  if (!runId) {
    fail(cmd, "missing_arg", "<run-id> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });

  // Search all assignment jobs for a matching run-id.
  const allJobs = loadJobsReadOnly(scope).filter(isAssignment);
  let foundJobId = null;
  let logPaths = null;

  for (const job of allJobs) {
    const descriptor = resolveRunForLogs({ scope, jobId: job.id, runId });
    // resolveRunForLogs returns a descriptor even for unknown run ids (with
    // computed paths). Verify the paths actually exist on disk.
    if (descriptor) {
      const stdoutExists =
        descriptor.log_paths?.stdout && existsSync(descriptor.log_paths.stdout);
      const stderrExists =
        descriptor.log_paths?.stderr && existsSync(descriptor.log_paths.stderr);
      if (stdoutExists || stderrExists || descriptor.active) {
        foundJobId = job.id;
        logPaths = descriptor.log_paths || runLogPaths(scope, job.id, runId);
        break;
      }
    }
  }

  if (!foundJobId) {
    fail(cmd, "not_found", `no run found for run-id "${runId}"`, {}, pretty);
    process.exit(1);
  }

  // Output the log paths in the envelope; also stream stdout content if present.
  output(
    cmd,
    true,
    { run_id: runId, job_id: foundJobId, log_paths: logPaths },
    [],
    pretty,
  );

  // Stream stdout log to stdout after the envelope (best-effort)
  if (logPaths?.stdout && existsSync(logPaths.stdout)) {
    try {
      process.stdout.write(readFileSync(logPaths.stdout, "utf8"));
    } catch {
      /* ignore */
    }
  }
}

// ─── Verb: update ─────────────────────────────────────────────────────────────
async function handleUpdate(flags, positionals, pretty) {
  const cmd = "update";
  const q = positionals[1];
  if (!q) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });

  // ── Pre-lock: identity resolution (gives fast not-found errors) ──────────
  const readJobs = loadJobsReadOnly(scope);
  const preAssignments = readJobs.filter(isAssignment);
  const preJob = identityFailOrJob(cmd, preAssignments, q, pretty);
  const updateInput = resolveAssignmentUpdateInput(flags);
  if (updateInput.error) {
    fail(cmd, updateInput.error.code, updateInput.error.message, {}, pretty);
    process.exit(updateInput.error.exitCode);
  }
  const { providerPatch, skill } = updateInput;
  const completionDelivery = completionDeliveryInput(
    flags["completion-delivery"],
  );
  if (completionDelivery.error) {
    fail(
      cmd,
      "completion_delivery_invalid",
      `--completion-delivery must be one of: ${COMPLETION_DELIVERY_MODES.join("|")}`,
      {},
      pretty,
    );
    process.exit(2);
  }
  // ── Reject --schedule (undocumented; was silently nooped before this check) ──
  if (flags.schedule !== undefined) {
    fail(
      cmd,
      "unknown_flag",
      "--schedule is not a valid flag; use: --in <dur>, --at <iso>, --cron '<expr>', or --every <dur>",
      {},
      pretty,
    );
    process.exit(2);
  }

  // ── Runtime options: validated against the provider already on the record,
  //    and against the provider configuration this call is about to write —
  //    a run-time option is only accepted by the runtime that will run it. ──
  const preConfig = preJob.execution_hints?.provider_config || null;
  const configPatch = academyProviderConfigFromFlags(flags);
  const runtime = runtimeOptionsOrFail(
    cmd,
    {
      flags,
      provider:
        providerPatch === undefined
          ? preJob.execution_hints?.provider || null
          : providerPatch,
      providerConfig: configPatch
        ? mergeProviderConfig(preConfig, configPatch)
        : preConfig,
      existing: storedRuntimeOptions(preConfig),
    },
    pretty,
  );
  const hasRuntime = runtime.changed;
  // ── Reject calls with no recognized mutation flag (was a silent noop) ────────
  {
    const _hasSched = Boolean(
      flags.in || flags.at || flags["once-at"] || flags.cron || flags.every,
    );
    const _hasName = typeof flags.name === "string" && flags.name.trim() !== "";
    const _hasDesc = typeof flags.description === "string";
    const _hasToggle = Boolean(flags.enable || flags.disable);
    const _hasProvider = providerPatch !== undefined;
    const _hasSkill = skill !== null;
    const _hasCompletionDelivery = completionDelivery.value !== null;
    if (
      !_hasSched &&
      !_hasName &&
      !_hasDesc &&
      !_hasToggle &&
      !_hasProvider &&
      !_hasSkill &&
      !_hasCompletionDelivery &&
      !hasRuntime &&
      !configPatch
    ) {
      fail(
        cmd,
        "no_update_flags",
        "no update flags provided; valid flags: --in <dur>, --at <iso>, --cron '<expr>', --every <dur>, --name, --description, --enable, --disable, --provider, --skill, --model, --reasoning-effort, --permission-mode, --academy-agent, --academy-runtime",
        {},
        pretty,
      );
      process.exit(2);
    }
  }

  // ── Pre-lock: schedule validation (pure; no side effects) ────────────────
  const hasScheduleFlag =
    flags.in || flags.at || flags["once-at"] || flags.cron || flags.every;
  let newSchedule = null;
  if (hasScheduleFlag) {
    try {
      newSchedule = buildScheduleFromFlags(flags);
    } catch (err) {
      fail(
        cmd,
        "invalid_schedule",
        `invalid schedule: ${err.message}`,
        {},
        pretty,
      );
      process.exit(2);
    }
    if (!newSchedule) {
      fail(
        cmd,
        "invalid_schedule",
        "invalid schedule: could not parse schedule flags",
        {},
        pretty,
      );
      process.exit(2);
    }
    // Validate the schedule against the pre-lock job to fail fast on bad input.
    const testJob = JSON.parse(JSON.stringify(preJob));
    testJob.schedule = newSchedule;
    testJob.state = testJob.state || {};
    testJob.state.next_run_at = null;
    const normalizedTest = normalizeJob(testJob, scope);
    setNextIfMissing(normalizedTest);
    const schedValidation = validateJob(normalizedTest, { scope });
    if (!schedValidation.valid) {
      fail(
        cmd,
        "invalid_schedule",
        `invalid schedule: ${schedValidation.errors.join(", ")}`,
        { errors: schedValidation.errors },
        pretty,
      );
      process.exit(2);
    }
  }

  const isRename = typeof flags.name === "string" && flags.name.trim() !== "";
  const newName = isRename ? flags.name.trim() : null;

  // renameRollbackDir is set inside the callback once the new dir is created.
  // It is cleared if the callback itself rolls back the dir (HELM_ASSIGNMENTS_FAIL_SAVE).
  let renameRollbackDir = null;
  let skillSnapshot = null;

  const owner = scopeOwner("update");
  let updateResult;
  try {
    updateResult = await mutateJobs(
      scope,
      owner,
      async (jobs) => {
        const idx = jobs.findIndex((j) => j.id === preJob.id);
        if (idx < 0) {
          // Guard: job disappeared between pre-lock read and lock acquisition.
          throw Object.assign(
            new Error(
              `no assignment matching "${q}" (try: ${ASSIGNMENTS_COMMAND} list)`,
            ),
            { code: "not_found", exitCode: 1 },
          );
        }
        const job = jobs[idx];
        const mutated = JSON.parse(JSON.stringify(job)); // deep clone
        const renameSource = isRename
          ? resolveAssignmentSkillSource({ scope, job })
          : null;

        // ── Apply schedule ──────────────────────────────────────────────────
        if (newSchedule) {
          mutated.schedule = newSchedule;
          mutated.state = mutated.state || {};
          mutated.state.next_run_at = null;
          const normalized = normalizeJob(mutated, scope);
          setNextIfMissing(normalized);
          Object.assign(mutated, normalized);
        }

        // ── Apply runtime options ───────────────────────────────────────────
        if (hasRuntime) {
          mutated.execution_hints = applyRuntimeOptions(
            mutated.execution_hints || {},
            runtime.options,
            runtime.patch,
          );
        }

        applyProviderPatch(mutated, providerPatch);
        // ── Apply provider configuration ────────────────────────────────────
        // Validated as a whole record before it is written: a configuration this
        // build would refuse to launch must not be storable through update.
        if (configPatch || providerPatch !== undefined) {
          if (configPatch) applyProviderConfig(mutated, configPatch);
          const invalid = validateJob(normalizeJob(mutated, scope), {
            scope,
          }).errors.filter((code) =>
            String(code).startsWith("execution_hints_"),
          );
          if (invalid.length > 0) {
            throw Object.assign(
              new Error(
                `invalid provider configuration: ${invalid.join(", ")}`,
              ),
              { code: invalid[0], exitCode: 2 },
            );
          }
        }

        // ── Apply description (primary storage: metadata.assignment.description) ──
        if (typeof flags.description === "string") {
          if (!mutated.metadata) mutated.metadata = {};
          if (!mutated.metadata.assignment) mutated.metadata.assignment = {};
          mutated.metadata.assignment.description = flags.description;
        }
        if (completionDelivery.value !== null) {
          if (!mutated.metadata) mutated.metadata = {};
          if (!mutated.metadata.assignment) mutated.metadata.assignment = {};
          mutated.metadata.assignment.completion_delivery =
            completionDelivery.value;
        }

        // Read and replace the backing skill only after catalog.lock is held.
        // A failed jobs.json save restores this exact snapshot before releasing
        // that lock, so a stale rollback cannot overwrite a later update.
        skillSnapshot = writeSkillUpdate(
          skill,
          mutated.metadata?.assignment?.skill_path,
        );
        // ── Apply enable / disable ──────────────────────────────────────────
        if (flags.enable) {
          mutated.state = mutated.state || {};
          mutated.state.enabled = true;
          if (!mutated.metadata) mutated.metadata = {};
          if (!mutated.metadata.assignment) mutated.metadata.assignment = {};
          mutated.metadata.assignment.status = "active";
          // Re-arm when enabling from an archived state (archive nulls next_run_at)
          if (mutated.state.next_run_at === null) {
            setNextIfMissing(mutated);
          }
        }
        if (flags.disable) {
          mutated.state = mutated.state || {};
          mutated.state.enabled = false;
          if (!mutated.metadata) mutated.metadata = {};
          if (!mutated.metadata.assignment) mutated.metadata.assignment = {};
          mutated.metadata.assignment.status = "disabled";
        }

        // ── Rename path (plan §9 Phase 2) ───────────────────────────────────
        if (isRename) {
          // Name collision check inside the lock (spans all assignments including
          // archived, consistent with create).
          if (jobs.some((a) => a.name === newName && a.id !== job.id)) {
            throw Object.assign(
              new Error(`assignment name already exists: ${newName}`),
              { code: "duplicate_name", exitCode: 1 },
            );
          }
          // Slug collision check — "Daily Check" and "Daily!Check"
          // both slugify to "daily-check"; reject independently of name.
          const newSlug = slugifyForAssignment(newName);
          const slugConflict = jobs.find(
            (j) =>
              isAssignment(j) &&
              j.id !== job.id &&
              slugifyForAssignment(j.name) === newSlug,
          );
          if (slugConflict) {
            throw Object.assign(
              new Error(
                `assignment slug "${newSlug}" already in use (collides with "${slugConflict.name}")`,
              ),
              { code: "duplicate_slug", exitCode: 1 },
            );
          }

          const oldDir = renameSource.home;
          const newDir = assignmentHome(scope.cwd, newSlug);
          const newSkillPath = join(newDir, "SKILL.md");

          // Copy dir (non-atomic; we track newDir for rollback if needed).
          copyDirRecursive(oldDir, newDir);
          renameRollbackDir = oldDir === newDir ? null : newDir;

          // Update record fields
          mutated.name = newName;
          if (!mutated.metadata) mutated.metadata = {};
          if (!mutated.metadata.assignment) mutated.metadata.assignment = {};
          mutated.metadata.assignment.skill_path = newSkillPath;
          mutated.prompt = {
            type: "inline",
            value: `Run the skill at ${newSkillPath} and follow it.`,
          };

          // Mutate in-place; mutateJobs calls saveJobs after this callback.
          jobs[idx] = mutated;

          return {
            type: "rename",
            mutated,
            newSlug,
            newSkillPath,
            oldDir,
            newDir,
          };
        }

        // ── Non-rename: update in-place ─────────────────────────────────────
        jobs[idx] = mutated;
        return { type: "update", mutated };
      },
      {
        beforeSave: () => {
          if (process.env.HELM_ASSIGNMENTS_FAIL_SAVE === "1") {
            throw new Error(
              "injected save failure (HELM_ASSIGNMENTS_FAIL_SAVE)",
            );
          }
        },
        onSaveFailure: () => restoreSkillUpdate(skillSnapshot),
      },
    );
  } catch (err) {
    // Rollback the rename dir if it was copied and something failed after.
    if (renameRollbackDir !== null && existsSync(renameRollbackDir)) {
      try {
        rmSync(renameRollbackDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    fail(cmd, err.code || "update_failed", err.message, {}, pretty);
    process.exit(err.exitCode ?? 1);
  }

  if (!updateResult.ok) {
    // Lease contention — callback never ran, nothing was mutated.
    if (renameRollbackDir !== null && existsSync(renameRollbackDir)) {
      try {
        rmSync(renameRollbackDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    fail(cmd, "scope_busy", "scope is busy, try again", {}, pretty);
    process.exit(1);
  }

  const { type, mutated, newSlug, newSkillPath, oldDir, newDir } =
    updateResult.value;

  if (type === "rename") {
    // Remove old dir after the record write succeeded.
    try {
      if (existsSync(oldDir) && oldDir !== newDir) {
        rmSync(oldDir, { recursive: true, force: true });
      }
    } catch {
      /* best-effort; record is already updated */
    }

    output(
      cmd,
      true,
      {
        id: mutated.id,
        name: mutated.name,
        slug: newSlug,
        skill_path: newSkillPath,
        next_run_at: mutated.state?.next_run_at || null,
      },
      [],
      pretty,
    );
  } else {
    output(
      cmd,
      true,
      {
        id: mutated.id,
        name: mutated.name,
        status: mutated.metadata?.assignment?.status || "active",
        next_run_at: mutated.state?.next_run_at || null,
        provider: assignmentProvider(mutated),
        provider_config: assignmentProviderConfig(mutated),
        runtime_options: publishedRuntimeOptions(mutated),
        description: assignmentDescription(mutated),
        completion_delivery: effectiveCompletionDelivery(
          mutated.metadata?.assignment,
        ),
      },
      [],
      pretty,
    );
  }
}

// ─── Verb: retarget ───────────────────────────────────────────────────────────
// Moves the assignment (record, backing skill, run history, logs, reports) to
// another scope, preserving its id. Every failure leaves the original usable;
// src/lib/assignment_retarget.mjs owns the ordering that guarantees it.
async function handleRetarget(flags, positionals, pretty) {
  const cmd = "retarget";
  const q = positionals[1];
  if (!q) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });
  const jobs = loadJobsReadOnly(scope).filter(isAssignment);
  const job = identityFailOrJob(cmd, jobs, q, pretty);

  let result;
  try {
    const destScope = resolveDestinationScope(scope, flags["to-cwd"]);
    result = await retargetAssignment({
      sourceScope: scope,
      destScope,
      jobId: job.id,
      owner: scopeOwner("retarget"),
    });
  } catch (err) {
    fail(
      cmd,
      err.code || "retarget_failed",
      String(err.message || err),
      err.details || {},
      pretty,
    );
    process.exit(err.exitCode ?? 1);
  }

  // Register the destination so a moved assignment is never stranded in a
  // scope the daemon never visits (same guarantee create gives).
  const warnings = [...result.warnings];
  try {
    registerScopeForDispatch(resolveScope({ cwd: result.to.cwd }));
  } catch (err) {
    warnings.push(
      `scope_register_failed: ${String(err.message || err)} — run '${TASKS_COMMAND} up --cwd ${result.to.cwd}' to register manually`,
    );
  }
  // Same envelope contract as create: a completed move with a degraded repair
  // step stays ok:true with an empty `errors`, and says what degraded in
  // `data.warnings`. Putting warnings in `errors` reads as a failed move.
  output(cmd, true, { ...result, warnings }, [], pretty);
}

// ─── Verb: archive ────────────────────────────────────────────────────────────
async function handleArchive(flags, positionals, pretty) {
  const cmd = "archive";
  const q = positionals[1];
  if (!q) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });

  // Pre-lock: identity resolution (gives fast not-found errors).
  const readJobs = loadJobsReadOnly(scope);
  const preAssignments = readJobs.filter(isAssignment);
  const preJob = identityFailOrJob(cmd, preAssignments, q, pretty);

  const owner = scopeOwner("archive");
  const result = await mutateJobs(scope, owner, (jobs) => {
    const idx = jobs.findIndex((j) => j.id === preJob.id);
    if (idx < 0) return; // guard: job disappeared between reads
    const mutated = JSON.parse(JSON.stringify(jobs[idx]));
    mutated.state = mutated.state || {};
    mutated.state.enabled = false;
    mutated.state.next_run_at = null;
    if (!mutated.metadata) mutated.metadata = {};
    if (!mutated.metadata.assignment) mutated.metadata.assignment = {};
    mutated.metadata.assignment.status = "archived";
    jobs[idx] = mutated;
  });

  if (!result.ok) {
    fail(cmd, "scope_busy", "scope is busy, try again", {}, pretty);
    process.exit(1);
  }

  output(cmd, true, { id: preJob.id, status: "archived" }, [], pretty);
}

// ─── Verb: unarchive ──────────────────────────────────────────────────────────
async function handleUnarchive(flags, positionals, pretty) {
  const cmd = "unarchive";
  const q = positionals[1];
  if (!q) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });

  // Pre-lock: identity resolution (gives fast not-found errors).
  const readJobs = loadJobsReadOnly(scope);
  const preAssignments = readJobs.filter(isAssignment);
  const preJob = identityFailOrJob(cmd, preAssignments, q, pretty);

  const owner = scopeOwner("unarchive");
  let unarchivedState = null;
  const result = await mutateJobs(scope, owner, (jobs) => {
    const idx = jobs.findIndex((j) => j.id === preJob.id);
    if (idx < 0) return; // guard: job disappeared between reads
    const mutated = JSON.parse(JSON.stringify(jobs[idx]));
    mutated.state = mutated.state || {};
    mutated.state.enabled = true;
    if (!mutated.metadata) mutated.metadata = {};
    if (!mutated.metadata.assignment) mutated.metadata.assignment = {};
    mutated.metadata.assignment.status = "active";
    // Recompute next_run_at from schedule (same logic as setNextIfMissing)
    mutated.state.next_run_at = null;
    setNextIfMissing(mutated);
    jobs[idx] = mutated;
    unarchivedState = mutated.state;
  });

  if (!result.ok) {
    fail(cmd, "scope_busy", "scope is busy, try again", {}, pretty);
    process.exit(1);
  }

  output(
    cmd,
    true,
    {
      id: preJob.id,
      status: "active",
      next_run_at: unarchivedState?.next_run_at ?? null,
    },
    [],
    pretty,
  );
}

// ─── Verb: run (immediate / direct invocation) ───────────────────────────────
async function handleRun(flags, positionals, pretty) {
  const cmd = "run";
  const q = positionals[1];
  if (!q) {
    fail(cmd, "missing_arg", "<id|name> is required", {}, pretty);
    process.exit(2);
  }
  const cwd = typeof flags.cwd === "string" ? flags.cwd : process.cwd();
  const scope = resolveScope({ cwd });
  const jobs = loadJobsReadOnly(scope);
  const assignments = jobs.filter(isAssignment);
  const job = identityFailOrJob(cmd, assignments, q, pretty);

  let result;
  try {
    result = await runJobNow(scope, job.id, {
      schedulerScriptPath: process.argv[1],
    });
  } catch (err) {
    fail(cmd, err.code || "run_failed", String(err.message || err), {}, pretty);
    process.exit(err.exitCode || 1);
  }

  if (!result.ok) {
    fail(cmd, "scope_busy", "scope dispatch already in progress", {}, pretty);
    process.exit(1);
  }

  const event = result.value || {};
  output(
    cmd,
    true,
    {
      run_id: event.run_id || null,
      mode: "direct",
      status: event.status || null,
    },
    [],
    pretty,
  );
}

// ─── Entry ────────────────────────────────────────────────────────────────────
async function run() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0] || "";
  const pretty = Boolean(flags.pretty);

  if (!cmd || flags.help) {
    process.stdout.write(
      `${ASSIGNMENTS_COMMAND} — manage Helm skill-backed assignments\n\n` +
        `Usage: ${ASSIGNMENTS_COMMAND} <verb> [options]\n\n` +
        "Verbs:\n" +
        "  create     Register a new skill-backed assignment (--completion-delivery activity|notify|conversation is required;\n" +
        "             --activate ensures the service; --permission-mode is required)\n" +
        "  list       List assignments (--status active|disabled|archived|all;\n" +
        "             --all-scopes lists across every registered scope;\n" +
        "             --all-scopes --with-terminal-runs adds each row's finished runs\n" +
        "             with immutable source_scope_id and source_cwd)\n" +
        "  show       Show full detail for one assignment\n" +
        "  path       Print the backing-skill path\n" +
        "  skill      Read the backing-skill UTF-8 content as JSON\n" +
        "  update     Change schedule/metadata/runtime options (--in/--at/--cron/--every/--name/\n" +
        "             --description/--completion-delivery/--enable/--disable/--provider/--skill/--model/--reasoning-effort/--permission-mode)\n" +
        "  retarget   Move an assignment to another working directory (--to-cwd <path>),\n" +
        "             keeping its id and run history\n" +
        "  archive    Stop schedule; retain skill + history\n" +
        "  unarchive  Re-arm a previously archived assignment\n" +
        "  run        Trigger an immediate direct run\n" +
        "  runs       List run history for an assignment\n" +
        "  completion Show the completion record for a specific run-id\n" +
        "  runtime-options  Accepted runtime options per provider\n" +
        "  logs       Output logs for a specific run-id\n\n" +
        `Run ${ASSIGNMENTS_COMMAND} <verb> --help for verb-specific options.\n`,
    );
    return;
  }

  if (cmd === "create") {
    await handleCreate(flags, pretty);
    return;
  }
  if (cmd === "list") {
    handleList(flags, pretty);
    return;
  }
  if (cmd === "show") {
    handleShow(flags, positionals, pretty);
    return;
  }
  if (cmd === "path") {
    handlePath(flags, positionals, pretty);
    return;
  }
  if (cmd === "skill") {
    handleSkill(flags, positionals, pretty);
    return;
  }
  if (cmd === "runs") {
    handleAssignmentRuns(flags, positionals, pretty, identityFailOrJob);
    return;
  }
  if (cmd === "completion") {
    handleCompletion(flags, positionals, pretty);
    return;
  }
  if (cmd === "runtime-options") {
    output(cmd, true, runtimeOptionCapabilities(), [], pretty);
    return;
  }
  if (cmd === "logs") {
    handleLogs(flags, positionals, pretty);
    return;
  }
  if (cmd === "update") {
    await handleUpdate(flags, positionals, pretty);
    return;
  }
  if (cmd === "retarget") {
    await handleRetarget(flags, positionals, pretty);
    return;
  }
  if (cmd === "archive") {
    await handleArchive(flags, positionals, pretty);
    return;
  }
  if (cmd === "unarchive") {
    await handleUnarchive(flags, positionals, pretty);
    return;
  }
  if (cmd === "run") {
    await handleRun(flags, positionals, pretty);
    return;
  }

  fail(cmd, "unknown_command", `unknown command: ${cmd}`, {}, pretty);
  process.exit(2);
}

run().catch((err) => {
  fail(
    err.code === "run_source_conflict" ? process.argv[2] : "runtime",
    err.code === "run_source_conflict" ? err.code : "runtime_error",
    String(err?.message || err),
    { stack: err?.stack || "" },
    false,
  );
  process.exit(1);
});
