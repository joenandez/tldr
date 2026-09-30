import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderTldrAgentProductionPlist } from "./tldr_agent_launchd_definition.mjs";
import {
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

export function productionPlist(
  schedulerScriptPath,
  {
    home = getHelmHome(),
    nodePath = process.execPath,
    tightbeamBin = process.env.TIGHTBEAM_BIN ||
      join(SOURCE_ROOT, "libexec", "tightbeam"),
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
