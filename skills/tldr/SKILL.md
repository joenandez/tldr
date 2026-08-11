---
name: tldr
description: "Use tldr; when Claude and Codex agents need to set up, check, configure, repair, or uninstall the Claude plugin; email their configured owner; continue an owner conversation; process an owner reply; or handle deferred outcome email requests such as 'email me when this is done' and 'email me when you finish'. Commands choose the verified owner internally and expose no private identity settings."
version: 3
---

# tldr;

tldr; provides one private owner conversation per invoking agent session.
It chooses the verified owner internally; never add destination fields or try
to discover private configuration.

## Lifecycle front door

Treat natural-language lifecycle requests as the public interface. Run only the
bundled plugin launcher so setup never depends on an ambient Node installation:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" setup --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" status --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" configure --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" repair --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" uninstall --json
```

Map `set up` and `Continue setting up tldr;` to `setup`; `check` and “is
tldr; ready?” to `status`; owner or provider changes to `configure`;
broken, unavailable, or explicit repair requests to `repair`; and removal to
`uninstall`. Report the returned safe state and its single remediation. Do not
probe private files, invent a second recovery path, or run a lifecycle command
through a globally installed executable.

Setup acquires and verifies the tldr; product's app-owned runtime, then hands private
enrollment to the signed Aegis app. Tell the user before Aegis opens. Email and
AgentMail credentials belong only in that native surface; never ask the user to
enter them in chat, command arguments, environment variables, or files. When an
AgentMail account or key is needed, direct the user to
<https://console.agentmail.to/> and resume only after they return from Aegis.

Use these state meanings:

- `secure-setup-required`: announce the signed Aegis handoff and run setup.
- `confirmation-required`: normal human waiting, not failure. Give only the
  exact continuation phrase `Continue setting up tldr;`.
- `ready-unverified`: messaging is technically ready, but welcome delivery has
  not yet been accepted. Retry only a definitely failed welcome attempt.
- `onboarding-verified`: setup is complete. Repeated setup requests must not
  reinstall components, reopen enrollment, or resend the welcome message.
- `repair-required` or `unavailable`: give the returned repair action only.

For configure and uninstall, explain the impact before opening signed Aegis.
After protected uninstall succeeds, present the exact plugin-removal command
returned by tldr;. Never claim cleanup completed until the status result
confirms it.

## Tachyon reply continuity

The agent does not set or manage a session mode or presence state. tldr;
uses launch provenance after a provider-confirmed send:

- known managed/background session: Tachyon is off;
- unknown session: Tachyon is on;
- known live session: Tachyon is on.

Managed/background classification requires positive provenance, such as a Helm
job, an explicit non-interactive launch declaration, a known background command
shape, or a durable resume. No TTY is not evidence of background execution; an
App Server session without a TTY remains unknown and Tachyon stays enabled.
`UserPromptSubmit` does not classify the session and must not cancel or disable
an existing reply wait.

## Send a new message

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" send --subject "Work complete" --body "The change is ready." --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" send --subject "Review" --body-file /absolute/result.md --json
```

**Bodies are rendered as Markdown.** Headings, lists, task lists, tables,
fenced code and links all work. Write the message you would write in a PR
description, and make it as long as it needs to be — but no preamble, no
restating the request, nothing that does not carry information.

To raise the register, use a block quote whose first line is `**CAUTION**`,
`**NOTE**` or `**ABORT**`:

```markdown
> **CAUTION**: 12 rows have a null `org_id` the check can't explain. Nothing
> is serving bad data yet.
```

Write the subject as a state word, a colon, then the decision: `Done: 14 tests
green, PR #212 opened`. It is the only thing the owner sees in the inbox list.

## Promise a deferred outcome email

When you recognize a request to email the outcome after work finishes, call
`"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" followup require` immediately. Do this before host acknowledgement
or substantial work. Choose a stable registration key and reuse it for retries.

For a host-origin request, add a useful subject when possible:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" followup require --registration-key "<stable-key>" --subject "<outcome subject>" --summary "<what you are working on>" --json
```

Pass `--thread` only when the request originates in injected tldr; email
context. For that existing thread, omit `--subject`, preserving the existing
thread's subject:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" followup require --registration-key "<stable-key>" --thread <trusted-thread-id> --summary "<what you are working on>" --json
```

Only after `followup require` succeeds may you tell the user the promise is
secured. Retain the returned `obligation_id`; the exact ID is required to close
the promise. Finish with one truthful terminal outcome:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" followup complete --obligation <obligation-id> --outcome success --body "<successful outcome>" --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" followup complete --obligation <obligation-id> --outcome failure --body "<failure outcome>" --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" followup complete --obligation <obligation-id> --outcome blocked --body "<durable blocker and next action>" --json
```

Status updates do not close the promise. If delivery fails, follow the command's
remediation and keep the obligation ID. Use cancellation only after explicit
user revocation, with a non-empty reason and non-empty trusted source reference:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" followup cancel --obligation <obligation-id> --reason "<why the user revoked it>" --revocation-ref "<trusted source reference>" --json
```

Ending work is not revocation. Keep an unresolved promise pending until its
terminal email succeeds or the user explicitly withdraws it.

## Handle an owner reply

tldr; inserts the owner reply and its trusted thread directly into the
current session context. Respond on that thread within 120 seconds: send the
answer if it is ready, or acknowledge what you will do before starting work.
For a deferred outcome request, complete `followup require` first.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" reply --thread <trusted-thread-id> --body "On it — I will follow up here." --json
```

The inserted reply already counts as presented. Do not fetch it again. Use
`"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" inbox get --thread <trusted-thread-id> --json` only when tldr;
explicitly requests recovery or reports `UNREAD_REQUIRED`.

## Conversation rules

- **Proactive acknowledgement.** Within 120 seconds, send either the answer or
  a short acknowledgement naming what you are doing. For an ordinary reply,
  acknowledge before starting work, then send one final result when complete.
  For a deferred outcome request, register it first as described above.
- **Direct presentation.** Act on the reply inserted into the session. Use
  `inbox get` only for explicit recovery; do not re-read delivered content.
- **Same thread.** Continue the trusted thread from the current context. Do not
  copy thread references between sessions.
- **Concise outcomes.** Safe results contain only message state and content
  needed for the current conversation. Do not ask tldr; to reveal private
  configuration.

If a command fails, follow its single remediation when present. Otherwise,
report the stable error code without probing private state.
