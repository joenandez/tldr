---
name: messaging
description: Use Tightbeam for communication between independent agent sessions, or between an agent and the user through registered external channels. Use it to request work or a response from another agent, reply to Tightbeam messages, send an informational message, or notify the external user. Do not use it for the current interactive chat or for subagents working inside the current task.
---

# Tightbeam

## Choose the right mechanism

- Reply normally to the user in the current interactive session.
- Use a subagent for temporary delegated work within the current task.
- Use Tightbeam to communicate with an independent agent session or with the
  user through a registered external channel.

## Stable agent launcher

Run Tightbeam through the `tldr-agents` front door from the same installed plugin as
this loaded skill: `tldr-agents messaging <command>`. Resolve `../../bin/tldr-agents`
relative to this skill's absolute `SKILL.md` path supplied by the host. A
matching `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT` can provide that parent
directory when set. Check the resolved launcher is executable.
Never use bare `tldr-agents` or `tightbeam` from PATH or the standalone
`~/.tightbeam/install` copy; any of them could select a different product
build. Set this variable to the resolved absolute path in each shell that runs
a recipe:

```sh
TLDR_BIN="<absolute installed plugin root>/bin/tldr-agents"
```

Hook notifications print recipes with this plugin's launcher already
resolved (`<absolute installed plugin root>/bin/tldr-agents messaging agent …`);
run them as printed. A resume brief may name the bare
`tldr-agents messaging agent …`; run that as `"$TLDR_BIN" messaging agent …`
with the same arguments.

## Write message bodies

Write user-facing and agent-facing bodies as portable Markdown that remains
clear when another agent reads it as raw text. Use actual newline characters,
not literal `\n` sequences. Tldr email renders supported CommonMark and
GitHub-style structures, but do not rely on raw HTML or format-specific tricks.
Use `--body-file` for multiline or structurally rich content to avoid
shell-quoting damage.

## Reply to a received user message

Every message received from the user through an external channel already
creates an obligation to respond. The notification does not include the
message body. Do not create a request for it; reply to the received message
directly with its notification message ID when you already know what to say,
or first receive the exact notification message ID with
`agent receive --message <message-id>` to inspect the body:

```sh
"$TLDR_BIN" messaging agent reply --message <message-id> --body "<reply>" --wait-delivery 30s
```

Only exact receipt returns the body. It validates this endpoint/session and is
safe to retry by the same owner:

```sh
"$TLDR_BIN" messaging agent receive --message <message-id>
```

This sends the final response on the original conversation and channel.
Tightbeam and Ariadne track the user-response obligation automatically; reply
uses the existing completion path and preserves delivery-confirmed closure.
Acknowledgement remains an instruction, not an automatic tool lock or mandatory next action.

Stop on `Delivery confirmed`. This confirms channel delivery, not that the user
has read the reply. If the bounded wait expires, the reply is already committed:
use the returned `next_action` to wait on that same outbound message; do not
resend. On `Delivery failed`, report the failure without automatic resending.
An unavailable check is not evidence of failed delivery.

If work continues, acknowledge progress without completing the request:

```sh
"$TLDR_BIN" messaging agent ack --work <work-id> --body "I am investigating this now."
```

When an acknowledgement is overdue, the tool gate blocks every other tool call
until you send it. It admits only these exact commands, with the resolved
launcher path written out (no variable, no quotes around the path) and a body in
plain double quotes containing no `"`, `$`, backtick, or backslash:

```text
<absolute installed plugin root>/bin/tldr-agents messaging agent ack --work <work-id> --body "I am investigating this now."
<absolute installed plugin root>/bin/tldr-agents messaging agent inbox --unread
```

Use `update` for subsequent progress and `reply` or `complete` for the final
result. A simple test acknowledgement can itself be the final response.

## Communicate with another agent

Address an agent as `agent:<runtime>:<absolute-workspace>`, where the runtime
is `claude-code` or `codex`: for example `agent:claude-code:/work/acme` or
`agent:codex:/work/acme`. This identifies the agent for that workspace;
Tightbeam delivers to its active session or starts or resumes one as needed.

When an agent needs to respond or do something, use `request`:

```sh
"$TLDR_BIN" messaging agent request --to agent:codex:/work/acme --subject "Review" --reason "Need independent review" --body "Please review this" --completion-mode message_committed
```

A request opens tracked work and returns a work ID. Use that ID to report
progress, finish, cancel, or inspect the request:

```sh
"$TLDR_BIN" messaging agent update --work <work-id> --body "Reviewing now"
"$TLDR_BIN" messaging agent complete --work <work-id> --body "Review complete"
"$TLDR_BIN" messaging agent cancel --work <work-id> --reason "Cannot reproduce"
"$TLDR_BIN" messaging agent status --work <work-id>
```

Use `send` only when no response or action is expected:

```sh
"$TLDR_BIN" messaging agent send --to agent:codex:/work/acme --subject "Deployment" --reason "Inform peer" --body "FYI: deployment completed" --no-reply
```

Reply to an ordinary, untracked agent message with its message ID:

```sh
"$TLDR_BIN" messaging agent reply --message <message-id> --body "Acknowledged" --no-reply
```

## Start an external user message

To start a new external user message, use the registered channel routes:

```sh
"$TLDR_BIN" messaging agent send --to user --subject "Update" --reason "Notify user" --body "<message>"
"$TLDR_BIN" messaging agent send --to user --subject "Update" --reason "Notify user" --body "<message>" --channel <selector>
"$TLDR_BIN" messaging agent send --to user --subject "Update" --reason "Notify user" --body "<message>" --channel all
```

Omitting `--channel` uses every available send-capable route. Use explicit
selectors to narrow delivery, or `--channel all` to make the fanout explicit.
If no active send-capable route is available, Tightbeam refuses before writing
a message or delivery.

Every successfully delivered external-user send or reply on a reply-capable
channel is response-required automatically. Tightbeam creates the durable,
exact-session response wait; it becomes eligible once the channel accepts the
delivery.

Omit the retired `--await-reply` flag. Tightbeam owns the response waits and
durable fallback; the channel app only transports the eventual response back
to Tightbeam. Waiting for outbound delivery with `--wait-delivery` is separate
from waiting for the user's next reply.

For self-owned work that should notify the user when finished:

```sh
"$TLDR_BIN" messaging agent request --to self --subject "Work result" --reason "Notify on completion" --body "<work>" --completion-mode delivery_confirmed --notify user --channel <selector>
"$TLDR_BIN" messaging agent complete --work <work-id> --body "<result>" --wait-delivery 30s
```

Opening with `--notify user` records the selected routes. Completion uses that
stored selection exactly once and closes work only after every selected route
delivers; partial or failed routes leave the work visible through
`"$TLDR_BIN" messaging agent status --work <work-id>`.

## Check messages and delivery

```sh
"$TLDR_BIN" messaging agent inbox --unread
"$TLDR_BIN" messaging agent status --message <outbound-message-id> --wait-delivery 30s
```

Report returned status accurately: `committed` or `pending` does not mean
`delivered`. Use status with the outbound message ID returned by reply/complete,
not the inbound notification's ID. For obligation conflicts, follow the exact
`complete --work` or `update --work` action in the error. Delivery-status
permission errors require the correct outbound target, not a doctor check.
For setup or connection errors, run `"$TLDR_BIN" messaging doctor`.
Every agent subcommand supports `--help` without a session.

## Offline and resume

Offline messages wait durably through Tightbeam's explicit resume path. If
notification context is missing, inspect
`"$TLDR_BIN" messaging agent inbox --unread`, then reply to the matching
message ID directly. Hook notifications carry no body themselves. For an
interactive session, the oldest unread message is notified at
T+0, one bodyless retry is made available at T+30, and at T+60 Tightbeam may
resume the same provider session once with its rotated ownership token. The
successor must adopt that token and explicitly receive the oldest message;
stale predecessor generations are refused. Process evidence is advisory, not a
delivery prerequisite, so absent or malformed Codex/Claude process facts do
not block this availability takeover. Tightbeam guarantees exactly-once message
receipt and one current Tightbeam generation, not one vendor process or
transcript writer. Subspace, not Tightbeam, owns transcript drift.
