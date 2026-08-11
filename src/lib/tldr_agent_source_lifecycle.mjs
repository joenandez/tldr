import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requestAegisStatusSafe } from "./aegis_client.mjs";
import { bootstrapHooks } from "./bootstrap_hooks.mjs";
import { waitForTldrAgentHealth } from "./tldr_agent_daemon_health.mjs";
import { renderTldrAgentProductionPlist } from "./tldr_agent_launchd_definition.mjs";
import {
  createTldrAgentInstallLifecycle,
  createTldrAgentLaunchdLifecycle,
} from "./tldr_agent_launchd_lifecycle.mjs";
import {
  tldrAgentSourceIdentity,
  readTldrAgentRuntimeSchemaVersion,
} from "./tldr_agent_runtime_identity.mjs";
import { initializeProductionReadBoundary } from "./tldr_agent_read_boundary.mjs";
import { getHelmHome } from "./helm_home.mjs";
import { setDesiredState } from "./runtime_store.mjs";

export const TLDR_AGENT_STATUS_PORT = 45176;
const ACTIVATABLE_AEGIS_STATES = new Set([
  "ready",
  "pending_verification",
  "unconfigured",
]);

export function requiresFreshPollForAegisStatus(status) {
  if (!ACTIVATABLE_AEGIS_STATES.has(status)) {
    throw new Error(
      `tldr; Aegis state ${JSON.stringify(status)} blocks source activation`,
    );
  }
  return status === "ready";
}

export function productionPlist(
  schedulerScriptPath,
  { home = getHelmHome() } = {},
) {
  return renderTldrAgentProductionPlist({
    schedulerScriptPath,
    home,
    statusPort: TLDR_AGENT_STATUS_PORT,
  });
}

// This boundary contains only source activation: hook convergence, daemon
// quiescence/reload, and exact runtime-identity verification. Native Aegis
// setup remains responsible for owner identity and provider authority.
export function createTldrAgentSourceInstallLifecycle({
  home = getHelmHome(),
  pluginHooksOwned = false,
  releaseOwnership = null,
  cleanupOwnedState = null,
  readAegisStatus = requestAegisStatusSafe,
} = {}) {
  const schedulerScriptPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "tldr-agent-private-runner.mjs",
  );
  const launchd = createTldrAgentLaunchdLifecycle({
    schedulerScriptPath,
    renderDefinition: (path) => productionPlist(path, { home }),
  });
  return createTldrAgentInstallLifecycle({
    runtimes: pluginHooksOwned ? [] : undefined,
    launchd,
    initializeReadBoundary: () => initializeProductionReadBoundary(home),
    desiredState: {
      set: (desiredInput) => setDesiredState({ home, ...desiredInput }),
    },
    verifyDaemon: async (daemon, { observeDaemon } = {}) => {
      const aegisStatus = await readAegisStatus();
      return waitForTldrAgentHealth({
        daemon,
        observeDaemon,
        home,
        port: TLDR_AGENT_STATUS_PORT,
        requirePollFresh: requiresFreshPollForAegisStatus(aegisStatus),
        expectedRuntimeIdentity: {
          ...tldrAgentSourceIdentity(),
          schema_version: readTldrAgentRuntimeSchemaVersion(home),
        },
      });
    },
    manageHooks: ({ action, runtime }) => bootstrapHooks({ action, runtime }),
    releaseOwnership,
    cleanupOwnedState,
  });
}
