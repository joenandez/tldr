// Opportunity #7 (reliability review 2026-06-11): scheduled retention/GC.
// Retention used to exist only as a manual CLI (`helm-tasks prune`) and even
// then covered only event/log files. Nothing bounded the SQLite runtime
// ledger (a row per run, forever) or the in-memory event caches. This service
// is the daemon-owned sweep for retained scheduler state.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendActivityEvent } from "./activity_stream.mjs";
import { pruneOldData, serviceRoot } from "./store.mjs";
import { writeJsonAtomic } from "./durable_file_io.mjs";
import {
  initializeRuntimeStore,
  withRuntimeStoreTransaction,
} from "./runtime_store.mjs";

export const DEFAULT_RETAIN_DAYS = Number(process.env.HELM_RETAIN_DAYS || 30);
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "skipped",
  "interrupted",
  "timed_out",
  "quarantined",
];

const TERMINAL_EFFECT_STATUSES = [
  "accepted",
  "failed_definite",
  "suppressed_duplicate",
  "dry_run",
  "blocked",
];

export function retentionStatePath() {
  return join(serviceRoot(), "retention-state.json");
}

export function readRetentionState() {
  const path = retentionStatePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function shouldRunRetention({
  state = readRetentionState(),
  now = Date.now(),
  intervalMs = RETENTION_INTERVAL_MS,
} = {}) {
  const lastMs = state?.last_run_at ? Date.parse(state.last_run_at) : NaN;
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= intervalMs;
}

// Delete terminal ledger rows older than the window, then VACUUM. Active /
// pending rows are never touched regardless of age. run_attempts cascade
// with their logical run (FK ON DELETE CASCADE, foreign_keys=ON).
export function pruneRuntimeLedgerForRetention({
  home,
  retainDays = DEFAULT_RETAIN_DAYS,
  now = Date.now(),
} = {}) {
  const cutoffIso = new Date(now - retainDays * 86400_000).toISOString();
  const runStatuses = TERMINAL_RUN_STATUSES.map(() => "?").join(",");
  const effectStatuses = TERMINAL_EFFECT_STATUSES.map(() => "?").join(",");
  const deleted = withRuntimeStoreTransaction({ home }, (db) => {
    const runs = db
      .prepare(
        `DELETE FROM logical_runs
          WHERE status IN (${runStatuses})
            AND COALESCE(finished_at, updated_at) < ?`,
      )
      .run(...TERMINAL_RUN_STATUSES, cutoffIso);
    const effects = db
      .prepare(
        `DELETE FROM outbound_effects
          WHERE status IN (${effectStatuses})
            AND updated_at < ?`,
      )
      .run(...TERMINAL_EFFECT_STATUSES, cutoffIso);
    return {
      logical_runs_deleted: Number(runs.changes || 0),
      outbound_effects_deleted: Number(effects.changes || 0),
    };
  });
  // VACUUM must run outside any transaction.
  let vacuumed = false;
  try {
    const store = initializeRuntimeStore({ home });
    store.db.exec("VACUUM");
    vacuumed = true;
  } catch {
    vacuumed = false;
  }
  return { ...deleted, cutoff: cutoffIso, vacuumed };
}

export function runScheduledRetention({
  scopes: _scopes = [],
  retainDays = DEFAULT_RETAIN_DAYS,
  now = Date.now(),
  home = undefined,
} = {}) {
  const startedAt = Date.now();
  const prune = pruneOldData(retainDays, false);
  const ledger = pruneRuntimeLedgerForRetention({ home, retainDays, now });
  const state = {
    version: "1.0",
    last_run_at: new Date(now).toISOString(),
    retain_days: retainDays,
  };
  writeJsonAtomic(retentionStatePath(), state);
  const summary = {
    ok: true,
    retain_days: retainDays,
    prune,
    ledger,
    duration_ms: Date.now() - startedAt,
  };
  appendActivityEvent({
    type: "retention_sweep_completed",
    level: "info",
    data: {
      retain_days: retainDays,
      events_deleted: prune.events_deleted,
      log_files_deleted: prune.log_files_deleted,
      ledger_runs_deleted: ledger.logical_runs_deleted,
      ledger_effects_deleted: ledger.outbound_effects_deleted,
      vacuumed: ledger.vacuumed,
      duration_ms: summary.duration_ms,
    },
  });
  return summary;
}
