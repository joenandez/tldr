// The detach child's stdio is discarded, so its boundary events go to the session dir.
import fs from "node:fs";
import path from "node:path";

const LOG_MAX_BYTES = 256 * 1024;
const LOG_KEEP_BYTES = 64 * 1024;

const logPath = (paths) => path.join(paths.dir, "hook-detach.log");

export function errorFields(error, withStack = true) {
  return {
    code: error?.code ?? null,
    message: String(error?.message ?? error),
    ...(withStack ? { stack: error?.stack ?? null } : {}),
  };
}

export function appendLog(paths, fields) {
  fs.appendFileSync(
    logPath(paths),
    `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...fields })}\n`,
    { mode: 0o600 },
  );
  trimDetachLog(logPath(paths));
}

/** Same temp+rename trim as trimNoticeFile: over the cap, keep the newest whole lines within the keep size. */
export function trimDetachLog(file) {
  if (fs.statSync(file).size <= LOG_MAX_BYTES) return;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let bytes = 0;
  let keepFrom = lines.length;
  while (keepFrom > 0) {
    bytes += Buffer.byteLength(lines[keepFrom - 1]) + 1;
    if (bytes > LOG_KEEP_BYTES) break;
    keepFrom -= 1;
  }
  keepFrom = Math.min(keepFrom, lines.length - 1); // the newest line always stays
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${lines.slice(keepFrom).join("\n")}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
}
