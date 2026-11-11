// One user-visible post at a time per Slack thread: an agent's reply and a failure
// notice never interleave, and the "still waiting?" decision is made inside the turn.
// A lock, not a clock: it holds nothing between ticks and expires on nothing.
// shortcut: in this process only; a second daemon on the same home is not serialized.
// Upgrade to a DB lease if two daemons per home are ever supported.
const tails = new Map();

export async function withThreadLock({ home, channelId, threadTs }, fn) {
  const id = JSON.stringify([home, channelId, threadTs ?? null]);
  const run = (tails.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  tails.set(id, tail);
  try {
    return await run;
  } finally {
    if (tails.get(id) === tail) tails.delete(id);
  }
}
