---
name: tasks
description: "Use Helm for scheduled, recurring, or future work: task jobs, skill-backed assignments, managed-agent runs, deterministic commands, daemon health, run history, logs, and skill refresh. Trigger whenever work must run later, recur, be inspected after dispatch, or be made durable."
version: 3
---

# Helm Tasks and Assignments

Helm is an agent-first local scheduler behind the `tldr-agents` front door:

- `tldr-agents tasks` manages ordinary scheduled jobs, the daemon, service health, history, and logs.
- `tldr-agents assignments` manages skill-backed agent work with durable instructions.

Run `tldr-agents` from the same installed plugin as this loaded skill. Resolve
`../../bin/tldr-agents` relative to this skill's absolute `SKILL.md` path supplied by
the host. A matching `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT` can provide that
parent directory when set. Check the launcher is executable. Never use a bare
`tldr-agents`, `helm-tasks`, or `helm-assignments` from PATH; those may point to
another build. In each shell, set `TLDR_BIN` to the resolved absolute launcher
path before using the recipes below.

```sh
TLDR_BIN="<absolute installed plugin root>/bin/tldr-agents"
```

Every command supports `--help` and `--help-json`. Commands return a JSON
envelope; use `--pretty` when reading it manually. Treat a create/update exit
code as a request acknowledgement, then read the stored object and run history.

## Choose the durable primitive

| Work                                       | Command                                                         |
| ------------------------------------------ | --------------------------------------------------------------- |
| Recurring or re-runnable agent judgment    | `tldr-agents assignments create`                                |
| One-off agent work without a durable skill | `tldr-agents tasks schedule --prompt ... --provider <provider>` |
| Deterministic command or script            | `tldr-agents tasks schedule --command <command> -- ...`         |

Choose one schedule flag: `--in`, `--at`, `--cron`, or `--every`.

## Assignments

An assignment has a durable backing skill at
`.helm/assignments/{slug}/SKILL.md`. Prefer it whenever recurring work needs
judgment, review, or ongoing refinement.

Before creating an assignment, ask the user to choose a provider permission
mode from `tldr-agents assignments runtime-options --pretty`; never infer the
permission posture. Creation also requires the user to explicitly choose
`--completion-delivery <activity|notify|conversation>`; ask the user which delivery promise applies and never infer it.

```bash
"$TLDR_BIN" assignments runtime-options --pretty
"$TLDR_BIN" assignments create \
  --name "Daily repository review" \
  --description "Review recent changes and record the highest-risk follow-ups." \
  --cron "0 8 * * 1-5" \
  --provider codex \
  --permission-mode workspace-write \
  --completion-delivery activity \
  --pretty
"$TLDR_BIN" assignments show "Daily repository review" --pretty
```

Without `--skill`, Helm scaffolds the backing skill. Replace its placeholders
with a concrete goal, numbered steps, output expectations, and references.
Use `--skill <path>` to adopt an existing one. The backing skill belongs in the
workspace, not a global agent-skill root.

The stored assignment records `completion_delivery`. A terminal run has a
separate `work_status` and `communication_status`; do not use one as a proxy
for the other. Tightbeam association fields are opaque, bind-once execution
metadata: retain `origin_thread_id` and `completion_message_id` verbatim when
reading a run, and do not attempt to replace them with Helm-owned thread state.

An assignment's required report command names its run explicitly
(`tasks report --run <run_id> --job <job_id> --status …`); copy it from the
job context rather than relying on `HELM_RUN_ID` reaching your tool shell. A
report that answers `recorded: false` / `not recorded` wrote nothing — rerun it
with `--run` and `--job` from the job context.

### Assignment delivery through Subspace

For `notify` or `conversation`, the assignment's first external user send must
select the reply-capable `subspace` route. Reuse the exact returned
`conversation_id` for the run and report the exact returned `conversation_id`
and terminal `message_id` with `--origin-thread` and `--completion-message`.
Do not substitute Helm thread IDs, provider IDs, or reconstructed values.

Headless assignment execution and daemon resumes are non-interactive and never
use `await_reply`. Only an interactive Agent Pane App Server message that
explicitly asks an external user to respond may use it, with the exact runtime
sender endpoint/process generation, `none` effect, and a reply-capable route.
Informational notifications omit it.

Tightbeam mints an opaque reply binding when Subspace claims a reply-capable
delivery. Agents, Helm, and provider adapters do not mint or decode that
binding. A provider reply publishes only the binding, body, stable external
event ID, and provider metadata; it supplies no raw conversation, route,
principal, endpoint, or lifecycle fields. Listener state never authorizes
ingress, and adapters do not call listener or lifecycle operations.

If `channels.reply-binding.v1` or a reply-capable `subspace` route is missing,
do not fabricate delivery evidence. Report the truthful work result so Helm
records `needs_review`.

Manage and verify with:

```bash
"$TLDR_BIN" assignments list --status all --pretty
"$TLDR_BIN" assignments show <id-or-name> --pretty
"$TLDR_BIN" assignments path <id-or-name> --pretty
"$TLDR_BIN" assignments update <id-or-name> --cron "0 9 * * 1-5" --pretty
"$TLDR_BIN" assignments run <id-or-name> --pretty
"$TLDR_BIN" assignments runs <id-or-name> --pretty
"$TLDR_BIN" assignments completion <run-id> --pretty
"$TLDR_BIN" assignments logs <run-id>
"$TLDR_BIN" assignments archive <id-or-name> --pretty
"$TLDR_BIN" assignments unarchive <id-or-name> --pretty
```

Use assignment ids verbatim. `archive` stops future scheduling while retaining
the backing skill and history; it is not a destructive delete. Use `retarget`
to move an assignment between workspaces while keeping its id and history.

## Jobs

Use `tldr-agents tasks schedule` for a disposable managed-agent run or a deterministic
command. Use an absolute `--cwd` unless the current directory is intentional.

```bash
# One disposable agent run
"$TLDR_BIN" tasks schedule --cwd /abs/project --id pr-risk-review --in 2h \
  --prompt "Review open changes and summarize the highest-risk items." \
  --provider codex --pretty

# One deterministic job; arguments after -- pass through literally
"$TLDR_BIN" tasks schedule --cwd /abs/project --id nightly-sync --cron "0 3 * * *" \
  --command node -- scripts/nightly-sync.mjs
```

Managed-agent jobs expose `execution_hints.provider` and
`execution_hints.managed: true`. Finished history includes captured session
information when the provider supports it.

A scheduled command job returns once it survives a short startup window but
stays running: history shows the real exit (`success`, or `failure` with
`exit_code_N`) when the command ends, not when it started.

A managed-agent or provider job is handed off once its session starts. Until
the session ends, history shows the run as `started` and the job's
`last_status` is `started`. When the session exits, history records the
outcome: `success`, or `failure` with `exit_code_N` or `signal_<SIG>`.
`tasks run` returns `ok: true` once the run has started.

A provider that decides on purpose not to start a session can exit 0 after
printing exactly one stdout line:

```text
{"type":"helm.skip","version":1,"source":"academy","reason":"run_lock_busy","agent":"<name>","job_id":"<HELM_JOB_ID>"}
```

The run is then recorded as `skipped` with that `reason`, and `last_status` is
`skipped`. No fallback agent runs. A non-zero exit, a session id seen first, or
exit 0 with neither still counts as a failed start and follows
`fallback_policy`.

To re-register an existing job idempotently, use `schedule --merge`: it creates
the job if missing and otherwise changes only the flags you pass, keeping
conditions, env, metadata, and hand-set schedule fields. `--replace` redefines
the job from exactly the flags given. Both keep run history and an operator
pause.

## Email me when it finishes

Before promising an email notification, check
`"$TLDR_BIN" status --json`. Helm has no email channel; the job's own
Tightbeam send carries the email. If `data.capabilities.email.state` is not
`connected`, or that send is refused with `no_outbound_channels`, nothing is
scheduled to email. Say exactly:

> Email isn’t connected, so nothing has been sent. Connect email now?

Make this offer once. If the user declines, say the notification is not
scheduled. Use another channel only after the user explicitly chooses it; never
substitute one silently.

If the user accepts, keep the notification promise as a private draft, then
start the setup skill's email connection (`"$TLDR_BIN" setup --json`). Pass the
summary on stdin or with `--body-file <path>`, never as an argument:

```bash
"$TLDR_BIN" drafts create --kind notification --body-file - <<'EOF'
Email me when the nightly build finishes.
EOF
```

A draft holds only the request. Never ask for an API key or verification code
in chat, command arguments, or files; the user enters them only in the tldr;
app.

When email connects in the same conversation, schedule it with the reviewed job
spec (JSON, as for `tasks create --stdin`):

```bash
"$TLDR_BIN" drafts confirm --id <draft-id> --job-file - --cwd /abs/project <<'EOF'
<reviewed job JSON>
EOF
```

Confirm creates one job tagged with the draft ID, in the workspace the first
attempt recorded. After a successful confirm the draft is gone: a repeat
returns `DRAFT_NOT_FOUND` and schedules nothing, so check
`"$TLDR_BIN" tasks list --cwd <cwd> --tag <draft-id>` instead of confirming
again. `state: committing` with `retryable` means an earlier attempt may
already have sent or scheduled it: say so, and confirm again with the same
`--job-file`; that retry finds the job (`reused: true`) instead of creating
another. The job is not activated: report
its returned `lifecycle_status`, `enabled`, `next_run_at`, and `cwd`, and run
`"$TLDR_BIN" tasks up --cwd <cwd>` if the scheduler is not running.

In a later session, or after a long delay, run `"$TLDR_BIN" drafts list`. For
each notification draft, once email is connected, show its summary as
`{summary}` and ask:

> Email is connected. This earlier request is still pending: {summary}. Send or schedule it now?

Never confirm a draft from an earlier session without the user’s explicit yes.
On no, close it with `"$TLDR_BIN" drafts discard --id <draft-id>`. Discard
schedules nothing. If it reports `previous_state: committing`, an earlier
attempt may already have scheduled the job; check
`"$TLDR_BIN" tasks list --cwd <commit_cwd> --tag <draft-id>` and tell the user
what it shows.

## Inspect and operate

```bash
"$TLDR_BIN" tasks status --cwd /abs/project --deep --pretty
"$TLDR_BIN" tasks get --id <job-id> --pretty
"$TLDR_BIN" tasks job-status --id <job-id> --pretty
"$TLDR_BIN" tasks history --id <job-id> --limit 5 --pretty
"$TLDR_BIN" tasks logs --id <job-id> --follow
"$TLDR_BIN" tasks doctor --cwd /abs/project --pretty
"$TLDR_BIN" tasks up --cwd /abs/project --pretty
"$TLDR_BIN" tasks skills refresh --pretty
```

If the scheduler reports `desired_state_blocked`, it is fail-closed. Set the
workspace desired state to live only when that is the intended operator action,
then retry. After updating Helm, refresh skills so the single current teaching
skill replaces the retired Helm-owned skill directories.

## Common mistakes

- Put recurring judgment in an assignment instead of an unstructured prompt.
- Put deterministic work in a command job instead of an assignment.
- Do not infer provider permission mode or completion delivery.
- Do not claim success until `show`/`get`, history, and logs confirm it.
- Preserve the separate work and communication outcomes when reporting a run.
