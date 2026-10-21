import { listSkyhookTerminalHistoryEvents } from "./runtime_ledger.mjs";
import { helmHome } from "./store.mjs";

function isTerminalHistoryEvent(event) {
  return (
    event?.kind === "completed" ||
    event?.kind === "skipped" ||
    event?.kind === "cancelled"
  );
}

// A handoff closes the ledger attempt as succeeded because the launch
// succeeded. That is not the work's outcome, so the ledger never sets a
// handoff run's status: the history event keeps the status it recorded
// (`started` since the provider-run outcome contract), and a ledger-only row
// reads `started`. The session exit is recorded as its own history event.
function isHandoffLedgerEvent(event) {
  return event?.payload?.terminal_source === "skyhook-handoff";
}

function publicLedgerEvent(event) {
  if (!isHandoffLedgerEvent(event)) return event;
  return { ...event, status: "started", error: null };
}

// The session-exit record is the run's final outcome; the ledger's launch
// terminal must not overwrite it.
function isSessionExitEvent(event) {
  return event?.payload?.session_exit === true;
}

export function mergeLedgerTerminalHistory(scope, jobId, events, limit) {
  const ledgerEvents = listSkyhookTerminalHistoryEvents({
    home: helmHome(),
    scopeId: scope?.scope_id,
    jobId,
    limit,
  }).map(publicLedgerEvent);
  if (ledgerEvents.length === 0) return events;

  const ledgerByRun = new Map(
    ledgerEvents.map((event) => [event.run_id, event]),
  );
  const seen = new Set();
  const merged = events.map((event) => {
    if (
      !isTerminalHistoryEvent(event) ||
      isSessionExitEvent(event) ||
      !ledgerByRun.has(event.run_id)
    ) {
      return event;
    }
    const ledger = ledgerByRun.get(event.run_id);
    seen.add(event.run_id);
    const recorded = isHandoffLedgerEvent(ledger)
      ? { status: event.status, error: event.error ?? null }
      : {};
    return {
      ...event,
      ...ledger,
      ...recorded,
      source_scope_id:
        event.source_scope_id ??
        event.scope_id ??
        ledger.source_scope_id ??
        null,
      source_cwd: event.source_cwd ?? event.cwd ?? ledger.source_cwd ?? null,
      cwd: event.cwd || ledger.cwd || scope?.cwd || null,
      log_paths: event.log_paths || ledger.log_paths || null,
      payload: {
        ...(event.payload || {}),
        ...(ledger.payload || {}),
      },
    };
  });
  for (const event of ledgerEvents) {
    if (seen.has(event.run_id)) continue;
    merged.push({
      ...event,
      source_scope_id: event.source_scope_id ?? null,
      source_cwd: event.source_cwd ?? null,
      cwd: event.cwd || scope?.cwd || null,
    });
  }
  return merged
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")))
    .slice(-limit);
}
