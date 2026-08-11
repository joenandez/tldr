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

export function inspectDefaultUninstallResidue({
  home = process.env.TLDR_AGENT_HOME || join(homedir(), ".tldr-agent"),
  nativeSetupApp,
  userID = process.getuid?.(),
} = {}) {
  if (!Number.isSafeInteger(userID) || !nativeSetupApp) return false;
  const paths = [
    home,
    join(homedir(), "Library", "LaunchAgents", "ai.tldr-agent.daemon.plist"),
    nativeSetupApp,
    "/Library/LaunchDaemons/ai.codename.aegis.broker.plist",
    "/var/run/ai.codename.aegis.broker.sock",
  ];
  return (
    paths.every((path) => !existsSync(path)) &&
    commandReportsAbsent("/bin/launchctl", [
      "print",
      `gui/${userID}/ai.tldr-agent.daemon`,
    ]) &&
    commandReportsAbsent("/bin/launchctl", [
      "print",
      "system/ai.codename.aegis.broker",
    ]) &&
    ["arm64", "x86_64"].every((architecture) =>
      commandReportsAbsent("/usr/sbin/pkgutil", [
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
