#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, commandName, output, fail } from "./lib/json_io.mjs";
import { TASKS_COMMAND } from "./lib/helm_context.mjs";
import {
  ensureWorkspaceConfigDir,
  helmHome,
  loadJobsReadOnly,
  loadRuntime,
  pruneOldData,
  readJsonIfExists,
  resolveScope,
  scopeRuntimeRoot,
  writeJsonAtomic,
} from "./lib/store.mjs";
import { previewNextRuns } from "./lib/schedule_eval.mjs";
import { previewScheduleFromFlags } from "./lib/schedule_preview.mjs";
import {
  buildScheduleFromFlags,
  nowDate as _nowDate,
} from "./lib/schedule_flags.mjs";
import { emitNotifications } from "./lib/notify.mjs";
import {
  installHeartbeat,
  removeHeartbeat,
  heartbeatStatus,
} from "./lib/heartbeat.mjs";
import { listRegisteredScopes, registerScope } from "./lib/scopes.mjs";
import {
  invalidProductionServiceLabels,
  serviceInstall,
  PRODUCTION_STATUS_PORT,
  serviceRestart,
  serviceStart,
  serviceStatus,
  serviceStop,
  serviceUninstall,
  sentinelInstall,
  sentinelStart,
  sentinelStatus,
  sentinelStop,
  sentinelUninstall,
} from "./lib/service.mjs";
import { daemonLastTickPath } from "./lib/daemon.mjs";
import { runDaemonCommand } from "./lib/daemon_entrypoint.mjs";
import {
  workspaceRunEvents,
  baseStatusData,
  getJob,
  historyForJob,
  jobStatusPayload,
  listJobs,
  resolveRunForLogs,
  workspaceStatusData,
} from "./lib/observability_service.mjs";
import { runStatusServer } from "./lib/status_server.mjs";
import { appendActivityEvent } from "./lib/activity_stream.mjs";
import {
  loadPublicEvents,
  publicEventsFileSize,
  publicEventsPath,
} from "./lib/read_store.mjs";
import {
  bulkDeleteByTag,
  bulkSetPausedByTag,
  cloneJob,
  createJob,
  deleteJob,
  normalizeJob,
  scheduleJob,
  setJobPaused,
  updateJob,
  validateJob,
  validationDiagnostics,
} from "./lib/job_service.mjs";
import {
  cancelJob,
  dispatchScope,
  runJobNow,
} from "./lib/dispatch_service.mjs";
import { probeNetwork } from "./lib/network_probe.mjs";
import {
  daemonFreshnessStatus,
  freshnessSchedulerScriptPath,
} from "./lib/daemon_freshness.mjs";
import { serviceRestartSafetyReport } from "./lib/service_restart_safety.mjs";
import {
  initWorkspace,
  bringWorkspaceDown,
  ensureWorkspaceRuntime,
  ensureWorkspaceUp,
} from "./lib/workspace_service.mjs";
import { runActivation } from "./lib/activation_service.mjs";
import { bootstrapHooks as bootstrapHooksCommand } from "./lib/bootstrap_hooks.mjs";
import { isProcessAlive } from "./lib/process_liveness.mjs";
import { runReportCommand } from "./lib/report_cli.mjs";
import { runCofounderChecks } from "./lib/doctor/cofounder.mjs";
import {
  runDeepDoctor,
  runSingleCheck,
  BAND_FLAGS as DOCTOR_BAND_FLAGS,
  CHECKS as DOCTOR_CHECKS,
} from "./lib/doctor/index.mjs";
import { hintFor as doctorHintFor } from "./lib/doctor/hint_map.mjs";

// nowDate is imported from src/lib/schedule_flags.mjs (shared clock hook)
function nowDate() {
  return _nowDate();
}

function nowIso() {
  return nowDate().toISOString();
}

function ageSecondsSince(timestamp, now = nowDate()) {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / 1000));
}

function computeLastDaemonTick() {
  try {
    const raw = readFileSync(daemonLastTickPath(), "utf8").trim();
    if (!raw) return null;
    const age = ageSecondsSince(raw);
    if (age === null) return null;
    return { timestamp: raw, age_seconds: age };
  } catch {
    return null;
  }
}

function serviceStatusWithBehavior(schedulerScriptPath) {
  const status = serviceStatus(schedulerScriptPath);
  return {
    ...status,
    invalid_service_labels: invalidProductionServiceLabels(),
    last_daemon_tick: computeLastDaemonTick(),
    daemon_freshness: daemonFreshnessStatus(
      freshnessSchedulerScriptPath(status, schedulerScriptPath),
    ),
  };
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function usage() {
  return {
    commands: [
      "up",
      "down",
      "ensure",
      "status",
      "init",
      "schedule",
      "create",
      "update",
      "delete",
      "clone",
      "pause",
      "resume",
      "list",
      "list-all",
      "get",
      "bootstrap-hooks",
      "run",
      "run-now",
      "cancel",
      "dispatch",
      "history",
      "job-status",
      "logs",
      "watch",
      "next-runs",
      "export",
      "import",
      "prune",
      "validate",
      "notify-test",
      "service install|start|stop|restart|status|uninstall",
      "system update",
      "system migrate-home",
      "dev-daemon up|status|down",
      "sentinel install|start|stop|status|uninstall",
      "daemon run",
      "server run",
      "heartbeat install|remove|status",
      "migrate",
      "desired-state get|set",
      "check network",
      "doctor",
      "onboard",
      "skills refresh",
      "identity show",
      "sessions list",
      "workspaces list",
      "scopes list|reconcile|enable|disable|quarantine|unquarantine|explain",
    ],
    input: {
      create: ["--job-file", "--stdin", "flags"],
      update: ["--patch-file", "--stdin", "flags (partial)"],
      validate: ["--job-file", "--stdin", "flags"],
      schedule: ["--job-file", "--stdin", "flags"],
    },
    authoring_flags: [
      "--command",
      "--args-json",
      "--memory <read+write|off>",
      "--no-memory",
      "-- (trailing args)",
      "--process-cwd",
      "--stdin-text",
      "--stdin-file",
      "--env-json",
      "--metadata-json",
      "--provider",
      "--academy-agent",
      "--academy-runtime",
      "--unmanaged",
      "--session-required",
      "--output-format",
      "--timeout-sec",
      "--notify-webhook-body-key",
      "--notify-webhook-template-json",
      "--tags",
      "--retry-max",
      "--retry-backoff",
      "--retry-delay-sec",
      "--max-catchup-runs",
      "--missed-run-policy",
      "--misfire-grace-sec",
      "--max-catchup-cost",
      "--estimated-catchup-cost",
      "--overlap-policy",
      "--no-network-check",
      "--network-host",
      "--activate",
    ],
    compatibility_flags: [
      "--prompt",
      "--prompt-file",
      "--model",
      "--max-turns",
    ],
  };
}

const HELP_COMMANDS = [
  "schedule",
  "skills refresh",
  "create",
  "update",
  "validate",
  "status",
  "up",
  "list",
  "get",
  "history",
  "logs",
  "job-status",
  "run",
  "run-now",
  "report",
  "cancel",
  "delete",
  "pause",
  "resume",
  "service status",
  "service update",
  "system migrate-home",
  "dev-daemon",
  "migrate",
  "desired-state",
];

const HELP_CATALOG = {
  service: {
    command: "service",
    summary: "Manage the Helm scheduler and service definitions.",
    usage:
      `${TASKS_COMMAND} service <status|update|restart|start|stop|install|uninstall>`,
    required: [],
    available_commands: [
      "service status",
      "service update",
      "service restart",
      "service start",
      "service stop",
      "service install",
      "service uninstall",
    ],
    options: ["--cwd <path>", "--force", "--deep", "--pretty", "--help-json"],
    examples: [
      {
        label: "refresh scheduler and sentinel definitions",
        command: `${TASKS_COMMAND} service update --cwd "$PWD" --pretty`,
      },
      {
        label: "inspect service health",
        command: `${TASKS_COMMAND} service status --cwd "$PWD" --deep --pretty`,
      },
    ],
    notes: [
      "Use service update after Helm daemon or sentinel code changes; it refreshes installed scheduler and sentinel definitions and restarts both.",
    ],
  },
  "skills refresh": {
    command: "skills refresh",
    summary: "Refresh installed Helm agent skills from this Helm checkout.",
    usage: `${TASKS_COMMAND} skills refresh [--no-verify] [--pretty]`,
    required: [],
    options: [
      "--no-verify             Skip the deep-doctor verify stage.",
      "--pretty                Human-readable JSON output.",
    ],
    examples: [
      {
        label: "refresh skills after updating Helm",
        command: `${TASKS_COMMAND} skills refresh --pretty`,
      },
      {
        label: "refresh without verify gate",
        command: `${TASKS_COMMAND} skills refresh --no-verify --pretty`,
      },
    ],
    notes: [
      `Equivalent to rerunning \`${TASKS_COMMAND} onboard\` on an already configured install.`,
      "Copies vendored skills into ~/.agents/skills and mirrors them into ~/.claude/skills and ~/.codex/skills.",
    ],
  },
  report: {
    command: "report",
    summary: "Report the outcome of the current managed agent run.",
    usage:
      `${TASKS_COMMAND} report --status <ok|fail> --summary <text> [--origin-thread <id> --completion-message <id>] [--run <run-id>] [--job <job-id>]`,
    required: ["--status <ok|fail>      Required for managed assignment runs."],
    options: [
      "--summary <text>        One-line outcome summary.",
      "--origin-thread <id>    Opaque official Tightbeam thread for this run.",
      "--completion-message <id> Opaque terminal Tightbeam message for this run.",
      "--run <run-id>          Override HELM_RUN_ID.",
      "--job <job-id>          Override HELM_JOB_ID.",
      "--session <session-id>  Record the reporting agent session.",
      "--resume-command <cmd>  Record how to resume the reporting session.",
      "--pretty                Human-readable JSON output.",
    ],
    examples: [
      {
        label: "report successful work from a managed run",
        command:
          `${TASKS_COMMAND} report --status ok --summary "Completed the requested work"`,
      },
    ],
    notes: [
      "Managed runs normally receive their run and job ids through HELM_RUN_ID and HELM_JOB_ID.",
      "Without a valid required report, Helm records an assignment outcome as indeterminate.",
    ],
  },
  schedule: {
    command: "schedule",
    summary:
      "Create runnable scheduled work and activate the workspace runtime.",
    usage:
      `${TASKS_COMMAND} schedule --cwd <path> --id <id> <schedule> ( --prompt <text> --provider <agent> | --prompt-file <path> --provider <agent> | --command <cmd> [-- <args...>] )`,
    required: [
      "--id <id>",
      "--prompt/--prompt-file + --provider for managed agents, or --command <executable> for deterministic jobs",
      "one schedule flag",
    ],
    schedule_flags: [
      "--in <2m|1h|1d|1w>",
      "--once-at <iso-time>",
      "--at <iso-time>",
      "--cron <expr>",
      "--every <duration>",
    ],
    options: [
      "--cwd <path>",
      "--replace",
      "--timezone <iana-zone>",
      "--args-json <json-array>",
      "--memory <read+write|off>",
      "--no-memory",
      "--stdin-text <text>",
      "--stdin-file <path>",
      "--env-json <json-object>",
      "--metadata-json <json-object>",
      "--provider <codex|claude|droid|gemini|cursor|hermes|academy>",
      "--academy-agent <name>",
      "--academy-runtime <claude|codex>",
      "--prompt <text>",
      "--prompt-file <path>",
      "--tags <a,b,c>",
      "--timeout-sec <seconds>",
    ],
    examples: [
      {
        label: "managed Codex agent one week from now",
        command:
          `${TASKS_COMMAND} schedule --cwd "$PWD" --id metrics-analysis --in 1w --prompt "Analyze metrics and summarize findings" --provider codex`,
      },
      {
        label: "managed Codex agent at exact time",
        command:
          `${TASKS_COMMAND} schedule --cwd "$PWD" --id metrics-analysis --once-at 2026-05-11T09:00:00-07:00 --prompt "Analyze metrics and summarize findings" --provider codex`,
      },
      {
        label: "managed Claude recurring prompt file",
        command:
          `${TASKS_COMMAND} schedule --cwd "$PWD" --id weekly-review --cron "0 9 * * 1" --timezone America/Los_Angeles --prompt-file prompts/weekly-review.md --provider claude`,
      },
      {
        label: "deterministic command job",
        command:
          `${TASKS_COMMAND} schedule --cwd "$PWD" --id nightly-sync --cron "0 3 * * *" --timezone America/Los_Angeles --command node -- scripts/nightly-sync.mjs`,
      },
      {
        label: "json job",
        command: `cat <<'JSON' | ${TASKS_COMMAND} schedule --cwd "$PWD" --stdin\n{\n  "id": "metrics-analysis",\n  "prompt": {\n    "type": "inline",\n    "value": "Analyze metrics and summarize findings"\n  },\n  "execution_hints": {\n    "provider": "codex"\n  },\n  "schedule": {\n    "type": "once",\n    "start_at": "2026-05-11T09:00:00-07:00"\n  }\n}\nJSON`,
      },
    ],
    notes: [
      "Use --provider with --prompt or --prompt-file for managed agent jobs; Helm owns argv, prompt injection, session capture, and resume metadata.",
      "Use --command for deterministic non-agent subprocesses. JSON jobs use process.command and process.args for command jobs.",
      "Everything after -- is passed as literal subprocess args. Use either -- or --args-json, not both.",
      "schedule validates, activates the service, writes the job, and returns activation.scope_registered, activation.service_running, activation.health, and activation.will_dispatch.",
    ],
  },
  create: {
    command: "create",
    summary:
      "Create a stored job and register its scope into the dispatch rotation. Pass --activate to also ensure the supervised service is running and healthy.",
    usage:
      `${TASKS_COMMAND} create --cwd <path> --id <id> <schedule> --command <cmd> [--activate]`,
    required: [
      "--id <id>",
      "--command <executable> or --prompt <text>",
      "one schedule flag",
    ],
    options: [
      "--job-file <path>",
      "--stdin",
      "--activate",
      "--args-json <json-array>",
      "--memory <read+write|off>",
      "--no-memory",
      "--metadata-json <json-object>",
    ],
    examples: [
      {
        label: "draft job",
        command:
          `${TASKS_COMMAND} create --cwd "$PWD" --id draft-review --in 1h --command echo -- "review later"`,
      },
    ],
    notes: [
      "Use schedule for runnable future work (validates + starts the service). create registers the scope so the daemon will dispatch the job; pass --activate to also start/verify the supervised service now.",
    ],
  },
  validate: {
    command: "validate",
    summary:
      "Validate a job from flags, --stdin, or --job-file without writing it.",
    usage: `${TASKS_COMMAND} validate --cwd <path> --stdin`,
    required: ["a complete job from flags, --stdin, or --job-file"],
    options: [
      "--job-file <path>",
      "--stdin",
      "--command <executable>",
      "--args-json <json-array>",
      "--once-at <time>",
      "--cron <expr>",
      "--every <duration>",
    ],
    examples: [
      {
        label: "validate json",
        command:
          `cat job.json | ${TASKS_COMMAND} validate --cwd "$PWD" --stdin --pretty`,
      },
    ],
    notes: [
      "JSON jobs use process.command and process.args, not top-level command/args.",
    ],
  },
  status: {
    command: "status",
    summary: "Show workspace scheduler status; use --deep for runtime health.",
    usage: `${TASKS_COMMAND} status --cwd <path> [--deep]`,
    required: [],
    options: ["--deep", "--pretty"],
    examples: [
      {
        label: "runtime health",
        command: `${TASKS_COMMAND} status --cwd "$PWD" --deep --pretty`,
      },
    ],
    notes: ["status --deep exits non-zero when the runtime is unhealthy."],
  },
  up: {
    command: "up",
    summary:
      "Register the workspace and ensure the supervised service is running.",
    usage: `${TASKS_COMMAND} up --cwd <path>`,
    required: [],
    options: ["--cwd <path>", "--pretty"],
    examples: [
      {
        label: "repair activation",
        command: `${TASKS_COMMAND} up --cwd "$PWD" --pretty`,
      },
    ],
    notes: ["schedule normally performs this activation automatically."],
  },
  list: {
    command: "list",
    summary: "List jobs in the current workspace.",
    usage: `${TASKS_COMMAND} list --cwd <path>`,
    required: [],
    options: [
      "--enabled true|false",
      "--tag <tag>",
      "--status <status>",
      "--schedule-type <type>",
      "--limit <n>",
    ],
    examples: [
      { label: "list jobs", command: `${TASKS_COMMAND} list --cwd "$PWD" --pretty` },
    ],
    notes: [],
  },
  get: {
    command: "get",
    summary: "Show one job by id.",
    usage: `${TASKS_COMMAND} get --cwd <path> --id <id>`,
    required: ["--id <id>"],
    options: ["--pretty"],
    examples: [
      {
        label: "show job",
        command: `${TASKS_COMMAND} get --cwd "$PWD" --id metrics-analysis --pretty`,
      },
    ],
    notes: [],
  },
  history: {
    command: "history",
    summary: "Show previous run events for one job.",
    usage: `${TASKS_COMMAND} history --cwd <path> --id <id> [--limit <n>]`,
    required: ["--id <id>"],
    options: ["--limit <n>", "--pretty"],
    examples: [
      {
        label: "recent runs",
        command:
          `${TASKS_COMMAND} history --cwd "$PWD" --id metrics-analysis --limit 20 --pretty`,
      },
    ],
    notes: [],
  },
  logs: {
    command: "logs",
    summary: "Read stdout or stderr logs for the latest or selected run.",
    usage:
      `${TASKS_COMMAND} logs --cwd <path> --id <id> [--stdout|--stderr] [--run-id <run-id>]`,
    required: ["--id <id>"],
    options: ["--stdout", "--stderr", "--run-id <run-id>", "--follow"],
    examples: [
      {
        label: "stdout",
        command: `${TASKS_COMMAND} logs --cwd "$PWD" --id metrics-analysis --stdout`,
      },
    ],
    notes: [],
  },
  "job-status": {
    command: "job-status",
    summary: "Show live process state for a job.",
    usage: `${TASKS_COMMAND} job-status --cwd <path> --id <id>`,
    required: ["--id <id>"],
    options: ["--pretty"],
    examples: [
      {
        label: "active run",
        command:
          `${TASKS_COMMAND} job-status --cwd "$PWD" --id metrics-analysis --pretty`,
      },
    ],
    notes: [
      "Returns active_run.pid, started_at, elapsed_ms, alive, and log_paths when running.",
    ],
  },
  run: {
    command: "run",
    summary: "Run a job now. Alias for run-now.",
    usage: `${TASKS_COMMAND} run --cwd <path> --id <id>`,
    required: ["--id <id>"],
    options: [
      "--override-env-json <json-object>",
      "--override-args-json <json-array>",
      "--memory <read+write|off>",
      "--no-memory",
      "--override-prompt <text>",
    ],
    examples: [
      {
        label: "run now",
        command: `${TASKS_COMMAND} run --cwd "$PWD" --id metrics-analysis --pretty`,
      },
    ],
    notes: ["The command exits non-zero if the job fails."],
  },
  "run-now": {
    command: "run-now",
    summary: "Run a job now.",
    usage: `${TASKS_COMMAND} run-now --cwd <path> --id <id>`,
    required: ["--id <id>"],
    options: [
      "--override-env-json <json-object>",
      "--override-args-json <json-array>",
      "--memory <read+write|off>",
      "--no-memory",
      "--override-prompt <text>",
    ],
    examples: [
      {
        label: "run now",
        command:
          `${TASKS_COMMAND} run-now --cwd "$PWD" --id metrics-analysis --pretty`,
      },
    ],
    notes: ["run is an alias for run-now."],
  },
  "service status": {
    command: "service status",
    summary:
      "Show global service state; use --deep for workspace runtime health.",
    usage: `${TASKS_COMMAND} service status --cwd <path> [--deep]`,
    required: [],
    options: ["--deep", "--pretty"],
    examples: [
      {
        label: "service health",
        command: `${TASKS_COMMAND} service status --cwd "$PWD" --deep --pretty`,
      },
    ],
    notes: [],
  },
  "system update": {
    command: "system update",
    summary:
      "Refresh installed scheduler and sentinel definitions and restart them.",
    usage: `${TASKS_COMMAND} system update [--force] [--cwd <path>]`,
    required: [],
    options: [
      "--force                Restart even when active runs are live.",
      "--cwd <path>",
      "--pretty",
    ],
    examples: [
      {
        label: "refresh daemon and sentinel after code changes",
        command: `${TASKS_COMMAND} system update --cwd "$PWD" --pretty`,
      },
      {
        label: "force while active runs exist",
        command: `${TASKS_COMMAND} system update --force --cwd "$PWD" --pretty`,
      },
    ],
    notes: [
      "Reinstalls the scheduler service template, restarts the scheduler daemon, reinstalls the sentinel definition, and restarts sentinel so it reloads current source.",
      "Use after changing Helm daemon or sentinel code. The command refuses to interrupt live active runs unless --force is passed.",
      `Alias: ${TASKS_COMMAND} service update.`,
    ],
  },
  "system migrate-home": {
    command: "system migrate-home",
    summary:
      "Rewrite stored absolute paths from an old Helm home prefix to a new one after the home was renamed.",
    usage:
      `${TASKS_COMMAND} system migrate-home --from <old-helm-home-abs-path> --to <new-helm-home-abs-path> [--dry-run] --json`,
    required: ["--from <abs-path>", "--to <abs-path>"],
    options: [
      "--from <abs-path>      Old Helm home prefix to rewrite; may be missing or a symlink.",
      "--to <abs-path>        New Helm home; must exist and already hold the Helm data.",
      "--dry-run              Write nothing; report the counts a real run would rewrite.",
      "--json",
      "--pretty",
    ],
    examples: [
      {
        label: "preview the Phase E rewrite",
        command:
          `${TASKS_COMMAND} system migrate-home --from "$HOME/.helm" --to "$HOME/.tldr-agents/helm" --dry-run --json`,
      },
    ],
    notes: [
      "Rewrites scope_registry.storage_root, scope_registry.source_json, scope_registry_metadata.last_backup_path (one transaction), scopes.json, workspaces/*/scope.json, and identity.json agentmail_key_path (atomic file replaces).",
      "A --dry-run may run before the rename: when --to is missing and --from holds the Helm data, it reads --from (data.read_from) and writes nothing.",
      "Idempotent: a second run rewrites nothing and reports already_migrated: true.",
      "Refuses with active_runs_in_progress (exit 3) while any Helm run is active; usage errors exit 2.",
    ],
  },
  "service update": {
    command: "service update",
    summary:
      "Alias for system update; refresh scheduler and sentinel definitions and restart them.",
    usage: `${TASKS_COMMAND} service update [--force] [--cwd <path>]`,
    required: [],
    options: [
      "--force                Restart even when active runs are live.",
      "--cwd <path>",
      "--pretty",
    ],
    examples: [
      {
        label: "refresh daemon and sentinel after code changes",
        command: `${TASKS_COMMAND} service update --cwd "$PWD" --pretty`,
      },
    ],
    notes: [
      "Reinstalls the scheduler service template, restarts the scheduler daemon, reinstalls the sentinel definition, and restarts sentinel so it reloads current source.",
      "Use after changing Helm daemon or sentinel code. The command refuses to interrupt live active runs unless --force is passed.",
      `Alias target: ${TASKS_COMMAND} system update.`,
    ],
  },
  "dev-daemon": {
    command: "dev-daemon",
    summary: "Run an isolated development scheduler daemon.",
    usage:
      `${TASKS_COMMAND} dev-daemon <up|status|down> --name <name> [--port <port>]`,
    required: ["--name <task-or-branch>"],
    options: ["--name <name>", "--port <non-45173>", "--pretty"],
    examples: [
      {
        label: "start isolated daemon",
        command: `${TASKS_COMMAND} dev-daemon up --name runway --pretty`,
      },
      {
        label: "stop isolated daemon",
        command: `${TASKS_COMMAND} dev-daemon down --name runway --pretty`,
      },
    ],
    notes: [
      "Uses HELM_HOME=~/.helm-dev-<name>, label ai.helm.scheduler.dev.<name>, and a non-production status port.",
    ],
  },
  migrate: {
    command: "migrate",
    summary: "Run runtime store schema migrations.",
    usage: `${TASKS_COMMAND} migrate [--dry-run] [--cwd <path>]`,
    required: [],
    options: ["--dry-run", "--cwd <path>", "--pretty", "--json-only"],
    examples: [
      {
        label: "validate migrations on a copy",
        command: `${TASKS_COMMAND} migrate --dry-run --cwd "$PWD" --json-only`,
      },
    ],
    notes: [
      "Uses HELM_HOME for the runtime store and never registers or dispatches a scope.",
      "Dry-run mode copies the runtime DB first and leaves the source unchanged.",
    ],
  },
  "desired-state": {
    command: "desired-state",
    summary: "Inspect or set the durable scheduler desired state.",
    usage:
      `${TASKS_COMMAND} desired-state set --mode <disabled|live> [--lockout <reason|none>] [--outbound-mode <disabled|dry_run|allowlist|live>]`,
    required: [],
    options: [
      "--mode <mode>",
      "--lockout <reason|none>",
      "--outbound-mode <mode>",
      "--reason <text>",
      "--cwd <path>",
      "--pretty",
      "--json-only",
    ],
    examples: [
      {
        label: "emergency lockout",
        command:
          `${TASKS_COMMAND} desired-state set --mode disabled --lockout emergency --cwd "$PWD"`,
      },
    ],
    notes: [
      "Missing desired state is fail-closed; set live explicitly before starting the service.",
    ],
  },
  cancel: {
    command: "cancel",
    summary: "Cancel a scheduled job before it runs.",
    usage: `${TASKS_COMMAND} cancel --cwd <path> --id <id>`,
    required: ["--id <id>"],
    options: ["--pretty"],
    examples: [
      {
        label: "cancel a scheduled job",
        command:
          `${TASKS_COMMAND} cancel --cwd "$PWD" --id metrics-analysis --pretty`,
      },
    ],
    notes: [
      "cancel prevents future runs of a job but leaves history intact. Use delete to remove the job entirely.",
      "cancel does not stop an actively running process; for that, use the OS or wait for the run to complete.",
    ],
  },
  update: {
    command: "update",
    summary:
      "Apply a partial patch to an existing job (reschedule, retarget, retag).",
    usage:
      `${TASKS_COMMAND} update --cwd <path> --id <id> ( --patch-file <path> | --stdin | flags )`,
    required: ["--id <id> (or id inside the patch payload)"],
    options: [
      "--patch-file <path>       JSON patch with the fields to merge.",
      "--stdin                   Read the JSON patch from stdin.",
      "--once-at <iso-time>      Reschedule a one-off job.",
      "--cron <expr>             Replace the recurring schedule.",
      "--timezone <iana-zone>",
      "--command <executable>",
      "--args-json <json-array>",
      "--metadata-json <json-object>",
      "--tags <a,b,c>",
      "--pretty",
    ],
    examples: [
      {
        label: "reschedule a one-off",
        command:
          `${TASKS_COMMAND} update --cwd "$PWD" --id metrics-analysis --once-at 2026-05-18T09:00:00-07:00 --pretty`,
      },
      {
        label: "patch from stdin",
        command: `echo '{"metadata":{"reason":"updated"}}' | ${TASKS_COMMAND} update --cwd "$PWD" --id metrics-analysis --stdin --pretty`,
      },
    ],
    notes: [
      "update merges the patch; omitted fields are left unchanged.",
      `For destructive replacement, use ${TASKS_COMMAND} schedule --replace.`,
    ],
  },
  delete: {
    command: "delete",
    summary: "Permanently delete a job (and any pending runs).",
    usage: `${TASKS_COMMAND} delete --cwd <path> ( --id <id> | --tag <tag> )`,
    required: ["--id <id> or --tag <tag>"],
    options: ["--pretty"],
    examples: [
      {
        label: "delete one job",
        command:
          `${TASKS_COMMAND} delete --cwd "$PWD" --id metrics-analysis --pretty`,
      },
      {
        label: "bulk delete by tag",
        command: `${TASKS_COMMAND} delete --cwd "$PWD" --tag draft --pretty`,
      },
    ],
    notes: [
      "delete removes the job; use cancel to stop future runs while keeping the row.",
    ],
  },
  pause: {
    command: "pause",
    summary: "Pause a job (or all jobs with a tag) so it skips scheduled runs.",
    usage: `${TASKS_COMMAND} pause --cwd <path> ( --id <id> | --tag <tag> )`,
    required: ["--id <id> or --tag <tag>"],
    options: ["--pretty"],
    examples: [
      {
        label: "pause one job",
        command: `${TASKS_COMMAND} pause --cwd "$PWD" --id nightly-digest --pretty`,
      },
      {
        label: "pause by tag",
        command: `${TASKS_COMMAND} pause --cwd "$PWD" --tag draft --pretty`,
      },
    ],
    notes: ["Paused jobs remain in the workspace; use resume to re-enable."],
  },
  resume: {
    command: "resume",
    summary: "Resume a previously paused job (or all jobs with a tag).",
    usage: `${TASKS_COMMAND} resume --cwd <path> ( --id <id> | --tag <tag> )`,
    required: ["--id <id> or --tag <tag>"],
    options: ["--pretty"],
    examples: [
      {
        label: "resume one job",
        command: `${TASKS_COMMAND} resume --cwd "$PWD" --id nightly-digest --pretty`,
      },
      {
        label: "resume by tag",
        command: `${TASKS_COMMAND} resume --cwd "$PWD" --tag draft --pretty`,
      },
    ],
    notes: [],
  },
  onboard: {
    command: "onboard",
    summary:
      "First-run setup: writes execution identity and installs agent skills + hooks.",
    usage: `${TASKS_COMMAND} onboard [--name <X> --email <Y>] [--non-interactive]`,
    required: [
      "(interactive)            No flags required — prompts for name, email, and workspaces root.",
      "(non-interactive)        --name and --email are required.",
    ],
    options: [
      "--non-interactive       Skip prompts; --name and --email are required.",
      "--workspaces-root <p>   Where your agent projects live (default: detected ~/Dev, ~/Code, ~/Projects, ~/src).",
      "--primary-agent <name>  Default controlled agent for prompt jobs and fresh spawns (claude|codex; default codex).",
      "--secondary-agent <name> Fallback controlled agent (claude|codex; default claude).",
      "--fallback-policy <p>   Agent fallback policy: always | never (default always).",
      "--reconfigure <field>   Update an existing install: name | email | workspaces-root | default-workspace | agents.",
    ],
    examples: [
      {
        label: "fresh install (interactive)",
        command: `${TASKS_COMMAND} onboard`,
      },
      {
        label: "non-interactive",
        command:
          `${TASKS_COMMAND} onboard --non-interactive --name Joe --email joe@example.com`,
      },
      {
        label: "switch primary agent",
        command:
          `${TASKS_COMMAND} onboard --reconfigure agents --non-interactive --primary-agent codex --secondary-agent claude --fallback-policy always`,
      },
    ],
    test_edge_cases: [
      "--no-verify             Skip the deep-doctor verify stage. For tests and edge cases that cannot tolerate a deep check. Default behavior is `--verify`.",
    ],
    notes: [
      "Stage 6.9 runs a deep-doctor verify as the final setup gate; on failure, exit 1 with a one-line Frame-Own-Recommend stderr.",
      `Re-running \`${TASKS_COMMAND} onboard\` on an already-configured install refreshes agent skills + hooks and re-runs the verify gate.`,
    ],
  },
};

function helpPayload(command = null) {
  if (command) {
    const entry = HELP_CATALOG[command];
    if (!entry) {
      return {
        command,
        error: "unknown_command",
        available_commands: HELP_COMMANDS,
      };
    }
    return entry;
  }
  return {
    command: "help",
    summary:
      "Helm Tasks is a local scheduler for non-interactive agent and CLI work.",
    usage: `${TASKS_COMMAND} <command> [options]`,
    common_workflows: [
      {
        label: "schedule one-off work",
        command:
          `${TASKS_COMMAND} schedule --cwd "$PWD" --id metrics-analysis --in 1w --prompt "Analyze metrics and summarize findings" --provider codex`,
      },
      {
        label: "schedule recurring work",
        command:
          `${TASKS_COMMAND} schedule --cwd "$PWD" --id nightly-digest --cron "0 23 * * *" --timezone America/Los_Angeles --prompt-file prompts/nightly-digest.md --provider claude`,
      },
      {
        label: "refresh installed skills after updating Helm",
        command: `${TASKS_COMMAND} skills refresh --pretty`,
      },
      {
        label: "check runtime health",
        command: `${TASKS_COMMAND} status --cwd "$PWD" --deep --pretty`,
      },
    ],
    commands: HELP_COMMANDS,
    notes: [
      `Use ${TASKS_COMMAND} <command> --help for command details.`,
      `Use ${TASKS_COMMAND} <command> --help-json for structured help.`,
    ],
  };
}

function renderHelpSection(title, lines) {
  if (!lines || lines.length === 0) return "";
  return `${title}:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

function renderCommandHelp(entry) {
  if (entry.error) {
    return [
      `Unknown help topic: ${entry.command}`,
      "",
      renderHelpSection("Available commands", entry.available_commands),
      "",
      `Use "${TASKS_COMMAND} --help" for the top-level overview.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const examples = (entry.examples || []).map(
    (example) =>
      `${example.label}:\n    ${String(example.command).split("\n").join("\n    ")}`,
  );
  return [
    `${TASKS_COMMAND} ${entry.command} - ${entry.summary}`,
    "",
    `Usage:\n  ${entry.usage}`,
    "",
    renderHelpSection("Required", entry.required),
    renderHelpSection("Schedules, choose one", entry.schedule_flags),
    renderHelpSection("Common options", entry.options),
    renderHelpSection("Examples", examples),
    renderHelpSection("Test / edge cases", entry.test_edge_cases),
    renderHelpSection("Behavior notes", entry.notes),
  ]
    .filter(Boolean)
    .join("\n");
}

function renderTopLevelHelp(payload) {
  const workflows = payload.common_workflows.map(
    (item) => `${item.label}:\n    ${item.command}`,
  );
  const commands = payload.commands.map((command) => {
    const summary = HELP_CATALOG[command]?.summary || "";
    return summary ? `${command.padEnd(14)} ${summary}` : command;
  });
  return [
    "Helm Tasks - local scheduler for non-interactive agent/CLI work",
    "",
    `Usage:\n  ${payload.usage}`,
    "",
    renderHelpSection("Common workflows", workflows),
    "",
    renderHelpSection("Core commands", commands),
    "",
    payload.notes.join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

function printHelp(command, json = false) {
  const payload = helpPayload(command);
  if (json) {
    output("help", true, payload, [], false);
    return;
  }
  process.stdout.write(
    command ? renderCommandHelp(payload) : renderTopLevelHelp(payload),
  );
  process.stdout.write("\n");
}

function helpCommandName(positionals) {
  if (positionals.length === 0) return null;
  return commandName(positionals).replace(".", " ");
}

function failValidation(cmd, raw, scope, errors, pretty) {
  fail(
    cmd,
    "validation_failed",
    "job validation failed",
    withScope(scope, {
      validation_errors: errors,
      validation_diagnostics: validationDiagnostics(raw, errors),
    }),
    pretty,
  );
}

function withScope(scope, data = {}) {
  return {
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    storage_root: scope.storage_root,
    ...data,
  };
}

function normalizeDevDaemonName(name) {
  const value = String(name || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value)) {
    const err = new Error(
      "dev-daemon --name must start with a letter or number and contain only letters, numbers, dots, underscores, or dashes",
    );
    err.code = "invalid_dev_daemon_name";
    err.exitCode = 2;
    throw err;
  }
  return value;
}

function devDaemonHome(name) {
  return join(homedir(), `.helm-dev-${name}`);
}

function devDaemonConfigPath(name) {
  return join(devDaemonHome(name), "service", "dev-daemon.json");
}

function readDevDaemonConfig(name) {
  return readJsonIfExists(devDaemonConfigPath(name), null);
}

function devDaemonEnv(name, port) {
  return {
    HELM_HOME: devDaemonHome(name),
    HELM_DEV_DAEMON_NAME: name,
    HELM_STATUS_PORT: String(port),
  };
}

async function allocateDevStatusPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = Number(address?.port);
      server.close(() => {
        if (Number.isFinite(port) && port !== PRODUCTION_STATUS_PORT) {
          resolvePort(port);
        } else {
          rejectPort(
            new Error("failed to allocate non-production status port"),
          );
        }
      });
    });
  });
}

async function resolveDevDaemonPort(
  flags,
  { name, requireExisting = false } = {},
) {
  if (flags.port !== undefined && flags.port !== true) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      const err = new Error("dev-daemon --port must be a valid TCP port");
      err.code = "invalid_dev_daemon_port";
      err.exitCode = 2;
      throw err;
    }
    if (port === PRODUCTION_STATUS_PORT) {
      const err = new Error(
        `dev-daemon refuses to use production status port ${PRODUCTION_STATUS_PORT}`,
      );
      err.code = "dev_daemon_uses_production_port";
      err.exitCode = 1;
      throw err;
    }
    return port;
  }
  if (requireExisting) {
    const configured = Number(readDevDaemonConfig(name)?.status_port);
    return Number.isInteger(configured) && configured > 0 ? configured : null;
  }
  return allocateDevStatusPort();
}

async function runWithDevDaemonEnvironment({ name, port }, fn) {
  const previous = {
    HELM_HOME: process.env.HELM_HOME,
    HELM_DEV_DAEMON_NAME: process.env.HELM_DEV_DAEMON_NAME,
    HELM_STATUS_PORT: process.env.HELM_STATUS_PORT,
  };
  const next = devDaemonEnv(name, port);
  process.env.HELM_HOME = next.HELM_HOME;
  process.env.HELM_DEV_DAEMON_NAME = next.HELM_DEV_DAEMON_NAME;
  process.env.HELM_STATUS_PORT = next.HELM_STATUS_PORT;
  try {
    return await fn(next);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function hasFlag(flags, name) {
  return Object.prototype.hasOwnProperty.call(flags, name);
}

function runtimeStoreObservation(runtimeStoreLockPath) {
  const lockPath = runtimeStoreLockPath();
  if (!existsSync(lockPath)) {
    return {
      status: "ok",
      reason: "runtime_store_available",
      lock_path: lockPath,
    };
  }
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    lock = {};
  }
  return {
    status: "degraded",
    reason: "runtime_store_locked",
    lock_path: lockPath,
    owner: lock.owner || null,
    holder_pid: lock.holder_pid || null,
    acquired_at: lock.acquired_at || null,
  };
}

async function readRuntimeControlState() {
  const {
    checkHelmHomeSafety,
    readDesiredState,
    readOutboundState,
    runtimeStoreLockPath,
    runtimeStoreCompatibilityContract,
  } = await import("./lib/runtime_store.mjs");
  return {
    desired_state: readDesiredState({ initialize: false }),
    outbound_state: readOutboundState({ initialize: false }),
    helm_home_safety: checkHelmHomeSafety(),
    runtime_store_observation: runtimeStoreObservation(runtimeStoreLockPath),
    runtime_store_compatibility: runtimeStoreCompatibilityContract(),
  };
}

async function assertSchedulerStartAllowed() {
  const { assertDesiredStateAllowsStart, assertHelmHomeSafe } = await import(
    "./lib/runtime_store.mjs"
  );
  const desiredState = assertDesiredStateAllowsStart({ initialize: false });
  const helmHomeSafety = assertHelmHomeSafe();
  return { desiredState, helmHomeSafety };
}

function failDesiredStateBlocked(command, err, scope, pretty) {
  fail(
    command,
    err?.code || "desired_state_blocked",
    err?.message || "desired state blocks scheduler start or dispatch",
    withScope(scope, err?.details || {}),
    pretty,
  );
}

function activationFailureDetails(scope, err) {
  return withScope(scope, {
    ...(err?.details || {}),
    repair: repairCommands(scope),
  });
}

function scopeArgs(scope) {
  return ["--cwd", scope.cwd];
}

function repairCommands(scope) {
  return {
    service_status:
      `node ${process.argv[1]} service status --deep ${scopeArgs(scope).join(" ")}`.trim(),
    ensure:
      `node ${process.argv[1]} ensure ${scopeArgs(scope).join(" ")}`.trim(),
    restart: `node ${process.argv[1]} service restart`.trim(),
  };
}

function validateRawJobInput(cmd, raw, scope, pretty) {
  const job = normalizeJob(raw, scope);
  const validation = validateJob(job, { scope });
  if (!validation.valid) {
    failValidation(cmd, raw, scope, validation.errors, pretty);
    process.exit(2);
  }
  return job;
}

async function ensureActivation(scope, schedulerScriptPath) {
  await assertSchedulerStartAllowed();
  return runActivation(scope, { schedulerScriptPath, repairCommands });
}

function activationWithJobFields(activation, job) {
  return {
    ...activation,
    next_run_at: job?.state?.next_run_at || job?.schedule?.start_at || null,
  };
}

function hasCommand(name) {
  const r = spawnSync("sh", ["-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  return r.status === 0;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadStdinJson() {
  const raw = readFileSync(0, "utf8");
  return JSON.parse(raw);
}

function splitCsv(input) {
  return String(input || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractJobDefinition(job) {
  const definition = { ...job };
  delete definition.lifecycle_status;
  delete definition.active_run;
  delete definition.next_run_at;
  delete definition.last_error;
  delete definition.consecutive_failures;
  delete definition.last_retry_count;
  delete definition.last_run;
  delete definition.state;
  delete definition.meta;
  return definition;
}

function parseJsonFlag(flagName, raw, kind) {
  try {
    const parsed = JSON.parse(raw);
    if (kind === "array" && !Array.isArray(parsed)) {
      throw new Error(`${flagName} must decode to a JSON array`);
    }
    if (kind === "object" && !isPlainObject(parsed)) {
      throw new Error(`${flagName} must decode to a JSON object`);
    }
    return parsed;
  } catch (err) {
    throw new Error(err.message || `${flagName} must be valid JSON`);
  }
}

function parseJsonValueFlag(flagName, raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(err.message || `${flagName} must be valid JSON`);
  }
}

function buildProcessFromFlags(flags, scope, trailingArgs = []) {
  if (trailingArgs.length > 0 && flags["args-json"]) {
    throw new Error(
      "Use either -- or --args-json to specify command arguments, not both.",
    );
  }
  if (trailingArgs.length > 0 && !flags.command) {
    throw new Error(
      "-- requires --command to specify which command receives the arguments.",
    );
  }

  const processSpec = {};

  if (flags.command) processSpec.command = flags.command;
  if (trailingArgs.length > 0) {
    processSpec.args = trailingArgs;
  } else if (flags["args-json"]) {
    processSpec.args = parseJsonFlag(
      "--args-json",
      flags["args-json"],
      "array",
    );
  }
  if (flags["stdin-text"] !== undefined)
    processSpec.stdin = flags["stdin-text"];
  if (flags["stdin-file"])
    processSpec.stdin_file = resolve(scope.cwd, flags["stdin-file"]);
  if (flags["process-cwd"])
    processSpec.cwd = resolve(scope.cwd, flags["process-cwd"]);
  if (flags["env-json"])
    processSpec.env = parseJsonFlag("--env-json", flags["env-json"], "object");

  return Object.keys(processSpec).length > 0 ? processSpec : null;
}

function buildExecutionHintsFromFlags(flags) {
  const hints = {};
  if (flags.model !== undefined)
    hints.model = flags.model === "null" ? null : flags.model;
  if (flags["max-turns"] !== undefined)
    hints.max_turns = Number(flags["max-turns"]);
  if (flags.provider !== undefined)
    hints.provider = flags.provider === "null" ? null : flags.provider;
  const providerConfig = {};
  if (flags["academy-agent"] !== undefined)
    providerConfig.academy_agent =
      flags["academy-agent"] === "null" ? null : flags["academy-agent"];
  if (flags["academy-runtime"] !== undefined)
    providerConfig.academy_runtime =
      flags["academy-runtime"] === "null" ? null : flags["academy-runtime"];
  if (Object.keys(providerConfig).length > 0)
    hints.provider_config = providerConfig;
  if (flags.unmanaged !== undefined) {
    hints.unmanaged =
      flags.unmanaged === true ? true : String(flags.unmanaged) === "true";
  }
  if (flags["session-required"] !== undefined) {
    hints.session_required =
      flags["session-required"] === true
        ? true
        : String(flags["session-required"]) === "true";
  }
  if (flags["output-format"] !== undefined)
    hints.output_format =
      flags["output-format"] === "null" ? null : flags["output-format"];
  if (flags["non-interactive"] !== undefined) {
    hints.non_interactive =
      flags["non-interactive"] === true
        ? true
        : String(flags["non-interactive"]) === "true";
  }
  return Object.keys(hints).length > 0 ? hints : null;
}

function memoryModeFromFlags(flags) {
  if (flags["no-memory"] !== undefined) return "off";
  if (flags.memory !== undefined) return String(flags.memory);
  return null;
}

function isValidMemoryMode(mode) {
  return mode === "read+write" || mode === "off";
}

function applyMemoryFlags(input, flags) {
  const mode = memoryModeFromFlags(flags);
  if (!mode) return input;
  return {
    ...(input || {}),
    memory: {
      ...((input && typeof input.memory === "object" && input.memory) || {}),
      mode,
    },
  };
}

function buildJobFromFlags(flags, scope, partial = false, trailingArgs = []) {
  const out = {};

  if (!partial || flags.id) out.id = flags.id;
  if (flags.name) out.name = flags.name;
  const processSpec = buildProcessFromFlags(flags, scope, trailingArgs);
  if (processSpec) out.process = processSpec;

  if (flags.prompt || flags["prompt-file"]) {
    out.prompt = {};
    if (flags.prompt) {
      out.prompt.type = "inline";
      out.prompt.value = flags.prompt;
    }
    if (flags["prompt-file"]) {
      out.prompt.type = "file";
      out.prompt.path = flags["prompt-file"];
      out.prompt.relative_to = flags["prompt-relative-to"] || "cwd";
    }
  }

  const schedule = buildScheduleFromFlags(flags);
  if (schedule) out.schedule = schedule;

  const notify = {};
  if (flags["notify-on"]) notify.on = flags["notify-on"];
  if (flags["notify-channels"])
    notify.channels = splitCsv(flags["notify-channels"]);
  if (flags["notify-file"]) notify.file_path = flags["notify-file"];
  if (flags["notify-webhook-env"])
    notify.webhook_url_env = flags["notify-webhook-env"];
  if (flags["notify-webhook-body-key"])
    notify.webhook_body_key = flags["notify-webhook-body-key"];
  if (flags["notify-webhook-template-json"])
    notify.webhook_template = parseJsonValueFlag(
      "--notify-webhook-template-json",
      flags["notify-webhook-template-json"],
    );
  if (flags["notify-on-consecutive-failures"])
    notify.on_consecutive_failures = Number(
      flags["notify-on-consecutive-failures"],
    );
  if (Object.keys(notify).length > 0) out.notify = notify;

  const hints = buildExecutionHintsFromFlags(flags);
  if (hints) {
    out.execution_hints = hints;
    out.execution = {
      model: hints.model ?? null,
      max_turns: hints.max_turns ?? null,
      timeout_sec: null,
    };
  }

  if (flags["timeout-sec"] !== undefined) {
    out.limits = {
      timeout_sec:
        flags["timeout-sec"] === "null" ? null : Number(flags["timeout-sec"]),
    };
    out.execution = {
      ...(out.execution || {}),
      timeout_sec: out.limits.timeout_sec,
    };
  }

  const memoryMode = memoryModeFromFlags(flags);
  if (memoryMode) out.memory = { mode: memoryMode };

  if (flags["metadata-json"])
    out.metadata = parseJsonFlag(
      "--metadata-json",
      flags["metadata-json"],
      "object",
    );

  if (flags.tags) out.tags = splitCsv(flags.tags);

  const retry = {};
  if (flags["retry-max"] !== undefined)
    retry.max_attempts = Number(flags["retry-max"]);
  if (flags["retry-backoff"] !== undefined)
    retry.backoff = flags["retry-backoff"];
  if (flags["retry-delay-sec"] !== undefined)
    retry.delay_sec = Number(flags["retry-delay-sec"]);
  if (Object.keys(retry).length > 0) out.retry = retry;

  const conditions = {};
  if (flags["condition-file-exists"])
    conditions.file_exists = resolve(scope.cwd, flags["condition-file-exists"]);
  if (flags["condition-env-set"])
    conditions.env_set = flags["condition-env-set"];
  if (Object.keys(conditions).length > 0) out.conditions = conditions;

  return out;
}

function resolveInputObject(flags, scope, partial = false, trailingArgs = []) {
  if (
    trailingArgs.length > 0 &&
    (flags["job-file"] || flags["patch-file"] || flags.stdin)
  ) {
    throw new Error(
      "-- cannot be combined with --job-file, --patch-file, or --stdin.",
    );
  }
  if (flags["job-file"]) {
    return applyMemoryFlags(loadJson(resolve(flags["job-file"])), flags);
  }
  if (flags["patch-file"]) {
    return applyMemoryFlags(loadJson(resolve(flags["patch-file"])), flags);
  }
  if (flags.stdin) {
    return applyMemoryFlags(loadStdinJson(), flags);
  }
  return applyMemoryFlags(
    buildJobFromFlags(flags, scope, partial, trailingArgs),
    flags,
  );
}

function selectedLogStream(flags) {
  if (flags.stdout && flags.stderr) {
    throw Object.assign(new Error("choose only one of --stdout or --stderr"), {
      code: "invalid_flags",
      exitCode: 2,
    });
  }
  return flags.stderr ? "stderr" : "stdout";
}

function writeFileRange(path, offset, endOffset, target = process.stdout) {
  if (endOffset <= offset) return offset;
  const fd = openSync(path, "r");
  try {
    let nextOffset = offset;
    while (nextOffset < endOffset) {
      const chunkSize = Math.min(65536, endOffset - nextOffset);
      const buffer = Buffer.alloc(chunkSize);
      const bytesRead = readSync(fd, buffer, 0, chunkSize, nextOffset);
      if (bytesRead <= 0) break;
      target.write(buffer.subarray(0, bytesRead));
      nextOffset += bytesRead;
    }
    return nextOffset;
  } finally {
    closeSync(fd);
  }
}

async function streamLogFile(path, opts = {}) {
  const follow = Boolean(opts.follow);
  const pid = opts.pid || null;
  let offset = 0;
  let sawFile = false;

  for (;;) {
    if (existsSync(path)) {
      sawFile = true;
      const size = statSync(path).size;
      if (size > offset) {
        offset = writeFileRange(
          path,
          offset,
          size,
          opts.target || process.stdout,
        );
      }
    }

    if (!follow) return { sawFile };

    const alive = pid ? isProcessAlive(pid) : false;

    if (!alive && sawFile) return { sawFile };
    // eslint-disable-next-line no-await-in-loop
    await sleep(Number(opts.pollMs || 100));
  }
}

function parseWatchLevels(raw) {
  if (!raw) return new Set(["info", "error"]);
  return new Set(splitCsv(raw));
}

function parseNonNegativeLimit(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw Object.assign(new Error("--limit must be a non-negative number"), {
      code: "invalid_flags",
      exitCode: 2,
    });
  }
  return Math.floor(value);
}

async function watchActivityStream(opts = {}) {
  const levels = parseWatchLevels(opts.level);
  const backlogLimit = parseNonNegativeLimit(opts.limit, 20);
  const filters = {
    scopeId: opts.scopeId || null,
    jobId: opts.jobId || null,
    levels,
  };
  const seen = new Set();
  const path = publicEventsPath();
  let offset = publicEventsFileSize();
  let remainder = "";

  const formatWatchLine = (event) =>
    event.message || `${event.ts} ${event.action}`;

  if (backlogLimit > 0) {
    const backlog = loadPublicEvents(backlogLimit, filters);
    for (const event of backlog) {
      seen.add(event.id);
      const line = opts.json ? JSON.stringify(event) : formatWatchLine(event);
      (opts.target || process.stdout).write(`${line}\n`);
    }
    offset = publicEventsFileSize();
  }

  for (;;) {
    if (!existsSync(path)) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(Number(opts.pollMs || 100));
      continue;
    }

    const size = statSync(path).size;
    if (size > offset) {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        readSync(fd, buffer, 0, size - offset, offset);
        offset = size;
        const text = remainder + buffer.toString("utf8");
        const lines = text.split("\n");
        remainder = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (seen.has(event.id)) continue;
          if (filters.scopeId && event.scope_id !== filters.scopeId) continue;
          if (filters.jobId && event.job_id !== filters.jobId) continue;
          if (event.level && !levels.has(event.level)) continue;
          seen.add(event.id);
          const rendered = opts.json
            ? JSON.stringify(event)
            : formatWatchLine(event);
          (opts.target || process.stdout).write(`${rendered}\n`);
        }
      } finally {
        closeSync(fd);
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(Number(opts.pollMs || 100));
  }
}

async function run() {
  const { positionals, flags, trailingArgs } = parseArgs(process.argv.slice(2));
  const rawCmd = commandName(positionals);
  const cmd = rawCmd === "run" ? "run-now" : rawCmd;
  const pretty = Boolean(flags.pretty);
  const jsonOnly = Boolean(flags["json-only"]);
  const schedulerScriptPath = process.argv[1];
  const helpRequested = Boolean(
    flags.help || flags["help-json"] || rawCmd === "help",
  );
  const helpJson = Boolean(
    flags["help-json"] || (rawCmd === "help" && flags.json),
  );

  if (helpRequested) {
    let target =
      rawCmd === "help"
        ? helpCommandName(positionals.slice(1))
        : cmd
          ? cmd === "run-now" && rawCmd === "run"
            ? "run"
            : rawCmd.replace(".", " ")
          : null;
    if (positionals[0] === "skills" && positionals[1] === "refresh")
      target = "skills refresh";
    printHelp(target, helpJson);
    if (target && !helpPayload(target).error) return;
    if (!target) return;
    process.exitCode = 2;
    return;
  }

  if (!cmd) {
    printHelp(null, false);
    return;
  }

  // Runs before scope resolution: it works on the explicit --to home only and
  // must not resolve, create, or write the default Helm home.
  if (cmd === "system.migrate-home") {
    const {
      MIGRATE_HOME_COMMAND,
      MigrateHomeError,
      migrateHelmHome,
    } = await import("./lib/migrate_home.mjs");
    try {
      const data = migrateHelmHome({
        from: typeof flags.from === "string" ? flags.from : undefined,
        to: typeof flags.to === "string" ? flags.to : undefined,
        dryRun: Boolean(flags["dry-run"]),
      });
      output(MIGRATE_HOME_COMMAND, true, data, [], pretty);
    } catch (err) {
      const known = err instanceof MigrateHomeError;
      fail(
        MIGRATE_HOME_COMMAND,
        known ? err.code : "migrate_home_failed",
        String(err?.message || err),
        known ? err.details : { stack: err?.stack || "" },
        pretty,
      );
      process.exit(known ? err.exitCode : 1);
    }
    return;
  }

  const scope = resolveScope({
    cwd:
      flags.scope || flags.cwd || process.env.HELM_SCOPE_CWD || process.cwd(),
  });

  if (cmd === "notify-test") {
    const fakeJob = {
      notify: {
        on: "both",
        channels: [flags.channel || "stdout"],
        file_path: flags["file-path"] || null,
        webhook_url_env:
          flags["webhook-url-env"] || flags["webhook-env"] || null,
        webhook_body_key: flags["notify-webhook-body-key"] || null,
        webhook_template: flags["notify-webhook-template-json"]
          ? parseJsonValueFlag(
              "--notify-webhook-template-json",
              flags["notify-webhook-template-json"],
            )
          : null,
      },
    };
    const event = {
      event_type: "job_run_completed",
      job_id: "notify-test",
      run_id: `run_${Date.now()}`,
      status: "success",
      started_at: nowIso(),
      finished_at: nowIso(),
      duration_ms: 1,
      summary: "notification test",
      error: null,
      metadata: flags["metadata-json"]
        ? parseJsonFlag("--metadata-json", flags["metadata-json"], "object")
        : {},
    };
    const results = await emitNotifications(fakeJob, event, { jsonOnly });
    output("notify-test", true, withScope(scope, { results }), [], pretty);
    return;
  }

  if (cmd === "migrate") {
    try {
      const { runRuntimeMigrations } = await import(
        "./lib/runtime_migrations.mjs"
      );
      const result = runRuntimeMigrations({
        dryRun: Boolean(flags["dry-run"]),
      });
      output(cmd, true, withScope(scope, result), [], pretty);
    } catch (err) {
      fail(
        cmd,
        err?.code || "runtime_migration_failed",
        err?.message || "runtime migration failed",
        withScope(scope, err?.details || {}),
        pretty,
      );
      process.exit(1);
    }
    return;
  }

  if (cmd === "desired-state") {
    const sub = positionals[1] || "get";
    try {
      const {
        readDesiredState,
        readOutboundState,
        setDesiredState,
        setOutboundMode,
      } = await import("./lib/runtime_store.mjs");

      if (sub === "get") {
        output(
          cmd,
          true,
          withScope(scope, {
            desired_state: readDesiredState({ initialize: false }),
            outbound_state: readOutboundState({ initialize: false }),
          }),
          [],
          pretty,
        );
        return;
      }

      if (sub !== "set") {
        fail(
          cmd,
          "unknown_subcommand",
          `unknown desired-state subcommand '${sub}'`,
          withScope(scope, { supported: ["get", "set"] }),
          pretty,
        );
        process.exit(2);
        return;
      }

      const updatesDesired =
        hasFlag(flags, "mode") || hasFlag(flags, "lockout");
      const updatesOutbound = hasFlag(flags, "outbound-mode");
      if (!updatesDesired && !updatesOutbound) {
        fail(
          cmd,
          "missing_flag",
          "desired-state set requires --mode, --lockout, or --outbound-mode",
          withScope(scope),
          pretty,
        );
        process.exit(2);
        return;
      }

      let desiredState = readDesiredState({ initialize: false });
      let outboundState = readOutboundState({ initialize: false });
      if (updatesDesired) {
        desiredState = setDesiredState({
          mode: flags.mode || desiredState.mode,
          lockout: hasFlag(flags, "lockout")
            ? flags.lockout
            : desiredState.lockout,
          reason: flags.reason || null,
        });
      }
      if (updatesOutbound) {
        outboundState = setOutboundMode({ mode: flags["outbound-mode"] });
      }

      output(
        cmd,
        true,
        withScope(scope, {
          desired_state: desiredState,
          outbound_state: outboundState,
        }),
        [],
        pretty,
      );
    } catch (err) {
      fail(
        cmd,
        err?.code || "desired_state_failed",
        err?.message || "desired-state command failed",
        withScope(scope, err?.details || {}),
        pretty,
      );
      process.exit(1);
    }
    return;
  }

  if (cmd === "scopes") {
    const sub = positionals[1] || "list";
    try {
      const registry = await import("./lib/scope_registry_v2.mjs");
      const scopeId = flags["scope-id"] || flags.scope || scope.scope_id;
      let result;
      if (sub === "list" || sub === "status") {
        result = registry.listScopeRegistryV2();
      } else if (sub === "reconcile") {
        result = registry.migrateScopesJsonToRegistryV2({
          actor: flags.actor || "cli",
          reason: flags.reason || "scopes_reconcile",
        });
      } else if (sub === "enable") {
        result = registry.setScopeDispatchState({
          scopeId,
          dispatchState: "enabled",
          actor: flags.actor || "cli",
          reason: flags.reason,
        });
      } else if (sub === "disable") {
        result = registry.setScopeDispatchState({
          scopeId,
          dispatchState: "disabled",
          actor: flags.actor || "cli",
          reason: flags.reason,
        });
      } else if (sub === "quarantine") {
        result = registry.setScopeQuarantineState({
          scopeId,
          quarantined: true,
          actor: flags.actor || "cli",
          reason: flags.reason,
        });
      } else if (sub === "unquarantine") {
        result = registry.setScopeQuarantineState({
          scopeId,
          quarantined: false,
          actor: flags.actor || "cli",
          reason: flags.reason,
        });
      } else if (sub === "explain") {
        result = registry.explainScopeRegistryV2({ scopeId });
      } else {
        fail(
          cmd,
          "unknown_subcommand",
          `unknown scopes subcommand '${sub}'`,
          withScope(scope, {
            supported: [
              "list",
              "status",
              "reconcile",
              "enable",
              "disable",
              "quarantine",
              "unquarantine",
              "explain",
            ],
          }),
          pretty,
        );
        process.exit(2);
        return;
      }
      output(cmd, true, withScope(scope, { registry: result }), [], pretty);
    } catch (err) {
      fail(
        cmd,
        err?.code || "scope_registry_failed",
        err?.message || "scope registry command failed",
        withScope(scope, err?.details || {}),
        pretty,
      );
      process.exit(err?.exitCode || 1);
    }
    return;
  }

  if (cmd === "check.network") {
    const host = flags.host ? String(flags.host) : null;
    const timeoutSec =
      flags["timeout-sec"] !== undefined ? Number(flags["timeout-sec"]) : null;
    const probe = await probeNetwork({
      hosts: host ? [host] : undefined,
      timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
    });
    output("check.network", probe.online, probe, [], pretty);
    if (!probe.online) process.exitCode = 1;
    return;
  }

  if (cmd === "doctor") {
    const runtimeRoot = scopeRuntimeRoot(scope);
    const localHelmDir = join(scope.cwd, ".helm");

    const cofounder_checks = await runCofounderChecks({ scope });
    const gatingCofounderChecks = new Set([
      "node_version_ok",
      "helm_home_writable",
    ]);
    let cofounder_failed = false;
    for (const [k, v] of Object.entries(cofounder_checks)) {
      if (gatingCofounderChecks.has(k) && v === false) cofounder_failed = true;
    }

    const bandsRequested = DOCTOR_BAND_FLAGS.filter((b) => flags[b]);
    const deep = Boolean(flags.deep) || bandsRequested.length > 0;
    const selectedBands = bandsRequested.length > 0 ? bandsRequested : null;

    const checkFlag = typeof flags.check === "string" ? flags.check : null;

    if (checkFlag) {
      const legacyAllowed = {
        "node-version": "node_version_ok",
        "helm-home": "helm_home_writable",
        identity: "identity_present",
        "workspaces-root": "workspaces_root_readable",
        "claude-permission": "claude_permission_posture",
      };
      if (Object.prototype.hasOwnProperty.call(legacyAllowed, checkFlag)) {
        const target = legacyAllowed[checkFlag];
        const value = cofounder_checks[target];
        const ok = value !== false;
        output(
          "doctor",
          ok,
          withScope(scope, { check: checkFlag, value }),
          [],
          pretty,
        );
        if (!ok) process.exitCode = 1;
        return;
      }
      const deepNames = new Set(DOCTOR_CHECKS.map((c) => c.name));
      if (deepNames.has(checkFlag)) {
        const single = await runSingleCheck(checkFlag, { scope });
        const ok = single.ok !== false;
        output(
          "doctor",
          ok,
          withScope(scope, { check: checkFlag, result: single.result }),
          [],
          pretty,
        );
        if (!ok) process.exitCode = 1;
        return;
      }
      const supported = [...Object.keys(legacyAllowed), ...deepNames];
      fail(
        "doctor",
        "invalid_check_flag",
        `unknown --check ${checkFlag}; supported: ${supported.join(", ")}`,
        withScope(scope, { supported }),
        pretty,
      );
      process.exit(2);
    }

    let behavior = null;
    let deepFailing = [];
    if (deep) {
      const deepResult = await runDeepDoctor({ bands: selectedBands, scope });
      behavior = deepResult.behavior;
      deepFailing = Array.isArray(deepResult.failing_checks)
        ? deepResult.failing_checks
        : [];
    }
    const controlState = await readRuntimeControlState();

    const checks = {
      storage_root: scope.storage_root,
      runtime_workspace_root: runtimeRoot,
      helm_home_safety: controlState.helm_home_safety,
      scope_cwd: scope.cwd,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      node: process.version,
      claude_available: hasCommand("claude"),
      codex_available: hasCommand("codex"),
      gemini_available: hasCommand("gemini"),
      droid_available: hasCommand("droid"),
      service: serviceStatusWithBehavior(schedulerScriptPath),
      registered_scopes: listRegisteredScopes().length,
      local_runtime_legacy: {
        runs: existsSync(join(localHelmDir, "runs")),
        runtime: existsSync(join(localHelmDir, "runtime.json")),
        active_runs: existsSync(join(localHelmDir, "active-runs.json")),
        locks: existsSync(join(localHelmDir, "locks")),
        heartbeat: existsSync(join(localHelmDir, "heartbeat.json")),
        logs: existsSync(join(localHelmDir, "logs")),
      },
      git_exclude_has_helm: (() => {
        const excludePath = join(scope.cwd, ".git", "info", "exclude");
        if (!existsSync(excludePath)) return false;
        return readFileSync(excludePath, "utf8")
          .split("\n")
          .some((line) => line.trim() === ".helm/");
      })(),
      cofounder_checks,
      deep,
      behavior,
    };

    const ok = !cofounder_failed && deepFailing.length === 0;
    const envelope = { ...withScope(scope, checks) };
    if (deep && deepFailing.length > 0) {
      envelope.failing_checks = deepFailing;
      envelope.failing_check_hints = deepFailing.reduce((acc, name) => {
        acc[name] = doctorHintFor(name);
        return acc;
      }, {});
    }
    output("doctor", ok, envelope, [], pretty);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (cmd === "watch") {
    try {
      await watchActivityStream({
        limit: flags.limit,
        json: Boolean(flags.json),
        scopeId: flags["scope-id"] || null,
        jobId: flags["job-id"] || null,
        level: flags.level,
      });
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        { helm_home: helmHome() },
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    return;
  }

  if (cmd.startsWith("dev-daemon.")) {
    const sub = cmd.slice("dev-daemon.".length);
    const supported = ["up", "status", "down"];
    if (!supported.includes(sub)) {
      fail(
        cmd,
        "unknown_subcommand",
        `unknown dev-daemon subcommand '${sub}'`,
        withScope(scope, { supported }),
        pretty,
      );
      process.exit(2);
      return;
    }
    let name;
    let port = null;
    try {
      name = normalizeDevDaemonName(flags.name);
      port = await resolveDevDaemonPort(flags, {
        name,
        requireExisting: sub !== "up",
      });
    } catch (err) {
      fail(
        cmd,
        err.code || "invalid_dev_daemon",
        String(err.message || err),
        withScope(scope, {
          production_status_port: PRODUCTION_STATUS_PORT,
        }),
        pretty,
      );
      process.exit(err.exitCode || 1);
      return;
    }
    await runWithDevDaemonEnvironment(
      { name, port: port === null ? 0 : port },
      async (env) => {
        try {
          if (sub === "up") {
            const { setDesiredState } = await import("./lib/runtime_store.mjs");
            const desired_state = setDesiredState({
              home: env.HELM_HOME,
              mode: "live",
              lockout: null,
              reason: "dev-daemon up",
            });
            writeJsonAtomic(devDaemonConfigPath(name), {
              version: "1.0",
              name,
              helm_home: env.HELM_HOME,
              label: `ai.helm.scheduler.dev.${name}`,
              status_port: Number(env.HELM_STATUS_PORT),
              updated_at: nowIso(),
            });
            let service = serviceStatus(schedulerScriptPath);
            if (!service.installed) {
              service = serviceInstall(schedulerScriptPath);
            }
            if (!service.running) service = serviceStart(schedulerScriptPath);
            output(
              cmd,
              true,
              withScope(scope, {
                dev_daemon: {
                  name,
                  helm_home: env.HELM_HOME,
                  label: service.label,
                  status_port: Number(env.HELM_STATUS_PORT),
                  logs: service.logs,
                  desired_state,
                },
                service,
              }),
              [],
              pretty,
            );
            return;
          }
          if (sub === "status") {
            const service = serviceStatus(schedulerScriptPath);
            output(
              cmd,
              true,
              withScope(scope, {
                dev_daemon: {
                  name,
                  helm_home: env.HELM_HOME,
                  label: service.label,
                  status_port: port,
                  logs: service.logs,
                },
                service,
              }),
              [],
              pretty,
            );
            return;
          }
          const service = serviceUninstall(schedulerScriptPath);
          output(
            cmd,
            true,
            withScope(scope, {
              dev_daemon: {
                name,
                helm_home: env.HELM_HOME,
                label: service.label,
                status_port: port,
                logs: service.logs,
              },
              service,
            }),
            [],
            pretty,
          );
        } catch (err) {
          fail(
            cmd,
            err.code || "dev_daemon_failed",
            String(err.message || err),
            withScope(scope, err.details || {}),
            pretty,
          );
          process.exit(err.exitCode || 1);
        }
      },
    );
    return;
  }

  if (cmd === "service.install") {
    output(
      cmd,
      true,
      withScope(scope, { service: serviceInstall(schedulerScriptPath) }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "service.start") {
    try {
      await assertSchedulerStartAllowed();
    } catch (err) {
      failDesiredStateBlocked(cmd, err, scope, pretty);
      process.exit(1);
    }
    output(
      cmd,
      true,
      withScope(scope, { service: serviceStart(schedulerScriptPath) }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "service.stop") {
    output(
      cmd,
      true,
      withScope(scope, { service: serviceStop(schedulerScriptPath) }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "service.restart") {
    try {
      await assertSchedulerStartAllowed();
    } catch (err) {
      failDesiredStateBlocked(cmd, err, scope, pretty);
      process.exit(1);
    }
    const restartSafety = serviceRestartSafetyReport(scope);
    if (restartSafety.ignored_active_runs.length > 0) {
      process.stderr.write(
        `[🪳 TEMP RESTART] service restart ignoring caller-owned active runs count=${restartSafety.ignored_active_runs.length}\n`,
      );
    }
    if (restartSafety.active_runs.length > 0 && !flags.force) {
      fail(
        cmd,
        "active_runs_in_progress",
        "refusing to restart Helm daemon while active runs are still live; retry with --force to override",
        withScope(scope, {
          active_runs: restartSafety.active_runs,
          hint: `wait for active runs to finish or use ${TASKS_COMMAND} service restart --force`,
        }),
        pretty,
      );
      process.exit(1);
    }
    output(
      cmd,
      true,
      withScope(scope, {
        service: serviceRestart(schedulerScriptPath),
        restart_safety: {
          forced: Boolean(flags.force),
          ...restartSafety,
        },
      }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "system.update" || cmd === "service.update") {
    try {
      await assertSchedulerStartAllowed();
    } catch (err) {
      failDesiredStateBlocked(cmd, err, scope, pretty);
      process.exit(1);
    }
    const restartSafety = serviceRestartSafetyReport(scope);
    if (restartSafety.ignored_active_runs.length > 0) {
      process.stderr.write(
        `[🪳 TEMP UPDATE] service update ignoring caller-owned active runs count=${restartSafety.ignored_active_runs.length}\n`,
      );
    }
    if (restartSafety.active_runs.length > 0 && !flags.force) {
      fail(
        cmd,
        "active_runs_in_progress",
        "refusing to update Helm services while active runs are still live; retry with --force to override",
        withScope(scope, {
          active_runs: restartSafety.active_runs,
          hint: `wait for active runs to finish or use ${TASKS_COMMAND} system update --force`,
        }),
        pretty,
      );
      process.exit(1);
    }

    const service_install = serviceInstall(schedulerScriptPath);
    const service = serviceRestart(schedulerScriptPath);
    const sentinel_install = sentinelInstall(schedulerScriptPath);
    const sentinel_stop = sentinelStop();
    const sentinel = sentinelStart(schedulerScriptPath);
    output(
      cmd,
      true,
      withScope(scope, {
        service,
        service_install,
        sentinel,
        sentinel_install,
        sentinel_stop,
        restart_safety: {
          forced: Boolean(flags.force),
          ...restartSafety,
        },
      }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "service.uninstall") {
    output(
      cmd,
      true,
      withScope(scope, { service: serviceUninstall(schedulerScriptPath) }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "service.status") {
    const service = serviceStatus(schedulerScriptPath, {
      includeMemoryDetails: Boolean(flags.deep),
      includeProcessTree: Boolean(flags.deep),
    });
    const controlState = await readRuntimeControlState();
    const runtime = loadRuntime(scope);
    const registryEntry =
      listRegisteredScopes().find(
        (entry) => entry.scope_id === scope.scope_id,
      ) || null;
    const runtimeHealth = flags.deep
      ? workspaceStatusData({
          scope,
          jobs: loadJobsReadOnly(scope),
          runEvents: workspaceRunEvents(scope, 5000),
          runtime,
          registryEntry,
          schedulerScriptPath,
        }).health
      : null;
    const health = runtimeHealth;
    const data = withScope(scope, {
      service,
      runtime,
      health,
      ...controlState,
    });
    if (flags.deep && !health.healthy) {
      fail(
        cmd,
        "runtime_unhealthy",
        `scheduler runtime unhealthy: ${health.reason}`,
        { ...data, repair: repairCommands(scope) },
        pretty,
      );
      process.exit(1);
    }
    output(cmd, true, data, [], pretty);
    return;
  }

  if (cmd === "sentinel.install") {
    output(
      cmd,
      true,
      withScope(scope, { sentinel: sentinelInstall(schedulerScriptPath) }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "sentinel.start") {
    output(
      cmd,
      true,
      withScope(scope, { sentinel: sentinelStart(schedulerScriptPath) }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "sentinel.stop") {
    output(
      cmd,
      true,
      withScope(scope, { sentinel: sentinelStop() }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "sentinel.uninstall") {
    output(
      cmd,
      true,
      withScope(scope, { sentinel: sentinelUninstall() }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "sentinel.status") {
    output(
      cmd,
      true,
      withScope(scope, { sentinel: sentinelStatus() }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "daemon.run") {
    await runDaemonCommand({
      flags,
      scope,
      schedulerScriptPath,
      command: cmd,
      pretty,
    });
    return;
  }

  if (cmd === "server.run") {
    await runStatusServer({
      schedulerScriptPath,
      host: "127.0.0.1",
      port:
        flags.port !== undefined ? Number(flags.port) : PRODUCTION_STATUS_PORT,
      onListen: (server) => {
        output(
          cmd,
          true,
          {
            helm_home: helmHome(),
            server,
            service: serviceStatus(schedulerScriptPath),
            registered_workspaces: listRegisteredScopes().length,
          },
          [],
          pretty,
        );
      },
    });
    return;
  }

  if (cmd === "ensure" || cmd === "up") {
    try {
      await assertSchedulerStartAllowed();
    } catch (err) {
      failDesiredStateBlocked(cmd, err, scope, pretty);
      process.exit(1);
    }
    const data = ensureWorkspaceUp(scope, schedulerScriptPath);
    if (!data.health.healthy) {
      fail(
        cmd,
        "runtime_unhealthy",
        `scheduler runtime unhealthy: ${data.health.reason}`,
        withScope(scope, {
          ...data,
          repair: repairCommands(scope),
        }),
        pretty,
      );
      process.exit(1);
    }
    output(
      cmd,
      true,
      withScope(scope, { service: data.service, health: data.health }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "down") {
    output(
      cmd,
      true,
      withScope(scope, bringWorkspaceDown(scope, schedulerScriptPath)),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "init") {
    output(cmd, true, withScope(scope, initWorkspace(scope)), [], pretty);
    return;
  }

  if (cmd === "heartbeat.install") {
    ensureWorkspaceRuntime(scope);
    output(
      cmd,
      true,
      withScope(scope, installHeartbeat(scope, schedulerScriptPath)),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "heartbeat.remove") {
    output(cmd, true, withScope(scope, removeHeartbeat(scope)), [], pretty);
    return;
  }

  if (cmd === "heartbeat.status") {
    output(cmd, true, withScope(scope, heartbeatStatus(scope)), [], pretty);
    return;
  }

  if (cmd === "status") {
    ensureWorkspaceConfigDir(scope);
    const jobs = loadJobsReadOnly(scope);
    const runtime = loadRuntime(scope);
    const controlState = await readRuntimeControlState();
    const registryEntry =
      listRegisteredScopes().find(
        (entry) => entry.scope_id === scope.scope_id,
      ) || null;
    const runtimeHealth = flags.deep
      ? workspaceStatusData({
          scope,
          jobs,
          runEvents: workspaceRunEvents(scope, 5000),
          runtime,
          registryEntry,
          schedulerScriptPath,
        }).health
      : null;
    const health = runtimeHealth;
    const data = withScope(scope, {
      ...baseStatusData({
        scope,
        jobs,
        runEvents: workspaceRunEvents(scope, 5000),
        schedulerScriptPath,
      }),
      runtime,
      health,
      ...controlState,
    });
    if (flags.deep && !health.healthy) {
      fail(
        cmd,
        "runtime_unhealthy",
        `scheduler runtime unhealthy: ${health.reason}`,
        { ...data, repair: repairCommands(scope) },
        pretty,
      );
      process.exit(1);
    }
    output(cmd, true, data, [], pretty);
    return;
  }

  if (cmd === "validate") {
    const raw = resolveInputObject(flags, scope, false, trailingArgs);
    const job = normalizeJob(raw, scope);
    const v = validateJob(job, { scope });
    if (!v.valid) {
      failValidation(cmd, raw, scope, v.errors, pretty);
      process.exit(2);
    }
    output(cmd, true, withScope(scope, { valid: true, job }), [], pretty);
    return;
  }

  if (cmd === "create") {
    const raw = resolveInputObject(flags, scope, false, trailingArgs);
    let activation = null;
    if (flags.activate) {
      validateRawJobInput(cmd, raw, scope, pretty);
      try {
        activation = await ensureActivation(scope, schedulerScriptPath);
      } catch (err) {
        fail(
          cmd,
          err.code || "activation_failed",
          String(err.message || err),
          activationFailureDetails(scope, err),
          pretty,
        );
        process.exit(err.exitCode || 1);
      }
      if (!activation.will_dispatch) {
        fail(
          cmd,
          "runtime_unhealthy",
          `scheduler runtime unhealthy: ${activation.health?.reason || "unknown"}`,
          withScope(scope, { activation }),
          pretty,
        );
        process.exit(1);
      }
    }
    let result;
    try {
      result = await createJob(scope, raw);
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(
          scope,
          err.validation_errors
            ? {
                validation_errors: err.validation_errors,
                validation_diagnostics:
                  err.validation_diagnostics ||
                  validationDiagnostics(raw, err.validation_errors),
              }
            : {},
        ),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!result.ok) {
      fail(
        cmd,
        "scope_busy",
        "scope mutation already in progress",
        withScope(scope, { lock: result.details }),
        pretty,
      );
      process.exit(1);
    }
    // Auto-register the scope so a stored job is never stranded in an
    // unregistered (undispatchable) scope — the failure mode that left
    // Ballmer's enabled jobs silently never firing. The --activate path
    // already registered via ensureActivation; for storage-only create we
    // register the scope without starting the service (lightweight). New
    // scopes enter enabled; an existing scope keeps its dispatch_state.
    const createWarnings = [];
    if (!activation) {
      try {
        ensureWorkspaceRuntime(scope);
        registerScope(scope);
      } catch (err) {
        createWarnings.push(
          `scope_register_failed: ${String(err.message || err)} — run '${TASKS_COMMAND} up --cwd ${scope.cwd}' to register manually`,
        );
      }
    }
    output(
      cmd,
      true,
      withScope(
        scope,
        activation ? { ...result.value, activation } : result.value,
      ),
      createWarnings,
      pretty,
    );
    return;
  }

  if (cmd === "schedule") {
    const raw = resolveInputObject(flags, scope, false, trailingArgs);
    validateRawJobInput(cmd, raw, scope, pretty);
    let activation;
    try {
      activation = await ensureActivation(scope, schedulerScriptPath);
    } catch (err) {
      fail(
        cmd,
        err.code || "activation_failed",
        String(err.message || err),
        activationFailureDetails(scope, err),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!activation.will_dispatch) {
      fail(
        cmd,
        "runtime_unhealthy",
        `scheduler runtime unhealthy: ${activation.health?.reason || "unknown"}`,
        withScope(scope, { activation }),
        pretty,
      );
      process.exit(1);
    }
    let result;
    try {
      result = await scheduleJob(scope, raw, {
        replace: Boolean(flags.replace),
      });
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(
          scope,
          err.validation_errors
            ? {
                validation_errors: err.validation_errors,
                validation_diagnostics:
                  err.validation_diagnostics ||
                  validationDiagnostics(raw, err.validation_errors),
              }
            : {},
        ),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!result.ok) {
      fail(
        cmd,
        "scope_busy",
        "scope mutation already in progress",
        withScope(scope, { lock: result.details }),
        pretty,
      );
      process.exit(1);
    }
    output(
      cmd,
      true,
      withScope(scope, {
        ...result.value,
        activation: activationWithJobFields(activation, result.value.job),
      }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "update") {
    const patch = resolveInputObject(flags, scope, true, trailingArgs);
    const id = flags.id || patch.id;
    if (!id) {
      fail(
        cmd,
        "missing_flag",
        "--id is required (or provide id in --stdin/--patch-file payload)",
        withScope(scope),
        pretty,
      );
      process.exit(2);
    }
    let result;
    try {
      result = await updateJob(scope, id, patch);
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(
          scope,
          err.validation_errors
            ? {
                validation_errors: err.validation_errors,
                validation_diagnostics:
                  err.validation_diagnostics ||
                  validationDiagnostics(patch, err.validation_errors),
              }
            : {},
        ),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!result.ok) {
      fail(
        cmd,
        "scope_busy",
        "scope mutation already in progress",
        withScope(scope, { lock: result.details }),
        pretty,
      );
      process.exit(1);
    }
    output(cmd, true, withScope(scope, result.value), [], pretty);
    return;
  }

  if (cmd === "delete") {
    const id = flags.id;
    const tag = flags.tag;
    if (!id && !tag) {
      fail(
        cmd,
        "missing_flag",
        "--id or --tag is required",
        withScope(scope),
        pretty,
      );
      process.exit(2);
    }
    if (tag && !id) {
      let result;
      try {
        result = await bulkDeleteByTag(scope, tag);
      } catch (err) {
        fail(
          cmd,
          err.code || "runtime_error",
          String(err.message || err),
          withScope(scope),
          pretty,
        );
        process.exit(err.exitCode || 1);
      }
      if (!result.ok) {
        fail(
          cmd,
          "scope_busy",
          "scope mutation already in progress",
          withScope(scope, { lock: result.details }),
          pretty,
        );
        process.exit(1);
      }
      output(cmd, true, withScope(scope, result.value), [], pretty);
      return;
    }
    let result;
    try {
      result = await deleteJob(scope, id);
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!result.ok) {
      fail(
        cmd,
        "scope_busy",
        "scope mutation already in progress",
        withScope(scope, { lock: result.details }),
        pretty,
      );
      process.exit(1);
    }
    output(cmd, true, withScope(scope, result.value), [], pretty);
    return;
  }

  if (cmd === "pause" || cmd === "resume") {
    const id = flags.id;
    const tag = flags.tag;
    if (!id && !tag) {
      fail(
        cmd,
        "missing_flag",
        "--id or --tag is required",
        withScope(scope),
        pretty,
      );
      process.exit(2);
    }
    if (tag && !id) {
      let result;
      try {
        result = await bulkSetPausedByTag(scope, tag, cmd === "resume");
      } catch (err) {
        fail(
          cmd,
          err.code || "runtime_error",
          String(err.message || err),
          withScope(scope),
          pretty,
        );
        process.exit(err.exitCode || 1);
      }
      if (!result.ok) {
        fail(
          cmd,
          "scope_busy",
          "scope mutation already in progress",
          withScope(scope, { lock: result.details }),
          pretty,
        );
        process.exit(1);
      }
      output(cmd, true, withScope(scope, result.value), [], pretty);
      return;
    }
    let result;
    try {
      result = await setJobPaused(scope, id, cmd === "resume");
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!result.ok) {
      fail(
        cmd,
        "scope_busy",
        "scope mutation already in progress",
        withScope(scope, { lock: result.details }),
        pretty,
      );
      process.exit(1);
    }
    output(cmd, true, withScope(scope, result.value), [], pretty);
    return;
  }

  if (cmd === "list") {
    let jobs = listJobs(scope, nowIso());
    if (flags.enabled !== undefined) {
      const enabled = String(flags.enabled) === "true";
      jobs = jobs.filter((job) => job.state.enabled === enabled);
    }
    if (flags.tag) {
      jobs = jobs.filter((job) => (job.tags || []).includes(flags.tag));
    }
    if (flags.status) {
      jobs = jobs.filter((job) => job.lifecycle_status === flags.status);
    }
    if (flags["schedule-type"]) {
      jobs = jobs.filter(
        (job) => job.schedule?.type === flags["schedule-type"],
      );
    }
    if (flags.name) {
      const pattern = flags.name.toLowerCase();
      jobs = jobs.filter((job) =>
        (job.name || "").toLowerCase().includes(pattern),
      );
    }
    if (flags.limit) jobs = jobs.slice(0, Number(flags.limit));
    output(cmd, true, withScope(scope, { jobs }), [], pretty);
    return;
  }

  if (cmd === "list-all") {
    const scopes = listRegisteredScopes();
    const now = nowIso();
    const results = [];
    for (const entry of scopes) {
      try {
        const entryScope = resolveScope({ cwd: entry.cwd });
        let jobs = listJobs(entryScope, now);
        if (flags.enabled !== undefined) {
          const enabled = String(flags.enabled) === "true";
          jobs = jobs.filter((job) => job.state.enabled === enabled);
        }
        if (flags.tag) {
          jobs = jobs.filter((job) => (job.tags || []).includes(flags.tag));
        }
        if (flags.status) {
          jobs = jobs.filter((job) => job.lifecycle_status === flags.status);
        }
        if (flags["schedule-type"]) {
          jobs = jobs.filter(
            (job) => job.schedule?.type === flags["schedule-type"],
          );
        }
        if (flags.name) {
          const pattern = flags.name.toLowerCase();
          jobs = jobs.filter((job) =>
            (job.name || "").toLowerCase().includes(pattern),
          );
        }
        results.push({
          scope_id: entryScope.scope_id,
          cwd: entryScope.cwd,
          jobs,
        });
      } catch {
        results.push({
          scope_id: entry.scope_id,
          cwd: entry.cwd,
          jobs: [],
          error: `scope not accessible`,
        });
      }
    }
    const totalJobs = results.reduce((sum, r) => sum + r.jobs.length, 0);
    output(
      cmd,
      true,
      { scopes: results.length, total_jobs: totalJobs, workspaces: results },
      [],
      pretty,
    );
    return;
  }

  if (cmd === "get") {
    const id = flags.id;
    if (!id) {
      fail(cmd, "missing_flag", "--id is required", withScope(scope), pretty);
      process.exit(2);
    }
    const job = getJob(scope, id, nowIso());
    if (!job) {
      fail(cmd, "not_found", `job '${id}' not found`, withScope(scope), pretty);
      process.exit(1);
    }
    output(cmd, true, withScope(scope, { job }), [], pretty);
    return;
  }

  if (cmd === "history") {
    const id = flags.id;
    const limit = Number(flags.limit || 20);
    if (!id) {
      fail(cmd, "missing_flag", "--id is required", withScope(scope), pretty);
      process.exit(2);
    }
    output(
      cmd,
      true,
      withScope(scope, { events: historyForJob(scope, id, limit) }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "job-status") {
    const id = flags.id;
    if (!id) {
      fail(cmd, "missing_flag", "--id is required", withScope(scope), pretty);
      process.exit(2);
    }
    const payload = jobStatusPayload(scope, id, nowIso());
    if (!payload) {
      fail(cmd, "not_found", `job '${id}' not found`, withScope(scope), pretty);
      process.exit(1);
    }
    output(cmd, true, withScope(scope, payload), [], pretty);
    return;
  }

  if (cmd === "logs") {
    const id = flags.id;
    if (!id) {
      fail(cmd, "missing_flag", "--id is required", withScope(scope), pretty);
      process.exit(2);
    }
    const stream = selectedLogStream(flags);
    const job = getJob(scope, id, nowIso());
    if (!job) {
      fail(cmd, "not_found", `job '${id}' not found`, withScope(scope), pretty);
      process.exit(1);
    }
    const descriptor = resolveRunForLogs({
      scope,
      jobId: id,
      runId: flags["run-id"] || null,
    });
    if (!descriptor) {
      fail(
        cmd,
        "no_runs",
        `job '${id}' has no runs to inspect`,
        withScope(scope),
        pretty,
      );
      process.exit(1);
    }
    const path = descriptor.log_paths?.[stream] || null;
    if (!path) {
      fail(
        cmd,
        "log_not_found",
        `${stream} log for run '${descriptor.run_id}' not found`,
        withScope(scope, { run_id: descriptor.run_id }),
        pretty,
      );
      process.exit(1);
    }
    const result = await streamLogFile(path, {
      follow: Boolean(flags.follow),
      pid: descriptor.active ? descriptor.pid : null,
    });
    if (!result.sawFile) {
      fail(
        cmd,
        "log_not_found",
        `${stream} log for run '${descriptor.run_id}' not found`,
        withScope(scope, { run_id: descriptor.run_id, path }),
        pretty,
      );
      process.exit(1);
    }
    return;
  }

  if (cmd === "run-now") {
    const id = flags.id;
    if (!id) {
      fail(cmd, "missing_flag", "--id is required", withScope(scope), pretty);
      process.exit(2);
    }
    try {
      await assertSchedulerStartAllowed();
    } catch (err) {
      failDesiredStateBlocked(cmd, err, scope, pretty);
      process.exit(1);
    }
    const overrides = {};
    if (flags["override-env-json"])
      overrides.env = parseJsonFlag(
        "--override-env-json",
        flags["override-env-json"],
        "object",
      );
    if (flags["override-args-json"])
      overrides.args = parseJsonFlag(
        "--override-args-json",
        flags["override-args-json"],
        "array",
      );
    if (flags["override-prompt"]) overrides.prompt = flags["override-prompt"];
    const memoryMode = memoryModeFromFlags(flags);
    if (memoryMode && !isValidMemoryMode(memoryMode)) {
      fail(
        cmd,
        "memory_mode_invalid",
        `error: invalid --memory value "${memoryMode}". Valid: read+write, off.`,
        withScope(scope),
        pretty,
      );
      process.exit(2);
    }
    if (memoryMode) overrides.memory = { mode: memoryMode };
    let result;
    try {
      result = await runJobNow(scope, id, {
        schedulerScriptPath,
        jsonOnly,
        memoryMode: memoryMode || null,
        overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      });
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!result.ok) {
      fail(
        cmd,
        "scope_busy",
        "scope dispatch already in progress",
        withScope(scope, { lock: result.details }),
        pretty,
      );
      process.exit(1);
    }
    if (result.value.status !== "success") {
      fail(
        cmd,
        "job_failed",
        `job '${id}' failed`,
        withScope(scope, { event: result.value }),
        pretty,
      );
      process.exit(1);
    }
    output(cmd, true, withScope(scope, { event: result.value }), [], pretty);
    return;
  }

  if (cmd === "cancel") {
    const id = flags.id;
    if (!id) {
      fail(cmd, "missing_flag", "--id is required", withScope(scope), pretty);
      process.exit(2);
    }
    let result;
    try {
      result = await cancelJob(scope, id);
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    output(cmd, true, withScope(scope, result), [], pretty);
    return;
  }

  if (cmd === "dispatch") {
    let result;
    try {
      await assertSchedulerStartAllowed();
      result = await dispatchScope(scope, {
        at: flags.at || nowIso(),
        limit: Number(flags.limit || 50),
        maxCatchupRuns: Number(flags["max-catchup-runs"] || 1),
        daemonInstanceId:
          flags["daemon-instance-id"] ||
          process.env.HELM_DAEMON_INSTANCE_ID ||
          null,
        schedulerScriptPath,
        jsonOnly,
        dryRun: Boolean(flags["dry-run"]),
        drainCompletions: !Boolean(flags["no-drain"]),
      });
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!result.ok) {
      fail(
        cmd,
        "scope_busy",
        "scope dispatch already in progress",
        withScope(scope, { lock: result.details }),
        pretty,
      );
      process.exit(1);
    }
    if (flags["dry-run"]) {
      output(
        cmd,
        true,
        withScope(scope, { dry_run: true, due_jobs: result.value }),
        [],
        pretty,
      );
      return;
    }
    if (result.value.some((event) => event.status === "failure")) {
      fail(
        cmd,
        "dispatch_failed",
        "one or more dispatched jobs failed",
        withScope(scope, {
          dispatched: result.value.length,
          events: result.value,
          at: flags.at || nowIso(),
        }),
        pretty,
      );
      process.exit(1);
    }
    output(
      cmd,
      true,
      withScope(scope, {
        dispatched: result.value.filter((event) => event.kind === "completed")
          .length,
        events: result.value,
        at: flags.at || nowIso(),
      }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "next-runs") {
    const id = flags.id;
    const count = Number(flags.count || 5);
    if (!id) {
      // HELM-REQ-9 — no --id but schedule flags present: preview the unsaved
      // schedule instead of resolving a stored job. Nothing is written.
      const preview = previewScheduleFromFlags({
        flags,
        scope,
        count,
        fromIso: nowIso(),
      });
      if (!preview) {
        fail(cmd, "missing_flag", "--id is required", withScope(scope), pretty);
        process.exit(2);
      }
      if (!preview.ok) {
        fail(
          cmd,
          preview.code,
          preview.message,
          withScope(scope, preview.data),
          pretty,
        );
        process.exit(2);
      }
      output(cmd, true, withScope(scope, preview.data), [], pretty);
      return;
    }
    const job = getJob(scope, id, nowIso());
    if (!job) {
      fail(cmd, "not_found", `job '${id}' not found`, withScope(scope), pretty);
      process.exit(1);
    }
    const runs = previewNextRuns(job, count, nowIso());
    output(
      cmd,
      true,
      withScope(scope, { job_id: id, count, next_runs: runs }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "clone") {
    const sourceId = flags.id;
    const newId = flags["new-id"];
    if (!sourceId) {
      fail(cmd, "missing_flag", "--id is required", withScope(scope), pretty);
      process.exit(2);
    }
    if (!newId) {
      fail(
        cmd,
        "missing_flag",
        "--new-id is required",
        withScope(scope),
        pretty,
      );
      process.exit(2);
    }
    let result;
    try {
      result = await cloneJob(scope, sourceId, newId);
    } catch (err) {
      fail(
        cmd,
        err.code || "runtime_error",
        String(err.message || err),
        withScope(
          scope,
          err.validation_errors
            ? {
                validation_errors: err.validation_errors,
                validation_diagnostics:
                  err.validation_diagnostics ||
                  validationDiagnostics({ id: newId }, err.validation_errors),
              }
            : {},
        ),
        pretty,
      );
      process.exit(err.exitCode || 1);
    }
    if (!result.ok) {
      fail(
        cmd,
        "scope_busy",
        "scope mutation already in progress",
        withScope(scope, { lock: result.details }),
        pretty,
      );
      process.exit(1);
    }
    output(cmd, true, withScope(scope, result.value), [], pretty);
    return;
  }

  if (cmd === "export") {
    const id = flags.id;
    if (id) {
      const job = getJob(scope, id, nowIso());
      if (!job) {
        fail(
          cmd,
          "not_found",
          `job '${id}' not found`,
          withScope(scope),
          pretty,
        );
        process.exit(1);
      }
      const definition = extractJobDefinition(job);
      output(cmd, true, withScope(scope, { jobs: [definition] }), [], pretty);
    } else {
      const jobs = listJobs(scope, nowIso());
      const definitions = jobs.map(extractJobDefinition);
      output(cmd, true, withScope(scope, { jobs: definitions }), [], pretty);
    }
    return;
  }

  if (cmd === "import") {
    const filePath = flags.file;
    if (!filePath) {
      fail(cmd, "missing_flag", "--file is required", withScope(scope), pretty);
      process.exit(2);
    }
    const raw = loadJson(resolve(filePath));
    const jobDefs = Array.isArray(raw)
      ? raw
      : raw.jobs || raw.data?.jobs || [raw];
    const replace = Boolean(flags.replace);
    const results = [];
    for (const def of jobDefs) {
      try {
        if (replace) {
          // eslint-disable-next-line no-await-in-loop
          const res = await scheduleJob(scope, def, { replace: true });
          results.push({
            id: def.id,
            action: res.value?.action || "created",
            ok: res.ok,
          });
        } else {
          // eslint-disable-next-line no-await-in-loop
          const res = await createJob(scope, def);
          results.push({ id: def.id, action: "created", ok: res.ok });
        }
      } catch (err) {
        results.push({
          id: def.id,
          action: "error",
          ok: false,
          error: String(err.message || err),
        });
      }
    }
    output(
      cmd,
      true,
      withScope(scope, {
        imported: results.filter((r) => r.ok).length,
        total: jobDefs.length,
        results,
      }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "prune") {
    const retainDays = Number(flags["retain-days"] || 30);
    const dryRun = Boolean(flags["dry-run"]);
    const result = pruneOldData(retainDays, dryRun);
    if (!dryRun) {
      appendActivityEvent({
        type: "prune_completed",
        source: "cli",
        data: {
          events_deleted: result.events_deleted || 0,
          log_files_deleted: result.log_files_deleted || 0,
          bytes_freed: result.bytes_freed || 0,
          retain_days: retainDays,
        },
      });
    }
    output(
      cmd,
      true,
      {
        ...result,
        retain_days: retainDays,
        dry_run: dryRun,
        helm_home: helmHome(),
      },
      [],
      pretty,
    );
    return;
  }

  if (cmd === "report") {
    const exitCode = runReportCommand({
      flags,
      cwd: process.cwd(),
      now: nowIso(),
      pretty,
    });
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  if (cmd === "sessions") {
    // Read-only view of agent sessions from Tightbeam's session endpoints,
    // plus sessions known only from the retired Helm hooks' legacy files
    // (one-release fallback). Subspace's compose UI consumes the JSON output.
    // Session identity is the full session_id; Helm no longer emits short
    // session aliases for display or routing.
    const sub = positionals[1] || null;
    if (sub !== "list") {
      fail(
        cmd,
        "invalid_subcommand",
        `unknown sessions subcommand '${sub || ""}'; supported: list`,
        withScope(scope, {
          usage: `${TASKS_COMMAND} sessions list [--state busy|idle] [--limit N]`,
        }),
        pretty,
      );
      process.exit(2);
    }
    let sessionsListImpl;
    try {
      sessionsListImpl = await import("./lib/sessions_list.mjs");
    } catch (err) {
      fail(
        cmd,
        "runtime_error",
        String(err?.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(1);
    }
    const result = await sessionsListImpl.listSessionsForCli({
      state: flags.state || null,
      limit: flags.limit ? Number(flags.limit) : null,
    });
    output(cmd, true, withScope(scope, result), [], pretty);
    return;
  }

  if (cmd === "workspaces") {
    const sub = positionals[1] || null;
    if (sub !== "list") {
      fail(
        cmd,
        "invalid_subcommand",
        `unknown workspaces subcommand '${sub || ""}'; supported: list`,
        withScope(scope, {
          usage: `${TASKS_COMMAND} workspaces list [--emit-aliases] [--limit N]`,
        }),
        pretty,
      );
      process.exit(2);
    }
    let workspacesListImpl;
    try {
      workspacesListImpl = await import("./lib/workspaces_list.mjs");
    } catch (err) {
      fail(
        cmd,
        "runtime_error",
        String(err?.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(1);
    }
    const result = workspacesListImpl.listWorkspacesForCli({
      scope,
      emitAliases: Boolean(flags["emit-aliases"]),
      limit: flags.limit ? Number(flags.limit) : null,
    });
    output(cmd, true, withScope(scope, result), [], pretty);
    return;
  }

  if (cmd === "onboard") {
    let onboardImpl;
    try {
      onboardImpl = await import("./cli/onboard.mjs");
    } catch (err) {
      fail(
        cmd,
        "runtime_error",
        String(err?.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(1);
    }
    const result = await onboardImpl.runOnboard({
      args: positionals.slice(1),
      flags,
      scope,
      schedulerScriptPath,
    });
    if (!result?.ok) {
      const errCode = result?.error || "onboard_failed";
      const hint =
        result?.hint ||
        (result?.missing
          ? `Missing: ${result.missing.join(", ")}`
          : `See \`${TASKS_COMMAND} onboard --help\`.`);
      fail(cmd, errCode, hint, withScope(scope, result || {}), pretty);
      process.exit(1);
    }
    output(cmd, true, withScope(scope, result), [], pretty);
    return;
  }

  if (cmd === "skills") {
    const sub = positionals[1] || null;
    if (sub !== "refresh") {
      fail(
        cmd,
        "invalid_subcommand",
        `unknown skills subcommand '${sub || ""}'; supported: refresh`,
        withScope(scope, {
          usage: `${TASKS_COMMAND} skills refresh [--no-verify] [--pretty]`,
        }),
        pretty,
      );
      process.exit(2);
    }
    let onboardImpl;
    try {
      onboardImpl = await import("./cli/onboard.mjs");
    } catch (err) {
      fail(
        cmd,
        "runtime_error",
        String(err?.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(1);
    }
    const result = await onboardImpl.runOnboard({
      args: [],
      flags: { ...flags, "non-interactive": true },
      scope,
      schedulerScriptPath,
    });
    if (!result?.ok) {
      const errCode = result?.error || "skills_refresh_failed";
      const hint =
        result?.hint ||
        (result?.missing
          ? `Missing: ${result.missing.join(", ")}`
          : `Run \`${TASKS_COMMAND} onboard\` first, then retry \`${TASKS_COMMAND} skills refresh\`.`);
      fail(cmd, errCode, hint, withScope(scope, result || {}), pretty);
      process.exit(1);
    }
    output(cmd, true, withScope(scope, result), [], pretty);
    return;
  }

  if (cmd === "identity") {
    // PRFAQ-0-4 Phase 4 — read-only view of <helm home>/identity.json.
    //   helm-tasks identity show
    const sub = positionals[1] || null;
    if (sub !== "show") {
      fail(
        cmd,
        "invalid_subcommand",
        `unknown identity subcommand '${sub || ""}'; supported: show`,
        withScope(scope, { usage: `${TASKS_COMMAND} identity show` }),
        pretty,
      );
      process.exit(2);
    }
    let identityImpl;
    try {
      identityImpl = await import("./lib/identity.mjs");
    } catch (err) {
      fail(
        cmd,
        "runtime_error",
        String(err?.message || err),
        withScope(scope),
        pretty,
      );
      process.exit(1);
    }
    const id = identityImpl.readIdentity();
    if (!id) {
      fail(
        cmd,
        "identity_not_configured",
        `Run \`${TASKS_COMMAND} onboard\` to create ${identityImpl.getIdentityPath()}.`,
        withScope(scope, { identity_path: identityImpl.getIdentityPath() }),
        pretty,
      );
      process.exit(1);
    }
    output(
      cmd,
      true,
      withScope(scope, {
        identity: identityImpl.redactIdentity(id),
        identity_path: identityImpl.getIdentityPath(),
      }),
      [],
      pretty,
    );
    return;
  }

  if (cmd === "bootstrap-hooks") {
    // Helm has no runtime hooks any more; both actions only remove
    // Helm-owned entries from the runtime hook settings (bootstrap_hooks.mjs).
    let action = "install";
    if (flags.uninstall) action = "uninstall";
    else if (flags.install) action = "install";
    const dryRun = Boolean(flags["dry-run"] || flags.dryRun);
    const runtime = flags.runtime || null;
    try {
      const result = bootstrapHooksCommand({ action, runtime, dryRun });
      if (!result.ok) {
        fail(cmd, result.error.code, result.error.message, {}, pretty);
        process.exit(1);
      }
      output(cmd, true, result, [], pretty);
    } catch (err) {
      fail(
        cmd,
        "bootstrap_hooks_failed",
        err.message || String(err),
        {},
        pretty,
      );
      process.exit(1);
    }
    return;
  }

  fail(
    cmd,
    "unknown_command",
    `unknown command '${cmd}'`,
    { usage: usage() },
    pretty,
  );
  process.exit(2);
}

run().catch((err) => {
  if (err?.code === "STATE_ROOT_MIGRATION_PENDING") {
    fail("runtime", err.code, err.message, err.details || {}, false);
    process.exit(3);
  }
  fail(
    "runtime",
    "runtime_error",
    String(err?.message || err),
    { stack: err?.stack || "" },
    false,
  );
  process.exit(1);
});
