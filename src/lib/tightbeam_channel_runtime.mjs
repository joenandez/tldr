import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TIGHTBEAM_CONTRACT = Object.freeze({
  package: "tightbeam",
  version: "0.2.0",
  minProtocol: "1.0",
  maxProtocol: "1",
  schemaVersion: 14,
  capability: "channels.v1",
});
export const AUTHORITY = "tldr-email";
export const APPLICATION = "tldr-email";
export const PRINCIPAL_REF = "verified-owner";
export const ENDPOINT_SESSION = "tldr-email-owner";

export function unavailable() {
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: "TIGHTBEAM_INCOMPATIBLE",
      message: "tldr; requires a compatible Tightbeam installation.",
      retryable: false,
      remediation:
        "Install Tightbeam 0.2.0 with channels.v1 support, then rerun setup.",
    }),
  });
}

export function commandFailure(result) {
  return result?.ok !== true || result?.result?.compatible === false;
}

export function defaultIdentityStore(home) {
  const path = join(home, "tightbeam-email-identity.json");
  return Object.freeze({
    async load() {
      try {
        const identity = JSON.parse(await readFile(path, "utf8"));
        return typeof identity?.app_id === "string" &&
          typeof identity?.app_secret === "string"
          ? identity
          : null;
      } catch {
        return null;
      }
    },
    async save(identity) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    },
  });
}

export async function productionRun({ command, admin, credentials, args }) {
  const commandArgs = ["--json"];
  if (admin) commandArgs.unshift("--admin");
  if (credentials) commandArgs.unshift("--app-id", credentials.app_id);
  commandArgs.push(...args);
  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH,
        TIGHTBEAM_STATE_ROOT: process.env.TIGHTBEAM_STATE_ROOT,
        TIGHTBEAM_APP_SECRET: credentials?.app_secret,
      },
    });
    return JSON.parse(stdout);
  } catch (error) {
    const output = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`;
    if (
      admin &&
      args[0] === "authority" &&
      args[1] === "register" &&
      args[2] === AUTHORITY &&
      (/identity_conflict/.test(output) ||
        /authority named "tldr-email" is already registered/.test(output))
    ) {
      return { ok: true, result: { already_registered: true } };
    }
    return null;
  }
}

export function expectedPreflightArgs() {
  return [
    "preflight",
    "--min-protocol",
    TIGHTBEAM_CONTRACT.minProtocol,
    "--max-protocol",
    TIGHTBEAM_CONTRACT.maxProtocol,
    "--expect-schema",
    String(TIGHTBEAM_CONTRACT.schemaVersion),
    "--require-capability",
    TIGHTBEAM_CONTRACT.capability,
    "--expect-daemon-version",
    TIGHTBEAM_CONTRACT.version,
  ];
}

export function inboundKey(providerMessageId) {
  return `tldr-email-inbound-${createHash("sha256")
    .update(providerMessageId)
    .digest("hex")
    .slice(0, 32)}`;
}
