import { listTightbeamSessions } from "../../scheduling/src/lib/tightbeam_sessions.mjs";
import { WORKING_STATUS, setThreadStatus } from "./slack_api.mjs";
import {
  FINAL_SETTLE_MS,
  SETTLE_MS,
  clearWorking,
  keyOf,
  paramsOf,
  settleWorking,
} from "./slack_working.mjs";
import { withLookups } from "./slack_endpoint_lookup.mjs";
import {
  agedReason,
  launchState,
  logUnconfirmed,
  noticeDue,
  noticePosted,
  stillWaiting,
} from "./slack_working_notice.mjs";
import {
  listWorking,
  markWorkingChecked,
  touchWorking,
} from "./slack_working_store.mjs";

// Slack drops a status 2 minutes after the last message; the sweep runs every
// ~10 s, so 80 s keeps the longest gap under 100 s even with a slow tick.
export const REFRESH_MS = 80_000;
// shortcut: a flat 30 min cap on any wait, however the session fares; upgrade to
// a per-runtime limit if a legitimate first reply takes longer than that.
export const MAX_AGE_MS = 30 * 60_000;

// Calls each lane makes at once: 13 rows at 9 s a call fit one 35 s phase in 3 waves.
// shortcut: past ~18 due rows at 9 s a call, the rest wait a tick and can pass
// Slack's 2 min expiry; upgrade to draining across phases if one owner keeps that
// many threads waiting.
const SLACK_POOL = 6;
// The verdict lane gets this much of the 35 s daemon phase.
// shortcut: a real lookup takes ~0.4 s, so ~200 rows get a verdict per tick; at 8 s
// a lookup only ~12 do and the rest wait a tick. Upgrade (one batched delivery read)
// if lookups slow down or that many threads wait at once.
export const VERDICT_BUDGET_MS = 15_000;

const nowOf = (ctx) => (ctx.now ?? Date.now)();
const DELIVERY_DONE = {
  failed: "delivery_failed",
  expired: "delivery_expired",
};

// The deliveries a message stands at now, one per recipient: a failed one on a
// replaced endpoint stands as its replacement, so only chain ends count.
function currentDeliveries(deliveries) {
  const ids = new Set(deliveries.map((d) => d.delivery_id));
  return deliveries.filter((d) => !ids.has(d.replacement_delivery_id));
}

// A closed session is done. A dead one is done once it read the message, or when
// it died after the message was accepted (a failed wake); dead before that, it
// awaits a wake or replacement. An idle one is done once it read the message and
// went idle after it.
function sessionVerdict(session, delivery, acceptedAt) {
  const reached = Boolean(delivery.read_at || delivery.acknowledged_at);
  const after = (session.state_since ?? 0) > acceptedAt;
  const reasons = {
    closed: "session_closed",
    dead: (reached || after) && "session_died",
    idle: reached && after && "idle_without_reply",
  };
  return reasons[session.state] || null;
}

// Absent from a complete endpoint list: gone. A truncated list proves nothing.
const missingEndpoint = (sessions) =>
  sessions.truncated ? null : "endpoint_gone";

// No session row: a placeholder waits (or is closed), anything else is gone.
function absentVerdict(placeholder, sessions) {
  if (placeholder === undefined) return missingEndpoint(sessions);
  return placeholder === "closed" ? "session_closed" : null;
}

// Why one recipient is done with the message, else null. A placeholder (an
// endpoint no session adopted yet) waits: it is not gone, and only its delivery
// going terminal, a reply or the bound ends the wait; a closed one never will.
function recipientVerdict(delivery, sessions, acceptedAt) {
  const done = DELIVERY_DONE[delivery.state];
  if (done) return done;
  const session = sessions.rows.find(
    (s) => s.endpoint_id === delivery.endpoint_id,
  );
  if (session) return sessionVerdict(session, delivery, acceptedAt);
  return absentVerdict(
    sessions.placeholders?.get(delivery.endpoint_id),
    sessions,
  );
}

// The reason a message's recipients are all done with it without posting, else
// null: one live or pending recipient keeps the wait. deliveries: the message's
// endpoint deliveries; sessions: {rows, truncated} from the endpoint list, or
// null when it could not be read.
export function endpointVerdict({ deliveries, sessions, acceptedAt }) {
  const current = currentDeliveries(deliveries);
  if (!current.length || !sessions) return null;
  const verdicts = current.map((d) =>
    recipientVerdict(d, sessions, acceptedAt),
  );
  return verdicts.every(Boolean) ? verdicts[0] : null;
}

async function loadSessions(ctx) {
  const list =
    ctx.listSessions ??
    ((filters) =>
      listTightbeamSessions(filters, { env: ctx.env, hookApp: true }));
  const found = await list({ includeClosed: true, limit: 1000 });
  if (!found.ok) return null;
  const placeholders = (found.placeholders ?? []).map((p) => [
    p.endpoint_id,
    p.state,
  ]);
  return {
    rows: found.sessions,
    truncated: found.truncated,
    placeholders: new Map(placeholders),
  };
}

async function committedVerdict(ctx, row, sessions) {
  const listed = await ctx.channel.listSlackDeliveries(row.messageId);
  if (!listed.ok) {
    ctx.logger?.({
      event: "slack_working_delivery_lookup_failed",
      status: "warn",
      params: paramsOf(row),
      result: { code: listed.code, tightbeam_code: listed.tightbeam_code },
    });
    return { unknown: true };
  }
  const deliveries = listed.endpoint_deliveries;
  const list = await withLookups(ctx, deliveries, await sessions());
  return {
    reason: endpointVerdict({
      deliveries,
      sessions: list,
      acceptedAt: row.acceptedAt,
    }),
    ...launchState(currentDeliveries(deliveries), list),
  };
}

// A row with no message is a post not committed yet: the inbound drain still
// owns it (it commits or fails it within the launch deadline), so no verdict.
function rowVerdict(ctx, row, sessions) {
  return row.messageId ? committedVerdict(ctx, row, sessions) : {};
}

// Re-sets the status. A failure is logged and dropped; the next tick tries again.
async function refresh(ctx, row) {
  if (!stillWaiting(ctx, row)) return false;
  const status = {
    channel: row.channelId,
    thread_ts: row.threadTs,
    status: WORKING_STATUS,
  };
  try {
    await setThreadStatus(status, ctx);
    touchWorking(ctx.home, keyOf(row), nowOf(ctx));
    return true;
  } catch (error) {
    ctx.logger?.({
      event: "slack_working_refresh_failed",
      status: "warn",
      params: paramsOf(row),
      result: { slack_error: error.slackError ?? null },
    });
    return false;
  }
}

// One bad row never stops the rest: it counts as "failed" and is logged.
async function safely(ctx, row, step) {
  try {
    return await step();
  } catch (error) {
    ctx.logger?.({
      event: "slack_working_sweep_failed",
      status: "error",
      params: paramsOf(row),
      result: { message: error.message, stack: error.stack },
    });
    return "failed";
  }
}

// Runs one step per row, in order, up to `limit` rows at a time, and tallies the
// outcomes into counts. A phase abort stops taking rows.
const eachRow =
  (ctx, counts) =>
  async (rows, step, limit = 1) => {
    const queue = [...rows];
    const worker = async () => {
      for (let row; !ctx.signal?.aborted && (row = queue.shift()); ) {
        // eslint-disable-next-line no-await-in-loop -- each worker takes one row at a time.
        const outcome = await safely(ctx, row, () => step(row));
        if (outcome) counts[outcome] += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, queue.length) }, worker),
    );
  };

const refreshDue = (ctx) => async (row) =>
  nowOf(ctx) - row.lastSetAt >= REFRESH_MS && (await refresh(ctx, row))
    ? "refreshed"
    : null;

const settleDue = (ctx) => async (row) => {
  const age = nowOf(ctx) - row.clearedAt;
  const settled = row.lastSetAt >= row.clearedAt + SETTLE_MS;
  if (age >= FINAL_SETTLE_MS || (age >= SETTLE_MS && !settled))
    await settleWorking(ctx, row);
  return null;
};

// The age cap is local for a post not committed yet: no delivery to consult. A
// committed one is decided with its delivery (verdictStep), since a launch still
// starting outlives the cap.
const isAged = (ctx, row) =>
  !row.messageId && nowOf(ctx) - row.acceptedAt >= MAX_AGE_MS;

// One step for the Slack-only pool: re-clear a terminal row, clear an aged
// uncommitted one, or refresh a live one.
const poolStep = (ctx) => async (row) => {
  if (row.clearedAt) return settleDue(ctx)(row);
  if (isAged(ctx, row)) {
    const current = stillWaiting(ctx, row);
    if (current) await clearWorking(ctx, current, "age_cap");
    return current ? "cleared" : null;
  }
  return refreshDue(ctx)(row);
};

// A row's verdict lookup, skipped once the pass spent its budget.
function verdictStep(ctx) {
  const deadline = nowOf(ctx) + VERDICT_BUDGET_MS;
  // one endpoint list per sweep, read only when a row needs it
  let loaded;
  const sessions = () => (loaded ??= loadSessions(ctx));
  return async (row) => {
    if (nowOf(ctx) >= deadline) return null;
    markWorkingChecked(ctx.home, keyOf(row), nowOf(ctx));
    const state = await rowVerdict(ctx, row, sessions);
    const reason =
      state.reason ??
      agedReason(nowOf(ctx) - row.acceptedAt, state, MAX_AGE_MS);
    const current = reason && stillWaiting(ctx, row);
    if (!current) return null;
    const verdict = { ...state, reason };
    const notice = noticeDue(ctx, current, verdict);
    if (!(await noticePosted(ctx, current, { notice }))) return null;
    logUnconfirmed(ctx, current, verdict);
    // The notice awaited Slack: clear only if this message still waits.
    const fresh = stillWaiting(ctx, current);
    if (fresh) await clearWorking(ctx, fresh, reason);
    return fresh ? "cleared" : null;
  };
}

// One pass over the waiting threads, as two lanes that run at once so neither can
// starve the other inside the daemon's phase. The pool does the Slack-only work
// (age-cap clears, delayed re-clears, due refreshes oldest-set first) a few calls at
// a time; the verdict lane looks up sessions and deliveries as many at once,
// least-recently-checked first inside a time budget, so every row gets its turn.
export async function sweepWorking(ctx) {
  const rows = listWorking(ctx.home);
  const waiting = rows.filter((row) => !row.clearedAt);
  const counts = {
    waiting: waiting.length,
    cleared: 0,
    refreshed: 0,
    failed: 0,
  };
  const aged = waiting.filter((row) => isAged(ctx, row));
  const live = waiting.filter((row) => !isAged(ctx, row));
  const stale = [...live].sort((a, b) => a.lastCheckedAt - b.lastCheckedAt);
  const unset = [...live].sort((a, b) => a.lastSetAt - b.lastSetAt);
  const each = eachRow(ctx, counts);
  await Promise.all([
    each(
      [...aged, ...rows.filter((row) => row.clearedAt), ...unset],
      poolStep(ctx),
      SLACK_POOL,
    ),
    each(stale, verdictStep(ctx), SLACK_POOL),
  ]);
  if (counts.cleared || counts.refreshed || counts.failed)
    ctx.logger?.({
      event: "slack_working_swept",
      status: "ok",
      result: counts,
    });
  return Object.freeze({ ok: counts.failed === 0, ...counts });
}
