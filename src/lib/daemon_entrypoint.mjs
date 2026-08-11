import { runTldrAgentDaemonLoop } from "./tldr_agent_daemon_loop.mjs";
import { runTldrAgentDaemonHealthServer } from "./tldr_agent_daemon_health.mjs";
import { fail, output } from "./json_io.mjs";
import { isTldrAgentPollOnlyDaemon } from "./tldr_agent_daemon_mode.mjs";

const PRODUCTION_STATUS_PORT = 45173;

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
  const { assertDesiredStateAllowsStart, assertHelmHomeSafe } = await import(
    "./runtime_store.mjs"
  );
  const desiredState = assertDesiredStateAllowsStart({ initialize: false });
  const helmHomeSafety = assertHelmHomeSafe();
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
} = {}) {
  try {
    await assertDaemonStartAllowed();
  } catch (err) {
    failDesiredStateBlocked(command, err, scope, pretty);
    process.exit(1);
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
  const results = await runTldrAgentDaemonLoop({
    schedulerScriptPath,
    intervalSec: Number(flags["interval-sec"] || 10),
    once: Boolean(flags.once),
    home: scope.storage_root || scope.cwd,
    scope,
  });
  if (flags.once) {
    const failures = results.filter((result) => !result.ok);
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
      process.exit(1);
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

export const _internals = { isTldrAgentPollOnlyDaemon };
