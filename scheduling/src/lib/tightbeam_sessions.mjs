// Helm's read path for agent session facts.
//
// Tightbeam's session hooks register every Claude Code and Codex session as
// an endpoint: provider session id, runtime, busy/idle state, launch mode,
// the workspace the session reported, and (Codex only) the proven owner pid.
// Helm used to keep its own SessionStart/UserPromptSubmit/Stop hooks that
// wrote the same facts under ~/.helm/sessions/<id>/. Those hooks are retired;
// Helm now reads the facts from Tightbeam through the package's `tightbeam`
// CLI (`tightbeam endpoint list`). It never imports messaging code and never
// opens Tightbeam's database: the CLI process is the boundary.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This package's own launcher, libexec/tightbeam at the package root (off
// every PATH; bin/ holds only the front door). It runs the Tightbeam CLI on
// the package's verified Node runtime. TIGHTBEAM_BIN overrides it, as it
// does for tldr's channel runtime.
export const PACKAGE_TIGHTBEAM_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "libexec",
  "tightbeam",
);

export const TIGHTBEAM_SESSION_LOOKUP_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function tightbeamCommand(env = process.env) {
  return env.TIGHTBEAM_BIN || PACKAGE_TIGHTBEAM_BIN;
}

// Tightbeam's documented state-root contract: TIGHTBEAM_STATE_ROOT, else
// ~/.tldr-agents/tightbeam (Phase E; ~/.tightbeam is the legacy root and a
// compatibility symlink until item 36). Helm only checks that the directory
// exists, so a machine (or a test home) with no Tightbeam install never pays
// for a CLI launch. Helm's plists also carry this value so Helm-launched
// sessions inherit it.
export function tightbeamStateRoot(env = process.env) {
  return (
    env.TIGHTBEAM_STATE_ROOT ||
    join(env.HOME || homedir(), ".tldr-agents", "tightbeam")
  );
}

// Tightbeam stores Claude Code as `claude-code`; Helm has always said
// `claude`. The endpoint.list runtime filter accepts either spelling.
export function helmRuntimeName(runtime) {
  if (runtime === "claude-code") return "claude";
  return typeof runtime === "string" && runtime ? runtime : null;
}

function log(level, fields) {
  if (level === "debug" && process.env.HELM_LOG_LEVEL !== "debug") return;
  try {
    process.stderr.write(
      `${JSON.stringify({ component: "helm", level, ...fields })}\n`,
    );
  } catch {
    // Diagnostics must never change the lookup result.
  }
}

export function endpointListArgs({
  sessionId = null,
  runtime = null,
  createdAfter = null,
  createdBefore = null,
  includeClosed = false,
  limit = null,
} = {}) {
  const args = ["--json", "endpoint", "list"];
  if (sessionId) args.push("--session", String(sessionId));
  if (runtime) args.push("--runtime", String(runtime));
  if (createdAfter) args.push("--created-after", String(createdAfter));
  if (createdBefore) args.push("--created-before", String(createdBefore));
  if (includeClosed) args.push("--include-closed");
  if (limit) args.push("--limit", String(limit));
  return args;
}

// One endpoint row as the session facts Helm consumers read. Endpoints
// with no provider session behind them (daemon placeholders) are not agent
// sessions and are dropped by the caller.
export function sessionFromEndpoint(row) {
  const updated = Date.parse(row?.updated_at || "");
  return {
    session_id: row.provider_session_id,
    runtime: helmRuntimeName(row.runtime),
    state: row.state || null,
    state_since: Number.isFinite(updated) ? updated : null,
    session_started_at: row.created_at || null,
    cwd: row.authority_reference || null,
    launch_mode: row.launch_mode || null,
    pid: Number.isInteger(row.owner_process_pid) ? row.owner_process_pid : null,
    endpoint_id: row.endpoint_id || null,
    source: "tightbeam",
  };
}

function runTightbeam(command, args, { env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          signal: error?.signal || null,
          timedOut: Boolean(error?.killed),
          spawnError: error && typeof error.code === "string" ? error.code : null,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      },
    );
  });
}

function failureCode(outcome) {
  if (outcome.spawnError) return "tightbeam_cli_unavailable";
  if (outcome.timedOut) return "tightbeam_cli_timeout";
  const named = /^error ([a-z_]+):/m.exec(outcome.stderr);
  if (named?.[1] === "malformed_request" && /unknown operation/.test(outcome.stderr)) {
    // A daemon older than endpoint.list: Helm's sessions stay readable
    // from the legacy files until the daemon restarts on this release.
    return "tightbeam_endpoint_list_unsupported";
  }
  if (named) return `tightbeam_${named[1]}`;
  return "tightbeam_cli_failed";
}

/**
 * Lists agent sessions Tightbeam knows about. Resolves to
 * `{ ok: true, sessions, truncated }` or `{ ok: false, error, message }`;
 * it never throws, because every caller has a fallback.
 */
export async function listTightbeamSessions(
  filters = {},
  {
    env = process.env,
    run = runTightbeam,
    timeoutMs = TIGHTBEAM_SESSION_LOOKUP_TIMEOUT_MS,
  } = {},
) {
  const started = Date.now();
  const params = {
    runtime: filters.runtime || null,
    session: filters.sessionId ? "set" : null,
    window: Boolean(filters.createdAfter || filters.createdBefore),
    limit: filters.limit || null,
  };
  const stateRoot = tightbeamStateRoot(env);
  if (!existsSync(stateRoot)) {
    log("debug", {
      event: "tightbeam_session_lookup",
      status: "skipped",
      reason: "tightbeam_state_root_missing",
      params,
    });
    return {
      ok: false,
      error: "tightbeam_state_root_missing",
      message: `no Tightbeam state root at ${stateRoot}`,
    };
  }
  const command = tightbeamCommand(env);
  const outcome = await run(command, endpointListArgs(filters), {
    env,
    timeoutMs,
  });
  const latencyMs = Date.now() - started;
  if (outcome.code !== 0) {
    const error = failureCode(outcome);
    log("warn", {
      event: "tightbeam_session_lookup",
      status: "failed",
      error,
      exit_code: outcome.code,
      signal: outcome.signal,
      latency_ms: latencyMs,
      params,
    });
    return {
      ok: false,
      error,
      message: outcome.stderr.trim().split("\n").at(-1) || error,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(outcome.stdout.trim().split("\n").at(-1) || "");
  } catch {
    parsed = null;
  }
  const rows = parsed?.ok === true ? parsed.result?.endpoints : null;
  if (!Array.isArray(rows)) {
    log("warn", {
      event: "tightbeam_session_lookup",
      status: "failed",
      error: "tightbeam_output_invalid",
      latency_ms: latencyMs,
      params,
    });
    return {
      ok: false,
      error: "tightbeam_output_invalid",
      message: "tightbeam endpoint list did not return an endpoints array",
    };
  }
  const sessions = rows
    .filter(
      (row) =>
        typeof row?.provider_session_id === "string" &&
        row.provider_session_id.length > 0,
    )
    .map(sessionFromEndpoint);
  log("debug", {
    event: "tightbeam_session_lookup",
    status: "ok",
    result: { sessions: sessions.length, truncated: Boolean(parsed.result.truncated) },
    latency_ms: latencyMs,
    params,
  });
  return {
    ok: true,
    sessions,
    truncated: Boolean(parsed.result.truncated),
  };
}

// A session's reported working directory and the run's cwd name one
// directory even when one side is a symlink (/tmp vs /private/tmp). An
// unknown side does not exclude a candidate; the time window still does.
function sameDirectory(left, right) {
  if (!left || !right || left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export const RUN_SESSION_WINDOW_GRACE_MS = 5_000;

/**
 * Finds the one session a Helm-launched agent run started, for runs whose
 * output carried no session id. The session's SessionStart hook registered
 * its Tightbeam endpoint while the run's wrapper was alive, for this
 * runtime, from this working directory. A proven owner pid (Codex) that
 * matches the wrapper wins; otherwise exactly one candidate must remain.
 * Two candidates fail closed rather than guessing.
 *
 * Resolves to `{ ok: true, session, match }` or
 * `{ ok: false, error, candidates, unavailable }`; `unavailable` means
 * Tightbeam could not answer at all.
 */
export async function resolveRunSessionFromTightbeam(
  {
    agent,
    startedMs,
    finishedMs,
    cwd = null,
    pids = [],
    graceMs = RUN_SESSION_WINDOW_GRACE_MS,
  },
  options = {},
) {
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) {
    return {
      ok: false,
      error: "wrapper_time_range_missing",
      candidates: [],
      unavailable: false,
    };
  }
  const lookup = await listTightbeamSessions(
    {
      runtime: agent,
      createdAfter: new Date(startedMs - graceMs).toISOString(),
      createdBefore: new Date(finishedMs + graceMs).toISOString(),
      limit: 50,
    },
    options,
  );
  if (!lookup.ok) {
    return { ok: false, error: lookup.error, candidates: [], unavailable: true };
  }
  const candidates = lookup.sessions.filter(
    (session) =>
      session.runtime === helmRuntimeName(agent) &&
      sameDirectory(session.cwd, cwd),
  );
  const wanted = new Set(
    pids.filter((pid) => Number.isInteger(pid) && pid > 0),
  );
  const byOwner = candidates.filter((session) => wanted.has(session.pid));
  if (byOwner.length === 1) {
    return { ok: true, session: byOwner[0], match: "owner_pid" };
  }
  if (candidates.length === 1) {
    return { ok: true, session: candidates[0], match: "session_window" };
  }
  return {
    ok: false,
    error:
      candidates.length > 1
        ? "tightbeam_session_ambiguous"
        : "tightbeam_session_unresolved",
    candidates: candidates.map((session) => session.session_id),
    unavailable: false,
  };
}
