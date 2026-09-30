import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { saveHeartbeatMeta, loadHeartbeatMeta } from "./store.mjs";

function readCrontab() {
  try {
    return execSync("crontab -l", { encoding: "utf8" });
  } catch {
    return "";
  }
}

function writeCrontab(content) {
  execSync("crontab -", { input: content, encoding: "utf8" });
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

function scopeTag(scope) {
  const digest = createHash("sha1")
    .update(scope.cwd)
    .digest("hex")
    .slice(0, 12);
  return `# helm-tasks:cwd:${digest}`;
}

// Opportunity #3 (reliability review 2026-06-11): per-minute cron with an
// overlap guard. Without it, a dispatch slower than 60s stacked a fresh
// cold-start node process every minute. The guard keys on a per-scope
// pidfile and skips the launch while the prior run's PID is still alive;
// a stale pidfile (crashed run, reboot) fails the kill -0 check and is
// simply overwritten.
function guardedDispatchScript(scope, scheduler) {
  const digest = createHash("sha1")
    .update(scope.cwd)
    .digest("hex")
    .slice(0, 12);
  const pidfile = `/tmp/helm-heartbeat-${digest}.pid`;
  return [
    `pid=$(cat "${pidfile}" 2>/dev/null || true)`,
    `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then exit 0; fi`,
    `echo $$ > "${pidfile}"`,
    `node "${scheduler}" dispatch`,
    `status=$?`,
    `rm -f "${pidfile}"`,
    `exit $status`,
  ].join("; ");
}

export function installHeartbeat(scope, schedulerScriptPath) {
  const scheduler = resolve(schedulerScriptPath);
  const line = `* * * * * cd ${shellQuote(scope.cwd)} && /bin/sh -c ${shellQuote(guardedDispatchScript(scope, scheduler))}`;

  const current = readCrontab().split("\n");
  const filtered = [];
  const t = scopeTag(scope);
  for (let i = 0; i < current.length; i++) {
    if (current[i].trim() === t) {
      i += 1;
      continue;
    }
    filtered.push(current[i]);
  }
  const updated = `${filtered.join("\n").trimEnd()}\n${t}\n${line}\n`;
  writeCrontab(updated);
  saveHeartbeatMeta(scope, {
    installed_at: new Date().toISOString(),
    cron: "* * * * *",
    command: line,
    installed_cwd: scope.cwd,
    tag: t,
  });
  return { installed: true, cron: "* * * * *", command: line, tag: t };
}

export function removeHeartbeat(scope) {
  const current = readCrontab().split("\n");
  const filtered = [];
  const t = scopeTag(scope);
  let removed = false;
  for (let i = 0; i < current.length; i++) {
    if (current[i].trim() === t) {
      removed = true;
      i += 1;
      continue;
    }
    filtered.push(current[i]);
  }
  if (removed) {
    writeCrontab(`${filtered.join("\n").trimEnd()}\n`);
  }
  return { removed, tag: t };
}

export function heartbeatStatus(scope) {
  const current = readCrontab();
  const t = scopeTag(scope);
  const installed = current.includes(t);
  const meta = loadHeartbeatMeta(scope);
  return { installed, meta, tag: t };
}
