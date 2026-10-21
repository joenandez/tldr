# tldr;

tldr; gives supported Claude Code and Codex sessions agent messaging and
scheduled tasks as soon as the plugin is installed. Email is optional: connect
it later when you want agents to reach you outside a session. AgentMail
credentials, provider delivery receipts, polling, and recovery stay on the Mac.

## 🚧 CAUTION 🚧 - Pre-Alpha

tldr; is in active development and probably won't work.

## Requirements

- macOS 13 or newer on Apple silicon
- Claude Code with plugin marketplace support
- An AgentMail account and API key, only if you connect email

Messaging and scheduled tasks work without an AgentMail account.

tldr; carries its own verified runtime. No separate Node or tldr; runtime
installation is required.

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

That is the whole install. Ask Claude to message another agent or schedule a
task; no email setup is needed. tldr; does not post a message after
installation.

## Use and maintain

Ask Claude about tldr; at any time:

```text
Check tldr;
Repair tldr;
Uninstall tldr;
```

`Check tldr;` is observational and reports messaging, scheduled tasks, and
email separately, for example:

```text
Messaging: ready. Scheduled tasks: ready. Email: not connected.
```

A capability that needs attention names its own single repair action. Repairing
messaging or tasks never opens the tldr; app or asks for email.

## Connect email (optional)

To let agents reach you outside a session, tell Claude:

```text
Set up email for tldr;
```

Claude opens the signed tldr; app. Enter the owner email, AgentMail API key,
and verification code only in the app; Claude receives only bounded status and
never the private values. If you close the app or setup is interrupted, email
stays not connected and messaging and tasks keep working. Resume with:

```text
Continue setting up email
```

Once email is connected, tldr; sends one welcome email. Replying tests the round
trip but is optional. Repeating setup does not reenroll, reinstall, or resend
the welcome message.

Manage email from Claude:

```text
Configure tldr;
Disconnect email
```

Configure changes the owner or API key in the app. Disconnect email removes
only the email connection after a confirmation in the app; messaging and
scheduled tasks stay available, and you can connect email again later.

## Uninstall

Tell your agent `Uninstall tldr;`. This stops agent messaging, scheduled tasks,
and email on this Mac. tldr; explains the impact, obtains fresh macOS
authorization in the signed tldr; app, stops its services, removes any
previously managed hook entries, and verifies removal of product-owned runtime,
launch definitions, and protected state. Unrelated files remain untouched.

After local cleanup is complete, remove the host plugin itself:

```bash
claude plugin uninstall tldr@tldr
codex plugin remove tldr@tldr
```

For a local install, replace `tldr@tldr` with the install's actual marketplace
suffix.

tldr; is released under the MIT License.
