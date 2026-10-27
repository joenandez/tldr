// Read-only messaging and tasks health readers, shared by installed status
// (starport_runtime.mjs) and the cold capability probe (src/tldr-capabilities.mjs).
// A capability whose daemon has simply not started yet is healthy: Tightbeam
// starts on the first session and Helm on the first `tasks up` or schedule.
// Only evidence of a fault (a check that fails for another reason, a started
// service that no longer answers, an unhealthy answer) makes one unhealthy.
// Readers never start a daemon, write state, or read credentials.

import { existsSync } from "node:fs";
import { get } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  productionRun,
  tightbeamInvocation,
} from "./tightbeam_channel_runtime.mjs";
import {
  readSlackCredentials,
  slackHealthProblems,
} from "./slack_credentials.mjs";
import { projectCapabilities } from "./tldr_capabilities.mjs";

// Helm's scheduler status port (scheduling/src/lib/service.mjs
// PRODUCTION_STATUS_PORT); HELM_STATUS_PORT overrides it there too.
export const HELM_SCHEDULER_STATUS_PORT = 45173;
const TASKS_LIVENESS_TIMEOUT_MS = 1500;
// scheduling/src/lib/service.mjs launchAgentPath() for PRODUCTION_SCHEDULER_LABEL.
const HELM_SCHEDULER_LAUNCH_AGENT = join(
  "Library",
  "LaunchAgents",
  "ai.helm.scheduler.plist",
);

// Tightbeam doctor codes that only say the daemon has not run yet: its first
// start creates the root, database, schema, and socket.
const MESSAGING_NOT_STARTED = new Set([
  "STATE_ROOT_MISSING",
  "DB_MISSING",
  "DB_NO_SCHEMA",
  "SCHEMA_OUTDATED",
  "DAEMON_NOT_RUNNING",
  "CREDENTIALS_MISSING",
]);
// Host integration findings that do not make messaging unusable: the plugin
// ships its own hooks, and an agent CLI missing from this PATH is a host that
// is not installed, not a broken messaging service.
const MESSAGING_HOST_OPTIONAL = new Set([
  "HOOK_MARKER_MISSING",
  "RUNTIME_COMMAND_UNRESOLVED",
]);

function messagingFault(check) {
  return (
    check?.status === "fail" &&
    !MESSAGING_NOT_STARTED.has(check.code) &&
    !MESSAGING_HOST_OPTIONAL.has(check.code)
  );
}

export function createMessagingDoctorReader({
  run = productionRun,
  command,
  commandPrefix,
} = {}) {
  const invocation = tightbeamInvocation({ command, commandPrefix });
  return async () => {
    const result = await run({
      ...invocation,
      admin: false,
      credentials: null,
      args: ["doctor"],
    });
    const checks = result?.result?.checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({ ok: !checks.some(messagingFault) });
  };
}

// Tasks health: the scheduler's own /livez probe (the one its sentinel uses).
// A plain GET neither starts the daemon nor writes Helm state. A refused
// connection is "not started" unless the scheduler's LaunchAgent is installed,
// in which case launchd should be keeping it up.
export function createTasksLivenessReader({
  port = HELM_SCHEDULER_STATUS_PORT,
  timeoutMs = TASKS_LIVENESS_TIMEOUT_MS,
  userHome = homedir(),
} = {}) {
  const schedulerInstalled = () =>
    existsSync(join(userHome, HELM_SCHEDULER_LAUNCH_AGENT));
  return () =>
    new Promise((resolveHealth) => {
      const settle = (ok) => resolveHealth(Object.freeze({ ok }));
      const request = get(
        { host: "127.0.0.1", port, path: "/livez", timeout: timeoutMs },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => {
            try {
              settle(
                response.statusCode === 200 && JSON.parse(body)?.ok === true,
              );
            } catch {
              settle(false);
            }
          });
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", (error) =>
        settle(error?.code === "ECONNREFUSED" && !schedulerInstalled()),
      );
    });
}

// Cheap and offline: credentials with an owner and no last-observed problem
// (dead token or missing route, from the daemon, listener or
// `status --channel slack`) mean connected; anything else needs attention.
export function readSlackCapabilityState() {
  try {
    const credentials = readSlackCredentials();
    if (!credentials) return "not_connected";
    return credentials.ownerUserId && slackHealthProblems().length === 0
      ? "connected"
      : "needs_attention";
  } catch {
    return "needs_attention";
  }
}

// Boundary logs on stderr: failures always, results only when asked.
function logProbeEvent(level, event, fields) {
  if (level === "info" && process.env.TLDR_AGENT_DEBUG_CAPABILITIES !== "1") {
    return;
  }
  try {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
    );
  } catch {
    // Logging never changes a probe outcome.
  }
}

async function observe(capability, reader) {
  try {
    return await reader();
  } catch (error) {
    logProbeEvent("warn", "cold_capability_reader_failed", {
      capability,
      error_code: typeof error?.code === "string" ? error.code : null,
      error_name: error?.name ?? null,
    });
    return Object.freeze({ ok: false });
  }
}

// Cold status for an install that never activated a lifecycle release: the
// lifecycle state stays setup-required, and email is not connected because no
// owner setup has run. Native setup and the app are never touched.
export async function probeColdCapabilities({
  readMessagingHealth = createMessagingDoctorReader(),
  readTasksHealth = createTasksLivenessReader({
    port: Number(process.env.HELM_STATUS_PORT) || HELM_SCHEDULER_STATUS_PORT,
  }),
} = {}) {
  const startedAt = Date.now();
  const [messaging, tasks] = await Promise.all([
    observe("messaging", readMessagingHealth),
    observe("tasks", readTasksHealth),
  ]);
  const capabilities = projectCapabilities({
    messaging,
    tasks,
    nativeStatus: "unavailable",
    appInstalled: false,
    slack: readSlackCapabilityState(),
  });
  logProbeEvent("info", "cold_capability_probe_result", {
    messaging: capabilities.messaging.state,
    tasks: capabilities.tasks.state,
    email: capabilities.email.state,
    latency_ms: Date.now() - startedAt,
  });
  return Object.freeze({
    ok: true,
    data: Object.freeze({
      state: "setup-required",
      next_action: "setup",
      capabilities,
    }),
    error: null,
  });
}
