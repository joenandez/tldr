// Halcyon Phase 0 — parse-attribution telemetry + child-sample classification.
// Extracted from resource_sampler.mjs to satisfy the file-size gate.
// resource_sampler.mjs remains the home for appendPerfEvent and the process-tree
// / vmmap sampling infrastructure; this module owns the higher-level record
// builders that sit above it.

import { existsSync, statSync } from "node:fs";
import { appendPerfEvent } from "./resource_sampler.mjs";

// ---------------------------------------------------------------------------
// Child-sample firehose cut (Halcyon Phase 0, task 0.1)
// ---------------------------------------------------------------------------

// Allowed child-sample lifecycles after the Phase 0 firehose cut.
// single_flight_released is removed (~82k rows/day eliminated).
const ALLOWED_CHILD_SAMPLE_LIFECYCLES = new Set(["launch", "error", "close"]);

/**
 * Classify whether a dispatch child is a scheduler evaluator or an agent run.
 * A dispatch child has "dispatch" as its first non-script argument (matching the
 * spawnDispatchChild call in daemon.mjs: argv = [schedulerScriptPath, "dispatch", ...]).
 */
export function classifyChildKind(argv) {
  if (!Array.isArray(argv) || argv.length < 2) return "agent_run";
  // argv[0] is the script path, argv[1] is the subcommand
  return argv[1] === "dispatch" ? "dispatch_evaluator" : "agent_run";
}

/**
 * Build a canonical daemon_dispatch_child_sample record.
 * Returns null for any lifecycle that was removed by the Phase 0 firehose cut
 * (specifically single_flight_released). Callers should skip emitting null records.
 */
export function buildChildSampleRecord({
  lifecycle,
  scope_id,
  cwd,
  pid,
  child_kind,
  daemon_instance_id,
  duration_ms,
  error,
  code,
  signal,
  single_flight_enabled,
  single_flight_release_status,
} = {}) {
  if (!ALLOWED_CHILD_SAMPLE_LIFECYCLES.has(lifecycle)) return null;

  const record = {
    event: "daemon_dispatch_child_sample",
    type: "daemon_dispatch_child_sample",
    classification: "helm_control_plane",
    daemon_instance_id: daemon_instance_id ?? null,
    scope_id: scope_id ?? null,
    cwd: cwd ?? null,
    pid: pid ?? null,
    lifecycle,
    child_kind: child_kind ?? "agent_run",
  };

  if (duration_ms !== undefined) record.duration_ms = duration_ms;
  if (error !== undefined) record.error = error;
  if (lifecycle === "close") {
    record.code = code ?? null;
    record.signal = signal ?? null;
    record.ok = code === 0;
    if (single_flight_release_status !== undefined) {
      record.single_flight_release_status = single_flight_release_status;
    }
  }
  if (single_flight_enabled !== undefined) {
    record.single_flight_enabled = single_flight_enabled;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Parse-attribution telemetry (Halcyon Phase 0, task 0.2)
// Emits a canonical_parse_sample row for every whole-file JSON parse >= 5 MB
// on hot read paths, to prove which files feed the native memory plateau.
// ---------------------------------------------------------------------------

/** Minimum file size (in bytes) that triggers a canonical_parse_sample row. */
export const PARSE_SAMPLE_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Emit a canonical_parse_sample row if sizeBytes exceeds the threshold.
 * The sink defaults to appendPerfEvent so production code needs no extra wiring;
 * tests inject a fake sink to avoid filesystem I/O.
 *
 * @param {object} opts
 * @param {string} opts.path - absolute path of the file that was parsed
 * @param {number} opts.sizeBytes - byte size of the content that was parsed
 * @param {number} opts.durationMs - parse duration in milliseconds
 * @param {string} opts.callerClass - classification of the call site (e.g. "canonical_threads")
 * @param {function} [opts.sink] - optional sink function (defaults to appendPerfEvent)
 */
export function emitParseSampleIfLarge({
  path,
  sizeBytes,
  durationMs,
  callerClass,
  sink = appendPerfEvent,
} = {}) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= PARSE_SAMPLE_THRESHOLD_BYTES)
    return;
  const record = {
    event: "canonical_parse_sample",
    type: "canonical_parse_sample",
    classification: "helm_control_plane",
    timestamp: new Date().toISOString(),
    path: path ?? null,
    size_bytes: sizeBytes,
    duration_ms: durationMs ?? null,
    caller_class: callerClass ?? null,
  };
  sink(record);
}

/**
 * Read and parse a JSON file while emitting a canonical_parse_sample row if
 * the file exceeds the attribution threshold. readFn(path) should return the
 * parsed value (null-safe).
 *
 * @param {string} path - absolute path to the JSON file
 * @param {string} callerClass - caller_class label for the parse-sample row
 * @param {function|undefined} parseSampleSink - optional test sink (defaults to appendPerfEvent)
 * @param {function} readFn - reader: (path) => parsed | null
 */
export function timedJsonRead(path, callerClass, parseSampleSink, readFn) {
  const t0 = Date.now();
  const sizeBytes = existsSync(path) ? statSync(path).size : 0;
  const parsed = readFn(path);
  emitParseSampleIfLarge({
    path,
    sizeBytes,
    durationMs: Date.now() - t0,
    callerClass,
    sink: parseSampleSink,
  });
  return parsed;
}

// ---------------------------------------------------------------------------
// Sample-slope analytics (moved from resource_sampler.mjs — file-size gate)
// ---------------------------------------------------------------------------

function readPath(object, path) {
  if (typeof path === "function") return path(object);
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce(
      (value, key) =>
        value === null || value === undefined ? undefined : value[key],
      object,
    );
}

export function sampleSlope(
  samples,
  { valuePath = "value", timePath = "ts" } = {},
) {
  const points = (Array.isArray(samples) ? samples : [])
    .map((sample) => {
      const value = Number(readPath(sample, valuePath));
      const rawTime = readPath(sample, timePath);
      const time =
        rawTime instanceof Date
          ? rawTime.getTime()
          : typeof rawTime === "number"
            ? rawTime
            : Date.parse(rawTime || "");
      return { value, time };
    })
    .filter(
      (point) => Number.isFinite(point.value) && Number.isFinite(point.time),
    )
    .sort((a, b) => a.time - b.time);
  if (points.length < 2) {
    return {
      ok: false,
      points: points.length,
      delta: null,
      duration_ms: null,
      per_minute: null,
    };
  }
  const first = points[0];
  const last = points[points.length - 1];
  const durationMs = last.time - first.time;
  if (durationMs <= 0) {
    return {
      ok: false,
      points: points.length,
      delta: null,
      duration_ms: durationMs,
      per_minute: null,
    };
  }
  const delta = last.value - first.value;
  return {
    ok: true,
    points: points.length,
    delta,
    duration_ms: durationMs,
    per_minute: Math.round((delta / (durationMs / 60000)) * 1000) / 1000,
  };
}
