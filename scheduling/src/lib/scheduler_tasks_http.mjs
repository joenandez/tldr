import { helmHome } from "./store.mjs";
import {
  deleteSchedulerTask,
  listSchedulerTasks,
  setSchedulerTaskEnabled,
} from "./scheduler_tasks_api.mjs";

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(data)}\n`);
}

function parseLimit(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parseTaskApiQuery(searchParams) {
  return {
    view: searchParams.get("view") || "enabled",
    scope_id: searchParams.get("scope_id") || null,
    schedule_type: searchParams.get("schedule_type") || null,
    status: searchParams.get("status") || null,
    q: searchParams.get("q") || null,
    limit: parseLimit(searchParams.get("limit"), 500),
  };
}

function taskApiTokenAllowed(req, token) {
  return (
    typeof token === "string" &&
    token.length > 0 &&
    req.headers["x-helm-ui-token"] === token
  );
}

function taskApiErrorStatus(err) {
  if (Number.isInteger(err?.statusCode)) return err.statusCode;
  if (err?.code === "not_found") return 404;
  if (err?.code === "scope_not_found") return 404;
  if (err?.code === "scope_cwd_missing") return 410;
  if (err?.code === "scope_busy") return 409;
  return 500;
}

export function handleSchedulerTasksApiRoute(
  req,
  res,
  requestUrl,
  pathname,
  { uiToken, onMutate } = {},
) {
  const tail = pathname.slice("/api/v1/tasks".length).replace(/\/+$/, "");
  if (req.method === "GET" && tail === "") {
    try {
      json(res, 200, {
        ok: true,
        helm_home: helmHome(),
        ...listSchedulerTasks(parseTaskApiQuery(requestUrl.searchParams)),
      });
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: {
          code: err?.code || "task_list_failed",
          message: String(err?.message || err),
        },
      });
    }
    return;
  }

  if (req.method === "POST") {
    if (!taskApiTokenAllowed(req, uiToken)) {
      json(res, 403, {
        ok: false,
        error: {
          code: "ui_token_required",
          message: "A valid X-Helm-UI-Token header is required.",
        },
      });
      return;
    }
    const parts = tail.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 3 && (parts[2] === "pause" || parts[2] === "resume")) {
      setSchedulerTaskEnabled({
        scopeId: parts[0],
        jobId: parts[1],
        enabled: parts[2] === "resume",
      })
        .then((data) => {
          onMutate?.({ scopeId: parts[0], jobId: parts[1] });
          json(res, 200, { ok: true, data });
        })
        .catch((err) => {
          json(res, taskApiErrorStatus(err), {
            ok: false,
            error: {
              code: err?.code || "task_update_failed",
              message: String(err?.message || err),
            },
          });
        });
      return;
    }
  }

  if (req.method === "DELETE") {
    if (!taskApiTokenAllowed(req, uiToken)) {
      json(res, 403, {
        ok: false,
        error: {
          code: "ui_token_required",
          message: "A valid X-Helm-UI-Token header is required.",
        },
      });
      return;
    }
    const parts = tail.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 2) {
      deleteSchedulerTask({ scopeId: parts[0], jobId: parts[1] })
        .then((data) => {
          onMutate?.({ scopeId: parts[0], jobId: parts[1] });
          json(res, 200, { ok: true, data });
        })
        .catch((err) => {
          json(res, taskApiErrorStatus(err), {
            ok: false,
            error: {
              code: err?.code || "task_delete_failed",
              message: String(err?.message || err),
            },
          });
        });
      return;
    }
  }

  json(res, 404, {
    ok: false,
    error: {
      code: "not_found",
      message: `Task API route '${pathname}' not found.`,
    },
  });
}
