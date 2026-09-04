---
name: tldr
description: "Use tldr; to set up, check, configure, repair, or uninstall the installed plugin."
version: 3
---

# tldr;

tldr; is a lifecycle concierge for setup and safe product management. It guides the user through one current lifecycle action at a time; it is not a general messaging interface.

## Lifecycle front door

Run only the bundled launcher. Use the command block for the current host:

```bash
# Claude Code
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" setup --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" status --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" configure --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" repair --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" uninstall --json

# Codex
"${PLUGIN_ROOT}/bin/tldr-agent" setup --json
"${PLUGIN_ROOT}/bin/tldr-agent" status --json
"${PLUGIN_ROOT}/bin/tldr-agent" configure --json
"${PLUGIN_ROOT}/bin/tldr-agent" repair --json
"${PLUGIN_ROOT}/bin/tldr-agent" uninstall --json
```

Map `set up` and `Continue setting up tldr;` to `setup`; `check` and “is tldr; ready?” to `status`; owner or provider changes to `configure`; broken, unavailable, or explicit repair requests to `repair`; and removal to `uninstall`. Report the returned safe state and its single returned remediation. Do not probe private files, invent another recovery path, or use a globally installed executable. If the host cannot resolve its plugin root, explain that the bundled launcher context is unavailable and stop.

## Guided setup

Use this predetermined guidance for a first-time setup. Keep sensitive input in the native tldr; app and never ask for an API key or verification code in chat, command arguments, environment variables, or files.

1. **Introduction:** “Let’s set up tldr;. It takes a few minutes. I’ll open the tldr; app, where you’ll connect AgentMail and verify your email. Your email address, API key, and verification code stay in the app and are never included in this chat.”
2. **App handoff:** Start setup, then tell the user to continue in the tldr; app. Wait for its next safe state rather than interpreting private details.
3. **Background access:** “macOS needs you to allow tldr; to run in the background so email replies can reach your agent sessions. In the tldr; app, choose **Open Login Items**, turn on **tldr;**, then choose **Continue**.”
4. **AgentMail key:** “tldr; needs an AgentMail API key. If you don’t have one, sign in to AgentMail, open **API Keys**, choose **Create New API Key**, name it ‘tldr; on this Mac,’ and copy it. Paste the key only into the tldr; app.”
5. **Verification:** “AgentMail is connected. Check your email for the verification code and enter it in the tldr; app. I can’t see or submit that code.”
6. **Finalizing:** Tell the user that tldr; finalizes the existing connection and health checks without exposing internal details.
7. **Success:** “tldr; is ready. I sent a welcome email from this agent session. Reply with anything—‘hello’ is enough—and this same session will answer to confirm that replies work. Replying is optional; setup is complete.” Then offer these use cases:
   - “Email me a summary when you finish.”
   - “Email me if you need input before continuing.”
   - “Send me the decision and anything still blocked.”

## Returning, repair, and removal

- **Returning/ready:** For `status`, give the concise ready result without replaying first-time guidance. An already ready installation stays ready and does not repeat setup or the welcome message. Use `configure` only for the existing product settings.
- **Repair:** If health says attention is required, say “tldr; needs attention” and give only the returned repair action. Correctable setup input errors stay in the app; do not turn them into a general repair workflow.
- **Uninstall:** Before `uninstall`, say: “Uninstalling tldr; removes its protected owner and AgentMail key, background service, product-owned agent hooks, and app files from this Mac. I’m opening the tldr; app so you can review and confirm the removal.” Never claim removal completed until `status` confirms it. After confirmed removal, present the exact plugin-removal command returned by tldr;.

## Safe-state guidance

- `secure-setup-required`: give the introduction and start setup.
- `confirmation-required`: normal human waiting, not failure. Give only `Continue setting up tldr;`.
- `ready-unverified`: setup is ready; continue the current setup guidance.
- `onboarding-verified`: setup is complete. Repeated setup must not reinstall components, reopen enrollment, or repeat the welcome message.
- `onboarding-reconciling`: tldr; is ready, but do not claim the welcome message was delivered. Explain that the welcome message needs confirmation and give only the returned remediation; an ambiguous welcome is reconciled before retry.
- `welcome-delivery-failed`: tldr; is ready. Explain that a definitely failed welcome message can use the single returned remediation without reopening setup.
- `repair-required` or `unavailable`: give the returned repair action only.

If any lifecycle command fails, follow its single remediation when present. Otherwise report the stable error code without probing private state.
