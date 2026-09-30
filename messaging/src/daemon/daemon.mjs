// Daemon lifecycle wiring: state root, exclusive lock, database + schema,
// operation table, UDS server, and structured logging. the architecture contract
// §2, §3; the state ownership contract "State root layout".

import fs from 'node:fs';

import { DAEMON_VERSION, PROTOCOL_VERSION } from '../protocol/envelope.mjs';
import { resolveStateRoot, ensureStateRoot, acquireDaemonLock } from './state_root.mjs';
import { openDatabase } from './db.mjs';
import { openSchema } from './schema.mjs';
import { createRuntimeSnapshot, loadPersistedRuntimeEntries } from './runtime_store.mjs';
import { buildOpTable } from './ops/index.mjs';
import { createServer } from './server.mjs';
import { createEventBus } from './event_bus.mjs';
import { startResumer, resolveResumerSettings } from './resumer.mjs';
import { startListenerReconciler } from './listener_reconciler.mjs';
import { resolveResumeStaleAfterMs } from './ops/message_shared.mjs';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Structured JSON-line logger. One line per lifecycle event or request
 * boundary: {event, ...fields}. Never logs payload contents or secrets —
 * callers are responsible for only passing safe, structural fields.
 */
export function createLogger({ level = 'info', stream } = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  function write(lvl, fields) {
    if (LOG_LEVELS[lvl] > threshold) return;
    if (!stream || !stream.writable) return;
    stream.write(JSON.stringify({ level: lvl, ts: new Date().toISOString(), ...fields }) + '\n');
  }
  return {
    debug: (fields) => write('debug', fields),
    info: (fields) => write('info', fields),
    warn: (fields) => write('warn', fields),
    error: (fields) => write('error', fields),
  };
}

/**
 * Starts the daemon against stateRoot: creates the root layout, acquires
 * the exclusive daemon lock (throws with err.code === 'DAEMON_LOCK_HELD'
 * if another live daemon already owns this root), opens the database and
 * schema v1, builds the operation table, and starts listening on the UDS
 * socket. Returns a handle with stop() for graceful shutdown.
 */
export async function startDaemon({
  stateRoot = resolveStateRoot(),
  logLevel = process.env.TIGHTBEAM_LOG_LEVEL || 'info',
  // A test-construction seam, not an operational mode. bin/tightbeam-daemon
  // never passes it, so a shipped daemon always runs the resume tick — the
  // resumer is required behavior and no environment value turns it off.
  // A fixture that registers a `claude-code` endpoint and sends it a
  // message would otherwise start a real `claude` process, so
  // test/conformance/helpers/daemon_process.mjs constructs its daemon with
  // `withResumer: false`.
  withResumer = true,
} = {}) {
  const paths = ensureStateRoot(stateRoot);
  const lock = acquireDaemonLock(stateRoot);

  const logStream = fs.createWriteStream(paths.log, { flags: 'a' });
  const logger = createLogger({ level: logLevel, stream: logStream });

  let db;
  let handle;
  let resumer;
  let listenerReconciler;
  try {
    db = openDatabase(paths.db);
    const schemaVersion = openSchema(db);

    // Runtime manifests are execution configuration: load and validate
    // every persisted file BEFORE the socket exists, so an invalid manifest
    // aborts startup (naming its path) instead of serving requests against
    // config the daemon cannot parse. The loaded snapshot is frozen and
    // becomes the initial `context.runtimeRegistry`; runtime.register swaps
    // whole new snapshots onto this reference in-process.
    const persistedEntries = loadPersistedRuntimeEntries({ runtimesDir: paths.runtimesDir });
    const runtimeRegistry = createRuntimeSnapshot({ stateRoot, runtimesDir: paths.runtimesDir, entries: persistedEntries });
    logger.info({
      event: 'runtime_registry_loaded',
      params: { manifest_count: persistedEntries.length },
      result: { runtime_count: runtimeRegistry.list().length },
      status: 'ok',
    });

    const context = {
      db,
      // The hook watermark path is derived from this (message_shared.mjs
      // refreshSessionWatermark, src/protocol/session_paths.mjs).
      stateRoot,
      adminNoncePath: paths.adminNonce,
      runtimesDir: paths.runtimesDir,
      runtimeRegistry,
      startedAt: Date.now(),
      daemonVersion: DAEMON_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion,
      eventBus: createEventBus(),
      logger,
      // Item 44: endpoints with a provider session and no activity inside
      // this window are never resume candidates (message_shared.mjs).
      resumeStaleAfterMs: resolveResumeStaleAfterMs(process.env),
    };

    const opTable = buildOpTable();
    handle = createServer({ opTable, context, logger });
    await handle.listen(paths.socket);

    // The resume tick (src/daemon/resumer.mjs): the daemon's own pass over
    // the durable resume-request queue, and the only place Tightbeam
    // starts a process. Not a scheduler — it plans nothing for a future
    // time, it asks whether the queue has anything in it now.
    // Listener recovery is always on: it closes socketless startup rows and
    // bounds missed live handoffs before the daemon starts serving work.
    listenerReconciler = startListenerReconciler(context);
    resumer = withResumer ? startResumer(context, { env: process.env }) : { settings: resolveResumerSettings(process.env), stop() {} };

    logger.info({
      event: 'daemon_started',
      pid: process.pid,
      state_root: stateRoot,
      // Differs from state_root only through a symlink, such as the
      // ~/.tightbeam compatibility link kept until item 36.
      state_root_realpath: fs.realpathSync(stateRoot),
      protocol_version: PROTOCOL_VERSION,
      schema_version: schemaVersion,
      resume_stale_after_days: context.resumeStaleAfterMs / (24 * 60 * 60 * 1000),
    });

    let stopping = null;
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        logger.info({ event: 'daemon_stopping' });
        await listenerReconciler.stop();
        resumer.stop();
        await handle.close();
        try {
          fs.unlinkSync(paths.socket);
        } catch (err) {
          if (err.code !== 'ENOENT') logger.warn({ event: 'socket_unlink_failed', message: err.message });
        }
        db.close();
        lock.release();
        logger.info({ event: 'daemon_stopped' });
        await new Promise((resolve) => logStream.end(resolve));
      })();
      return stopping;
    };

    return { stateRoot, paths, context, logger, resumer, listenerReconciler, stop };
  } catch (err) {
    // Startup failed after the lock was acquired: release everything we
    // opened so a retry (or the caller's own cleanup) is not blocked by a
    // lock this process no longer holds meaningfully.
    if (resumer) resumer.stop();
    if (listenerReconciler) await listenerReconciler.stop();
    if (handle) {
      try {
        await handle.close();
      } catch {
        // best-effort cleanup after an already-failed startup
      }
    }
    if (db) db.close();
    lock.release();
    logStream.end();
    throw err;
  }
}

/**
 * Wires SIGINT/SIGTERM to a graceful stop() + process.exit(0), and logs an
 * uncaughtException / unhandledRejection as a lifecycle error before
 * re-throwing. Kept separate from startDaemon so the daemon lifecycle
 * itself stays testable without touching process-global signal state.
 */
export function attachProcessLifecycle(daemon) {
  const shutdown = (signal) => {
    daemon.logger.info({ event: 'signal_received', signal });
    daemon
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        daemon.logger.error({ event: 'shutdown_failed', message: err.message });
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
