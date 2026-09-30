import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseCron,
  parseEvery,
  computeInitialNextRun,
} from "./schedule_eval.mjs";
import { decorateJob } from "./read_model.mjs";
import { mutateJobs } from "./scope_runtime.mjs";
import { appendActivityEvent } from "./activity_stream.mjs";
import { bypassesNetworkPrecondition } from "./network_precondition_policy.mjs";
import { isSafeJobId } from "./job_id.mjs";
import { normalizeJobRuntimeFields } from "./job_runtime_fields.mjs";

function resolveSource(opts) {
  return opts?.source || "cli";
}

const VALID_NOTIFY_ON = new Set(["success", "failure", "both", "none"]);
const VALID_CHANNELS = new Set(["stdout", "file", "webhook"]);
const VALID_SCHEDULE_TYPES = new Set(["once", "recurring", "interval"]);
const VALID_BACKOFF_TYPES = new Set(["none", "linear", "exponential"]);
const VALID_MEMORY_MODES = new Set(["read+write", "off"]);
const VALID_PROVIDERS = new Set([
  "academy",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "droid",
  "hermes",
]);
const VALID_ACADEMY_RUNTIMES = new Set(["claude", "codex"]);
function nowDate() {
  return process.env.HELM_NOW ? new Date(process.env.HELM_NOW) : new Date();
}

function nowIso() {
  return nowDate().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMemory(input) {
  const mode =
    typeof input?.memory?.mode === "string"
      ? input.memory.mode.trim().toLowerCase()
      : "read+write";
  return { mode };
}

const CODEX_SUBCOMMANDS = new Set([
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "sandbox",
  "debug",
  "apply",
  "a",
  "resume",
  "fork",
  "cloud",
  "exec-server",
  "features",
  "help",
]);

export function normalizeCodexProcessArgs(command, args) {
  if (typeof command !== "string") return args;
  const base = command.split("/").pop();
  if (base !== "codex") return args;
  const first = args?.[0];
  if (typeof first === "string" && CODEX_SUBCOMMANDS.has(first)) return args;
  return ["exec", ...(Array.isArray(args) ? args : [])];
}

function isJsonValue(value) {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function normalizeProviderConfig(provider, config) {
  if (!isPlainObject(config)) return undefined;
  if (provider !== "academy") return config;
  return {
    ...config,
    academy_runtime: config.academy_runtime ?? "claude",
  };
}

export function normalizeJob(input, scope) {
  const now = nowIso();
  const schedule = input.schedule || {};
  const hints = isPlainObject(input.execution_hints)
    ? input.execution_hints
    : {};
  const legacyExecution = isPlainObject(input.execution) ? input.execution : {};
  const limits = isPlainObject(input.limits) ? input.limits : {};
  const processSpec = isPlainObject(input.process) ? input.process : null;
  const promptSpec = isPlainObject(input.prompt) ? input.prompt : null;
  const normalizedModel = hints.model ?? legacyExecution.model ?? null;
  const normalizedMaxTurns = hints.max_turns ?? legacyExecution.max_turns ?? 50;
  const normalizedTimeout =
    limits.timeout_sec ?? legacyExecution.timeout_sec ?? null;
  const normalizedQuietTimeout = limits.quiet_timeout_sec ?? null;
  const normalizedHardTimeout = limits.hard_timeout_sec ?? null;
  const networkPrecondition = bypassesNetworkPrecondition(input)
    ? false
    : (schedule.preconditions?.network ?? true);
  return {
    id: input.id,
    name: input.name || input.id,
    process: processSpec
      ? {
          command: processSpec.command,
          args: normalizeCodexProcessArgs(
            processSpec.command,
            Array.isArray(processSpec.args)
              ? processSpec.args.map((value) => String(value))
              : [],
          ),
          stdin: processSpec.stdin ?? null,
          stdin_file: processSpec.stdin_file ?? null,
          cwd: processSpec.cwd
            ? resolve(scope.cwd, processSpec.cwd)
            : scope.cwd,
          env: isPlainObject(processSpec.env) ? processSpec.env : {},
        }
      : null,
    prompt: promptSpec
      ? {
          type: promptSpec.type,
          value: promptSpec.value,
          path: promptSpec.path,
          relative_to: promptSpec.relative_to || "cwd",
        }
      : null,
    schedule: {
      type: schedule.type,
      timezone:
        schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      start_at: schedule.start_at || null,
      cron: schedule.cron || null,
      every: schedule.every || null,
      end_at: schedule.end_at || null,
      max_catchup_runs: Number.isInteger(schedule.max_catchup_runs)
        ? schedule.max_catchup_runs
        : null,
      max_catchup: Number.isInteger(schedule.max_catchup)
        ? schedule.max_catchup
        : null,
      max_catchup_cost: Number.isFinite(schedule.max_catchup_cost)
        ? schedule.max_catchup_cost
        : null,
      estimated_catchup_cost: Number.isFinite(schedule.estimated_catchup_cost)
        ? schedule.estimated_catchup_cost
        : null,
      missed_run_policy: schedule.missed_run_policy || null,
      misfire_grace_sec: Number.isInteger(schedule.misfire_grace_sec)
        ? schedule.misfire_grace_sec
        : null,
      run_once_deadline_at: schedule.run_once_deadline_at || null,
      overlap_policy: schedule.overlap_policy || null,
      priority: schedule.priority || null,
      stagger_sec: Number.isInteger(schedule.stagger_sec)
        ? schedule.stagger_sec
        : null,
      jitter_sec: Number.isFinite(schedule.jitter_sec)
        ? schedule.jitter_sec
        : 0,
      preconditions: {
        network: networkPrecondition,
        network_host: schedule.preconditions?.network_host ?? null,
      },
    },
    limits: {
      timeout_sec: normalizedTimeout,
      quiet_timeout_sec: normalizedQuietTimeout,
      hard_timeout_sec: normalizedHardTimeout,
    },
    execution_hints: {
      model: normalizedModel,
      max_turns: normalizedMaxTurns,
      output_format: hints.output_format ?? null,
      non_interactive: hints.non_interactive ?? true,
      provider: hints.provider ?? null,
      provider_config: normalizeProviderConfig(
        hints.provider,
        hints.provider_config,
      ),
      managed:
        hints.managed !== undefined
          ? hints.managed === true
          : hints.provider
            ? true
            : null,
      unmanaged: hints.unmanaged === true,
      session_required:
        hints.session_required !== undefined
          ? hints.session_required === true
          : hints.unmanaged === true
            ? false
            : hints.provider
              ? true
              : hints.managed === true
                ? true
                : null,
    },
    execution: {
      model: normalizedModel,
      max_turns: normalizedMaxTurns,
      timeout_sec: normalizedTimeout,
    },
    notify: {
      on: input.notify?.on || "both",
      channels: input.notify?.channels || ["stdout"],
      file_path: input.notify?.file_path || null,
      webhook_url_env: input.notify?.webhook_url_env || null,
      webhook_body_key: input.notify?.webhook_body_key ?? null,
      webhook_template: input.notify?.webhook_template ?? null,
      on_consecutive_failures: Number.isInteger(
        input.notify?.on_consecutive_failures,
      )
        ? input.notify.on_consecutive_failures
        : null,
    },
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
    memory: normalizeMemory(input),
    tags: Array.isArray(input.tags) ? input.tags : [],
    ...normalizeJobRuntimeFields(input, now),
  };
}

export function validateJob(job, opts = {}) {
  const errors = [];

  if (!isSafeJobId(job.id)) errors.push("id_invalid");
  if (!job.process && !job.prompt) errors.push("process_required");

  if (job.process) {
    if (!isPlainObject(job.process)) {
      errors.push("process_invalid");
    } else {
      if (!job.process.command || typeof job.process.command !== "string")
        errors.push("process_command_required");
      if (job.process.args !== undefined && !Array.isArray(job.process.args))
        errors.push("process_args_invalid");
      if (
        Array.isArray(job.process.args) &&
        job.process.args.some((arg) => typeof arg !== "string")
      )
        errors.push("process_args_invalid");
      if (
        job.process.cwd !== undefined &&
        job.process.cwd !== null &&
        typeof job.process.cwd !== "string"
      )
        errors.push("process_cwd_invalid");
      if (
        job.process.env !== undefined &&
        job.process.env !== null &&
        !isPlainObject(job.process.env)
      )
        errors.push("process_env_invalid");
      if (
        job.process.stdin !== undefined &&
        job.process.stdin !== null &&
        typeof job.process.stdin !== "string"
      )
        errors.push("process_stdin_invalid");
      if (
        job.process.stdin_file !== undefined &&
        job.process.stdin_file !== null &&
        typeof job.process.stdin_file !== "string"
      )
        errors.push("process_stdin_file_invalid");
      if (
        job.process.stdin !== undefined &&
        job.process.stdin !== null &&
        job.process.stdin_file !== undefined &&
        job.process.stdin_file !== null
      )
        errors.push("process_stdin_conflict");
      if (job.process.stdin_file) {
        const base = job.process.cwd || opts.scope?.cwd || process.cwd();
        const p = isAbsolute(job.process.stdin_file)
          ? job.process.stdin_file
          : join(base, job.process.stdin_file);
        if (!existsSync(p)) errors.push("process_stdin_file_missing");
      }
    }
  }

  if (job.prompt) {
    if (!isPlainObject(job.prompt)) {
      errors.push("prompt_invalid");
    } else if (job.prompt?.type === "inline") {
      if (!job.prompt.value || !String(job.prompt.value).trim())
        errors.push("prompt_inline_empty");
    } else if (job.prompt?.type === "file") {
      if (!job.prompt.path) {
        errors.push("prompt_file_path_required");
      } else {
        const base = opts.scope.cwd;
        const p = isAbsolute(job.prompt.path)
          ? job.prompt.path
          : join(base, job.prompt.path);
        if (!existsSync(p)) errors.push("prompt_file_missing");
        else if (!readFileSync(p, "utf8").trim())
          errors.push("prompt_file_empty");
      }
    } else {
      errors.push("prompt_type_invalid");
    }
  }

  if (!job.schedule || !VALID_SCHEDULE_TYPES.has(job.schedule.type))
    errors.push("schedule_type_invalid");
  if (
    job.schedule?.type === "once" &&
    (!job.schedule.start_at ||
      Number.isNaN(new Date(job.schedule.start_at).getTime()))
  ) {
    errors.push("schedule_once_start_at_invalid");
  }
  if (job.schedule?.type === "recurring" && !parseCron(job.schedule.cron))
    errors.push("schedule_cron_invalid");
  if (job.schedule?.type === "interval" && !parseEvery(job.schedule.every))
    errors.push("schedule_every_invalid");
  if (job.schedule?.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: job.schedule.timezone,
      }).format(new Date());
    } catch {
      errors.push("schedule_timezone_invalid");
    }
  }
  if (
    job.schedule?.end_at &&
    Number.isNaN(new Date(job.schedule.end_at).getTime())
  )
    errors.push("schedule_end_at_invalid");

  const on = job.notify?.on ?? "both";
  if (!VALID_NOTIFY_ON.has(on)) errors.push("notify_on_invalid");
  for (const ch of job.notify?.channels || []) {
    if (!VALID_CHANNELS.has(ch)) errors.push(`notify_channel_invalid:${ch}`);
  }
  if (
    job.notify?.webhook_body_key !== null &&
    job.notify?.webhook_body_key !== undefined
  ) {
    if (
      typeof job.notify.webhook_body_key !== "string" ||
      !job.notify.webhook_body_key.trim()
    ) {
      errors.push("notify_webhook_body_key_invalid");
    }
  }
  if (
    job.notify?.webhook_template !== null &&
    job.notify?.webhook_template !== undefined
  ) {
    if (!isJsonValue(job.notify.webhook_template)) {
      errors.push("notify_webhook_template_invalid");
    }
  }
  if (
    job.notify?.webhook_body_key &&
    job.notify?.webhook_template !== null &&
    job.notify?.webhook_template !== undefined
  ) {
    errors.push("notify_webhook_payload_conflict");
  }
  if (
    job.notify?.on_consecutive_failures !== null &&
    job.notify?.on_consecutive_failures !== undefined
  ) {
    if (
      !Number.isInteger(job.notify.on_consecutive_failures) ||
      job.notify.on_consecutive_failures < 1
    ) {
      errors.push("notify_on_consecutive_failures_invalid");
    }
  }

  const turns = job.execution_hints?.max_turns ?? job.execution?.max_turns;
  if (
    turns !== null &&
    turns !== undefined &&
    (!Number.isInteger(turns) || turns <= 0)
  )
    errors.push("execution_max_turns_invalid");
  const timeout = job.limits?.timeout_sec ?? job.execution?.timeout_sec;
  if (
    timeout !== null &&
    timeout !== undefined &&
    (!Number.isInteger(timeout) || timeout <= 0)
  )
    errors.push("execution_timeout_invalid");
  const quietTimeout = job.limits?.quiet_timeout_sec;
  if (
    quietTimeout !== null &&
    quietTimeout !== undefined &&
    (!Number.isInteger(quietTimeout) || quietTimeout < 0)
  )
    errors.push("limits_quiet_timeout_invalid");
  const hardTimeout = job.limits?.hard_timeout_sec;
  if (
    hardTimeout !== null &&
    hardTimeout !== undefined &&
    (!Number.isInteger(hardTimeout) || hardTimeout <= 0)
  )
    errors.push("limits_hard_timeout_invalid");
  if (job.execution_hints !== undefined && !isPlainObject(job.execution_hints))
    errors.push("execution_hints_invalid");
  const provider = job.execution_hints?.provider;
  const providerConfig = job.execution_hints?.provider_config;
  if (
    provider !== undefined &&
    provider !== null &&
    !VALID_PROVIDERS.has(provider)
  ) {
    errors.push("execution_hints_provider_invalid");
  }
  if (
    providerConfig !== undefined &&
    (!isPlainObject(providerConfig) || !isJsonValue(providerConfig))
  ) {
    errors.push("execution_hints_provider_config_invalid");
  }
  if (provider === "academy" && isPlainObject(providerConfig)) {
    if (
      typeof providerConfig.academy_agent !== "string" ||
      !providerConfig.academy_agent.trim()
    ) {
      errors.push("execution_hints_academy_agent_required");
    }
    const academyRuntime = providerConfig.academy_runtime ?? "claude";
    if (
      typeof academyRuntime !== "string" ||
      !VALID_ACADEMY_RUNTIMES.has(academyRuntime)
    ) {
      errors.push("execution_hints_academy_runtime_invalid");
    }
  } else if (provider === "academy") {
    errors.push("execution_hints_academy_agent_required");
  }
  const unmanaged = job.execution_hints?.unmanaged === true;
  const sessionRequired = job.execution_hints?.session_required;
  if (
    sessionRequired !== undefined &&
    sessionRequired !== null &&
    typeof sessionRequired !== "boolean"
  ) {
    errors.push("execution_hints_session_required_invalid");
  }
  if (
    job.execution_hints?.unmanaged !== undefined &&
    typeof job.execution_hints.unmanaged !== "boolean"
  ) {
    errors.push("execution_hints_unmanaged_invalid");
  }
  if (
    String(job.process?.command || "")
      .split("/")
      .pop() === "codex" &&
    job.process?.args?.[0] === "resume"
  ) {
    errors.push("codex_interactive_resume_not_allowed");
  }
  if (provider && unmanaged) {
    errors.push("managed_agent_provider_conflicts_with_unmanaged");
  }
  if (
    (provider || job.execution_hints?.managed === true) &&
    sessionRequired === false &&
    !unmanaged
  ) {
    errors.push("agent_session_required_false_not_allowed");
  }
  if (job.metadata !== undefined && !isPlainObject(job.metadata))
    errors.push("metadata_invalid");
  if (job.memory !== undefined && !isPlainObject(job.memory)) {
    errors.push("memory_invalid");
  } else if (!VALID_MEMORY_MODES.has(job.memory?.mode || "read+write")) {
    errors.push("memory_mode_invalid");
  }

  if (
    job.schedule?.max_catchup_runs !== null &&
    job.schedule?.max_catchup_runs !== undefined
  ) {
    if (
      !Number.isInteger(job.schedule.max_catchup_runs) ||
      job.schedule.max_catchup_runs < 1
    ) {
      errors.push("schedule_max_catchup_runs_invalid");
    }
  }
  if (
    job.schedule?.max_catchup !== null &&
    job.schedule?.max_catchup !== undefined
  ) {
    if (
      !Number.isInteger(job.schedule.max_catchup) ||
      job.schedule.max_catchup < 1
    ) {
      errors.push("schedule_max_catchup_invalid");
    }
  }
  if (
    job.schedule?.max_catchup_cost !== null &&
    job.schedule?.max_catchup_cost !== undefined
  ) {
    if (
      !Number.isFinite(job.schedule.max_catchup_cost) ||
      job.schedule.max_catchup_cost < 0
    ) {
      errors.push("schedule_max_catchup_cost_invalid");
    }
  }
  if (
    job.schedule?.estimated_catchup_cost !== null &&
    job.schedule?.estimated_catchup_cost !== undefined
  ) {
    if (
      !Number.isFinite(job.schedule.estimated_catchup_cost) ||
      job.schedule.estimated_catchup_cost < 0
    ) {
      errors.push("schedule_estimated_catchup_cost_invalid");
    }
  }
  if (
    job.schedule?.missed_run_policy !== null &&
    job.schedule?.missed_run_policy !== undefined
  ) {
    if (
      ![
        "skip",
        "run_once_if_missed",
        "latest_only",
        "bounded_catchup",
      ].includes(job.schedule.missed_run_policy)
    ) {
      errors.push("schedule_missed_run_policy_invalid");
    }
  }
  if (
    job.schedule?.misfire_grace_sec !== null &&
    job.schedule?.misfire_grace_sec !== undefined
  ) {
    if (
      !Number.isInteger(job.schedule.misfire_grace_sec) ||
      job.schedule.misfire_grace_sec < 0
    ) {
      errors.push("schedule_misfire_grace_sec_invalid");
    }
  }
  if (
    job.schedule?.overlap_policy !== null &&
    job.schedule?.overlap_policy !== undefined
  ) {
    if (!["forbid", "allow"].includes(job.schedule.overlap_policy)) {
      errors.push("schedule_overlap_policy_invalid");
    }
  }
  if (
    job.schedule?.stagger_sec !== null &&
    job.schedule?.stagger_sec !== undefined
  ) {
    if (
      !Number.isInteger(job.schedule.stagger_sec) ||
      job.schedule.stagger_sec < 0
    ) {
      errors.push("schedule_stagger_sec_invalid");
    }
  }

  if (
    job.schedule?.preconditions !== undefined &&
    job.schedule?.preconditions !== null
  ) {
    if (!isPlainObject(job.schedule.preconditions)) {
      errors.push("schedule_preconditions_invalid");
    } else {
      if (typeof job.schedule.preconditions.network !== "boolean") {
        errors.push("schedule_preconditions_network_invalid");
      }
      const host = job.schedule.preconditions.network_host;
      if (host !== null && host !== undefined && typeof host !== "string") {
        errors.push("schedule_preconditions_network_host_invalid");
      }
    }
  }

  if (
    job.schedule?.jitter_sec !== undefined &&
    job.schedule?.jitter_sec !== null
  ) {
    if (
      !Number.isFinite(job.schedule.jitter_sec) ||
      job.schedule.jitter_sec < 0
    ) {
      errors.push("schedule_jitter_sec_invalid");
    }
  }

  if (!Array.isArray(job.tags)) {
    errors.push("tags_invalid");
  } else {
    for (const tag of job.tags) {
      if (typeof tag !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(tag)) {
        errors.push("tag_format_invalid");
        break;
      }
    }
  }

  if (job.retry) {
    if (!Number.isInteger(job.retry.max_attempts) || job.retry.max_attempts < 0)
      errors.push("retry_max_attempts_invalid");
    if (!VALID_BACKOFF_TYPES.has(job.retry.backoff))
      errors.push("retry_backoff_invalid");
    if (!Number.isFinite(job.retry.delay_sec) || job.retry.delay_sec < 0)
      errors.push("retry_delay_sec_invalid");
  }

  if (job.conditions) {
    if (
      job.conditions.file_exists !== null &&
      typeof job.conditions.file_exists !== "string"
    )
      errors.push("conditions_file_exists_invalid");
    if (
      job.conditions.env_set !== null &&
      typeof job.conditions.env_set !== "string"
    )
      errors.push("conditions_env_set_invalid");
  }

  return { valid: errors.length === 0, errors };
}

export function validationDiagnostics(input = {}, errors = []) {
  const raw = isPlainObject(input) ? input : {};
  const diagnostics = [];
  const add = (code, message, hint = null) => {
    if (!errors.includes(code)) return;
    diagnostics.push(hint ? { code, message, hint } : { code, message });
  };

  add(
    "id_invalid",
    "Job id is required and must use lowercase letters, numbers, and dashes.",
    'Example: --id metrics-analysis or JSON "id": "metrics-analysis".',
  );
  if (errors.includes("process_required")) {
    if (raw.command !== undefined || raw.args !== undefined) {
      diagnostics.push({
        code: "process_required",
        message:
          "Job JSON must define process.command; top-level command and args are CLI flags only.",
        hint: 'Use { "process": { "command": "codex", "args": ["exec", "..."] } } instead of { "command": "codex", "args": [...] }.',
      });
    } else {
      diagnostics.push({
        code: "process_required",
        message: "Job must define process.command or a legacy prompt.",
        hint: 'For command jobs, use JSON { "process": { "command": "codex", "args": ["exec", "..."] } } or flags --command codex -- exec "...".',
      });
    }
  }
  add(
    "process_command_required",
    "process.command is required and must be a string.",
    'Example: "process": { "command": "codex", "args": ["exec", "..."] }.',
  );
  add(
    "process_args_invalid",
    "process.args must be an array of strings.",
    'Example: "args": ["exec", "Analyze metrics"].',
  );
  add(
    "process_stdin_file_missing",
    "process.stdin_file points to a file that does not exist.",
    "Use an absolute path or a path relative to the job process cwd.",
  );
  add(
    "schedule_type_invalid",
    "Job schedule is missing or has an invalid type.",
    'Choose one: flags --in, --once-at/--at, --cron, --every; or JSON schedule.type "once", "recurring", or "interval".',
  );
  add(
    "schedule_once_start_at_invalid",
    "Once schedules require a valid schedule.start_at timestamp.",
    'Example: "schedule": { "type": "once", "start_at": "2026-05-11T09:00:00-07:00" }.',
  );
  add(
    "schedule_cron_invalid",
    "Recurring schedules require a valid schedule.cron expression.",
    'Example: --cron "0 9 * * 1" --timezone America/Los_Angeles.',
  );
  add(
    "schedule_every_invalid",
    "Interval schedules require a valid schedule.every duration.",
    "Example: --every 30m.",
  );
  add(
    "schedule_timezone_invalid",
    "schedule.timezone must be a valid IANA timezone.",
    "Example: America/Los_Angeles.",
  );
  add(
    "agent_session_required_false_not_allowed",
    "Managed agent jobs must keep session identity required.",
    "Remove --session-required false for provider-backed agent launches.",
  );
  add(
    "codex_interactive_resume_not_allowed",
    "Top-level codex resume requires a terminal and cannot run as a scheduled job.",
    "Use codex exec --json resume <id> - and pass the prompt on stdin.",
  );
  add(
    "memory_mode_invalid",
    "Invalid memory mode.",
    'Valid memory modes are "read+write" and "off".',
  );

  for (const code of errors) {
    if (!diagnostics.some((d) => d.code === code)) {
      diagnostics.push({ code, message: `Validation failed: ${code}` });
    }
  }
  return diagnostics;
}

export function setNextIfMissing(job) {
  if (!job.state.next_run_at) {
    job.state.next_run_at = computeInitialNextRun(job, nowIso());
  }
}

function scopeOwner(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function ensureMutatedJob(scope, patchOrJob, existing = null) {
  const merged = existing
    ? {
        ...existing,
        ...patchOrJob,
        id: existing.id,
        meta: { ...existing.meta },
      }
    : patchOrJob;
  const next = normalizeJob(merged, scope);
  setNextIfMissing(next);
  const validation = validateJob(next, { scope });
  if (!validation.valid) {
    throw Object.assign(new Error("job validation failed"), {
      code: "validation_failed",
      exitCode: 2,
      validation_errors: validation.errors,
      validation_diagnostics: validationDiagnostics(
        patchOrJob,
        validation.errors,
      ),
    });
  }
  return next;
}

export async function createJob(scope, input, opts = {}) {
  const job = ensureMutatedJob(scope, input);
  const owner = scopeOwner("create");
  const source = resolveSource(opts);
  const result = await mutateJobs(scope, owner, async (jobs) => {
    if (jobs.find((entry) => entry.id === job.id)) {
      throw Object.assign(new Error(`job '${job.id}' already exists`), {
        code: "duplicate_id",
        exitCode: 2,
      });
    }
    jobs.push(job);
    return { job: decorateJob(job) };
  });
  if (result.ok) {
    appendActivityEvent({
      type: "job_created",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      source,
      data: { job: decorateJob(job) },
    });
  }
  return result;
}

export async function scheduleJob(scope, input, opts = {}) {
  const job = ensureMutatedJob(scope, input);
  const owner = scopeOwner("schedule");
  const source = resolveSource(opts);
  let emitType = null;
  let before = null;
  const result = await mutateJobs(scope, owner, async (jobs) => {
    const idx = jobs.findIndex((entry) => entry.id === job.id);
    if (idx >= 0) {
      if (!opts.replace) {
        throw Object.assign(
          new Error(`job '${job.id}' already exists (use --replace)`),
          { code: "duplicate_id", exitCode: 2 },
        );
      }
      before = decorateJob(jobs[idx]);
      job.meta.created_at = jobs[idx].meta.created_at;
      job.meta.updated_at = nowIso();
      jobs[idx] = job;
      emitType = "job_updated";
      return { action: "updated", job: decorateJob(job) };
    }
    jobs.push(job);
    emitType = "job_created";
    return { action: "created", job: decorateJob(job) };
  });
  if (result.ok && emitType === "job_created") {
    appendActivityEvent({
      type: "job_created",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      source,
      data: { job: decorateJob(job) },
    });
  } else if (result.ok && emitType === "job_updated") {
    appendActivityEvent({
      type: "job_updated",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: job.id,
      source,
      data: { before, after: decorateJob(job) },
    });
  }
  return result;
}

export async function updateJob(scope, id, patch, opts = {}) {
  const owner = scopeOwner("update");
  const source = resolveSource(opts);
  let before = null;
  let after = null;
  const result = await mutateJobs(scope, owner, async (jobs) => {
    const idx = jobs.findIndex((entry) => entry.id === id);
    if (idx < 0) {
      throw Object.assign(new Error(`job '${id}' not found`), {
        code: "not_found",
        exitCode: 1,
      });
    }
    before = decorateJob(jobs[idx]);
    const next = ensureMutatedJob(scope, patch, jobs[idx]);
    jobs[idx] = next;
    after = decorateJob(next);
    return { job: decorateJob(next) };
  });
  if (result.ok) {
    appendActivityEvent({
      type: "job_updated",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: id,
      source,
      data: { before, after },
    });
  }
  return result;
}

export async function deleteJob(scope, id, opts = {}) {
  const owner = scopeOwner("delete");
  const source = resolveSource(opts);
  let deletedJob = null;
  const result = await mutateJobs(scope, owner, async (jobs) => {
    const existing = jobs.find((entry) => entry.id === id);
    deletedJob = existing ? decorateJob(existing) : null;
    const before = jobs.length;
    const kept = jobs.filter((entry) => entry.id !== id);
    jobs.length = 0;
    jobs.push(...kept);
    return { deleted: before - kept.length };
  });
  if (result.ok && deletedJob) {
    appendActivityEvent({
      type: "job_deleted",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: id,
      source,
      data: { job: deletedJob },
    });
  }
  return result;
}

export async function setJobPaused(scope, id, enabled, opts = {}) {
  const owner = scopeOwner(enabled ? "resume" : "pause");
  const source = resolveSource(opts);
  let emittedJob = null;
  const result = await mutateJobs(scope, owner, async (jobs) => {
    const job = jobs.find((entry) => entry.id === id);
    if (!job) {
      throw Object.assign(new Error(`job '${id}' not found`), {
        code: "not_found",
        exitCode: 1,
      });
    }
    job.state.enabled = enabled;
    job.meta.updated_at = nowIso();
    emittedJob = decorateJob(job);
    return { job: decorateJob(job) };
  });
  if (result.ok) {
    appendActivityEvent({
      type: enabled ? "job_resumed" : "job_paused",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: id,
      source,
      data: { job: emittedJob },
    });
  }
  return result;
}

export async function bulkSetPausedByTag(scope, tag, enabled, opts = {}) {
  const owner = scopeOwner(enabled ? "bulk_resume" : "bulk_pause");
  const source = resolveSource(opts);
  const mutatedJobs = [];
  const result = await mutateJobs(scope, owner, async (jobs) => {
    let matched = 0;
    let mutated = 0;
    for (const job of jobs) {
      if (!(job.tags || []).includes(tag)) continue;
      matched++;
      if (job.state.enabled !== enabled) {
        job.state.enabled = enabled;
        job.meta.updated_at = nowIso();
        mutated++;
        mutatedJobs.push(decorateJob(job));
      }
    }
    return { tag, matched, mutated };
  });
  if (result.ok) {
    for (const decorated of mutatedJobs) {
      appendActivityEvent({
        type: enabled ? "job_resumed" : "job_paused",
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: decorated.id,
        source,
        data: { job: decorated, bulk_tag: tag },
      });
    }
  }
  return result;
}

export async function bulkDeleteByTag(scope, tag, opts = {}) {
  const owner = scopeOwner("bulk_delete");
  const source = resolveSource(opts);
  const removedJobs = [];
  const result = await mutateJobs(scope, owner, async (jobs) => {
    const before = jobs.length;
    const kept = [];
    for (const job of jobs) {
      if ((job.tags || []).includes(tag)) {
        removedJobs.push(decorateJob(job));
      } else {
        kept.push(job);
      }
    }
    jobs.length = 0;
    jobs.push(...kept);
    return {
      tag,
      matched: before - kept.length,
      deleted: before - kept.length,
    };
  });
  if (result.ok) {
    for (const decorated of removedJobs) {
      appendActivityEvent({
        type: "job_deleted",
        scope_id: scope.scope_id,
        cwd: scope.cwd,
        job_id: decorated.id,
        source,
        data: { job: decorated, bulk_tag: tag },
      });
    }
  }
  return result;
}

export async function cloneJob(scope, sourceId, newId, opts = {}) {
  const owner = scopeOwner("clone");
  const source = resolveSource(opts);
  let freshJob = null;
  const result = await mutateJobs(scope, owner, async (jobs) => {
    const src = jobs.find((entry) => entry.id === sourceId);
    if (!src) {
      throw Object.assign(new Error(`job '${sourceId}' not found`), {
        code: "not_found",
        exitCode: 1,
      });
    }
    if (jobs.find((entry) => entry.id === newId)) {
      throw Object.assign(new Error(`job '${newId}' already exists`), {
        code: "duplicate_id",
        exitCode: 2,
      });
    }
    const clone = JSON.parse(JSON.stringify(src));
    clone.id = newId;
    if (src.name === src.id) clone.name = newId;
    const fresh = ensureMutatedJob(scope, clone);
    fresh.state.enabled = true;
    fresh.state.last_run_at = null;
    fresh.state.last_status = "none";
    fresh.state.last_error = null;
    fresh.state.last_failed_step = null;
    fresh.meta.created_at = nowIso();
    fresh.meta.updated_at = nowIso();
    jobs.push(fresh);
    freshJob = decorateJob(fresh);
    return { source_id: sourceId, job: decorateJob(fresh) };
  });
  if (result.ok && freshJob) {
    appendActivityEvent({
      type: "job_cloned",
      scope_id: scope.scope_id,
      cwd: scope.cwd,
      job_id: newId,
      source,
      data: { source_id: sourceId, new_id: newId, job: freshJob },
    });
  }
  return result;
}
