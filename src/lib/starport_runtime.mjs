import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { createProductionOwnerSetupService } from "./aegis_native_setup_runtime.mjs";
import { createTldrAgentSourceInstallLifecycle } from "./tldr_agent_source_lifecycle.mjs";
import {
  readIdentity,
  resolveSessionFromPidAncestry,
} from "./identity_state.mjs";
import { resolveTldrAgentScope } from "./store.mjs";
import { installVerifiedLocalAegisPackage } from "./starport_aegis_package.mjs";
import { createStarportOnboarding } from "./starport_onboarding.mjs";
import { createStarportOrchestrator } from "./starport_orchestrator.mjs";

const AEGIS_APP =
  "/Library/Application Support/Codename/Aegis/TldrAgentAegis.app";
const AEGIS_TEAM_ID = "VVG962SM5J";
const ARCHITECTURES = new Set(["arm64", "x86_64"]);

function normalizedArchitecture(architecture = process.arch) {
  const value = architecture === "x64" ? "x86_64" : architecture;
  return ARCHITECTURES.has(value) ? value : null;
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function matchesFileRecord(root, record) {
  if (
    !root ||
    !record ||
    typeof record.path !== "string" ||
    record.path.startsWith("/") ||
    record.path.split("/").includes("..")
  ) {
    return false;
  }
  try {
    const path = resolve(root, record.path);
    if (!path.startsWith(`${resolve(root)}/`) || !statSync(path).isFile()) {
      return false;
    }
    const bytes = readFileSync(path);
    return (
      bytes.length === record.bytes &&
      createHash("sha256").update(bytes).digest("hex") === record.sha256
    );
  } catch {
    return false;
  }
}

function releaseMatchesSource(sourceRoot, release) {
  const packageJson = safeJson(join(sourceRoot, "package.json"));
  return (
    packageJson?.name === "@joenandez/tldr" && packageJson.version === release
  );
}

function resolveSetupSession(env = process.env) {
  const explicit = String(env.CLAUDE_CODE_SESSION_ID ?? "").trim();
  if (explicit) {
    const identity = readIdentity(explicit);
    return identity ? { sessionId: explicit, identity } : null;
  }
  const resolved = resolveSessionFromPidAncestry();
  return resolved.ok
    ? { sessionId: resolved.session_id, identity: resolved.identity }
    : null;
}

function unavailableOnboarding() {
  return Object.freeze({
    async status() {
      return Object.freeze({ status: "failed" });
    },
    async send() {
      return Object.freeze({ status: "failed" });
    },
  });
}

function shouldInstallBundledAegis({ appExists, nativeStatus }) {
  return (
    !appExists ||
    !["ready", "pending_verification", "unconfigured"].includes(nativeStatus)
  );
}

export function createStarportComponentInspector({
  home,
  sourceRoot,
  pluginRoot,
  activationManifest,
  architecture = normalizedArchitecture(),
  aegisApp = AEGIS_APP,
  launchAgent = join(
    homedir(),
    "Library",
    "LaunchAgents",
    "ai.tldr-agent.daemon.plist",
  ),
  nodeExecutable = process.execPath,
} = {}) {
  return async () => {
    const activation = safeJson(activationManifest);
    const release = activation?.release;
    const pluginManifest = activation?.plugin_manifest;
    const hookManifest = activation?.hook_manifest;
    const installedNode = join(home, "install", "runtime", "bin", "node");
    let activationRecord = null;
    try {
      const bytes = readFileSync(activationManifest);
      activationRecord = {
        path: "release/activation-manifest.json",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      activationRecord = null;
    }
    const activationHealthy = matchesFileRecord(pluginRoot, activationRecord);
    const pluginHealthy =
      activationHealthy &&
      matchesFileRecord(pluginRoot, pluginManifest) &&
      releaseMatchesSource(sourceRoot, release);
    const runtimeHealthy =
      activationHealthy &&
      Boolean(activation?.architectures?.[architecture]?.runtime) &&
      resolve(nodeExecutable) === resolve(installedNode) &&
      releaseMatchesSource(sourceRoot, release);
    const nativeInstalled = existsSync(aegisApp);
    return Object.freeze({
      plugin: pluginHealthy,
      runtime: runtimeHealthy,
      hooks: matchesFileRecord(pluginRoot, hookManifest),
      service: existsSync(launchAgent),
      aegis: nativeInstalled,
      outbound: nativeInstalled,
    });
  };
}

function bundledAegisInstaller({
  home,
  architecture = normalizedArchitecture(),
  installPackage = installVerifiedLocalAegisPackage,
} = {}) {
  return async () => {
    if (!architecture) throw new Error("Starport architecture unsupported");
    const installRoot = join(home, "install");
    const manifest = safeJson(join(installRoot, "activation-manifest.json"));
    const record = manifest?.architectures?.[architecture]?.aegis;
    const packagePath = join(installRoot, "TldrAgentAegis.pkg");
    if (
      !matchesFileRecord(installRoot, {
        ...record,
        path: basename(packagePath),
      })
    ) {
      throw new Error("Starport Aegis package integrity failed");
    }
    return installPackage({
      packagePath,
      artifact: {
        ...record,
        architecture,
        minimum_macos: "13.0",
        installer_team_id: AEGIS_TEAM_ID,
        package_identifier: `ai.codename.aegis.${architecture}`,
      },
    });
  };
}

export async function createProductionStarportRuntime({
  env = process.env,
  userHome = homedir(),
  native = null,
  source = null,
  onboarding = null,
  inspectComponents = null,
  installBundledAegis = null,
} = {}) {
  const home = resolve(env.TLDR_AGENT_HOME || join(userHome, ".tldr-agent"));
  env.TLDR_AGENT_HOME = home;
  env.HELM_HOME = home;
  env.HELM_CANONICAL_SQLITE = "1";
  delete env.HELM_CANONICAL_SQLITE_KILL_SWITCH;

  const sourceRoot = join(home, "install", "tldr-agent");
  const activationManifest = join(home, "install", "activation-manifest.json");
  const activePluginRoot = env.TLDR_AGENT_PLUGIN_ROOT
    ? resolve(env.TLDR_AGENT_PLUGIN_ROOT)
    : null;
  const nativeService = native ?? createProductionOwnerSetupService();
  const sourceLifecycle =
    source ??
    createTldrAgentSourceInstallLifecycle({ home, pluginHooksOwned: true });
  const installAegis = installBundledAegis ?? bundledAegisInstaller({ home });
  const sourceAdapter = Object.freeze({
    async install() {
      const observed = await nativeService.status();
      if (
        shouldInstallBundledAegis({
          appExists: existsSync(AEGIS_APP),
          nativeStatus: observed?.data?.status,
        })
      ) {
        await installAegis();
      }
      return sourceLifecycle.install();
    },
    uninstall: () => sourceLifecycle.uninstall(),
  });

  const session = resolveSetupSession(env);
  const scope = resolveTldrAgentScope({
    cwd: session?.identity?.cwd || process.cwd(),
    tldrAgentHome: home,
  });
  const onboardingService =
    onboarding ??
    (session
      ? createStarportOnboarding({
          sessionId: session.sessionId,
          scope,
          home,
        })
      : unavailableOnboarding());
  const inspector =
    inspectComponents ??
    createStarportComponentInspector({
      home,
      sourceRoot,
      pluginRoot: activePluginRoot,
      activationManifest,
    });
  return createStarportOrchestrator({
    inspectComponents: inspector,
    native: nativeService,
    onboarding: onboardingService,
    source: sourceAdapter,
  });
}

export const _internals = Object.freeze({
  AEGIS_APP,
  AEGIS_TEAM_ID,
  normalizedArchitecture,
  resolveSetupSession,
  shouldInstallBundledAegis,
});
