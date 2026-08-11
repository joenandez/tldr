import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { runtimeStorePath, withRuntimeStore } from "./runtime_store.mjs";
import { withFileMutex } from "./substrate/file_mutex.mjs";

const STOP_INDEX_READY = ".beacon-stop-index-v1.ready";
const STOP_INDEX_DIR = "beacon-pending.d";

function storeArgs(options) {
  const home = options?.home;
  return {
    home,
    path: options?.path ?? runtimeStorePath(home),
  };
}

function stopIndexRoot(options = {}) {
  return (
    options.sessionsRoot ??
    process.env.TLDR_AGENT_SESSIONS_ROOT ??
    join(options.home ?? dirname(storeArgs(options).path), "sessions")
  );
}

function stopIndexMarkerPath(input, options = {}) {
  return join(
    stopIndexRoot(options),
    input.sessionId,
    STOP_INDEX_DIR,
    `${encodeURIComponent(input.obligationId)}.pending`,
  );
}

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function writeBeaconPendingMarker(input, options) {
  const writer = options?.writePendingMarker;
  if (writer) {
    writer(input, options);
    return;
  }
  atomicWrite(stopIndexMarkerPath(input, options), "pending\n");
}

function removePendingMarker(input, options) {
  const remover = options?.removePendingMarker;
  if (remover) {
    remover(input, options);
    return;
  }
  rmSync(stopIndexMarkerPath(input, options), { force: true });
}

function stopIndexLockPath(options) {
  return join(
    dirname(storeArgs(options).path),
    "locks",
    "beacon-stop-index.lock",
  );
}

export function withBeaconStopIndexMutex(options, fn, onUnavailable = null) {
  try {
    return withFileMutex(stopIndexLockPath(options), fn, options?.mutexOptions);
  } catch (error) {
    const unavailable = new Set([
      "EACCES",
      "EMFILE",
      "ENFILE",
      "ENOENT",
      "ENOSPC",
      "EPERM",
      "EROFS",
    ]);
    if (
      onUnavailable &&
      (error?.name === "MutexTimeoutError" || unavailable.has(error?.code))
    ) {
      return onUnavailable(error);
    }
    throw error;
  }
}

export function safelyRemoveBeaconPendingMarker(input, options) {
  try {
    removePendingMarker(input, options);
  } catch {
    // A stale marker is a safe false positive and the slow preflight heals it.
  }
}

function indexedMarkerFiles(root) {
  const files = [];
  let sessions = [];
  try {
    sessions = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const markerDir = join(root, session.name, STOP_INDEX_DIR);
    let markers = [];
    try {
      markers = readdirSync(markerDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const marker of markers) {
      if (marker.isFile() && marker.name.endsWith(".pending")) {
        files.push(join(markerDir, marker.name));
      }
    }
  }
  return files;
}

export function reconcileBeaconStopIndex(options = {}) {
  return withBeaconStopIndexMutex(options, () => {
    const root = stopIndexRoot(options);
    const ready = join(root, STOP_INDEX_READY);
    mkdirSync(root, { recursive: true });
    rmSync(ready, { force: true });
    const pendingRows =
      options.pendingRows ??
      withRuntimeStore(storeArgs(options), (db) =>
        db
          .prepare(
            `SELECT owner_session_id, obligation_id
             FROM tldr_agent_beacon_obligations
             WHERE status = 'pending'
             ORDER BY owner_session_id, obligation_id`,
          )
          .all(),
      );
    const expected = new Set();
    const pendingSessionIds = new Set();
    for (const row of pendingRows) {
      const input = {
        sessionId: row.owner_session_id,
        obligationId: row.obligation_id,
      };
      const marker = stopIndexMarkerPath(input, options);
      writeBeaconPendingMarker(input, options);
      expected.add(marker);
      pendingSessionIds.add(row.owner_session_id);
    }
    for (const marker of indexedMarkerFiles(root)) {
      if (!expected.has(marker)) rmSync(marker, { force: true });
    }
    atomicWrite(ready, "ready\n");
    return {
      pendingSessionIds: [...pendingSessionIds].sort(),
      pendingCount: pendingRows.length,
    };
  });
}
