import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function readHookSettings(file) {
  if (!existsSync(file)) return { exists: false, raw: null, value: {} };
  const raw = readFileSync(file, "utf8");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not a JSON object");
    }
    return { exists: true, raw, value };
  } catch (error) {
    throw new Error(`failed to parse ${file}: ${error.message}`);
  }
}

export function serializeHookSettings(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function atomicWriteHookSettings(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, contents, "utf8");
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
