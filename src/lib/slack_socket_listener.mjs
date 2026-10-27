import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { connectionsOpen } from "./slack_api.mjs";
import { readSlackCredentials } from "./slack_credentials.mjs";
import { tldrAgentHomeFor } from "./store.mjs";

const SEEN_LIMIT = 5000;
const PARENT_CHECK_MS = 2000;
const PRIVATE_CHANNEL_TYPES = new Set(["group", "im"]);

export function slackInboxPath(home) {
  return join(home, "slack", "inbox.jsonl");
}

// Slack's wss ticket URL is a credential: never let it reach a log line.
const redact = (message) => String(message).replace(/wss?:\/\/\S+/gi, "[url]");

// The daemon spawns us with no IPC or stdin pipe, so a ppid change is the only
// signal that it died; ppid 1 also means it died while we were booting.
// Returns a stop function.
export function watchParent({
  getPpid = () => process.ppid,
  intervalMs = PARENT_CHECK_MS,
  onLost,
  log = () => {},
}) {
  const startPpid = getPpid();
  const timer = setInterval(() => {
    const ppid = getPpid();
    if (ppid === startPpid && ppid !== 1) return;
    clearInterval(timer);
    log({
      event: "slack_listener_parent_lost",
      status: "warn",
      params: { startPpid, ppid },
    });
    onLost();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

const isKeptSubtype = (subtype) => !subtype || subtype === "thread_broadcast";
const isPrivateChat = (event) => PRIVATE_CHANNEL_TYPES.has(event.channel_type);
const isOwnerHuman = (event, ownerUserId) =>
  Boolean(ownerUserId) && event.user === ownerUserId && !event.bot_id;

function keepable(envelope, ownerUserId) {
  const event = envelope.payload?.event;
  if (envelope.type !== "events_api" || event?.type !== "message") return false;
  return (
    isPrivateChat(event) &&
    isKeptSubtype(event.subtype) &&
    isOwnerHuman(event, ownerUserId)
  );
}

function readSeededIds(path) {
  if (!existsSync(path)) return [];
  const ids = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const id = JSON.parse(line).event_id;
      if (id) ids.push(id);
    } catch {
      // blank or torn line: ignore
    }
  }
  return ids;
}

function createSeen(path) {
  const set = new Set(readSeededIds(path).slice(-SEEN_LIMIT));
  return {
    has: (id) => set.has(id),
    add(id) {
      set.add(id);
      if (set.size > SEEN_LIMIT) set.delete(set.values().next().value);
    },
  };
}

function appendInbox(path, entry) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// Resolves after ms, or at once on abort.
const sleep = (ms, signal) => pause(ms, undefined, { signal }).catch(() => {});

// Durable dedupe after the inbox is drained is the inbound lane's job
// (it records processed event ids in the channel map).
function createHandler({ path, ownerUserId, counters }) {
  const seen = createSeen(path);
  return function handle(envelope) {
    if (!keepable(envelope, ownerUserId)) {
      counters.dropped += 1;
      return;
    }
    const { event_id: eventId, event } = envelope.payload;
    if (eventId && seen.has(eventId)) {
      counters.dropped += 1;
      return;
    }
    appendInbox(path, {
      event_id: eventId,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts ?? null,
      text: event.text,
      user: event.user,
    });
    if (eventId) seen.add(eventId);
    counters.kept += 1;
  };
}

// Resolves with "disconnect" | "closed" | "aborted" when this socket is done.
function runSession({ WebSocketImpl, url, handle, signal, onHello, log }) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (error) {
      log({
        event: "slack_socket_construct_failed",
        status: "error",
        result: { message: redact(error?.message) },
      });
      resolve("closed");
      return;
    }
    const finish = (reason) => {
      signal.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch (error) {
        log({
          event: "slack_socket_close_failed",
          status: "warn",
          result: { message: redact(error.message) },
        });
      }
      resolve(reason);
    };
    const onAbort = () => finish("aborted");
    const onMessage = (message) => {
      let envelope;
      try {
        envelope = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (envelope.type === "hello") onHello();
      if (envelope.type === "disconnect") {
        finish("disconnect");
        return;
      }
      try {
        handle(envelope);
      } catch (error) {
        // no ack: Slack redelivers
        log({
          event: "slack_append_failed",
          status: "error",
          result: { message: redact(error.message) },
        });
        return;
      }
      if (envelope.envelope_id) {
        ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }
    };
    signal.addEventListener("abort", onAbort);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", () => finish("closed"));
    ws.addEventListener("error", () => finish("closed"));
  });
}

export async function runSlackSocketListener({
  home,
  ownerUserId,
  openConnection = (abort) => connectionsOpen({ home, signal: abort }),
  WebSocketImpl = globalThis.WebSocket,
  signal = new AbortController().signal,
  logger,
  backoff = {},
}) {
  const log = (entry) => logger?.(entry);
  const initialMs = backoff.initialMs ?? 1000;
  const maxMs = backoff.maxMs ?? 30000;
  const counters = { kept: 0, dropped: 0 };
  const handle = createHandler({
    path: slackInboxPath(home),
    ownerUserId,
    counters,
  });
  let delay = initialMs;
  const wait = async (event, extra = {}) => {
    const ms = extra.retryAfterMs ?? delay;
    log({
      event,
      status: "info",
      params: { delayMs: ms },
      result: extra.result,
    });
    delay = Math.min(delay * 2, maxMs);
    await sleep(ms, signal);
  };
  const onHello = () => {
    delay = initialMs;
    log({ event: "slack_socket_hello", status: "info" });
  };

  while (!signal.aborted) {
    let url;
    try {
      // Abortable, so SIGTERM ends a stalled open instead of orphaning it.
      // eslint-disable-next-line no-await-in-loop -- one connection attempt at a time.
      url = await openConnection(signal);
    } catch (error) {
      const result = {
        slack_error: error.slackError,
        http_status: error.httpStatus,
        message: redact(error.message),
      };
      log({ event: "slack_socket_open_failed", status: "error", result });
      await wait("slack_socket_reconnect_scheduled", {
        retryAfterMs: error.retryAfterMs,
      });
      continue;
    }
    if (signal.aborted) break;
    log({ event: "slack_socket_connecting", status: "info" });
    // eslint-disable-next-line no-await-in-loop -- one session at a time; the next connect follows its end.
    const reason = await runSession({
      WebSocketImpl,
      url,
      handle,
      signal,
      onHello,
      log,
    });
    log({
      event: "slack_socket_ended",
      status: "info",
      result: { reason, ...counters },
    });
    if (reason === "closed") await wait("slack_socket_reconnect_scheduled");
  }
  log({
    event: "slack_socket_stopped",
    status: "info",
    result: { ...counters },
  });
}

async function main() {
  const home = tldrAgentHomeFor();
  const credentials = readSlackCredentials({ home });
  const out = (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`);
  if (!credentials?.ownerUserId) {
    out({ event: "slack_socket_not_ready", status: "error" });
    process.exit(2);
  }
  const controller = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"])
    process.on(sig, () => controller.abort());
  const stopWatching = watchParent({
    onLost: () => controller.abort(),
    log: out,
  });
  await runSlackSocketListener({
    home,
    ownerUserId: credentials.ownerUserId,
    signal: controller.signal,
    logger: out,
  });
  stopWatching();
  // Real Slack's close handshake holds the event loop ~10 s; exit now so a
  // restarted daemon's new listener never overlaps this socket.
  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ event: "slack_socket_crashed", status: "error", result: { message: redact(error.message) } })}\n`,
    );
    process.exit(1);
  });
}
