// One Tightbeam request as an app, in this process: connect to the daemon socket, handshake with
// the app credentials, send one op. The CLI path (libexec/tightbeam -> component-dispatch) hashes
// the 52 MB runtime and runs plutil before Node on every call: 0.2 s typical, seconds at load
// (ac-wzn7q). Socket I/O is async, so the daemon's main thread stays free (ac-srg29).
// The result has the CLI's --json envelope, so callers read it the same way.
import { connect } from "../../messaging/src/client/client.mjs";
import { resolveStateRoot } from "../../messaging/src/protocol/state_root_location.mjs";
import { daemonNotRunning } from "./tightbeam_channel_runtime.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

const isConnectError = (error) =>
  ["ENOENT", "ECONNREFUSED"].includes(error?.code) &&
  error?.syscall === "connect";

function envelopeOf(error) {
  if (isConnectError(error)) return daemonNotRunning();
  return {
    ok: false,
    data: null,
    error: {
      code:
        typeof error?.code === "string"
          ? error.code
          : "TIGHTBEAM_OPERATION_FAILED",
      message: String(error?.message ?? error),
    },
  };
}

function timeoutError(op, timeoutMs) {
  return Object.assign(
    new Error(`Tightbeam ${op} did not answer within ${timeoutMs} ms`),
    { code: "TIGHTBEAM_REQUEST_TIMEOUT" },
  );
}

export async function requestAsApp({
  identity,
  op,
  payload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stateRoot = resolveStateRoot(),
  connectImpl = connect,
}) {
  let client = null;
  let timer;
  let expired = false;
  const call = (async () => {
    client = await connectImpl(stateRoot);
    if (expired) throw timeoutError(op, timeoutMs); // connected after the deadline: start nothing
    await client.handshake({
      appId: identity.app_id,
      credential: { kind: "app", app_secret: identity.app_secret },
    });
    return client.request(op, payload);
  })();
  // Clean up when the call itself settles, so a connect that lands after the deadline is cleaned
  // up too: destroyed, since past the deadline the daemon may never end its side.
  call
    .finally(() => (expired ? client?.destroy() : client?.close()))
    .catch(() => {});
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      // A hung daemon never answers, so `call` may never settle: drop the socket now.
      client?.destroy();
      reject(timeoutError(op, timeoutMs));
    }, timeoutMs);
  });
  try {
    return {
      ok: true,
      data: null,
      result: await Promise.race([call, deadline]),
    };
  } catch (error) {
    return envelopeOf(error);
  } finally {
    clearTimeout(timer);
  }
}
