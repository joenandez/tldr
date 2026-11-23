// ac-jfv.116: what a live owner process is doing, read from the process
// snapshot the owner reconciler already takes each pass (retirement_executor.mjs
// snapshotProcesses). Pure functions over that snapshot; no ps, no database.
import { normalizeStartIdentity } from "./owner_process_contract.mjs";

// pid, ppid, then lstart (fixed C-locale shape: weekday month day time year);
// the command is everything after it. The prefix is matched alone and the rest
// is sliced and trimmed, so a command of any length parses in linear time.
const SNAPSHOT_PREFIX =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?=\s|$)/;

const NODE = /^node(\d+(\.\d+)*)?$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
const basename = (token) => token.slice(token.lastIndexOf("/") + 1);

/**
 * Is this `ps` command line a running `agent wait`? Decided on argv structure
 * (ps joins argv with spaces): argv[0] (or argv[1] when argv[0] is node, node24,
 * ...) is the snapshot's `tightbeam` bin followed by `agent wait`, or the
 * `tldr-agents` front door followed by `messaging agent wait`. A shell run with -c/-lc never is: its argument text
 * only names the command. shortcut: tokens split on whitespace, so a launcher
 * path containing spaces does not match; upgrade if live rows show one.
 */
export function isAgentWaitCommand(command) {
  const argv = String(command).trim().split(/\s+/, 8);
  if (
    SHELLS.has(basename(argv[0])) &&
    argv.slice(1, 4).some((token) => /^-[a-z]*c[a-z]*$/.test(token))
  )
    return false;
  // argv[1] is a launcher only behind node; behind any other program it is an argument.
  const i = NODE.test(basename(argv[0])) ? 1 : 0;
  const name = basename(argv[i] ?? "");
  if (name === "tightbeam")
    return argv[i + 1] === "agent" && argv[i + 2] === "wait";
  return (
    name === "tldr-agents" &&
    argv[i + 1] === "messaging" &&
    argv[i + 2] === "agent" &&
    argv[i + 3] === "wait"
  );
}

/**
 * One `ps -A -o pid= -o ppid= -o lstart= -o command=` output as
 * Map<pid, { pid, startIdentity, ppid, command }>. `startIdentity` is the same
 * normalized start text liveness has always compared.
 */
export function parseProcessSnapshot(raw) {
  const processes = new Map();
  for (const line of String(raw).split("\n")) {
    const match = SNAPSHOT_PREFIX.exec(line);
    if (match)
      processes.set(Number(match[1]), {
        pid: Number(match[1]),
        startIdentity: normalizeStartIdentity(match[3]),
        ppid: Number(match[2]),
        command: line.slice(match[0].length).trim(),
      });
  }
  return processes;
}

// Per snapshot: the parent index, and each owner pid's walk result (endpoints can share an owner).
const indexBySnapshot = new WeakMap();

/** Map<ppid, entries[]>; entries without a ppid (an old-shape snapshot) are skipped. */
export function childrenOf(snapshot) {
  const children = new Map();
  for (const entry of snapshot.values()) {
    if (!Number.isInteger(entry.ppid)) continue;
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry);
  }
  return children;
}

function descendants(children, ownerPid) {
  const seen = new Set([ownerPid]);
  const found = [];
  const queue = [ownerPid];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of children.get(queue[cursor]) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      found.push(child);
    }
  }
  return found;
}

/**
 * waiting_on_message when a descendant of the owner is an `agent wait` process
 * (since the earliest such process itself started), else working.
 */
export function ownerActivityFromSnapshot(
  snapshot,
  ownerPid,
  children = childrenOf(snapshot),
) {
  const waits = descendants(children, ownerPid).filter((entry) =>
    isAgentWaitCommand(entry.command ?? ""),
  );
  if (waits.length === 0) return { activity: "working", waiting_since: null };
  const startedMs = Math.min(
    ...waits.map((entry) => Date.parse(entry.startIdentity)),
  );
  return {
    activity: "waiting_on_message",
    waiting_since: Number.isFinite(startedMs)
      ? new Date(startedMs).toISOString()
      : null,
  };
}

/**
 * One daemon-memory entry for a watched endpoint row whose owner the pass saw
 * alive. It is keyed to that exact owner (pid, start identity, generation); only
 * a busy owner carries process activity. The parent index and each owner's
 * subtree walk are done once per snapshot.
 */
export function observeOwnerActivity(snapshot, row, observedAt) {
  if (!indexBySnapshot.has(snapshot))
    indexBySnapshot.set(snapshot, {
      children: childrenOf(snapshot),
      byOwner: new Map(),
    });
  const { children, byOwner } = indexBySnapshot.get(snapshot);
  if (row.state === "busy" && !byOwner.has(row.owner_process_pid))
    byOwner.set(
      row.owner_process_pid,
      ownerActivityFromSnapshot(snapshot, row.owner_process_pid, children),
    );
  return {
    ...(row.state === "busy"
      ? byOwner.get(row.owner_process_pid)
      : { activity: null, waiting_since: null }),
    owner_process_pid: row.owner_process_pid,
    owner_process_start_identity: normalizeStartIdentity(
      row.owner_process_start_identity,
    ),
    process_generation: row.process_generation,
    observed_at: observedAt,
  };
}
