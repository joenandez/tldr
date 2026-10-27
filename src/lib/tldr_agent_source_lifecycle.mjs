import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requestAegisStatusSafe } from "./aegis_client.mjs";
import {
  captureActiveRuntimePointer,
  publishActiveRuntimePointer,
  restoreActiveRuntimePointer,
} from "./tldr_agent_active_runtime.mjs";
import { bootstrapHooks } from "./bootstrap_hooks.mjs";
import { waitForTldrAgentHealth } from "./tldr_agent_daemon_health.mjs";
import {
  createTldrAgentInstallLifecycle,
  createTldrAgentLaunchdLifecycle,
} from "./tldr_agent_launchd_lifecycle.mjs";
import {
  tldrAgentSourceIdentity,
  readTldrAgentRuntimeSchemaVersion,
} from "./tldr_agent_runtime_identity.mjs";
import { helmHome as getHelmHome, helmStateRootFor } from "./store.mjs";
import {
  LifecycleStoreError,
  initializeLifecycleStore,
  lifecycleOriginIsRecorded,
  lifecycleStorePath,
  migrateLegacyDesiredState,
  readLifecycleDesiredState,
  setLifecycleDesiredState,
} from "./tldr_agent_lifecycle_store.mjs";
import {
  consumeCapturedPreSplitSource,
  readCapturedPreSplitSource,
  readVerifiedInstalledPreSplitSource,
} from "./tldr_agent_presplit_evidence.mjs";
import { createProductStateRemoval } from "./tldr_agent_product_removal.mjs";
import { waitForHelmLaunchdServices } from "./tldr_agent_helm_service_wait.mjs";
import {
  SOURCE_ROOT,
  TLDR_AGENT_STATUS_PORT,
  assertSourceLifecycleRootsCreatable,
  defaultDaemonTightbeamBin,
  defaultTightbeamStateRoot,
  productionPlist,
} from "./tldr_agent_source_plist.mjs";
export {
  VERIFIED_PRE_SPLIT_RELEASE,
  lifecycleMigrationEvidencePath,
  readVerifiedInstalledPreSplitSource,
} from "./tldr_agent_presplit_evidence.mjs";
export {
  TLDR_AGENT_STATUS_PORT,
  defaultTightbeamStateRoot,
  productionPlist,
} from "./tldr_agent_source_plist.mjs";
const ACTIVATABLE_AEGIS_STATES = new Set([
  "ready",
  "pending_verification",
  "unconfigured",
]);

function logLifecycle(level, event, params) {
  const ts = new Date().toISOString();
  process.stderr.write(`${JSON.stringify({ ts, level, event, params })}\n`);
}
export function requiresFreshPollForAegisStatus(status, override = null) {
  if (!ACTIVATABLE_AEGIS_STATES.has(status)) {
    throw new Error(
      `tldr; Aegis state ${JSON.stringify(status)} blocks source activation`,
    );
  }
  if (typeof override === "boolean") return override;
  return status === "ready";
}
export function createTldrAgentSourceInstallLifecycle({
  home = getHelmHome(),
  activeRuntimePath = join(dirname(home), "active-runtime.json"),
  helmHome = helmStateRootFor(),
  nodePath = process.execPath,
  tightbeamBin = defaultDaemonTightbeamBin(),
  tightbeamStateRoot = defaultTightbeamStateRoot(),
  requireFreshPoll = null,
  releaseOwnership = null,
  cleanupOwnedState = null,
  readAegisStatus = requestAegisStatusSafe,
  createLaunchdLifecycle = createTldrAgentLaunchdLifecycle,
  createInstallLifecycle = createTldrAgentInstallLifecycle,
  readPriorSource = () => readVerifiedInstalledPreSplitSource({ home }),
  readCapturedSource = () => readCapturedPreSplitSource({ home }),
  manageHooks = bootstrapHooks,
  commandRunner = spawnSync,
  waitForDaemonHealth = waitForTldrAgentHealth,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  const schedulerScriptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "tldr-agent-private-runner.mjs",
  );
  const launchd = createLaunchdLifecycle({
    schedulerScriptPath,
    renderDefinition: (path) =>
      productionPlist(path, {
        home,
        nodePath,
        tightbeamBin,
        tightbeamStateRoot,
      }),
  });
  const assertRootsCreatable = (operation) =>
    assertSourceLifecycleRootsCreatable({
      operation,
      home,
      helmHome,
      tightbeamStateRoot,
    });
  const consumeReadyReplacementEvidence = (captured, action) => {
    if (!captured?.captured) return false;
    if (!captured.validReplacementEvidence) {
      throw new LifecycleStoreError(
        "lifecycle_migration_source_unverified",
        "lifecycle replacement evidence is not verified",
      );
    }
    const discardEvidence = consumeCapturedPreSplitSource(captured);
    discardEvidence();
    logLifecycle("info", "lifecycle_replacement_evidence_consumed", {
      action,
    });
    return true;
  };
  const reconcileReplacementEvidence = () => {
    const state = readLifecycleDesiredState({ home });
    if (!state.ready) return { consumed: false, reason: "store_not_ready" };
    return {
      consumed: consumeReadyReplacementEvidence(
        readCapturedSource(),
        "reconcile",
      ),
    };
  };
  const prepareLifecycleState = async ({ action, quiesce = null }) => {
    const path = lifecycleStorePath(home);
    const state = readLifecycleDesiredState({ home, path });
    const captured = readCapturedSource();
    if (state.ready) {
      consumeReadyReplacementEvidence(captured, action);
      return state;
    }
    if (existsSync(path)) {
      throw new LifecycleStoreError(
        state.reason,
        `tldr; lifecycle state is unavailable: ${state.reason}`,
        { desired_state: state },
      );
    }
    if (action === "install") {
      if (!captured.captured) {
        if (
          lifecycleOriginIsRecorded({ home }) ||
          existsSync(join(home, "runtime.sqlite"))
        ) {
          throw new LifecycleStoreError(
            "lifecycle_migration_source_unverified",
            "lifecycle state is missing without verified pre-split replacement evidence",
            { path },
          );
        }
        return initializeLifecycleStore({ home, path });
      }
      if (
        !captured.verifiedInstalledSource ||
        !captured.sourcePredatesLifecycleSplit
      ) {
        throw new LifecycleStoreError(
          "lifecycle_migration_source_unverified",
          "lifecycle migration requires a verified installed pre-split source",
        );
      }
      if (typeof quiesce !== "function") {
        throw new LifecycleStoreError(
          "lifecycle_migration_not_quiesced",
          "lifecycle migration requires daemon quiescence",
        );
      }
      await quiesce();
      const migrated = migrateLegacyDesiredState({
        home,
        path,
        quiesced: true,
        verifiedInstalledSource: captured.verifiedInstalledSource,
        sourcePredatesLifecycleSplit: captured.sourcePredatesLifecycleSplit,
      });
      const discardEvidence = consumeCapturedPreSplitSource(captured);
      discardEvidence();
      return migrated;
    }
    const evidence = readPriorSource();
    return migrateLegacyDesiredState({
      home,
      path,
      quiesced: true,
      ...evidence,
    });
  };
  let helmServiceUpdateRefused = false;
  const runHelmLifecycleCommand = (args) => {
    const schedulingRoot = join(SOURCE_ROOT, "scheduling");
    const result = commandRunner(
      nodePath,
      [join(schedulingRoot, "src", "helm-tasks.mjs"), ...args],
      {
        cwd: SOURCE_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HELM_HOME: helmHome,
          HELM_CANONICAL_CHECKOUT: schedulingRoot,
          TIGHTBEAM_STATE_ROOT: tightbeamStateRoot,
        },
      },
    );
    if (Number(result?.status ?? 1) !== 0) {
      let refusal = null;
      try {
        refusal = JSON.parse(String(result?.stdout || ""))?.error || null;
      } catch {
        refusal = null;
      }
      logLifecycle("error", "helm_lifecycle_command_failed", {
        args,
        status: result?.status ?? null,
        signal: result?.signal ?? null,
        refusal_code: refusal?.code ?? null,
      });
      const detail = refusal?.message
        ? `${refusal.code ? `[${refusal.code}] ` : ""}${refusal.message}`
        : String(result?.stderr || result?.stdout || "").trim();
      const error = new Error(
        `Helm ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      );
      error.code = "helm_service_update_failed";
      throw error;
    }
  };
  const productRemoval = createProductStateRemoval({
    roots: { agent: home, helm: helmHome, tightbeam: tightbeamStateRoot },
    commandRunner,
    sleep,
  });
  const lifecycle = createInstallLifecycle({
    manageHooks,
    launchd,
    desiredState: {
      set: (desiredInput) =>
        setLifecycleDesiredState({ home, ...desiredInput }),
    },
    prepareLifecycleState,
    verifyDaemon: async (daemon, { observeDaemon } = {}) => {
      const aegisStatus = await readAegisStatus();
      const health = await waitForDaemonHealth({
        daemon,
        observeDaemon,
        home,
        port: TLDR_AGENT_STATUS_PORT,
        requirePollFresh: requiresFreshPollForAegisStatus(
          aegisStatus,
          requireFreshPoll,
        ),
        expectedRuntimeIdentity: {
          ...tldrAgentSourceIdentity(),
          schema_version: readTldrAgentRuntimeSchemaVersion(home),
        },
      });
      if (health?.ready !== true) return health;
      if (helmServiceUpdateRefused) {
        const error = new Error(
          "tldr; Helm service update was already refused during this activation",
        );
        error.code = "helm_service_update_failed";
        throw error;
      }
      try {
        runHelmLifecycleCommand(["service", "update"]);
        await waitForHelmLaunchdServices({
          commandRunner,
          nodePath,
          now,
          sleep,
          log: logLifecycle,
        });
      } catch (error) {
        helmServiceUpdateRefused = true;
        if (!error.code) error.code = "helm_service_update_failed";
        throw error;
      }
      return health;
    },
    releaseOwnership,
    // Full uninstall only: runs after hooks and the agent daemon are removed.
    cleanupOwnedState:
      cleanupOwnedState ??
      (() =>
        productRemoval.removeProductState({ agentDaemon: launchd.status?.() })),
  });
  return Object.freeze({
    ...lifecycle,
    reconcileReplacementEvidence,
    async install(...args) {
      assertRootsCreatable("install");
      helmServiceUpdateRefused = false;
      const result = await lifecycle.install(...args);
      if (result?.ok === true) {
        publishActiveRuntimePointer(activeRuntimePath, SOURCE_ROOT);
      }
      return result;
    },
    async prepareUpdate(...args) {
      assertRootsCreatable("prepare_update");
      helmServiceUpdateRefused = false;
      return lifecycle.prepareUpdate(...args);
    },
    async uninstall(...args) {
      productRemoval.assertRemovable();
      const removed = productRemoval.confirmAlreadyRemoved();
      if (removed) {
        restoreActiveRuntimePointer(activeRuntimePath, null);
        return removed;
      }
      runHelmLifecycleCommand(["service", "uninstall"]);
      runHelmLifecycleCommand(["sentinel", "uninstall"]);
      productRemoval.verifyHelmServicesAbsent();
      const result = await lifecycle.uninstall(...args);
      const daemonRemoved =
        result?.daemon?.installed === false &&
        result?.daemon?.loaded !== true &&
        result?.daemon?.running !== true;
      if (result?.ok === true || daemonRemoved) {
        restoreActiveRuntimePointer(activeRuntimePath, null);
      }
      return productRemoval.assertComplete(result);
    },
    async update(options) {
      const previousPointer = captureActiveRuntimePointer(activeRuntimePath);
      try {
        return await lifecycle.update.call(this, options);
      } catch (error) {
        try {
          restoreActiveRuntimePointer(activeRuntimePath, previousPointer);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "tldr; update failed and active runtime pointer rollback failed",
          );
        }
        throw error;
      }
    },
    async activatePreparedUpdate(prepared) {
      const result = await lifecycle.activatePreparedUpdate.call(
        this,
        prepared,
      );
      if (result?.ok === true) {
        publishActiveRuntimePointer(activeRuntimePath, SOURCE_ROOT);
      }
      return result;
    },
  });
}
