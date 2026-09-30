import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { serviceRoot, readJsonIfExists, writeJsonAtomic } from "./store.mjs";

export function daemonFreshnessPath() {
  return `${serviceRoot()}/daemon-freshness.json`;
}

export function freshnessSchedulerScriptPath(service, fallbackPath) {
  return service?.scheduler_script || fallbackPath;
}

export function computeDaemonSourceHash(schedulerScriptPath) {
  const files = collectLocalModuleGraph(resolve(schedulerScriptPath));
  const hash = createHash("sha256");
  for (const file of files) {
    const source = readFileSync(file);
    hash.update(file);
    hash.update("\0");
    hash.update(String(source.length));
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function collectLocalModuleGraph(entrypoint) {
  const pending = [entrypoint];
  const seen = new Set();
  const files = [];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    files.push(file);
    for (const specifier of localImportSpecifiers(source)) {
      const resolved = resolveLocalModule(file, specifier);
      if (resolved && !seen.has(resolved)) pending.push(resolved);
    }
  }
  return files.sort();
}

function localImportSpecifiers(source) {
  const specifiers = [];
  const staticImport = /\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    let match;
    while ((match = pattern.exec(source))) {
      if (match[1]?.startsWith(".")) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function resolveLocalModule(importer, specifier) {
  const base = resolve(dirname(importer), specifier);
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.mjs`, join(base, "index.mjs")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function writeDaemonFreshness({
  schedulerScriptPath,
  daemonInstanceId = null,
  pid = process.pid,
  recordedAt = new Date().toISOString(),
} = {}) {
  const record = {
    version: "1.0",
    recorded_at: recordedAt,
    pid,
    daemon_instance_id: daemonInstanceId,
    scheduler_script_path: resolve(schedulerScriptPath),
    source_template_hash: computeDaemonSourceHash(schedulerScriptPath),
  };
  writeJsonAtomic(daemonFreshnessPath(), record);
  return record;
}

export function daemonFreshnessStatus(schedulerScriptPath) {
  const path = daemonFreshnessPath();
  if (!existsSync(path)) return null;
  const record = readJsonIfExists(path, null);
  if (!record || typeof record !== "object") {
    return {
      status: "unknown",
      restart_required: false,
      reason: "daemon_freshness_record_unreadable",
      path,
    };
  }
  let currentHash;
  try {
    currentHash = computeDaemonSourceHash(schedulerScriptPath);
  } catch (err) {
    return {
      status: "unknown",
      restart_required: false,
      reason: "current_source_hash_unavailable",
      error: err?.message || String(err),
      path,
    };
  }
  const recordedHash = record.source_template_hash || null;
  const stale = Boolean(recordedHash && recordedHash !== currentHash);
  return {
    status: stale ? "stale" : "current",
    restart_required: stale,
    reason: stale ? "source_template_hash_mismatch" : null,
    hint: stale
      ? "Restart the Helm daemon so live email routing uses the linked package code."
      : null,
    recorded_at: record.recorded_at || null,
    daemon_instance_id: record.daemon_instance_id || null,
    pid: record.pid || null,
    scheduler_script_path: record.scheduler_script_path || null,
    recorded_hash: recordedHash,
    current_hash: currentHash,
  };
}
