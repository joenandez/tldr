// `tldr-agents drafts <verb>`: create, list, confirm, and discard private
// email-intent drafts (plan Technical Approach 4). Runs through
// libexec/component-dispatch on the verified packaged runtime, so it works
// before any email install. The body is read only from stdin
// (`--body-file -`) or a file, never from a command-line argument, so it
// never lands in shell history or a process listing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EmailIntentDraftError,
  createEmailIntentDraftStore,
  logDraftEvent,
} from "./email_intent_drafts.mjs";
import { confirmDraft } from "./email_intent_confirm.mjs";
import { output, parseArgs } from "./json_io.mjs";
import { tldrAgentHomeFor } from "./store.mjs";

export const USAGE_EXIT = 64;
const VERB_FLAGS = Object.freeze({
  create: new Set(["kind", "subject", "body-file", "session"]),
  list: new Set([]),
  confirm: new Set(["id", "job-file", "cwd"]),
  discard: new Set(["id"]),
});
const HELP = `tldr-agents drafts - email requests kept for review until email is connected.

Verbs:
  create   Keep a blocked email request as a private, expiring draft.
  list     List pending drafts with their recipient, content, or summary.
  confirm  Send or schedule one reviewed draft, at most once.
  discard  Close a draft without sending or scheduling anything.

Usage:
  create --kind send --subject <text> --body-file <path>|- [--session <ref>]
  create --kind notification --body-file <path>|- [--session <ref>]
  list
  confirm --id <draft-id>
  confirm --id <draft-id> --job-file <path>|- [--cwd <path>]
  discard --id <draft-id>

The body is read from stdin (--body-file -) or a file, never an argument.
Nothing is sent or scheduled until confirm, after the user reviews it.
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = "usage_error";
  }
}

function checkFlags(verb, { positionals, flags, trailingArgs }, allowed) {
  if (Object.hasOwn(flags, "body")) {
    throw new UsageError(
      "pass the body on stdin with --body-file - or in a file with --body-file <path>, never as an argument",
    );
  }
  const extra = [...positionals.slice(1), ...trailingArgs];
  if (extra.length > 0) {
    throw new UsageError(
      `${verb} takes no positional arguments; pass the body with --body-file <path>|-`,
    );
  }
  for (const [name, value] of Object.entries(flags)) {
    if (!allowed.has(name))
      throw new UsageError(`${verb} does not accept --${name}`);
    if (value === true) throw new UsageError(`--${name} requires a value`);
  }
}

export function readBody(bodyFile, { readStdin }) {
  if (bodyFile === undefined) {
    throw new UsageError(
      "--body-file <path>|- is required; the body is never an argument",
    );
  }
  try {
    return bodyFile === "-" ? readStdin() : readFileSync(bodyFile, "utf8");
  } catch {
    throw new UsageError(
      "--body-file must name a readable file, or - for stdin",
    );
  }
}

function sessionReference(flags, env) {
  if (flags.session) return flags.session;
  if (env.CLAUDE_CODE_SESSION_ID) return `claude:${env.CLAUDE_CODE_SESSION_ID}`;
  if (env.CODEX_THREAD_ID) return `codex:${env.CODEX_THREAD_ID}`;
  throw new UsageError("no current agent session; pass --session <ref>");
}

function requireId(flags) {
  if (!flags.id) throw new UsageError("--id <draft-id> is required");
  return flags.id;
}

function createInput(flags, env, io) {
  const content = readBody(flags["body-file"], io);
  const session = sessionReference(flags, env);
  if (flags.kind === "send") {
    return {
      session,
      action_kind: "send",
      recipient: "user",
      subject: flags.subject,
      content,
    };
  }
  if (flags.kind === "notification") {
    if (flags.subject !== undefined)
      throw new UsageError("--subject is only for --kind send");
    return {
      session,
      action_kind: "notification",
      notification_summary: content,
    };
  }
  throw new UsageError("--kind must be send or notification");
}

function publicDraft({
  claimed_by_pid: _pid,
  claimed_by_start: _start,
  ...draft
}) {
  return draft;
}

// Confirm loads its committer only when used, so create/list/discard never
// import Tightbeam. The user has reviewed the draft before an agent runs this.
function readJobSpec(jobFile, io) {
  if (jobFile === undefined) return null;
  try {
    return JSON.parse(readBody(jobFile, io));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("--job-file must hold the reviewed job as JSON");
  }
}

// Absolute, so a retry from another directory reaches the same workspace.
function commitCwdFor(draft, flags) {
  if (draft?.action_kind !== "notification") return undefined;
  return resolve(flags.cwd ?? process.cwd());
}

async function committerFor(draft, flags, { env, io }) {
  if (draft?.action_kind !== "notification") {
    if (flags["job-file"] !== undefined || flags.cwd !== undefined) {
      throw new UsageError(
        "--job-file and --cwd are only for notification drafts",
      );
    }
    const { createTightbeamDraftSender } = await import(
      "./email_intent_send_commit.mjs"
    );
    return createTightbeamDraftSender({ env });
  }
  const { createHelmDraftJobCommitter } = await import(
    "./email_intent_job_commit.mjs"
  );
  return createHelmDraftJobCommitter({
    cwd: commitCwdFor(draft, flags),
    jobSpec: readJobSpec(flags["job-file"], io),
    env,
  });
}

// Refused before the claim, so a recovered draft keeps its claim record and
// recorded workspace instead of being re-claimed only to fail.
function requireJobFile(draft, flags) {
  if (draft?.action_kind !== "notification" || flags["job-file"]) return;
  throw Object.assign(
    new EmailIntentDraftError(
      "DRAFT_JOB_SPEC_REQUIRED",
      "a notification draft needs the reviewed job as --job-file <path>|-",
    ),
    { details: { id: draft.id, state: draft.state } },
  );
}

// A resolved draft is deleted, so a missing one may have been sent or
// scheduled already; the report never says it was not committed.
function draftNotFound(id) {
  return Object.assign(
    new EmailIntentDraftError(
      "DRAFT_NOT_FOUND",
      `draft ${id} not found; it may already have been sent or scheduled, or it was discarded or expired`,
    ),
    { details: { id, state: "not_found" } },
  );
}

async function confirmVerb(flags, { store, env, io }) {
  const id = requireId(flags);
  const draft = store.get(id);
  // Checked before the kind-specific flags, which a missing draft has no kind for.
  if (!draft) throw draftNotFound(id);
  requireJobFile(draft, flags);
  const commit = await committerFor(draft, flags, { env, io });
  const result = await confirmDraft({
    store,
    id,
    commit,
    commitCwd: commitCwdFor(draft, flags),
  });
  if (!result.ok) {
    if (result.code === "DRAFT_NOT_FOUND") throw draftNotFound(id);
    const { ok: _ok, code, message, ...details } = result;
    throw Object.assign(
      new EmailIntentDraftError(
        code,
        message ?? `draft ${id} was not committed`,
      ),
      { details: { id, ...details } },
    );
  }
  return {
    data: { id, state: result.state, outcome: result.outcome },
    draft: { id },
  };
}

export async function runDraftVerb(argv, { env = process.env, io } = {}) {
  const parsed = parseArgs(argv);
  const verb = parsed.positionals[0];
  const store = () =>
    createEmailIntentDraftStore({ home: tldrAgentHomeFor({ env }) });
  if (!VERB_FLAGS[verb])
    throw new UsageError(`unknown drafts verb: ${verb ?? "(missing)"}`);
  checkFlags(verb, parsed, VERB_FLAGS[verb]);
  const { flags } = parsed;
  if (verb === "create") {
    const draft = store().create(createInput(flags, env, io));
    return { data: { draft: publicDraft(draft) }, draft };
  }
  if (verb === "list") {
    const drafts = store().list().map(publicDraft);
    return { data: { drafts, pending_count: drafts.length } };
  }
  if (verb === "confirm")
    return confirmVerb(flags, { store: store(), env, io });
  const id = requireId(flags);
  const { state, commit_cwd } = store().discard(id);
  return {
    data: { id, discarded: true, previous_state: state, commit_cwd },
    draft: { id },
  };
}

function exitCodeFor(error) {
  if (error instanceof UsageError) return USAGE_EXIT;
  return 1;
}

export async function main(argv, { env = process.env, readStdin } = {}) {
  if (argv.length === 0 || ["--help", "-h", "help"].includes(argv[0])) {
    process.stdout.write(HELP);
    return 0;
  }
  const verb = argv[0];
  const started = Date.now();
  const io = { readStdin: readStdin ?? (() => readFileSync(0, "utf8")) };
  try {
    const result = await runDraftVerb(argv, { env, io });
    output(`drafts.${verb}`, true, result.data);
    logDraftEvent("info", "email_intent_draft.verb", {
      params: {
        verb,
        draft_id: result.draft?.id,
        action_kind: result.draft?.action_kind,
      },
      status: "ok",
      latency_ms: Date.now() - started,
    });
    return result.exitCode ?? 0;
  } catch (error) {
    const known =
      error instanceof UsageError || error instanceof EmailIntentDraftError;
    const code = known ? error.code : "DRAFT_COMMAND_FAILED";
    output(`drafts.${verb}`, false, error.details ?? {}, [
      { code, message: error.message },
    ]);
    logDraftEvent("error", "email_intent_draft.verb", {
      params: { verb },
      status: "failed",
      result: { code },
      latency_ms: Date.now() - started,
      ...(known ? {} : { stack: error?.stack }),
    });
    return exitCodeFor(error);
  }
}
