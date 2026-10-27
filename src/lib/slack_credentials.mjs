import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { writeTextAtomic } from "./durable_file_io.mjs";
import { tldrAgentHomeFor } from "./store.mjs";

// Slack bot/app tokens in a 0600 file under the tldr agent home (Mac and WSL
// share the path). Reads fail closed on loose modes, symlinks, and /mnt.
// Token values are never logged and never placed in error messages.

export class SlackCredentialsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SlackCredentialsError";
    this.code = code;
  }
}

const insecure = (message) =>
  new SlackCredentialsError("slack_credentials_insecure", message);
const invalid = (message) =>
  new SlackCredentialsError("slack_credentials_invalid", message);

export function slackCredentialsPath({ home = tldrAgentHomeFor() } = {}) {
  return join(home, "credentials", "slack.json");
}

const underMnt = (path) => path === "/mnt" || path.startsWith("/mnt/");
const PREFIXES = { botToken: "xoxb-", appToken: "xapp-" };

function validate(value) {
  for (const [field, prefix] of Object.entries(PREFIXES)) {
    const token = value?.[field];
    if (typeof token !== "string" || !token.startsWith(prefix))
      throw invalid(`slack ${field} must start with ${prefix}`);
  }
  for (const field of ["ownerUserId", "teamId"]) {
    const id = value[field] ?? null;
    if (id !== null && (typeof id !== "string" || id === ""))
      throw invalid(`slack ${field} must be a non-empty string or null`);
  }
  const { botToken, appToken } = value;
  return {
    botToken,
    appToken,
    ownerUserId: value.ownerUserId ?? null,
    teamId: value.teamId ?? null,
  };
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

function checkReadable(file) {
  if (underMnt(resolve(file)))
    throw insecure("slack credentials path is under /mnt/");
  const realFile = real(file);
  if ([real(dirname(file)), realFile].some((path) => path && underMnt(path)))
    throw insecure("slack credentials resolve under /mnt/");
  if (!realFile) return null;
  if (lstatSync(file).isSymbolicLink())
    throw insecure("slack credentials file is a symlink");
  if (statSync(dirname(realFile)).mode & 0o077)
    throw insecure("slack credentials folder has group or other bits set");
  if (statSync(realFile).mode & 0o077)
    throw insecure("slack credentials file has group or other bits set");
  return realFile;
}

export function readSlackCredentials({ home, logger } = {}) {
  const file = slackCredentialsPath({ home });
  const log = (event, extra = {}) => logger?.({ event, path: file, ...extra });
  try {
    const realFile = checkReadable(file);
    if (!realFile) {
      log("slack_credentials_absent", { status: "absent" });
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(realFile, "utf8"));
    } catch {
      throw invalid("slack credentials file is not valid JSON");
    }
    const result = validate(parsed);
    log("slack_credentials_read", { status: "ok" });
    return result;
  } catch (error) {
    log("slack_credentials_refused", { status: "refused", code: error.code });
    throw error;
  }
}

// Last observed Slack facts (bot_token, app_token, route), "ok" or the
// problem, one file each so the daemon and the listener never overwrite each
// other. Offline status reads them, so a broken Slack never reads as
// connected (AC-6). New or deleted credentials void every fact.
const HEALTH_FACT = /^(bot_token|app_token|route)$/u;
const slackHealthDir = (home = tldrAgentHomeFor()) =>
  join(home, "slack", "health");

function readFact(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function recordSlackHealth(fact, value, { home } = {}) {
  const file = join(slackHealthDir(home), fact);
  if (readFact(file) !== value) writeTextAtomic(file, value);
}

// Facts whose last observation was a problem, e.g. ["bot_token"].
export function slackHealthProblems({ home } = {}) {
  const dir = slackHealthDir(home);
  let facts = [];
  try {
    facts = readdirSync(dir).filter((name) => HEALTH_FACT.test(name));
  } catch {
    return [];
  }
  return facts.filter((fact) => readFact(join(dir, fact)) !== "ok");
}

export function writeSlackCredentials(credentials, { home, logger } = {}) {
  const value = validate(credentials);
  const file = slackCredentialsPath({ home });
  if (underMnt(resolve(file)))
    throw insecure("slack credentials path is under /mnt/");
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (underMnt(realpathSync(dir)))
    throw insecure("slack credentials resolve under /mnt/");
  chmodSync(dir, 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  rmSync(slackHealthDir(home), { recursive: true, force: true });
  logger?.({ event: "slack_credentials_written", status: "ok", path: file });
  return file;
}

export function deleteSlackCredentials({ home, logger } = {}) {
  const file = slackCredentialsPath({ home });
  const existed = !!real(file) || !!lstatOrNull(file);
  rmSync(file, { force: true });
  rmSync(slackHealthDir(home), { recursive: true, force: true });
  logger?.({ event: "slack_credentials_deleted", path: file, result: existed });
  return existed;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
