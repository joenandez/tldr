// A held release whose completion persist was abandoned (or whose process died before it) leaves the hold it
// was released from on disk. The ledger shows the release ended: the slot's latest attempt is not held.run_id.
// Before expiry or release act on that stale hold, put the release's real outcome on it (fgp.52):
// success or skip -> cleared (the run's own record is the slot's one terminal record); a failure re-held by its
// completion -> that exact hold (attempts+1, its until or backoff, from the run's `held` history event); any other
// failure -> cleared (not holdable, or past the deadline: the completion would have cleared it too).
// A lost release is not reconciled: rule 5's lost copy covers it. Rules: plan-addendum "Held release state model".
import { logOnce, patchHolds } from "./held_release_core.mjs";
import { liveRunsOf, ownRunInFlight, slotTerminal } from "./held_live_runs.mjs";
import { loadJobHistory } from "./read_store.mjs";
import { loadActiveRunsReadOnly } from "./store.mjs";

const ENDED = new Set(["succeeded", "skipped", "failed", "timed_out"]);
const CLEARS = new Set(["succeeded", "skipped"]);

function staleRelease(scope, job) {
  const held = job.state.held;
  if (!held.run_id) return null;
  const t = slotTerminal(scope, job, held.slot);
  const ended =
    t?.last_run_id &&
    t.last_run_id !== held.run_id &&
    ENDED.has(t.status) &&
    t.terminal_source !== "lost";
  return ended ? t : null;
}

// The release's own history record must exist: it is the slot's one terminal record once the hold is cleared.
// undefined: no such record, or its re-hold is not in history (an event from before .52); rule 5 decides.
// DEFER: history cannot be read now; the hold sits the tick out (never acted on stale).
const DEFER = Symbol("defer");
function readHistory(scope, job) {
  try {
    return loadJobHistory(scope, job.id, 50);
  } catch {
    return null;
  }
}

function realHold(scope, job, terminal) {
  const events = readHistory(scope, job);
  if (!events) return DEFER;
  const own = events.filter((e) => e.run_id === terminal.last_run_id);
  const recorded = own.some((e) => ["completed", "skipped"].includes(e.kind));
  const reheld = CLEARS.has(terminal.status)
    ? null
    : (own.findLast((e) => e.kind === "held") ?? null);
  // A re-hold must carry its exact hold for this slot; anything else is left to rule 5.
  const exact = !reheld || reheld.payload?.held?.slot === job.state.held.slot;
  return recorded && exact ? (reheld?.payload.held ?? null) : undefined;
}

function staleOf(entry) {
  const candidates = entry.holds
    .map((job) => ({ job, terminal: staleRelease(entry.scope, job) }))
    .filter((c) => c.terminal);
  if (!candidates.length) return [];
  const live = liveRunsOf(
    entry.scope,
    loadActiveRunsReadOnly(entry.scope).runs,
  );
  return candidates
    .filter((c) => !ownRunInFlight(live, c.job))
    .map((c) => ({ ...c, next: realHold(entry.scope, c.job, c.terminal) }))
    .filter((c) => c.next !== undefined);
}

// One lease: rewrite every stale hold whose outcome is known, only if the fresh hold is still the stale one.
async function applyOutcomes(scope, stale) {
  const changes = stale
    .filter(({ next }) => next !== DEFER)
    .map(({ job, next }) => ({
      jobId: job.id,
      slot: job.state.held.slot,
      apply: (fresh) => {
        const same = fresh.state.held.run_id === job.state.held.run_id;
        if (same) fresh.state.held = next;
        return same;
      },
    }));
  const applied = changes.length
    ? await patchHolds(scope, "held_reconcile", changes)
    : [];
  return new Set(applied.filter((a) => a.value).map((a) => a.jobId));
}

function report({ log, entry, done }, { job, next, terminal }) {
  if (!done) {
    const reason = next === DEFER ? "history_unreadable" : "catalog_unwritable";
    logOnce(log, {
      ...entry,
      job,
      event: "held.reconcile_deferred",
      status: "warn",
      reason,
    });
    return;
  }
  log("held.reconciled", "info", {
    job: job.id,
    run: terminal.last_run_id,
    outcome: next ? "held" : "cleared",
    attempts: next?.attempts ?? null,
  });
  job.state.held = next;
}

/** Mutates `loaded`: a reconciled hold is replaced (or dropped) for the rest of the tick; a stale hold whose
 * outcome cannot be read or written now (history unreadable, catalog busy or unwritable) sits this tick out, so it
 * is never expired or released stale. */
export async function reconcileStaleHolds(loaded, log) {
  let reconciled = 0;
  for (const entry of loaded) {
    const stale = staleOf(entry);
    if (!stale.length) continue;
    // eslint-disable-next-line no-await-in-loop -- one scope lease at a time
    const done = await applyOutcomes(entry.scope, stale);
    stale.forEach((s) => report({ log, entry, done: done.has(s.job.id) }, s));
    reconciled += done.size;
    const sitOut = new Set(
      stale.filter((s) => !done.has(s.job.id)).map((s) => s.job),
    );
    entry.holds = entry.holds.filter(
      (job) => job.state.held && !sitOut.has(job),
    );
  }
  return reconciled;
}
