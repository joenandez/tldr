# tldr;

tldr; is a local lifecycle and private-email bridge for supported Claude Code
and Codex sessions. It keeps AgentMail credentials, provider delivery receipts,
polling, and recovery on the Mac. Tightbeam owns messaging, session routing,
and continuation using the safely inherited current-session context.

## 🚧 CAUTION 🚧 - Pre-Alpha

tldr; is in active development and probably won't work.

## Requirements

- macOS 13 or newer on Apple silicon
- Claude Code with plugin marketplace support
- An AgentMail account and API key for private enrollment in the signed Aegis app

tldr; carries its own verified runtime. No separate Node or tldr; runtime installation is required.

## Install

Run the complete installation block in Terminal:

```bash
claude plugin marketplace add joenandez/tldr
claude plugin install tldr@tldr --scope user
```

If Claude Code asks the current session to reload plugins, run:

```text
/reload-plugins
```

Then tell Claude:

```text
Set up tldr;
```

Claude verifies the bundled tldr; release and opens the signed Aegis app when private setup or macOS approval is needed. Enter the owner email and AgentMail API key only in Aegis. Claude receives bounded status such as `confirmation-required`, `ready-unverified`, or `onboarding-verified`; it never receives the private values.

If email confirmation is still pending, Claude gives one continuation phrase:

```text
Continue setting up tldr;
```

Successful setup sends one welcome email. That accepted delivery proves the
owner path is usable and explains that Tightbeam handles reply routing for the
inherited current session. Repeating setup does not reenroll, reinstall, or
resend the welcome message.

## Use and maintain

Use the lifecycle front door in Claude:

```text
Check tldr;
Configure tldr;
Repair tldr;
Uninstall tldr;
```

`Check tldr;` is observational. Configure and repair open Aegis only when the
protected boundary is required. Each blocked state provides one bounded action;
setup can resume later from durable safe state.

tldr; has no public send, reply, inbox, scheduler, or agent-hook command.
Tightbeam owns messaging and recipient routing; tldr; never creates a local
session identity or reconstructs a route from provider data.

## Uninstall

Tell Claude `Uninstall tldr;`. tldr; explains the impact, obtains fresh macOS
authorization in signed Aegis, stops its services, removes any previously
managed hook entries, and verifies removal of product-owned runtime, launch
definitions, and protected state. Unrelated files remain untouched.

After Claude reports that local cleanup is complete, remove the plugin itself:

```bash
claude plugin uninstall tldr@tldr
```

tldr; is released under the MIT License.
