import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function commandReportsAbsent(command, arguments_) {
  const observed = spawnSync(command, arguments_, {
    encoding: "utf8",
    stdio: "ignore",
    timeout: 5_000,
  });
  return !observed.error && observed.status !== null && observed.status !== 0;
}

const AEGIS_SYSTEM_PATHS = Object.freeze([
  "/Library/LaunchDaemons/ai.codename.aegis.broker.plist",
  "/var/run/ai.codename.aegis.broker.sock",
]);
const PLUGIN_REMOVAL_GUIDANCE =
  "Claude Code: claude plugin uninstall tldr@tldr\n" +
  "Codex: codex plugin remove tldr@tldr";

// The signed app's removal is the confirmation signal. The product state
// roots (~/.tldr-agents/{agent,helm,tightbeam}) are not part of it: the
// source uninstall removes and verifies them only after this reports
// `uninstalled`, from the runtime that lives in the agent root.
export function inspectDefaultUninstallResidue({
  nativeSetupApp,
  userHome = homedir(),
  userID = process.getuid?.(),
  systemPaths = AEGIS_SYSTEM_PATHS,
  reportsAbsent = commandReportsAbsent,
} = {}) {
  if (!Number.isSafeInteger(userID) || !nativeSetupApp) return false;
  const paths = [
    join(userHome, "Library", "LaunchAgents", "ai.tldr-agent.daemon.plist"),
    nativeSetupApp,
    ...systemPaths,
  ];
  return (
    paths.every((path) => !existsSync(path)) &&
    reportsAbsent("/bin/launchctl", [
      "print",
      `gui/${userID}/ai.tldr-agent.daemon`,
    ]) &&
    reportsAbsent("/bin/launchctl", [
      "print",
      "system/ai.codename.aegis.broker",
    ]) &&
    ["arm64", "x86_64"].every((architecture) =>
      reportsAbsent("/usr/sbin/pkgutil", [
        "--pkg-info",
        `ai.codename.aegis.${architecture}`,
      ]),
    )
  );
}

export async function observeNativeSetup({
  launchOperation,
  readStatus,
  polling,
  wait,
  result,
}) {
  const failed = await launchOperation();
  if (failed) return failed;
  async function observe(attempt) {
    const observed = await readStatus();
    if (observed.data.status !== "pending_verification") return observed;
    if (attempt + 1 < polling.attempts) {
      await wait(polling.intervalMs);
      return observe(attempt + 1);
    }
    return result("confirmation-required", "Continue setting up tldr;");
  }
  return observe(0);
}

export async function observeNativeUninstall({
  launchOperation,
  inspectUninstallResidue,
  polling,
  wait,
  result,
}) {
  const failed = await launchOperation();
  if (failed) return failed;
  async function observe(attempt) {
    let removed = false;
    try {
      removed = (await inspectUninstallResidue()) === true;
    } catch {
      removed = false;
    }
    if (removed) return result("uninstalled");
    if (attempt + 1 < polling.attempts) {
      await wait(polling.intervalMs);
      return observe(attempt + 1);
    }
    return result("uninstall-incomplete", "Uninstall tldr;");
  }
  return observe(0);
}

// Full uninstall behind the signed app's protected confirmation. A
// never-connected install has no app yet, so this explicit request (and only
// this one) first installs the bundled app through the setup installer.
// Nothing is removed unless the app confirms removal.
export async function uninstallStarport({
  inspectComponents,
  native,
  source,
  result,
  log,
}) {
  const uninstalled = () =>
    result("uninstalled", [], "remove-plugin", PLUGIN_REMOVAL_GUIDANCE);
  const incomplete = (components, remediation = "Uninstall tldr;") =>
    result("uninstall-incomplete", components, "retry-uninstall", remediation);
  const failed = (stage, error) =>
    log("error", "starport_uninstall_incomplete", {
      operation: "uninstall",
      stage,
      code: error?.code ?? null,
      message: error?.message ?? null,
      stack: error?.stack ?? null,
    });
  const inspected = await inspectComponents();
  const appInstalled = inspected?.aegis === true;
  const productState =
    inspected?.runtime === true ||
    inspected?.service === true ||
    source?.hasProductState?.() === true;
  if (!appInstalled && !productState) {
    // Nothing to confirm or remove: installing the app just to uninstall it
    // would leave a fresh install behind if its admin prompt were canceled.
    log("info", "starport_stage", {
      operation: "uninstall",
      stage: "nothing_installed",
    });
    return uninstalled();
  }
  log("info", "starport_stage", {
    operation: "uninstall",
    stage: appInstalled ? "native_confirmation" : "native_app_install",
  });
  if (!appInstalled) {
    try {
      await source?.installNativeApp?.();
    } catch (error) {
      failed("native_app_install", error);
      return incomplete(
        ["aegis"],
        "Approve the tldr; installer, then uninstall tldr; again",
      );
    }
  }
  const confirmed = await native.uninstall?.();
  if (confirmed?.ok === false || confirmed?.data?.status !== "uninstalled") {
    return incomplete(["aegis", "service", "runtime"]);
  }
  try {
    const removed = await source?.uninstall?.();
    if (removed?.ok === false) {
      const error = new Error("source uninstall reported partial removal");
      error.code = removed.error || "uninstall_incomplete";
      throw error;
    }
  } catch (error) {
    failed("source", error);
    return incomplete(["service", "runtime"]);
  }
  return uninstalled();
}
