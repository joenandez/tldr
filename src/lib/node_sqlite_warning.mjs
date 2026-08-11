// Suppresses Node's `ExperimentalWarning: SQLite is an experimental feature`.
//
// node:sqlite is unflagged from Node 22.13.0 (the supported floor — see
// MIN_NODE_VERSION in node_exec.mjs) but still emits an ExperimentalWarning on
// stderr for the whole 22.x and 23.x line. Node 24 does not. Left alone, every
// `tldr-agent` invocation on a supported Node prints a warning that looks like
// a defect, and the daemon writes one into its log on each start.
//
// The filter is deliberately narrow: only ExperimentalWarning whose message
// names SQLite is dropped. Every other warning — including other
// ExperimentalWarnings — reaches the default handler untouched. No version
// branch is needed; the filter simply stops matching once Node stops emitting.
//
// Importing this module installs the filter. It must be the FIRST import in an
// entrypoint: ES module imports evaluate depth-first in source order, so
// anything importing node:sqlite ahead of it would emit the warning first.

/**
 * @param {unknown} warning - the payload Node passes with a `warning` event
 * @returns {boolean} true when this is the node:sqlite experimental warning
 */
export function isSqliteExperimentalWarning(warning) {
  if (!warning || typeof warning !== "object") return false;
  const { name, message } = /** @type {{name?: unknown, message?: unknown}} */ (
    warning
  );
  if (name !== "ExperimentalWarning") return false;
  return typeof message === "string" && /\bSQLite\b/i.test(message);
}

/**
 * Install the filter on a process-like emitter. Idempotent: a second call on
 * the same target is a no-op, so repeated imports cannot stack wrappers.
 *
 * @param {{emit: Function, __tldrAgentSqliteWarningFiltered?: boolean}} target
 * @returns {boolean} true if this call installed the filter
 */
export function installSqliteWarningFilter(target = process) {
  if (!target || typeof target.emit !== "function") return false;
  if (target.__tldrAgentSqliteWarningFiltered) return false;

  const originalEmit = target.emit;
  target.emit = function emit(name, ...args) {
    if (name === "warning" && isSqliteExperimentalWarning(args[0]))
      return false;
    return originalEmit.call(this, name, ...args);
  };
  target.__tldrAgentSqliteWarningFiltered = true;
  return true;
}

installSqliteWarningFilter();
