import { schedulerTasksCss } from "./scheduler_tasks_ui_css.mjs";

function escapeScriptString(value) {
  return JSON.stringify(String(value || ""));
}

export function renderSchedulerTasksUi({ token = "", startedAt = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Helm Scheduled Tasks</title>
  <style>${schedulerTasksCss}</style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Helm Scheduled Tasks</h1>
        <div class="meta">Local server started <span id="startedAt"></span></div>
      </div>
      <div class="toolbar">
        <input id="search" class="control" type="search" placeholder="Search tasks">
        <select id="scope" class="control" aria-label="Workspace"></select>
        <div class="segmented" role="tablist" aria-label="Task view">
          <button type="button" data-view="enabled" class="active">Enabled</button>
          <button type="button" data-view="paused">Paused</button>
          <button type="button" data-view="scheduled">Scheduled</button>
          <button type="button" data-view="all">All</button>
        </div>
      </div>
    </header>

    <section class="summary" aria-label="Task summary">
      <div class="metric"><b id="metricShown">0</b><span>shown</span></div>
      <div class="metric"><b id="metricEnabled">0</b><span>enabled</span></div>
      <div class="metric"><b id="metricPaused">0</b><span>paused</span></div>
      <div class="metric"><b id="metricWorkspaces">0</b><span>workspaces</span></div>
    </section>

    <section class="panel">
      <table>
        <colgroup>
          <col style="width: 25%">
          <col style="width: 11%">
          <col style="width: 11%">
          <col style="width: 12%">
          <col style="width: 12%">
          <col style="width: 15%">
          <col style="width: 6%">
          <col style="width: 8%">
        </colgroup>
        <thead>
          <tr>
            <th>Task</th>
            <th>Now</th>
            <th>Last Result</th>
            <th>Schedule</th>
            <th>Next Run</th>
            <th>Workspace</th>
            <th>Enabled</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="empty" class="empty" hidden>No tasks match the current filters.</div>
      <div id="error" class="error" hidden></div>
    </section>
  </main>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script>
    const UI_TOKEN = ${escapeScriptString(token)};
    const STARTED_AT = ${escapeScriptString(startedAt)};
    const state = { view: "enabled", q: "", scope: "", tasks: [], workspaces: [] };

    const el = (id) => document.getElementById(id);
    const fmt = new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });

    function shortWorkspace(cwd) {
      const parts = String(cwd || "").split("/").filter(Boolean);
      return parts.slice(-2).join("/") || cwd || "unknown";
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[ch]);
    }

    function formatTime(value) {
      if (!value) return "none";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return fmt.format(date);
    }

    function toast(message) {
      const node = el("toast");
      node.textContent = message;
      node.classList.add("show");
      clearTimeout(node._timer);
      node._timer = setTimeout(() => node.classList.remove("show"), 2600);
    }

    function stateClass(task) {
      if (task.current_state === "due" || task.current_state === "deferred") return "warn";
      if (task.current_state === "running" || task.current_state === "waiting") return "ok";
      if (task.enabled) return "ok";
      return "muted";
    }

    function resultClass(task) {
      if (task.last_result === "failure") return "bad";
      if (task.last_result === "skipped") return "warn";
      if (task.last_result === "success") return "ok";
      return "muted";
    }

    function titleCase(value) {
      return String(value || "none").replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
    }

    function stateNote(task) {
      if (task.current_state === "running") return "Active run";
      if (task.current_state === "paused") return "Stopped";
      if (task.current_state === "due") return "Ready to start";
      if (task.current_state === "deferred") return task.deferred_reason || "Deferred";
      return "Between runs";
    }

    function resultNote(task) {
      if (task.last_result === "none") return "No completed run";
      return formatTime(task.last_run_at);
    }

    function renderScopeOptions() {
      const select = el("scope");
      const current = select.value;
      const scopes = [...new Map(state.tasks.map((task) => [
        task.scope_id,
        { scope_id: task.scope_id, label: shortWorkspace(task.cwd) }
      ])).values()].sort((a, b) => a.label.localeCompare(b.label));
      select.innerHTML = '<option value="">All workspaces</option>' +
        scopes.map((scope) => '<option value="' + escapeHtml(scope.scope_id) + '">' +
          escapeHtml(scope.label) + '</option>').join("");
      select.value = scopes.some((scope) => scope.scope_id === current) ? current : "";
    }

    function renderRows() {
      const tbody = el("rows");
      const empty = el("empty");
      const error = el("error");
      error.hidden = true;
      const rows = state.tasks.filter((task) => !state.scope || task.scope_id === state.scope);
      tbody.innerHTML = rows.map((task) => {
        const on = task.enabled ? " on" : "";
        const tags = task.tags && task.tags.length ? " #" + task.tags.slice(0, 3).join(" #") : "";
        const taskTitle = escapeHtml(task.title);
        const taskId = escapeHtml(task.job_id);
        const taskTags = escapeHtml(tags);
        const stateText = escapeHtml(titleCase(task.current_state || task.lifecycle_status));
        const stateHint = escapeHtml(stateNote(task));
        const resultText = escapeHtml(titleCase(task.last_result || task.last_status || "none"));
        const resultHint = escapeHtml(resultNote(task));
        const scheduleLabel = escapeHtml(task.schedule.label);
        const runner = escapeHtml(task.runner);
        const nextRun = escapeHtml(formatTime(task.next_run_at));
        const workspace = escapeHtml(shortWorkspace(task.cwd));
        const scopeId = escapeHtml(task.scope_id);
        return '<tr>' +
          '<td><div class="task-title">' + taskTitle + '</div><div class="subtle">' + taskId + taskTags + '</div></td>' +
          '<td><div class="state-cell ' + stateClass(task) + '"><span class="state-dot"></span><div><div class="state-title">' + stateText + '</div><div class="state-note">' + stateHint + '</div></div></div></td>' +
          '<td><div class="result-cell ' + resultClass(task) + '"><div class="result-title">' + resultText + '</div><div class="result-note">' + resultHint + '</div></div></td>' +
          '<td><span class="pill">' + scheduleLabel + '</span><div class="subtle">' + runner + '</div></td>' +
          '<td>' + nextRun + '</td>' +
          '<td><div>' + workspace + '</div><div class="subtle">' + scopeId + '</div></td>' +
          '<td><button type="button" class="switch' + on + '" aria-label="Toggle ' + taskId + '" data-scope="' +
            encodeURIComponent(task.scope_id) + '" data-job="' + encodeURIComponent(task.job_id) + '"></button></td>' +
          '<td><button type="button" class="delete-button" aria-label="Delete task ' + taskId + '" data-scope="' +
            encodeURIComponent(task.scope_id) + '" data-job="' + encodeURIComponent(task.job_id) + '">Delete</button></td>' +
        '</tr>';
      }).join("");
      empty.hidden = rows.length !== 0;
      el("metricShown").textContent = String(rows.length);
      el("metricEnabled").textContent = String(rows.filter((task) => task.enabled).length);
      el("metricPaused").textContent = String(rows.filter((task) => !task.enabled).length);
      el("metricWorkspaces").textContent = String(new Set(rows.map((task) => task.scope_id)).size);
    }

    async function loadTasks() {
      const params = new URLSearchParams({ view: state.view, limit: "1000" });
      if (state.q) params.set("q", state.q);
      const response = await fetch("/api/v1/tasks?" + params.toString());
      if (!response.ok) throw new Error("Task list failed: " + response.status);
      const data = await response.json();
      state.tasks = data.tasks || [];
      state.workspaces = data.workspaces || [];
      renderScopeOptions();
      renderRows();
    }

    async function toggle(button) {
      const scope = button.dataset.scope;
      const job = button.dataset.job;
      const isOn = button.classList.contains("on");
      button.disabled = true;
      try {
        const action = isOn ? "pause" : "resume";
        const response = await fetch("/api/v1/tasks/" + scope + "/" + job + "/" + action, {
          method: "POST",
          headers: { "X-Helm-UI-Token": UI_TOKEN }
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error?.message || "Toggle failed");
        }
        toast(isOn ? "Task paused" : "Task resumed");
        await loadTasks();
      } catch (err) {
        toast(err.message || String(err));
      } finally {
        button.disabled = false;
      }
    }

    async function deleteTask(button) {
      const scope = button.dataset.scope;
      const job = button.dataset.job;
      const task = state.tasks.find((candidate) =>
        encodeURIComponent(candidate.scope_id) === scope &&
        encodeURIComponent(candidate.job_id) === job
      );
      const title = task?.title || decodeURIComponent(job);
      const taskId = task?.job_id || decodeURIComponent(job);
      const confirmed = window.confirm(
        'Delete "' + title + '" (' + taskId + ')?\\n\\n' +
        'This removes the scheduled task. Run history is retained.'
      );
      if (!confirmed) return;

      button.disabled = true;
      try {
        const response = await fetch("/api/v1/tasks/" + scope + "/" + job, {
          method: "DELETE",
          headers: { "X-Helm-UI-Token": UI_TOKEN }
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error?.message || "Delete failed");
        }
        toast("Task deleted");
        await loadTasks();
      } catch (err) {
        toast(err.message || String(err));
      } finally {
        button.disabled = false;
      }
    }

    document.querySelector(".segmented").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-view]");
      if (!button) return;
      document.querySelectorAll(".segmented button").forEach((node) => node.classList.remove("active"));
      button.classList.add("active");
      state.view = button.dataset.view;
      loadTasks().catch(showError);
    });
    el("search").addEventListener("input", (event) => {
      clearTimeout(el("search")._timer);
      el("search")._timer = setTimeout(() => {
        state.q = event.target.value.trim();
        loadTasks().catch(showError);
      }, 160);
    });
    el("scope").addEventListener("change", (event) => {
      state.scope = event.target.value;
      renderRows();
    });
    el("rows").addEventListener("click", (event) => {
      const deleteButton = event.target.closest("button.delete-button");
      if (deleteButton) {
        deleteTask(deleteButton);
        return;
      }
      const toggleButton = event.target.closest("button.switch");
      if (toggleButton) toggle(toggleButton);
    });
    function showError(err) {
      el("error").textContent = err.message || String(err);
      el("error").hidden = false;
    }
    el("startedAt").textContent = formatTime(STARTED_AT);
    loadTasks().catch(showError);
  </script>
</body>
</html>`;
}
