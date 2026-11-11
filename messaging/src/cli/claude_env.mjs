import { REPLY_WAIT_HOST_WINDOW_MS } from "../protocol/reply_listener_policy.mjs";

// Claude holds a foreground Bash call past 10 minutes only when the user's
// BASH_MAX_TIMEOUT_MS allows it; the explicit wait needs the full host window.
export const CLAUDE_ENV = Object.freeze({
  BASH_MAX_TIMEOUT_MS: String(REPLY_WAIT_HOST_WINDOW_MS),
});

// "Higher, keep it" only for a plain non-negative integer at least ours; Claude
// does not read anything else (1e9, Infinity, 0x10) as that many milliseconds.
function keepsHigher(current, ours) {
  const text = Number.isSafeInteger(current) ? String(current) : current;
  return (
    typeof text === "string" &&
    /^\d+$/.test(text) &&
    Number(text) >= Number(ours)
  );
}

/** Throws invalid_settings_env when a settings value holds a non-object env. */
export function assertEnvObject(settings) {
  if (settings?.env !== undefined && !isPlainObject(settings.env))
    throw Object.assign(
      new Error(
        "settings.json env must be a JSON object; fix it by hand and retry",
      ),
      { code: "invalid_settings_env" },
    );
}

function installKey(next, key, ours) {
  assertEnvObject(next);
  const current = next.env?.[key];
  if (current !== undefined && keepsHigher(current, ours))
    return { key, op: String(current) === ours ? "noop" : "keep" };
  next.env ??= {};
  next.env[key] = ours;
  return current === undefined
    ? { key, op: "add", to: ours }
    : { key, op: "refresh", from: current, to: ours };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uninstallKey(next, key, ours) {
  const current = isPlainObject(next.env) ? next.env[key] : undefined;
  if (current === undefined) return { key, op: "absent" };
  if (String(current) !== ours) return { key, op: "keep" };
  delete next.env[key];
  if (Object.keys(next.env).length === 0) delete next.env;
  return { key, op: "remove" };
}

/**
 * Merges the env keys Tightbeam needs into a Claude settings value. Raises a
 * missing, lower, or unparseable value and never lowers a higher one; touches
 * no other key. Uninstall removes a key only while it still equals ours.
 * Mutates `next` and returns the per-key change list.
 */
export function planEnv(next, action, env = CLAUDE_ENV) {
  const plan = action === "install" ? installKey : uninstallKey;
  return Object.entries(env).map(([key, ours]) => plan(next, key, ours));
}
