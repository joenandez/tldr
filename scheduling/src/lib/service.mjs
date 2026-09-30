import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  globalRuntimeRoot,
  helmHome,
  serviceRoot,
  ensureGlobalRuntimeDirs,
  worktreeName,
} from "./store.mjs";
import { defaultHelmHome, isProductionHelmHome } from "./state_root.mjs";
import { tightbeamStateRoot } from "./tightbeam_sessions.mjs";
import {
  assertNodeRuntimeContract,
  resolveExecutable,
  resolveNodeExecutable,
  resolveServiceNodeExecutable,
  runtimePath,
} from "./node_exec.mjs";
import {
  appendActivityEvent,
  trackHealthTransition,
} from "./activity_stream.mjs";
import { tailFile } from "./file_tail.mjs";
import { bootoutLaunchdJob } from "./launchd_bootout.mjs";
import { isProcessAlive } from "./process_liveness.mjs";
import { processTreePids } from "./process_wrapper.mjs";
import {
  processTreeResourceSnapshot,
  vmmapSummaryForPid,
} from "./resource_sampler.mjs";

export const PRODUCTION_SCHEDULER_LABEL = "ai.helm.scheduler";
export const PRODUCTION_SENTINEL_LABEL = "ai.helm.sentinel";
export const PRODUCTION_STATUS_PORT = 45173;
export const PRODUCTION_HELM_HOME = defaultHelmHome();
export const PRODUCTION_SERVICE_OVERRIDE_ENV =
  "HELM_ALLOW_PRODUCTION_SERVICE_MUTATION_FROM_WORKTREE";
const SCHEDULER_LABEL_BASE = PRODUCTION_SCHEDULER_LABEL;
const SENTINEL_LABEL_BASE = PRODUCTION_SENTINEL_LABEL;

export function worktreeLabel(base, name) {
  if (!name) return base;
  return base === SCHEDULER_LABEL_BASE
    ? `${base}.dev.${name}`
    : `${base}.${name}`;
}
function activeDevDaemonName() {
  return process.env.HELM_DEV_DAEMON_NAME || null;
}
function schedulerLabel() {
  return activeDevDaemonName()
    ? worktreeLabel(SCHEDULER_LABEL_BASE, activeDevDaemonName())
    : SCHEDULER_LABEL_BASE;
}
function sentinelLabel() {
  return activeDevDaemonName()
    ? worktreeLabel(SENTINEL_LABEL_BASE, activeDevDaemonName())
    : SENTINEL_LABEL_BASE;
}
const SYSTEMD_UNIT = "helm-tasks.service";

function quoteXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fakeStatePath() {
  return join(serviceRoot(), "fake-service.json");
}

function nowIso() {
  return new Date().toISOString();
}

function commandExists(name) {
  const result = spawnSync("sh", ["-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

export function detectServiceMode() {
  if (process.env.HELM_SERVICE_MODE === "fake") return "fake";
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux" && commandExists("systemctl"))
    return "systemd";
  return "unsupported";
}

function serviceScriptPath(schedulerScriptPath) {
  const resolved = resolve(schedulerScriptPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function repoRoot(schedulerScriptPath) {
  return resolve(dirname(schedulerScriptPath), "..");
}

function daemonScriptPath(schedulerScriptPath) {
  return join(
    dirname(serviceScriptPath(schedulerScriptPath)),
    "helm-daemon.mjs",
  );
}

function logPaths() {
  ensureGlobalRuntimeDirs();
  return {
    stdout: join(serviceRoot(), "daemon.stdout.log"),
    stderr: join(serviceRoot(), "daemon.stderr.log"),
  };
}

const FORWARDED_ENV_KEYS = [
  "HELM_HOME",
  "HELM_STATUS_PORT",
  "HELM_DEV_DAEMON_NAME",
  "HELM_CANONICAL_CHECKOUT",
];

function serviceEnvironment() {
  const nodePath = resolveServiceNodeExecutable();
  const claudePath = resolveExecutable("claude");
  const env = {
    PATH: runtimePath([nodePath, claudePath]),
    // Bake the resolved home into the plist so the launchd-spawned daemon binds
    // to the same home as the installer instead of re-resolving it from
    // launchd's bare environment.
    HELM_HOME: helmHome(),
    TIGHTBEAM_STATE_ROOT: tightbeamStateRoot(),
    HELM_STATUS_PORT: String(
      process.env.HELM_STATUS_PORT || PRODUCTION_STATUS_PORT,
    ),
  };
  for (const key of FORWARDED_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function launchAgentPath() {
  return join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${schedulerLabel()}.plist`,
  );
}

function sentinelLaunchAgentPath() {
  return join(homedir(), "Library", "LaunchAgents", `${sentinelLabel()}.plist`);
}

function launchdTarget() {
  return `gui/${process.getuid()}/${schedulerLabel()}`;
}

function sentinelLaunchdTarget() {
  return `gui/${process.getuid()}/${sentinelLabel()}`;
}

function systemdUnitPath() {
  return join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}

function serviceDefinition(schedulerScriptPath) {
  const nodePath = resolveServiceNodeExecutable();
  const script = serviceScriptPath(schedulerScriptPath);
  const daemonScript = daemonScriptPath(schedulerScriptPath);
  const env = serviceEnvironment();
  return {
    nodePath,
    script,
    daemonScript,
    workingDirectory: repoRoot(script),
    env,
    logs: logPaths(),
  };
}

function normalizePath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function configuredCanonicalCheckout() {
  return normalizePath(
    process.env.HELM_CANONICAL_CHECKOUT || join(homedir(), "Dev", "helm"),
  );
}

function isProductionHome(home = helmHome()) {
  return isProductionHelmHome(home);
}

function currentStatusPort() {
  const value = Number(process.env.HELM_STATUS_PORT || PRODUCTION_STATUS_PORT);
  return Number.isFinite(value) ? value : PRODUCTION_STATUS_PORT;
}

export function serviceMutationSafety({
  home = helmHome(),
  schedulerScriptPath,
  env = process.env,
  cwdWorktreeName = worktreeName(),
} = {}) {
  const devName = env.HELM_DEV_DAEMON_NAME || null;
  const statusPort = Number(env.HELM_STATUS_PORT || PRODUCTION_STATUS_PORT);
  if (devName) {
    if (isProductionHome(home)) {
      return {
        ok: false,
        code: "dev_daemon_uses_production_home",
        message: "dev daemon refuses to use the production HELM_HOME",
        details: {
          helm_home: home,
          production_home: PRODUCTION_HELM_HOME,
          label: worktreeLabel(SCHEDULER_LABEL_BASE, devName),
        },
      };
    }
    if (statusPort === PRODUCTION_STATUS_PORT) {
      return {
        ok: false,
        code: "dev_daemon_uses_production_port",
        message: `dev daemon refuses to use production status port ${PRODUCTION_STATUS_PORT}`,
        details: {
          helm_home: home,
          status_port: statusPort,
          production_status_port: PRODUCTION_STATUS_PORT,
          label: worktreeLabel(SCHEDULER_LABEL_BASE, devName),
        },
      };
    }
    return { ok: true };
  }

  if (!isProductionHome(home)) return { ok: true };
  if (env[PRODUCTION_SERVICE_OVERRIDE_ENV] === "1") return { ok: true };

  const scriptRoot = schedulerScriptPath
    ? normalizePath(repoRoot(serviceScriptPath(schedulerScriptPath)))
    : null;
  const canonicalRoot = configuredCanonicalCheckout();
  const fromCanonical = scriptRoot === canonicalRoot && !cwdWorktreeName;
  if (fromCanonical) return { ok: true };

  return {
    ok: false,
    code: "production_service_mutation_forbidden",
    message:
      "production Helm service mutation is allowed only from the canonical checkout",
    details: {
      helm_home: home,
      production_home: PRODUCTION_HELM_HOME,
      scheduler_script: schedulerScriptPath
        ? serviceScriptPath(schedulerScriptPath)
        : null,
      script_root: scriptRoot,
      canonical_checkout: canonicalRoot,
      worktree_name: cwdWorktreeName,
      override_env: PRODUCTION_SERVICE_OVERRIDE_ENV,
    },
  };
}

function assertServiceMutationAllowed(schedulerScriptPath) {
  const safety = serviceMutationSafety({ schedulerScriptPath });
  if (safety.ok) return;
  const err = new Error(safety.message);
  err.code = safety.code;
  err.details = safety.details;
  err.exitCode = 1;
  throw err;
}

function assertDevServiceConfiguration() {
  if (!activeDevDaemonName()) return;
  if (isProductionHome(helmHome())) {
    const err = new Error("dev daemon refuses to use the production HELM_HOME");
    err.code = "dev_daemon_uses_production_home";
    err.details = {
      helm_home: helmHome(),
      production_home: PRODUCTION_HELM_HOME,
      label: schedulerLabel(),
    };
    throw err;
  }
  if (currentStatusPort() === PRODUCTION_STATUS_PORT) {
    const err = new Error(
      `dev daemon refuses to use production status port ${PRODUCTION_STATUS_PORT}`,
    );
    err.code = "dev_daemon_uses_production_port";
    err.details = {
      helm_home: helmHome(),
      status_port: currentStatusPort(),
      production_status_port: PRODUCTION_STATUS_PORT,
      label: schedulerLabel(),
    };
    throw err;
  }
}

function plistValue(text, key) {
  const pattern = new RegExp(
    `<key>${key}</key>\\s*<string>([^<]*)</string>`,
    "m",
  );
  return text.match(pattern)?.[1] || null;
}

function plistOldSpaceValue(text) {
  const match = String(text || "").match(/--max-old-space-size=(\d+)/);
  return match ? Number(match[1]) : null;
}

function normalizePlistText(text) {
  return String(text || "")
    .trim()
    .replace(/\r\n/g, "\n");
}

function normalizePathForTemplateComparison(pathValue) {
  return [
    ...new Set(
      String(pathValue || "")
        .split(":")
        .filter(Boolean)
        .filter((entry) => !entry.includes("/.codex/tmp/arg0/")),
    ),
  ]
    .sort()
    .join(":");
}

function normalizeSchedulerPlistForTemplateComparison(text) {
  return normalizePlistText(text).replace(
    /(<key>PATH<\/key>\s*<string>)([^<]*)(<\/string>)/m,
    (_match, prefix, value, suffix) =>
      `${prefix}${normalizePathForTemplateComparison(value)}${suffix}`,
  );
}

function schedulerServiceTemplateState({
  definitionText = "",
  expectedDefinitionText = "",
  launchdRaw = "",
  installed = false,
  loaded = false,
} = {}) {
  const configuredOldSpaceMb = plistOldSpaceValue(definitionText);
  const expectedOldSpaceMb = plistOldSpaceValue(expectedDefinitionText);
  const runtimeOldSpaceMb = plistOldSpaceValue(launchdRaw);
  const templateDrift =
    installed &&
    normalizeSchedulerPlistForTemplateComparison(definitionText) !==
      normalizeSchedulerPlistForTemplateComparison(expectedDefinitionText);
  const runtimeDrift =
    loaded &&
    configuredOldSpaceMb !== null &&
    runtimeOldSpaceMb !== null &&
    runtimeOldSpaceMb !== configuredOldSpaceMb;
  const drift = Boolean(templateDrift || runtimeDrift);
  return {
    service_template_drift: drift,
    service_template: {
      configured_old_space_mb: configuredOldSpaceMb,
      expected_old_space_mb: expectedOldSpaceMb,
      runtime_old_space_mb: runtimeOldSpaceMb,
      installed_matches_expected: installed ? !templateDrift : null,
      runtime_matches_installed: loaded ? !runtimeDrift : null,
    },
    health: runtimeDrift
      ? {
          healthy: false,
          reason: "scheduler_service_runtime_drift",
        }
      : {
          healthy: true,
          reason: "ok",
        },
  };
}

function launchdEnvironmentValue(text, key) {
  const source = String(text || "");
  const assignment = source.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, "m"));
  if (assignment) return assignment[1].replace(/^"|"$/g, "");
  const launchdMap = source.match(
    new RegExp(`"?${key}"?\\s*=>\\s*"?([^"\\n]+)"?`, "m"),
  );
  return launchdMap?.[1]?.trim() || null;
}

function sentinelRepairModeState({
  definitionText = "",
  launchdRaw = "",
  processRaw = "",
  loaded = false,
} = {}) {
  const configured =
    plistValue(definitionText, "HELM_SENTINEL_REPAIR_MODE") || null;
  const runtime =
    launchdEnvironmentValue(launchdRaw, "HELM_SENTINEL_REPAIR_MODE") ||
    launchdEnvironmentValue(processRaw, "HELM_SENTINEL_REPAIR_MODE") ||
    null;
  const drift =
    loaded && configured === "restart_loaded_only" && runtime !== configured;
  return {
    repair_mode: configured,
    configured_repair_mode: configured,
    runtime_repair_mode: runtime,
    repair_mode_drift: drift,
    health: drift
      ? {
          healthy: false,
          reason: "sentinel_runtime_config_drift",
        }
      : {
          healthy: true,
          reason: "ok",
        },
  };
}

export function invalidProductionServiceLabels({
  launchAgentsDir = join(homedir(), "Library", "LaunchAgents"),
} = {}) {
  let entries = [];
  try {
    entries = readdirSync(launchAgentsDir);
  } catch {
    return [];
  }
  const invalid = [];
  for (const entry of entries) {
    if (entry === `${SCHEDULER_LABEL_BASE}.plist`) continue;
    if (!entry.startsWith(`${SCHEDULER_LABEL_BASE}.`)) continue;
    if (!entry.endsWith(".plist")) continue;
    const path = join(launchAgentsDir, entry);
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const label = plistValue(text, "Label") || entry.replace(/\.plist$/, "");
    const envHome = plistValue(text, "HELM_HOME");
    const statusPort = Number(plistValue(text, "HELM_STATUS_PORT") || NaN);
    const usesProductionHome = envHome !== null && isProductionHome(envHome);
    const usesProductionPort = statusPort === PRODUCTION_STATUS_PORT;
    if (!usesProductionHome && !usesProductionPort) continue;
    invalid.push({
      label,
      path,
      helm_home: envHome,
      status_port: Number.isFinite(statusPort) ? statusPort : null,
      uses_production_home: usesProductionHome,
      uses_production_port: usesProductionPort,
      reason: "non_production_label_targets_production_daemon",
    });
  }
  return invalid;
}

function sentinelRoot() {
  return join(globalRuntimeRoot(), "sentinel");
}

function sentinelScriptSourcePath(schedulerScriptPath) {
  return join(dirname(serviceScriptPath(schedulerScriptPath)), "sentinel.mjs");
}

function sentinelScriptInstallPath() {
  return join(sentinelRoot(), "sentinel.mjs");
}

function sentinelLogPaths() {
  mkdirSync(sentinelRoot(), { recursive: true });
  return {
    stdout: join(sentinelRoot(), "sentinel.stdout.log"),
    stderr: join(sentinelRoot(), "sentinel.stderr.log"),
  };
}

function sentinelFakeStatePath() {
  return join(sentinelRoot(), "fake-sentinel.json");
}

// Slow launchd's relaunch of a crash-looping job. Without this, sub-10s exits
// (e.g. a transient singleton refusal) make launchd flap and eventually boot the
// job out of the registry entirely — the Sev2 where the scheduler vanished from
// launchctl and never came back. 30s keeps it registered while a transient
// condition clears.
const LAUNCHD_THROTTLE_SECONDS = 30;
const DAEMON_MAX_OLD_SPACE_MB = 256;
const SENTINEL_DEFAULT_REPAIR_MODE = "restart_loaded_only";

export function sentinelPlistContent(scriptPath) {
  const logs = sentinelLogPaths();
  const repairMode =
    process.env.HELM_SENTINEL_REPAIR_MODE || SENTINEL_DEFAULT_REPAIR_MODE;
  const sentinelEnv = {
    HELM_HOME: globalRuntimeRoot(),
    TIGHTBEAM_STATE_ROOT: tightbeamStateRoot(),
    PATH: serviceEnvironment().PATH,
    HELM_SENTINEL_REPAIR_MODE: repairMode,
  };
  if (process.env.HELM_CANONICAL_CHECKOUT) {
    sentinelEnv.HELM_CANONICAL_CHECKOUT =
      process.env.HELM_CANONICAL_CHECKOUT;
  }
  // Run the sentinel from the repo source so Node's main-module detection
  // (import.meta.url === process.argv[1]) matches and the loop actually starts,
  // and so ./lib + node_modules resolve from the repo.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${sentinelLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${quoteXml(resolveServiceNodeExecutable())}</string>
    <string>${quoteXml(scriptPath)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${LAUNCHD_THROTTLE_SECONDS}</integer>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(sentinelEnv)
  .map(
    ([key, value]) =>
      `    <key>${quoteXml(key)}</key>\n    <string>${quoteXml(value)}</string>`,
  )
  .join("\n")}
  </dict>
  <key>StandardOutPath</key>
  <string>${quoteXml(logs.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${quoteXml(logs.stderr)}</string>
</dict>
</plist>
`;
}

export function plistContent(schedulerScriptPath) {
  const definition = serviceDefinition(schedulerScriptPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${schedulerLabel()}</string>
  <key>ProgramArguments</key>
	  <array>
	    <string>${quoteXml(definition.nodePath)}</string>
	    <string>--jitless</string>
	    <string>--max-semi-space-size=1</string>
	    <string>--max-old-space-size=${DAEMON_MAX_OLD_SPACE_MB}</string>
	    <string>${quoteXml(definition.daemonScript)}</string>
	  </array>
  <key>WorkingDirectory</key>
  <string>${quoteXml(definition.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${LAUNCHD_THROTTLE_SECONDS}</integer>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(definition.env)
  .map(
    ([k, v]) =>
      `    <key>${quoteXml(k)}</key>\n    <string>${quoteXml(v)}</string>`,
  )
  .join("\n")}
  </dict>
  <key>StandardOutPath</key>
  <string>${quoteXml(definition.logs.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${quoteXml(definition.logs.stderr)}</string>
</dict>
</plist>
`;
}

function systemdContent(schedulerScriptPath) {
  const definition = serviceDefinition(schedulerScriptPath);
  return `[Unit]
Description=Helm Tasks Daemon

[Service]
ExecStart=${definition.nodePath} --jitless --max-semi-space-size=1 --max-old-space-size=${DAEMON_MAX_OLD_SPACE_MB} ${definition.daemonScript}
WorkingDirectory=${definition.workingDirectory}
Restart=always
RestartSec=2
${Object.entries(definition.env)
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join("\n")}
StandardOutput=append:${definition.logs.stdout}
StandardError=append:${definition.logs.stderr}

[Install]
WantedBy=default.target
`;
}

function fakeState() {
  if (!existsSync(fakeStatePath())) {
    return { installed: false, running: false, pid: null, updated_at: null };
  }
  return JSON.parse(readFileSync(fakeStatePath(), "utf8"));
}

function saveFakeState(state) {
  ensureGlobalRuntimeDirs();
  writeFileSync(fakeStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function runCommand(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${cmd} failed`).trim());
  }
  return result.stdout || "";
}

function runCommandAllow(cmd, args, allowedStatuses = []) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0 && !allowedStatuses.includes(result.status)) {
    throw new Error((result.stderr || result.stdout || `${cmd} failed`).trim());
  }
  return result;
}

function readDaemonPidFile() {
  const path = join(serviceRoot(), "daemon.pid");
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function rssMbForPid(pid) {
  if (!pid || !isProcessAlive(pid)) return null;
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const kb = Number(String(result.stdout || "").trim());
  if (!Number.isFinite(kb) || kb <= 0) return null;
  return Math.round(kb / 1024);
}

function daemonMemoryForPid(pid, { includeDetails = false } = {}) {
  const rssMb = rssMbForPid(pid);
  const vmmap = includeDetails
    ? vmmapSummaryForPid(pid)
    : {
        physical_footprint_mb: null,
        physical_footprint_peak_mb: null,
        malloc_large_reusable_mb: null,
        vmmap_ok: false,
        vmmap_error: null,
      };
  return {
    ps_rss_mb: rssMb,
    heap_used_mb: null,
    heap_total_mb: null,
    external_mb: null,
    array_buffers_mb: null,
    ...vmmap,
  };
}

function childCountForPid(pid) {
  if (!pid || !isProcessAlive(pid)) return 0;
  return Math.max(0, processTreePids(pid).length - 1);
}

function daemonFreshnessTimestamp() {
  const path = join(serviceRoot(), "daemon-freshness.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed.recorded_at || null;
  } catch {
    return null;
  }
}

function effectiveDaemonQuarantine(quarantine, progress, noProgress) {
  if (!quarantine?.active) return quarantine;
  const quarantineDaemonId = quarantine.daemon_instance_id || null;
  const progressDaemonId = progress?.daemon_instance_id || null;
  if (!quarantineDaemonId || !progressDaemonId) return quarantine;
  if (quarantineDaemonId === progressDaemonId || noProgress) return quarantine;
  return {
    ...quarantine,
    active: false,
    active_cause: null,
    stale: true,
    stale_reason: "daemon_instance_rotated",
    ignored_active_cause: quarantine.active_cause || null,
    ignored_daemon_instance_id: quarantineDaemonId,
    current_daemon_instance_id: progressDaemonId,
  };
}

function readDaemonProgressDiagnostics() {
  const daemonRoot = join(globalRuntimeRoot(), "daemon");
  const progressPath = join(daemonRoot, "progress.json");
  const quarantinePath = join(daemonRoot, "quarantine.json");
  let progress = null;
  try {
    progress = JSON.parse(readFileSync(progressPath, "utf8"));
  } catch {
    progress = null;
  }
  let quarantine = {
    version: "1.0",
    active: false,
    causes: {},
  };
  try {
    quarantine = JSON.parse(readFileSync(quarantinePath, "utf8"));
  } catch {
    // absent quarantine is healthy and expected.
  }
  if (!progress) {
    return {
      configured: false,
      current_phase: null,
      heartbeat_at: null,
      heartbeat_age_ms: null,
      no_progress: false,
      no_progress_reason: null,
      quarantine,
    };
  }
  const staleAfterMs = Number(
    process.env.HELM_DAEMON_PROGRESS_STALE_MS || 15000,
  );
  const heartbeatMs = Date.parse(progress.heartbeat_at || "");
  const heartbeatAgeMs = Number.isFinite(heartbeatMs)
    ? Math.max(0, Date.now() - heartbeatMs)
    : null;
  const noProgress =
    progress.status === "running" &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs > staleAfterMs;
  quarantine = effectiveDaemonQuarantine(quarantine, progress, noProgress);
  return {
    configured: true,
    ...progress,
    heartbeat_age_ms: heartbeatAgeMs,
    no_progress: noProgress,
    no_progress_reason: noProgress ? "heartbeat_stale" : null,
    quarantine,
  };
}

function logStat(path) {
  try {
    const st = statSync(path);
    return { path, size_bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { path, size_bytes: null, mtime: null };
  }
}

function parseLaunchdClue(raw) {
  if (!raw) return null;
  const exitMatch = raw.match(/last exit code = (-?\d+)/);
  const reasonMatch = raw.match(/reason = ([^\n]+)/);
  const stateMatch = raw.match(/state = ([^\n]+)/);
  return {
    state: stateMatch ? stateMatch[1].trim() : null,
    last_exit_code: exitMatch ? Number(exitMatch[1]) : null,
    reason: reasonMatch ? reasonMatch[1].trim() : null,
  };
}

function withServiceDiagnostics(status, options = {}) {
  const { raw, ...publicStatus } = status;
  const pidFileValue = readDaemonPidFile();
  const livePid = status.pid || pidFileValue || null;
  const stderrPath = status.logs?.stderr || null;
  const daemonProgress = readDaemonProgressDiagnostics();
  const memory = daemonMemoryForPid(livePid, {
    includeDetails: Boolean(options.includeMemoryDetails),
  });
  const currentRssMb = memory.ps_rss_mb;
  const processTree = options.includeProcessTree
    ? processTreeResourceSnapshot(livePid)
    : null;
  const childCount = processTree
    ? processTree.child_count
    : childCountForPid(livePid);
  const containment = {
    live_pid: livePid,
    live_pid_alive: isProcessAlive(livePid),
    current_rss_mb: currentRssMb,
    child_count: childCount,
    no_progress: Boolean(daemonProgress.no_progress),
    no_progress_reason: daemonProgress.no_progress_reason || null,
    current_phase: daemonProgress.current_phase || null,
    quarantine_active: Boolean(daemonProgress.quarantine?.active),
  };
  if (options.emitTelemetry) {
    appendActivityEvent({
      type: "daemon_containment_telemetry",
      kind: "service",
      level:
        containment.no_progress || containment.quarantine_active
          ? "error"
          : "info",
      data: containment,
    });
  }
  return {
    ...publicStatus,
    pid_file: {
      path: join(serviceRoot(), "daemon.pid"),
      pid: pidFileValue,
      alive: isProcessAlive(pidFileValue),
    },
    live_pid: livePid,
    live_pid_alive: containment.live_pid_alive,
    current_rss_mb: currentRssMb,
    child_count: childCount,
    ...(processTree ? { process_tree: processTree } : {}),
    memory,
    containment,
    last_daemon_freshness_at: daemonFreshnessTimestamp(),
    daemon_progress: daemonProgress,
    recent_stderr_tail: stderrPath ? tailFile(stderrPath, 25) : null,
    stderr_log: stderrPath ? logStat(stderrPath) : null,
    launchd_clue: parseLaunchdClue(raw || ""),
  };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fakeInstall(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  assertDevServiceConfiguration();
  ensureGlobalRuntimeDirs();
  const path = join(serviceRoot(), "helm-tasks.fake.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        installed_at: nowIso(),
        scheduler_script: serviceScriptPath(schedulerScriptPath),
        daemon_script: daemonScriptPath(schedulerScriptPath),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const current = fakeState();
  saveFakeState({ ...current, installed: true, updated_at: nowIso() });
  return fakeStatus(schedulerScriptPath);
}

function fakeStart(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  assertDevServiceConfiguration();
  const current = fakeState();
  if (!current.installed) {
    fakeInstall(schedulerScriptPath);
  }
  if (current.running && current.pid) {
    if (isProcessAlive(current.pid)) {
      return fakeStatus(schedulerScriptPath);
    }
  }

  // If a daemon is already running for this HELM_HOME (per the singleton
  // pidfile), adopt it instead of forking a duplicate. Prevents the orphan
  // daemon swarm fixed in COE 2026-05-05.
  const pidFile = join(serviceRoot(), "daemon.pid");
  if (existsSync(pidFile)) {
    try {
      const heldPid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(heldPid) && heldPid > 0 && isProcessAlive(heldPid)) {
        saveFakeState({
          installed: true,
          running: true,
          pid: heldPid,
          updated_at: nowIso(),
        });
        return fakeStatus(schedulerScriptPath);
      }
    } catch {
      // pidfile stale or unreadable; fall through and spawn a fresh daemon
    }
  }

  const nodePath = resolveNodeExecutable();
  const child = spawn(
    nodePath,
    [daemonScriptPath(schedulerScriptPath), "--interval-sec", "1"],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HELM_SERVICE_MODE: "fake",
        HELM_DAEMON_CHILD: "1",
        HELM_FAKE_SERVICE_DAEMON: "1",
        HELM_STATUS_PORT: process.env.HELM_STATUS_PORT || "0",
        // HELM_DAEMON_PARENT_PID is intentionally NOT set here. fakeStart
        // runs in the short-lived `service start` CLI subprocess; tagging
        // its pid would kill the detached daemon as soon as the CLI exits,
        // breaking the whole point of `service start`. Test harnesses inject
        // HELM_DAEMON_PARENT_PID via process.env (testlib.runCli) so it
        // cascades here automatically and points at the long-lived test
        // runner. See COE 2026-05-05.
      },
    },
  );
  child.unref();
  saveFakeState({
    installed: true,
    running: true,
    pid: child.pid,
    updated_at: nowIso(),
  });
  return fakeStatus(schedulerScriptPath);
}

function fakeStop(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  const current = fakeState();
  if (current.running && current.pid) {
    try {
      process.kill(current.pid, "SIGTERM");
    } catch {
      // ignore stale pid
    }
  }
  saveFakeState({
    ...current,
    running: false,
    pid: null,
    updated_at: nowIso(),
  });
  return fakeStatus(schedulerScriptPath);
}

function fakeStatus(schedulerScriptPath) {
  const current = fakeState();
  let running = Boolean(current.running && current.pid);
  if (running && !isProcessAlive(current.pid)) running = false;
  const definitionPath = join(serviceRoot(), "helm-tasks.fake.json");
  return {
    mode: "fake",
    label: schedulerLabel(),
    unit: SYSTEMD_UNIT,
    installed: current.installed && existsSync(definitionPath),
    running,
    loaded: running,
    pid: running ? current.pid : null,
    definition_path: definitionPath,
    logs: logPaths(),
    scheduler_script: serviceScriptPath(schedulerScriptPath),
    daemon_script: daemonScriptPath(schedulerScriptPath),
  };
}

function fakeUninstall(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  fakeStop(schedulerScriptPath);
  rmSync(join(serviceRoot(), "helm-tasks.fake.json"), { force: true });
  saveFakeState({
    installed: false,
    running: false,
    pid: null,
    updated_at: nowIso(),
  });
  return fakeStatus(schedulerScriptPath);
}

function launchdInstall(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  assertDevServiceConfiguration();
  const path = launchAgentPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plistContent(schedulerScriptPath), "utf8");
  return launchdStatus(schedulerScriptPath);
}

function launchdStatus(schedulerScriptPath) {
  const definitionPath = launchAgentPath();
  const installed = existsSync(definitionPath);
  let definitionText = "";
  try {
    definitionText = readFileSync(definitionPath, "utf8");
  } catch {
    definitionText = "";
  }
  let loaded = false;
  let running = false;
  let pid = null;
  let raw = "";
  if (installed) {
    const result = spawnSync("launchctl", ["print", launchdTarget()], {
      encoding: "utf8",
    });
    loaded = result.status === 0;
    raw = `${result.stdout || ""}${result.stderr || ""}`;
    const match = raw.match(/pid = (\d+)/);
    if (match) {
      running = true;
      pid = Number(match[1]);
    }
  }
  const templateState = schedulerServiceTemplateState({
    definitionText,
    expectedDefinitionText: plistContent(schedulerScriptPath),
    launchdRaw: raw,
    installed,
    loaded,
  });
  return {
    mode: "launchd",
    label: schedulerLabel(),
    installed,
    loaded,
    running,
    pid,
    definition_path: definitionPath,
    logs: logPaths(),
    scheduler_script: serviceScriptPath(schedulerScriptPath),
    ...templateState,
    raw,
  };
}

function waitForLaunchd(schedulerScriptPath, predicate, timeoutMs = 5000) {
  const started = Date.now();
  let status = launchdStatus(schedulerScriptPath);
  while (!predicate(status) && Date.now() - started < timeoutMs) {
    sleepMs(250);
    status = launchdStatus(schedulerScriptPath);
  }
  return status;
}

function assertLaunchdRunningStatus(status, action = "start") {
  const livePid =
    Number.isInteger(status?.pid) &&
    status.pid > 0 &&
    isProcessAlive(status.pid);
  if (status?.running === true && livePid) return status;
  const err = new Error(
    `scheduler_service_not_running: launchd ${action} did not produce a running scheduler pid`,
  );
  err.code = "scheduler_service_not_running";
  err.details = {
    action,
    loaded: Boolean(status?.loaded),
    running: Boolean(status?.running),
    pid: status?.pid || null,
    label: status?.label || schedulerLabel(),
  };
  throw err;
}

function launchdStart(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  assertDevServiceConfiguration();
  const status = launchdStatus(schedulerScriptPath);
  if (!status.installed) {
    launchdInstall(schedulerScriptPath);
  }
  const current = launchdStatus(schedulerScriptPath);
  if (!current.loaded) {
    runCommand("launchctl", [
      "bootstrap",
      `gui/${process.getuid()}`,
      launchAgentPath(),
    ]);
  }
  let afterBootstrap = waitForLaunchd(
    schedulerScriptPath,
    (next) => next.loaded || next.running,
    3000,
  );
  if (afterBootstrap.running) {
    return assertLaunchdRunningStatus(afterBootstrap, "start");
  }
  try {
    runCommand("launchctl", ["kickstart", "-k", launchdTarget()]);
  } catch (err) {
    afterBootstrap = waitForLaunchd(
      schedulerScriptPath,
      (next) => next.running,
      3000,
    );
    if (afterBootstrap.running) {
      return assertLaunchdRunningStatus(afterBootstrap, "start");
    }
    throw err;
  }
  return assertLaunchdRunningStatus(
    waitForLaunchd(schedulerScriptPath, (next) => next.running, 3000),
    "start",
  );
}

function sentinelLaunchdProcessEnvironment(pid) {
  if (!pid) return "";
  const result = spawnSync("ps", ["-p", String(pid), "-wwE"], {
    encoding: "utf8",
  });
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function reloadSentinelLaunchdJob() {
  bootoutLaunchdJob(sentinelLaunchdTarget());
  runCommandAllow(
    "launchctl",
    ["bootstrap", `gui/${process.getuid()}`, sentinelLaunchAgentPath()],
    [3],
  );
  return waitForSentinelLaunchd((next) => next.loaded || next.running, 3000);
}

function waitForSentinelLaunchd(predicate, timeoutMs = 5000) {
  const started = Date.now();
  let status = sentinelLaunchdStatus();
  while (!predicate(status) && Date.now() - started < timeoutMs) {
    sleepMs(250);
    status = sentinelLaunchdStatus();
  }
  return status;
}

function launchdStop(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  const current = launchdStatus(schedulerScriptPath);
  if (current.loaded) {
    bootoutLaunchdJob(launchdTarget());
  }
  return launchdStatus(schedulerScriptPath);
}

function launchdUninstall(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  const current = launchdStatus(schedulerScriptPath);
  if (current.loaded) {
    bootoutLaunchdJob(launchdTarget());
  }
  rmSync(launchAgentPath(), { force: true });
  return launchdStatus(schedulerScriptPath);
}

function systemdInstall(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  assertDevServiceConfiguration();
  const path = systemdUnitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, systemdContent(schedulerScriptPath), "utf8");
  runCommand("systemctl", ["--user", "daemon-reload"]);
  return systemdStatus(schedulerScriptPath);
}

function systemdStatus(schedulerScriptPath) {
  const definitionPath = systemdUnitPath();
  const installed = existsSync(definitionPath);
  let loaded = false;
  let running = false;
  let pid = null;
  if (installed) {
    const result = spawnSync(
      "systemctl",
      [
        "--user",
        "show",
        SYSTEMD_UNIT,
        "--property=LoadState,ActiveState,SubState,MainPID",
      ],
      { encoding: "utf8" },
    );
    const text = `${result.stdout || ""}`;
    loaded = text.includes("LoadState=loaded");
    running = text.includes("ActiveState=active");
    const match = text.match(/MainPID=(\d+)/);
    if (match && Number(match[1]) > 0) {
      pid = Number(match[1]);
    }
  }
  return {
    mode: "systemd",
    unit: SYSTEMD_UNIT,
    installed,
    loaded,
    running,
    pid,
    definition_path: definitionPath,
    logs: logPaths(),
    scheduler_script: serviceScriptPath(schedulerScriptPath),
  };
}

function systemdStart(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  assertDevServiceConfiguration();
  const current = systemdStatus(schedulerScriptPath);
  if (!current.installed) {
    systemdInstall(schedulerScriptPath);
  }
  runCommand("systemctl", ["--user", "daemon-reload"]);
  runCommand("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  runCommand("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  return systemdStatus(schedulerScriptPath);
}

function systemdStop(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  const current = systemdStatus(schedulerScriptPath);
  if (current.installed) {
    runCommand("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
  }
  return systemdStatus(schedulerScriptPath);
}

function systemdUninstall(schedulerScriptPath) {
  assertServiceMutationAllowed(schedulerScriptPath);
  const current = systemdStatus(schedulerScriptPath);
  if (current.installed) {
    spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], {
      encoding: "utf8",
    });
    rmSync(systemdUnitPath(), { force: true });
    runCommand("systemctl", ["--user", "daemon-reload"]);
  }
  return systemdStatus(schedulerScriptPath);
}

export function serviceInstall(schedulerScriptPath) {
  assertNodeRuntimeContract();
  const mode = detectServiceMode();
  let result;
  if (mode === "fake") result = fakeInstall(schedulerScriptPath);
  else if (mode === "launchd") result = launchdInstall(schedulerScriptPath);
  else if (mode === "systemd") result = systemdInstall(schedulerScriptPath);
  else throw new Error("service mode unsupported on this platform");
  appendActivityEvent({
    type: "service_installed",
    source: "cli",
    data: {
      mode,
      definition_path: result.definition_path || null,
      scheduler_script: result.scheduler_script || null,
    },
  });
  return result;
}

export function serviceStart(schedulerScriptPath) {
  assertNodeRuntimeContract();
  const mode = detectServiceMode();
  let result;
  if (mode === "fake") result = fakeStart(schedulerScriptPath);
  else if (mode === "launchd") result = launchdStart(schedulerScriptPath);
  else if (mode === "systemd") result = systemdStart(schedulerScriptPath);
  else throw new Error("service mode unsupported on this platform");
  if (result.running) {
    trackHealthTransition("service", "ok");
  }
  return result;
}

export function serviceStop(schedulerScriptPath) {
  const mode = detectServiceMode();
  let result;
  if (mode === "fake") result = fakeStop(schedulerScriptPath);
  else if (mode === "launchd") result = launchdStop(schedulerScriptPath);
  else if (mode === "systemd") result = systemdStop(schedulerScriptPath);
  else throw new Error("service mode unsupported on this platform");
  trackHealthTransition("service", "service_not_running");
  return result;
}

export function serviceRestart(schedulerScriptPath) {
  serviceStop(schedulerScriptPath);
  return serviceStart(schedulerScriptPath);
}

export function serviceUninstall(schedulerScriptPath) {
  const mode = detectServiceMode();
  let result;
  if (mode === "fake") result = fakeUninstall(schedulerScriptPath);
  else if (mode === "launchd") result = launchdUninstall(schedulerScriptPath);
  else if (mode === "systemd") result = systemdUninstall(schedulerScriptPath);
  else throw new Error("service mode unsupported on this platform");
  trackHealthTransition("service", "service_not_running");
  return result;
}

export function serviceStatus(schedulerScriptPath, options = {}) {
  const mode = detectServiceMode();
  const withDiagnostics = (status) =>
    options.includeDiagnostics === false
      ? (({ raw: _raw, ...publicStatus }) => publicStatus)(status)
      : withServiceDiagnostics(status, options);
  if (mode === "fake") return withDiagnostics(fakeStatus(schedulerScriptPath));
  if (mode === "launchd")
    return withDiagnostics(launchdStatus(schedulerScriptPath));
  if (mode === "systemd")
    return withDiagnostics(systemdStatus(schedulerScriptPath));
  return withDiagnostics({
    mode: "unsupported",
    installed: false,
    loaded: false,
    running: false,
    pid: null,
    definition_path: null,
    logs: logPaths(),
    scheduler_script: serviceScriptPath(schedulerScriptPath),
  });
}

function installSentinelScript(schedulerScriptPath) {
  ensureGlobalRuntimeDirs();
  mkdirSync(sentinelRoot(), { recursive: true });
  const source = sentinelScriptSourcePath(schedulerScriptPath);
  const target = sentinelScriptInstallPath();
  // launchd runs the sentinel from the repo source directly (see
  // sentinelPlistContent), the same model used for the scheduler daemon. We do
  // NOT execute a standalone copy: the sentinel imports ./lib/*.mjs and that
  // The sentinel imports local runtime modules, so a bare copy in ~/.helm cannot
  // resolve the lib tree and crash-loops on ERR_MODULE_NOT_FOUND.
  // Keep an install-path marker (symlink -> source) so install/status/uninstall
  // bookkeeping has a stable artifact to detect; fall back to a copy only if the
  // platform rejects symlinks.
  rmSync(target, { force: true });
  try {
    symlinkSync(source, target);
  } catch {
    copyFileSync(source, target);
    chmodSync(target, 0o755);
  }
  return target;
}

function fakeSentinelState() {
  return readJsonIfExistsLocal(sentinelFakeStatePath(), {
    installed: false,
    running: false,
    updated_at: null,
  });
}

function readJsonIfExistsLocal(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveFakeSentinelState(patch) {
  mkdirSync(sentinelRoot(), { recursive: true });
  const next = { ...fakeSentinelState(), ...patch, updated_at: nowIso() };
  writeFileSync(
    sentinelFakeStatePath(),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  return next;
}

function sentinelLaunchdStatus() {
  const definitionPath = sentinelLaunchAgentPath();
  const installed =
    existsSync(definitionPath) && existsSync(sentinelScriptInstallPath());
  let definitionText = "";
  try {
    definitionText = readFileSync(definitionPath, "utf8");
  } catch {
    definitionText = "";
  }
  let loaded = false;
  let running = false;
  let pid = null;
  let raw = "";
  let processRaw = "";
  if (installed) {
    const result = spawnSync("launchctl", ["print", sentinelLaunchdTarget()], {
      encoding: "utf8",
    });
    raw = `${result.stdout || ""}${result.stderr || ""}`;
    loaded = result.status === 0;
    const match = raw.match(/pid = (\d+)/);
    if (match) {
      running = true;
      pid = Number(match[1]);
      processRaw = sentinelLaunchdProcessEnvironment(pid);
    }
  }
  const repairMode = sentinelRepairModeState({
    definitionText,
    launchdRaw: raw,
    processRaw,
    loaded,
  });
  return {
    mode: "launchd",
    label: sentinelLabel(),
    installed,
    loaded,
    running,
    pid,
    definition_path: definitionPath,
    script_path: sentinelScriptInstallPath(),
    ...repairMode,
    helm_home: plistValue(definitionText, "HELM_HOME") || null,
    logs: sentinelLogPaths(),
    raw,
  };
}

function fakeSentinelStatus() {
  const state = fakeSentinelState();
  const repairMode =
    state.repair_mode ||
    process.env.HELM_SENTINEL_REPAIR_MODE ||
    SENTINEL_DEFAULT_REPAIR_MODE;
  return {
    mode: "fake",
    label: sentinelLabel(),
    installed: Boolean(
      state.installed && existsSync(sentinelScriptInstallPath()),
    ),
    loaded: Boolean(state.running),
    running: Boolean(state.running),
    pid: null,
    definition_path: sentinelFakeStatePath(),
    script_path: sentinelScriptInstallPath(),
    repair_mode: repairMode,
    configured_repair_mode: repairMode,
    runtime_repair_mode: repairMode,
    repair_mode_drift: false,
    health: { healthy: true, reason: "ok" },
    helm_home: globalRuntimeRoot(),
    logs: sentinelLogPaths(),
  };
}

export function sentinelInstall(schedulerScriptPath) {
  installSentinelScript(schedulerScriptPath);
  if (detectServiceMode() === "fake") {
    saveFakeSentinelState({
      installed: true,
      running: false,
      repair_mode:
        process.env.HELM_SENTINEL_REPAIR_MODE || SENTINEL_DEFAULT_REPAIR_MODE,
    });
    return fakeSentinelStatus();
  }
  const path = sentinelLaunchAgentPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    sentinelPlistContent(sentinelScriptSourcePath(schedulerScriptPath)),
    "utf8",
  );
  return sentinelLaunchdStatus();
}

export function sentinelStart(schedulerScriptPath) {
  if (detectServiceMode() === "fake") {
    if (!fakeSentinelState().installed) sentinelInstall(schedulerScriptPath);
    saveFakeSentinelState({ installed: true, running: true });
    return fakeSentinelStatus();
  }
  let status = sentinelLaunchdStatus();
  if (!status.installed) {
    sentinelInstall(schedulerScriptPath);
    status = sentinelLaunchdStatus();
  }
  if (status.loaded && status.repair_mode_drift) {
    status = reloadSentinelLaunchdJob();
  }
  if (!status.loaded) {
    runCommandAllow(
      "launchctl",
      ["bootstrap", `gui/${process.getuid()}`, sentinelLaunchAgentPath()],
      [3],
    );
    status = waitForSentinelLaunchd((next) => next.loaded, 3000);
  }
  runCommandAllow(
    "launchctl",
    ["kickstart", "-k", sentinelLaunchdTarget()],
    [3],
  );
  return sentinelLaunchdStatus();
}

export function sentinelStop() {
  if (detectServiceMode() === "fake") {
    saveFakeSentinelState({ running: false });
    return fakeSentinelStatus();
  }
  if (sentinelLaunchdStatus().loaded) {
    bootoutLaunchdJob(sentinelLaunchdTarget());
  }
  return sentinelLaunchdStatus();
}

export function sentinelUninstall() {
  if (detectServiceMode() === "fake") {
    saveFakeSentinelState({ installed: false, running: false });
    rmSync(sentinelScriptInstallPath(), { force: true });
    return fakeSentinelStatus();
  }
  if (sentinelLaunchdStatus().loaded) {
    bootoutLaunchdJob(sentinelLaunchdTarget());
  }
  rmSync(sentinelLaunchAgentPath(), { force: true });
  rmSync(sentinelScriptInstallPath(), { force: true });
  return sentinelLaunchdStatus();
}

export function sentinelStatus() {
  if (detectServiceMode() === "fake") return fakeSentinelStatus();
  if (process.platform === "darwin") return sentinelLaunchdStatus();
  return {
    mode: "unsupported",
    label: sentinelLabel(),
    installed: existsSync(sentinelScriptInstallPath()),
    loaded: false,
    running: false,
    pid: null,
    definition_path: null,
    script_path: sentinelScriptInstallPath(),
    repair_mode: null,
    configured_repair_mode: null,
    runtime_repair_mode: null,
    repair_mode_drift: false,
    health: { healthy: true, reason: "unsupported" },
    helm_home: globalRuntimeRoot(),
    logs: sentinelLogPaths(),
  };
}

export function serviceDefinitionForTest(schedulerScriptPath) {
  return serviceDefinition(schedulerScriptPath);
}

export const _internals = {
  assertLaunchdRunningStatus,
  schedulerServiceTemplateState,
  sentinelRepairModeState,
  systemdContent,
};
