import {
  appendPerfEvent,
  buildDaemonResourceSampleRecord,
  inProcessMemorySample,
} from "./resource_sampler_light.mjs";
import { runDaemonLoop } from "./daemon.mjs";
import { runDaemonStatusServer } from "./daemon_status_server.mjs";
import { fail, output } from "./json_io.mjs";

const PRODUCTION_STATUS_PORT = 45173;

function daemonResourceSampleIntervalMs() {
  const configured = Number(process.env.HELM_DAEMON_RESOURCE_SAMPLE_MS);
  if (!Number.isFinite(configured) || configured <= 0) return 60_000;
  return Math.max(15_000, Math.floor(configured));
}

function daemonResourceSampleIncludesProcessTree() {
  return process.env.HELM_DAEMON_PROCESS_TREE_SAMPLE === "1";
}

function shouldWriteDaemonMemoryStderr() {
  return process.env.HELM_DAEMON_MEMORY_STDERR === "1";
}

function daemonStartupCheckpointsEnabled() {
  return (
    process.env.HELM_DAEMON_STARTUP_CHECKPOINTS === "1" ||
    process.env.HELM_DAEMON_PHASE_RESOURCE_SAMPLES === "1"
  );
}

function daemonStartupCheckpointIncludesVmmap() {
  return (
    process.env.HELM_DAEMON_STARTUP_CHECKPOINT_VMMAP === "1" ||
    process.env.HELM_DAEMON_PHASE_RESOURCE_SAMPLES === "1"
  );
}

function writeDaemonResourceSample({
  event = "daemon_resource_sample",
  classification = "helm_control_plane",
  daemonInstanceId = null,
  statusPortBind = null,
  phase = null,
  metadata = {},
  writeStderr = false,
} = {}) {
  const timestamp = new Date().toISOString();
  const memory = inProcessMemorySample();
  const record = appendPerfEvent(
    buildDaemonResourceSampleRecord({
      timestamp,
      event,
      classification,
      daemonInstanceId,
      pid: process.pid,
      phase,
      statusPortBind,
      memory,
      metadata,
      includeProcessTree: daemonResourceSampleIncludesProcessTree(),
    }),
  );
  if (writeStderr && shouldWriteDaemonMemoryStderr()) {
    process.stderr.write(
      JSON.stringify({
        ts: timestamp,
        level: "info",
        event: "daemon_memory",
        process_tree_mode: record.process_tree_mode,
        sampler_reason: record.metadata?.sampler_reason || null,
        ...memory,
      }) + "\n",
    );
  }
  return record;
}

function writeDaemonStartupCheckpoint({
  checkpoint,
  daemonInstanceId = null,
  statusPortBind = null,
  metadata = {},
} = {}) {
  if (!daemonStartupCheckpointsEnabled()) return null;
  const name = String(checkpoint || "").trim();
  if (!name) throw new Error("daemon startup checkpoint name is required");
  const timestamp = new Date().toISOString();
  return appendPerfEvent(
    buildDaemonResourceSampleRecord({
      timestamp,
      event: "daemon_startup_checkpoint",
      classification: "helm_control_plane",
      daemonInstanceId,
      pid: process.pid,
      phase: name,
      statusPortBind,
      memory: inProcessMemorySample(),
      metadata: {
        ...metadata,
        checkpoint: name,
      },
      includeProcessTree: false,
    }),
  );
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

async function assertSchedulerStartAllowed() {
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
    err?.message || "desired state blocks scheduler start or dispatch",
    withScope(scope, err?.details || {}),
    pretty,
  );
}

async function serviceStatusForOnce(schedulerScriptPath) {
  const { serviceStatus } = await import("./service.mjs");
  return serviceStatus(schedulerScriptPath);
}

export async function runDaemonCommand({
  flags = {},
  scope,
  schedulerScriptPath,
  command = "daemon.run",
  pretty = false,
} = {}) {
  writeDaemonStartupCheckpoint({
    checkpoint: "runner_start",
    metadata: { once: Boolean(flags.once) },
  });
  try {
    await assertSchedulerStartAllowed();
    writeDaemonStartupCheckpoint({
      checkpoint: "desired_state_checked",
      metadata: { once: Boolean(flags.once) },
    });
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
    runDaemonStatusServer({
      schedulerScriptPath,
      host: "127.0.0.1",
      port: statusPort,
      unref: true,
      onListen: (server) => {
        process.stderr.write(
          `helm daemon status_server listening on ${server.url}\n`,
        );
        settleBind({ ok: true, ...server });
      },
    }).catch((err) => {
      process.stderr.write(`helm daemon status_server error: ${err.message}\n`);
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
    writeDaemonStartupCheckpoint({
      checkpoint: "status_server_bound",
      statusPortBind,
      metadata: { once: Boolean(flags.once) },
    });

    try {
      writeDaemonResourceSample({
        statusPortBind,
        metadata: { reason: "status_server_bound" },
      });
    } catch (err) {
      process.stderr.write(
        `helm daemon resource sample failed: ${err.message}\n`,
      );
    }

    const memTimer = setInterval(() => {
      try {
        writeDaemonResourceSample({ statusPortBind, writeStderr: true });
      } catch (err) {
        process.stderr.write(
          `helm daemon resource sample failed: ${err.message}\n`,
        );
      }
    }, daemonResourceSampleIntervalMs());
    memTimer.unref();
  }

  writeDaemonStartupCheckpoint({
    checkpoint: "loop_entered",
    statusPortBind,
    metadata: { once: Boolean(flags.once) },
  });
  const results = await runDaemonLoop({
    schedulerScriptPath,
    intervalSec: Number(flags["interval-sec"] || 10),
    once: Boolean(flags.once),
    statusPortBind,
  });
  if (flags.once) {
    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      fail(
        command,
        "daemon_dispatch_failed",
        "one or more scope dispatches failed",
        withScope(scope, {
          service: await serviceStatusForOnce(schedulerScriptPath),
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
        service: await serviceStatusForOnce(schedulerScriptPath),
        results,
      }),
      [],
      pretty,
    );
  }
  return results;
}

export const _internals = {
  daemonResourceSampleIntervalMs,
  daemonResourceSampleIncludesProcessTree,
  shouldWriteDaemonMemoryStderr,
  daemonStartupCheckpointsEnabled,
  writeDaemonResourceSample,
  writeDaemonStartupCheckpoint,
};
