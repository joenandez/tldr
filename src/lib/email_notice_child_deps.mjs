// What the warm notice child (email_notice_child.mjs) runs on in production; tests swap this
// module for a fake through the `#tldr-agent-notice-child-deps` import condition.
import { createTightbeamEmailAdapter } from "./tightbeam_email_adapter.mjs";
import { createTightbeamChannel } from "./tightbeam_channel.mjs";
import { requestAegisOutbound } from "./aegis_client.mjs";
import { productionRun } from "./tightbeam_channel_runtime.mjs";
import { createTickVerifiedTightbeamRun } from "./tightbeam_verified_runtime.mjs";
import { emailTransport } from "./transports/email.mjs";

// The same check the cold drain child makes before it runs: a stopped or unsafe home sends nothing.
export async function assertEnabled() {
  const { assertLifecycleDesiredStateAllowsStart, assertLifecycleHomeSafe } =
    await import("./tldr_agent_lifecycle_store.mjs");
  assertLifecycleDesiredStateAllowsStart();
  assertLifecycleHomeSafe();
}

// Every Tightbeam CLI call is killed at `cliMs` and returns then. It stays in this child's process
// group (inheritGroup), which the daemon kills whole on stop, request timeout or restart, so a hung
// CLI never outlives the child (ac-jfv.74.1, review r4 #4 and r5). One verified runtime resolution
// serves the child's life; a failed claim sets the child up afresh.
export const cliRunner = (cliMs) => (options) =>
  productionRun({ timeoutMs: cliMs, inheritGroup: true, ...options });

export function loadDependencies({ cliMs, sendMs }) {
  const run = cliRunner(cliMs);
  return {
    channel: createTightbeamChannel({
      run: createTickVerifiedTightbeamRun({ run }),
    }),
    createAdapter: createTightbeamEmailAdapter,
    // Aegis's own socket deadline is the same bound the child's send timeout enforces.
    send: (row, context) =>
      emailTransport.send(row, {
        ...context,
        requestAegisOutbound: (options) =>
          requestAegisOutbound({ ...options, timeoutMs: sendMs }),
      }),
  };
}
