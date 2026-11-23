// A wedged app-server must not keep the host alive forever: the handshake (initialize and the thread
// open) gets this long (generous: a cold start loads the rollout), then the run is abandoned.
export const HANDSHAKE_MS = 120_000;

/** Resolves with `promise`'s value, or with `onTimeout()` if it is still pending after `ms`. */
export async function withHandshakeDeadline(
  promise,
  ms = HANDSHAKE_MS,
  onTimeout,
) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
