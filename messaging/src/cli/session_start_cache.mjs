// State-root bootstrap stamp and raw channel-catalog cache (contract C3): SessionStart
// reads these instead of asking the daemon, so a slow daemon never holds a session.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { routeOpenTo, slackChannelAdded } from "../protocol/session_env.mjs";

const STAMP_FILE = "bootstrap-stamp";
const CATALOG_FILE = "channel-catalog.json";

const warn = (event, params, error) =>
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event,
      status: "warn",
      params,
      result: { message: String(error?.message ?? error), stack: error?.stack },
    })}\n`,
  );

function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    warn(
      "session_start_cache_read_failed",
      { file: path.basename(file) },
      error,
    );
    return null;
  }
}

export function bootstrapStamp({
  version,
  runtimeNames,
  wakeRuntimeIds,
  authorityName,
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version,
        runtimeNames: [...runtimeNames].sort(),
        wakeRuntimeIds: [...wakeRuntimeIds],
        authorityName,
      }),
    )
    .digest("hex");
}

export const readBootstrapStamp = (stateRoot) =>
  readIfPresent(path.join(stateRoot, STAMP_FILE))?.trim() || null;
export const writeBootstrapStamp = (stateRoot, stamp) =>
  writeAtomic(path.join(stateRoot, STAMP_FILE), stamp);

// Stores the raw daemon answer; per-agent filtering happens at read time.
export const writeCatalogCache = (stateRoot, routes) =>
  writeAtomic(path.join(stateRoot, CATALOG_FILE), JSON.stringify({ routes }));

export function renderOutboundChannelCatalog(routes) {
  const catalog = routes
    .map(({ selector, label }) => ({ selector, label }))
    .sort((a, b) =>
      a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0,
    );
  return `<tightbeam_outbound_channels>\n${JSON.stringify(catalog)}\n</tightbeam_outbound_channels>`;
}

function readCachedRoutes(stateRoot) {
  const raw = readIfPresent(path.join(stateRoot, CATALOG_FILE));
  if (raw === null) return null;
  try {
    const { routes } = JSON.parse(raw);
    if (!Array.isArray(routes)) throw new TypeError("routes is not an array");
    return routes;
  } catch (error) {
    warn("channel_catalog_cache_corrupt", {}, error);
    return null;
  }
}

// Absent, corrupt or malformed cache renders '': SessionStart prints nothing rather than failing.
export function renderCachedCatalog(stateRoot, academyAgentName) {
  const routes = readCachedRoutes(stateRoot);
  if (!routes) return "";
  return renderOutboundChannelCatalog(
    routes.filter(
      ({ selector }) =>
        routeOpenTo(selector, academyAgentName) &&
        (selector !== "slack" || slackChannelAdded(academyAgentName)),
    ),
  );
}
