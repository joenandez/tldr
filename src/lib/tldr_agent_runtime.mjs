import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterRegistry } from "./adapters/registry.mjs";
import { probeRuntimeResumeCapabilities } from "./adapter_session_identity.mjs";
import { createTldrAgentDiagnosticCliDependencies } from "./tldr_agent_diagnostics.mjs";
import { cancelBeaconFollowup } from "./tldr_agent_beacon_cancel.mjs";
import { requireBeaconFollowup } from "./tldr_agent_beacon_require.mjs";
import { completeBeaconFollowup } from "./tldr_agent_beacon_complete.mjs";
import { dispatchTldrAgentMessage } from "./tldr_agent_message_dispatch.mjs";

const BUILTIN_ADAPTER_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "adapters",
);

export function createProductionDependencies({
  nativeSetupDependencies = null,
  platform = process.platform,
} = {}) {
  async function openOwnerSetupService() {
    const { createProductionOwnerSetupService } = await import(
      "#tldr-agent-owner-setup-runtime"
    );
    return createProductionOwnerSetupService(nativeSetupDependencies ?? {});
  }
  return {
    ...createTldrAgentDiagnosticCliDependencies(),
    readBodyFile: (path) => readFileSync(path === "-" ? 0 : path, "utf8"),
    async resolveContext() {
      if (process.platform !== "darwin") return { runtimeUnsupported: true };
      const [{ resolveTldrAgentScope }, identityState, ownerRuntime] =
        await Promise.all([
          import("./store.mjs"),
          import("./identity_state.mjs"),
          import("#tldr-agent-owner-setup-runtime"),
        ]);
      const resolved = identityState.resolveOutboundEmailSessionOwner();
      const runtime = resolved.identity?.runtime || null;
      const adapter = runtime
        ? createAdapterRegistry({ dirs: [BUILTIN_ADAPTER_DIR] }).get(runtime)
        : null;
      const runtimeCapabilities = runtime
        ? probeRuntimeResumeCapabilities({ runtime, adapter })
        : {
            ok: false,
            ready: false,
            runtime: null,
            missing: ["session_identity"],
          };
      const { owner } = await ownerRuntime.resolveOwnerIdentity();
      return {
        owner,
        sessionId: resolved.ok ? resolved.session_id : null,
        runtimeReady: runtimeCapabilities.ready,
        runtimeCapabilityError: runtimeCapabilities.error || null,
        scope: resolveTldrAgentScope({ cwd: process.cwd() }),
      };
    },
    cancelBeaconFollowup,
    requireBeaconFollowup,
    completeBeaconFollowup,
    async assertReplyOwnership({ scope, threadId, sessionId }) {
      const { assertOwningSessionForReply } = await import(
        "./substrate/thread_ownership.mjs"
      );
      return assertOwningSessionForReply(scope, threadId, sessionId);
    },
    dispatchMessage: dispatchTldrAgentMessage,
    async getInboxMessage(input) {
      const { getInboxMessage } = await import("./inbox_cli.mjs");
      return getInboxMessage(input);
    },
    async resolvePendingMessage({ scope, threadId, sessionId }) {
      const { checkUnreadBeforeDispatch } = await import(
        "./substrate/blocked_unread.mjs"
      );
      const pending = checkUnreadBeforeDispatch({ scope, threadId, sessionId });
      if (pending.ok || !pending.data?.latest_message_id) return { ok: false };
      return { ok: true, messageId: pending.data.latest_message_id };
    },
    async getAgentSafeStatus() {
      if (platform !== "darwin") {
        return { ok: false, code: "RUNTIME_UNSUPPORTED" };
      }
      const service = await openOwnerSetupService();
      try {
        const status = await service.status();
        if (status?.ok === false) {
          return { ok: false, code: status.error?.code ?? "NOT_CONFIGURED" };
        }
        const data = status?.data ?? status;
        const remediation = ["degraded", "recovering"].includes(data.status)
          ? "tldr-agent doctor"
          : data.status === "unconfigured"
            ? "tldr-agent setup"
            : null;
        return {
          ok: true,
          data: {
            readiness: data.status ?? "unknown",
            runtime: data.runtime?.status ?? "unknown",
            daemon: data.daemon?.status ?? "unknown",
            ...(remediation ? { remediation } : {}),
          },
        };
      } finally {
        service?.close?.();
      }
    },
    async ownerSetupService() {
      return openOwnerSetupService();
    },
    async installLifecycle() {
      const { createProductionInstallLifecycle } = await import(
        "#tldr-agent-owner-setup-runtime"
      );
      return createProductionInstallLifecycle();
    },
    async runDaemonForeground() {
      const { runTldrAgentDaemonForeground } = await import(
        "./tldr_agent_daemon_foreground.mjs"
      );
      return runTldrAgentDaemonForeground();
    },
  };
}
