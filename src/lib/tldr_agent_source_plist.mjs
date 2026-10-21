import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTldrAgentProductionPlist } from "./tldr_agent_launchd_definition.mjs";
import { defaultTightbeamInvocation } from "./tightbeam_channel_runtime.mjs";
import {
  assertStateRootsCreatable,
  canonicalStateRoot,
  helmHome as getHelmHome,
  tightbeamStateRootFor,
} from "./store.mjs";

// The tldr daemon's production launchd definition and its inputs: the status
// port, the source root the daemon runs from, and the Tightbeam root it names.
// Split from tldr_agent_source_lifecycle.mjs (item 47), which re-exports
// every name here except SOURCE_ROOT.

export const TLDR_AGENT_STATUS_PORT = 45176;
export const SOURCE_ROOT = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

// The daemon and the Tightbeam CLIs it runs must name the same Tightbeam
// root. A value that reached us through the legacy ~/.tightbeam symlink (a
// resumed session's environment) is written as the new root it points to.
export function defaultTightbeamStateRoot() {
  return canonicalStateRoot({
    component: "tightbeam",
    root: tightbeamStateRootFor(),
  });
}

// The TIGHTBEAM_BIN the daemon's children inherit: one launcher, or none in
// the installed layout, where each child resolves the installed runtime's
// Tightbeam entrypoint itself (defaultTightbeamInvocation).
export function defaultDaemonTightbeamBin(env = process.env) {
  const { command, commandPrefix } = defaultTightbeamInvocation(env);
  return commandPrefix ? null : command;
}

export function productionPlist(
  schedulerScriptPath,
  {
    home = getHelmHome(),
    nodePath = process.execPath,
    tightbeamBin = defaultDaemonTightbeamBin(),
    tightbeamStateRoot = defaultTightbeamStateRoot(),
  } = {},
) {
  return renderTldrAgentProductionPlist({
    schedulerScriptPath,
    home,
    statusPort: TLDR_AGENT_STATUS_PORT,
    nodePath,
    tightbeamBin,
    tightbeamStateRoot,
  });
}

export function assertSourceLifecycleRootsCreatable({
  operation,
  home,
  helmHome,
  tightbeamStateRoot,
}) {
  // Refuse before touching launchd if the state roots cannot be created; a
  // plist without writable state would leave users with a daemon that starts
  // and immediately fails.
  return assertStateRootsCreatable({
    roots: {
      agent: { path: home, source: "lifecycle" },
      helm: { path: helmHome, source: "lifecycle" },
      tightbeam: { path: tightbeamStateRoot, source: "lifecycle" },
    },
    guarded: ["agent"],
    operation: `source_lifecycle_${operation}`,
  });
}
