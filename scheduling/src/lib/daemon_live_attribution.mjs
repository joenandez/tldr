import {
  appendPerfEvent,
  buildDaemonResourceSampleRecord,
  inProcessMemorySample,
} from "./resource_sampler_light.mjs";

const DAEMON_PHASE_CHECKPOINTS = new Map([
  ["health_projection", "first_health_projection"],
]);
const STATUS_SERVER_ROUTES = new Map([
  ["first_service_status_read", "/service"],
]);
const statusServerSeen = new Set();

function liveDeltaCheckpointsEnabled() {
  return (
    process.env.HELM_DAEMON_LIVE_DELTA_CHECKPOINTS === "1" ||
    process.env.HELM_DAEMON_STARTUP_CHECKPOINTS === "1" ||
    process.env.HELM_DAEMON_PHASE_RESOURCE_SAMPLES === "1"
  );
}

function liveDeltaCheckpointIncludesVmmap() {
  return (
    process.env.HELM_DAEMON_LIVE_DELTA_CHECKPOINT_VMMAP === "1" ||
    process.env.HELM_DAEMON_STARTUP_CHECKPOINT_VMMAP === "1" ||
    process.env.HELM_DAEMON_PHASE_RESOURCE_SAMPLES === "1"
  );
}

export function writeDaemonLiveDeltaCheckpoint({
  checkpoint,
  daemonInstanceId = null,
  statusPortBind = null,
  metadata = {},
  seen = null,
  once = true,
  pid = process.pid,
  sink = appendPerfEvent,
  memorySample = inProcessMemorySample,
  vmmapFn = null,
} = {}) {
  if (!liveDeltaCheckpointsEnabled()) return null;
  const name = String(checkpoint || "").trim();
  if (!name) throw new Error("daemon live delta checkpoint name is required");
  if (once && seen?.has(name)) return null;
  if (once) seen?.add(name);

  return sink(
    buildDaemonResourceSampleRecord({
      event: "daemon_live_delta_checkpoint",
      classification: "helm_control_plane",
      daemonInstanceId,
      pid,
      phase: name,
      statusPortBind,
      memory: memorySample(),
      metadata: {
        ...metadata,
        checkpoint: name,
      },
      includeProcessTree: false,
      vmmapFn: liveDeltaCheckpointIncludesVmmap() ? vmmapFn : null,
    }),
  );
}

export function createDaemonLiveDeltaAttributor({
  daemonInstanceId = null,
  statusPortBind = null,
  sink = appendPerfEvent,
  memorySample = inProcessMemorySample,
  vmmapFn = null,
  pid = process.pid,
} = {}) {
  const seen = new Set();
  return {
    checkpoint(input = {}, maybeMetadata = {}) {
      const args =
        typeof input === "string"
          ? { checkpoint: input, metadata: maybeMetadata }
          : input;
      return writeDaemonLiveDeltaCheckpoint({
        checkpoint: args.checkpoint,
        daemonInstanceId,
        statusPortBind,
        metadata: args.metadata || {},
        once: args.once ?? true,
        seen,
        sink,
        memorySample,
        vmmapFn,
        pid,
      });
    },
    phase(name, result) {
      const checkpoint = DAEMON_PHASE_CHECKPOINTS.get(name);
      if (!checkpoint) return null;
      return this.checkpoint(checkpoint, {
        ok: Boolean(result?.ok),
        duration_ms: result?.duration_ms ?? null,
      });
    },
    dispatchScan(plan, dispatchExecutor) {
      return this.checkpoint("first_dispatch_scan", {
        authoritative_registry: Boolean(plan?.authoritative),
        dispatchable_scope_count: plan?.dispatchable?.length ?? 0,
        skipped_scope_count: plan?.skipped?.length ?? 0,
        inproc_executor_enabled: Boolean(dispatchExecutor),
      });
    },
  };
}

export function writeStatusServerLiveDeltaCheckpoint(
  checkpoint,
  result = null,
) {
  return writeDaemonLiveDeltaCheckpoint({
    checkpoint,
    metadata: {
      route: STATUS_SERVER_ROUTES.get(checkpoint) || null,
      source: "status_server",
      ok: result && typeof result === "object" ? Boolean(result.ok) : null,
    },
    seen: statusServerSeen,
  });
}

export const _internals = {
  liveDeltaCheckpointsEnabled,
  liveDeltaCheckpointIncludesVmmap,
};
