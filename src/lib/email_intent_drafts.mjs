// Private, expiring email-intent drafts (plan Technical Approach 4). When a
// user asks for an email and no email route exists, the agent may retain the
// request here for a later, fresh review. A draft is the only new persisted
// product fact: an opaque id, timestamps, the requesting session, the action
// kind, and only the user-authored recipient/content or notification summary.
// Never secrets, provider receipts, or delivery claims.
//
// Lifecycle: pending -> committing -> (resolved: removed)
//            pending | committing with a dead claim -> (discarded: removed)
//            committing -> pending (first-attempt pre-commit refusal only)
// A committing claim stays exclusive while its claiming process runs, however
// long the commit takes. Once that process exits (or its PID now runs another
// process, told apart by start time) the next confirmer re-drives the same
// keyed commit.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { writeTextAtomic } from "./durable_file_io.mjs";
import {
  EmailIntentDraftError,
  refuseDraft as refuse,
  validateDraftInput,
} from "./email_intent_draft_input.mjs";
import {
  isSameProcessAlive,
  processStartEvidence,
} from "./process_liveness.mjs";

export const EMAIL_INTENT_DRAFT_DIRECTORY = "email-intents";
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const DRAFT_ID =
  /^ei-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DRAFT_FILE = /^(ei-[0-9a-f-]{36})\.json$/u;

export { EmailIntentDraftError, validateDraftInput };

export function emailIntentDraftDirectory(home) {
  return join(home, EMAIL_INTENT_DRAFT_DIRECTORY);
}

export function logDraftEvent(level, event, fields) {
  try {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
    );
  } catch {
    // Logging never changes a draft outcome.
  }
}

function assertDraftId(id) {
  if (typeof id !== "string" || !DRAFT_ID.test(id)) {
    refuse("DRAFT_ID_INVALID", "the draft id is not an email-intent draft id");
  }
  return id;
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    refuse(
      "DRAFT_STORE_UNAVAILABLE",
      `${directory} is not a private directory`,
    );
  }
  chmodSync(directory, 0o700);
}

export function createEmailIntentDraftStore({
  home,
  now = () => Date.now(),
  ttlMs = DRAFT_TTL_MS,
  pid = process.pid,
  // (pid, recordedStartTime) -> whether that same process is still running.
  isProcessAlive = isSameProcessAlive,
  readProcessStart = (claimPid) => processStartEvidence(claimPid).start_time,
  writeSyncFn = writeSync,
} = {}) {
  if (typeof home !== "string" || home.length === 0) {
    refuse("DRAFT_STORE_UNAVAILABLE", "the tldr agent home is not set");
  }
  const directory = emailIntentDraftDirectory(home);
  const pathFor = (id) => join(directory, `${assertDraftId(id)}.json`);
  const iso = (millis) => new Date(millis).toISOString();

  function write(record) {
    ensurePrivateDirectory(directory);
    writeTextAtomic(pathFor(record.id), `${JSON.stringify(record)}\n`, {
      durable: true,
      mode: 0o600,
      writeSyncFn,
    });
    return record;
  }

  function remove(id) {
    try {
      unlinkSync(pathFor(id));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  function readLive(id) {
    let record;
    try {
      record = JSON.parse(readFileSync(pathFor(id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      logDraftEvent("warn", "email_intent_draft.unreadable", {
        params: { draft_id: id },
        result: { code: error?.code ?? "DRAFT_MALFORMED" },
      });
      return null;
    }
    if (!(Date.parse(record?.expires_at) > now())) {
      remove(id);
      return null;
    }
    return record;
  }

  function claimIsLive(record) {
    return (
      record.state === "committing" &&
      isProcessAlive(record.claimed_by_pid, record.claimed_by_start ?? null)
    );
  }

  // One process at a time moves a draft between states. A lock left by a
  // process that died inside this short section is broken after LOCK_STALE_MS.
  function withLock(id, action) {
    const lockPath = `${pathFor(id)}.lock`;
    ensurePrivateDirectory(directory);
    let descriptor;
    for (let attempt = 0; descriptor === undefined; attempt += 1) {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (attempt > 0 || !lockIsStale(lockPath)) return { busy: true };
        logDraftEvent("warn", "email_intent_draft.stale_lock_broken", {
          params: { draft_id: id },
        });
        unlinkSync(lockPath);
      }
    }
    try {
      return { value: action() };
    } finally {
      closeSync(descriptor);
      unlinkSync(lockPath);
    }
  }

  function lockIsStale(lockPath) {
    try {
      return now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  function mutate(id, action) {
    const outcome = withLock(id, action);
    if (outcome.busy)
      refuse("DRAFT_IN_PROGRESS", "another confirmer holds this draft");
    return outcome.value;
  }

  function requireRecord(id) {
    const record = readLive(id);
    if (!record) refuse("DRAFT_NOT_FOUND", "no pending draft has this id");
    return record;
  }

  function list() {
    let names;
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return names
      .map((name) => DRAFT_FILE.exec(name)?.[1])
      .filter(Boolean)
      .map((id) => readLive(id))
      .filter(Boolean)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  return Object.freeze({
    directory,
    create(input) {
      const fields = validateDraftInput(input);
      const created = now();
      return write({
        id: `ei-${randomUUID()}`,
        created_at: iso(created),
        expires_at: iso(created + ttlMs),
        ...fields,
        state: "pending",
      });
    },
    get(id) {
      return readLive(assertDraftId(id));
    },
    list,
    pendingCount() {
      return list().length;
    },
    // commitCwd: the workspace a notification job targets; the first claim
    // records it so a retry from any directory checks that same workspace.
    claimCommitting(id, { commitCwd } = {}) {
      assertDraftId(id);
      const outcome = withLock(id, () => {
        const record = readLive(id);
        if (!record) return { claimed: false, reason: "not_found" };
        if (claimIsLive(record))
          return { claimed: false, reason: "in_progress" };
        const recovered = record.state === "committing";
        if (recovered) {
          logDraftEvent("warn", "email_intent_draft.claim_recovered", {
            params: { draft_id: id, action_kind: record.action_kind },
          });
        }
        const draft = write({
          ...record,
          state: "committing",
          claimed_at: iso(now()),
          claimed_by_pid: pid,
          claimed_by_start: readProcessStart(pid),
          ...(record.commit_cwd || commitCwd
            ? { commit_cwd: record.commit_cwd ?? commitCwd }
            : {}),
        });
        return { claimed: true, draft, ...(recovered ? { recovered } : {}) };
      });
      return outcome.busy
        ? { claimed: false, reason: "in_progress" }
        : outcome.value;
    },
    release(id) {
      return mutate(id, () => {
        const record = requireRecord(id);
        if (record.state !== "committing") {
          refuse(
            "DRAFT_NOT_COMMITTING",
            "only a committing draft can be released",
          );
        }
        // Nothing was committed, so the next confirm may target a new workspace.
        const { claimed_at: _at, claimed_by_pid: _pid, ...rest } = record;
        delete rest.claimed_by_start;
        delete rest.commit_cwd;
        return write({ ...rest, state: "pending" });
      });
    },
    resolve(id) {
      mutate(id, () => {
        const record = requireRecord(id);
        if (record.state !== "committing") {
          refuse(
            "DRAFT_NOT_COMMITTING",
            "a draft resolves only after its commit",
          );
        }
        remove(id);
      });
    },
    // Discard never commits, so a dead claim may be closed; the returned
    // record tells the caller an earlier attempt may have committed.
    discard(id) {
      return mutate(id, () => {
        const record = requireRecord(id);
        if (claimIsLive(record)) {
          refuse(
            "DRAFT_IN_PROGRESS",
            "this draft is being committed; confirm it again to finish",
          );
        }
        remove(id);
        return record;
      });
    },
  });
}
