// ac-kf9rt R4: an armed record's body_shown only ever turns on. Split from
// ack_gate.mjs (its complexity limit); layout and rules: the ack_gate.mjs header.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * When `bodyShown`, sets `body_shown` on armed/<id> by an atomic rename that keeps the armed
 * time, so the refusal budget counted from it holds. A record already gone is
 * left gone; the caller's closed() re-check undoes a raced escape or reply.
 */
export function markBodyShown(file, bodyShown) {
  if (!bodyShown) return;
  let stamp;
  try {
    const [first, flag] = fs.readFileSync(file, "utf8").trim().split("\n");
    if (flag === "body_shown") return;
    stamp = first;
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const temporary = path.join(
    path.dirname(file),
    `.${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  fs.writeFileSync(temporary, `${stamp}\nbody_shown\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, file);
}
