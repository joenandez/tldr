// Read-only subscription usage check. No model call; never writes or refreshes credentials.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

import { defaultLog } from "./held_release_core.mjs";

const TIMEOUT_MS = 10_000;
const UNKNOWN = { state: "unknown", resets_at: null, http_status: null };

// Missing or unparsable file: no credential. Any other read error (EACCES, EIO) is transient and rethrown.
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === "ENOENT") return null;
    throw error;
  }
}

function keychainJson() {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      },
    );
    return JSON.parse(out);
  } catch (error) {
    // Exit 44 = item not found, ENOENT = no `security` binary, SyntaxError = junk: no Keychain credential.
    // A locked or timed-out Keychain (anything else) is transient: rethrow so the probe stays unknown, not permanent.
    if (
      error instanceof SyntaxError ||
      error?.code === "ENOENT" ||
      error?.status === 44
    )
      return null;
    throw error;
  }
}

// Returns {token, accountId?} | {permanent: reason}. No usable credential (API-key account, missing login)
// is permanent so the episode never re-polls it; an expired token is a 401 at fetch time and stays transient.
const NO_CREDENTIAL = { permanent: "no_credential" };
function claudeCredential() {
  const oauth = (
    keychainJson() ?? readJson(join(homedir(), ".claude", ".credentials.json"))
  )?.claudeAiOauth;
  if (!oauth?.accessToken) return NO_CREDENTIAL;
  // Setup tokens are inference-only: no refresh token and no user:profile scope for the usage endpoint.
  const noProfile =
    Array.isArray(oauth.scopes) && !oauth.scopes.includes("user:profile");
  if (noProfile || oauth.refreshToken === undefined)
    return { permanent: "setup_token" };
  return { token: oauth.accessToken };
}

function codexCredential() {
  const auth = readJson(
    join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
  );
  if (!auth) return NO_CREDENTIAL;
  const token = auth.tokens?.access_token;
  if (!token)
    return auth.OPENAI_API_KEY
      ? { permanent: "api_key_account" }
      : NO_CREDENTIAL;
  return { token, accountId: auth.tokens.account_id };
}

const toMs = (iso) => {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// Each parser returns [{pct, resetsAt}] or null on schema drift.
function claudeWindows(body) {
  const wins = [body?.five_hour, body?.seven_day].filter(
    (w) => w && typeof w === "object",
  );
  if (!wins.length || wins.some((w) => typeof w.utilization !== "number"))
    return null;
  return wins.map((w) => ({ pct: w.utilization, resetsAt: toMs(w.resets_at) }));
}

function codexWindows(body, now) {
  const rl = body?.rate_limit ?? body;
  const wins = [rl?.primary_window, rl?.secondary_window].filter(
    (w) => w && typeof w === "object",
  );
  if (!wins.length || wins.some((w) => typeof w.used_percent !== "number"))
    return null;
  return wins.map((w) => {
    // reset_at is absolute epoch seconds; reset_after_seconds is relative to now.
    const resetsAt =
      typeof w.reset_at === "number"
        ? w.reset_at * 1000
        : typeof w.reset_after_seconds === "number"
          ? now + w.reset_after_seconds * 1000
          : null;
    return { pct: w.used_percent, resetsAt };
  });
}

function classify(windows) {
  if (!windows) return { ...UNKNOWN };
  const full = windows.filter((w) => w.pct >= 100);
  if (!full.length) return { state: "available", resets_at: null };
  const times = full.map((w) => w.resetsAt).filter((t) => t !== null);
  return {
    state: "limited",
    resets_at: times.length ? Math.max(...times) : null,
  };
}

const PROVIDERS = {
  claude: {
    url: "https://api.anthropic.com/api/oauth/usage",
    credential: claudeCredential,
    headers: (c) => ({
      Authorization: `Bearer ${c.token}`,
      "anthropic-beta": "oauth-2025-04-20",
    }),
    windows: (body) => claudeWindows(body),
  },
  codex: {
    url: "https://chatgpt.com/backend-api/wham/usage",
    credential: codexCredential,
    headers: (c) => ({
      Authorization: `Bearer ${c.token}`,
      ...(c.accountId ? { "ChatGPT-Account-Id": c.accountId } : {}),
    }),
    windows: codexWindows,
  },
};

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

// HELM_USAGE_PROBE_BASE_URL swaps the origin only (acceptance drives a stub server). Loopback only:
// anything else would send the OAuth bearer to an arbitrary host.
function endpoint(spec, provider, log) {
  const base = process.env.HELM_USAGE_PROBE_BASE_URL;
  if (!base) return spec.url;
  let origin = null;
  try {
    const u = new URL(base);
    if (["http:", "https:"].includes(u.protocol) && LOOPBACK.has(u.hostname))
      origin = u.origin;
  } catch {
    // unparsable: ignored below
  }
  if (!origin) {
    log("usage_probe_base_url_ignored", "warn", {
      params: { provider, reason: "not_loopback" },
    });
    return spec.url;
  }
  return `${origin}${new URL(spec.url).pathname}`;
}

async function fetchState(spec, cred, { fetchImpl, now, provider, log }) {
  const res = await fetchImpl(endpoint(spec, provider, log), {
    method: "GET",
    headers: spec.headers(cred),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) return { ...UNKNOWN, http_status: res.status };
  return {
    ...classify(spec.windows(await res.json(), now())),
    http_status: 200,
  };
}

/**
 * @returns {{state: "available"|"limited"|"unknown", resets_at: number|null, http_status: number|null,
 *   permanent?: true, reason?: string}}
 *   permanent+reason ("setup_token"|"api_key_account"|"no_credential") means: never poll again this episode.
 */
export async function readUsage(
  provider,
  { fetchImpl = fetch, now = Date.now, readCredential, log = defaultLog } = {},
) {
  // Real monotonic clock: `now` may be frozen (HELM_NOW / injected) and is for state decisions only.
  const started = performance.now();
  const spec = PROVIDERS[provider];
  let result = { ...UNKNOWN };
  try {
    const cred = spec && (readCredential ?? spec.credential)(provider);
    if (cred?.permanent)
      result = { ...UNKNOWN, permanent: true, reason: cred.permanent };
    else if (cred?.token)
      result = await fetchState(spec, cred, { fetchImpl, now, provider, log });
  } catch {
    // Never log the error: its text could carry credentials. State stays unknown.
    result = { ...UNKNOWN };
  }
  log("usage_probe", "info", {
    params: { provider },
    result: { state: result.state, http_status: result.http_status },
    latency: Math.round(performance.now() - started),
  });
  return result;
}
