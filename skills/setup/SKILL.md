---
name: setup
description: "Use tldr; to set up, check, configure, repair, or uninstall the installed plugin."
version: 3
---

# tldr;

tldr; is a lifecycle concierge for setup and safe product management. It guides the user through one current lifecycle action at a time; it is not a general messaging interface.

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

Map `set up` and `Continue setting up tldr;` to `setup`; `check` and “is tldr; ready?” to `status`; owner or provider changes to `configure`; broken, unavailable, or explicit repair requests to `repair`; and removal to `uninstall`. Report the returned safe state and its single returned remediation. Do not probe private files, invent another recovery path, or use a globally installed executable. Stop for unavailable bundled launcher context only when neither the host's plugin-root variable nor the loaded skill's absolute path resolves an executable bundled launcher; an unset variable alone is not a failure.

## Guided setup

Use this predetermined guidance for a first-time setup. Keep sensitive input in the native tldr; app and never ask for an API key or verification code in chat, command arguments, environment variables, or files.

1. **Introduction:** “Let’s set up tldr;. It takes a few minutes. I’ll open the tldr; app, where you’ll connect AgentMail and verify your email. Your email address, API key, and verification code stay in the app and are never included in this chat.”
2. **App handoff:** Start setup, then tell the user to continue in the tldr; app. Wait for its next safe state rather than interpreting private details.
3. **Background access:** “macOS needs you to allow tldr; to run in the background so email replies can reach your agent sessions. In the tldr; app, choose **Open Login Items**, turn on **tldr;**, then choose **Continue**.”
4. **AgentMail key:** “tldr; needs an AgentMail API key. If you don’t have one, sign in to AgentMail, open **API Keys**, choose **Create New API Key**, name it ‘tldr; on this Mac,’ and copy it. Paste the key only into the tldr; app.”
5. **Verification:** “AgentMail is connected. Check your email for the verification code and enter it in the tldr; app. I can’t see or submit that code.”
6. **Finalizing:** Tell the user that tldr; finalizes the existing connection and health checks without exposing internal details.
7. **Success:** “tldr; is ready. The welcome email was sent through its
   private provider bridge. Tightbeam owns any reply routing for the safely
   inherited current session. Replying is optional; setup is complete.”

## Returning, repair, and removal

- **Returning/ready:** For `status`, give the concise ready result without replaying first-time guidance. An already ready installation stays ready and does not repeat setup or the welcome message. Use `configure` only for the existing product settings.
- **Repair:** If health says attention is required, say “tldr; needs attention” and give only the returned repair action. Correctable setup input errors stay in the app; do not turn them into a general repair workflow.
- **Uninstall:** Before `uninstall`, say: “Uninstalling tldr; removes its
  protected owner and AgentMail key, background service, app files, and any
  previously managed hook entries from this Mac. I’m opening the tldr; app so
  you can review and confirm the removal.” Never claim removal completed until
  `status` confirms it. After confirmed removal, present the exact
  plugin-removal command returned by tldr;.

## Safe-state guidance

- `secure-setup-required`: give the introduction and start setup.
- `confirmation-required`: normal human waiting, not failure. Give only `Continue setting up tldr;`.
- `ready-unverified`: setup is ready; continue the current setup guidance.
- `onboarding-verified`: setup is complete. Repeated setup must not reinstall components, reopen enrollment, or repeat the welcome message.
- `onboarding-reconciling`: tldr; is ready, but do not claim the welcome message was delivered. Explain that the welcome message needs confirmation and give only the returned remediation; an ambiguous welcome is reconciled before retry.
- `welcome-delivery-failed`: tldr; is ready. Explain that a definitely failed welcome message can use the single returned remediation without reopening setup.
- `repair-required` or `unavailable`: give the returned repair action only.

If any lifecycle command fails, follow its single remediation when present. Otherwise report the stable error code without probing private state.
