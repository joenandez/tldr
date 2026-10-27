import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  acquireActionStoreLock,
  releaseActionStoreLock,
} from "./agent_action_lock.mjs";

function validStore(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  const envelopes = parsed.envelopes;
  if (!envelopes || typeof envelopes !== "object" || Array.isArray(envelopes))
    return false;
  return true;
}

export function readActionStore(session) {
  if (!session.agent_action_store_path) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(session.agent_action_store_path, "utf8"),
    );
    if (!validStore(parsed)) throw new Error("malformed action store");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { envelopes: {} };
    throw Object.assign(
      new Error(
        "the current session action identity store is unreadable; refusing to risk a duplicate send",
      ),
      { code: "action_identity_unavailable" },
    );
  }
}

export function writeActionStore(session, store) {
  if (!session.agent_action_store_path) return;
  const temporary = `${session.agent_action_store_path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(session.agent_action_store_path), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(temporary, session.agent_action_store_path);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* Preserve publication error. */
    }
    throw Object.assign(
      new Error(
        `could not persist the current action identity: ${error.message}`,
      ),
      { code: "action_identity_unavailable" },
    );
  }
}

export function mutateActionStore(session, update) {
  if (!session.agent_action_store_path) return undefined;
  const file = session.agent_action_store_path;
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let ownerToken;
  try {
    ownerToken = acquireActionStoreLock(lock);
  } catch (error) {
    if (error?.code !== "action_identity_unavailable") {
      throw Object.assign(
        new Error(
          `could not lock the current action identity: ${error.message}`,
        ),
        { code: "action_identity_unavailable" },
      );
    }
    throw error;
  }
  try {
    const store = readActionStore(session);
    const result = update(store);
    writeActionStore(session, store);
    return result;
  } finally {
    releaseActionStoreLock(lock, ownerToken);
  }
}
