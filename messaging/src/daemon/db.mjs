// node:sqlite DatabaseSync wrapper: WAL mode, foreign keys on, busy
// timeout, and a transaction helper. the architecture contract §2.

import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Runs fn() inside a BEGIN IMMEDIATE / COMMIT transaction. Rolls back and
 * rethrows on any error. Returns fn()'s return value on success.
 */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = fn();
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('COMMIT');
  return result;
}
