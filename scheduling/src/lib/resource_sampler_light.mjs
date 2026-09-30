import { join } from "node:path";
import { appendJsonLine, helmHome } from "./store.mjs";

const MB = 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function roundMbFromBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return Math.round((bytes / MB) * 10) / 10;
}

export function inProcessMemorySample(memoryUsage = process.memoryUsage()) {
  return {
    rss_mb: roundMbFromBytes(memoryUsage.rss),
    heap_used_mb: roundMbFromBytes(memoryUsage.heapUsed),
    heap_total_mb: roundMbFromBytes(memoryUsage.heapTotal),
    external_mb: roundMbFromBytes(memoryUsage.external),
    array_buffers_mb: roundMbFromBytes(memoryUsage.arrayBuffers),
  };
}

export function buildDaemonResourceSampleRecord({
  timestamp = nowIso(),
  event = "daemon_resource_sample",
  classification = "helm_control_plane",
  daemonInstanceId = null,
  pid = process.pid,
  phase = null,
  statusPortBind = null,
  memory = inProcessMemorySample(),
  metadata = {},
  includeProcessTree = false,
  processTreeSnapshot = null,
  vmmapFn = null,
} = {}) {
  const processTree =
    includeProcessTree && typeof processTreeSnapshot === "function"
      ? processTreeSnapshot(pid)
      : null;
  const processTreeMode = includeProcessTree ? "included" : "memory_only";
  const samplerReason = includeProcessTree
    ? "process_tree_included"
    : "process_tree_not_requested";

  let mergedMemory = memory;
  if (typeof vmmapFn === "function") {
    const footprint = vmmapFn(pid);
    mergedMemory = {
      ...memory,
      physical_footprint_mb: footprint.physical_footprint_mb,
      physical_footprint_peak_mb: footprint.physical_footprint_peak_mb,
      malloc_large_reusable_mb: footprint.malloc_large_reusable_mb,
      vmmap_ok: footprint.vmmap_ok,
      vmmap_error: footprint.vmmap_error ?? null,
    };
  }

  return {
    timestamp,
    event,
    type: event,
    classification,
    daemon_instance_id: daemonInstanceId,
    pid,
    phase,
    status_port: statusPortBind,
    memory: mergedMemory,
    process_tree_mode: processTreeMode,
    ...(processTree ? { process_tree: processTree } : {}),
    metadata: {
      ...metadata,
      sampler_reason: samplerReason,
    },
  };
}

export function daemonResourcePerfPath(
  timestamp = nowIso(),
  home = helmHome(),
) {
  const day = new Date(timestamp).toISOString().slice(0, 10);
  return join(home, "perf", "daemon-resources", `${day}.jsonl`);
}

export function appendPerfEvent(
  event,
  { home = helmHome(), now = nowIso } = {},
) {
  const timestamp = event?.timestamp || now();
  const record = {
    timestamp,
    event: event?.event || event?.type || "daemon_resource_sample",
    type: event?.type || event?.event || "daemon_resource_sample",
    classification: event?.classification || "helm_control_plane",
    ...event,
    timestamp,
  };
  appendJsonLine(daemonResourcePerfPath(timestamp, home), record);
  return record;
}
