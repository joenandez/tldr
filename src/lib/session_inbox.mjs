import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sessionDir } from "./identity_state.mjs";

export function enqueueInboxEntry(sessionId, entry) {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "inbox.jsonl");
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const prior = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (entry?.message_id) {
    for (const line of prior.split("\n")) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).message_id === entry.message_id) {
          return { appended: false, reason: "duplicate_message_id" };
        }
      } catch {
        // Preserve malformed content and append the valid new row.
      }
    }
  }
  writeFileSync(tmp, prior + JSON.stringify(entry) + "\n", "utf8");
  renameSync(tmp, file);
  return { appended: true };
}
