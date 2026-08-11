# tldr;

tldr; gives each Claude Code session a private email thread with its
verified owner. The owner can reply from anywhere, and tldr; continues the
originating session in its original directory without exposing an email address
or provider credential to the agent.

## Requirements

- macOS 13 or newer on Apple silicon or Intel
- Claude Code with plugin marketplace support
- An AgentMail account and API key for private enrollment in the signed Aegis app

tldr; carries its own verified runtime. No separate Node or tldr;
runtime installation is required.

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

Claude verifies the bundled tldr; release and opens the signed Aegis app
when private setup or macOS approval is needed. Enter the owner email and
AgentMail API key only in Aegis. Claude receives bounded status such as
`confirmation-required`, `ready-unverified`, or `onboarding-verified`; it never
receives the private values.

If email confirmation is still pending, Claude gives one continuation phrase:

```text
Continue setting up tldr;
```

Successful setup sends one welcome email. That accepted delivery proves the
owner path is usable and explains how replies return to the originating Claude
session. Repeating setup does not reenroll, reinstall, or resend the welcome
message.

## Use and maintain

Talk to Claude in natural language:

```text
Email me when this is done
Reply that I am on it
Check tldr;
Configure tldr;
Repair tldr;
Uninstall tldr;
```

`Check tldr;` is observational. Configure and repair open Aegis only when
the protected boundary is required. Each blocked state provides one bounded
action; setup can resume later from durable safe state.

tldr; always chooses the verified owner internally. It rejects arbitrary
recipients, CC/BCC, raw provider options, and cross-session thread reuse.

## Uninstall

Tell Claude `Uninstall tldr;`. tldr; explains the impact, obtains
fresh macOS authorization in signed Aegis, stops its services, and verifies
removal of product-owned runtime, hooks, launch definitions, and protected
state. Unrelated files remain untouched.

After Claude reports that local cleanup is complete, remove the plugin itself:

```bash
claude plugin uninstall tldr@tldr
```

tldr; is released under the MIT License.
