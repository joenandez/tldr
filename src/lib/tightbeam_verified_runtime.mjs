// Item 38 option E: one payload verification per email poll tick.
//
// Every libexec/tightbeam call goes through libexec/component-dispatch,
// which hashes the 52 MB runtime payload and reads the manifest with plutil
// before it runs Node. An idle poll tick makes five such calls. This runner
// asks the same dispatcher to verify once (`component-dispatch --resolve
// tightbeam`) on the tick's first call, then runs that tick's calls on the
// verified runtime node with the packaged Tightbeam entrypoint, over the same
// process boundary and environment. It never falls back: when verification
// fails, every call in the tick fails, so the tick fails. The poll child is
// one process per tick, so one runner instance is one tick.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { productionRun } from "./tightbeam_channel_runtime.mjs";

const execFileAsync = promisify(execFile);
const RESOLVE_TIMEOUT_MS = 30_000;
const RUNTIME_FAILURE = /^tldr-agent runtime: ([A-Z_]+): (.*)$/mu;

function logRuntime(level, event, params) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, params })}\n`,
  );
}

// The package dispatcher beside a tightbeam launcher (libexec/, or bin/ in a
// package from before the launchers moved), or null when the command is not
// this package's launcher (an explicit TIGHTBEAM_BIN that points elsewhere
// keeps its own per-call behavior).
export function packageDispatcherFor(command) {
  let launcher;
  try {
    launcher = realpathSync(command);
  } catch {
    return null;
  }
  if (basename(launcher) !== "tightbeam") return null;
  const dispatcher = join(dirname(launcher), "component-dispatch");
  return existsSync(dispatcher) ? dispatcher : null;
}

export function runtimeUnverified(runtimeCode, detail) {
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: "TIGHTBEAM_RUNTIME_UNVERIFIED",
      runtime_code: runtimeCode,
      message: `tldr; could not verify its packaged runtime: ${detail}`,
      retryable: false,
      remediation:
        "Reinstall or update tldr; so its runtime payload matches release/activation-manifest.json.",
    }),
  });
}

function parseResolution(stdout, dispatcher) {
  const fields = Object.fromEntries(
    String(stdout)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  const expectedEntrypoint = join(
    dirname(dirname(dispatcher)),
    "messaging",
    "bin",
    "tightbeam",
  );
  if (
    !isAbsolute(fields.node ?? "") ||
    !/^[0-9a-f]{64}$/u.test(fields.sha256 ?? "") ||
    realpathSync(fields.entrypoint) !== realpathSync(expectedEntrypoint)
  ) {
    return null;
  }
  return {
    node: fields.node,
    entrypoint: fields.entrypoint,
    sha256: fields.sha256,
  };
}

// Runs `component-dispatch --resolve tightbeam` with the environment a
// libexec/tightbeam call would get, so the runtime cache is the same one.
export async function resolveVerifiedTightbeamRuntime({
  dispatcher,
  env = process.env,
}) {
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync(
      "/bin/sh",
      [dispatcher, "--resolve", "tightbeam"],
      {
        encoding: "utf8",
        timeout: RESOLVE_TIMEOUT_MS,
        env: {
          PATH: env.PATH,
          HOME: env.HOME,
          TLDR_AGENT_HOME: env.TLDR_AGENT_HOME,
        },
      },
    );
    let resolved = null;
    try {
      resolved = parseResolution(stdout, dispatcher);
    } catch {
      resolved = null;
    }
    if (!resolved) {
      logRuntime("error", "tightbeam_runtime_unverified", {
        runtime_code: "RUNTIME_RESOLUTION_INVALID",
        latency_ms: Date.now() - startedAt,
      });
      return runtimeUnverified(
        "RUNTIME_RESOLUTION_INVALID",
        "the dispatcher returned an unexpected runtime",
      );
    }
    logRuntime("info", "tightbeam_runtime_verified", {
      sha256: resolved.sha256,
      latency_ms: Date.now() - startedAt,
    });
    return Object.freeze({ ok: true, ...resolved });
  } catch (error) {
    const failure = RUNTIME_FAILURE.exec(String(error?.stderr ?? ""));
    const runtimeCode =
      failure?.[1] ??
      (error?.killed ? "RUNTIME_RESOLVE_TIMEOUT" : "RUNTIME_RESOLVE_FAILED");
    logRuntime("error", "tightbeam_runtime_unverified", {
      runtime_code: runtimeCode,
      exit_code: typeof error?.code === "number" ? error.code : null,
      latency_ms: Date.now() - startedAt,
    });
    return runtimeUnverified(
      runtimeCode,
      failure?.[2] ?? error?.message ?? "component-dispatch failed",
    );
  }
}

// A `run` for createTightbeamChannel that verifies the payload once for the
// life of this runner (one poll tick) and runs every call on that runtime.
export function createTickVerifiedTightbeamRun({
  run = productionRun,
  resolveRuntime = resolveVerifiedTightbeamRuntime,
} = {}) {
  const resolutions = new Map();
  return async (options) => {
    const dispatcher = packageDispatcherFor(options.command);
    if (!dispatcher) return run(options);
    if (!resolutions.has(dispatcher)) {
      resolutions.set(dispatcher, resolveRuntime({ dispatcher }));
    }
    const runtime = await resolutions.get(dispatcher);
    if (runtime?.ok !== true) return runtime;
    return run({
      ...options,
      command: runtime.node,
      commandPrefix: [runtime.entrypoint],
    });
  };
}
