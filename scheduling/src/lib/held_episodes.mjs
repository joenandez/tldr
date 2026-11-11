// Notice episodes (AC-8): one canned notice per provider:reason episode; an episode closes when no hold remains for its key.
import { readHeldNotices, writeHeldNotices } from "./held_notice.mjs";
import { knownReset } from "./held_state.mjs";

const RETRY_EVERY_MS = 5 * 60_000;
// Named refusals that will not clear by retrying within the episode.
const PERMANENT_REFUSALS = new Set([
  "session_unavailable",
  "exact_session_unavailable",
  "session_identity_mismatch",
  "report_identity_mismatch",
  "no_outbound_channels",
]);
const isPermanent = (reason) =>
  PERMANENT_REFUSALS.has(reason) || /retired/.test(reason);

// Outage copy says "will retry until <deadline>"; limit copy says "resume at <until>", only for a reset still ahead (fgp.58).
const noticeTime = (h) =>
  h.reason === "provider_outage" ? h.deadline : knownReset(h) ? h.until : null;

function groupHolds(holds) {
  const groups = new Map();
  for (const h of holds) {
    const key = `${h.provider}:${h.reason}`;
    const g = groups.get(key) ?? { ...h, count: 0, until: null, scopes: [] };
    g.count += 1;
    if (h.scope_id && !g.scopes.includes(h.scope_id)) g.scopes.push(h.scope_id);
    const when = noticeTime(h);
    if (Number.isFinite(when)) g.until = Math.max(g.until ?? 0, when);
    groups.set(key, g);
  }
  return groups;
}

const pending = (ep, now) =>
  !ep.notified_at &&
  !ep.unavailable &&
  now - (ep.last_attempt_at ?? -Infinity) >= RETRY_EVERY_MS;

// Records notified_at only after delivery; sendHeldNotice logs sent/unavailable itself.
async function attempt(ep, group, { send, pickSender, log, now, persist }) {
  const { provider, reason, until, count } = group;
  const sender = pickSender();
  ep.last_attempt_at = now;
  if (!sender) {
    // Logged once per episode; later ticks retry silently in case a coordinator run appears.
    if (ep.skipped !== "no_sender")
      log("held_notice.skipped", "warn", {
        provider,
        reason,
        why: "no_sender",
      });
    ep.skipped = "no_sender";
    return persist();
  }
  // a crash or timeout mid-send still waits out the retry interval; an unsaved record sends nothing
  if (!persist()) return false;
  try {
    const result = await send({
      provider,
      reason,
      until,
      count,
      sender,
      now,
      quietRefusal: ep.refusal,
    });
    if (result?.sent) ep.notified_at = now;
    else {
      ep.refusal = result?.reason;
      if (isPermanent(String(result?.reason))) ep.unavailable = result.reason;
    }
  } catch (error) {
    // Durable in the episode record, so a restarted daemon does not repeat it.
    if (ep.refusal !== "send_threw")
      log("held_notice.unavailable", "error", { provider, reason }, error);
    ep.refusal = "send_threw";
  }
  return persist();
}

// One log per distinct state problem until the file works again (the daemon ticks every second).
let stateProblem = null;
function noteState(log, problem) {
  if (problem === stateProblem) return;
  stateProblem = problem;
  if (problem)
    log(`held_notice.state_${problem.split(":")[0]}`, "warn", {
      code: problem.split(":")[1],
    });
}

// One sync_failed log per distinct problem until a sync completes (.50).
let syncProblem = null;
export async function syncNoticeEpisodes({ home, holds, now, ...hooks }) {
  try {
    const result = await syncEpisodes({ home, holds, now, ...hooks });
    syncProblem = null;
    return result;
  } catch (error) {
    const problem = `${error?.code ?? ""}:${error?.message ?? error}`;
    if (problem !== syncProblem)
      hooks.log("held_notice.sync_failed", "error", {}, error);
    syncProblem = problem;
    return { opened: 0, closed: 0 };
  }
}

// Never throws; false = not saved. Nothing is sent unless the episode record was saved first.
function saveEpisodes(home, episodes, log) {
  let saved = true;
  try {
    writeHeldNotices(home, episodes);
  } catch (error) {
    saved = false;
    noteState(log, `unwritable:${error?.code ?? "error"}`);
  }
  if (saved) noteState(log, null);
  return saved;
}

// An episode's holds are unknown while a scope it drew holds from cannot be read (.50); it stays open only then,
// so one permanently unreadable scope never freezes another scope's episodes (fgp.54). An episode
// recorded before scopes were tracked is unknown on any partial tick.
const frozen = (ep, failed) =>
  Array.isArray(ep.scopes)
    ? ep.scopes.some((s) => failed.has(s))
    : failed.size > 0;

// The scopes an episode has holds in now, plus any it had that cannot be read now. @returns true when changed
function trackScopes(ep, group, failed) {
  const next = [
    ...new Set([
      ...group.scopes,
      ...(ep.scopes ?? []).filter((s) => failed.has(s)),
    ]),
  ].sort();
  const changed = JSON.stringify(next) !== JSON.stringify(ep.scopes);
  ep.scopes = next;
  return changed;
}

// Close ended episodes and open new ones in place; returns the keys to send for.
function planEpisodes(episodes, groups, { now, failedScopes = [] }) {
  const failed = new Set(failedScopes);
  const closed = Object.keys(episodes).filter(
    (k) => !groups.has(k) && !frozen(episodes[k], failed),
  );
  const opened = [...groups.keys()].filter((k) => !(k in episodes));
  for (const key of closed) delete episodes[key];
  for (const key of opened) episodes[key] = { episode_started_at: now };
  const tracked = [...groups.keys()].filter((k) =>
    trackScopes(episodes[k], groups.get(k), failed),
  );
  const retry = [...groups.keys()].filter(
    (k) => !opened.includes(k) && pending(episodes[k], now),
  );
  return { closed, opened, retry, tracked };
}

async function syncEpisodes({ home, holds, now, failedScopes, ...hooks }) {
  const groups = groupHolds(holds);
  let problem = null;
  const episodes = readHeldNotices(
    home,
    (error) =>
      (problem = `corrupt:${error ? (error.code ?? "error") : "rewritten"}`),
    (code) => (problem = `unreadable:${code}`),
  );
  // A good read clears a read problem, never an unwritable one: only a save proves the file works again.
  noteState(
    hooks.log,
    problem ?? (stateProblem?.startsWith("unwritable") ? stateProblem : null),
  );
  // An unreadable file sends nothing: it may hold a notified episode.
  const plan =
    episodes && planEpisodes(episodes, groups, { now, failedScopes });
  const { closed = [], opened = [], retry = [], tracked = [] } = plan || {};
  const persist = () => saveEpisodes(home, episodes, hooks.log);
  const changed =
    closed.length + opened.length + retry.length + tracked.length > 0;
  if (!changed || !persist()) return { opened: 0, closed: 0 };
  for (const key of [...opened, ...retry]) {
    // eslint-disable-next-line no-await-in-loop -- one notice at a time
    await attempt(episodes[key], groups.get(key), { ...hooks, now, persist });
  }
  return { opened: opened.length, closed: closed.length };
}
