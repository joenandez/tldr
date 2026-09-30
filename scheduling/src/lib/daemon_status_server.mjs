import { createServer } from "node:http";
import { URL } from "node:url";
import { helmHome } from "./store.mjs";

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(data)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function notFound(res, pathname) {
  json(res, 404, { error: { code: "not_found", message: pathname } });
}

async function servicePayload(schedulerScriptPath) {
  const [{ serviceStatus }, { listRegisteredScopes }, liveAttribution] =
    await Promise.all([
      import("./service.mjs"),
      import("./scopes.mjs"),
      import("./daemon_live_attribution.mjs"),
    ]);
  liveAttribution.writeStatusServerLiveDeltaCheckpoint(
    "first_service_status_read",
  );
  return {
    helm_home: helmHome(),
    service: serviceStatus(schedulerScriptPath),
    registered_workspaces: listRegisteredScopes().length,
  };
}

export async function runDaemonStatusServer(opts = {}) {
  const schedulerScriptPath = opts.schedulerScriptPath;
  const host = opts.host || "127.0.0.1";
  const port = opts.port !== undefined ? Number(opts.port) : 45173;
  const startedAt = nowIso();

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${host}:${port}`);
    const pathname = requestUrl.pathname;
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
    if (pathname === "/health") {
      json(res, 200, {
        ok: true,
        started_at: startedAt,
        helm_home: helmHome(),
        service: {
          health: { healthy: true, reason: "ok" },
          live_pid: process.pid,
          live_pid_alive: true,
        },
        registered_workspaces: null,
      });
      return;
    }
    if (pathname === "/service") {
      try {
        json(res, 200, await servicePayload(schedulerScriptPath));
      } catch (err) {
        json(res, 500, {
          error: {
            code: "service_status_failed",
            message: err?.message || String(err),
          },
        });
      }
      return;
    }
    notFound(res, pathname);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort =
        address && typeof address === "object" ? address.port : port;
      opts.onListen?.({
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        started_at: startedAt,
        helm_home: helmHome(),
      });
      resolve();
    });
  });
  if (opts.unref) server.unref();
  return {
    close: () => server.close(),
    url: `http://${host}:${port}`,
    host,
    port,
    started_at: startedAt,
  };
}
