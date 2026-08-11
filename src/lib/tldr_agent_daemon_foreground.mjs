import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDaemonCommand } from "./daemon_entrypoint.mjs";

const TLDR_AGENT_STATUS_PORT = 45176;

export async function runTldrAgentDaemonForeground() {
  process.env.TLDR_AGENT_DAEMON_MODE = "poll-only";
  process.env.HELM_STATUS_PORT = String(TLDR_AGENT_STATUS_PORT);
  const { resolveTldrAgentScope } = await import("./store.mjs");
  return runDaemonCommand({
    flags: {},
    scope: resolveTldrAgentScope({ cwd: process.cwd() }),
    schedulerScriptPath: join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "tldr-agent-private-runner.mjs",
    ),
    command: "daemon.run",
    pretty: false,
  });
}
