---
name: setup
description: "Use tldr; to check messaging, scheduled tasks, email, and Slack status, connect or disconnect email or Slack, repair a capability, or uninstall the plugin's product."
version: 4
---

# tldr;

tldr; gives agents messaging and scheduled tasks as soon as the plugin is installed. Email is an optional, later connection for reaching the user outside a session. This skill answers status per capability and guides one lifecycle action at a time; it is not a general messaging interface.

## Lifecycle front door

Run only the [bundled launcher](../../bin/tldr-agents), the `tldr-agents` front door, from the same installed plugin as this loaded skill. When the current host provides its plugin-root environment variable, use the matching command block below.

If that variable is unset, resolve `../../bin/tldr-agents` relative to the directory containing this skill's absolute `SKILL.md` path supplied by the host's skill catalog. Invoke that resolved, quoted absolute launcher path with the requested operation and `--json`. This does not require a plugin-root environment variable. Use the exact loaded skill location, not the working directory, a guessed cache version, or another installed copy. Check that the resolved launcher exists and is executable before invoking it.

```bash
# Claude Code
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agents" setup --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agents" status --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agents" configure --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agents" repair --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agents" uninstall --json

# Codex
"${PLUGIN_ROOT}/bin/tldr-agents" setup --json
"${PLUGIN_ROOT}/bin/tldr-agents" status --json
"${PLUGIN_ROOT}/bin/tldr-agents" configure --json
"${PLUGIN_ROOT}/bin/tldr-agents" repair --json
"${PLUGIN_ROOT}/bin/tldr-agents" uninstall --json
```

Map what the user says to one operation:

- “Set up email for tldr;”, “Connect email”, “Continue setting up email”, “Continue setting up tldr;”, or set up: `setup`.
- “Check tldr;” or “is tldr; ready?”: `status`; report a Slack line (for example “Slack: connected”) alongside the other capabilities.
- “Change owner” or “Replace API key”: `configure`.
- “Disconnect email”: `configure`, then **Disconnect Email** in the app.
- “Fix email” or “Repair tldr;”: `repair`.
- “Set up Slack for tldr;”: `setup --channel slack`.
- “Fix Slack”: `repair --channel slack`.
- “Disconnect Slack”: `configure --channel slack disconnect`.
- “Uninstall tldr;”: `uninstall`.

Do not probe private files, invent another recovery path, or use a globally installed executable. Stop for unavailable bundled launcher context only when neither the host's plugin-root variable nor the loaded skill's absolute path resolves an executable bundled launcher; an unset variable alone is not a failure.

## First use and status

Messaging and scheduled tasks never wait for email. Never promise an automatic message after installation; the user discovers tldr; through this skill, status, and first use. On a first tldr; question, run `status`; when messaging and tasks are ready and email is not connected, say:

“tldr; is ready for agent messaging and scheduled tasks. Email is optional. Say ‘Set up email for tldr;’ whenever you want agents to reach you outside a session.”

Answer status from `data.capabilities`, one line per capability. Do not answer from `data.state`; it is kept only for older callers. On a healthy install that never connected email, the legacy state may ask for setup so older callers do not loop on repair. When messaging and tasks are ready and email is not connected, say exactly:

“Messaging: ready. Scheduled tasks: ready. Email: not connected.”

Otherwise use the same shape with plain words: ready, needs attention, not connected, setup not complete, or connected. Report each capability from its own entry. If a reply has no `data.capabilities`, say you couldn’t read tldr; status; give the reply's own remediation when it has one, and do not guess a capability state or start email setup from it.

- **Messaging or tasks needs attention:** name only that capability and run its returned `remediation`: replace the leading `tldr-agents` with the resolved launcher path. Messaging or scheduled-task repair never opens the tldr; app, and email status stays as reported.
- **Email pending:** “Email setup isn’t complete. Messaging and scheduled tasks still work. Say ‘Continue setting up email’ when you’re ready.”
- **Email disconnect not finished:** when `email.next_action` is `finish-email-disconnect`, do not offer repair; repair would reconnect email. Say: “Email disconnect isn’t finished. Messaging and scheduled tasks are still available. I’ll open the tldr; app so you can finish disconnecting email there.” Then run `configure`.
- **Email needs attention:** “Email needs attention. Messaging and scheduled tasks are still available. {single action}” Replace `{single action}` with one sentence offering the returned repair.
- **Email connected:** report it as connected. A welcome delivery problem never demotes a connected email; when `email.welcome_delivery` is `ambiguous` or `failed`, say: “Email is connected, but I can’t yet confirm the welcome message was delivered. I’ll check that delivery before trying again.” Never resend an uncertain welcome. Retry only a definitely failed welcome message, once, with the top-level `data.remediation` when one is returned.

## Connect email

Run `setup` only when the user asks to connect email, accepts a Connect email offer from the messaging or tasks skill, or continues an unfinished email setup. First run `status`. If email is already connected, do not run `setup`; say:

“Email is already connected. No setup or new welcome email is needed.”

Otherwise say the handoff and run `setup` without asking again:

“I’ll open the signed tldr; app to connect email. You’ll need an AgentMail API key and access to your email. Enter the key and verification code only in the app.”

Never ask for an API key or verification code in chat, command arguments, environment variables, or files. The app resumes at the next unfinished step:

- **Background access:** macOS needs tldr; allowed in the background so email replies can reach agent sessions. In the app, choose **Open Login Items**, turn on **tldr;**, then choose **Continue**.
- **AgentMail key:** without a key, sign in to AgentMail, open **API Keys**, choose **Create New API Key**, name it “tldr; on this Mac,” and copy it into the app only.
- **Verification:** the code arrives by email and is entered in the app. You can't see or submit it.

Read the `setup` result from `data.capabilities.email`:

- **Connected:** “Email is connected. Agents can reach you outside a session. You can reply to the welcome email to test the round trip; replying is optional.” Use the welcome copy above instead when welcome delivery is ambiguous or failed.
- **Pending or not connected** (the app was closed, canceled, or is waiting for a code): use the paused copy above. Nothing was connected and messaging and tasks still work.
- **Needs attention:** use the email attention copy above.

After email connects, run `drafts list` through the same launcher. For each pending email request, follow the review prompt in the messaging and tasks skills; never send one without the user's explicit yes. `already_committed` means it was already sent. `state: committing` with `retryable` means an earlier attempt may already have sent it; say so instead of calling it unsent.

## Connect Slack

Run the Slack operations above only when the user asks. Setup serves a local page; the user does the Slack clicks there. Report Slack from its own `status` entry; Slack problems never change messaging, tasks, or email.

- Run `setup --channel slack` in the background. Add `--agents <name,name>` to create a private channel for each name now (for example `--agents clio,stow`). Or add `--agents-json <file|->` (`-` reads stdin) with rows `{name,cwd,runtime,command}`; this gives each name a launch command so a new top-level post starts a session. It cannot be combined with `--agents`.
- **Not an Academy agent** (no `ACADEMY_AGENT_NAME` in the environment): run `setup --channel slack` without `--agents` or `--agents-json`.
- **Academy agent:** get your rows from `academy list --slack-rows <name>` and pipe them in: `academy list --slack-rows <name> | tldr-agents setup --channel slack --agents-json -`.
- Read the `url` and `steps` line from its output. Send the user the link and that line, unchanged (“Open this link and follow the 3 steps on the page.”). The page shows the steps one at a time; do not repeat them in chat. Never open a browser; links only.
- When the command exits, report its result. “Slack: connected” means done. If it says the channels failed, run the retry command it prints. When you are not an Academy agent, after “Slack: connected” say exactly: “Slack works with your Academy Owners and Principals. Ask one of them, or tell me which agent should get a channel.”

Slack tokens are pasted only into the local setup page, never in chat, arguments, or environment variables. If the user pastes a token in chat, tell them to revoke or rotate it in Slack and rerun setup. To add channels later: `tldr-agents slack channels add <name>...`. To add one Academy agent's channel with its launch command: `academy list --slack-rows <name> | tldr-agents slack channels add --agents-json -`.

## Repair, disconnect, and uninstall

- **Repair:** run `repair` and give only its returned remediation. When email was never connected, repair covers only messaging and tasks and names the affected capability. Correctable email input errors stay in the app.
- **Change owner or replace API key:** run `configure`; the change happens in the app.
- **Disconnect email:** run `configure` and tell the user to choose **Disconnect Email** in the app's email settings and review what stops before confirming. The app may block the disconnect until pending email is reviewed, or report it incomplete with a retry. Then run `status`; only when email is no longer connected, say: “Email disconnected. Agent messaging and scheduled tasks are still available.” The user can connect email again later with setup.
- **Uninstall tldr;:** this is full removal, not an email change. Before `uninstall`, say: “Uninstalling tldr; stops agent messaging, scheduled tasks, and email on this Mac and removes protected tldr; settings. This does not remove the host plugin. I’m opening the tldr; app so you can review and confirm the removal.” If email was never connected, macOS may first ask for administrator approval to install the signed app. Never claim removal completed until the result reports it. On success, present the exact plugin-removal command it returns. For public installs, Claude Code uses `claude plugin uninstall tldr@tldr` and Codex uses `codex plugin remove tldr@tldr`; local installs must use their actual marketplace suffix. If removal is incomplete, say so and offer to retry.

If any lifecycle command fails, follow its single remediation when present. Otherwise report the stable error code without probing private state.
