---
name: tldr
description: "Use tldr; to set up, check, configure, repair, or uninstall the Claude plugin. It handles signed Aegis enrollment and Tightbeam email-channel registration without exposing private identity settings."
version: 3
---

# tldr;

tldr; is a lifecycle-only plugin. It owns signed Aegis enrollment, verified-owner
security, rendering, polling, AgentMail integration, and the provider-thread
mapping used by its Tightbeam email channel. Tightbeam is the sole routine
message and delivery authority.

## Lifecycle front door

Run only the bundled plugin launcher:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" setup --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" status --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" configure --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" repair --json
"${CLAUDE_PLUGIN_ROOT}/bin/tldr-agent" uninstall --json
```

Map `set up` and `Continue setting up tldr;` to `setup`; `check` and “is
tldr; ready?” to `status`; owner or provider changes to `configure`; broken,
unavailable, or explicit repair requests to `repair`; and removal to
`uninstall`. Report the returned safe state and its single remediation. Do not
probe private files, invent a second recovery path, or invoke a globally
installed executable.

Setup acquires and verifies the app-owned runtime, then hands private enrollment
to the signed Aegis app. Tell the user before Aegis opens. Email and AgentMail
credentials belong only in that native surface; never ask for them in chat,
arguments, environment variables, or files. When an AgentMail account or key is
needed, direct the user to <https://console.agentmail.to/> and resume only after
they return from Aegis.

Use these state meanings:

- `secure-setup-required`: announce the signed Aegis handoff and run setup.
- `confirmation-required`: normal human waiting, not failure. Give only
  `Continue setting up tldr;`.
- `ready-unverified`: setup is ready and its Tightbeam email route is registered.
- `onboarding-verified`: setup is complete; repeated setup must not reinstall
  components or reopen enrollment.
- `repair-required` or `unavailable`: give the returned repair action only.

For configure and uninstall, explain the impact before opening signed Aegis.
After protected uninstall succeeds, present the exact plugin-removal command
returned by tldr;. Never claim cleanup completed until status confirms it.
