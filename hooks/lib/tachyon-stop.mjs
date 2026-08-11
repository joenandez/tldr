#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  watch,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ackTachyonDelivery,
  claimTachyonListener,
  markTachyonListenerEnded,
  refreshTachyonListener,
  tachyonListenerPaths,
} from "../../src/lib/tachyon_listener.mjs";
import { appendActivityEvent } from "../../src/lib/tldr_agent_diagnostics.mjs";
import { readIdentity, writeState } from "../../src/lib/identity_state.mjs";
import { tachyonListenerEligible } from "../../src/lib/tachyon_eligibility.mjs";
import { runAriadneStopGate } from "../../src/lib/ariadne_followup.mjs";
import { runBeaconStopGate } from "../../src/lib/tldr_agent_beacon_stop.mjs";
import { markReplyPresented } from "./mark-reply-presented.mjs";
import { renderMidSessionInject } from "../templates/mid_session_inject.mjs";

let activeListenerCleanup = null;

for (const signalName of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signalName, () => {
    const cleanup = activeListenerCleanup;
    activeListenerCleanup = null;
    try {
      cleanup?.(`cancelled_${signalName.toLowerCase()}`);
    } catch {
      // Cancellation must still release the process when state storage fails.
    }
    process.exit(0);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function safeReadJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function sanitize(value) {
  return String(value ?? "unknown").replace(/[\r\n\t]+/g, " ");
}

function renderEntry(_sessionId, entry) {
  return renderMidSessionInject({
    thread_id: sanitize(entry.thread_id ?? "unknown"),
    body:
      entry.body === null || entry.body === undefined || entry.body === ""
        ? "(empty reply)"
        : String(entry.body),
  });
}

function writeSystemMessage(message) {
  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      systemMessage: message,
      suppressOutput: false,
    })}\n`,
  );
}

function markHookSessionState({ sessionId, state, pid, reason }) {
  const logPrefix =
    reason === "tachyon_listener_parked" ||
    reason === "tachyon_message_continuation"
      ? "[🪳 TEMP TACHYON_SAFE_HANDOFF]"
      : "[🪳 TEMP TACHYON_STOP]";
  try {
    writeState(sessionId, { state, lastPid: pid });
    appendActivityEvent({
      type: "tachyon_stop_hook_state",
      level: "debug",
      data: {
        session_id: sessionId,
        state,
        pid,
        reason,
        log_prefix: logPrefix,
      },
    });
  } catch (err) {
    appendActivityEvent({
      type: "tachyon_stop_hook_state_failed",
      level: "warn",
      data: {
        session_id: sessionId,
        state,
        pid,
        reason,
        error: err?.message || String(err),
        log_prefix: logPrefix,
      },
    });
  }
}

function logRelistenEvent({ sessionId, ownerId, pid, reason, claim = null }) {
  appendActivityEvent({
    type: "tachyon_stop_hook_relisten",
    level: "debug",
    data: {
      session_id: sessionId,
      owner_id: ownerId,
      pid,
      reason,
      blocking_owner_id: claim?.blocking_owner_id || null,
      blocking_deadline_at: claim?.deadline_at || null,
      log_prefix: "[🪳 TEMP TACHYON_RELISTEN]",
    },
  });
}

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function claimTachyonListenerWithRetry({
  sessionId,
  ownerId,
  pid,
  hookPid,
  hookPpid,
  runtime,
  leaseMs,
  retryMs,
}) {
  const claim = claimTachyonListener({
    sessionId,
    ownerId,
    pid,
    hookPid,
    hookPpid,
    agentPid: pid,
    runtime,
    waitState: "blocking_stop_hook",
    leaseMs,
  });
  if (claim.claimed || claim.reason !== "listener_in_flight") return claim;

  logRelistenEvent({
    sessionId,
    ownerId,
    pid,
    reason: "listener_in_flight_retry",
    claim,
  });
  const deadlineMs = Date.parse(claim.deadline_at || "");
  const waitMs = Number.isFinite(deadlineMs)
    ? Math.max(0, deadlineMs - Date.now() + 5)
    : 0;
  const maxWaitMs = Math.max(0, Number(retryMs) || 0);
  if (waitMs > maxWaitMs) return claim;
  if (waitMs > 0) await sleep(waitMs);
  return claimTachyonListener({
    sessionId,
    ownerId,
    pid,
    hookPid,
    hookPpid,
    agentPid: pid,
    runtime,
    waitState: "blocking_stop_hook",
    leaseMs,
  });
}

function lineEndOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) offsets.push(i + 1);
  }
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    offsets.push(buffer.length);
  }
  return offsets;
}

function readUnreadEntry({ inbox, statePath }) {
  if (!existsSync(inbox)) return null;
  const size = statSync(inbox).size;
  if (size <= 0) return null;
  const state = safeReadJson(statePath, {});
  let lastSeen = Number(state?.last_seen_offset || 0);
  if (!Number.isFinite(lastSeen) || lastSeen < 0 || lastSeen > size)
    lastSeen = 0;
  if (size <= lastSeen) return null;

  const buffer = readFileSync(inbox);
  const endOffsets = lineEndOffsets(buffer);
  for (const endOffset of endOffsets) {
    if (endOffset <= lastSeen) continue;
    const startOffset = lastSeen;
    const slice = buffer.subarray(startOffset, endOffset);
    const text = slice.toString("utf8").trim();
    if (!text) {
      lastSeen = endOffset;
      continue;
    }
    try {
      const entry = JSON.parse(text);
      if (!entry || typeof entry !== "object") {
        lastSeen = endOffset;
        continue;
      }
      return { entry, nextOffset: endOffset, size };
    } catch {
      lastSeen = endOffset;
    }
  }
  atomicWriteJson(statePath, {
    last_seen_offset: size,
    last_check_ts: nowIso(),
  });
  return null;
}

function advanceOffset(statePath, offset) {
  atomicWriteJson(statePath, {
    last_seen_offset: offset,
    last_check_ts: nowIso(),
  });
}

function fileSignature(path) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function exitContinuation(
  sessionId,
  entry,
  statePath,
  nextOffset,
  ownerId = null,
  pid = null,
) {
  markHookSessionState({
    sessionId,
    state: "busy",
    pid,
    reason: "tachyon_message_continuation",
  });
  const messageId =
    typeof entry.message_id === "string" ? entry.message_id : null;
  const presented = markReplyPresented({
    sessionId,
    messageId,
    via: "tachyon_stop_inject",
  });
  if (!presented.ok) {
    throw new Error(`reply_presented_mark_failed:${presented.error}`);
  }
  advanceOffset(statePath, nextOffset);
  if (messageId) {
    const ack = ackTachyonDelivery({ sessionId, messageId, ownerId });
    if (ownerId && ack.acked) {
      markTachyonListenerEnded({
        sessionId,
        ownerId,
        terminalReason: "delivered",
      });
    }
  }
  process.stderr.write(`${renderEntry(sessionId, entry)}\n`);
  process.exit(2);
}

async function waitForWake({
  sessionId,
  inbox,
  statePath,
  ownerId,
  timeoutMs,
  heartbeatMs,
  leaseMs,
}) {
  const { wake } = tachyonListenerPaths(sessionId);
  mkdirSync(dirname(wake), { recursive: true });
  let waitRegistrations = 0;
  let wakeSignature = fileSignature(wake);
  if (process.env.HELM_TACHYON_WAIT_COUNTER) {
    writeFileSync(process.env.HELM_TACHYON_WAIT_COUNTER, "0\n", "utf8");
  }

  return await new Promise((resolveWait) => {
    let settled = false;
    let watcher = null;
    let heartbeat = null;
    let timeout = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (watcher) watcher.close();
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      resolveWait(result);
    };

    const scan = () => {
      const unread = readUnreadEntry({ inbox, statePath });
      if (unread) finish({ type: "message", unread });
    };

    try {
      watcher = watch(
        dirname(wake),
        { persistent: true },
        (event, filename) => {
          if (filename && String(filename) !== "tachyon-wake.json") return;
          scan();
        },
      );
      waitRegistrations += 1;
      if (process.env.HELM_TACHYON_WAIT_COUNTER) {
        writeFileSync(
          process.env.HELM_TACHYON_WAIT_COUNTER,
          `${waitRegistrations}\n`,
          "utf8",
        );
      }
    } catch (err) {
      finish({ type: "error", error: err?.message || String(err) });
      return;
    }

    heartbeat = setInterval(
      () => {
        refreshTachyonListener({ sessionId, ownerId, leaseMs });
        const nextWakeSignature = fileSignature(wake);
        if (nextWakeSignature && nextWakeSignature !== wakeSignature) {
          wakeSignature = nextWakeSignature;
          scan();
        }
      },
      Math.max(50, heartbeatMs),
    );

    timeout = setTimeout(
      () => {
        markTachyonListenerEnded({
          sessionId,
          ownerId,
          terminalReason: "timeout",
        });
        finish({ type: "timeout" });
      },
      Math.max(1, timeoutMs),
    );

    scan();
  });
}

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) return 0;
  const root =
    process.env.TLDR_AGENT_SESSIONS_ROOT ||
    join(
      process.env.TLDR_AGENT_HOME || join(process.env.HOME, ".tldr-agent"),
      "sessions",
    );
  const dir = join(root, sessionId);
  const inbox = process.env.HELM_HOOK_INBOX || join(dir, "inbox.jsonl");
  const statePath =
    process.env.HELM_HOOK_STATE || join(dir, "inbox-check-state.json");
  const ownerId = process.env.HELM_TACHYON_OWNER_ID || `stop_${process.pid}`;
  const timeoutMs = numberEnv("HELM_TACHYON_WAIT_MS", 4 * 60 * 60 * 1000);
  const leaseMs = numberEnv("HELM_TACHYON_LEASE_MS", 30000);
  const claimRetryMs = numberEnv("HELM_TACHYON_CLAIM_RETRY_MS", leaseMs);
  const heartbeatMs = numberEnv(
    "HELM_TACHYON_HEARTBEAT_MS",
    Math.min(5000, Math.max(100, leaseMs / 2)),
  );

  mkdirSync(dir, { recursive: true });
  const identity = readIdentity(sessionId);
  const pid = Number(
    process.env.HELM_AGENT_PID || identity?.pid || process.ppid || process.pid,
  );
  if (process.env.HELM_TACHYON_STOP_HOOK_ACTIVE === "1") {
    logRelistenEvent({
      sessionId,
      ownerId,
      pid,
      reason: "stop_hook_active_reentry",
    });
  }
  const beacon = runBeaconStopGate({
    sessionId,
    home: process.env.TLDR_AGENT_HOME || join(process.env.HOME, ".tldr-agent"),
    preflightError: process.env.HELM_BEACON_PREFLIGHT_ERROR === "1",
  });
  if (beacon.notice) process.stderr.write(`${beacon.notice}\n`);
  if (beacon.action === "block") {
    markHookSessionState({
      sessionId,
      state: "busy",
      pid,
      reason: "beacon_stop_gate_pending",
    });
    return 2;
  }
  markHookSessionState({
    sessionId,
    state: "busy",
    pid,
    reason: "ariadne_stop_gate_pending",
  });
  const ariadne = runAriadneStopGate({ sessionId, identity });
  if (ariadne.notice) process.stderr.write(`${ariadne.notice}\n`);
  if (ariadne.action === "block") return 2;
  if (!tachyonListenerEligible({ sessionId, identity })) {
    markHookSessionState({
      sessionId,
      state: "idle",
      pid,
      reason: "tachyon_ineligible",
    });
    return 0;
  }
  const unread = readUnreadEntry({ inbox, statePath });
  if (unread) {
    exitContinuation(
      sessionId,
      unread.entry,
      statePath,
      unread.nextOffset,
      null,
      pid,
    );
    return 2;
  }
  if (process.env.HELM_TACHYON_DISABLE_LISTEN === "1") {
    markHookSessionState({
      sessionId,
      state: "idle",
      pid,
      reason: "tachyon_disabled",
    });
    return 0;
  }

  const claim = await claimTachyonListenerWithRetry({
    sessionId,
    ownerId,
    pid,
    hookPid: process.pid,
    hookPpid: process.ppid,
    runtime: identity?.runtime || null,
    leaseMs,
    retryMs: claimRetryMs,
  });
  if (!claim.claimed) {
    markHookSessionState({
      sessionId,
      state: "idle",
      pid,
      reason: `tachyon_listener_${claim.reason || "claim_failed"}`,
    });
    return 0;
  }
  activeListenerCleanup = (terminalReason) => {
    markTachyonListenerEnded({ sessionId, ownerId, terminalReason });
    markHookSessionState({
      sessionId,
      state: "idle",
      pid,
      reason: `tachyon_listener_${terminalReason}`,
    });
  };
  markHookSessionState({
    sessionId,
    state: "idle",
    pid,
    reason: "tachyon_listener_parked",
  });
  writeSystemMessage(
    "tldr; is listening for email replies. Press ESC to stop listening and resume this session.",
  );
  const result = await waitForWake({
    sessionId,
    inbox,
    statePath,
    ownerId,
    timeoutMs,
    heartbeatMs,
    leaseMs,
  });
  if (result.type === "message") {
    activeListenerCleanup = null;
    exitContinuation(
      sessionId,
      result.unread.entry,
      statePath,
      result.unread.nextOffset,
      ownerId,
      pid,
    );
    return 2;
  }
  activeListenerCleanup = null;
  if (result.type === "error") {
    markTachyonListenerEnded({
      sessionId,
      ownerId,
      terminalReason: "watch_error",
    });
  }
  markHookSessionState({
    sessionId,
    state: "idle",
    pid,
    reason: `tachyon_listener_${result.type || "ended"}`,
  });
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const cleanup = activeListenerCleanup;
    activeListenerCleanup = null;
    cleanup?.("listener_error");
    const sessionId = process.argv[2];
    if (sessionId) {
      const identity = readIdentity(sessionId);
      const pid = Number(
        process.env.HELM_AGENT_PID ||
          identity?.pid ||
          process.ppid ||
          process.pid,
      );
      markHookSessionState({
        sessionId,
        state: "idle",
        pid,
        reason: "tachyon_listener_error",
      });
    }
    process.stderr.write(`[tachyon-stop] ${err?.message || String(err)}\n`);
    process.exitCode = 0;
  });
