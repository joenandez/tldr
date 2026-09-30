import { spawnSync as defaultSpawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { appendJsonLine, helmHome } from "./store.mjs";
import { isProcessAlive } from "./process_liveness.mjs";

const MB = 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function roundMbFromBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return Math.round((bytes / MB) * 10) / 10;
}

function roundMbFromKb(kb) {
  if (!Number.isFinite(kb) || kb < 0) return null;
  return Math.round((kb / 1024) * 10) / 10;
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

export function sizeTokenToMb(value) {
  const match = String(value || "")
    .trim()
    .match(/^([\d.]+)\s*([KMGT])(?:i?B)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toUpperCase();
  if (unit === "K") return Math.round((amount / 1024) * 10) / 10;
  if (unit === "M") return Math.round(amount * 10) / 10;
  if (unit === "G") return Math.round(amount * 1024 * 10) / 10;
  if (unit === "T") return Math.round(amount * 1024 * 1024 * 10) / 10;
  return null;
}

export function parseVmmapSummary(stdout) {
  const raw = String(stdout || "");
  const physical = raw.match(
    /Physical footprint:\s+([\d.]+\s*[KMGT](?:i?B)?)/i,
  );
  const peak = raw.match(
    /Physical footprint \(peak\):\s+([\d.]+\s*[KMGT](?:i?B)?)/i,
  );
  const reusable = raw.match(
    /MALLOC_LARGE_REUSABLE\s+([\d.]+\s*[KMGT](?:i?B)?)/i,
  );
  return {
    physical_footprint_mb: sizeTokenToMb(physical?.[1]),
    physical_footprint_peak_mb: sizeTokenToMb(peak?.[1]),
    malloc_large_reusable_mb: sizeTokenToMb(reusable?.[1]),
    vmmap_ok: true,
    vmmap_error: null,
  };
}

export function vmmapSummaryForPid(
  pid,
  {
    spawnSync = defaultSpawnSync,
    pidAlive = isProcessAlive,
    platform = process.platform,
  } = {},
) {
  const numericPid = Number(pid);
  const empty = {
    physical_footprint_mb: null,
    physical_footprint_peak_mb: null,
    malloc_large_reusable_mb: null,
    vmmap_ok: false,
    vmmap_error: null,
  };
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ...empty, vmmap_error: "invalid_pid" };
  }
  if (platform !== "darwin") {
    return { ...empty, vmmap_error: "unsupported_platform" };
  }
  if (!pidAlive(numericPid)) {
    return { ...empty, vmmap_error: "pid_not_alive" };
  }
  const result = spawnSync("vmmap", ["-summary", String(numericPid)], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    return {
      ...empty,
      vmmap_error:
        result.error?.message ||
        String(result.stderr || "").trim() ||
        `vmmap_exit_${result.status}`,
    };
  }
  return parseVmmapSummary(result.stdout || "");
}

function commandClass(comm, command) {
  const raw = String(comm || "").trim() || String(command || "").trim();
  if (!raw) return null;
  return basename(raw.split(/\s+/)[0]);
}

export function parsePsProcessRows(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID")) continue;
    const match = trimmed.match(
      /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/,
    );
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const vszKb = Number(match[4]);
    const ageMs = psAgeTokenToMs(match[5]);
    const comm = match[6] || "";
    const command = (match[7] || comm).trim();
    rows.push({
      pid,
      ppid,
      rss_kb: rssKb,
      vsz_kb: vszKb,
      age_ms: ageMs,
      command,
      command_class: commandClass(comm, command),
    });
  }
  return rows;
}

function psAgeTokenToMs(token) {
  const raw = String(token || "").trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const match = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const secs = Number(match[4] || 0);
  return (((days * 24 + hours) * 60 + minutes) * 60 + secs) * 1000;
}

function descendantRows(rootPid, rows) {
  const byParent = new Map();
  const byPid = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  if (!byPid.has(rootPid)) return [];
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row) out.push(row);
    for (const child of byParent.get(pid) || []) stack.push(child.pid);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

function publicProcessRow(row) {
  if (!row) return null;
  return {
    pid: row.pid,
    ppid: row.ppid,
    rss_mb: roundMbFromKb(row.rss_kb),
    vsz_mb: roundMbFromKb(row.vsz_kb),
    age_ms: row.age_ms,
    command_class: row.command_class,
    command: row.command_class,
  };
}

function isSamplerPsRow(row) {
  if (!row) return false;
  return row.command_class === "ps";
}

export function processTreeResourceSnapshot(
  rootPid,
  {
    spawnSync = defaultSpawnSync,
    pidAlive = isProcessAlive,
    readPs = null,
    topN = 5,
    sampledAt = nowIso(),
  } = {},
) {
  const numericPid = Number(rootPid);
  const empty = {
    ok: false,
    error: null,
    sampled_at: sampledAt,
    root_pid: Number.isInteger(numericPid) ? numericPid : null,
    daemon: null,
    child_count: 0,
    child_rss_total_mb: 0,
    child_vsz_total_mb: 0,
    max_child_age_ms: null,
    top_children: [],
  };
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ...empty, error: "invalid_pid" };
  }
  if (!pidAlive(numericPid)) {
    return { ...empty, error: "pid_not_alive" };
  }
  const result =
    readPs !== null
      ? { status: 0, stdout: readPs }
      : spawnSync("ps", ["-axo", "pid=,ppid=,rss=,vsz=,etime=,comm="], {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 2 * 1024 * 1024,
        });
  if (result.status !== 0) {
    return {
      ...empty,
      error:
        result.error?.message ||
        String(result.stderr || "").trim() ||
        `ps_exit_${result.status}`,
    };
  }
  const tree = descendantRows(numericPid, parsePsProcessRows(result.stdout));
  if (tree.length === 0) return { ...empty, error: "pid_not_found" };
  const root = tree.find((row) => row.pid === numericPid) || null;
  const allChildren = tree.filter((row) => row.pid !== numericPid);
  const samplerChildren = allChildren.filter(isSamplerPsRow);
  const children = allChildren.filter((row) => !isSamplerPsRow(row));
  const rssKb = children.reduce((sum, row) => sum + (row.rss_kb || 0), 0);
  const vszKb = children.reduce((sum, row) => sum + (row.vsz_kb || 0), 0);
  const childAges = children
    .map((row) => row.age_ms)
    .filter((value) => Number.isFinite(value));
  const topChildren = [...children]
    .sort((a, b) => (b.rss_kb || 0) - (a.rss_kb || 0))
    .slice(0, Math.max(0, topN))
    .map(publicProcessRow);
  return {
    ...empty,
    ok: true,
    error: null,
    daemon: publicProcessRow(root),
    child_count: children.length,
    sampler_child_count: samplerChildren.length,
    raw_child_count: allChildren.length,
    child_rss_total_mb: roundMbFromKb(rssKb) ?? 0,
    child_vsz_total_mb: roundMbFromKb(vszKb) ?? 0,
    max_child_age_ms: childAges.length ? Math.max(...childAges) : null,
    top_children: topChildren,
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
  processTreeSnapshot = processTreeResourceSnapshot,
  vmmapFn = null, // optional (pid) => vmmapSummaryForPid result; merged into memory; called at most once.
} = {}) {
  const processTree = includeProcessTree ? processTreeSnapshot(pid) : null;
  const processTreeMode = includeProcessTree ? "included" : "memory_only";
  const samplerReason = includeProcessTree
    ? "process_tree_included"
    : "process_tree_not_requested";

  // Merge vmmap footprint into the memory sub-object (one call max per sample).
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

export { sampleSlope } from "./perf_attribution.mjs";

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
