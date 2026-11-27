// The detach seam (contract C2): a hook verb's daemon work runs in a
// detached child so nothing in a conversation waits on the daemon.
//
// The foreground writes the payload to the session dir, claims the
// per-session+verb lock (an atomic mkdir) and spawns
// `hook <verb> --background <session_id>`, which adopts that claim. If the
// lock is already held, by a worker or by a child not yet started, it spawns
// nothing: the holder picks the newer payload up before it exits. Coalesced,
// never queued, single-flight: only the newest pending payload survives.
//
// No lost wakeup: the foreground writes its payload BEFORE it claims the
// lock, and a worker releases the lock BEFORE its last pending check. So
// either the worker sees the payload, or the foreground claims the lock and
// spawns a worker. A worker killed mid-job (or a child that never started)
// leaves a lock whose owner pid is dead; the next job reclaims it.
//
// ac-os0zc: every launch of a provider session shares the session dir, so a
// payload and its lock are kept per launch (`paths.lane`, takeover_launch.mjs launchPaths): one
// launch's newer payload never replaces another's, and each worker runs only
// its own launch's. Paths with no lane use the shared names, as before.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withoutSessionEnv } from "../protocol/session_env.mjs";
import {
  ownerLockRelease,
  readBootstrapLockOwner,
  tryOwnerLock,
} from "./bootstrap.mjs";
import { appendLog, errorFields } from "./detach_log.mjs";
import {
  DRAIN_VERB,
  recordDrainFailure,
  shouldLogFailure,
  trackDrainJob,
} from "./drain_backoff.mjs";

const CLI_PATH = fileURLToPath(new URL("../../bin/tightbeam", import.meta.url));

// detach-<verb>[.<lane>] (takeover_launch.mjs launchPaths); no lane is the shared, pre-lane name.
const stem = (paths, verb) =>
  `detach-${[verb, paths.lane].filter(Boolean).join(".")}`;
const pendingPath = (paths, verb) =>
  path.join(paths.dir, `${stem(paths, verb)}.pending.json`);
const lockPath = (paths, verb) =>
  path.join(paths.dir, `${stem(paths, verb)}.lock`);

/** The shared, pre-lane paths of this session (a payload a previous build left). */
export const legacyPaths = ({ lane: _lane, ...paths }) => paths;
/** A payload written under the shared name before lanes (an install mid-session). */
export const legacyPending = (paths, verb) =>
  fs.existsSync(pendingPath(legacyPaths(paths), verb));
// The token of the lock claim a foreground hands to the worker it spawns.
const CLAIM_ENV = "TIGHTBEAM_DETACH_CLAIM";

/**
 * Hands `payload` to a detached `hook <verb> --background` child and returns
 * without waiting. The caller exits 0 with empty stdout via process.exit.
 * `args` are extra CLI args for the child (e.g. `--runtime <id>`); the child
 * env is withoutSessionEnv, so anything the worker needs from the
 * foreground session must travel in `payload`.
 */
export function runDetached(
  verb,
  payload,
  { stateRoot, paths, args = [], cliPath = CLI_PATH, spawnImpl = spawn },
) {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const temp = path.join(
    paths.dir,
    `${stem(paths, verb)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  fs.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, pendingPath(paths, verb));

  const lock = lockPath(paths, verb);
  const claim = randomBytes(16).toString("hex");
  const release = tryOwnerLock(lock, claim);
  if (!release) return { detached: true, coalesced: true };
  // A spawn that throws leaves the claim to this process's pid; the next job reclaims it once this hook exits.
  const child = spawnImpl(
    process.execPath,
    [
      cliPath,
      "--state-root",
      stateRoot,
      "hook",
      verb,
      ...args,
      ...(paths.lane ? ["--detach-lane", paths.lane] : []),
      "--background",
      path.basename(paths.dir),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...withoutSessionEnv(process.env), [CLAIM_ENV]: claim },
    },
  );
  // The claim outlives this process: it names the child, which adopts it. No pid: no child will, so give it back.
  child.pid ? recordOwner(lock, child.pid, claim) : release();
  // The payload stays pending, so the next job's worker runs it.
  child.on("error", (error) => {
    const backoffN = verb === DRAIN_VERB ? recordDrainFailure(paths) : null;
    if (backoffN === null || shouldLogFailure(backoffN))
      appendLog(paths, {
        event: "hook_detach_spawn_failed",
        status: "error",
        verb,
        backoff_n: backoffN,
        error: errorFields(error, backoffN === null || backoffN === 1),
      });
  });
  child.unref();
  return { detached: true, coalesced: false };
}

/**
 * The child side: under the per-session+verb lock, run every pending payload
 * (newest wins) and repeat with the last payload while
 * `needsAnotherPass(paths)` reports newer local state. Logs one boundary
 * event per job; rethrows the last failure after releasing the lock.
 */
export async function runDetachedWorker({
  verb,
  paths,
  run,
  needsAnotherPass = () => false,
  claim = process.env[CLAIM_ENV],
}) {
  const job = {
    verb,
    paths,
    run,
    needsAnotherPass,
    payload: null,
    passes: 0,
    failure: null,
    lastError: null,
    failedPasses: 0,
  };
  const startedAt = Date.now();
  let logged = false;
  const logNow = () => {
    logged = true;
    logJob(job, jobOutcome(job), Date.now() - startedAt);
  };
  try {
    let release;
    while ((release = acquireJobLock(paths, verb, claim))) {
      try {
        // Record a throw before the log line below, which then carries it.
        // eslint-disable-next-line no-await-in-loop -- one lock hold at a time by design
        await drainPending(job).catch((error) => {
          job.failure = job.lastError = error;
          throw error;
        });
      } finally {
        logNow(); // before the release: once the lock is gone, the job's line is on disk
        release();
      }
      // After release: a request that landed during the last check is not lost.
      if (!hasMoreWork(job)) break;
    }
  } catch (error) {
    job.failure = job.lastError = error;
  }
  if (!logged) logNow();
  if (job.failure) throw job.failure;
  return { detached: true, outcome: jobOutcome(job), passes: job.passes };
}

// A down daemon fails every job: log the first failure (with its stack), then every 10th.
function logJob(job, outcome, latencyMs) {
  const { verb, paths } = job;
  const backoffN = trackDrainJob({
    verb,
    paths,
    failed: Boolean(job.failure),
    ran: job.passes > 0,
  });
  if (job.failure && backoffN !== null && !shouldLogFailure(backoffN)) return;
  appendLog(paths, {
    event: "hook_detach_job",
    status: jobStatus(job),
    verb,
    outcome,
    passes: job.passes,
    failed_passes: job.failedPasses,
    latency_ms: latencyMs,
    ...(backoffN === null ? {} : { backoff_n: backoffN }),
    ...(job.lastError
      ? {
          error: errorFields(
            job.lastError,
            backoffN === null || backoffN === 1,
          ),
        }
      : {}),
  });
}

const wantsAnotherPass = (job) =>
  job.payload !== null &&
  job.failure === null &&
  job.needsAnotherPass(job.paths);
const hasMoreWork = (job) =>
  fs.existsSync(pendingPath(job.paths, job.verb)) || wantsAnotherPass(job);
const jobOutcome = (job) =>
  job.failure ? "error" : job.passes > 0 ? "ok" : "coalesced";
const jobStatus = (job) =>
  job.failure ? "error" : job.lastError ? "warn" : "info";

async function drainPending(job) {
  for (;;) {
    const claimed = claimPending(job.paths, job.verb);
    if (claimed !== null) job.payload = claimed;
    else if (!wantsAnotherPass(job)) return;
    job.passes += 1;
    try {
      // eslint-disable-next-line no-await-in-loop -- passes are sequential by design
      await job.run(job.payload);
      job.failure = null;
    } catch (error) {
      job.failure = job.lastError = error;
      job.failedPasses += 1;
    }
  }
}

function acquireJobLock(paths, verb, claim) {
  const lock = lockPath(paths, verb);
  const release = adoptClaim(lock, claim) ?? tryOwnerLock(lock);
  if (!release) return null;
  // A handler that calls process.exit mid-job skips `finally`.
  process.once("exit", release);
  return () => {
    process.removeListener("exit", release);
    release();
  };
}

/** The worker a foreground spawned takes over the lock that foreground claimed for it. */
function adoptClaim(lock, claim) {
  // String(): an absent claim never matches, not even a lock with no readable owner.
  if (readBootstrapLockOwner(lock)?.token !== String(claim)) return null;
  recordOwner(lock, process.pid, claim);
  return ownerLockRelease(lock, claim);
}

/** Names `pid` as the owner of this claim's lock (atomic replace, so a liveness check never reads half a file). */
function recordOwner(lock, pid, claim) {
  const temp = path.join(lock, `owner.${process.pid}.tmp`);
  fs.writeFileSync(
    temp,
    `${JSON.stringify({ pid, token: claim, started_at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temp, path.join(lock, "owner.json"));
}

/** Takes the pending payload by rename, so a newer one written meanwhile stays pending. */
function claimPending(paths, verb) {
  const claim = path.join(
    paths.dir,
    `${stem(paths, verb)}.claim-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    fs.renameSync(pendingPath(paths, verb), claim);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return fs.readFileSync(claim, "utf8");
  } finally {
    fs.rmSync(claim, { force: true });
  }
}
