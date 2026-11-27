import fs from "node:fs";

import { withScratchLock } from "./hook_scratch.mjs";

// ---- Shown/claim ledger (contract C6) ----------------------------------------
// ONE set per session (paths.shown) for the foreground notice, the detached
// drain and PostToolUse. Append-only JSON lines {id, state, pid}; the last line
// per id wins. States: claimed (a live pid is staging/showing it, for at most
// CLAIM_MAX_AGE_MS), released
// (staging failed or finished; claimable again), shown (final: never staged or
// rendered again, even after pending-inject.jsonl is gone).
// Every mutation holds the scratch lock. The lock is non-blocking, so a busy
// lock returns {claimed:false, reason:'busy'}: skip and retry at the next boundary.
// A claim spans local file work only (claim, stage or show, commit; the drain claims after
// its daemon reply): milliseconds, seconds on a loaded host. An older claim's holder crashed
// (its pid may be reused); 30 s matches the scratch lock's staleness bound.
export const CLAIM_MAX_AGE_MS = 30_000;
const LEDGER_COMPACT_BYTES = 32 * 1024;
// Compaction keeps shown rows within half the trigger, so the next rewrite is a full half-trigger of appends away.
const LEDGER_KEEP_BYTES = LEDGER_COMPACT_BYTES / 2;

function readLedger(paths) {
  const latest = new Map();
  let raw = "";
  try {
    raw = fs.readFileSync(paths.shown, "utf8");
  } catch {
    return latest;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue; // appendLedger's separator newlines
    try {
      const row = JSON.parse(line);
      if (typeof row?.id === "string" && typeof row.state === "string") {
        latest.delete(row.id); // re-insert so Map order is recency order
        latest.set(row.id, row);
      }
    } catch {
      // torn line (a crash mid-append): skip it
    }
  }
  return latest;
}

function appendLedger(paths, row) {
  // Leading newline: a torn final line never glues onto this record.
  const fd = fs.openSync(paths.shown, "a", 0o600);
  try {
    fs.writeFileSync(fd, `\n${JSON.stringify(row)}\n`);
    // Only "shown" must survive a crash; a lost claim or release reads as a dead claim, which is reclaimed anyway.
    if (row.state === "shown") fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.statSync(paths.shown).size <= LEDGER_COMPACT_BYTES) return;
  compactLedger(paths);
}

// Rewrites the ledger keeping live claims and the newest shown rows within LEDGER_KEEP_BYTES.
function compactLedger(paths) {
  let budget = LEDGER_KEEP_BYTES;
  const kept = [...readLedger(paths).values()]
    .filter((r) => r.state !== "released")
    .reverse()
    .filter(
      (r) =>
        r.state === "claimed" || (budget -= JSON.stringify(r).length + 1) >= 0,
    )
    .reverse()
    .map((r) => `${JSON.stringify(r)}\n`);
  const temporary = `${paths.shown}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, kept.join(""));
    fs.fsyncSync(fd); // "shown survives a crash" must hold across the rename
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, paths.shown);
}

const probe = (pid) => {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
};

const pidAlive = (pid) =>
  Number.isSafeInteger(pid) && pid > 0 && (pid === process.pid || probe(pid));

/** Decides a claim and records it. Returns {claimed, reason?, recovered?}. */
export function claimRow(paths, id) {
  const row = readLedger(paths).get(id);
  if (row?.state === "shown") return { claimed: false, reason: "shown" };
  const fresh = Date.now() - row?.at < CLAIM_MAX_AGE_MS;
  if (row?.state === "claimed" && fresh && pidAlive(row.pid))
    return { claimed: false, reason: "held" };
  appendLedger(paths, {
    id,
    state: "claimed",
    pid: process.pid,
    at: Date.now(),
  });
  return row?.state === "claimed"
    ? { claimed: true, recovered: true }
    : { claimed: true };
}

export function releaseRow(paths, id) {
  if (readLedger(paths).get(id)?.state === "claimed")
    appendLedger(paths, { id, state: "released", at: Date.now() });
}

export function shownRow(paths, id) {
  appendLedger(paths, { id, state: "shown", at: Date.now() });
}

export function isShownRow(paths, id) {
  return readLedger(paths).get(id)?.state === "shown";
}

/** One ledger read for many checks: returns isShown(id, attempt). */
export function shownSnapshot(paths) {
  const ledger = readLedger(paths);
  return (id, attempt) => ledger.get(noticeKey(id, attempt))?.state === "shown";
}

// Shown/claim API over the rows above. Mutations hold the non-blocking
// scratch lock; a busy lock means skip and retry at the next boundary.
// claimNotice returns {claimed:true[, recovered:true]} or
// {claimed:false, reason:'shown'|'held'|'busy'}. 'shown': never stage or
// render; 'held': a live pid has it; 'busy': scratch lock busy. After claiming
// call releaseNotice (staged, unshown) or markNoticeShown. The key is
// (id, attempt): a daemon retry re-rings the same delivery as attempt 'retry'
// and must show once more.
const noticeKey = (id, attempt = "initial") => `${id}#${attempt}`;

// Callers log the outcome (the drain's drain_result carries reason and recovered).
export const claimNotice = (paths, id, attempt) =>
  withScratchLock(paths, () => claimRow(paths, noticeKey(id, attempt))) ?? {
    claimed: false,
    reason: "busy",
  };

/** Gives a claim back unshown; the id stays claimable. False if the lock was busy. */
export const releaseNotice = (paths, id, attempt) =>
  withScratchLock(
    paths,
    () => releaseRow(paths, noticeKey(id, attempt)) ?? true,
  ) === true;

/** Records `id` shown (final), claim or not. False if the lock was busy. */
export const markNoticeShown = (paths, id, attempt) =>
  withScratchLock(
    paths,
    () => shownRow(paths, noticeKey(id, attempt)) ?? true,
  ) === true;

export const isNoticeShown = (paths, id, attempt) =>
  isShownRow(paths, noticeKey(id, attempt));
