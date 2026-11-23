// A stalled stdout reader throttles the app-server instead of queueing its output here (review F2).
export function forwardLine(adapter, line) {
  if (adapter.stdout.write(`${line}\n`) || adapter.awaitingDrain) return;
  adapter.awaitingDrain = true;
  adapter.lines.pause();
  adapter.stdout.once("drain", () => {
    adapter.awaitingDrain = false;
    // The run host closes `lines` once the agent is gone; a resume after that throws.
    if (!adapter.closed) adapter.lines.resume();
  });
}
