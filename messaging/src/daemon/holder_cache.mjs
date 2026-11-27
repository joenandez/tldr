// The holder cache (ac-srg29): a synchronous read of an async lsof probe of
// one Codex thread-writer lock, so deciders inside a transaction never wait on
// a child process. codex_thread_host.mjs turns its answers into host answers.

import { observeFileHolders as probeFileHolders } from "./process_table.mjs";

// A probe answer is reused this long (a read inside it kicks no probe unless
// the answer is a negative nobody confirmed yet); the next ask after it kicks
// one async probe and, until it lands, hears `{ pending: true }`.
const HOLDER_CACHE_MS = 2_000;
// Takeover's final check acts only on a confirmation whose later probe finished
// within one 1 s reconciler tick (plus slack), and spends it: one confirmation,
// one takeover read. Residual window: the probe's own run time plus this, plus,
// in a woken run, the run's own work before the read.
const CONFIRM_FRESH_MS = 1_250;
// Landings are coalesced into one woken reader run, at most one per second per
// context. A woken run kicks no probe, so every probe and every wake traces back
// to a read outside a wake (a tick): no chain sustains itself.
const WAKE_MIN_GAP_MS = 1_000;
// A path nobody has read for this long is dropped (swept on read, no timer).
const ENTRY_IDLE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;

const isUnheld = (probe) => probe?.answer?.pids?.length === 0; // pids is always an array or absent
// The later probe started after an earlier negative finished: two distinct runs.
const followsNegative = (last, prev) =>
  isUnheld(prev) && last.startedAtMs >= prev.finishedAtMs;

/**
 * A synchronous `observeFileHolders(lockPath)` over an async probe: the cached
 * answer when observed within 2 s, else `{ pending: true }` and a refresh,
 * at most one probe in flight per path. A probe that throws is `{ unavailable: true }`.
 *
 * The cache keeps the last two probes per path. A negative answer (`pids: []`)
 * carries `confirmed: true` only when the two latest probes were both negative,
 * the later started after the earlier finished, and the later finished within
 * 1.25 s, and no `confirm` read has spent them: one probe can miss a holder that
 * took the lock a moment later, two in a row from distinct runs are the
 * evidence a takeover rests on, once. A `confirm` read whose latest answer is
 * negative and not yet confirmed kicks one more probe even while it is fresh.
 * Landings are coalesced into one `wakeReaders()` run (at most one per second);
 * in that run the burst's answers that landed at most 1.25 s before it started
 * are fresh, so the readers act on them whatever their own work costs and
 * whatever the tick spacing. A read inside a woken run never kicks a probe.
 */
export function cachedHolderObserver({
  probe = probeFileHolders,
  now = Date.now,
  wakeReaders = () => {},
} = {}) {
  const entries = new Map(); // lockPath -> { last, prev, probing, readAtMs }
  let nextSweepMs = 0;
  // Probes landed since the last woken run, and those the woken run in progress reads as fresh.
  let burst = null;
  let woken = new Set();
  let lastWakeMs = -Infinity;
  let waking = false;
  const runWake = () => {
    const startMs = now();
    // Only landings at most 1.25 s before the wake started are fresh in it: a wake held up by a blocked loop vouches for nothing.
    woken = new Set(
      [...burst].filter(
        (landed) => startMs - landed.finishedAtMs <= CONFIRM_FRESH_MS,
      ),
    );
    [burst, lastWakeMs, waking] = [null, startMs, true];
    try {
      wakeReaders();
    } finally {
      [woken, waking] = [new Set(), false];
    }
  };
  const land = (entry, landed) => {
    Object.assign(entry, { prev: entry.last, last: landed, probing: false });
    if (burst === null) {
      burst = new Set();
      const delayMs = lastWakeMs + WAKE_MIN_GAP_MS - now();
      if (delayMs > 0) setTimeout(runWake, delayMs).unref?.();
      else setImmediate(runWake);
    }
    burst.add(landed);
  };
  const kick = (entry, lockPath) => {
    if (entry.probing) return;
    entry.probing = true;
    const startedAtMs = now();
    Promise.resolve()
      .then(() => probe(lockPath))
      .catch(() => ({ unavailable: true }))
      .then((answer) =>
        land(entry, { answer, startedAtMs, finishedAtMs: now() }),
      );
  };
  const observe = (lockPath, { confirm = false } = {}) => {
    const nowMs = now();
    if (nowMs >= nextSweepMs) {
      nextSweepMs = nowMs + SWEEP_EVERY_MS;
      sweepIdle(entries, nowMs);
    }
    const entry = entries.get(lockPath) ?? {
      last: null,
      prev: null,
      probing: false,
      readAtMs: nowMs,
    };
    entry.readAtMs = nowMs;
    entries.set(lockPath, entry);
    const { answer, needsProbe } = readEntry(entry, {
      nowMs,
      confirm,
      woken: woken.has(entry.last),
    });
    if (needsProbe && !waking) kick(entry, lockPath);
    return answer;
  };
  observe.size = () => entries.size;
  return observe;
}

// One read of a path: the answer it sees, and whether it must kick a probe.
// `woken`: the latest probe landed in the burst that woke this run, at most 1.25 s
// before it started, so it is fresh whatever this run's own work cost.
function readEntry(entry, { nowMs, confirm, woken }) {
  const { last, prev } = entry;
  const ageMs = nowMs - (last?.finishedAtMs ?? -Infinity);
  const refresh = ageMs > HOLDER_CACHE_MS && !woken;
  const unheld = !refresh && isUnheld(last);
  const confirmed =
    unheld &&
    followsNegative(last, prev) &&
    !last.spent &&
    (woken || ageMs <= CONFIRM_FRESH_MS);
  if (confirm && confirmed) last.spent = true;
  // Only the final check needs a second probe; a plain read never kicks for confirmation.
  return {
    answer: refresh ? { pending: true } : answerOf(last, unheld, confirmed),
    needsProbe: refresh || (confirm && unheld && !confirmed),
  };
}

// Entries nobody is probing and nobody has read lately (a session whose lock is long gone).
function sweepIdle(entries, nowMs) {
  for (const [key, entry] of entries)
    if (!entry.probing && nowMs - entry.readAtMs > ENTRY_IDLE_MS)
      entries.delete(key);
}

// The cached answer; a negative one says whether two distinct probes agree.
const answerOf = (last, unheld, confirmed) =>
  unheld ? { ...last.answer, confirmed } : last.answer;
