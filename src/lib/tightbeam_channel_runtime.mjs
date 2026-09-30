import { execFile } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeTextAtomic } from "./durable_file_io.mjs";

const execFileAsync = promisify(execFile);

export const TIGHTBEAM_COMPATIBILITY = Object.freeze({
  minProtocol: "1.0",
  maxProtocol: "1",
  requiredCapabilities: Object.freeze([
    "channels.v1",
    "channels.reply-binding.v1",
    "listener.v1",
  ]),
});
// This package's own Tightbeam launcher, libexec/tightbeam at the package
// root (off every PATH; bin/ holds only the front door). TIGHTBEAM_BIN
// overrides it; the retired standalone ~/.tightbeam/install copy is never a
// default.
export const PACKAGE_TIGHTBEAM_BIN = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "libexec",
  "tightbeam",
);

export function defaultTightbeamCommand(env = process.env) {
  return env.TIGHTBEAM_BIN || PACKAGE_TIGHTBEAM_BIN;
}

export const AUTHORITY = "tldr-email";
export const APPLICATION = "tldr-email";
export const WELCOME_APPLICATION = "tldr-welcome";
export const PRINCIPAL_REF = "verified-owner";
export const ENDPOINT_SESSION = "tldr-email-owner";
export const WELCOME_ENDPOINT_SESSION = "tldr-welcome-sender";

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

export function identityInvalid() {
  return Object.freeze({
    ok: false,
    data: null,
    error: Object.freeze({
      code: "TLDR_EMAIL_IDENTITY_INVALID",
      message: "tldr; cannot trust its local Tightbeam email identity.",
      retryable: false,
      remediation: "Repair tldr;",
    }),
  });
}

function invalidIdentityState() {
  const error = new Error("TLDR Tightbeam email identity is invalid");
  error.code = "TLDR_EMAIL_IDENTITY_INVALID";
  return error;
}

export function debugIdentity(stage, data = {}) {
  if (process.env.TLDR_AGENT_DEBUG_TIGHTBEAM_IDENTITY !== "1") return;
  process.stderr.write(
    `[🪳 TEMP tldr-enrollment-state-recovery] ${stage} ${JSON.stringify(data)}\n`,
  );
}

export function commandFailure(result) {
  return result?.ok !== true || result?.result?.compatible === false;
}

export function defaultIdentityStore(home) {
  const path = join(home, "tightbeam-email-identity.json");
  return Object.freeze({
    async load() {
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw invalidIdentityState();
      }
      if (!metadata.isFile()) throw invalidIdentityState();
      let identity;
      try {
        identity = JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw invalidIdentityState();
      }
      if (
        typeof identity?.app_id !== "string" ||
        identity.app_id.length === 0 ||
        typeof identity?.app_secret !== "string" ||
        identity.app_secret.length === 0 ||
        (identity.welcome !== undefined &&
          (typeof identity.welcome?.app_id !== "string" ||
            identity.welcome.app_id.length === 0 ||
            typeof identity.welcome?.app_secret !== "string" ||
            identity.welcome.app_secret.length === 0))
      ) {
        throw invalidIdentityState();
      }
      return identity;
    },
    async save(identity) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      writeTextAtomic(path, `${JSON.stringify(identity)}\n`, {
        durable: true,
        mode: 0o600,
      });
    },
  });
}

// commandPrefix carries the Tightbeam entrypoint when command is the
// already-verified runtime node rather than the libexec/tightbeam launcher.
export async function productionRun({
  command,
  commandPrefix = [],
  admin,
  credentials,
  args,
}) {
  const commandArgs = ["--json"];
  if (admin) commandArgs.unshift("--admin");
  if (credentials) commandArgs.unshift("--app-id", credentials.app_id);
  commandArgs.push(...args);
  try {
    const { stdout } = await execFileAsync(
      command,
      [...commandPrefix, ...commandArgs],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TLDR_AGENT_HOME: process.env.TLDR_AGENT_HOME,
          TIGHTBEAM_STATE_ROOT: process.env.TIGHTBEAM_STATE_ROOT,
          TIGHTBEAM_APP_SECRET: credentials?.app_secret,
        },
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const output = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}`;
    const registeredApplication = args[2];
    if (
      admin &&
      args[0] === "app" &&
      args[1] === "register" &&
      [APPLICATION, WELCOME_APPLICATION].includes(registeredApplication) &&
      /identity_conflict/.test(output) &&
      output.includes(
        `application named "${registeredApplication}" is already registered`,
      )
    ) {
      return {
        ok: false,
        data: null,
        error: { code: "TIGHTBEAM_APPLICATION_IDENTITY_CONFLICT" },
      };
    }
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
    // The CLI reports a daemon refusal only on stderr (`error <code>: ...`,
    // exit 1). Keep that code so a caller can tell an expected refusal, such
    // as the idle `claim_held` of delivery.claim, from a real failure (item 49).
    const refusal = /^error ([a-z][a-z_]{0,63}): /mu.exec(
      String(error?.stderr ?? ""),
    );
    return {
      ok: false,
      data: null,
      error: {
        code: "TIGHTBEAM_OPERATION_FAILED",
        ...(refusal ? { tightbeam_code: refusal[1] } : {}),
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
