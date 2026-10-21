import { runTldrAgentDaemonLoop } from "./tldr_agent_daemon_loop.mjs";
import { runTldrAgentDaemonHealthServer } from "./tldr_agent_daemon_health.mjs";
import { fail, output } from "./json_io.mjs";

const PRODUCTION_STATUS_PORT = 45173;

// A child phase reports its own failure as action "failed" inside an ok
// phase; both make a --once run fail, so Helm run history shows it.
export const failedOnceResults = (results) =>
  results.filter((result) => !result.ok || result.result?.action === "failed");

// The Linux poll job runs --once with no agent session open, so after a WSL
// restart nothing else starts Tightbeam. Bootstrap is idempotent: it answers
// fast when the daemon runs and starts a detached one when it does not. This
// never throws: it logs and returns the result, and null (no launcher, a
// throw, or a rejected run) means failed. Only ok === true is success; the
// caller then fails the tick without polling.
export async function ensureTightbeamForOnce({ run } = {}) {
  const startedMs = Date.now();
  let result = null;
  let thrown = null;
  try {
    const runtime = await import("./tightbeam_channel_runtime.mjs");
    result = await (run ?? runtime.productionRun)({
      ...runtime.tightbeamInvocation(),
      args: ["bootstrap"],
    });
  } catch (error) {
    thrown = error;
  }
  const ok = result?.ok === true;
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: ok ? "info" : "error",
      event: "daemon.once_tightbeam_bootstrap",
      status: ok ? "ok" : "failed",
      result: {
        daemon: result?.result?.daemon ?? null,
        code:
          result?.error?.code ??
          (thrown
            ? "bootstrap_threw"
            : result
              ? ok
                ? null
                : "bootstrap_not_ok"
              : "launcher_unavailable"),
      },
      ...(thrown ? { error: String(thrown?.message ?? thrown) } : {}),
      latency_ms: Date.now() - startedMs,
    })}\n`,
  );
  return result;
}

function withScope(scope, data = {}) {
  return {
    scope: {
      cwd: scope.cwd,
      scope_id: scope.scope_id,
      storage_root: scope.storage_root,
    },
    ...data,
  };
}

async function assertDaemonStartAllowed() {
  const { assertLifecycleDesiredStateAllowsStart, assertLifecycleHomeSafe } =
    await import("./tldr_agent_lifecycle_store.mjs");
  const desiredState = assertLifecycleDesiredStateAllowsStart();
  const helmHomeSafety = assertLifecycleHomeSafe();
  return { desiredState, helmHomeSafety };
}

function failDesiredStateBlocked(command, err, scope, pretty) {
  fail(
    command,
    err?.code || "desired_state_blocked",
    err?.message || "desired state blocks tldr; daemon start",
    withScope(scope, err?.details || {}),
    pretty,
  );
}

export async function runDaemonCommand({
  flags = {},
  scope,
  schedulerScriptPath,
  command = "daemon.run",
  pretty = false,
  // Seams so tests prove the exit code and poll count without spawning.
  deps: {
    assertStartAllowed = assertDaemonStartAllowed,
    ensureTightbeam = ensureTightbeamForOnce,
    runLoop = runTldrAgentDaemonLoop,
    exit = (code) => process.exit(code),
  } = {},
} = {}) {
  try {
    await assertStartAllowed();
  } catch (err) {
    failDesiredStateBlocked(command, err, scope, pretty);
    exit(1);
    return [];
  }

  let statusPortBind = null;
  if (!flags.once) {
    const statusPort = Number(
      process.env.HELM_STATUS_PORT || PRODUCTION_STATUS_PORT,
    );
    let bindSettled = false;
    let resolveBind;
    const bindReady = new Promise((finishBind) => {
      resolveBind = finishBind;
    });
    const settleBind = (result) => {
      if (bindSettled) return;
      bindSettled = true;
      resolveBind(result);
    };
    runTldrAgentDaemonHealthServer({
      home: scope.storage_root || scope.cwd,
      host: "127.0.0.1",
      port: statusPort,
      unref: true,
      onListen: (server) => {
        process.stderr.write(
          `tldr-agent daemon health listening on ${server.url}\n`,
        );
        settleBind({ ok: true, ...server });
      },
    }).catch((err) => {
      process.stderr.write(`tldr-agent daemon health error: ${err.message}\n`);
      settleBind({
        ok: false,
        code: "status_port_bind_failed",
        message: err?.message || String(err),
        host: "127.0.0.1",
        port: statusPort,
      });
    });
    statusPortBind = await bindReady;
    if (!statusPortBind.ok) {
      const { emitSafetyEvent } = await import("./safety_events.mjs");
      emitSafetyEvent({
        type: "daemon_singleton_collision",
        subsystem: "daemon_singleton",
        status: "failure",
        errorClass: "status_port_bind_failed",
        metadata: {
          attempted_pid: process.pid,
          reason: "status_port_bind_failed",
          code: statusPortBind.code || "status_port_bind_failed",
          status_port: statusPortBind,
        },
      });
      fail(
        command,
        "status_port_bind_failed",
        "daemon status port bind failed",
        withScope(scope, { status_port: statusPortBind }),
        pretty,
      );
      process.exit(1);
    }
  }
  if (flags.once) {
    const bootstrap = await ensureTightbeam();
    if (bootstrap?.ok !== true) {
      fail(
        command,
        "tightbeam_bootstrap_failed",
        "tldr; could not reach or start Tightbeam; tick not polled",
        withScope(scope, { code: bootstrap?.error?.code ?? null }),
        pretty,
      );
      exit(1);
      return [];
    }
  }
  const results = await runLoop({
    schedulerScriptPath,
    intervalSec: Number(flags["interval-sec"] || 10),
    once: Boolean(flags.once),
    home: scope.storage_root || scope.cwd,
    scope,
  });
  if (flags.once) {
    const failures = failedOnceResults(results);
    if (failures.length > 0) {
      fail(
        command,
        "daemon_mail_phase_failed",
        "one or more tldr; mail phases failed",
        withScope(scope, {
          service: { mode: "tldr_agent_mail" },
          results,
        }),
        pretty,
      );
      exit(1);
      return results;
    }
    output(
      command,
      true,
      withScope(scope, {
        service: { mode: "tldr_agent_mail" },
        results,
      }),
      [],
      pretty,
    );
  }
  return results;
}
