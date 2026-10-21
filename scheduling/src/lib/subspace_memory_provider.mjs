import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WRAPPER = "bin/helm-job-memory-wrapper";

// Reads only the JWT payload's exp claim; the token itself is never kept.
function tokenExpiryMs(home) {
  try {
    const payload = readFileSync(join(home, "auth-token"), "utf8")
      .trim()
      .split(".")[1];
    const exp = JSON.parse(Buffer.from(payload, "base64url").toString()).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// Each Subspace app refreshes its own auth-token only while it runs, so the
// home baked at service install can be a closed app with an expired token
// (HTTP 401 on memory capture). Pick the home whose token is live now.
// shortcut: a SUBSPACE_HOME equal to the daemon's own is treated as inherited,
// not as a job pin; upgrade by threading the job env separately if that bites.
export function chooseSubspaceHome({
  env = {},
  userHome = homedir(),
  now = Date.now(),
  daemonHome = process.env.SUBSPACE_HOME,
} = {}) {
  const explicit =
    typeof env.SUBSPACE_HOME === "string" ? env.SUBSPACE_HOME.trim() : "";
  const prod = join(userHome, ".subspace");
  const candidates = [prod, join(userHome, ".subspace-alpha")].map((home) => {
    const exp = tokenExpiryMs(home);
    const live =
      exp !== null && exp > now && existsSync(join(home, WRAPPER));
    return { home, live, exp_iso: exp === null ? null : new Date(exp).toISOString() };
  });
  if (explicit && explicit !== daemonHome) {
    return { home: explicit, reason: "job_env", candidates };
  }
  const live = candidates
    .filter((c) => c.live)
    .sort((a, b) => Date.parse(b.exp_iso) - Date.parse(a.exp_iso))[0];
  if (live) return { home: live.home, reason: "live_token", candidates };
  return {
    home: explicit || prod,
    reason: "fallback_no_live_token",
    candidates,
  };
}

export function buildSubspaceProviderLaunch(
  env = {},
  scrubEnv = (value) => ({ ...value }),
  wrapperPath = undefined,
  choice = {},
) {
  const selection = chooseSubspaceHome({ env, ...choice });
  const home = selection.home;
  const bin = join(home, "bin");
  const cleanEnv = scrubEnv(env);
  return {
    selection,
    cleanEnv,
    directEnv: { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH || ""}` },
    wrapper:
      wrapperPath === undefined ? join(home, WRAPPER) : wrapperPath,
    wrapperEnv: {
      ...cleanEnv,
      SUBSPACE_HOME: home,
      PATH: `${bin}:${cleanEnv.PATH || ""}`,
    },
  };
}
