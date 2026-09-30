import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requestAegisStatusSafe } from "./aegis_client.mjs";
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
import {
  assertStateRootsCreatable,
  helmHome as getHelmHome,
  helmStateRootFor,
} from "./store.mjs";
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
import {
  SOURCE_ROOT,
  TLDR_AGENT_STATUS_PORT,
  defaultTightbeamStateRoot,
  productionPlist,
} from "./tldr_agent_source_plist.mjs";

// The pre-split replacement evidence and the production launchd definition
// live in their own modules; re-exported so importers keep one path.
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
// Helm's sentinel install bootstraps and then kickstarts -k the job, so launchd
// holds the restart for its 30 s ThrottleInterval. Allow one full window.
const HELM_SERVICE_START_TIMEOUT_MS = 45_000;
const HELM_SERVICE_POLL_INTERVAL_MS = 1_000;
const HELM_LAUNCHD_LABELS = Object.freeze([
  {
    label: "ai.helm.scheduler",
    script: "scheduling/src/helm-daemon.mjs",
  },
  {
    label: "ai.helm.sentinel",
    script: "scheduling/src/sentinel.mjs",
  },
]);

function logLifecycle(level, event, params) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, params })}\n`,
  );
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

// This boundary contains source activation, historic hook removal, daemon
// quiescence/reload, and exact runtime-identity verification. Native Aegis
// setup remains responsible for owner identity and provider authority.
export function createTldrAgentSourceInstallLifecycle({
  home = getHelmHome(),
  helmHome = helmStateRootFor(),
  nodePath = process.execPath,
  tightbeamBin = process.env.TIGHTBEAM_BIN ||
    join(SOURCE_ROOT, "libexec", "tightbeam"),
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
  // install and update create the agent root (lifecycle store, launchd
  // plist), so they refuse while ~/.tldr-agent is still a real directory and
  // the new root is missing. Helm and Tightbeam create their own roots behind
  // their own guards; the whole-product entry points (Starport setup/repair,
  // local:update, the bootstrap script) check all three before they start.
  const assertRootsCreatable = (operation) =>
    assertStateRootsCreatable({
      roots: {
        agent: { path: home, source: "lifecycle" },
        helm: { path: helmHome, source: "lifecycle" },
        tightbeam: { path: tightbeamStateRoot, source: "lifecycle" },
      },
      guarded: ["agent"],
      operation: `source_lifecycle_${operation}`,
    });
  // A replacement over a ready store leaves post-split evidence that nothing
  // migrates; consume it so the next runtime swap is not refused as unresolved.
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
      // Helm reports refusals (active runs, desired state) as JSON on stdout.
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
        const deadline = now() + HELM_SERVICE_START_TIMEOUT_MS;
        for (const { label, script } of HELM_LAUNCHD_LABELS) {
          const target = `gui/${process.getuid()}/${label}`;
          const expectedScript = join(SOURCE_ROOT, script);
          const startedAt = now();
          let attempts = 0;
          for (;;) {
            attempts += 1;
            const status = commandRunner("launchctl", ["print", target], {
              encoding: "utf8",
            });
            const output = `${status?.stdout || ""}${status?.stderr || ""}`;
            const running =
              Number(status?.status ?? 1) === 0 &&
              /state = running\b/u.test(output) &&
              /pid = [1-9]\d*\b/u.test(output);
            if (
              running &&
              output.includes(nodePath) &&
              output.includes(expectedScript)
            ) {
              if (attempts > 1) {
                logLifecycle("info", "helm_service_start_waited", {
                  label,
                  attempts,
                  latency_ms: now() - startedAt,
                });
              }
              break;
            }
            if (now() >= deadline) {
              logLifecycle("error", "helm_service_start_timeout", {
                label,
                attempts,
                running,
                latency_ms: now() - startedAt,
              });
              throw new Error(
                `Helm launchd service ${label} is not running from the active source and packaged Node`,
              );
            }
            // eslint-disable-next-line no-await-in-loop -- Poll launchd sequentially until the throttled restart lands or the deadline passes.
            await sleep(HELM_SERVICE_POLL_INTERVAL_MS);
          }
        }
      } catch (error) {
        helmServiceUpdateRefused = true;
        if (!error.code) error.code = "helm_service_update_failed";
        throw error;
      }
      return health;
    },
    releaseOwnership,
    cleanupOwnedState,
  });
  return Object.freeze({
    ...lifecycle,
    reconcileReplacementEvidence,
    async install(...args) {
      assertRootsCreatable("install");
      helmServiceUpdateRefused = false;
      return lifecycle.install(...args);
    },
    async prepareUpdate(...args) {
      assertRootsCreatable("prepare_update");
      helmServiceUpdateRefused = false;
      return lifecycle.prepareUpdate(...args);
    },
    async uninstall(...args) {
      runHelmLifecycleCommand(["service", "uninstall"]);
      runHelmLifecycleCommand(["sentinel", "uninstall"]);
      return lifecycle.uninstall(...args);
    },
    // update() runs this.prepareUpdate(), which checks the roots.
    async update(options) {
      return lifecycle.update.call(this, options);
    },
    async activatePreparedUpdate(prepared) {
      return lifecycle.activatePreparedUpdate.call(this, prepared);
    },
  });
}
