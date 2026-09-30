import { spawnSync } from "node:child_process";

// launchd's `bootout` returns while the job is still draining: `launchctl
// print` keeps reporting it (state = SIGTERMed, old pid listed) until the
// process exits. A bootstrap in that window fails with EIO (5) and a kickstart
// with EALREADY (37), and a status read mistakes the dying pid for a running
// service. A slow-exiting daemon (for example one mid-tick under load) made a
// live `helm service update` fail this way, so every stop waits for release.
// launchd sends SIGKILL after its default 20 s exit timeout; allow margin.
export const LAUNCHD_RELEASE_TIMEOUT_MS = 30_000;
const LAUNCHD_RELEASE_POLL_MS = 250;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function logLaunchd(level, event, params) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, params })}\n`,
  );
}

export function waitForLaunchdRelease(
  target,
  {
    timeoutMs = LAUNCHD_RELEASE_TIMEOUT_MS,
    run = spawnSync,
    sleep = sleepMs,
    now = Date.now,
  } = {},
) {
  const startedAt = now();
  let polls = 0;
  for (;;) {
    polls += 1;
    const printed = run("launchctl", ["print", target], { encoding: "utf8" });
    if (printed.status !== 0) {
      // Only log waits; an immediate release is the normal fast path.
      if (polls > 1) {
        logLaunchd("info", "launchd_bootout_released", {
          target,
          polls,
          latency_ms: now() - startedAt,
        });
      }
      return { released: true, polls, latency_ms: now() - startedAt };
    }
    if (now() - startedAt >= timeoutMs) {
      const state =
        /state = (\S+)/.exec(`${printed.stdout || ""}`)?.[1] || null;
      logLaunchd("error", "launchd_bootout_release_timeout", {
        target,
        polls,
        state,
        latency_ms: now() - startedAt,
      });
      const err = new Error(
        `launchd_bootout_release_timeout: ${target} was still ${state || "loaded"} ${timeoutMs} ms after bootout`,
      );
      err.code = "launchd_bootout_release_timeout";
      throw err;
    }
    sleep(LAUNCHD_RELEASE_POLL_MS);
  }
}

// Boot the job out (a missing job, status 3, is already stopped) and return
// only once launchd has released it, so a following bootstrap cannot race.
export function bootoutLaunchdJob(target, options = {}) {
  const run = options.run || spawnSync;
  const result = run("launchctl", ["bootout", target], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 3) {
    throw new Error(
      (result.stderr || result.stdout || "launchctl failed").trim(),
    );
  }
  return waitForLaunchdRelease(target, options);
}
