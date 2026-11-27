// Daemon push into a live non-interactive run (never-wait, plan Decision C).
// The run host listens on <state-root>/sessions/<session>/in.sock and takes
// one line-JSON request per connection:
//   {"op":"prompt","id":"<delivery id>","text","deliver":"steer"|"queue","owner_launch_token"}
//   -> {"id","ok":true,"delivered":"steer"|"queue"} | {"ok":false,"reason":"owner"|"closed"|"busy"|"rejected"|"error"}
// `busy` is a Codex host whose turn is starting; `rejected` is a Codex app-server that refused every
// turn that could carry the prompt (a Codex ok waits for its turn/start or turn/steer to be accepted).
// Both are retryable, no receipt, like every refusal; a host slower than the request timeout is `timeout`.
// The run host refuses (`owner`) unless the token is its own launch's, so a
// resume launch that bound in.sock before it registered never takes a push
// meant for the previous owner.
// The delivery id is the prompt id, so a run host can replay a lost ack
// without writing the prompt twice. Receipt is recorded only after `ok`,
// through the same current-owner core message.receive uses; every failure
// records nothing, so the hook and resume routes still run.

import fs from "node:fs";
import net from "node:net";

import { renderNotification } from "../cli/arrival_notification.mjs";
import { isSafeSessionId, sessionPaths } from "../protocol/session_paths.mjs";
import { withTransaction } from "./db.mjs";
import { recordCurrentOwnerReceipt } from "./ops/message_receive_current_owner.mjs";
import { receiveOrderBy } from "./ops/message_shared.mjs";
import { asksNothingSql } from "./ops/delivery_admission.mjs";
import {
  endpointReadsInbox,
  publishSessionNotice,
} from "./ops/session_notice.mjs";
import { notificationContext } from "./ops/notification_context.mjs";

const REQUEST_TIMEOUT_MS = 5000;
const PUSH_RETRY_MS = 30_000;

export function inputSocketPath(stateRoot, sessionId) {
  return sessionPaths(stateRoot, sessionId).inputSocket;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists under another user; fail closed, as state_root.mjs does.
    return error.code === "EPERM";
  }
}

/**
 * True while the run host that wrote in.pid is alive and still owns the
 * in.sock inode it bound. Synchronous and socket-free, for the resumer tick;
 * a missing or unreadable record, a dead pid or a replaced socket is no live
 * run. shortcut: a host killed with SIGKILL whose pid is then reused reads as
 * live until that pid exits; upgrade to a process start identity if seen.
 */
export function liveRunHost(stateRoot, sessionId) {
  const { inputSocket, inputPid } = sessionPaths(stateRoot, sessionId);
  try {
    const { pid, ino } = JSON.parse(fs.readFileSync(inputPid, "utf8"));
    return fs.lstatSync(inputSocket).ino === ino && isPidAlive(pid);
  } catch {
    return false;
  }
}

function parseReply(line, id) {
  try {
    const reply = JSON.parse(line);
    if (reply?.ok === true && reply.id === id) return reply;
    return {
      ok: false,
      reason: typeof reply?.reason === "string" ? reply.reason : "error",
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Connect, send one line-JSON request, read one line-JSON reply. Never
 * rejects: a failure resolves `{ ok: false, reason }`, where reason is the
 * run host's own, `closed`, `timeout`, `error`, or the socket error code
 * (ENOENT, ECONNREFUSED, ...).
 */
export function sendRunInput(
  socketPath,
  request,
  { timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const socket = net.createConnection(socketPath, () =>
      socket.write(`${JSON.stringify(request)}\n`),
    );
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reply);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () =>
      finish({ ok: false, reason: "timeout" }),
    );
    socket.on("error", (error) =>
      finish({ ok: false, reason: error.code ?? "error" }),
    );
    socket.on("close", () => finish({ ok: false, reason: "closed" }));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) finish(parseReply(buffer.slice(0, end), request.id));
    });
  });
}

// A live, daemon/Helm-launched owner only (the token; launch_mode describes the
// SESSION, so an interactive session resumed headless still qualifies), and never while a resume launch is in
// flight (a claimed request): that launch's brief already names the mail.
function liveRunCandidates(db, stateRoot) {
  return db
    .prepare(
      `SELECT e.id, e.state, e.process_generation, e.provider_session_id, e.owner_epoch, e.owner_launch_token, e.created_by_app_id
       FROM endpoints e
      WHERE e.state IN ('busy', 'idle')
        AND e.owner_process_exited_at IS NULL AND e.owner_launch_token IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM resume_requests r WHERE r.endpoint_id = e.id AND r.state = 'claimed')
        AND EXISTS (
          SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
           WHERE d.endpoint_id = e.id AND d.state != 'failed' AND d.read_at IS NULL
             AND m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL
        )`,
    )
    .all()
    .filter(
      (endpoint) =>
        isSafeSessionId(endpoint.provider_session_id) &&
        fs.existsSync(inputSocketPath(stateRoot, endpoint.provider_session_id)),
    );
}

// All unread deliveries, not only user ones: receipt is oldest-first, so a
// user message cannot be receipted while an earlier one stays unread.
function unreadDeliveries(db, endpointId) {
  const rows = db
    .prepare(
      `SELECT d.id, d.message_id, d.takeover_decided_at, m.body, m.origin = 'inbound' AND m.origin_channel_route_id IS NOT NULL AS has_external_origin,
              ${asksNothingSql("d")} AS asks_nothing
       FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.endpoint_id = ? AND d.state != 'failed' AND d.read_at IS NULL
      ORDER BY ${receiveOrderBy("d")}`,
    )
    .all(endpointId);
  // Admission order (ac-jfv.217): closed work after what still asks something.
  return [
    ...rows.filter((row) => !row.asks_nothing),
    ...rows.filter((row) => row.asks_nothing),
  ];
}

// The hook's notification block, which carries the body for user-origin mail
// only (arrival_notification.mjs: quoted, capped, the arrival tag neutralized), so
// the run can answer the user without a receive call. Other mail (another
// agent's, say) stays behind the block's receive command: in a
// bypass-permissions run, a pushed body is user-role text. No body without the
// owning app's read_inbox grant (review v2).
function promptText(db, delivery, endpointId) {
  return renderNotification([
    {
      ...notificationContext(db, delivery.message_id, {
        deliveryId: delivery.id,
      }),
      message_id: delivery.message_id,
      has_external_origin: Boolean(delivery.has_external_origin),
      ...(endpointReadsInbox(db, endpointId) ? { body: delivery.body } : {}),
    },
  ]);
}

// Why a receipt was refused: the owner exited, the owner tuple moved, or this
// owner holds no current-owner receipt for it any more (a takeover, an earlier unread row).
const OWNER_COLUMNS = [
  "process_generation",
  "provider_session_id",
  "owner_epoch",
  "owner_launch_token",
];
function refusalReason(db, endpoint) {
  const now = db
    .prepare(
      `SELECT ${OWNER_COLUMNS.join(", ")}, owner_process_exited_at FROM endpoints WHERE id = ?`,
    )
    .get(endpoint.id);
  if (now?.owner_process_exited_at) return "owner_exited";
  const same =
    now && OWNER_COLUMNS.every((column) => now[column] === endpoint[column]);
  return same ? "not_receivable" : "owner_rotated";
}

function recordPushReceipt(context, push, delivery) {
  const { endpoint } = push;
  const input = {
    message_id: delivery.message_id,
    endpoint_id: endpoint.id,
    process_generation: endpoint.process_generation,
    provider_session_id: endpoint.provider_session_id,
    owner_epoch: endpoint.owner_epoch,
    owner_launch_token: endpoint.owner_launch_token,
  };
  let outcome = null;
  let reason = null;
  try {
    outcome = withTransaction(context.db, () =>
      recordCurrentOwnerReceipt(context.db, input, {
        appId: endpoint.created_by_app_id,
        openAdmission: true,
      }),
    );
  } catch (error) {
    if (error?.code !== "listener_conflict") throw error;
    reason = "read_conflict";
  }
  if (!outcome) {
    // The run saw it, but no receipt holds: the hooks may show it once more.
    push.notes.push([
      "warn",
      {
        event: "run_input.receipt_refused",
        params: {
          endpoint_id: endpoint.id,
          delivery_id: delivery.id,
          message_id: delivery.message_id,
        },
        result: { reason: reason ?? refusalReason(context.db, endpoint) },
        status: "refused",
      },
    ]);
    return false;
  }
  if (outcome.wake) {
    publishSessionNotice(context.db, {
      stateRoot: context.stateRoot,
      ...outcome.wake,
      wake: "next_unread",
      logger: context.logger,
    });
  }
  return true;
}

// A refusing socket is never unlinked here, by design: the binding host owns
// cleanup. The next run host for the session replaces a socket nobody answers
// only after its own probe, by the inode it probed (run_host_files.mjs); the
// daemon removing by path could delete a socket a new host just bound.
function fallBack(push, reason) {
  push.notes.push([
    "info",
    {
      event: "run_input.fallback",
      params: {
        endpoint_id: push.endpoint.id,
        session_id: push.endpoint.provider_session_id,
      },
      result: { reason },
      status: "fallback",
    },
  ]);
}

/** Pushes one delivery and receipts it; resolves null, or the reason the push stops here. */
async function pushDelivery(context, delivery, push) {
  const { endpoint } = push;
  // A takeover owns it, and receipt is oldest-first, so nothing behind it can be receipted either.
  if (delivery.takeover_decided_at) return "takeover_decided";
  const reply = await sendRunInput(
    push.socketPath,
    {
      op: "prompt",
      id: delivery.id,
      text: promptText(context.db, delivery, endpoint.id),
      deliver: push.deliver,
      owner_launch_token: endpoint.owner_launch_token,
    },
    { timeoutMs: push.timeoutMs },
  );
  if (!reply.ok) {
    fallBack(push, reply.reason);
    return reply.reason;
  }
  return recordPushReceipt(context, push, delivery) ? null : "receipt_refused";
}

// What a refused push waits for besides time: a new socket or a new owner.
function retryKey(socketPath, endpoint) {
  let ino = null;
  try {
    ino = fs.lstatSync(socketPath).ino;
  } catch {
    // gone: a later bind makes a new key
  }
  const { process_generation, owner_epoch, owner_launch_token } = endpoint;
  return JSON.stringify([
    ino,
    process_generation,
    owner_epoch,
    owner_launch_token,
  ]);
}

async function pushDeliveries(context, push) {
  let count = 0;
  for (const delivery of unreadDeliveries(context.db, push.endpoint.id)) {
    // Sequential on purpose: each receipt follows its own ok, in receive order.
    // eslint-disable-next-line no-await-in-loop
    const stopped = await pushDelivery(context, delivery, push);
    if (stopped) return { result: stopped, count };
    count += 1;
  }
  return { result: "ok", count };
}

/**
 * One endpoint's push. A refused one backs off: it is retried when the
 * socket inode or owner tuple changes, or after PUSH_RETRY_MS, and it logs
 * only when its reason changes, so a run that cannot take input costs no
 * per-tick spin or log lines.
 */
async function pushToRun(context, endpoint, { timeoutMs, nowMs }) {
  const started = Date.now();
  const backoff = (context.runInputBackoff ??= new Map());
  const socketPath = inputSocketPath(
    context.stateRoot,
    endpoint.provider_session_id,
  );
  const key = retryKey(socketPath, endpoint);
  const last = backoff.get(endpoint.id);
  if (last?.key === key && nowMs - last.atMs < PUSH_RETRY_MS) return;
  const deliver = endpoint.state === "busy" ? "steer" : "queue";
  const push = { endpoint, deliver, socketPath, timeoutMs, notes: [] };
  const { result, count } = await pushDeliveries(context, push);
  if (result === "ok") backoff.delete(endpoint.id);
  else backoff.set(endpoint.id, { key, reason: result, atMs: nowMs });
  if (last?.reason === result) return;
  for (const [level, entry] of push.notes) context.logger?.[level]?.(entry);
  context.logger?.info?.({
    event: "run_input.push",
    params: { endpoint_id: endpoint.id },
    result: { count, deliver, result, latency: Date.now() - started },
    status: result === "ok" ? "ok" : "fallback",
  });
}

/**
 * Push every unread delivery to each live non-interactive run that has
 * unread user mail and an in.sock. Socket I/O runs outside any transaction;
 * each receipt is its own transaction, in receive order. One endpoint's
 * failure is logged and never cuts the others short.
 */
export async function pushToLiveRuns(
  context,
  { timeoutMs = REQUEST_TIMEOUT_MS, nowMs = Date.now() } = {},
) {
  const endpoints = liveRunCandidates(context.db, context.stateRoot);
  // Each failure is logged when it happens; the pass settles only after every endpoint does.
  await Promise.allSettled(
    endpoints.map((endpoint) =>
      pushToRun(context, endpoint, { timeoutMs, nowMs }).catch((error) =>
        context.logger?.error?.({
          event: "run_input.push_failed",
          params: { endpoint_id: endpoint.id },
          status: "error",
          error: { message: error?.message, stack: error?.stack },
        }),
      ),
    ),
  );
}
