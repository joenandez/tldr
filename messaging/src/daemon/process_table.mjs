// The daemon's one window onto operating-system processes (ac-srg29).
//
// The daemon's event loop must never wait on a child process: a synchronous
// `ps` over ~1,400 processes at load 300 held the loop for seconds and the
// daemon stopped accepting connections. Everything here is async `execFile`
// with a timeout and a bounded buffer, and the table never has two `ps` runs
// in flight at once.
//
// Two kinds of caller:
//   - async passes (owner reconciliation, retirement) await a snapshot that
//     STARTED after they read their rows (`snapshotStartedAtOrAfter`).
//   - deciders inside a database transaction never await and never spawn.
//     They read the latest snapshot synchronously (`observe`), which says
//     `{ pending: true }` ("no snapshot fresh enough yet") instead of
//     guessing, and kicks one async refresh. Every caller defers on pending.
//
// `{ unavailable: true }` means ps ran and could not answer (spawn error, bad
// exit with no rows). A ps that was killed (timeout, buffer limit) is NOT that:
// it answers nothing, the previous snapshot ages into pending, and pending
// never lets a caller launch, retire or take over.
//
// The all-process snapshot asks for `comm=` (the executable path), never
// every process's full argv (Claude's argv carries whole prompts: 1.3 MB
// against 138 KB). argv is read only for the few pids owner activity needs,
// through one targeted `ps -p` (`argvFor`).
import { execFile } from "node:child_process";

import { normalizeStartIdentity } from "./owner_process_contract.mjs";

// A snapshot older than this never answers (equal to the retirement lease).
export const SNAPSHOT_MAX_AGE_MS = 30_000;
// A snapshot older than this still answers but kicks a refresh.
const REFRESH_AFTER_MS = 5_000;
const SLOW_WARN_MS = 2_000;
const FIRST_SEEN_PRUNE_MS = 10 * 60_000;
const PS_TIMEOUT_MS = 15_000;
const SNAPSHOT_PROBE = {
  file: "ps",
  args: [
    "-A",
    "-o",
    "pid=",
    "-o",
    "ppid=",
    "-o",
    "pgid=",
    "-o",
    "stat=",
    "-o",
    "lstart=",
    "-o",
    "comm=",
  ],
  timeout: PS_TIMEOUT_MS,
  maxBuffer: 8 * 1024 * 1024,
};

// `ps -o lstart=` is locale-formatted; the hook captured it under the C
// locale (src/cli/hook_identity.mjs), so every observation here does too.
function run(execFileFn, { file, args, ...options }) {
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  return new Promise((resolve) => {
    execFileFn(
      file,
      args,
      { encoding: "utf8", env, ...options },
      (error, stdout) => {
        resolve({ error, stdout: String(stdout ?? "") });
      },
    );
  });
}

/** A killed child (timeout, buffer limit) answered nothing; it did not fail to answer. */
const interrupted = (error) =>
  error?.killed === true || error?.code === "ETIMEDOUT";

// pid, ppid, pgid, stat, lstart (fixed C-locale shape), then comm: the one
// column that may hold spaces, so it is sliced off after the matched prefix.
const SNAPSHOT_PREFIX =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?=\s|$)/;

/** `ps -A` output as Map<pid, { pid, ppid, processGroupId, stat, startIdentity, comm, command }>; `command` is `comm` until argv is fetched. */
export function parseProcessTable(raw) {
  const processes = new Map();
  for (const line of String(raw).split("\n")) {
    const match = SNAPSHOT_PREFIX.exec(line);
    if (!match) continue;
    const comm = line.slice(match[0].length).trim();
    processes.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      processGroupId: Number(match[3]),
      stat: match[4],
      startIdentity: normalizeStartIdentity(match[5]),
      comm,
      command: comm,
    });
  }
  return processes;
}

/** One snapshot entry as `ps -p` always answered: the process, or null when absent or a zombie. */
export function liveEntry(snapshot, pid) {
  const entry = snapshot.get(pid);
  return entry && !String(entry.stat ?? "").startsWith("Z") ? entry : null;
}

/** What an async pass may read from a snapshot: its process Map, `{ pending }` (ps was killed), or `{ unavailable }`. */
export function snapshotAnswer(snapshot) {
  if (snapshot.interrupted) return { pending: true };
  return snapshot.processes ?? { unavailable: true };
}

function warn(table, event, details) {
  table.getLogger()?.warn?.({ event, ...details });
}

function logProbe(table, { probe, startedAtMs, error }) {
  const latencyMs = table.now() - startedAtMs;
  if (!error && latencyMs <= SLOW_WARN_MS) return;
  const result = {
    code: error?.code ?? null,
    killed: Boolean(error?.killed),
    message: String(error?.message ?? "").slice(0, 200),
  };
  warn(
    table,
    error ? "process_observation_failed" : "process_observation_slow",
    {
      params: { probe },
      ...(error ? { result } : {}),
      status: error ? "error" : "slow",
      latency_ms: latencyMs,
    },
  );
}

// One ps at a time, whatever asks for it.
function exclusive(table, job) {
  const result = table.tail.then(job);
  table.tail = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function runSnapshot(table) {
  const seq = (table.started += 1);
  const startedAtMs = table.now();
  const { error, stdout } = await run(table.execFileFn, SNAPSHOT_PROBE);
  const processes = error ? null : parseProcessTable(stdout);
  const snapshot = {
    seq,
    startedAtMs,
    finishedAtMs: table.now(),
    processes: processes?.size ? processes : null,
    interrupted: interrupted(error),
  };
  // A killed ps is no answer: the previous snapshot stays and ages into pending.
  if (!snapshot.interrupted) table.latest = snapshot;
  for (const [key, seen] of table.firstSeen) {
    if (snapshot.finishedAtMs - seen.lastMs > FIRST_SEEN_PRUNE_MS)
      table.firstSeen.delete(key);
  }
  logProbe(table, {
    probe: "snapshot",
    startedAtMs,
    error: error ?? (snapshot.processes ? null : { code: "empty" }),
  });
  return snapshot;
}

/** One refresh in flight at a time; a caller during one joins it. Never rejects. */
function refresh(table) {
  table.inflight ??= exclusive(table, () => runSnapshot(table)).finally(() => {
    table.inflight = null;
  });
  return table.inflight;
}

function firstSeenAt(table, pid, owner) {
  const nowMs = table.now();
  const key = `${pid}\u0000${normalizeStartIdentity(owner?.owner_process_start_identity)}`;
  const seen = table.firstSeen.get(key) ?? { firstMs: nowMs, lastMs: nowMs };
  seen.lastMs = nowMs;
  table.firstSeen.set(key, seen);
  return seen.firstMs;
}

/**
 * Synchronous, in-transaction-safe: `{ pid, startIdentity, processGroupId }`,
 * null (absent, zombie), `{ unavailable: true }` (ps could not answer), or
 * `{ pending: true }` (no snapshot fresh enough, or one that began before
 * this owner was first seen here: an owner that registered after a snapshot
 * began can be absent from it, and absent must never read as exited).
 */
function observe(table, pid, owner) {
  const firstMs = firstSeenAt(table, pid, owner);
  const snapshot = table.latest;
  const ageMs = snapshot ? table.now() - snapshot.startedAtMs : Infinity;
  if (
    !snapshot ||
    ageMs > SNAPSHOT_MAX_AGE_MS ||
    snapshot.startedAtMs <= firstMs
  ) {
    refresh(table);
    return { pending: true };
  }
  if (ageMs > REFRESH_AFTER_MS) refresh(table);
  const answer = snapshotAnswer(snapshot);
  if (!(answer instanceof Map)) return answer;
  const entry = liveEntry(answer, pid);
  return (
    entry && {
      pid,
      startIdentity: entry.startIdentity,
      processGroupId: entry.processGroupId,
    }
  );
}

/** Map<pid, argv string> for these pids (one targeted ps), or null when ps gave no answer (failed or killed). */
function runArgv(table, pids) {
  const startedAtMs = table.now();
  const probe = {
    file: "ps",
    args: ["-ww", "-o", "pid=", "-o", "command=", "-p", pids.join(",")],
    timeout: PS_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  };
  return run(table.execFileFn, probe).then(({ error, stdout }) => {
    // ps exits 1 when some listed pid already exited, and still prints the rest.
    const failed = error && !(error.code === 1 && stdout.trim() !== "");
    logProbe(table, {
      probe: "argv",
      startedAtMs,
      error: failed ? error : null,
    });
    if (failed) return null;
    const rows = stdout
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line));
    return new Map(
      rows.filter(Boolean).map((match) => [Number(match[1]), match[2].trim()]),
    );
  });
}

/** One process table per daemon context; `execFileFn` and `now` are the test seams. */
export function createProcessTable({
  execFileFn = execFile,
  now = Date.now,
  getLogger = () => null,
} = {}) {
  const table = {
    execFileFn,
    now,
    getLogger,
    latest: null,
    inflight: null,
    started: 0, // snapshots started so far: a causal order that a millisecond clock cannot give
    tail: Promise.resolve(),
    firstSeen: new Map(),
  };
  return {
    refresh: () => refresh(table),
    /**
     * A snapshot whose `ps` started strictly after `startMs` (the caller's row
     * read), or after this call began (which is after the read, even inside one
     * millisecond). A refresh that began earlier is waited out, then redone.
     */
    async snapshotStartedAtOrAfter(startMs) {
      const calledAfterSeq = table.started;
      let snapshot = await refresh(table);
      // A killed ps is returned as is (answers pending), never retried without end.
      while (
        !snapshot.interrupted &&
        snapshot.startedAtMs <= startMs &&
        snapshot.seq <= calledAfterSeq
      ) {
        // Each refresh must finish before the next may start: one ps at a time.
        // eslint-disable-next-line no-await-in-loop
        snapshot = await refresh(table);
      }
      return snapshot;
    },
    observe: (pid, owner) => observe(table, pid, owner),
    argvFor(pids) {
      // Every candidate in one ps: the output bound is maxBuffer, and an answer
      // that overflows it is unknown (null), never a partial one.
      const list = [...new Set(pids)];
      return list.length === 0
        ? Promise.resolve(new Map())
        : exclusive(table, () => runArgv(table, list));
    },
    latest: () => table.latest,
  };
}

const tables = new WeakMap();

/** The daemon context's process table (one per context, like liveOwnersFor). */
export function processTableFor(context, options = {}) {
  if (!tables.has(context))
    tables.set(
      context,
      createProcessTable({ getLogger: () => context.logger, ...options }),
    );
  return tables.get(context);
}

/** `observeProcess(pid, owner)` for the in-transaction deciders: reads the latest snapshot, never spawns, never awaits. */
export function processObserverFor(context) {
  return (pid, owner) => processTableFor(context).observe(pid, owner);
}

// lsof lives in /usr/sbin, which a daemon started from launchd or a GUI does
// not always have on PATH (src/cli/hook_process_tree.mjs hit the same thing
// live). The absolute path is tried first, the PATH lookup second.
const LSOF_COMMANDS = Object.freeze(["/usr/sbin/lsof", "lsof"]);

/**
 * The live processes holding one file open: `{ pids }` (empty when nobody
 * does), `{ pending: true }` when lsof was killed before it answered (never a
 * decision), or `{ unavailable: true }` when lsof could not answer. A fixed
 * probe of one path the caller built from a validated name; never a shell.
 * F34 uses it to ask who holds a Codex thread's writer lock.
 */
export async function observeFileHolders(
  filePath,
  { execFileFn = execFile } = {},
) {
  for (const file of LSOF_COMMANDS) {
    const probe = {
      file,
      args: ["-t", "--", filePath],
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    };
    // Probes run one after the other on purpose: the second is only a fallback for ENOENT.
    // eslint-disable-next-line no-await-in-loop
    const result = await run(execFileFn, probe);
    if (result.error?.code !== "ENOENT") return holdersAnswer(result);
  }
  return { unavailable: true };
}

// lsof exits 1 for "nothing found", and also when it could not inspect some
// other process while still answering; only a failure that produced no answer
// at all and is not the plain "nothing" exit is unknown. A killed (timed-out)
// lsof is unknown too: an unknown host never starts a writer, and the hosted
// path's unknown window still ends a request lsof can never answer.
function holdersAnswer({ error, stdout }) {
  if (error && error.code !== 1) return { unavailable: true };
  const lines = stdout.split("\n").map((line) => line.trim());
  return { pids: lines.filter((line) => /^\d+$/.test(line)).map(Number) };
}
