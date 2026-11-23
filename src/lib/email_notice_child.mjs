// The warm email notice child (ac-jfv.74.1): one long-lived process the daemon forks with IPC
// (email_notice_warm_child.mjs). A wake message runs one notice tick (tier 0, up to 4 sends at
// once) on dependencies loaded once, so a wake costs one claim CLI call plus the send, not a cold
// node start, payload verification, preflight and route resolution. Parent messages:
// { type: "wake", id }; replies: { type: "ready" }, { type: "result", id, outbound },
// { type: "error", id, code, message }.
import "./node_sqlite_warning.mjs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertEnabled, loadDependencies } from "#tldr-agent-notice-child-deps";
import { drainNotices, withSendTimeout } from "./email_notice_drain.mjs";
import { TLDR_AGENT_EMAIL_NOTICE } from "./tldr_agent_daemon_phase_timeouts.mjs";

// Setup (load, preflight, adapter) is kept for later wakes; a failed claim drops it, as the claim
// may have failed on a stale identity, route or verified runtime. A failed setup is an error to the
// parent and is tried again at the next wake. The lifecycle check runs on every wake.
export function createNoticeWorker({
  loadDependencies: load = loadDependencies,
  assertEnabled: assertRunning = assertEnabled,
  cliMs = TLDR_AGENT_EMAIL_NOTICE.cliMs,
  sendMs = TLDR_AGENT_EMAIL_NOTICE.sendMs,
  tickMs = TLDR_AGENT_EMAIL_NOTICE.tickMs,
  limit = 4,
  now = Date.now,
} = {}) {
  let adapter = null;
  async function setup() {
    const loaded = await load({ cliMs, sendMs });
    const preflight = await loaded.channel.preflight();
    if (preflight?.ok !== true) {
      const remediation =
        preflight?.error?.remediation || "Tightbeam preflight failed";
      throw Object.assign(new Error(remediation), {
        code: preflight?.error?.code || "tightbeam_preflight_failed",
      });
    }
    return loaded.createAdapter({
      channel: loaded.channel,
      send: withSendTimeout(loaded.send, sendMs),
    });
  }
  return {
    async wake() {
      await assertRunning();
      adapter ??= await setup();
      const outbound = await drainNotices({
        adapter,
        deadlineMs: now() + tickMs,
        limit,
      });
      if (outbound.cause === "claim_failed") adapter = null;
      return outbound;
    },
  };
}

const numberFrom = (value, fallback) =>
  Number(value) > 0 ? Number(value) : fallback;

// The child's main. It is its own process group leader (the parent forks it detached), so its exit
// ends the CLI calls it started; losing the parent (the IPC channel closing) ends it at once.
export function runNoticeChild({ env = process.env } = {}) {
  const worker = createNoticeWorker({
    cliMs: numberFrom(env.TLDR_NOTICE_CLI_MS, undefined),
    sendMs: numberFrom(env.TLDR_NOTICE_SEND_MS, undefined),
    tickMs: numberFrom(env.TLDR_NOTICE_TICK_MS, undefined),
  });
  process.on("message", async (message) => {
    if (message?.type !== "wake") return;
    try {
      process.send({
        type: "result",
        id: message.id,
        outbound: await worker.wake(),
      });
    } catch (error) {
      process.send({
        type: "error",
        id: message.id,
        code: error?.code ?? null,
        message: error?.message || String(error),
      });
    }
  });
  process.on("disconnect", () => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(0);
    }
  });
  process.send({ type: "ready" });
}

const isMain = (() => {
  if (!process.argv[1] || !process.send) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isMain) runNoticeChild();
