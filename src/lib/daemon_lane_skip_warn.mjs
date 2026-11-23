// The email notice and answer lanes skip a tick when no inbox target resolves. That is normal
// for an install with no email, but a wiring bug skipped every tick silently once (r5). So the
// first such skip of a lane is a warn, once per lane, never per tick (ac-jfv.74.1).
const TARGET_SKIPS = new Set([
  "email_not_configured",
  "no_registered_scopes",
  "missing_inbox_key",
]);

// `record(status, extra)` writes the lane's own activity event.
export function createSkipWarner({ lane, record }) {
  let warned = false;
  return (skip) => {
    if (warned || !TARGET_SKIPS.has(skip?.reason)) return;
    warned = true;
    process.stderr.write(
      `tldr daemon email ${lane} lane tick skipped: ${skip.reason}\n`,
    );
    record("warn", { metadata: { reason: skip.reason } });
  };
}
