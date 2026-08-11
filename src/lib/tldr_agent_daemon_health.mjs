import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { URL } from "node:url";

import { helmHome } from "./store.mjs";
import {
  tldrAgentSourceIdentity,
  readTldrAgentRuntimeSchemaVersion,
  runtimeStoreIsHealthy,
} from "./tldr_agent_runtime_identity.mjs";

const RETRY_DECISIONS = new Set([
  "error",
  "live_write_failed",
  "resume_schedule_failed",
  "resume_schedule_threw",
]);

export function tldrAgentDaemonPollHealthPath(home = helmHome()) {
  return join(home, "service", "daemon-poll-health.json");
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function normalizedDecision(entry) {
  const raw = entry?.decision;
  if (raw && typeof raw === "object") {
    return {
      decision: raw.dispatch_decision || null,
      nextRetryAt: raw.dispatch_next_retry_at || null,
    };
  }
  return { decision: typeof raw === "string" ? raw : null, nextRetryAt: null };
}

export function summarizeTldrAgentDispatchHealth(results = []) {
  let pendingCount = 0;
  let decisionCount = 0;
  let retryPendingCount = 0;
  let deadLetteredCount = 0;
  let nextRetryAt = null;
  const deadLetterIds = [];
  for (const result of results) {
    pendingCount += Number(result?.pending_count) || 0;
    const decisions = Array.isArray(result?.decisions) ? result.decisions : [];
    decisionCount += decisions.length;
    for (const entry of decisions) {
      const normalized = normalizedDecision(entry);
      if (normalized.decision === "dead_lettered") {
        deadLetteredCount += 1;
        if (typeof entry?.message_id === "string") {
          deadLetterIds.push(entry.message_id);
        }
      }
      if (normalized.nextRetryAt || RETRY_DECISIONS.has(normalized.decision)) {
        retryPendingCount += 1;
      }
      if (
        normalized.nextRetryAt &&
        (!nextRetryAt || normalized.nextRetryAt < nextRetryAt)
      ) {
        nextRetryAt = normalized.nextRetryAt;
      }
    }
  }
  return {
    action: "dispatched",
    pending_count: pendingCount,
    decision_count: decisionCount,
    retry_pending_count: retryPendingCount,
    dead_lettered_count: deadLetteredCount,
    dead_letter_ids: deadLetterIds,
    next_retry_at: nextRetryAt,
  };
}

export function readTldrAgentDaemonPollHealth({ home = helmHome() } = {}) {
  return readJson(tldrAgentDaemonPollHealthPath(home), null);
}

export function writeTldrAgentDaemonPollHealth({
  home = helmHome(),
  poll,
  dispatcher,
  now,
} = {}) {
  const prior = readTldrAgentDaemonPollHealth({ home }) || {};
  const currentDispatcher =
    dispatcher?.action === "failed" ? null : dispatcher || null;
  const observedAt = now || new Date().toISOString();
  const observedMs = Date.parse(observedAt);
  const pollSucceeded = poll?.action === "polled";
  const priorNextRetryMs = prior.next_retry_at
    ? Date.parse(prior.next_retry_at)
    : NaN;
  const currentRetryCount = Number(currentDispatcher?.retry_pending_count) || 0;
  const retainFutureRetry =
    currentDispatcher &&
    currentRetryCount === 0 &&
    Number.isFinite(priorNextRetryMs) &&
    priorNextRetryMs > observedMs;
  const priorDeadLetterIds = Array.isArray(prior.dead_letter_ids)
    ? prior.dead_letter_ids
    : [];
  const currentDeadLetterIds = Array.isArray(currentDispatcher?.dead_letter_ids)
    ? currentDispatcher.dead_letter_ids.filter((id) => typeof id === "string")
    : [];
  const knownDeadLetterIds = new Set(priorDeadLetterIds);
  let newDeadLetterCount = 0;
  for (const id of currentDeadLetterIds) {
    if (knownDeadLetterIds.has(id)) continue;
    knownDeadLetterIds.add(id);
    newDeadLetterCount += 1;
  }
  const priorDeadLetterCount = Number(prior.dead_letter_count) || 0;
  const deadLetterCount =
    priorDeadLetterIds.length === 0 &&
    priorDeadLetterCount >= currentDeadLetterIds.length
      ? Math.max(
          priorDeadLetterCount,
          Number(currentDispatcher?.dead_lettered_count) || 0,
        )
      : priorDeadLetterCount + newDeadLetterCount;
  const record = {
    version: "1.0",
    observed_at: observedAt,
    last_successful_poll_at: pollSucceeded
      ? observedAt
      : prior.last_successful_poll_at || null,
    cursor_timestamp: pollSucceeded
      ? poll.last_seen_timestamp || prior.cursor_timestamp || null
      : prior.cursor_timestamp || null,
    last_poll_action: poll?.action || null,
    last_poll_error: poll?.action === "failed" ? poll.reason || "failed" : null,
    retry_pending_count: currentDispatcher
      ? retainFutureRetry
        ? Number(prior.retry_pending_count) || 0
        : currentRetryCount
      : Number(prior.retry_pending_count) || 0,
    next_retry_at: currentDispatcher
      ? currentDispatcher.next_retry_at ||
        (retainFutureRetry ? prior.next_retry_at : null)
      : prior.next_retry_at || null,
    dead_letter_count: deadLetterCount,
    dead_letter_ids: [...knownDeadLetterIds].slice(-500),
  };
  writeJsonAtomic(tldrAgentDaemonPollHealthPath(home), record);
  return record;
}

export function projectTldrAgentDaemonPollHealth({
  home = helmHome(),
  running,
  nowMs = Date.now(),
  pollIntervalSeconds = 15,
} = {}) {
  const record = readTldrAgentDaemonPollHealth({ home });
  const lastSuccessfulPollMs = record?.last_successful_poll_at
    ? Date.parse(record.last_successful_poll_at)
    : NaN;
  const lastSuccessfulPollAgeSeconds = Number.isFinite(lastSuccessfulPollMs)
    ? Math.max(0, Math.floor((nowMs - lastSuccessfulPollMs) / 1000))
    : null;
  const freshnessWindowSeconds = Math.max(
    60,
    Number(pollIntervalSeconds) * 4 + 10,
  );
  const healthy = Boolean(
    running &&
      lastSuccessfulPollAgeSeconds !== null &&
      lastSuccessfulPollAgeSeconds <= freshnessWindowSeconds,
  );
  return {
    running: Boolean(running),
    healthy,
    last_successful_poll_at: record?.last_successful_poll_at || null,
    last_successful_poll_age_seconds: lastSuccessfulPollAgeSeconds,
    freshness_window_seconds: freshnessWindowSeconds,
    retry_pending_count: Number(record?.retry_pending_count) || 0,
    next_retry_at: record?.next_retry_at || null,
    dead_letter_count: Number(record?.dead_letter_count) || 0,
  };
}

export function evaluateTldrAgentDaemonHealth({
  home = helmHome(),
  pid = process.pid,
  currentPid = process.pid,
  nowMs = Date.now(),
  pollIntervalSeconds = 15,
  canOpenSqlite = runtimeStoreIsHealthy,
  runtimeIdentity = tldrAgentSourceIdentity(),
  readSchemaVersion = readTldrAgentRuntimeSchemaVersion,
} = {}) {
  const polling = projectTldrAgentDaemonPollHealth({
    home,
    running: true,
    nowMs,
    pollIntervalSeconds,
  });
  const checks = {
    pid_current:
      Number.isInteger(Number(pid)) && Number(pid) === Number(currentPid),
    sqlite_open: canOpenSqlite(home),
    poll_fresh: polling.healthy,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    helm_home: home,
    pid: Number(pid),
    runtime: {
      ...runtimeIdentity,
      schema_version: readSchemaVersion(home),
    },
    checks,
    last_successful_poll_at: polling.last_successful_poll_at,
    last_successful_poll_age_seconds: polling.last_successful_poll_age_seconds,
    freshness_window_seconds: polling.freshness_window_seconds,
  };
}

function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(data)}\n`);
}

export async function runTldrAgentDaemonHealthServer({
  home = helmHome(),
  host = "127.0.0.1",
  port = 45173,
  unref = false,
  onListen = null,
  evaluateHealth = evaluateTldrAgentDaemonHealth,
  runtimeIdentity = tldrAgentSourceIdentity(),
} = {}) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", `http://${host}:${port}`)
      .pathname;
    if (request.method !== "GET") {
      json(response, 405, {
        error: { code: "method_not_allowed", message: "GET only" },
      });
      return;
    }
    if (pathname !== "/livez") {
      json(response, 404, {
        error: { code: "not_found", message: pathname },
      });
      return;
    }
    const health = evaluateHealth({
      home,
      pid: process.pid,
      runtimeIdentity,
    });
    json(response, health.ok ? 200 : 503, health);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort =
        address && typeof address === "object" ? address.port : port;
      onListen?.({
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        helm_home: home,
      });
      resolve();
    });
  });
  if (unref) server.unref();
  const address = server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : port;
  return {
    close: () => server.close(),
    url: `http://${host}:${actualPort}`,
    host,
    port: actualPort,
  };
}

export async function waitForTldrAgentHealth({
  daemon,
  observeDaemon = null,
  home,
  port,
  timeoutMs = 5_000,
  requirePollFresh = true,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  expectedRuntimeIdentity = null,
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const currentDaemon =
        typeof observeDaemon === "function"
          ? // eslint-disable-next-line no-await-in-loop -- launchd can publish PID after bootstrap returns.
            await observeDaemon()
          : daemon;
      const launchdPid = Number(currentDaemon?.pid);
      if (!Number.isInteger(launchdPid) || launchdPid <= 0) {
        // eslint-disable-next-line no-await-in-loop -- readiness probes are bounded and serialized.
        await delay(Math.min(100, Math.max(1, deadline - now())));
        continue;
      }
      const remaining = Math.max(1, deadline - now());
      // eslint-disable-next-line no-await-in-loop -- each probe observes one local health response.
      const response = await fetchImpl(`http://127.0.0.1:${port}/livez`, {
        signal: AbortSignal.timeout(Math.min(500, remaining)),
      });
      if (response.ok !== true && Number(response.status) !== 503) {
        // eslint-disable-next-line no-await-in-loop -- readiness probes are bounded and serialized.
        await delay(Math.min(100, Math.max(1, deadline - now())));
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- each bounded probe has one local JSON response.
      const body = await response.json();
      const runtimeMatches = expectedRuntimeIdentity
        ? [
            "package_version",
            "source_revision",
            "source_dirty",
            "schema_version",
          ].every(
            (key) => body?.runtime?.[key] === expectedRuntimeIdentity?.[key],
          )
        : true;
      if (
        typeof body?.ok === "boolean" &&
        (requirePollFresh === false || body.ok === true) &&
        body.helm_home === home &&
        Number(body.pid) === launchdPid &&
        body.checks?.pid_current === true &&
        body.checks?.sqlite_open === true &&
        (requirePollFresh === false || body.checks?.poll_fresh === true) &&
        runtimeMatches
      ) {
        return {
          ready: true,
          full_health: body.ok === true,
          pid: launchdPid,
          port,
          runtime: body.runtime ?? null,
        };
      }
    } catch {}
    // eslint-disable-next-line no-await-in-loop -- retries are intentionally serialized and bounded.
    await delay(Math.min(100, Math.max(1, deadline - now())));
  }
  return { ready: false, port };
}
