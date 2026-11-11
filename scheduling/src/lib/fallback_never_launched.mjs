// A runtime fallback whose command never ran (ENOENT, or the wrapper shell's exit 127) produced no outcome:
// the primary's limit still decides a hold (AC-1). Every launch empties the run log (the log holds the final
// agent's output, AC-15), so a launch that never ran must hand the primary's stdout back.
import { readFileSync, writeFileSync } from "node:fs";

const TAIL_BYTES = 262144; // same window held_at_exit reads

/** Anchored: a launched fallback's own failure text ("ENOENT: no such file ...") is its outcome (AC-15).
 * @param {string|null|undefined} error a start/terminal result's `error` or `fallback_failure_summary` */
export function neverLaunched(error) {
  return /^spawn .+ ENOENT$|^exit_code_127$/.test(error || "");
}

/** Empties `path`; the returned `restore(result)` puts the previous tail back when the launch never ran. */
export function truncateKeepingTail(path) {
  let tail = null;
  try {
    tail = readFileSync(path).subarray(-TAIL_BYTES);
  } catch {
    // no previous log: nothing to keep
  }
  writeFileSync(path, "", "utf8");
  return (result) => {
    if (tail?.length && neverLaunched(result?.error)) writeFileSync(path, tail);
  };
}
