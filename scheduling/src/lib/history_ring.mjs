// In-memory ring buffer of recent history events per (scope_id, job_id).
// Populated on the write path (appendJobHistoryEvent) and consulted by
// historyForJob so the UI's 20–200-event queries never touch disk.
// On daemon restart the ring is empty; readers fall through to the
// tail-seek disk reader, which is still fast.

export const HISTORY_RING_SIZE = 200;
// Cap distinct (scope, job) keys so long-uptime daemons don't accumulate
// rings for deleted/paused/one-off jobs. Eviction is LRU on write.
export const HISTORY_RING_MAX_JOBS = 200;

const ringByKey = new Map();

function keyFor(scopeId, jobId) {
  return `${scopeId}::${jobId}`;
}

export function pushToHistoryRing(scopeId, jobId, event) {
  if (!scopeId || !jobId || !event) return;
  const k = keyFor(scopeId, jobId);
  let ring = ringByKey.get(k);
  if (ring) {
    // Move to tail to mark most-recently-written (Map keeps insertion order).
    ringByKey.delete(k);
  } else {
    if (ringByKey.size >= HISTORY_RING_MAX_JOBS) {
      const oldest = ringByKey.keys().next().value;
      if (oldest !== undefined) ringByKey.delete(oldest);
    }
    ring = [];
  }
  ring.push(event);
  if (ring.length > HISTORY_RING_SIZE) {
    ring.splice(0, ring.length - HISTORY_RING_SIZE);
  }
  ringByKey.set(k, ring);
}

export function historyFromRing(scopeId, jobId, limit = 20) {
  if (!scopeId || !jobId) return null;
  const ring = ringByKey.get(keyFor(scopeId, jobId));
  if (!ring) return null;
  return ring.slice(-limit);
}

// Test helper — not exported through index surfaces, but importable directly.
export function __resetHistoryRing() {
  ringByKey.clear();
}
