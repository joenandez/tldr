import { spawnSync } from "node:child_process";

const LAUNCHCTL = "/bin/launchctl";
const AQUA = "Aqua";

function defaultRun() {
  return spawnSync(LAUNCHCTL, ["managername"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5_000,
  });
}

// A macOS GUI (Aqua) session is required before tldr; may open the setup app or
// the macOS Installer. Without one, /usr/bin/open blocks until its caller times
// out, so every GUI-bound path must fail closed instead of waiting.
export function hasGuiSession({ env = process.env, run = defaultRun } = {}) {
  if (env.TLDR_AGENT_ASSUME_GUI_SESSION === "0") return false;
  if (env.TLDR_AGENT_ASSUME_GUI_SESSION === "1") return true;
  // A build agent can hold an Aqua session it must never draw into.
  if (env.CI) return false;
  if (process.platform !== "darwin") return false;
  let result;
  try {
    result = run();
  } catch {
    return false;
  }
  if (!result || result.status !== 0) return false;
  return String(result.stdout || "").trim() === AQUA;
}

// Bare `tldr-agent` serves a person at a Mac and an automated caller. Open the
// configurable app when there is a screen to draw on, otherwise answer with the
// safe read-only projection.
export function defaultStarportOperation(options) {
  return hasGuiSession(options) ? "configure" : "status";
}

// The macOS Installer needs a window. Without an Aqua session "open -W" waits
// for a window that never appears, so refuse before starting the wait.
export function requireGuiSession(options) {
  if (hasGuiSession(options)) return;
  throw Object.assign(new Error("NATIVE_INSTALLER_REQUIRES_GUI"), {
    code: "NATIVE_INSTALLER_REQUIRES_GUI",
  });
}
