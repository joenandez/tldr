import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { daemonLockPid } from "../../messaging/src/cli/bootstrap.mjs";
import { isProcessAlive } from "./process_liveness.mjs";
import { defaultStateRoot } from "./state_root_layout.mjs";

// Full-uninstall removal of the product's messaging, tasks, and lifecycle
// state. It runs only after the signed app confirmed and removed itself; the
// source lifecycle calls it once hooks and the agent daemon are gone.
export const HELM_LAUNCHD_LABELS = Object.freeze([
  {
    label: "ai.helm.scheduler",
    script: "scheduling/src/helm-daemon.mjs",
  },
  {
    label: "ai.helm.sentinel",
    script: "scheduling/src/sentinel.mjs",
  },
]);
const TIGHTBEAM_STOP_TIMEOUT_MS = 10_000;
const TIGHTBEAM_STOP_POLL_MS = 100;

function logRemoval(level, event, params) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, params })}\n`,
  );
}

function removalError(code, message, params = {}) {
  logRemoval("error", "product_removal_failed", { code, ...params });
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameIdentity(stat, identity) {
  return (
    Boolean(stat && identity) &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino
  );
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function rootKind(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "symlink";
    return stat.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    return "unreadable";
  }
}

export function createProductStateRemoval({
  roots,
  commandRunner = spawnSync,
  signalProcess = (pid, signal) => process.kill(pid, signal),
  isAlive = isProcessAlive,
  readLockPid = daemonLockPid,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  stopTimeoutMs = TIGHTBEAM_STOP_TIMEOUT_MS,
  userHome = homedir(),
}) {
  // Removal order: messaging, then tasks, then the lifecycle (agent) root
  // that holds the running runtime.
  const ordered = [
    ["tightbeam", resolve(roots.tightbeam)],
    ["helm", resolve(roots.helm)],
    ["agent", resolve(roots.agent)],
  ];

  // Every root is <home>/.tldr-agents/<component>, the layout the state-root
  // resolvers produce, so the product parent is the one shared ancestor.
  const productParent = dirname(resolve(roots.agent));
  const productHome = dirname(productParent);

  function unsafePath(component, details) {
    return removalError(
      "product_state_unsafe_path",
      `tldr; ${component} state root is not a removable directory`,
      { component, ...details },
    );
  }

  // Validates the layout, then records the identity of the product parent
  // and of each existing root; removal is bound to exactly these directories.
  function assertRemovable() {
    for (const [component, path] of ordered) {
      const expected = resolve(defaultStateRoot(component, productHome));
      if (path !== expected) {
        throw unsafePath(component, { kind: "outside_layout", broad: false });
      }
    }
    const parentKind = rootKind(productParent);
    if (parentKind !== "absent" && parentKind !== "directory") {
      throw unsafePath("product_parent", { kind: parentKind, broad: false });
    }
    const realParent =
      parentKind === "directory" ? realpathSync(productParent) : null;
    const validated = {
      parent: parentKind === "directory" ? lstatSync(productParent) : null,
      roots: {},
    };
    for (const [component, path] of ordered) {
      const kind = rootKind(path);
      const broad = path === "/" || path === resolve(userHome);
      if (broad || (kind !== "absent" && kind !== "directory")) {
        throw unsafePath(component, { kind, broad });
      }
      if (kind !== "directory") continue;
      if (realpathSync(path) !== join(realParent, basename(path))) {
        throw unsafePath(component, { kind: "realpath_mismatch", broad });
      }
      validated.roots[component] = lstatSync(path);
    }
    return validated;
  }

  function verifyHelmServicesAbsent() {
    for (const { label } of HELM_LAUNCHD_LABELS) {
      const target = `gui/${process.getuid()}/${label}`;
      const printed = commandRunner("launchctl", ["print", target], {
        encoding: "utf8",
      });
      if (Number(printed?.status ?? 1) === 0) {
        throw removalError(
          "helm_service_still_loaded",
          `Helm launchd service ${label} is still loaded after uninstall`,
          { label },
        );
      }
    }
    logRemoval("info", "product_removal_step", {
      component: "helm_services",
      result: "absent",
    });
  }

  async function waitForExit(pid) {
    const deadline = now() + stopTimeoutMs;
    while (isAlive(pid)) {
      if (now() >= deadline) return false;
      // eslint-disable-next-line no-await-in-loop -- Poll one process until it exits or the deadline passes.
      await sleep(TIGHTBEAM_STOP_POLL_MS);
    }
    return true;
  }

  // The lock holder is this root's daemon; a live PID running anything else
  // is a stale lock whose PID was reused, and is never signalled.
  function isTightbeamDaemon(pid) {
    const listed = commandRunner(
      "/bin/ps",
      ["-o", "command=", "-p", `${pid}`],
      {
        encoding: "utf8",
      },
    );
    return String(listed?.stdout || "").includes("tightbeam-daemon");
  }

  async function stopTightbeamDaemon() {
    const root = roots.tightbeam;
    const pid = readLockPid(root);
    if (!pid || !isAlive(pid) || !isTightbeamDaemon(pid)) {
      logRemoval("info", "product_removal_step", {
        component: "tightbeam_daemon",
        result: "not_running",
        lock_pid: pid,
      });
      return;
    }
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        signalProcess(pid, signal);
      } catch (error) {
        if (error?.code !== "ESRCH") {
          throw removalError(
            "tightbeam_daemon_stop_failed",
            `Tightbeam daemon ${pid} could not be signalled`,
            { pid, signal, errno: error?.code ?? null },
          );
        }
      }
      // eslint-disable-next-line no-await-in-loop -- SIGKILL is sent only after SIGTERM's wait fails.
      if (await waitForExit(pid)) {
        logRemoval("info", "product_removal_step", {
          component: "tightbeam_daemon",
          result: "stopped",
          pid,
          signal,
        });
        return;
      }
    }
    throw removalError(
      "tightbeam_daemon_stop_failed",
      `Tightbeam daemon ${pid} is still running`,
      { pid },
    );
  }

  function changedError(component, stage) {
    return removalError(
      "product_state_changed",
      `tldr; ${component} state changed after it was validated; nothing was removed`,
      { component, stage },
    );
  }

  // Renames the validated root into a random sibling under the verified
  // parent and deletes that only if it is still the validated directory, so a
  // swap between validation and removal fails instead of deleting elsewhere.
  // A quarantine that is not deleted goes back to its root, so a retry finds
  // the remaining state where it was validated.
  function restoreQuarantine(component, quarantine, path) {
    try {
      renameSync(quarantine, path);
    } catch (error) {
      logRemoval("error", "product_removal_restore_failed", {
        component,
        errno: error?.code ?? null,
        stack: error?.stack ?? null,
      });
    }
  }

  function renameIntoQuarantine(component, path) {
    const quarantine = join(
      productParent,
      `.uninstall-${component}-${randomBytes(8).toString("hex")}`,
    );
    try {
      renameSync(path, quarantine);
    } catch (error) {
      throw removalError(
        "product_state_removal_failed",
        `tldr; ${component} state could not be removed`,
        { component, errno: error?.code ?? null },
      );
    }
    return quarantine;
  }

  function quarantineRoot(component, path, validated) {
    const identity = validated.roots[component];
    const current = lstatOrNull(path);
    if (!identity) {
      if (current) throw changedError(component, "appeared");
      return null;
    }
    const parentUnchanged = () =>
      sameIdentity(lstatOrNull(productParent), validated.parent);
    if (!parentUnchanged()) throw changedError(component, "parent");
    if (!sameIdentity(current, identity)) throw changedError(component, "root");
    const quarantine = renameIntoQuarantine(component, path);
    if (
      !sameIdentity(lstatOrNull(quarantine), identity) ||
      !parentUnchanged()
    ) {
      restoreQuarantine(component, quarantine, path);
      throw changedError(component, "quarantine");
    }
    return quarantine;
  }

  function removeRoot(component, path, validated) {
    const quarantine = quarantineRoot(component, path, validated);
    if (!quarantine) return;
    let failure = null;
    try {
      rmSync(quarantine, { recursive: true, force: true });
    } catch (error) {
      failure = error;
    }
    if (failure || existsSync(quarantine)) {
      restoreQuarantine(component, quarantine, path);
      throw removalError(
        "product_state_removal_failed",
        `tldr; ${component} state could not be removed`,
        { component, errno: failure?.code ?? null },
      );
    }
    if (existsSync(path)) {
      throw removalError(
        "product_state_removal_failed",
        `tldr; ${component} state is still present`,
        { component },
      );
    }
    logRemoval("info", "product_removal_step", {
      component: `${component}_state`,
      result: "removed",
    });
  }

  async function removeProductState({ agentDaemon = null } = {}) {
    const validated = assertRemovable();
    if (agentDaemon?.loaded || agentDaemon?.running) {
      throw removalError(
        "agent_daemon_still_loaded",
        "tldr; daemon is still loaded; its state was not removed",
        { loaded: Boolean(agentDaemon.loaded) },
      );
    }
    await stopTightbeamDaemon();
    for (const [component, path] of ordered) {
      removeRoot(component, path, validated);
    }
    return { cleaned: true, removed: ordered.map(([component]) => component) };
  }

  // The signed app's product-uninstall entry may already have removed every
  // root; a later CLI uninstall then only confirms Helm is gone.
  function confirmAlreadyRemoved() {
    if (ordered.some(([, path]) => rootKind(path) !== "absent")) return null;
    verifyHelmServicesAbsent();
    logRemoval("info", "product_removal_step", {
      component: "product_state",
      result: "already_removed",
    });
    return { ok: true, action: "uninstall", already_removed: true };
  }

  // The install lifecycle reports a failed owned-state cleanup as a result,
  // not a throw; a partial removal must never read as success.
  function assertComplete(result) {
    if (result?.ok === true) return result;
    throw removalError(
      result?.error || "uninstall_incomplete",
      "tldr; uninstall did not remove all state",
      { action: result?.action ?? null },
    );
  }

  return Object.freeze({
    assertComplete,
    assertRemovable,
    confirmAlreadyRemoved,
    verifyHelmServicesAbsent,
    removeProductState,
  });
}
