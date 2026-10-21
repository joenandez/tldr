import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { STATE_ROOT_PARENT } from "./state_root_layout.mjs";

// The owner's AgentMail key, inbox id, and owner address on Linux/WSL, where
// no Aegis helper holds them. Every read fails closed: a loose mode or a
// Windows-mounted path (/mnt/...) is refused. The key is never logged.

export class OwnerCredentialsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OwnerCredentialsError";
    this.code = code;
  }
}

const insecure = (message) =>
  new OwnerCredentialsError("owner_credentials_insecure", message);
const invalid = (message) =>
  new OwnerCredentialsError("owner_credentials_invalid", message);

export function ownerCredentialsPath({ home = homedir() } = {}) {
  return join(home, STATE_ROOT_PARENT, "credentials", "owner.json");
}

const underMnt = (path) => path === "/mnt" || path.startsWith("/mnt/");

function validate(value) {
  const fields = ["apiKey", "inboxId", "ownerAddress"];
  for (const field of fields) {
    if (typeof value?.[field] !== "string" || value[field].trim() === "")
      throw invalid(`owner credentials field ${field} is missing or empty`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.ownerAddress))
    throw invalid("owner credentials ownerAddress is not an email address");
  const { apiKey, inboxId, ownerAddress } = value;
  return { apiKey, inboxId, ownerAddress };
}

// Same shape as today's destination_masked: "o***@example.com".
export function maskDestination(address) {
  const match = /^([^\s@])[^\s@]*@([^\s@]+)$/.exec(address ?? "");
  return match ? `${match[1]}***@${match[2]}` : null;
}

export function readOwnerCredentials({ home, logger } = {}) {
  const file = ownerCredentialsPath({ home });
  const log = (event, extra = {}) => logger?.({ event, path: file, ...extra });
  const refuse = (error) => {
    log("owner_credentials_refused", { code: error.code });
    return error;
  };
  if (underMnt(resolve(file)))
    throw refuse(insecure("owner credentials path is under /mnt/"));
  // Resolve the folder and the file itself, so a symlink at either level is
  // checked where the key actually lives.
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const realFile = real(file);
  if ([real(dirname(file)), realFile].some((path) => path && underMnt(path)))
    throw refuse(insecure("owner credentials resolve under /mnt/"));
  if (!realFile)
    throw refuse(
      new OwnerCredentialsError(
        "owner_credentials_missing",
        "owner credentials file not found",
      ),
    );
  const fileMode = statSync(realFile).mode;
  if (statSync(dirname(realFile)).mode & 0o077)
    throw refuse(
      insecure("owner credentials folder has group or other bits set"),
    );
  if (fileMode & 0o077)
    throw refuse(
      insecure("owner credentials file has group or other bits set"),
    );
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(realFile, "utf8"));
  } catch {
    throw refuse(invalid("owner credentials file is not valid JSON"));
  }
  try {
    const result = validate(parsed);
    log("owner_credentials_read", {
      destination_masked: maskDestination(result.ownerAddress),
    });
    return result;
  } catch (error) {
    throw refuse(error);
  }
}

export function writeOwnerCredentials(credentials, { home, logger } = {}) {
  const value = validate(credentials);
  const file = ownerCredentialsPath({ home });
  if (underMnt(resolve(file)))
    throw insecure("owner credentials path is under /mnt/");
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A symlinked folder must not carry the key onto the Windows mount.
  if (underMnt(realpathSync(dir)))
    throw insecure("owner credentials resolve under /mnt/");
  chmodSync(dir, 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  logger?.({
    event: "owner_credentials_written",
    path: file,
    destination_masked: maskDestination(value.ownerAddress),
  });
  return file;
}
