// The signed app's Uninstall tldr; data path (plan Technical Approach 5): stop
// the Helm services and the Tightbeam daemon and remove the Tightbeam, Helm,
// and agent state roots through the source lifecycle's full uninstall. The app
// runs it on the installed runtime (`<home>/install/runtime/bin/node
// <home>/install/tldr-agent/src/starport.mjs product-uninstall`) after its
// protected confirmation and before it removes that runtime; the agent root,
// which holds the runtime, is removed last.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runsFromInstalledRuntime } from "./email_disconnect_entry.mjs";
import { tldrAgentHomeFor } from "./store.mjs";
import { createTldrAgentSourceInstallLifecycle } from "./tldr_agent_source_lifecycle.mjs";

export const PRODUCT_UNINSTALL = "product-uninstall";

function logEvent(level, event, fields) {
  try {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
    );
  } catch {
    // Logging never changes an uninstall outcome.
  }
}

function failure(code, message, retryable) {
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({ code, message, retryable }),
  });
}

export async function runProductUninstallOperation({
  env = process.env,
  userHome = homedir(),
  modulePath = fileURLToPath(import.meta.url),
  execPath = process.execPath,
  createSource = createTldrAgentSourceInstallLifecycle,
} = {}) {
  const home = resolve(tldrAgentHomeFor({ env, userHome }));
  if (!runsFromInstalledRuntime({ home, modulePath, execPath })) {
    logEvent("warn", "product_uninstall.entry_refused", {
      status: "unverified_runtime",
    });
    return failure(
      "PRODUCT_UNINSTALL_ENTRY_UNVERIFIED",
      "tldr; removal runs only from the installed tldr; runtime.",
      false,
    );
  }
  env.TLDR_AGENT_HOME = home;
  const startedAt = Date.now();
  try {
    const removed = await createSource({ home }).uninstall();
    if (removed?.ok !== true) {
      const error = new Error("source uninstall reported partial removal");
      error.code = removed?.error || "uninstall_incomplete";
      throw error;
    }
    logEvent("info", "product_uninstall.result", {
      status: "removed",
      already_removed: removed.already_removed === true,
      latency_ms: Date.now() - startedAt,
    });
    return Object.freeze({
      ok: true,
      data: Object.freeze({ state: "removed" }),
      error: null,
    });
  } catch (error) {
    logEvent("error", "product_uninstall.result", {
      status: "incomplete",
      code: error?.code ?? null,
      message: error?.message ?? null,
      stack: error?.stack ?? null,
      latency_ms: Date.now() - startedAt,
    });
    return failure(
      "PRODUCT_UNINSTALL_INCOMPLETE",
      "tldr; could not remove all of its services and state.",
      true,
    );
  }
}
