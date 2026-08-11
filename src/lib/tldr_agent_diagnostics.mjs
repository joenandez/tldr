import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  TLDR_AGENT_DIAGNOSTIC_SCHEMA_VERSION,
  projectTldrAgentDiagnostic,
} from "./tldr_agent_diagnostic_schema.mjs";

export { projectTldrAgentDiagnostic } from "./tldr_agent_diagnostic_schema.mjs";

export const TLDR_AGENT_DIAGNOSTIC_RETENTION_DAYS = 7;
export const TLDR_AGENT_DIAGNOSTIC_FILE_MAX_BYTES = 1024 * 1024;
export const TLDR_AGENT_DIAGNOSTIC_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

const ACTIVE_FILE = "diagnostics.jsonl";
const REPORT_ID = /^diag_[a-z0-9_-]+$/;

function defaultHome() {
  return process.env.TLDR_AGENT_HOME || join(homedir(), ".tldr-agent");
}

export function tldrAgentDiagnosticsRoot(home = defaultHome()) {
  return join(home, "logs", "diagnostics");
}

function reportsRoot(home) {
  return join(tldrAgentDiagnosticsRoot(home), "reports");
}

function activePath(home) {
  return join(tldrAgentDiagnosticsRoot(home), ACTIVE_FILE);
}

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function diagnosticFiles(home) {
  const root = tldrAgentDiagnosticsRoot(home);
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json")) {
        const stat = statSync(path);
        files.push({
          path,
          name: entry.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  visit(root);
  return files;
}

function closedFiles(home) {
  const active = activePath(home);
  return diagnosticFiles(home)
    .filter((file) => file.path !== active)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
}

function totalBytes(home) {
  return diagnosticFiles(home).reduce((sum, file) => sum + file.size, 0);
}

function rotateActive(home, now) {
  const path = activePath(home);
  if (!existsSync(path) || statSync(path).size === 0) return false;
  const stamp = safeDate(now)
    .toISOString()
    .replaceAll(/[^0-9]/g, "");
  const rotated = join(
    tldrAgentDiagnosticsRoot(home),
    `diagnostics-${stamp}-${process.pid}-${randomBytes(3).toString("hex")}.jsonl`,
  );
  renameSync(path, rotated);
  return true;
}

function removeExpired(home, now, retentionDays) {
  const cutoff = safeDate(now).getTime() - retentionDays * 86_400_000;
  let deleted = 0;
  for (const file of closedFiles(home)) {
    if (file.mtimeMs >= cutoff) continue;
    rmSync(file.path, { force: true });
    deleted += 1;
  }
  return deleted;
}

function enforceTotalCap(home, totalMaxBytes, reserveBytes = 0) {
  let total = totalBytes(home);
  let deleted = 0;
  for (const file of closedFiles(home)) {
    if (total + reserveBytes <= totalMaxBytes) break;
    rmSync(file.path, { force: true });
    total -= file.size;
    deleted += 1;
  }
  return { deleted, totalBytes: total };
}

export function maintainTldrAgentDiagnostics({
  home = defaultHome(),
  now = new Date(),
  retentionDays = TLDR_AGENT_DIAGNOSTIC_RETENTION_DAYS,
  totalMaxBytes = TLDR_AGENT_DIAGNOSTIC_TOTAL_MAX_BYTES,
  reserveBytes = 0,
} = {}) {
  try {
    mkdirSync(tldrAgentDiagnosticsRoot(home), { recursive: true, mode: 0o700 });
    const expired_deleted = removeExpired(home, now, retentionDays);
    const capped = enforceTotalCap(home, totalMaxBytes, reserveBytes);
    return {
      ok: true,
      expired_deleted,
      capped_deleted: capped.deleted,
      total_bytes: capped.totalBytes,
    };
  } catch {
    return { ok: false, expired_deleted: 0, capped_deleted: 0, total_bytes: 0 };
  }
}

export function appendTldrAgentDiagnostic(
  input,
  {
    home = defaultHome(),
    now = new Date(),
    retentionDays = TLDR_AGENT_DIAGNOSTIC_RETENTION_DAYS,
    perFileMaxBytes = TLDR_AGENT_DIAGNOSTIC_FILE_MAX_BYTES,
    totalMaxBytes = TLDR_AGENT_DIAGNOSTIC_TOTAL_MAX_BYTES,
    durable = false,
  } = {},
) {
  try {
    const event = projectTldrAgentDiagnostic(input, { now });
    if (!event) return { recorded: false };
    const line = `${JSON.stringify(event)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > perFileMaxBytes || lineBytes > totalMaxBytes) {
      return { recorded: false };
    }
    const root = tldrAgentDiagnosticsRoot(home);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = activePath(home);
    if (existsSync(path)) {
      const active = statSync(path);
      const cutoff = safeDate(now).getTime() - retentionDays * 86_400_000;
      if (
        active.size + lineBytes > perFileMaxBytes ||
        active.mtimeMs < cutoff
      ) {
        rotateActive(home, now);
      }
    }
    maintainTldrAgentDiagnostics({
      home,
      now,
      retentionDays,
      totalMaxBytes,
      reserveBytes: lineBytes,
    });
    if (totalBytes(home) + lineBytes > totalMaxBytes)
      return { recorded: false };
    if (durable) {
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, line, null, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    }
    return { recorded: true, event };
  } catch {
    return { recorded: false };
  }
}

// Temporary compatibility signature while Workstream 8 removes inherited files.
export function appendActivityEvent(input, options) {
  const result = appendTldrAgentDiagnostic(input, options);
  return result.event || result;
}

function logFilesNewestFirst(home) {
  const root = tldrAgentDiagnosticsRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({
      name,
      path: join(root, name),
      stat: statSync(join(root, name)),
    }))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
}

export function inspectTldrAgentLogs({
  home = defaultHome(),
  limit = 100,
} = {}) {
  try {
    const max = Math.max(0, Math.min(500, Number(limit) || 0));
    if (max === 0) return { events: [] };
    const events = [];
    for (const file of logFilesNewestFirst(home)) {
      const lines = readFileSync(file.path, "utf8").split("\n").filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const event = JSON.parse(lines[index]);
          if (projectTldrAgentDiagnostic(event, { now: event.timestamp })) {
            events.push(event);
          }
        } catch {}
      }
    }
    return {
      events: events
        .sort((left, right) =>
          String(right.timestamp || "").localeCompare(
            String(left.timestamp || ""),
          ),
        )
        .slice(0, max),
    };
  } catch {
    return { events: [] };
  }
}

export function purgeTldrAgentDiagnostics({ home = defaultHome() } = {}) {
  try {
    rmSync(tldrAgentDiagnosticsRoot(home), { recursive: true, force: true });
    return { purged: true };
  } catch {
    return { purged: false };
  }
}

export function createTldrAgentDiagnosticReport({ home = defaultHome() } = {}) {
  try {
    const createdAt = new Date();
    const diagnosticId = `diag_${createdAt.toISOString().replaceAll(/[^0-9]/g, "")}_${randomBytes(4).toString("hex")}`;
    const report = {
      schema_version: TLDR_AGENT_DIAGNOSTIC_SCHEMA_VERSION,
      diagnostic_id: diagnosticId,
      created_at: createdAt.toISOString(),
      events: inspectTldrAgentLogs({ home, limit: 200 }).events,
    };
    mkdirSync(reportsRoot(home), { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(report)}\n`;
    const temporary = join(
      reportsRoot(home),
      `.${diagnosticId}.${process.pid}.tmp`,
    );
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, join(reportsRoot(home), `${diagnosticId}.json`));
    maintainTldrAgentDiagnostics({ home });
    return {
      ok: true,
      diagnostic_id: diagnosticId,
      event_count: report.events.length,
      size_bytes: Buffer.byteLength(serialized),
    };
  } catch {
    return { ok: false, code: "diagnostic_create_failed" };
  }
}

export function inspectTldrAgentDiagnosticReport({
  home = defaultHome(),
  diagnosticId = null,
} = {}) {
  try {
    let selected = diagnosticId;
    if (!selected) {
      const reports = existsSync(reportsRoot(home))
        ? readdirSync(reportsRoot(home))
            .filter((name) => REPORT_ID.test(name.replace(/\.json$/, "")))
            .sort()
        : [];
      selected = reports.at(-1)?.replace(/\.json$/, "") || null;
    }
    if (!selected || !REPORT_ID.test(selected)) {
      return { ok: false, code: "diagnostic_id_invalid" };
    }
    const stored = JSON.parse(
      readFileSync(join(reportsRoot(home), `${selected}.json`), "utf8"),
    );
    const report = {
      schema_version: TLDR_AGENT_DIAGNOSTIC_SCHEMA_VERSION,
      diagnostic_id: selected,
      created_at: safeDate(stored.created_at).toISOString(),
      events: Array.isArray(stored.events)
        ? stored.events
            .map((event) =>
              projectTldrAgentDiagnostic(event, { now: event?.timestamp }),
            )
            .filter(Boolean)
        : [],
    };
    return { ok: true, report };
  } catch {
    return { ok: false, code: "diagnostic_not_found" };
  }
}

export function createTldrAgentDiagnosticCliDependencies({
  home = defaultHome(),
} = {}) {
  return {
    inspectDiagnosticsLogs: ({ limit }) =>
      inspectTldrAgentLogs({ home, limit }),
    purgeDiagnosticsLogs: () => purgeTldrAgentDiagnostics({ home }),
    createDiagnosticReport: () => createTldrAgentDiagnosticReport({ home }),
    inspectDiagnosticReport: ({ diagnosticId }) =>
      inspectTldrAgentDiagnosticReport({ home, diagnosticId }),
  };
}
