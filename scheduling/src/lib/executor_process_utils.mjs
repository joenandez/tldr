import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TRUNCATION_MARKER = "\n[... helm output truncated ...]\n";

export function positiveIntegerEnv(name, fallback = null, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createBoundedTextCapture(maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  const headLimit = Math.floor(limit / 2);
  const tailLimit = limit - headLimit;
  let totalBytes = 0;
  let truncated = false;
  let full = Buffer.alloc(0);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      totalBytes += buffer.length;
      if (!truncated && full.length + buffer.length <= limit) {
        full = Buffer.concat([full, buffer]);
        return;
      }
      if (!truncated) {
        truncated = true;
        head = full.subarray(0, headLimit);
        tail = full.subarray(Math.max(0, full.length - tailLimit));
        full = Buffer.alloc(0);
      }
      tail = Buffer.concat([tail, buffer]);
      if (tail.length > tailLimit) {
        tail = tail.subarray(tail.length - tailLimit);
      }
    },
    text() {
      if (!truncated) return full.toString();
      return `${head.toString()}${TRUNCATION_MARKER}${tail.toString()}`;
    },
    stats() {
      return {
        bytes: totalBytes,
        truncated,
        retained_bytes: Buffer.byteLength(this.text()),
      };
    },
  };
}

export function outputMetadata(stdoutCapture, stderrCapture, logStreams) {
  const stdout = stdoutCapture.stats();
  const stderr = stderrCapture.stats();
  return {
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
    output_truncated: stdout.truncated || stderr.truncated,
    retained_stdout_bytes: stdout.retained_bytes,
    retained_stderr_bytes: stderr.retained_bytes,
    log_stdout_bytes: logStreams?.state?.stdoutBytes ?? null,
    log_stderr_bytes: logStreams?.state?.stderrBytes ?? null,
    log_stdout_truncated: Boolean(logStreams?.state?.stdoutTruncated),
    log_stderr_truncated: Boolean(logStreams?.state?.stderrTruncated),
    log_write_errors: logStreams?.state?.errors || [],
  };
}

export function safeCloseFd(fd) {
  if (!Number.isInteger(fd)) return;
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

export function makeStdinFd(stdinText, logPaths) {
  if (stdinText === null) return { fd: "ignore", path: null };
  const baseDir = logPaths?.stdout
    ? dirname(logPaths.stdout)
    : mkdtempSync(join(tmpdir(), "helm-agent-stdin-"));
  mkdirSync(baseDir, { recursive: true });
  const path = join(
    baseDir,
    `stdin-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  writeFileSync(path, stdinText, "utf8");
  return { fd: openSync(path, "r"), path };
}

export function signalStartedProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
