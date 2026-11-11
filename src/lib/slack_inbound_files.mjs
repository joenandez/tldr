import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { FILE_MAX_BYTES, downloadFile } from "./slack_file_download.mjs";

// Files the owner attaches to a Slack message: download each with the bot
// token, save it under <home>/slack/files/<event id>/, and append a list to the
// message text. Text is never lost: a failed file becomes a line naming the cause.
// The list is rendered once per event and saved in .list.txt, so every retry of
// the send carries the same body (the send key is the same, and a changed body
// under one key is refused as a collision).

const MB = 1024 * 1024;
const REASONS = {
  missing_files_read_scope:
    "missing files:read scope: add it to the Slack app and reinstall",
  too_large: `file is over the ${FILE_MAX_BYTES / MB} MB cap`,
  network_error: "network error while downloading",
  request_timeout: "download timed out",
  aborted: "download stopped",
  not_connected: "Slack bot token is not connected",
  untrusted_file_url: "the download URL is not a Slack URL",
  html_page:
    "Slack answered with a web page instead of the file (if this repeats, check the files:read scope)",
  no_url:
    "Slack did not give a download URL (not processed yet, or shared from another workspace)",
};

const reasonFor = (code) =>
  REASONS[code] ??
  (/^http_\d+$/.test(code)
    ? `Slack answered HTTP ${code.slice(5)}`
    : `download failed (${code})`);

// A path segment from Slack's text: no separators, no leading dot, no control chars.
const safeSegment = (value, fallback) => {
  const clean = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 100);
  return clean || fallback;
};

const LIST = ".list.txt";

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function readList(dir) {
  try {
    const list = readFileSync(join(dir, LIST), "utf8");
    return list.startsWith("Attached files (") ? list : null;
  } catch {
    return null;
  }
}

// Written whole or not at all, so a reader never sees half a list.
function writeList(dir, list) {
  const tmp = join(dir, `${LIST}.tmp`);
  writeFileSync(tmp, list, { mode: 0o600 });
  renameSync(tmp, join(dir, LIST));
}

// Answers that need no request: Slack Connect files and files over the cap are
// refused; a file saved by an earlier attempt of this event (it is renamed in
// only when whole) is reused.
function earlyResult(file, dest) {
  if (!file.url) return { code: "no_url" };
  if (file.size > FILE_MAX_BYTES) return { code: "too_large" };
  const have = existsSync(dest) ? statSync(dest).size : null;
  const sizeKnown = typeof file.size === "number";
  const whole = have !== null && (!sizeKnown || have === file.size);
  return whole ? { bytes: have, reused: true } : null;
}

async function fetchBytes(ctx, file, dest) {
  const early = earlyResult(file, dest);
  if (early) return early;
  try {
    ensureDir(join(dest, ".."));
    const bytes = await downloadFile(file.url, dest, {
      home: ctx.home,
      credentials: ctx.credentials,
      fetchImpl: ctx.fetchImpl,
      signal: ctx.signal,
      allowHtml: /html/i.test(file.mimetype ?? ""),
    });
    return { bytes };
  } catch (error) {
    return { code: error.slackError ?? error.code ?? "download_error" };
  }
}

// What Slack says about the file; not the bytes, which differ between attempts.
function describe(file) {
  const facts = [
    file.mimetype,
    typeof file.size === "number" ? `${file.size} bytes` : null,
  ].filter(Boolean);
  return facts.length ? ` (${facts.join(", ")})` : "";
}

// One outcome per file, one log per outcome. Never throws.
async function fetchOne({ ctx, entry, file, label, dest }) {
  const started = Date.now();
  const got = await fetchBytes(ctx, file, dest);
  const saved = got.bytes !== undefined;
  ctx.logger?.({
    event: "slack_inbound_file",
    status: saved ? "ok" : "error",
    params: {
      channel: entry.channel,
      ts: entry.ts,
      file_id: file.id,
      mimetype: file.mimetype ?? null,
    },
    result: {
      saved,
      reused: Boolean(got.reused),
      bytes: got.bytes ?? null,
      code: got.code ?? null,
    },
    latency_ms: Date.now() - started,
  });
  return saved
    ? `- ${label}${describe(file)}: ${dest}`
    : `- ${label}: not downloaded, ${reasonFor(got.code)}`;
}

// One file at a time. The index in each saved name keeps names unique, however
// Slack names the files and whatever the file system does with case.
async function buildList({ ctx, entry, dir, files }) {
  const lines = [];
  for (const [i, file] of files.entries()) {
    if (ctx.signal?.aborted) return null;
    const label = safeSegment(file.name, `file-${i + 1}`);
    const dest = join(dir, `${i + 1}-${label}`);
    // eslint-disable-next-line no-await-in-loop
    lines.push(await fetchOne({ ctx, entry, file, label, dest }));
  }
  if (ctx.signal?.aborted) return null;
  return `Attached files (${files.length}):\n${lines.join("\n")}`;
}

// shortcut: if .list.txt cannot be saved, a retry may render a different body
// (idempotency_collision); acceptable for rare disk faults. A transient failure
// line is frozen per event by design: the list is rendered once.
function persist(ctx, dir, list) {
  try {
    ensureDir(dir);
    writeList(dir, list);
  } catch (error) {
    ctx.logger?.({
      event: "slack_inbound_file_list_not_saved",
      status: "error",
      result: { code: error.code ?? "error" },
    });
  }
}

// Returns the entry with the file list appended to its text, or null when the
// daemon phase was aborted mid-download (the lane then retries the message).
export async function withFiles(ctx, entry, eventId) {
  const files = Array.isArray(entry.files) ? entry.files : [];
  if (files.length === 0) return entry;
  const dir = join(ctx.home, "slack", "files", safeSegment(eventId, "event"));
  let list = readList(dir);
  if (list === null) {
    list = await buildList({ ctx, entry, dir, files });
    if (list === null) return null;
    persist(ctx, dir, list);
  }
  return { ...entry, text: entry.text ? `${entry.text}\n\n${list}` : list };
}
