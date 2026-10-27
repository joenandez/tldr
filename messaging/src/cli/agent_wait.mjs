import { REPLY_BINDING_POLICY } from "../protocol/reply_listener_policy.mjs";
import { readActionStore, writeActionStore } from "./agent_action_store.mjs";
import {
  cachePendingReplyGuard,
  canonicalPendingReplyGuard,
} from "./agent_wait_context.mjs";
import {
  readWaitMessage,
  readWaitOutcome,
  readWaitTerminal,
  recordWaitMessage,
  recordWaitOutcome,
} from "./agent_wait_journal.mjs";
import { tightbeamRecipeCommand } from "./package_context.mjs";

const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = REPLY_BINDING_POLICY.maxParkMs;

export function parseWaitTimeout(value) {
  if (value === undefined) return undefined;
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new RangeError("--timeout requires a duration such as 30s");
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]];
  const timeout = Number(match[1]) * scale;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_WAIT_MS) {
    throw new RangeError(`--timeout must be between 1ms and ${MAX_WAIT_MS}ms`);
  }
  return timeout;
}

export { readActionStore, readWaitOutcome, writeActionStore };

function aborted(signal) {
  return signal?.aborted === true;
}

function waitForSignal(signal, milliseconds) {
  if (aborted(signal)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function waitForRequest(request, signal, remaining) {
  if (!signal) return request;
  if (aborted(signal)) return Promise.resolve({ cancelled: true });
  let timer;
  let onAbort;
  const stopped = new Promise((resolve) => {
    onAbort = () => resolve({ cancelled: true });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => resolve({ timed_out: true }), remaining);
  });
  return Promise.race([request.then((value) => ({ value })), stopped]).finally(
    () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  );
}

function terminalResult(outcome, replay = false) {
  return {
    outcome,
    ...(replay ? { idempotent_replay: true } : {}),
    confirmation: outcome === "timeout" ? "Wait timed out" : "Wait cancelled",
  };
}

function needsNotificationWaitUpdate(error) {
  const field = error?.details?.field;
  const malformedReasons = [
    /unknown operation: message\.notification\.next/.test(error?.message ?? ""),
    ["include_pending_reply_guard", "wait_action_id"].includes(field),
  ];
  return [
    ["unknown_operation", "unsupported_operation"].includes(error?.code),
    error?.code === "malformed_request" && malformedReasons.some(Boolean),
  ].some(Boolean);
}

function requireSessionIdentity(session) {
  const endpointValid = typeof session?.endpoint_id === "string";
  const generationValid =
    Number.isSafeInteger(session?.process_generation) &&
    session.process_generation >= 1;
  const providerValid =
    typeof session?.session_id === "string" && session.session_id.length > 0;
  if (endpointValid && generationValid && providerValid) return;
  throw Object.assign(
    new Error(
      "the current session lacks exact provider identity; refresh the supported SessionStart hook and retry",
    ),
    { code: "session_unavailable" },
  );
}

function replayResult(session, actionId) {
  const terminal = readWaitTerminal(session, actionId);
  if (terminal) return terminalResult(terminal.outcome, true);
  const messageId = readWaitMessage(session, actionId);
  return messageId ? messageResult(session, messageId, true) : null;
}

async function finishWait(client, session, { actionId, outcome }) {
  await client.close?.();
  recordWaitOutcome(session, actionId, outcome);
  return terminalResult(outcome);
}

async function pollStep(client, session, options) {
  const {
    actionId,
    signal,
    remaining,
    started,
    timeoutMs,
    now,
    capturePendingGuard,
  } = options;
  const pending = client.request("message.notification.next", {
    endpoint_id: session.endpoint_id,
    process_generation: session.process_generation,
    provider_session_id: session.session_id,
    ...(capturePendingGuard && actionId
      ? { include_pending_reply_guard: true, wait_action_id: actionId }
      : {}),
  });
  const reply = await waitForRequest(pending, signal, remaining);
  let result = null;
  if (signal.aborted)
    result = await finishWait(client, session, {
      actionId,
      outcome: "cancelled",
    });
  else if (reply?.timed_out || now() - started >= timeoutMs)
    result = await finishWait(client, session, {
      actionId,
      outcome: "timeout",
    });
  const notification = reply?.value;
  if (
    capturePendingGuard &&
    !result &&
    Object.hasOwn(notification ?? {}, "pending_reply_guard")
  ) {
    const guard = canonicalPendingReplyGuard(
      notification?.pending_reply_guard,
      session,
    );
    cachePendingReplyGuard(session, guard);
  }
  if (
    !result &&
    notification &&
    typeof notification.message_id === "string" &&
    notification.message_id.length > 0
  ) {
    recordWaitMessage(session, actionId, notification.message_id);
    result = messageResult(session, notification.message_id);
  }
  return result;
}

async function pollUntilDone(client, session, options) {
  const { actionId, signal, started, timeoutMs, now, sleep } = options;
  let result;
  let capturePendingGuard = Boolean(actionId);
  while (!result) {
    const remaining = timeoutMs - (now() - started);
    const optionsForStep = { ...options, remaining, capturePendingGuard };
    result = signal.aborted
      ? await finishWait(client, session, { actionId, outcome: "cancelled" })
      : remaining <= 0
        ? await finishWait(client, session, { actionId, outcome: "timeout" })
        : await pollStep(client, session, optionsForStep);
    capturePendingGuard = false;
    if (!result)
      await sleep(
        signal,
        Math.min(POLL_INTERVAL_MS, timeoutMs - (now() - started)),
      );
  }
  return result;
}

export async function waitForAgent(
  client,
  session,
  {
    actionId,
    timeoutMs = MAX_WAIT_MS,
    signal,
    now = () => performance.now(),
    sleep = waitForSignal,
  } = {},
) {
  requireSessionIdentity(session);
  const controller = new AbortController();
  const cancel = (name, code) => {
    process.exitCode = code;
    controller.abort(name);
  };
  const onInterrupt = () => cancel("cancelled", 130);
  const onTerminate = () => cancel("cancelled", 143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const started = now();
  try {
    const replay = replayResult(session, actionId);
    if (replay) return replay;
    if (controller.signal.aborted) {
      return await finishWait(client, session, {
        actionId,
        outcome: "cancelled",
      });
    }
    return await pollUntilDone(client, session, {
      actionId,
      signal: controller.signal,
      started,
      timeoutMs,
      now,
      sleep,
    });
  } catch (error) {
    if (needsNotificationWaitUpdate(error)) {
      throw Object.assign(
        new Error(
          "the Tightbeam daemon needs an update to support agent wait; update or repair the messaging daemon and retry",
        ),
        { code: "notification_wait_unavailable" },
      );
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

function messageResult(session, messageId, replay = false) {
  return {
    outcome: "message",
    message_id: messageId,
    ...(replay ? { idempotent_replay: true } : {}),
    next_action: `${session.recipe_prefix ?? tightbeamRecipeCommand()} agent receive --message ${messageId}`,
    confirmation: `Message available: ${messageId}`,
  };
}
