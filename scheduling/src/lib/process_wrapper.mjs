import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { isSameProcessAlive } from "./process_liveness.mjs";
import { buildSubspaceProviderLaunch } from "./subspace_memory_provider.mjs";
import {
  buildMemoryContext,
  buildSubspaceMemoryLaunch,
} from "./subspace_memory_launch.mjs";

export { buildMemoryContext };

const VALID_MEMORY_MODES = new Set(["read+write", "off"]);
const WRAPPER_UNAVAILABLE_RE =
  /\[helm-job-memory-wrapper\] grove env unavailable \(([^)]+)\)/;
const WRAPPER_PREFLIGHT_EXIT = 86;

function nowIso() {
  return new Date().toISOString();
}

function lifecycle(state, data = {}) {
  return { state, ts: nowIso(), ...data };
}

export function isValidMemoryMode(mode) {
  return VALID_MEMORY_MODES.has(mode);
}

export function normalizeMemoryMode(mode, fallback = null) {
  if (typeof mode !== "string") return fallback;
  const normalized = mode.trim().toLowerCase();
  return isValidMemoryMode(normalized) ? normalized : fallback;
}

export function scrubSubspaceMemoryEnv(env = {}) {
  const next = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (key.startsWith("GROVE_")) continue;
    if (key.startsWith("SUBSPACE_")) continue;
    if (key === "HELM_MEMORY_CONTEXT" || key === "HELM_MEMORY_MODE") continue;
    next[key] = value;
  }
  return next;
}

export function isExecutableFile(path) {
  if (typeof path !== "string" || !path) return false;
  try {
    accessSync(path, constants.X_OK);
    let head = "";
    try {
      head = readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, 256);
    } catch {
      return true;
    }
    if (head.startsWith("#!")) {
      const interpreter = head
        .slice(2)
        .split(/\r?\n/, 1)[0]
        .trim()
        .split(/\s+/, 1)[0];
      if (interpreter.startsWith("/")) accessSync(interpreter, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function memoryEvidence({
  requestedMode = "read+write",
  effectiveMode = "off",
  reason = "no_provider",
  cwd = null,
  workspace = null,
  notes = [],
} = {}) {
  return {
    requested_mode: requestedMode,
    effective_mode: effectiveMode,
    reason,
    workspace,
    read: effectiveMode === "read+write",
    write: effectiveMode === "read+write",
    context_cwd: cwd,
    notes,
  };
}

export function resolveMemoryRequest({
  requestedMode,
  env = {},
  job = null,
} = {}) {
  const explicit = normalizeMemoryMode(requestedMode);
  if (explicit) return { mode: explicit, source: "invocation", warnings: [] };

  const warnings = [];
  if (env.HELM_MEMORY !== undefined) {
    const fromEnv = normalizeMemoryMode(env.HELM_MEMORY);
    if (fromEnv) return { mode: fromEnv, source: "env", warnings };
    warnings.push(
      `warning: ignoring HELM_MEMORY="${env.HELM_MEMORY}" (not one of read+write, off); using ${normalizeMemoryMode(job?.memory?.mode, "read+write")}.`,
    );
  }

  const sticky = normalizeMemoryMode(job?.memory?.mode);
  if (sticky) return { mode: sticky, source: "job", warnings };
  return { mode: "read+write", source: "default", warnings };
}

export function reasonFromWrapperUnavailable(rawReason) {
  const reason = String(rawReason || "");
  if (reason === "cwd_not_in_grove_db") return "cwd_unmappable";
  if (reason === "grove_db_not_found") return "no_provider";
  if (reason.includes("not_entitled") || reason.includes("not_enabled")) {
    return "not_entitled";
  }
  return "provider_error";
}

export function wrapperDelegatesCommand({
  wrapperPath,
  cwd,
  env = {},
  requestedMode = "read+write",
} = {}) {
  if (!isExecutableFile(wrapperPath)) return false;
  const { wrapperEnv } = buildSubspaceProviderLaunch(
    env,
    scrubSubspaceMemoryEnv,
  );
  const launch = buildSubspaceMemoryLaunch({
    command: process.execPath,
    args: ["-e", `process.exit(${WRAPPER_PREFLIGHT_EXIT})`],
    env: wrapperEnv,
    cwd,
    requestedMode,
  });
  const result = spawnSync(wrapperPath, launch.args, {
    cwd,
    env: launch.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return !result.error && result.status === WRAPPER_PREFLIGHT_EXIT;
}

export function deriveMemoryAfterRun(memory, stderr = "") {
  if (!memory || memory.effective_mode !== "read+write") return memory || null;
  const match = String(stderr || "").match(WRAPPER_UNAVAILABLE_RE);
  if (!match) return memory;
  const reason = reasonFromWrapperUnavailable(match[1]);
  return {
    ...memory,
    effective_mode: "off",
    reason,
    workspace: null,
    read: false,
    write: false,
    notes: [...(memory.notes || []), `wrapper:${match[1]}`],
  };
}

export function planMemoryLaunch({
  command,
  args = [],
  cwd,
  env = {},
  requestedMode = "read+write",
  wrapperPath = undefined,
} = {}) {
  const requested = normalizeMemoryMode(requestedMode, "read+write");
  const provider = buildSubspaceProviderLaunch(
    env,
    scrubSubspaceMemoryEnv,
    wrapperPath,
  );
  if (requested === "off") {
    return {
      command,
      args,
      env: provider.cleanEnv,
      memory: memoryEvidence({
        requestedMode: requested,
        effectiveMode: "off",
        reason: "operator_off",
        cwd,
      }),
    };
  }

  const resolvedWrapper =
    typeof provider.wrapper === "string" && isExecutableFile(provider.wrapper)
      ? provider.wrapper
      : null;
  if (!resolvedWrapper) {
    return {
      command,
      args,
      env: provider.directEnv,
      memory: memoryEvidence({
        requestedMode: requested,
        effectiveMode: "off",
        reason: "no_provider",
        cwd,
      }),
    };
  }

  if (
    !wrapperDelegatesCommand({
      wrapperPath: resolvedWrapper,
      cwd,
      env: provider.wrapperEnv,
      requestedMode: requested,
    })
  ) {
    return {
      command,
      args,
      env: provider.directEnv,
      memory: memoryEvidence({
        requestedMode: requested,
        effectiveMode: "off",
        reason: "provider_error",
        cwd,
        notes: ["wrapper_preflight_failed"],
      }),
    };
  }

  const launch = buildSubspaceMemoryLaunch({
    command,
    args,
    env: provider.wrapperEnv,
    cwd,
    requestedMode: requested,
  });
  return {
    command: resolvedWrapper,
    args: launch.args,
    env: launch.env,
    memory: memoryEvidence({
      requestedMode: requested,
      effectiveMode: "read+write",
      reason: "ok",
      cwd,
    }),
  };
}

// Opportunity #9: tree snapshot with per-PID start times, so post-kill
// verification can re-check exactly the processes that existed at TERM time
// (identity-verified — PID reuse can't trigger a wrong re-kill) instead of
// re-walking a tree whose root is already gone. Returns null when ps itself
// fails: "unknown" must never read as "tree empty".
export function processTreeSnapshot(rootPid, readPs = null) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const result =
    readPs ??
    spawnSync("ps", ["-eo", "pid=,ppid=,lstart="], {
      encoding: "utf8",
      timeout: 5000,
    });
  if (typeof result !== "string" && (result.error || result.status !== 0)) {
    return null;
  }
  const raw = typeof result === "string" ? result : result.stdout || "";
  if (!raw.trim()) return null;
  const childrenOf = new Map();
  const startOf = new Map();
  for (const line of raw.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    startOf.set(pid, match[3].trim());
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  const found = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid) || !startOf.has(pid)) continue;
    seen.add(pid);
    found.push({ pid, start_time: startOf.get(pid) });
    for (const child of childrenOf.get(pid) || []) stack.push(child);
  }
  return found.sort((a, b) => a.pid - b.pid);
}

export function processTreePids(rootPid, readPs = null) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const result =
    readPs ||
    spawnSync("ps", ["-eo", "pid,ppid,pgid"], {
      encoding: "utf8",
      timeout: 5000,
    });
  const raw = typeof result === "string" ? result : result.stdout || "";
  const childrenOf = new Map();
  const pids = new Set();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID")) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    pids.add(pid);
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  if (!pids.has(rootPid)) return [];
  const found = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    for (const child of childrenOf.get(pid) || []) stack.push(child);
  }
  return found.sort((a, b) => a - b);
}

// Opportunity #9: a real kill grace. The previous 250ms default gave
// children no realistic window to flush/exit on SIGTERM.
export function defaultKillGraceMs() {
  const sec = Number(process.env.HELM_KILL_GRACE_SEC);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  return 10_000;
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return { ok: true, signal, target: "process_group", pgid: pid };
  } catch (err) {
    try {
      process.kill(pid, signal);
      return {
        ok: true,
        signal,
        target: "process",
        pid,
        group_error: err?.code || err?.message || String(err),
      };
    } catch (fallbackErr) {
      return {
        ok: false,
        signal,
        target: "process_group",
        pgid: pid,
        error: fallbackErr?.code || fallbackErr?.message || String(fallbackErr),
      };
    }
  }
}

export function spawnWrappedCommand({
  command,
  args = [],
  cwd,
  env,
  memoryMode = null,
  memoryWrapperPath = undefined,
  stdio = ["pipe", "pipe", "pipe"],
  timeoutMs = null,
  killGraceMs = null,
  onSpawn = null,
} = {}) {
  const planned = planMemoryLaunch({
    command,
    args,
    cwd,
    env,
    requestedMode: memoryMode || "read+write",
    wrapperPath: memoryWrapperPath,
  });
  const evidence = {
    version: "1.0",
    command: planned.command,
    args: planned.args,
    requested_command: command,
    requested_args: args,
    cwd,
    memory: planned.memory,
    lifecycle: [],
    cleanup: null,
  };
  evidence.lifecycle.push(lifecycle("spawned"));
  const child = spawn(planned.command, planned.args, {
    cwd,
    env: planned.env,
    stdio,
    detached: true,
  });
  evidence.pid = child.pid || null;
  evidence.pgid = child.pid || null;
  evidence.lifecycle.push(
    lifecycle("pg_ready", { pid: child.pid, pgid: child.pid }),
  );
  evidence.lifecycle.push(lifecycle("pre_exec", { pid: child.pid }));
  if (typeof onSpawn === "function") {
    onSpawn({
      pid: child.pid,
      pgid: child.pid,
      command: planned.command,
      args: planned.args,
      cwd,
      wrapper: evidence,
    });
  }

  let timedOut = false;
  let termTimer = null;
  let killTimer = null;
  let treeSnapshot = null;
  let verifyStarted = false;
  const graceResolved =
    Number.isFinite(killGraceMs) && killGraceMs >= 0
      ? killGraceMs
      : defaultKillGraceMs();

  // Opportunity #9: confirm the kill against the TERM-time snapshot with
  // bounded re-escalation. The old path declared "tree_reaped" off a single
  // full-system ps walk from an already-dead root (which can only return
  // []), so detached survivors read as reaped.
  const VERIFY_ATTEMPTS = 5;
  const VERIFY_INTERVAL_MS = 200;
  const verifyTreeReaped = (attempt = 0) => {
    if (!evidence.cleanup) return;
    if (!treeSnapshot) {
      evidence.cleanup.after_pids = null;
      evidence.cleanup.result = "verification_unavailable";
      return;
    }
    const survivors = treeSnapshot.filter(
      (s) => s.pid !== process.pid && isSameProcessAlive(s.pid, s.start_time),
    );
    evidence.cleanup.after_pids = survivors.map((s) => s.pid);
    if (survivors.length === 0) {
      evidence.cleanup.result = "tree_reaped";
      return;
    }
    for (const s of survivors) {
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {
        // already gone or not ours anymore
      }
    }
    if (attempt + 1 >= VERIFY_ATTEMPTS) {
      evidence.cleanup.result = "survivors_remain";
      return;
    }
    // Deliberately not unref()'d — the launcher must stay alive until the
    // escalation either confirms the reap or exhausts its retries.
    setTimeout(() => verifyTreeReaped(attempt + 1), VERIFY_INTERVAL_MS);
  };
  const startVerification = () => {
    if (verifyStarted) return;
    verifyStarted = true;
    verifyTreeReaped();
  };

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    // Deliberately not unref()'d: with unref'd timers, a launcher whose
    // event loop drained before the timeout exited without ever sending
    // TERM/KILL, orphaning the whole tree.
    termTimer = setTimeout(() => {
      timedOut = true;
      treeSnapshot = processTreeSnapshot(child.pid);
      const term = signalProcessGroup(child.pid, "SIGTERM");
      evidence.cleanup = {
        reason: "timeout",
        timeout_ms: timeoutMs,
        attempted_signals: [term],
        before_pids: treeSnapshot ? treeSnapshot.map((s) => s.pid) : null,
        after_pids: [],
        result: "term_sent",
      };
      killTimer = setTimeout(() => {
        const kill = signalProcessGroup(child.pid, "SIGKILL");
        evidence.cleanup.attempted_signals.push(kill);
        evidence.cleanup.result = kill.ok ? "kill_sent" : "kill_failed";
        startVerification();
      }, graceResolved);
    }, timeoutMs);
  }

  const clearTimers = () => {
    if (termTimer) clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
  };

  child.once("spawn", () => {
    evidence.lifecycle.push(lifecycle("post_exec", { pid: child.pid }));
  });

  child.once("close", (code, signal) => {
    clearTimers();
    evidence.lifecycle.push(lifecycle("exited", { code, signal }));
    // If the timeout path engaged, verify against the TERM-time snapshot —
    // the direct child exiting says nothing about detached descendants.
    if (evidence.cleanup) startVerification();
    evidence.lifecycle.push(lifecycle("finalized", { timed_out: timedOut }));
  });

  child.once("error", (err) => {
    clearTimers();
    evidence.lifecycle.push(
      lifecycle("finalized", {
        error: err?.message || String(err),
        timed_out: timedOut,
      }),
    );
  });

  return { child, evidence };
}
