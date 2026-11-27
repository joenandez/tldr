// node:sqlite DatabaseSync wrapper: WAL mode, foreign keys on, busy
// timeout, and a transaction helper. the architecture contract §2.

import { DatabaseSync } from 'node:sqlite';

// Run before COMMIT. ops/thread_owners.mjs registers its settle when the daemon graph loads, so this
// module stays a leaf: the CLI and hooks import it without pulling in the daemon.
let beforeCommit = null;
export function onBeforeCommit(hook) {
  beforeCommit = hook;
}

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

const afterCommitQueues = new WeakMap();

/**
 * Runs fn() inside a BEGIN IMMEDIATE / COMMIT transaction. Rolls back and
 * rethrows on any error. Returns fn()'s return value on success. Work queued
 * with afterCommit() runs, in order, only after COMMIT succeeds.
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  const committed = [];
  afterCommitQueues.set(db, committed);
  let result;
  try {
    result = fn();
    beforeCommit?.(db); // owners follow the work: settled once, after every write of this transaction
  } catch (err) {
    afterCommitQueues.delete(db);
    db.exec('ROLLBACK');
    throw err;
  }
  afterCommitQueues.delete(db);
  db.exec('COMMIT');
  for (const { fn: run, logger } of committed) {
    try {
      run();
    } catch (err) {
      // The commit already happened: one failed hook must not skip the rest or throw into the caller.
      const entry = { event: 'after_commit_failed', result: { error: err.message }, status: 'warn', stack: err.stack };
      if (logger?.warn) logger.warn(entry);
      else console.warn(JSON.stringify(entry));
    }
  }
  return result;
}

/**
 * Defers fn until the enclosing withTransaction commits; a rollback drops
 * it. Outside a transaction every write is already committed, so fn runs now.
 * fn must not throw: the commit it follows has already happened.
 */
export function afterCommit(db, fn, logger = null) {
  const queue = afterCommitQueues.get(db);
  if (queue) queue.push({ fn, logger });
  else fn();
}
