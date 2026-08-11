#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markRead } from "../../src/lib/substrate/blocked_unread.mjs";

export function markReplyPresented({
  sessionId,
  messageId,
  via = "reply_prompt_injected",
  markReadMessage = markRead,
} = {}) {
  if (!sessionId || !messageId) return { ok: false, error: "missing_required" };
  try {
    return markReadMessage({ sessionId, messageId, via });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export function markReplyRowsPresented({
  sessionId,
  jsonlPath,
  via = "reply_prompt_injected",
  markReadMessage = markRead,
} = {}) {
  let rows;
  try {
    rows = readFileSync(jsonlPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
  for (const row of rows) {
    const result = markReplyPresented({
      sessionId,
      messageId: row?.message_id,
      via,
      markReadMessage,
    });
    if (!result.ok) return result;
  }
  return { ok: true, presented: rows.length };
}

const isMain = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false;

if (isMain) {
  const result = markReplyRowsPresented({
    sessionId: process.argv[2],
    jsonlPath: process.argv[3],
    via: process.argv[4] || "post_tool_use_inject",
  });
  if (!result.ok) {
    process.stderr.write(`${result.error || "mark_presented_failed"}\n`);
    process.exitCode = 1;
  }
}
