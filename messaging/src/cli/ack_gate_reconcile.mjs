// hnbc 1.9.1: the armed PreToolUse branch decides from local files only
// (hook_ack_gate.mjs); this module hands the boundary's daemon work (the
// drain) to the detached worker and tracks the drain's deferral. The daemon
// op ack.gate.check is gone (ac-jfv.156), so nothing here reconciles armed ids
// with the daemon: the local gate's caps and expiry bound an armed id.

import fs from "node:fs";
import path from "node:path";

import { drainBackedOff } from "./drain_backoff.mjs";
import { runDetached } from "./hook_detach.mjs";
import { CLAIM_MAX_AGE_MS } from "./notice_ledger.mjs";
import { DETACHED_IDENTITY, DETACHED_LAUNCH_TOKEN } from "./prompt_busy.mjs";

const VERB = "pre-tool-use";

/**
 * Hands this boundary's daemon work (the drain) to the
 * detached `hook pre-tool-use --background` worker. A launch failure is
 * logged and never changes the foreground's verdict or refusal. No `detach`
 * (an in-process caller; the CLI passes {}) launches nothing, as SessionStart
 * treats it; the hook never drains inline.
 */
export function detachPreToolUse({
  ctx,
  stateRoot,
  runtime,
  payload,
  detach,
  reason,
  log,
}) {
  // The backoff read is one stat-sized read, no IPC. It skips even if the watermark changed
  // meanwhile: the local notice still shows; only the drain waits for until_ms.
  const cause = !detach
    ? "no_detach_seam"
    : drainBackedOff(ctx.paths) && "drain_backoff";
  if (cause) {
    log({
      event: "pre_tool_use_detach_skipped",
      session_id: ctx.identity.session_id,
      params: { reason },
      result: { cause },
    });
    return null;
  }
  const identity = ctx.identity.authority_name
    ? { [DETACHED_IDENTITY]: { ...ctx.identity, owner_process: null } }
    : { [DETACHED_LAUNCH_TOKEN]: ctx.identity.launch_token ?? null };
  try {
    const result = runDetached(
      VERB,
      { ...payload, session_id: ctx.identity.session_id, ...identity },
      {
        stateRoot,
        paths: ctx.paths,
        args: runtime ? ["--runtime", runtime] : [],
        ...detach,
      },
    );
    log({
      event: "pre_tool_use_detached",
      session_id: ctx.identity.session_id,
      params: { reason },
      result: { coalesced: result.coalesced },
    });
    return result;
  } catch (error) {
    log({
      event: "pre_tool_use_detach_failed",
      session_id: ctx.identity.session_id,
      params: { reason },
      status: "error",
      error: error.code || error.message,
      stack: error.stack,
    });
    return null;
  }
}

const readOrNull = (file) => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};
const deferralPath = (paths) => path.join(paths.dir, "drain.deferred");

/** The watermark changed since the last consumed one: the foreground's "a drain is wanted" (Copilot). */
export function watermarkUnseen(paths) {
  const watermark = readOrNull(paths.watermark);
  return (
    watermark !== null &&
    !watermark.equals(readOrNull(paths.seen) ?? Buffer.alloc(0))
  );
}

/** The detached drain left `watermark` to another live claimer (a held or busy claim). */
export function recordDrainDeferred(paths, watermark) {
  fs.writeFileSync(deferralPath(paths), watermark, { mode: 0o600 });
}

/**
 * Whether the detached worker runs the drain again (DETACHED_PASS_NEEDED). A watermark it
 * deferred is not re-run until it changes or the holder's claim could have aged out, so a
 * held claim never spins the worker; a later hook still launches a fresh pass.
 */
export function drainPassNeeded(paths) {
  if (!watermarkUnseen(paths)) return false;
  const deferred = deferralPath(paths);
  try {
    const recent =
      Date.now() - fs.statSync(deferred).mtimeMs < CLAIM_MAX_AGE_MS;
    return !(
      recent && readOrNull(paths.watermark).equals(readOrNull(deferred))
    );
  } catch {
    return true; // no deferral recorded, or a file vanished mid-read
  }
}
