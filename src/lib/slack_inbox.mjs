import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { readSlackCredentials } from "./slack_credentials.mjs";
import { slackInboxPath } from "./slack_socket_listener.mjs";

// The listener appends to inbox.jsonl; the inbound lane reads it behind a byte
// cursor and rotates it once fully drained.
const ROTATED = /^inbox\.jsonl\.(\d+)\.old$/u;

const cursorPath = (home) => join(home, "slack", "inbox.cursor");

function readCursor(home, size) {
  let cursor = 0;
  try {
    cursor = Number(readFileSync(cursorPath(home), "utf8")) || 0;
  } catch {
    // no cursor yet: start at the top
  }
  return cursor > size ? 0 : cursor;
}

export function writeCursor(home, cursor) {
  const temp = `${cursorPath(home)}.tmp`;
  writeFileSync(temp, String(cursor), { mode: 0o600 });
  renameSync(temp, cursorPath(home));
}

// Complete lines after the cursor, each with the byte offset just past it.
export function readPending(home) {
  const file = slackInboxPath(home);
  if (!existsSync(file)) return [];
  const cursor = readCursor(home, statSync(file).size);
  const buffer = readFileSync(file).subarray(cursor);
  const complete = buffer.subarray(0, buffer.lastIndexOf(10) + 1);
  const lines = [];
  let offset = cursor;
  for (const raw of complete.toString("utf8").split("\n").slice(0, -1)) {
    offset += Buffer.byteLength(raw) + 1;
    lines.push({ raw, end: offset });
  }
  return lines;
}

// Rotation never deletes in the same drain: the listener may have opened the
// old file just before the rename, so bytes past the recorded cursor are moved
// back into the live inbox on the next drain, when that append has long finished.
export function sweepRotated(ctx) {
  const dir = join(ctx.home, "slack");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const consumed = ROTATED.exec(name)?.[1];
    if (consumed === undefined) continue;
    const file = join(dir, name);
    const tail = readFileSync(file).subarray(Number(consumed));
    if (tail.length > 0) appendFileSync(slackInboxPath(ctx.home), tail);
    unlinkSync(file);
    ctx.logger?.({
      event: "slack_inbox_rotated_swept",
      status: "ok",
      result: { salvaged_bytes: tail.length },
    });
  }
}

export function rotateIfDrained(ctx) {
  const file = slackInboxPath(ctx.home);
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (size === 0 || readCursor(ctx.home, size) !== size) return;
  // cursor first: a crash after this only re-reads lines the dedupe skips
  writeCursor(ctx.home, 0);
  renameSync(file, `${file}.${size}.old`);
  ctx.logger?.({
    event: "slack_inbox_rotated",
    status: "ok",
    result: { bytes: size },
  });
}

export function parseEntry(raw) {
  try {
    const entry = JSON.parse(raw);
    return entry?.channel && entry?.ts ? entry : null;
  } catch {
    return null;
  }
}

export function resolveOwner({ ownerUserId, home }) {
  if (ownerUserId) return ownerUserId;
  try {
    return readSlackCredentials({ home })?.ownerUserId ?? null;
  } catch {
    return null;
  }
}
