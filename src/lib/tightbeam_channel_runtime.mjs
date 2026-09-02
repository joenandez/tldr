import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TIGHTBEAM_COMPATIBILITY = Object.freeze({
  minProtocol: "1.0",
  maxProtocol: "1",
  requiredCapabilities: Object.freeze(["channels.v1"]),
});
export const AUTHORITY = "tldr-email";
export const APPLICATION = "tldr-email";
export const PRINCIPAL_REF = "verified-owner";
export const ENDPOINT_SESSION = "tldr-email-owner";

export function unavailable(failedDimensions = []) {
  const dimensions = [
    ...new Set(
      failedDimensions.filter(
        (dimension) => typeof dimension === "string" && dimension.length > 0,
      ),
    ),
  ];
  const diagnostic = dimensions.length
    ? ` Failed compatibility dimension${dimensions.length === 1 ? "" : "s"}: ${dimensions.join(", ")}.`
    : "";
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: "TIGHTBEAM_INCOMPATIBLE",
      message: "tldr; requires a compatible Tightbeam installation.",
      retryable: false,
      remediation: `Install Tightbeam with supported protocol ${TIGHTBEAM_COMPATIBILITY.minProtocol} through ${TIGHTBEAM_COMPATIBILITY.maxProtocol} and required capability ${TIGHTBEAM_COMPATIBILITY.requiredCapabilities.join(", ")}, then rerun setup.${diagnostic}`,
    }),
  });
}

export function launcherUnavailable() {
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: "TIGHTBEAM_UNAVAILABLE",
      message: "tldr; cannot launch the activated Tightbeam installation.",
      retryable: false,
      remediation:
        "Activate Tightbeam, approve plugin trust, or start a new session, then rerun setup.",
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
    if (typeof error?.stdout === "string" && error.stdout.trim().length > 0) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        // A launched command that emits malformed data is not a missing launcher.
      }
    }
    if (
      ["ENOENT", "EACCES", "EPERM"].includes(error?.code) ||
      (error?.errno && !error?.stdout)
    )
      return null;
    return {
      ok: false,
      data: null,
      error: {
        code: "TIGHTBEAM_OPERATION_FAILED",
        message:
          "tldr; launched Tightbeam but it did not return a valid response.",
        retryable: false,
      },
    };
  }
}

export function expectedPreflightArgs() {
  return [
    "preflight",
    "--min-protocol",
    TIGHTBEAM_COMPATIBILITY.minProtocol,
    "--max-protocol",
    TIGHTBEAM_COMPATIBILITY.maxProtocol,
    ...TIGHTBEAM_COMPATIBILITY.requiredCapabilities.flatMap((capability) => [
      "--require-capability",
      capability,
    ]),
  ];
}

export function inboundKey(providerMessageId) {
  return `tldr-email-inbound-${createHash("sha256")
    .update(providerMessageId)
    .digest("hex")
    .slice(0, 32)}`;
}
