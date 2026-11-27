// hnbc 1.15: failure backoff for the detached drain.
//
// While the daemon is down every tool call would start foreground Node and spawn a
// drain worker that fails. A failed drain writes sessions/<id>/drain.backoff as
// {until_ms, n}; the foreground skips the spawn while now < until_ms (one read, no IPC,
// no wait). The first successful pass deletes the file. The backoff only gates the drain
// spawn: a notice already local still shows. If the watermark changes while backed off,
// the spawn is still skipped until until_ms (simple rule: the local notice still shows).
import fs from "node:fs";
import path from "node:path";

export const DRAIN_VERB = "pre-tool-use";
const BASE_MS = 1_000;
const MAX_MS = 60_000;
const LOG_EVERY = 10;

const backoffPath = (paths) => path.join(paths.dir, "drain.backoff");

function readBackoff(paths) {
  try {
    const state = JSON.parse(fs.readFileSync(backoffPath(paths), "utf8"));
    return Number.isFinite(state?.until_ms) && Number.isInteger(state?.n)
      ? state
      : null;
  } catch {
    return null; // absent or torn: not backed off
  }
}

export function drainBackedOff(paths, now = Date.now()) {
  const state = readBackoff(paths);
  return state !== null && now < state.until_ms;
}

/** Records one more failure; returns n (consecutive failures) for the log decision. */
export function recordDrainFailure(paths, now = Date.now()) {
  const n = (readBackoff(paths)?.n ?? 0) + 1;
  const delay = Math.min(BASE_MS * 2 ** (n - 1), MAX_MS);
  const file = backoffPath(paths);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ until_ms: now + delay, n }), {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
  return n;
}

export const clearDrainBackoff = (paths) =>
  fs.rmSync(backoffPath(paths), { force: true });

/** The first failure, then every 10th: a down daemon must not write a line per tool call. */
export const shouldLogFailure = (n) => n === 1 || n % LOG_EVERY === 0;

/** Drain jobs only: a failure extends drain.backoff (returns n), a pass that ran clears it. */
export function trackDrainJob({ verb, paths, failed, ran }) {
  if (verb !== DRAIN_VERB) return null;
  if (failed) return recordDrainFailure(paths);
  if (ran) clearDrainBackoff(paths);
  return null;
}
