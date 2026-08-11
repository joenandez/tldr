import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { isProcessAlive } from "./process_liveness.mjs";

const TLDR_AGENT_DAEMON_LABEL = "ai.tldr-agent.daemon";
const DEFAULT_QUIESCE_TIMEOUT_MS = 15_000;

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// tldr; has no retained Helm equivalent for this coordinator: Helm service
// install owns broader scheduler surfaces, while tldr; v1 must touch only
// marker-owned runtime hooks and the tldr; launchd entry.
export function createTldrAgentInstallLifecycle({
  launchd,
  runtimes = ["claude", "codex"],
  manageHooks,
  initializeReadBoundary = null,
  desiredState = null,
  verifyDaemon = null,
  releaseOwnership = null,
  cleanupOwnedState = null,
} = {}) {
  if (!launchd || typeof manageHooks !== "function") {
    throw new TypeError("tldr; install lifecycle requires launchd and hooks");
  }
  async function hooks(action) {
    const report = [];
    for (const runtime of runtimes) {
      // eslint-disable-next-line no-await-in-loop -- hook files are updated per runtime.
      report.push(await manageHooks({ action, runtime }));
    }
    return report;
  }
  async function allowDaemonStart(reason) {
    if (typeof desiredState?.set !== "function") return null;
    const state = await desiredState.set({
      mode: "live",
      lockout: "none",
      reason,
    });
    if (state?.allowed_to_start !== true) {
      throw new Error("tldr; desired state blocks daemon start");
    }
    return state;
  }
  async function ensureReadBoundary() {
    if (typeof initializeReadBoundary !== "function") return null;
    const result = await initializeReadBoundary();
    if (result?.ok !== true) {
      throw new Error("tldr; unread boundary initialization failed");
    }
    return result;
  }
  async function blockDaemonStart(reason) {
    if (typeof desiredState?.set !== "function") return null;
    const state = await desiredState.set({
      mode: "disabled",
      lockout: "none",
      reason,
    });
    if (state?.allowed_to_start !== false) {
      throw new Error("tldr; desired state did not block daemon start");
    }
    return state;
  }
  async function removeOwnedState(action, daemon) {
    const cleanup = await cleanupOwnedState?.();
    if (cleanup?.cleaned !== true) {
      return {
        ok: false,
        action,
        daemon,
        error: "owned_state_cleanup_failed",
      };
    }
    const ownership = await releaseOwnership?.();
    if (ownership?.released === false) {
      return {
        ok: false,
        action,
        daemon,
        cleanup,
        error: "ownership_release_failed",
      };
    }
    return { ok: true, action, daemon, cleanup };
  }
  async function verifiedDaemon(startDaemon) {
    let primaryError = null;
    try {
      const observation = await startDaemon();
      if (typeof verifyDaemon !== "function") return observation;
      const verification = await verifyDaemon(observation, {
        observeDaemon: () => launchd.status(),
      });
      if (verification?.ready !== true) {
        throw new Error("tldr; daemon did not become ready");
      }
      return launchd.status();
    } catch (error) {
      primaryError = error;
    }
    const cleanupErrors = [];
    try {
      await blockDaemonStart("tldr_agent_readiness_failed");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await launchd.unload();
    } catch (error) {
      cleanupErrors.push(error);
    }
    const error = new Error("tldr; daemon readiness check failed", {
      cause: primaryError || cleanupErrors[0],
    });
    if (cleanupErrors.length > 0) error.cleanup_errors = cleanupErrors;
    throw error;
  }
  return Object.freeze({
    async install() {
      const hookReport = await hooks("install");
      await ensureReadBoundary();
      const desired = await allowDaemonStart("tldr_agent_install");
      const daemon = await verifiedDaemon(() =>
        typeof launchd.converge === "function"
          ? launchd.converge()
          : launchd.load(),
      );
      return {
        ok: true,
        action: "install",
        hooks: hookReport,
        daemon,
        ...(desired ? { desired_state: desired } : {}),
      };
    },
    async prepareUpdate() {
      const hookReport = await hooks("install");
      const requestedStop = await launchd.unload();
      const stopped =
        typeof launchd.waitForUnloaded === "function"
          ? await launchd.waitForUnloaded()
          : requestedStop;
      if (stopped?.loaded || stopped?.running) {
        throw lifecycleError(
          "DAEMON_QUIESCE_TIMEOUT",
          "tldr; daemon did not quiesce before update",
        );
      }
      return Object.freeze({ hookReport });
    },
    async activatePreparedUpdate(prepared) {
      if (!prepared || !Array.isArray(prepared.hookReport)) {
        throw new TypeError("tldr; update preparation is invalid");
      }
      await ensureReadBoundary();
      const desired = await allowDaemonStart("tldr_agent_update");
      const daemon = await verifiedDaemon(() => launchd.reload());
      return {
        ok: true,
        action: "update",
        hooks: prepared.hookReport,
        daemon,
        ...(desired ? { desired_state: desired } : {}),
      };
    },
    async update({ beforeActivate = null } = {}) {
      if (beforeActivate !== null && typeof beforeActivate !== "function") {
        throw new TypeError("tldr; update activation hook is invalid");
      }
      const prepared = await this.prepareUpdate();
      try {
        await beforeActivate?.();
        return await this.activatePreparedUpdate(prepared);
      } catch (error) {
        try {
          await this.activatePreparedUpdate(prepared);
        } catch (restoreError) {
          error.rollback_cause = restoreError;
        }
        throw error;
      }
    },
    async uninstall() {
      await launchd.unload();
      const hookReport = await hooks("uninstall");
      const daemon = await launchd.uninstall();
      const result = await removeOwnedState("uninstall", daemon);
      return { ...result, hooks: hookReport };
    },
    async status() {
      return { ok: true, action: "status", daemon: launchd.status() };
    },
  });
}

// tldr;-specific injection seam for launchd lifecycle tests. Production
// supplies the retained plist renderer; tests supply an isolated domain/root.
export function createTldrAgentLaunchdLifecycle({
  schedulerScriptPath,
  launchAgentsDir = join(homedir(), "Library", "LaunchAgents"),
  domain = `gui/${process.getuid()}`,
  devName = null,
  commandRunner = (command, args) =>
    spawnSync(command, args, { encoding: "utf8" }),
  isPidAlive = isProcessAlive,
  renderDefinition,
  now = Date.now,
  sleepSync = (milliseconds) =>
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      0,
      0,
      milliseconds,
    ),
  quiesceTimeoutMs = DEFAULT_QUIESCE_TIMEOUT_MS,
  reloadTimeoutMs = 2_000,
} = {}) {
  if (typeof renderDefinition !== "function") {
    throw new TypeError("tldr; launchd lifecycle requires plist renderer");
  }
  if (devName && !/^[a-zA-Z0-9._-]+$/.test(devName)) {
    throw new TypeError("tldr; launchd dev name is invalid");
  }
  const label = devName
    ? `${TLDR_AGENT_DAEMON_LABEL}.dev.${devName}`
    : TLDR_AGENT_DAEMON_LABEL;
  const definitionPath = join(launchAgentsDir, `${label}.plist`);
  const target = `${domain}/${label}`;
  const run = (args, allowedStatuses = []) => {
    const result = commandRunner("launchctl", args) || {};
    const status = Number(result.status ?? 0);
    if (status !== 0 && !allowedStatuses.includes(status)) {
      throw new Error(
        String(
          result.stderr || result.stdout || `launchctl ${args[0]} failed`,
        ).trim(),
      );
    }
    return { ...result, status };
  };
  const status = () => {
    const installed = existsSync(definitionPath);
    // `launchctl print` is observational: any non-zero status means the
    // isolated job is not loaded and must not make status/cleanup throw.
    const printed = installed
      ? commandRunner("launchctl", ["print", target]) || {}
      : { status: 3 };
    printed.status = Number(printed.status ?? 0);
    const raw = `${printed.stdout || ""}${printed.stderr || ""}`;
    const match = raw.match(/pid = (\d+)/);
    const pid = match ? Number(match[1]) : null;
    return {
      mode: "launchd",
      label,
      installed,
      loaded: installed && printed.status === 0,
      running: Boolean(pid && isPidAlive(pid)),
      pid,
      definition_path: definitionPath,
      raw,
    };
  };
  const install = () => {
    mkdirSync(launchAgentsDir, { recursive: true });
    writeFileSync(
      definitionPath,
      renderDefinition(schedulerScriptPath),
      "utf8",
    );
    return status();
  };
  const unload = () => {
    if (status().loaded) run(["bootout", target], [3]);
    return status();
  };
  const waitForUnloaded = () => {
    const deadline = now() + quiesceTimeoutMs;
    let observed = status();
    while ((observed.loaded || observed.running) && now() < deadline) {
      sleepSync(25);
      observed = status();
    }
    return observed;
  };
  const load = () => {
    if (!existsSync(definitionPath)) install();
    if (!status().loaded) run(["bootstrap", domain, definitionPath]);
    return status();
  };
  const reload = () => {
    unload();
    waitForUnloaded();
    install();
    const deadline = now() + reloadTimeoutMs;
    let bootstrapped;
    do {
      bootstrapped = run(["bootstrap", domain, definitionPath], [5]);
      if (bootstrapped.status === 0) break;
      sleepSync(50);
    } while (now() < deadline);
    if (bootstrapped?.status !== 0) {
      throw new Error(
        String(
          bootstrapped?.stderr ||
            bootstrapped?.stdout ||
            "launchctl bootstrap failed",
        ).trim(),
      );
    }
    return status();
  };
  const converge = () => {
    if (status().loaded) return reload();
    install();
    return load();
  };
  const uninstall = () => {
    unload();
    rmSync(definitionPath, { force: true });
    return status();
  };
  return {
    definitionPath,
    target,
    install,
    converge,
    load,
    reload,
    unload,
    waitForUnloaded,
    uninstall,
    status,
  };
}
