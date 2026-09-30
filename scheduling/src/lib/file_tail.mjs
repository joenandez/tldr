import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export function tailFile(path, maxLines = 25, maxBytes = 64 * 1024) {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    const start = Math.max(0, stat.size - maxBytes - 1);
    const buffer = Buffer.alloc(stat.size - start);
    const fd = openSync(path, "r");
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    let text = buffer.toString("utf8", 0, bytesRead);
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
    }
    return text.split("\n").slice(-maxLines).join("\n").trimEnd();
  } catch {
    return null;
  }
}
