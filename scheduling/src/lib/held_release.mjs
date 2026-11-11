// held_release tick phase: expire, usage-check, stagger and release held runs; notice episodes; start sweep.
import { statSync } from "node:fs";
import { startHeldRun } from "./dispatch_held_run.mjs";
import { providerOf } from "./held_at_exit.mjs";
import { syncNoticeEpisodes } from "./held_episodes.mjs";
import { pickNoticeSender, sendHeldNotice } from "./held_notice.mjs";
import { expireHolds } from "./held_release_expire.mjs";
import { reconcileStaleHolds } from "./held_reconcile.mjs";
import { releaseDue } from "./held_release_dispatch.mjs";
import { probeUsage } from "./held_release_probe.mjs";
import {
  defaultLog,
  heldNow,
  loadHolds,
  memory,
} from "./held_release_core.mjs";
import { sweepFailedRuns } from "./held_sweep.mjs";
import { loadJobHistory } from "./read_store.mjs";
import { listRegisteredScopesLegacy } from "./scopes.mjs";
import { helmHome, resolveScope } from "./store.mjs";
import { readUsage } from "./usage_probe.mjs";

export { resetHeldReleaseMemory } from "./held_release_core.mjs";

// Only a cwd that is gone (ENOENT) drops a scope; an unreadable or unmounted one (EACCES, EPERM, TCC) is kept,
// so its holds load from the Helm home, or it counts as failed (partial), never as absent (fgp.53).
const gone = (path) => {
  try {
    statSync(path);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
};

export function defaultScopes() {
  return listRegisteredScopesLegacy()
    .filter((e) => e.quarantine_state !== "quarantined" && !gone(e.cwd))
    .map((e) => resolveScope({ cwd: e.cwd }));
}

export function lastSuccessOf(scope, job) {
  const done = loadJobHistory(scope, job.id, 50).findLast(
    (e) => e.kind === "completed" && e.status === "success" && e.session_id,
  );
  if (!done) return null;
  // `completed` events carry no runtime. Never pin a guessed one: a wrong
  // session/runtime pair is an identity the messaging layer never saw.
  const runtime = providerOf(job) ?? job.state?.held?.provider ?? null;
  if (!runtime) return null;
  return { session_id: done.session_id, runtime, at: done.ts };
}

/** One pass over all scopes. `deps` and `now` are injectable for tests. */
export async function runHeldReleaseTick({
  scopes,
  now = heldNow(),
  deps = {},
} = {}) {
  const d = {
    usage: readUsage,
    startHeldRun,
    send: sendHeldNotice,
    home: helmHome(),
    log: defaultLog,
    ...deps,
  };
  const { log } = d;
  let loaded = loadHolds(scopes, log);
  const reconciled = await reconcileStaleHolds(loaded, log);
  const expired = await expireHolds(loaded, now, log);
  const probed = await probeUsage(loaded, now, d);
  const released = await releaseDue(loaded, now, d);
  loaded = loadHolds(scopes, log);
  const holds = loaded.flatMap((l) =>
    l.holds.map((j) => ({ ...j.state.held, scope_id: l.scope.scope_id })),
  );
  const read = new Set(loaded.map((l) => l.scope.scope_id));
  const notices = await syncNoticeEpisodes({
    home: d.home,
    holds,
    // A scope that failed to load may still hold a limit: its episodes stay open while it fails (.50, .54).
    failedScopes: scopes.map((s) => s.scope_id).filter((id) => !read.has(id)),
    now,
    log,
    send: (notice) =>
      d.send(notice, {
        log: ({ event, status, ...fields }) => log(event, status, fields),
      }),
    pickSender: () =>
      pickNoticeSender(
        loaded.flatMap(({ scope, jobs }) =>
          jobs
            .filter((j) => j.state?.held || j.tags?.includes("coordinator"))
            .map((j) => ({
              tags: j.tags,
              held: Boolean(j.state?.held),
              last_success: lastSuccessOf(scope, j),
            })),
        ),
      ),
  });
  const counts = {
    held: holds.length,
    reconciled,
    expired,
    released,
    probed,
    notices_opened: notices.opened,
    episodes_closed: notices.closed,
  };
  const activity = [
    reconciled,
    expired,
    released,
    probed,
    notices.opened,
    notices.closed,
  ];
  if (activity.some(Boolean)) log("held_release.tick", "info", counts);
  return counts;
}

/** Daemon entry: registers the `held_release` phase; sweeps once per process first (AC-12). */
export function runHeldReleasePhase(
  runTickPhase,
  { scopes = defaultScopes, now = heldNow, deps = {} } = {},
) {
  return runTickPhase("held_release", async () => {
    const list = scopes();
    if (!memory.swept) {
      memory.swept = true;
      await sweepFailedRuns(list, { now: now(), log: deps.log ?? defaultLog });
    }
    await runHeldReleaseTick({ scopes: list, now: now(), deps });
  });
}
