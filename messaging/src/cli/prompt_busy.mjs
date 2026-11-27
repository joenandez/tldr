// Local prompt generation for the detached UserPromptSubmit busy mark.
// The foreground records generation + prompt time BEFORE handing off; the
// worker sends the newest prompt time (contract C4) and records the
// generation it got an answer for. A stale-ignored ack still counts.
import fs from "node:fs";
import path from "node:path";
import { appendLog } from "./detach_log.mjs";
import { isGatedSession } from "./hook_ack_arm.mjs";
import { localStopAckHold } from "./hook_ack_gate.mjs";
import { runDetached } from "./hook_detach.mjs";

// Per launch (`paths.lane`, ac-os0zc): one launch's prompt or ack never stands for another's.
const laned = (paths, name) =>
  path.join(paths.dir, `${name}${paths.lane ? `.${paths.lane}` : ""}.json`);
const promptFile = (paths) => laned(paths, "prompt-generation");
const ackFile = (paths) => laned(paths, "prompt-busy-ack");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function readPrompt(paths) {
  return readJson(promptFile(paths));
}

export function recordPrompt(paths, now = Date.now()) {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const prompt = {
    generation: (readPrompt(paths)?.generation ?? 0) + 1,
    prompt_at_ms: now,
  };
  writeJson(promptFile(paths), prompt);
  return prompt;
}

export function ackPrompt(paths, generation) {
  if (generation > (readJson(ackFile(paths))?.generation ?? 0))
    writeJson(ackFile(paths), { generation });
}

export const promptBusyNeeded = (paths) =>
  (readPrompt(paths)?.generation ?? 0) >
  (readJson(ackFile(paths))?.generation ?? 0);

// The detached child has no session env, so the identity resolved here rides in the payload.
export const DETACHED_IDENTITY = "tightbeam_detached_identity";
// ac-os0zc: the launch token alone, for a worker started before the identity resolves (the ACK-only gate).
export const DETACHED_LAUNCH_TOKEN = "tightbeam_detached_launch_token";

// Generation first, then the handoff: nothing here touches the daemon.
export function detachPromptBusy({
  ctx,
  stateRoot,
  runtime,
  payload,
  log,
  detach = {},
  ownerProcess = null,
}) {
  const prompt = recordPrompt(ctx.paths);
  const handoff = {
    ...payload,
    session_id: ctx.identity.session_id,
    // The child must not capture its own (detached) process tree: null, or the
    // foreground's capture when this launch adopts a takeover (ac-x09n0).
    [DETACHED_IDENTITY]: { ...ctx.identity, owner_process: ownerProcess },
  };
  const result = runDetached("user-prompt-submit", handoff, {
    stateRoot,
    paths: ctx.paths,
    args: ["--runtime", runtime],
    ...detach,
  });
  log({
    event: "user_prompt_busy_detached",
    session_id: ctx.identity.session_id,
    generation: prompt.generation,
    coalesced: result.coalesced,
  });
  return result;
}

// No credentials yet: the first SessionStart worker is still bootstrapping, so
// no hook here could resolve an identity. A prompt (already recorded) is
// marked busy by that worker after it registers (session_start_register.mjs);
// any other hook exits 0 with no output, unless an armed ack gate holds Stop
// (PreToolUse's armed verdict runs before this). The warn line, once per
// session and hook, is where the missing authority shows.
export function deferWithoutIdentity({
  ctx,
  verb,
  prompt,
  isCopilot,
  log,
  recordHandoff,
}) {
  fs.mkdirSync(ctx.paths.dir, { recursive: true, mode: 0o700 }); // a fresh root may not have the session dir yet
  const fields = {
    level: "warn",
    status: "warn",
    event: prompt ? "busy_deferred_no_identity" : "hook_skipped_no_identity",
    params: {
      session_id: ctx.identity.session_id,
      verb,
      ...(prompt ? { generation: prompt.generation } : {}),
    },
    result: {
      error: "no_authority",
      ...(prompt ? { busy: "session_start_worker" } : {}),
    },
  };
  if (prompt || firstSkip(ctx.paths, verb)) {
    appendLog(ctx.paths, fields);
    log(fields);
  }
  if (!prompt) return skipOrHold({ ctx, verb, log, recordHandoff });
  return { deferred: true, ...(isCopilot ? { copilotOutput: {} } : {}) };
}

// Tool hooks run at every boundary: one warn line per session and hook, not per call.
function firstSkip(paths, verb) {
  try {
    fs.writeFileSync(path.join(paths.dir, `no-identity-warned.${verb}`), "", {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    return error.code !== "EEXIST"; // a marker that cannot be written logs again rather than never
  }
}

// An armed gate still holds Stop; its handoff record lets the wake listener end at once either way.
function skipOrHold({ ctx, verb, log, recordHandoff }) {
  const held =
    verb === "stop" && isGatedSession(ctx)
      ? localStopAckHold(ctx, { log })
      : null;
  if (verb === "stop" && ctx.handoff === true)
    recordHandoff({ decision: held ? "block" : "allow" });
  return held ?? { skipped: true, reason: "no_identity" };
}
