import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch as fsWatch,
} from "node:fs";
import { URL } from "node:url";
import { helmHome, resolveScope } from "./store.mjs";
import { listRegisteredScopes } from "./scopes.mjs";
import {
  getJob,
  globalServerEvents,
  historyForJob,
  jobStatusPayload,
  listJobs,
  registeredWorkspaceSummaries,
  resolveRunForLogs,
} from "./observability_service.mjs";
import { loadPublicEvents, publicEventsPath } from "./read_store.mjs";
import { serviceStatus } from "./service.mjs";
import { appendPerfEvent } from "./resource_sampler_light.mjs";
import { writeStatusServerLiveDeltaCheckpoint as liveDeltaCheckpoint } from "./daemon_live_attribution.mjs";
import { renderSchedulerTasksUi } from "./scheduler_tasks_ui.mjs";
import { handleSchedulerTasksApiRoute } from "./scheduler_tasks_http.mjs";

function nowIso() {
  return new Date().toISOString();
}

function shouldSampleHealthProbe(durationMs) {
  return process.env.HELM_STATUS_HEALTH_SAMPLE_ALL === "1" || durationMs > 750;
}

function appendHealthProbeSample(sample) {
  try {
    appendPerfEvent({
      event: "status_health_probe_sample",
      type: "status_health_probe_sample",
      classification: "helm_control_plane",
      ...sample,
    });
  } catch (err) {
    process.stderr.write(
      `helm status health perf sample failed: ${err.message}\n`,
    );
  }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(data)}\n`);
}

function html(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function parseOffsetOrNull(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function sendLogRange(res, path, { offset, length }) {
  const total = statSync(path).size;
  const clampedOffset = Math.max(0, Math.min(offset ?? 0, total));
  const available = total - clampedOffset;
  const clampedLength =
    length === null || length === undefined
      ? available
      : Math.max(0, Math.min(length, available));
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Helm-Log-Path": path,
    "X-Helm-Log-Total-Bytes": String(total),
    "X-Helm-Log-Offset": String(clampedOffset),
    "X-Helm-Log-Length": String(clampedLength),
  };
  res.writeHead(200, headers);
  if (clampedLength === 0) {
    res.end("");
    return;
  }
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(clampedLength);
    readSync(fd, buf, 0, clampedLength, clampedOffset);
    res.end(buf);
  } finally {
    closeSync(fd);
  }
}

function parseLimit(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function scopeRecordById(scopeId) {
  return (
    listRegisteredScopes().find((entry) => entry.scope_id === scopeId) || null
  );
}

const cache = new Map(); // key -> { value, exp }
const inFlight = new Map(); // key -> Promise<value>
function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.value;
  const pending = inFlight.get(key);
  if (pending) return pending;
  let result;
  try {
    result = loader();
  } catch (err) {
    throw err;
  }
  if (result && typeof result.then === "function") {
    const p = Promise.resolve(result)
      .then((v) => {
        cache.set(key, { value: v, exp: Date.now() + ttlMs });
        inFlight.delete(key);
        return v;
      })
      .catch((err) => {
        inFlight.delete(key);
        throw err;
      });
    inFlight.set(key, p);
    return p;
  }
  cache.set(key, { value: result, exp: now + ttlMs });
  return result;
}
function invalidateCache(prefix) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

function invalidateForEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  invalidateCache("workspaces");
  invalidateCache("jobs-all");
  const scopeId = ev.scope_id;
  const jobId = ev.job_id;
  if (scopeId) {
    invalidateCache(`jobs:${scopeId}`);
    if (jobId) {
      invalidateCache(`job:${scopeId}:${jobId}`);
      invalidateCache(`history:${scopeId}:${jobId}`);
    } else {
      invalidateCache(`job:${scopeId}:`);
      invalidateCache(`history:${scopeId}:`);
    }
  }
}

const sseSubscribers = new Set();

function broadcastSse(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const sub of sseSubscribers) {
    try {
      sub.write(frame);
    } catch {
      /* ignore; cleanup runs on 'close' */
    }
  }
}

let tailerStarted = false;
let tailerOffset = 0;
let tailerBuf = "";
let tailerInFlight = false;
let tailerPending = false;
let tailerOverlapSkips = 0;
let tailerLastMetricAt = 0;

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const TAILER_MAX_READ_BYTES = positiveNumberEnv(
  "HELM_STATUS_TAILER_MAX_READ_BYTES",
  256 * 1024,
);
const TAILER_METRIC_INTERVAL_MS = positiveNumberEnv(
  "HELM_STATUS_TAILER_METRIC_INTERVAL_MS",
  60_000,
);

function logTailerMetric(metric) {
  const now = Date.now();
  const shouldLog =
    metric.capped ||
    metric.overlap_skips > 0 ||
    (metric.parsed_lines > 0 &&
      now - tailerLastMetricAt >= TAILER_METRIC_INTERVAL_MS);
  if (!shouldLog) return;
  tailerLastMetricAt = now;
  try {
    process.stderr.write(
      `${JSON.stringify({
        ts: nowIso(),
        level: "debug",
        event: "daemon_status_tailer",
        ...metric,
      })}\n`,
    );
  } catch {
    /* stderr best-effort only */
  }
}

function startTailerOnce() {
  if (tailerStarted) return;
  tailerStarted = true;
  const path = publicEventsPath();
  try {
    tailerOffset = existsSync(path) ? statSync(path).size : 0;
  } catch {
    tailerOffset = 0;
  }

  const tick = () => {
    if (tailerInFlight) {
      tailerPending = true;
      tailerOverlapSkips += 1;
      logTailerMetric({
        reason: "overlap_skip",
        to_read_bytes: 0,
        read_bytes: 0,
        parsed_lines: 0,
        subscriber_count: sseSubscribers.size,
        overlap_skips: tailerOverlapSkips,
        capped: false,
      });
      return;
    }
    tailerInFlight = true;
    let parsedLines = 0;
    let toRead = 0;
    let readBytes = 0;
    let capped = false;
    try {
      if (!existsSync(path)) return;
      const size = statSync(path).size;
      if (size < tailerOffset) {
        // File was truncated / rotated — reset.
        tailerOffset = 0;
        tailerBuf = "";
      }
      if (size === tailerOffset) return;
      toRead = size - tailerOffset;
      const chunkBytes = Math.max(1, Math.min(toRead, TAILER_MAX_READ_BYTES));
      capped = chunkBytes < toRead;
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.allocUnsafe(chunkBytes);
        readBytes = readSync(fd, buf, 0, chunkBytes, tailerOffset);
        tailerOffset += readBytes;
        tailerBuf += buf.toString("utf8", 0, readBytes);
        let idx;
        while ((idx = tailerBuf.indexOf("\n")) !== -1) {
          const line = tailerBuf.slice(0, idx).trim();
          tailerBuf = tailerBuf.slice(idx + 1);
          if (!line) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          parsedLines += 1;
          invalidateForEvent(parsed);
          broadcastSse(parsed);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      /* transient fs hiccups — try again next tick */
    } finally {
      tailerInFlight = false;
      logTailerMetric({
        to_read_bytes: toRead,
        read_bytes: readBytes,
        parsed_lines: parsedLines,
        subscriber_count: sseSubscribers.size,
        overlap_skips: tailerOverlapSkips,
        capped,
      });
      tailerOverlapSkips = 0;
      if (tailerPending) {
        tailerPending = false;
        setImmediate(tick);
      }
    }
  };

  // Poll every 250ms. fs.watch is unreliable for append-only log files across
  // platforms; stat-based polling is simple and cheap (one syscall per tick).
  const interval = setInterval(tick, 250);
  interval.unref?.();

  // Best-effort: also react to fs events when they do fire.
  try {
    const watcher = fsWatch(path, { persistent: false }, () => tick());
    watcher.unref?.();
  } catch {
    /* file may not exist yet; stat-poll will catch it */
  }
}

function handleEventsStream(req, res, { since = null, seed = 25 } = {}) {
  req.socket?.setNoDelay?.(true);
  req.socket?.setKeepAlive?.(true, 30_000);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\n\n`);

  // Seed with recent events so freshly-opened streams immediately have context.
  try {
    const seedLimit = Math.max(1, Math.min(500, Number(seed) || 25));
    const filters = since ? { since } : {};
    const events = loadPublicEvents(since ? null : seedLimit, filters);
    for (const ev of events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch {
    /* no seed, no problem */
  }

  sseSubscribers.add(res);
  startTailerOnce();

  const heartbeat = setInterval(() => {
    try {
      res.write(`:hb\n\n`);
    } catch {
      /* socket closed */
    }
  }, 25_000);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    sseSubscribers.delete(res);
    try {
      res.end();
    } catch {
      /* already ended */
    }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

function missingScopeSummary(entry) {
  return {
    scope_id: entry.scope_id,
    cwd: entry.cwd,
    storage_root: entry.storage_root,
    registered_at: entry.registered_at,
    updated_at: entry.updated_at,
    exists: false,
    runtime: null,
    health: {
      healthy: false,
      reason: "scope_cwd_missing",
      dispatch_stale_seconds: null,
    },
    jobs_total: 0,
    jobs_enabled: 0,
    next_due_job: null,
    last_completed_run: null,
    active_runs_count: 0,
  };
}

export async function runStatusServer(opts = {}) {
  const schedulerScriptPath = opts.schedulerScriptPath;
  const host = opts.host || "127.0.0.1";
  const port = opts.port !== undefined ? Number(opts.port) : 45173;
  const startedAt = nowIso();
  const uiToken =
    opts.uiToken ||
    process.env.HELM_STATUS_UI_TOKEN ||
    randomBytes(24).toString("hex");

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${host}:${port}`);
    const pathname = requestUrl.pathname;

    try {
      if (pathname.startsWith("/api/v1/tasks")) {
        handleSchedulerTasksApiRoute(req, res, requestUrl, pathname, {
          uiToken,
          onMutate: ({ scopeId, jobId }) => {
            invalidateCache("jobs-all");
            invalidateCache("workspaces");
            invalidateCache(`jobs:${scopeId}`);
            invalidateCache(`job:${scopeId}:${jobId}`);
          },
        });
        return;
      }

      if (req.method !== "GET") {
        json(res, 405, {
          error: { code: "method_not_allowed", message: "GET only" },
        });
        return;
      }

      if (pathname === "/livez") {
        json(res, 200, {
          ok: true,
          started_at: startedAt,
          helm_home: helmHome(),
          pid: process.pid,
        });
        return;
      }

      if (pathname === "/" || pathname === "/ui" || pathname === "/tasks") {
        html(res, 200, renderSchedulerTasksUi({ token: uiToken, startedAt }));
        return;
      }

      if (pathname === "/health") {
        const routeStartedAt = Date.now();
        const serviceStartedAt = Date.now();
        const service = serviceStatus(schedulerScriptPath, {
          includeDiagnostics: false,
        });
        const serviceDurationMs = Date.now() - serviceStartedAt;
        const registeredWorkspaces = listRegisteredScopes().length;
        const routeDurationMs = Date.now() - routeStartedAt;
        if (shouldSampleHealthProbe(routeDurationMs)) {
          appendHealthProbeSample({
            route_duration_ms: routeDurationMs,
            service_status_duration_ms: serviceDurationMs,
            registered_workspaces: registeredWorkspaces,
          });
        }
        json(res, 200, {
          ok: true,
          started_at: startedAt,
          helm_home: helmHome(),
          service,
          registered_workspaces: registeredWorkspaces,
        });
        return;
      }

      if (pathname === "/service") {
        liveDeltaCheckpoint("first_service_status_read");
        json(res, 200, {
          helm_home: helmHome(),
          service: serviceStatus(schedulerScriptPath),
          registered_workspaces: listRegisteredScopes().length,
        });
        return;
      }

      if (pathname === "/jobs-all") {
        Promise.resolve(
          cached("jobs-all", 10_000, () => {
            const entries = listRegisteredScopes();
            const workspaces = [];
            let total_jobs = 0;
            for (const entry of entries) {
              if (!existsSync(entry.cwd)) {
                workspaces.push({
                  scope_id: entry.scope_id,
                  cwd: entry.cwd,
                  jobs: [],
                  error: "cwd_missing",
                });
                continue;
              }
              const scope = resolveScope({ cwd: entry.cwd });
              const jobs = listJobs(scope);
              total_jobs += jobs.length;
              workspaces.push({
                scope_id: scope.scope_id,
                cwd: scope.cwd,
                jobs,
              });
            }
            return { helm_home: helmHome(), workspaces, total_jobs };
          }),
        )
          .then((data) => {
            json(res, 200, data);
          })
          .catch((err) => {
            json(res, 500, {
              error: {
                code: "server_error",
                message: String(err.message || err),
              },
            });
          });
        return;
      }

      if (pathname === "/workspaces") {
        Promise.resolve(
          cached("workspaces", 30_000, () => {
            const summaries = registeredWorkspaceSummaries(schedulerScriptPath);
            return listRegisteredScopes().map((entry) => {
              if (!existsSync(entry.cwd)) return missingScopeSummary(entry);
              return (
                summaries.find(
                  (workspace) => workspace.scope_id === entry.scope_id,
                ) || missingScopeSummary(entry)
              );
            });
          }),
        )
          .then((workspaces) => {
            json(res, 200, { helm_home: helmHome(), workspaces });
          })
          .catch((err) => {
            json(res, 500, {
              error: {
                code: "server_error",
                message: String(err.message || err),
              },
            });
          });
        return;
      }

      if (pathname === "/events") {
        json(
          res,
          200,
          globalServerEvents(schedulerScriptPath, {
            since: requestUrl.searchParams.get("since"),
            scope_id: requestUrl.searchParams.get("scope_id"),
            limit: parseLimit(requestUrl.searchParams.get("limit"), 100),
          }),
        );
        return;
      }

      if (pathname === "/events/stream") {
        handleEventsStream(req, res, {
          since: requestUrl.searchParams.get("since"),
          seed: parseLimit(requestUrl.searchParams.get("seed"), 25),
        });
        return;
      }

      const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== "workspaces" || parts.length < 2) {
        json(res, 404, {
          error: { code: "not_found", message: "route not found" },
        });
        return;
      }

      const scopeId = parts[1];
      const entry = scopeRecordById(scopeId);
      if (!entry) {
        json(res, 404, {
          error: {
            code: "scope_not_found",
            message: `scope '${scopeId}' not found`,
          },
        });
        return;
      }
      if (!existsSync(entry.cwd)) {
        if (parts.length === 3 && parts[2] === "status") {
          json(res, 200, missingScopeSummary(entry));
          return;
        }
        json(res, 410, {
          error: {
            code: "scope_cwd_missing",
            message: `scope '${scopeId}' cwd is missing`,
          },
        });
        return;
      }
      const scope = resolveScope({ cwd: entry.cwd });

      if (parts.length === 3 && parts[2] === "status") {
        const payload = registeredWorkspaceSummaries(schedulerScriptPath).find(
          (workspace) => workspace.scope_id === scopeId,
        );
        json(res, 200, payload || missingScopeSummary(entry));
        return;
      }

      if (parts.length === 3 && parts[2] === "jobs") {
        const jobs = cached(`jobs:${scope.scope_id}`, 10_000, () =>
          listJobs(scope),
        );
        json(res, 200, {
          scope_id: scope.scope_id,
          cwd: scope.cwd,
          jobs,
        });
        return;
      }

      if (parts.length === 4 && parts[2] === "jobs") {
        const payload = cached(`job:${scope.scope_id}:${parts[3]}`, 5_000, () =>
          jobStatusPayload(scope, parts[3]),
        );
        if (!payload) {
          json(res, 404, {
            error: {
              code: "job_not_found",
              message: `job '${parts[3]}' not found`,
            },
          });
          return;
        }
        json(res, 200, {
          scope_id: scope.scope_id,
          cwd: scope.cwd,
          ...payload,
        });
        return;
      }

      if (parts.length === 5 && parts[2] === "jobs" && parts[4] === "history") {
        const limit = parseLimit(requestUrl.searchParams.get("limit"), 20);
        const events = cached(
          `history:${scope.scope_id}:${parts[3]}:${limit}`,
          10_000,
          () => historyForJob(scope, parts[3], limit),
        );
        json(res, 200, {
          scope_id: scope.scope_id,
          cwd: scope.cwd,
          job_id: parts[3],
          events,
        });
        return;
      }

      if (
        parts.length === 8 &&
        parts[2] === "jobs" &&
        parts[4] === "runs" &&
        parts[6] === "logs" &&
        (parts[7] === "stdout" || parts[7] === "stderr")
      ) {
        const descriptor = resolveRunForLogs({
          scope,
          jobId: parts[3],
          runId: parts[5],
        });
        if (!getJob(scope, parts[3])) {
          json(res, 404, {
            error: {
              code: "job_not_found",
              message: `job '${parts[3]}' not found`,
            },
          });
          return;
        }
        const path = descriptor?.log_paths?.[parts[7]] || null;
        if (!path || !existsSync(path)) {
          json(res, 404, {
            error: {
              code: "log_not_found",
              message: `${parts[7]} log for run '${parts[5]}' not found`,
            },
          });
          return;
        }
        const offset = parseOffsetOrNull(requestUrl.searchParams.get("offset"));
        const length = parseOffsetOrNull(requestUrl.searchParams.get("length"));
        sendLogRange(res, path, { offset, length });
        return;
      }

      json(res, 404, {
        error: { code: "not_found", message: "route not found" },
      });
    } catch (err) {
      json(res, 500, {
        error: {
          code: "server_error",
          message: String(err.message || err),
        },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  if (opts.unref) server.unref?.();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  if (typeof opts.onListen === "function") {
    await opts.onListen({
      host,
      port: actualPort,
      url: `http://${host}:${actualPort}`,
      ui_url: `http://${host}:${actualPort}/ui`,
      started_at: startedAt,
      helm_home: helmHome(),
    });
  }

  await new Promise((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
}
