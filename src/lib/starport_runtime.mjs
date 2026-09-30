import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { createProductionOwnerSetupService } from "./aegis_native_setup_runtime.mjs";
import { createTldrAgentSourceInstallLifecycle } from "./tldr_agent_source_lifecycle.mjs";
import {
  assertStateRootsCreatable,
  resolveStateRoots,
  STATE_ROOT_MIGRATION_PENDING,
  resolveTldrAgentScope,
  stateRootsReport,
  tldrAgentHomeFor,
} from "./store.mjs";
import { installVerifiedLocalAegisPackage } from "./starport_aegis_package.mjs";
import {
  _internals as onboardingInternals,
  createSessionWelcomeDispatcher,
  createStarportOnboarding,
  createWelcomeEvidenceStore,
} from "./starport_onboarding.mjs";
import { createStarportOrchestrator } from "./starport_orchestrator.mjs";
import { createTightbeamChannel } from "./tightbeam_channel.mjs";
import {
  AEGIS_APP,
  createLocalSnapshotComponentInspector,
  createStarportComponentInspector,
  matchesFileRecord,
  normalizedArchitecture,
  safeJson,
} from "./starport_component_inspection.mjs";

export {
  createLocalSnapshotComponentInspector,
  createStarportComponentInspector,
} from "./starport_component_inspection.mjs";

const AEGIS_TEAM_ID = "VVG962SM5J";

function safeContextId(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function resolveSetupContext(env = process.env) {
  const claude = safeContextId(env.CLAUDE_CODE_SESSION_ID);
  const codex = safeContextId(env.CODEX_THREAD_ID);
  if (Boolean(claude) === Boolean(codex)) return null;
  return claude
    ? { runtime: "claude", sessionId: claude }
    : { runtime: "codex", sessionId: codex };
}

function unavailableOnboarding() {
  return Object.freeze({
    async status() {
      return Object.freeze({
        status: "failed",
        remediation: onboardingInternals.SAFE_WELCOME_REMEDIATION,
      });
    },
    async send() {
      return Object.freeze({
        status: "failed",
        remediation: onboardingInternals.SAFE_WELCOME_REMEDIATION,
      });
    },
  });
}

function shouldInstallBundledAegis({ appExists, nativeStatus }) {
  return (
    !appExists ||
    !["ready", "pending_verification", "unconfigured"].includes(nativeStatus)
  );
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
  tightbeam = null,
} = {}) {
  // The roots as the caller configured them, before this runtime pins
  // TLDR_AGENT_HOME and HELM_HOME into env below.
  const stateRootEnv = Object.freeze({
    TLDR_AGENT_HOME: env.TLDR_AGENT_HOME,
    TIGHTBEAM_STATE_ROOT: env.TIGHTBEAM_STATE_ROOT,
  });
  const home = resolve(tldrAgentHomeFor({ env, userHome }));
  env.TLDR_AGENT_HOME = home;
  env.HELM_HOME = home;
  env.HELM_CANONICAL_SQLITE = "1";
  delete env.HELM_CANONICAL_SQLITE_KILL_SWITCH;

  const localSnapshotRoot = env.TLDR_AGENT_LOCAL_SNAPSHOT_ROOT
    ? resolve(env.TLDR_AGENT_LOCAL_SNAPSHOT_ROOT)
    : null;
  const sourceRoot = localSnapshotRoot || join(home, "install", "tldr-agent");
  const activationManifest = join(home, "install", "activation-manifest.json");
  const activePluginRoot = env.TLDR_AGENT_PLUGIN_ROOT
    ? resolve(env.TLDR_AGENT_PLUGIN_ROOT)
    : null;
  const nativeService = native ?? createProductionOwnerSetupService();
  const sourceLifecycle =
    source ?? createTldrAgentSourceInstallLifecycle({ home });
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
    reconcile: () => sourceLifecycle.reconcileReplacementEvidence?.(),
    uninstall: () => sourceLifecycle.uninstall(),
  });

  const context = resolveSetupContext(env);
  const scope = resolveTldrAgentScope({
    cwd: process.cwd(),
    tldrAgentHome: home,
  });
  const tightbeamService = tightbeam ?? createTightbeamChannel({ home });
  const welcomeEvidence = createWelcomeEvidenceStore({
    home,
    findProviderAcceptanceByDelivery:
      tightbeamService.findProviderAcceptanceByDelivery,
  });
  const dispatchWelcome = createSessionWelcomeDispatcher({
    command: env.TIGHTBEAM_BIN,
    stateRoot: env.TIGHTBEAM_STATE_ROOT,
    context,
    evidence: welcomeEvidence,
  });
  const onboardingService =
    onboarding ??
    (context
      ? createStarportOnboarding({
          sessionId: context.sessionId,
          scope,
          home,
          readEvidence: () => welcomeEvidence.read(),
          dispatchMessage: dispatchWelcome,
        })
      : unavailableOnboarding());
  const inspector =
    inspectComponents ??
    (localSnapshotRoot
      ? createLocalSnapshotComponentInspector({
          home,
          sourceRoot,
          pluginRoot: activePluginRoot,
        })
      : createStarportComponentInspector({
          home,
          sourceRoot,
          pluginRoot: activePluginRoot,
          activationManifest,
        }));
  const orchestrator = createStarportOrchestrator({
    inspectComponents: inspector,
    native: nativeService,
    onboarding: onboardingService,
    source: sourceAdapter,
    tightbeam: tightbeamService,
  });
  return withStateRoots(orchestrator, { env: stateRootEnv, userHome });
}

function stateRootMigrationPending(error) {
  const pending = error.details?.pending || [];
  return Object.freeze({
    ok: false,
    data: Object.freeze({
      pending: Object.freeze(
        pending.map((entry) =>
          Object.freeze({
            component: entry.component,
            path: entry.path,
            legacy_path: entry.legacy_path,
          }),
        ),
      ),
    }),
    error: Object.freeze({
      code: error.code,
      message: "tldr; state has not moved to ~/.tldr-agents yet.",
      retryable: false,
      remediation: "Move tldr; state into ~/.tldr-agents, then try again.",
    }),
  });
}

// Status reports the three resolved state roots (read-only; it creates none).
// Setup and repair create roots, so they refuse while a legacy root is still a
// real directory and its new root is missing.
function withStateRoots(orchestrator, { env, userHome }) {
  const guarded = (operation) => async () => {
    try {
      assertStateRootsCreatable({
        roots: resolveStateRoots({ env, userHome }),
        userHome,
        operation: `starport_${operation}`,
      });
    } catch (error) {
      if (error?.code !== STATE_ROOT_MIGRATION_PENDING) throw error;
      return stateRootMigrationPending(error);
    }
    return orchestrator[operation]();
  };
  return Object.freeze({
    ...orchestrator,
    async status() {
      const result = await orchestrator.status();
      if (!result?.ok || !result.data) return result;
      return Object.freeze({
        ...result,
        data: Object.freeze({
          ...result.data,
          ...stateRootsReport({ env, userHome }),
        }),
      });
    },
    setup: guarded("setup"),
    repair: guarded("repair"),
  });
}

export const _internals = Object.freeze({
  resolveSetupContext,
  AEGIS_APP,
  AEGIS_TEAM_ID,
  normalizedArchitecture,
  shouldInstallBundledAegis,
  unavailableOnboarding,
});
