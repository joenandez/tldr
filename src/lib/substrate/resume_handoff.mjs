#!/usr/bin/env node

import { constants, accessSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { appendActivityEvent } from "../tldr_agent_diagnostics.mjs";
import { readIdentity, readState } from "../identity_state.mjs";
import { isProcessAlive, processStartEvidence } from "../process_liveness.mjs";
import { classifySessionOwnerState } from "../session_owner_state.mjs";
import { terminateAliveIdlePid } from "../session_revive.mjs";

const LOG_PREFIX = "[🪳 TEMP TACHYON_SAFE_HANDOFF]";
const HANDOFF_HELPER_PATH = fileURLToPath(import.meta.url);

export function resumeHandoffSchedule({
  sessionId,
  providerCommand,
  providerArgs,
  replacement,
} = {}) {
  if (!replacement) return null;
  const descriptor = {
    session_id: sessionId,
    expected_pid: Number(replacement.expectedPid),
    expected_start_time: replacement.expectedStartTime || null,
    pid_source: replacement.pidSource || null,
    controlling_tty: replacement.controllingTty || null,
    provider_command: providerCommand,
    provider_args: providerArgs,
  };
  return {
    descriptor,
    childArgs: [
      HANDOFF_HELPER_PATH,
      "--descriptor-json",
      JSON.stringify(descriptor),
    ],
  };
}

function emitHandoff(action, descriptor, extra = {}, level = "info") {
  try {
    appendActivityEvent({
      type: "tachyon_safe_handoff",
      level,
      data: {
        action,
        session_id: descriptor?.session_id || null,
        expected_pid: descriptor?.expected_pid ?? null,
        pid_source: descriptor?.pid_source || null,
        controlling_tty: descriptor?.controlling_tty || null,
        log_prefix: LOG_PREFIX,
        ...extra,
      },
    });
  } catch {
    // Handoff safety must not depend on observability storage availability.
  }
}

function result(action, reason, descriptor, extra = {}, ok = true) {
  emitHandoff(action, descriptor, { reason, ...extra }, ok ? "info" : "error");
  return {
    ok,
    action,
    reason,
    session_id: descriptor?.session_id || null,
    expected_pid: descriptor?.expected_pid ?? null,
    ...extra,
  };
}

function executablePath(command, env = process.env) {
  if (typeof command !== "string" || command.trim() === "") return null;
  const candidate = command.trim();
  const paths =
    isAbsolute(candidate) || candidate.includes("/")
      ? [resolvePath(candidate)]
      : String(env.PATH || "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, candidate));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object")
    return "descriptor_invalid";
  if (typeof descriptor.session_id !== "string" || !descriptor.session_id)
    return "session_id_missing";
  const pid = Number(descriptor.expected_pid);
  if (!Number.isFinite(pid) || pid <= 1) return "expected_pid_invalid";
  if (
    !Array.isArray(descriptor.provider_args) ||
    descriptor.provider_args.some((arg) => typeof arg !== "string")
  )
    return "provider_args_invalid";
  return null;
}

function differentLiveOwner({ descriptor, identity, state }) {
  const expectedPid = Number(descriptor.expected_pid);
  const candidates = [
    { pid: Number(identity?.pid), source: "identity.pid" },
    {
      pid: Number(state?.last_pid ?? state?.lastPid),
      source: "state.last_pid",
    },
  ];
  return (
    candidates.find(
      (candidate) =>
        Number.isFinite(candidate.pid) &&
        candidate.pid > 1 &&
        candidate.pid !== expectedPid &&
        isProcessAlive(candidate.pid),
    ) || null
  );
}

function ownerSnapshot(descriptor) {
  const sessionId = descriptor.session_id;
  const identity = readIdentity(sessionId);
  const state = readState(sessionId);
  const replacement = differentLiveOwner({ descriptor, identity, state });
  if (replacement) {
    return {
      preserveReason: "owner_replaced",
      ownerPid: replacement.pid,
      ownerPidSource: replacement.source,
    };
  }
  const owner = classifySessionOwnerState({ sessionId, identity, state });
  if (owner.state === "alive_busy") {
    return { preserveReason: "owner_busy", owner };
  }
  if (owner.state === "alive_listening") {
    return { preserveReason: "owner_listening", owner };
  }
  return { owner, identity, state };
}

function launchProvider({ descriptor, prompt, spawnSyncImpl, signal = null }) {
  emitHandoff("provider_launch", descriptor, { signal });
  const launched = spawnSyncImpl(
    descriptor.provider_command,
    descriptor.provider_args,
    {
      cwd: process.cwd(),
      env: process.env,
      input: prompt,
      encoding: "utf8",
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (launched?.error || launched?.status !== 0) {
    return result(
      "handoff_failed",
      "provider_launch_failed",
      descriptor,
      {
        signal,
        provider_exit_code: launched?.status ?? null,
        provider_error: launched?.error?.message || null,
      },
      false,
    );
  }
  return result("provider_launched", null, descriptor, {
    signal,
    provider_exit_code: launched.status,
  });
}

export async function runResumeHandoff({
  descriptor,
  prompt,
  spawnSyncImpl = spawnSync,
} = {}) {
  const descriptorError = validateDescriptor(descriptor);
  if (descriptorError)
    return result("handoff_failed", descriptorError, descriptor, {}, false);

  emitHandoff("handoff_preflight", descriptor);
  if (!executablePath(descriptor.provider_command)) {
    return result(
      "handoff_failed",
      "provider_executable_missing",
      descriptor,
      {},
      false,
    );
  }
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return result(
      "handoff_failed",
      "resume_prompt_missing",
      descriptor,
      {},
      false,
    );
  }

  const expectedPid = Number(descriptor.expected_pid);
  let snapshot = ownerSnapshot(descriptor);
  if (snapshot.preserveReason) {
    return result("owner_preserved", snapshot.preserveReason, descriptor, {
      owner_pid: snapshot.ownerPid ?? snapshot.owner?.pid ?? null,
      owner_state: snapshot.owner?.state || null,
    });
  }

  if (!isProcessAlive(expectedPid)) {
    return launchProvider({
      descriptor,
      prompt,
      spawnSyncImpl,
      signal: null,
    });
  }
  if (!descriptor.expected_start_time) {
    return result(
      "handoff_failed",
      "process_start_evidence_missing",
      descriptor,
      {},
      false,
    );
  }
  const evidence = processStartEvidence(expectedPid);
  if (!evidence.start_time) {
    return result(
      "handoff_failed",
      "process_start_unavailable",
      descriptor,
      {},
      false,
    );
  }
  if (evidence.start_time !== descriptor.expected_start_time) {
    return result(
      "handoff_failed",
      "process_start_mismatch",
      descriptor,
      { actual_start_time: evidence.start_time },
      false,
    );
  }
  if (snapshot.owner?.state !== "alive_idle") {
    return result(
      "handoff_failed",
      "owner_not_verified_idle",
      descriptor,
      { owner_state: snapshot.owner?.state || null },
      false,
    );
  }

  snapshot = ownerSnapshot(descriptor);
  if (snapshot.preserveReason) {
    return result("owner_preserved", snapshot.preserveReason, descriptor, {
      owner_pid: snapshot.ownerPid ?? snapshot.owner?.pid ?? null,
      owner_state: snapshot.owner?.state || null,
    });
  }
  if (snapshot.owner?.state !== "alive_idle") {
    return result(
      "handoff_failed",
      "owner_not_verified_idle",
      descriptor,
      { owner_state: snapshot.owner?.state || null },
      false,
    );
  }
  const finalEvidence = processStartEvidence(expectedPid);
  if (
    !finalEvidence.start_time ||
    finalEvidence.start_time !== descriptor.expected_start_time
  ) {
    return result(
      "handoff_failed",
      finalEvidence.start_time
        ? "process_start_mismatch"
        : "process_start_unavailable",
      descriptor,
      { actual_start_time: finalEvidence.start_time },
      false,
    );
  }

  const termination = await terminateAliveIdlePid({
    sessionId: descriptor.session_id,
    pid: expectedPid,
    source: descriptor.pid_source,
  });
  if (!termination?.ok) {
    return result(
      "handoff_failed",
      termination?.error || "verified_termination_failed",
      descriptor,
      {},
      false,
    );
  }
  emitHandoff("verified_termination", descriptor, {
    signal: termination.signal || null,
  });
  return launchProvider({
    descriptor,
    prompt,
    spawnSyncImpl,
    signal: termination.signal || null,
  });
}

function descriptorArg(argv) {
  const index = argv.indexOf("--descriptor-json");
  if (index < 0 || !argv[index + 1]) return null;
  try {
    return JSON.parse(argv[index + 1]);
  } catch {
    return null;
  }
}

async function main() {
  const descriptor = descriptorArg(process.argv.slice(2));
  const prompt = readFileSync(0, "utf8");
  const handoff = await runResumeHandoff({ descriptor, prompt });
  process.stdout.write(`${JSON.stringify(handoff)}\n`);
  process.exitCode = handoff.ok ? 0 : 1;
}

if (process.argv[1] && resolvePath(process.argv[1]) === HANDOFF_HELPER_PATH) {
  main().catch((error) => {
    const descriptor = descriptorArg(process.argv.slice(2));
    const failed = result(
      "handoff_failed",
      "handoff_unhandled_error",
      descriptor,
      { error: error?.message || String(error) },
      false,
    );
    process.stdout.write(`${JSON.stringify(failed)}\n`);
    process.exitCode = 1;
  });
}
