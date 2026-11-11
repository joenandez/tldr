import { output, fail } from "../lib/json_io.mjs";
import { heldNow } from "../lib/held_release_core.mjs";
import { defaultScopes } from "../lib/held_release.mjs";
import { liveRunsOf, releaseBlocker } from "../lib/held_live_runs.mjs";
import { mutateJobs } from "../lib/scope_runtime.mjs";
import { loadActiveRunsReadOnly } from "../lib/store.mjs";
import { TASKS_COMMAND } from "../lib/helm_context.mjs";

const PROVIDERS = new Set(["claude", "codex"]);

export const RELEASE_HELD_HELP = {
  command: "release-held",
  summary:
    "Release held runs now, in every registered workspace. Run it after the user adds credits or switches accounts.",
  usage: `${TASKS_COMMAND} release-held [--provider claude|codex] [--json]`,
  required: [],
  options: [
    "--provider claude|codex  Release only holds for that provider.",
    "--json  Print one JSON object with the totals and per-scope job ids (released, deferred).",
    "--pretty",
  ],
  examples: [
    {
      label: "release every held run",
      command: `${TASKS_COMMAND} release-held --json`,
    },
    {
      label: "release only Claude holds",
      command: `${TASKS_COMMAND} release-held --provider claude`,
    },
  ],
  notes: [
    "The scheduler daemon staggers and dispatches released runs; this command only marks them due.",
    "A held run beside a live run of its job is marked due but counted as deferred: it starts once that run ends.",
  ],
};

function log(event, fields) {
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}

// Marked due, but the daemon will not start a run beside a live one (the same blocker it checks): say why.
function splitDeferred(scope, marked) {
  const live = liveRunsOf(scope, loadActiveRunsReadOnly(scope).runs);
  const jobIds = [];
  const deferredIds = [];
  for (const job of marked) {
    const reason = releaseBlocker(live, job);
    (reason ? deferredIds : jobIds).push(job.id);
    if (reason)
      log("release_held.deferred", {
        status: "info",
        params: { scope_id: scope.scope_id, job: job.id },
        reason,
      });
  }
  return { jobIds, deferredIds };
}

async function releaseInScope(scope, provider) {
  const marked = [];
  const result = await mutateJobs(
    scope,
    `release_held_${Date.now()}`,
    (jobs) => {
      const now = heldNow();
      for (const job of jobs) {
        const held = job.state?.held;
        if (!held || (provider && held.provider !== provider)) continue;
        held.until = now;
        held.release_requested_by = "command";
        marked.push(job);
      }
    },
  );
  if (!result.ok) throw new Error(`scope busy: ${scope.scope_id}`);
  const { jobIds, deferredIds } = splitDeferred(scope, marked);
  return {
    scope_id: scope.scope_id,
    cwd: scope.cwd,
    released: jobIds.length,
    job_ids: jobIds,
    deferred: deferredIds.length,
    deferred_job_ids: deferredIds,
  };
}

async function releaseAll(provider) {
  const scopes = [];
  const errors = [];
  for (const scope of defaultScopes()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one scope lease at a time
      scopes.push(await releaseInScope(scope, provider));
    } catch (err) {
      log("release_held_scope_failed", {
        status: "error",
        params: { scope_id: scope.scope_id },
        error: String(err?.message || err),
        stack: err?.stack,
      });
      errors.push({
        code: "scope_failed",
        message: `${scope.cwd}: ${err.message}`,
      });
    }
  }
  return { scopes, errors };
}

function printText({ released, deferred, scopes }, errors) {
  const later = (n) => (n ? `, deferred ${n} (a run of the job is live)` : "");
  for (const s of scopes)
    process.stdout.write(
      `${s.cwd}: released ${s.released}${later(s.deferred)}\n`,
    );
  process.stdout.write(
    `released ${released} held run${released === 1 ? "" : "s"}${later(deferred)}\n`,
  );
  for (const e of errors) process.stderr.write(`${e.message}\n`);
}

export async function runReleaseHeld({ flags, pretty }) {
  const started = Date.now();
  const cmd = "release-held";
  const provider = typeof flags.provider === "string" ? flags.provider : null;
  if (flags.provider !== undefined && !PROVIDERS.has(provider)) {
    fail(cmd, "invalid_flag", "--provider must be claude or codex", {}, pretty);
    process.exit(2);
  }
  const { scopes, errors } = await releaseAll(provider);
  const released = scopes.reduce((sum, s) => sum + s.released, 0);
  const deferred = scopes.reduce((sum, s) => sum + s.deferred, 0);
  log("release_held", {
    params: { provider },
    result: {
      released,
      deferred,
      scopes: scopes.length,
      failed: errors.length,
    },
    status: errors.length ? "partial" : "ok",
    latency: Date.now() - started,
  });
  const data = { released, deferred, scopes };
  if (flags.json || pretty)
    output(cmd, errors.length === 0, data, errors, pretty);
  else printText(data, errors);
  if (errors.length) process.exit(1);
}
