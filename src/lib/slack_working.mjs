import { WORKING_STATUS, setThreadStatus } from "./slack_api.mjs";
import {
  deleteWorking,
  lookupWorking,
  markWorkingCleared,
  touchWorking,
} from "./slack_working_store.mjs";

// The exact message a decision is about: store writes match on all three.
export const keyOf = (row) => ({
  channelId: row.channelId,
  threadTs: row.threadTs,
  ts: row.ts,
});
export const paramsOf = (row) => ({
  channel: row.channelId,
  thread_ts: row.threadTs,
});

// Slack's request timeout is 10 s: past this a show still in flight from the listener
// process has landed or failed, so one more clear undoes it.
export const SETTLE_MS = 15_000;
// shortcut: a status Slack applies longer than 120 s after the clear would stick; upgrade if that is ever seen.
export const FINAL_SETTLE_MS = 120_000;

// The empty status of a clear. A failure is logged and dropped (Slack's own
// timeout clears it).
async function sendClear(opts, row, reason) {
  try {
    await setThreadStatus(
      { channel: row.channelId, thread_ts: row.threadTs, status: "" },
      opts,
    );
  } catch (error) {
    opts.logger?.({
      event: "slack_working_clear_failed",
      status: "warn",
      params: { ...paramsOf(row), step: "status", reason },
      result: { slack_error: error.slackError ?? null },
    });
  }
}

// Marks the row terminal (the sweep never refreshes it) and clears Slack. The row
// stays until settleWorking: a listener show that lands after this clear is undone then.
export async function clearWorking(opts, row, reason) {
  const now = (opts.now ?? Date.now)();
  // A newer message took the row (or it is gone): this decision is stale.
  if (!markWorkingCleared(opts.home, keyOf(row), now)) return;
  await sendClear(opts, row, reason);
  await restoreNewer(opts, row);
  opts.logger?.({
    event: "slack_working_cleared",
    status: "ok",
    params: { ...paramsOf(row), reason },
    result: { age_ms: now - row.acceptedAt },
  });
}

// The old clear's empty status may have landed after a newer message in this thread
// set its own: set it again at once rather than leave it blank until the next sweep.
async function restoreNewer(opts, row) {
  const current = lookupWorking(opts.home, keyOf(row));
  if (!current || current.ts === row.ts || current.clearedAt) return false;
  await setThreadStatus(
    { ...paramsOf(row), status: WORKING_STATUS },
    opts,
  ).catch((error) =>
    opts.logger?.({
      event: "slack_working_refresh_failed",
      status: "warn",
      params: paramsOf(row),
      result: { slack_error: error.slackError ?? null },
    }),
  );
  return true;
}

// Clears Slack again for a row that is still this terminal one; false if it is not
// (inbound may track a newer message in this thread while the clear is in flight:
// that row is live and never touched here).
async function reclear(opts, row, reason) {
  const terminal = () => {
    const current = lookupWorking(opts.home, keyOf(row));
    return current?.ts === row.ts && current.clearedAt > 0;
  };
  if (!terminal()) return false;
  await sendClear(opts, row, reason);
  return !(await restoreNewer(opts, row)) && terminal();
}

// A delayed re-clear of a terminal row: the first at SETTLE_MS, the last at
// FINAL_SETTLE_MS (then the row is forgotten). A row's last_set_at is free once it
// is terminal, so the first settle records itself there. Returns whether the row is gone.
export async function settleWorking(opts, row) {
  const now = (opts.now ?? Date.now)();
  const final = now - row.clearedAt >= FINAL_SETTLE_MS;
  if (!(await reclear(opts, row, final ? "settle_final" : "settle")))
    return false;
  if (!final) {
    touchWorking(opts.home, keyOf(row), now);
    return false;
  }
  deleteWorking(opts.home, keyOf(row));
  opts.logger?.({
    event: "slack_working_settled",
    status: "ok",
    params: paramsOf(row),
  });
  return true;
}

// The first post into a thread landed: clear its indicator if it has one. Never
// throws, so it can sit on the post path.
// key.postedTs, when given, is the Slack ts of the post being replayed: a row for an owner
// message newer than that post is not answered by it and is left alone.
export async function clearThreadWorking(opts, key, reason) {
  const { postedTs } = key;
  try {
    const row = lookupWorking(opts.home, key);
    const newer = postedTs !== undefined && Number(row?.ts) > Number(postedTs);
    if (row && !row.clearedAt && !newer) await clearWorking(opts, row, reason);
  } catch (error) {
    opts.logger?.({
      event: "slack_working_clear_crashed",
      status: "error",
      params: { channel: key.channelId, thread_ts: key.threadTs, reason },
      result: { message: error.message, stack: error.stack },
    });
  }
}
