// Steers the host acked but the app-server refused while a replacement turn was still starting
// (no turn id to retry against). They wait here for that start to settle, so an acked prompt is
// delivered or, if the app-server closes first, logged lost; never silently dropped.

// The steer was acked but did not land; never drop silently. A steer refused while its own
// turn still looks current is a turn that ended before its turn/completed arrived (G2), so
// start a turn now; a newer turn gets one more steer; a turn still starting parks it; a failing
// turn/start is logged lost.
export function recoverSteer(adapter, job, error) {
  const dead = adapter.closed || adapter.inputClosed;
  if (!dead && adapter.starting) {
    parkSteer(adapter, job, error);
    return;
  }
  const stale =
    !adapter.busy() || (!adapter.starting && adapter.turnId === job.turnId);
  if (!dead && stale) {
    const deadId = adapter.turnId;
    if (deadId !== null) adapter.deadTurnIds.add(deadId);
    adapter.turnId = null;
    adapter.startTurn(job.text, job.id, deadId);
  } else if (!dead && adapter.turnId && !job.retried)
    adapter.steer({ ...job, retried: true });
  else {
    adapter.unanswered.delete(job.id);
    adapter.lost(job.id, error);
  }
}

/** Holds `job` (counted undelivered) until the starting turn settles. */
function parkSteer(adapter, job, error) {
  adapter.parked.push({ job, error });
  adapter.unanswered.add(job.id);
}

/** The start settled: steer into its turn, or recover as if the steer had just been refused. */
export function flushParked(adapter) {
  for (const { job, error } of adapter.parked.splice(0)) {
    if (adapter.turnId && !adapter.starting && adapter.turnId !== job.turnId)
      adapter.steer({ ...job, turnId: undefined });
    else adapter.recover(job, error);
  }
}

/** The app-server closed with these still waiting: nothing can deliver them. */
export function loseParked(adapter) {
  for (const { job, error } of adapter.parked.splice(0)) {
    adapter.unanswered.delete(job.id);
    adapter.lost(job.id, error);
  }
}
