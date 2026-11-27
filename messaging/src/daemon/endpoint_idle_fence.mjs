// The idle fence, the mirror of contract C4's late busy guard: a detached Stop
// idle names when its Stop ran (stop_at_ms). When the endpoint's last applied
// busy carries a newer prompt time, that idle is late: the session is mid-turn
// again, so the idle is refused (no state write, no idle stamp, no host wake).
import { TightbeamError } from "../protocol/envelope.mjs";

// shortcut: in memory per database like the C4 last-idle stamp; a daemon restart lets a late idle apply as before.
const lastBusyByDb = new WeakMap();

/** stop_at_ms from an endpoint.state.set payload; absent means an unfenced idle. */
export function readStopAtMs(payload, state) {
  const stopAtMs = payload.stop_at_ms;
  if (
    stopAtMs !== undefined &&
    (state !== "idle" || !Number.isInteger(stopAtMs) || stopAtMs < 0)
  ) {
    throw new TightbeamError(
      "malformed_request",
      'stop_at_ms is only valid with state "idle" and must be a non-negative integer',
      { field: "stop_at_ms" },
    );
  }
  return stopAtMs;
}

export function recordEndpointBusy(
  db,
  { endpointId, processGeneration, promptAtMs },
) {
  if (promptAtMs === undefined) return;
  if (!lastBusyByDb.has(db)) lastBusyByDb.set(db, new Map());
  lastBusyByDb.get(db).set(endpointId, { processGeneration, promptAtMs });
}

/** {stale_idle_ignored:true} when this idle predates the last busy prompt of the same generation, else null. */
export function staleIdleResult(
  context,
  { endpointId, processGeneration, stopAtMs },
) {
  const busy =
    stopAtMs === undefined
      ? null
      : lastBusyByDb.get(context.db)?.get(endpointId);
  if (
    busy?.processGeneration !== processGeneration ||
    !(busy.promptAtMs > stopAtMs)
  )
    return null;
  context.logger?.info({
    event: "endpoint_idle_ignored_stale",
    params: {
      endpoint_id: endpointId,
      process_generation: processGeneration,
      stop_at_ms: stopAtMs,
      last_prompt_at_ms: busy.promptAtMs,
    },
    result: "ignored",
    status: "ok",
  });
  return { stale_idle_ignored: true };
}
