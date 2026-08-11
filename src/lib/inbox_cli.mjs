import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { helmSessionsRoot } from "./identity_state.mjs";
import { markRead } from "./substrate/blocked_unread.mjs";

export const INBOX_GET_EXIT_CODES = {
  message_not_found: 4,
  permission_denied: 5,
  transport_error: 1,
};

const CANONICAL_KEYS = [
  "message_id",
  "thread_id",
  "from",
  "to",
  "subject",
  "ts",
  "body",
  "routing_metadata",
  "headers",
];

function errorEnvelope(error, messageId, extra = {}) {
  return { ok: false, error, data: { message_id: messageId, ...extra } };
}

function isPermissionError(err) {
  return err?.code === "EACCES" || err?.code === "EPERM";
}

function canonicalPayload(row) {
  return {
    message_id: row.message_id ?? null,
    thread_id: row.thread_id ?? null,
    from: row.from ?? row.sender?.address ?? row.sender ?? null,
    to: row.to ?? row.recipients ?? [],
    subject: row.subject ?? null,
    ts: row.ts ?? row.created_at ?? row.queued_at ?? null,
    body: row.body ?? "",
    routing_metadata: row.routing_metadata ?? row.metadata ?? {},
    headers: row.headers ?? {},
  };
}

function parseInboxLine(line, file) {
  try {
    return JSON.parse(line);
  } catch (err) {
    const wrapped = new Error(`failed to parse ${file}: ${err.message}`);
    wrapped.code = "EJSONPARSE";
    throw wrapped;
  }
}

function scanInboxFile(file, messageId) {
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line || !line.includes(messageId)) continue;
    const row = parseInboxLine(line, file);
    if (row?.message_id === messageId) {
      return row;
    }
  }
  return null;
}

export function truncateAtSentenceBoundary(body, limit = 280) {
  const text = String(body ?? "");
  if (text.length <= limit) return text;
  const lowerBound = Math.min(200, limit);
  let boundary = -1;
  const re = /[.!?;](?=\s)/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const end = match.index + 1;
    if (end >= lowerBound && end <= limit) boundary = end;
    if (end > limit) break;
  }
  if (boundary !== -1) return text.slice(0, boundary);
  return `${text.slice(0, limit)}…`;
}

export function getInboxMessage({ scope = null, messageId, opts = {} } = {}) {
  void scope;
  void opts;
  if (!messageId || typeof messageId !== "string") {
    return errorEnvelope("message_not_found", messageId || "");
  }
  const root = helmSessionsRoot();
  let sessionIds;
  try {
    try {
      statSync(root);
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR")
        return errorEnvelope("message_not_found", messageId);
      if (isPermissionError(err))
        return errorEnvelope("permission_denied", messageId);
      return errorEnvelope("transport_error", messageId, {
        reason: err.message,
      });
    }
    sessionIds = readdirSync(root)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch (err) {
    if (isPermissionError(err))
      return errorEnvelope("permission_denied", messageId);
    return errorEnvelope("transport_error", messageId, { reason: err.message });
  }

  for (const sessionId of sessionIds) {
    const file = join(root, sessionId, "inbox.jsonl");
    try {
      try {
        statSync(file);
      } catch (err) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR") continue;
        if (isPermissionError(err))
          return errorEnvelope("permission_denied", messageId);
        return errorEnvelope("transport_error", messageId, {
          reason: err.message,
        });
      }
      const row = scanInboxFile(file, messageId);
      if (!row) continue;
      try {
        markRead({ scope, sessionId, messageId, via: "cli_get" });
      } catch (err) {
        process.stderr.write(
          `# inbox get mark-read failed: ${err?.message || String(err)}\n`,
        );
      }
      return {
        ok: true,
        data: canonicalPayload(row),
        meta: { session_id: sessionId, path: file },
      };
    } catch (err) {
      if (isPermissionError(err))
        return errorEnvelope("permission_denied", messageId);
      return errorEnvelope("transport_error", messageId, {
        reason: err.message,
      });
    }
  }
  return errorEnvelope("message_not_found", messageId);
}

export function renderInboxGetHelp() {
  return [
    "helm-tasks inbox get - read one canonical inbound message by message_id",
    "",
    "Usage:",
    "  helm-tasks inbox get <message-id> [--json|--pretty|--text] [--scope <path>]",
    "",
    "Options:",
    "  --json        Print the default JSON envelope.",
    "  --pretty      Pretty-print the JSON envelope.",
    "  --text        Print only the full body field.",
    "  --scope PATH  Resolve workspace scope from PATH.",
    "  --help        Show this help.",
    "  --help-json   Print machine-readable command metadata.",
    "",
    "Examples:",
    "  helm-tasks inbox get msg_abc123 --json",
    "  helm-tasks inbox get msg_abc123 --text",
    "",
    "Errors:",
    "  message_not_found exits 4 when the message id is absent.",
    "  permission_denied exits 5 when the inbox store cannot be read.",
    "  transport_error exits 1 for malformed JSONL or other I/O failures.",
  ].join("\n");
}

export function renderInboxHelp() {
  return [
    "helm-tasks inbox - inspect inbound substrate state",
    "",
    "Usage:",
    "  helm-tasks inbox get <message-id> [--json|--pretty|--text]",
    "  helm-tasks inbox poll [--no-dispatch]",
    "  helm-tasks inbox dispatch [--all-registered]",
    "  helm-tasks inbox reconcile --thread <id> [--no-dispatch]",
    "",
    "Run `helm-tasks inbox get --help` for the message body getter.",
  ].join("\n");
}

export function renderInboxGetHelpJson() {
  return {
    schema_version: 1,
    command: "inbox get",
    usage:
      "helm-tasks inbox get <message-id> [--text|--pretty|--json|--scope <path>|--help|--help-json]",
    flags: ["--text", "--pretty", "--json", "--scope", "--help", "--help-json"],
    output: {
      ok: CANONICAL_KEYS,
      text: "body",
    },
    errors: [
      {
        code: "message_not_found",
        exit_code: INBOX_GET_EXIT_CODES.message_not_found,
      },
      {
        code: "permission_denied",
        exit_code: INBOX_GET_EXIT_CODES.permission_denied,
      },
      {
        code: "transport_error",
        exit_code: INBOX_GET_EXIT_CODES.transport_error,
      },
    ],
  };
}

export function stderrHint(result) {
  if (result.ok) {
    const bytes = Buffer.byteLength(result.data.body || "", "utf8");
    return `# resolved from ${result.meta.path} (byte_length=${bytes})`;
  }
  if (result.error === "message_not_found") {
    return `# message_not_found — ${result.data.message_id} not in canonical inbound store`;
  }
  if (result.error === "permission_denied") {
    return "# permission_denied — cannot read ~/.helm/sessions; fix filesystem permissions or run from the operator account that owns Helm state";
  }
  return `# transport_error — ${result.data.reason || "failed to read canonical inbound store"}`;
}
