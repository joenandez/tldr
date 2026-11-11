// One canned "limits are active" message per hold episode, sent as a past
// agent session through the tldr-agents send CLI. No model call.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./durable_file_io.mjs";

const DEFAULT_BIN = fileURLToPath(
  new URL("../../../bin/tldr-agents", import.meta.url),
);
const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" };
// Ambient ids would outrank the pinned one in resolveAgentIdentity's chain.
const AMBIENT_SESSION_VARS = [
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
];

function defaultLog(entry) {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

const SEND_TIMEOUT_MS = 10_000;
const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

function daySuffix(date, days) {
  if (days <= 0) return "";
  if (days === 1) return " tomorrow";
  const opts =
    days < 7 ? { weekday: "long" } : { month: "short", day: "numeric" };
  return ` ${date.toLocaleDateString("en-US", opts)}`;
}

// Local time; names the day when it is not today so "until 02:00" cannot mean the wrong 02:00.
function clock(until, now) {
  const date = new Date(until);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round(
    (startOfDay(date) - startOfDay(new Date(now))) / 86_400_000,
  );
  return `${time}${daySuffix(date, days)}`;
}

function plural(count) {
  return count === 1 ? "1 background run is" : `${count} background runs are`;
}

export function heldNoticeCopy({
  provider,
  reason,
  until,
  count,
  now = Date.now(),
}) {
  const name = PROVIDER_NAMES[provider] ?? provider;
  const waiting = plural(count);
  if (reason === "provider_outage") {
    return {
      subject: `${name} is not responding`,
      body: `${name} isn't responding. ${waiting} waiting and will retry until ${clock(until, now)}. If it's back sooner, tell me and I'll resume them now.`,
    };
  }
  // A limit with no known reset time must not show a time: it retries on backoff.
  const timed =
    until !== null &&
    until !== undefined &&
    Number.isFinite(new Date(until).getTime());
  const active = timed
    ? `Usage limits are active for ${name} until ${clock(until, now)}. ${waiting} waiting and will resume then.`
    : `Usage limits are active for ${name}. ${waiting} waiting and will retry automatically.`;
  return {
    subject: `Usage limits are active for ${name}`,
    body: `${active} If you add credits or switch accounts, tell me and I'll resume them now.`,
  };
}

// Entries: {tags, held, last_success: {session_id, runtime, at}|null}, one per
// job across scopes. Coordinator's latest success wins, else any held job's.
export function pickNoticeSender(jobsAcrossScopes) {
  const latest = (jobs) =>
    jobs
      .filter((job) => job.last_success?.session_id)
      .sort((a, b) =>
        String(b.last_success.at).localeCompare(a.last_success.at),
      )[0]?.last_success ?? null;
  const coordinator = latest(
    jobsAcrossScopes.filter((job) => job.tags?.includes("coordinator")),
  );
  const picked =
    coordinator ?? latest(jobsAcrossScopes.filter((job) => job.held));
  return picked
    ? { session_id: picked.session_id, runtime: picked.runtime }
    : null;
}

function runSend({ args, env, binPath, spawnImpl }) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawnImpl(binPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill?.("SIGKILL");
      resolve({ code: null, out, err, timedOut: true });
    }, SEND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (err += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: error.message, errno: error.code });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

// The CLI prints a JSON envelope; a named refusal carries error.code.
// Raw errno names (ENOENT, ECONNREFUSED: the messaging daemon's socket is gone) become one named code.
const isErrno = (name) => /^E[A-Z0-9]{3,}$/.test(name);
function envelopeCode(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.code ?? parsed?.errors?.[0]?.code ?? null;
  } catch {
    return null; // not JSON
  }
}
function refusalCode({ code, out, err, timedOut, errno }) {
  if (timedOut) return "send_timeout";
  const named = isErrno(String(errno))
    ? errno
    : (envelopeCode(out) ?? envelopeCode(err));
  if (named)
    return isErrno(String(named)) ? "messaging_unreachable" : String(named);
  return code === null ? "send_unavailable" : `send_exit_${code}`;
}

export async function sendHeldNotice(
  { provider, reason, until, count, sender, now, quietRefusal = null },
  {
    binPath = DEFAULT_BIN,
    env = process.env,
    spawnImpl = spawn,
    log = defaultLog,
  } = {},
) {
  const started = Date.now();
  const emit = (event, status, result) =>
    log({
      event,
      params: { provider, reason, count, runtime: sender?.runtime ?? null },
      result,
      status,
      latency: Date.now() - started,
    });
  if (!sender?.session_id || !sender?.runtime) {
    emit("held_notice.unavailable", "warn", { reason: "no_sender" });
    return { sent: false, reason: "no_sender" };
  }
  const { subject, body } = heldNoticeCopy({
    provider,
    reason,
    until,
    count,
    now,
  });
  const pinned = { ...env };
  for (const name of AMBIENT_SESSION_VARS) delete pinned[name];
  pinned.TIGHTBEAM_RUNTIME = sender.runtime;
  pinned.HELM_AGENT_SESSION_ID = sender.session_id;
  const args = [
    "messaging",
    "--json",
    "agent",
    "send",
    "--to",
    "user",
    "--subject",
    subject,
    "--reason",
    "Background runs are on hold",
    "--body",
    body,
  ];
  const result = await runSend({ args, env: pinned, binPath, spawnImpl });
  if (result.code === 0) {
    emit("held_notice.sent", "info", { sent: true });
    return { sent: true, reason: "sent" };
  }
  const code = refusalCode(result);
  // The caller passes the refusal it already logged this episode: log a refusal once, and again only when it changes.
  if (code !== quietRefusal)
    emit("held_notice.unavailable", "warn", { reason: code });
  return { sent: false, reason: code };
}

const noticeFile = (home) => join(home, "held-notice.json");

export function writeHeldNotices(home, episodes) {
  writeJsonAtomic(noticeFile(home), episodes);
}

// Corrupt content (parse error, not an object) is treated as empty and rewritten at once, so it is reported once;
// if the rewrite fails, null is returned (nothing sent) and onCorrupt gets the error.
// Cost: the episodes are lost, so an open episode may send its notice a second time.
// An errno read (EACCES, EPERM, EIO, EMFILE...) is not corruption: the file is left alone and null is returned,
// so the caller sends nothing rather than re-notifying an episode it cannot read.
const CORRUPT = Symbol("corrupt");

// {} when missing, null when unreadable (errno), CORRUPT on a parse error.
function parseNotices(home, onUnreadable) {
  let text;
  try {
    text = readFileSync(noticeFile(home), "utf8");
  } catch (error) {
    const missing = error?.code === "ENOENT";
    if (!missing) onUnreadable?.(error?.code ?? "error");
    return missing ? {} : null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return CORRUPT;
  }
}

export function readHeldNotices(home, onCorrupt, onUnreadable) {
  const parsed = parseNotices(home, onUnreadable);
  if (parsed === null) return null;
  const ok =
    parsed !== CORRUPT &&
    Boolean(parsed) &&
    typeof parsed === "object" &&
    !Array.isArray(parsed);
  if (ok) return parsed;
  let error = null;
  try {
    writeHeldNotices(home, {});
  } catch (writeError) {
    error = writeError;
  }
  onCorrupt?.(error);
  // Not rewritten: send nothing (like an unreadable file) rather than fail every tick.
  return error ? null : {};
}
