import fs from "node:fs";
import {
  clearDrainBackoff,
  drainBackedOff,
  recordDrainFailure,
  shouldLogFailure,
} from "./drain_backoff.mjs";
import { runDetached } from "./hook_detach.mjs";
import { appendLog } from "./detach_log.mjs";
import { DETACHED_IDENTITY, readPrompt } from "./prompt_busy.mjs";

// Stop's local exit (plan W1 step 5 / A6): a proven-direct session with no
// messaging evidence skips session.stop; anything unreadable or unproven goes
// to the daemon. A `--handoff` Stop (Claude) exits locally too, and its async
// wake-listen registers the park off the user's path (hnbc G1, owner design).

// The local handoff decision: wake-listen itself runs this Stop's session.stop.
export const LOCAL_STOP_PARK = "register_park";

function readOptional(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Why this Stop must consult session.stop, or null when it may exit locally
 * (plan W1 step 5 / A6). Anything unreadable or unproven answers non-null.
 */
function stopNeedsDaemon(ctx, readCache) {
  const cached = readCache(ctx.paths);
  const watermark = readOptional(ctx.paths.watermark);
  const reasons = [
    [
      "daemon_launch",
      () =>
        Boolean(
          ctx.identity.launch_token || ctx.identity.placeholder_endpoint_id,
        ),
    ],
    // Direct = this process and its registration both resolved interactive with no daemon launch or recovery: only then does session.stop reduce to unarmed_allow, which the marker and delivery files mirror.
    [
      "not_proven_direct",
      () =>
        ctx.identity.launch_mode !== "interactive" ||
        cached?.launch_mode !== "interactive" ||
        typeof cached.recovery_resume_request_id === "string",
    ],
    ["messaging_used", () => readOptional(ctx.paths.messagingUsed) !== null],
    [
      "unseen_watermark",
      () =>
        watermark !== null &&
        !watermark.equals(readOptional(ctx.paths.seen) ?? Buffer.alloc(0)),
    ],
    [
      "local_notice",
      () =>
        Boolean(
          readOptional(ctx.paths.notices)?.length ||
            readOptional(ctx.paths.pending)?.length,
        ),
    ],
  ];
  return reasons.find(([, applies]) => applies())?.[0] ?? null;
}

function localStopVerdict(ctx, { readCache, log }) {
  try {
    return stopNeedsDaemon(ctx, readCache);
  } catch (error) {
    log({
      event: "stop_local_check_failed",
      session_id: ctx.identity.session_id,
      status: "error",
      error: error.code || error.message,
      stack: error.stack,
    });
    return "unreadable";
  }
}

/** True when this Stop may exit locally without contacting the daemon. */
export function stopExitsLocally(ctx, deps) {
  const startedAt = Date.now();
  const needsDaemon = localStopVerdict(ctx, deps);
  deps.log({
    event: "stop_local_check",
    session_id: ctx.identity.session_id,
    result: needsDaemon ?? "local_exit",
    status: "ok",
    latency_ms: Date.now() - startedAt,
  });
  return needsDaemon === null;
}

// The local exit skips session.stop, which is what idles the endpoint. Hand an
// idle mark to the detached seam so mail that arrives while the session sits
// at the prompt is not routed enqueue_only to a hook that never fires.
export const DETACHED_STOP_IDLE = "tightbeam_detached_stop_idle";

/** Local-exit result for this Stop, or null when it must consult session.stop. */
export function localStopExit(ctx, deps) {
  if (!stopExitsLocally(ctx, deps)) return null;
  const { stateRoot, runtime, payload, log } = deps;
  const stopAtMs = Date.now();
  const handoff = {
    ...payload,
    session_id: ctx.identity.session_id,
    [DETACHED_STOP_IDLE]: { stop_at_ms: stopAtMs },
    // null owner_process: the child must not capture its own (detached) process tree.
    [DETACHED_IDENTITY]: { ...ctx.identity, owner_process: null },
  };
  try {
    const { coalesced } = runDetached("stop", handoff, {
      stateRoot,
      paths: ctx.paths,
      args: ["--runtime", runtime],
    });
    log({
      event: "stop_idle_mark_detached",
      session_id: ctx.identity.session_id,
      coalesced,
      status: "ok",
    });
  } catch (error) {
    log({
      event: "stop_idle_mark_detach_failed",
      session_id: ctx.identity.session_id,
      status: "error",
      error: error.message,
      stack: error.stack,
    });
  }
  if (ctx.handoff === true)
    deps.recordHandoff({
      decision: LOCAL_STOP_PARK,
      wait_mode: ctx.waitMode ?? null,
      stop_at_ms: stopAtMs,
    });
  return { skipped: true, local_exit: true };
}

const promptSince = (paths, stopAtMs) =>
  (readPrompt(paths)?.prompt_at_ms ?? 0) > stopAtMs;

// wake-listen's stdio is discarded by the host, so its failures also go to hook-detach.log (1.15).
function logAlways(ctx, log, entry) {
  log(entry);
  try {
    appendLog(ctx.paths, entry);
  } catch (error) {
    log({
      event: "hook_detach_log_failed",
      error: error.code || error.message,
      status: "error",
    });
  }
}

/** wake-listen before any socket: a local-exit record under 1.15 backoff ends here (no retry). */
export function localParkBackedOff(ctx, record, log) {
  if (record.decision !== LOCAL_STOP_PARK || !drainBackedOff(ctx.paths))
    return null;
  // debug only: the sampled unreachable line already records the outage; one line per Stop is what 1.15 removes.
  log({
    event: "wake_listen_backed_off",
    session_id: ctx.identity.session_id,
    status: "warn",
  });
  return { woke: false, backed_off: true };
}

/** wake-listen could not reach the daemon for a local-exit record: silent exit, 1.15 backoff, sampled log. */
export function localParkUnreachable(ctx, error, log) {
  const n = recordDrainFailure(ctx.paths);
  if (shouldLogFailure(n))
    logAlways(ctx, log, {
      event: "wake_listen_daemon_unreachable",
      session_id: ctx.identity.session_id,
      failures: n,
      status: "warn",
      error: error.code || error.message,
      stack: error.stack,
    });
  return { woke: false, daemon_unreachable: true };
}

/**
 * wake-listen for a local-exit Stop: run that Stop's session.stop here, off
 * the user's path. It is both the park registration and the one unread
 * check: an unread delivery that landed after the idle mark parks as an
 * immediate presentation (armed) or answers block (exit 2), so either wakes
 * the session now. A prompt after the Stop skips it, as the idle mark does (C4).
 * deps: gateStop, consume (consumeStopHandoff), listen (listenForWake), markBusy, log.
 */
export async function registerLocalStopPark(client, ctx, deps) {
  const startedAt = Date.now();
  clearDrainBackoff(ctx.paths); // the daemon answered the handshake
  if (promptSince(ctx.paths, ctx.handoffRecord.stop_at_ms)) {
    deps.log({
      event: "wake_listen_register_skipped",
      session_id: ctx.identity.session_id,
      reason: "newer_prompt",
    });
    return { woke: false, newer_prompt: true };
  }
  let outcome;
  try {
    outcome = await runLocalStopGate(client, ctx, deps);
  } catch (error) {
    deps.log({
      event: "wake_listen_register_failed",
      session_id: ctx.identity.session_id,
      status: "error",
      error: error.code || error.message,
      stack: error.stack,
      latency_ms: Date.now() - startedAt,
    });
    return { woke: false, error: error.code || error.message };
  }
  return settleRegistration(ctx, deps, { ...outcome, client, startedAt });
}

// This Stop's session.stop, as the gate would have made it.
async function runLocalStopGate(client, ctx, deps) {
  const record = ctx.handoffRecord;
  const gate = await deps.gateStop(client, {
    ...ctx,
    handoff: true,
    waitMode: record.wait_mode ?? undefined,
  });
  // gateStop recorded its decision under this same key: hold a park, drop the rest.
  const { record: parked } = await deps.consume(ctx.paths, ctx.stdinKey, {
    waitMs: 0,
  });
  // A prompt raced the registration: re-assert its busy, which the late idle overwrote or made stale.
  const raced = promptSince(ctx.paths, record.stop_at_ms);
  if (raced) await deps.markBusy(client, ctx);
  return { gate, parked, raced };
}

function settleRegistration(
  ctx,
  deps,
  { client, gate, parked, raced, startedAt },
) {
  const result = raced
    ? "newer_prompt"
    : gate.blocked
      ? "block"
      : parked?.decision === "park"
        ? "park"
        : gate.gate;
  deps.log({
    event: "wake_listen_registered",
    session_id: ctx.identity.session_id,
    result,
    status: raced ? "warn" : "ok",
    latency_ms: Date.now() - startedAt,
  });
  if (raced) return { woke: false, newer_prompt: true };
  if (result === "park")
    return deps.listen(client, {
      record: parked,
      ctx,
      hostProbe: ctx.hostProbe,
    });
  // A block already wrote its reason to stderr with exit 2: that is the wake. Never print its stdout JSON.
  return { woke: gate.blocked === true, gate: result };
}

/**
 * Background pass: false when a prompt landed after this Stop. The late idle
 * would otherwise also make the daemon drop that prompt's busy as stale (C4).
 */
export function stopIdleStillCurrent(ctx) {
  return !(
    (readPrompt(ctx.paths)?.prompt_at_ms ?? 0) >
    ctx.payload[DETACHED_STOP_IDLE].stop_at_ms
  );
}
