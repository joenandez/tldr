import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { isProcessAlive } from "./process_liveness.mjs";

function nowMs() {
  return process.env.HELM_NOW
    ? new Date(process.env.HELM_NOW).getTime()
    : Date.now();
}

export const isPidAlive = isProcessAlive;

export function activeRunStatus(entry) {
  if (!entry) return null;
  const alive = isPidAlive(entry.pid);
  if (!alive) return null;
  return {
    ...entry,
    alive: true,
    elapsed_ms: Math.max(0, nowMs() - new Date(entry.started_at).getTime()),
  };
}

// Parse `ps -o time=` output into milliseconds. Accepts both macOS/BSD
// (`M:SS.ss` or `H:MM:SS.ss`) and Linux (`HH:MM:SS`) shapes.
export function parsePsCpuTimeMs(raw) {
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(":");
  // Right-most is seconds (possibly fractional), then minutes, then hours, etc.
  let ms = 0;
  const multipliers = [1000, 60_000, 3_600_000, 86_400_000];
  for (let i = 0; i < parts.length; i++) {
    const val = Number(parts[parts.length - 1 - i]);
    if (!Number.isFinite(val)) return 0;
    ms += val * multipliers[i];
  }
  return Math.round(ms);
}

function readPsAll() {
  const res = spawnSync("ps", ["-eo", "pid,ppid,time="], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (res.error || res.status !== 0) return "";
  return res.stdout || "";
}

// Sum CPU time across a process tree rooted at `rootPid`. Walks the
// pid/ppid relationships in a single `ps` snapshot to avoid repeated
// process calls. Returns 0 if the root is missing (already exited).
export function sampleProcessTreeCpuMs(rootPid, readPsFn = readPsAll) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return 0;
  const raw = readPsFn();
  if (!raw) return 0;

  const childrenOf = new Map();
  const cpuOf = new Map();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpu = parsePsCpuTimeMs(match[3]);
    cpuOf.set(pid, cpu);
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }

  if (!cpuOf.has(rootPid)) return 0;

  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += cpuOf.get(pid) || 0;
    for (const child of childrenOf.get(pid) || []) stack.push(child);
  }
  return total;
}

// Opportunity #9: heartbeat-file mtime in ms. 0 when the run has no
// heartbeat path or the file doesn't exist yet.
export function sampleHeartbeatMs(path) {
  if (!path) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Max mtime in ms across a run's log paths. 0 if neither exists.
export function sampleLogActivityMs(logPaths) {
  if (!logPaths) return 0;
  let maxMs = 0;
  for (const p of [logPaths.stdout, logPaths.stderr]) {
    if (!p) continue;
    try {
      const s = statSync(p);
      if (s.mtimeMs > maxMs) maxMs = s.mtimeMs;
    } catch {
      // missing files are expected before first write
    }
  }
  return maxMs;
}
