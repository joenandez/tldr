import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeTextAtomic } from "./durable_file_io.mjs";
import { renderTldrAgentWelcomeEmail } from "./transports/email/templates.mjs";

export const WELCOME_IDEMPOTENCY_KEY = "tldr-agent-welcome:v1";
export const WELCOME_REASON =
  "Confirm the setup session can receive owner replies";
const execFileAsync = promisify(execFile);
const WELCOME_EVIDENCE_VERSION = 1;
const WELCOME_EVIDENCE_FILE = "welcome-evidence.json";
const SAFE_WELCOME_REMEDIATION =
  "Start a new supported agent session, then rerun tldr; setup.";
const DEFINITE_TIGHTBEAM_FAILURE_CODES = new Set([
  "session_unavailable",
  "route_unavailable",
  "permission_denied",
  "bootstrap_required",
]);

async function noWelcomeEvidence() {
  return "not-started";
}

function status(value, remediation = null) {
  return Object.freeze({
    status: value,
    ...(typeof remediation === "string" && remediation.length > 0
      ? { remediation }
      : {}),
  });
}

function sessionEnvironment(session) {
  const sessionId = session?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  return session?.identity?.runtime === "codex"
    ? { CODEX_THREAD_ID: sessionId }
    : { CLAUDE_CODE_SESSION_ID: sessionId };
}

function welcomeData(result) {
  const value = result?.result ?? result?.data ?? result;
  if (!value || typeof value !== "object") return {};
  const delivery = Array.isArray(value.channel_deliveries)
    ? value.channel_deliveries.find(
        (item) =>
          item?.selector === "email" && typeof item.delivery_id === "string",
      )
    : null;
  return Object.fromEntries(
    [
      ["message_id", value.message_id],
      ["conversation_id", value.conversation_id],
      ["delivery_id", value.delivery_id ?? delivery?.delivery_id],
      ["outcome", value.outcome],
    ].filter(
      ([, fieldValue]) =>
        typeof fieldValue === "string" && fieldValue.length > 0,
    ),
  );
}

async function productionSessionRun({
  command,
  args,
  env,
  exec = execFileAsync,
}) {
  try {
    const { stdout } = await exec(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      env,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const output = String(error?.stdout ?? "").trim();
    if (output) {
      try {
        return JSON.parse(output);
      } catch {
        // The launch completed but did not return an interpretable result.
      }
    }
    const stderr = String(error?.stderr ?? "");
    const stableCode = stderr.match(/(?:^|\n)error ([a-z][a-z0-9_]*):/i)?.[1];
    if (
      /(?:^|\n)usage error:/i.test(stderr) ||
      DEFINITE_TIGHTBEAM_FAILURE_CODES.has(stableCode)
    ) {
      return {
        ok: false,
        error: {
          code: stableCode ?? "tightbeam_usage_error",
          ambiguous: false,
        },
      };
    }
    return {
      ok: false,
      error: {
        code:
          error?.code === "ENOENT"
            ? "tightbeam_unavailable"
            : "welcome_send_failed",
        ambiguous: error?.code !== "ENOENT",
      },
    };
  }
}

export function createSessionWelcomeDispatcher({
  command = process.env.TIGHTBEAM_BIN ||
    join(
      process.env.HOME ?? homedir(),
      ".tightbeam",
      "install",
      "bin",
      "tightbeam",
    ),
  stateRoot = process.env.TIGHTBEAM_STATE_ROOT,
  session,
  run = productionSessionRun,
  evidence = null,
} = {}) {
  const identityEnvironment = sessionEnvironment(session);
  return async ({ subject, body } = {}) => {
    if (!identityEnvironment) {
      return {
        ok: false,
        error: {
          code: "session_unavailable",
          ambiguous: false,
          remediation: SAFE_WELCOME_REMEDIATION,
        },
      };
    }
    try {
      await evidence?.begin();
    } catch {
      return {
        ok: false,
        error: { code: "welcome_evidence_unavailable", ambiguous: true },
      };
    }
    const result = await run({
      command,
      args: [
        "--json",
        "agent",
        "send",
        "--to",
        "user",
        "--channel",
        "email",
        "--subject",
        subject,
        "--reason",
        WELCOME_REASON,
        "--body",
        body,
      ],
      env: {
        PATH: process.env.PATH,
        TIGHTBEAM_STATE_ROOT: stateRoot,
        ...identityEnvironment,
      },
    });
    const unavailable = result?.error?.code === "session_unavailable";
    const normalized = unavailable
      ? {
          ok: false,
          error: {
            code: "session_unavailable",
            ambiguous: false,
            remediation: SAFE_WELCOME_REMEDIATION,
          },
        }
      : result?.ok === true
        ? { ok: true, data: welcomeData(result) }
        : result;
    try {
      await evidence?.complete(normalized);
    } catch {
      return {
        ok: false,
        error: { code: "welcome_evidence_unavailable", ambiguous: true },
      };
    }
    return normalized;
  };
}

function evidenceRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set([
    "version",
    "status",
    "timestamp",
    "message_id",
    "conversation_id",
    "delivery_id",
    "outcome",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.version !== WELCOME_EVIDENCE_VERSION ||
    typeof value.status !== "string" ||
    typeof value.timestamp !== "string"
  ) {
    return null;
  }
  return value;
}

export function createWelcomeEvidenceStore({
  home,
  path = join(home || "", WELCOME_EVIDENCE_FILE),
  now = () => new Date().toISOString(),
  write = writeTextAtomic,
  read = readFile,
  findProviderAcceptanceByDelivery = async () => null,
} = {}) {
  function writeRecord(record) {
    write(path, `${JSON.stringify(record)}\n`, { durable: true, mode: 0o600 });
  }

  async function readRecord() {
    try {
      return evidenceRecord(JSON.parse(await read(path, "utf8")));
    } catch (error) {
      return error?.code === "ENOENT" ? undefined : null;
    }
  }

  return Object.freeze({
    path,
    async begin() {
      writeRecord({
        version: WELCOME_EVIDENCE_VERSION,
        status: "dispatching",
        timestamp: now(),
      });
    },
    async complete(result) {
      const data = welcomeData(result);
      const definiteFailure =
        result?.ok === false && result?.error?.ambiguous !== true;
      writeRecord({
        version: WELCOME_EVIDENCE_VERSION,
        status: definiteFailure
          ? "failed"
          : result?.ok === true
            ? "returned"
            : "ambiguous",
        timestamp: now(),
        ...data,
      });
    },
    async read() {
      const record = await readRecord();
      if (record === undefined) return "not-started";
      if (record === null) return "ambiguous";
      if (record.status === "failed") return "failed";
      if (typeof record.delivery_id !== "string") return "ambiguous";
      try {
        return (await findProviderAcceptanceByDelivery(record.delivery_id))
          ? "accepted"
          : "ambiguous";
      } catch {
        return "ambiguous";
      }
    },
  });
}

function debugSetupTemplateDrift(stage, data) {
  if (process.env.TLDR_AGENT_DEBUG_TEMPLATE_DRIFT !== "1") return;
  process.stderr.write(
    `[🪳 TEMP SETUP_EMAIL_TEMPLATE_DRIFT] ${stage} ${JSON.stringify(data)}\n`,
  );
}

export function createStarportOnboarding({
  sessionId,
  scope,
  home = null,
  owner = "owner",
  readEvidence = noWelcomeEvidence,
  dispatchMessage = null,
} = {}) {
  if (!sessionId || !scope?.scope_id) {
    throw new TypeError("Starport onboarding requires setup session and scope");
  }

  let failedRemediation = null;

  async function readStatus() {
    const evidence = await readEvidence({
      scope,
      home,
      idempotencyKey: WELCOME_IDEMPOTENCY_KEY,
    });
    return status(
      ["accepted", "ambiguous", "failed"].includes(evidence)
        ? evidence
        : "not-started",
    );
  }

  async function send() {
    const before = await readStatus();
    if (before.status === "accepted" || before.status === "ambiguous") {
      return before;
    }
    if (typeof dispatchMessage !== "function") return status("failed");
    const template = renderTldrAgentWelcomeEmail();
    debugSetupTemplateDrift("setup-welcome-dispatch", {
      template_version: template.template_version,
      idempotency_key: WELCOME_IDEMPOTENCY_KEY,
    });
    let delivery;
    try {
      delivery = await dispatchMessage({
        kind: "new",
        owner,
        sessionId,
        scope,
        subject: template.subject,
        body: template.body,
        idempotencyKey: WELCOME_IDEMPOTENCY_KEY,
        emailState: "conversation",
        replyInstruction: template.replyInstruction,
        securityNotice: template.securityNotice,
        tldrAgentReplyCandidate: true,
        home,
      });
    } catch (error) {
      return status(error?.ambiguous === true ? "ambiguous" : "failed");
    }
    if (delivery?.ok === false && delivery.error?.ambiguous !== true) {
      failedRemediation =
        typeof delivery.error?.remediation === "string"
          ? delivery.error.remediation
          : null;
      const afterFailure = await readStatus();
      return afterFailure.status === "not-started"
        ? status("failed", failedRemediation)
        : status(afterFailure.status, failedRemediation);
    }
    if (delivery?.error?.ambiguous === true) return status("ambiguous");
    const after = await readStatus();
    return after.status === "accepted" ? after : status("ambiguous");
  }

  return Object.freeze({ status: readStatus, send });
}

export const _internals = Object.freeze({
  DEFINITE_TIGHTBEAM_FAILURE_CODES,
  noWelcomeEvidence,
  SAFE_WELCOME_REMEDIATION,
  WELCOME_EVIDENCE_FILE,
  WELCOME_EVIDENCE_VERSION,
  evidenceRecord,
  sessionEnvironment,
  productionSessionRun,
  welcomeData,
});
