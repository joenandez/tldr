# Security Policy

## Supported versions

Helm is pre-1.0 and follows semver loosely. Security fixes are issued against the most recent minor release on `main`. Older 0.x lines are not patched.

| Version | Supported |
| ------- | --------- |
| 0.x (latest) | Yes |
| 0.x (older)  | No  |

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Email: **joevfernandez@gmail.com** with the subject line `helm security:` followed by a short description.

Please include:

- A description of the issue and its impact.
- Reproduction steps or a proof of concept.
- The affected version (`helm-tasks --version` or commit SHA).
- Any suggested mitigation.

You should receive an acknowledgement within 5 business days. We will work with you on a fix and a coordinated disclosure timeline.

## Threat model summary

Helm is a **local, single-user** task scheduler. It is not designed to be exposed to a network or shared between mutually distrusting users. By design, Helm:

- Executes arbitrary commands as the invoking user.
- Reads and writes durable state under a local data directory.
- Spawns and supervises a per-user daemon process via `launchd`.

Out of scope for this project:

- Multi-tenant isolation between users on the same host.
- Sandboxing of the commands a job runs.
- Authenticated remote control of the daemon.

In scope for security reports:

- Path traversal or argument injection through CLI inputs, the job schema, or the local control surface.
- State corruption that could persist across daemon restarts.
- Privilege escalation beyond the invoking user's existing privileges.
- Secret leakage in logs, notifications, or error output.
