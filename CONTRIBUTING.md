# Contributing to Helm

Thanks for your interest in improving Helm.

Helm is an agent-first local task scheduler. It executes arbitrary commands on your machine on a schedule, so correctness, predictability, and observability matter more than surface features. Please keep that in mind when proposing changes.

## Project scope

- **Agent-first**: every user-visible surface must be machine-readable and stable. CLI output, error shapes, and event names are part of the contract.
- **macOS for v1**: the supervised daemon integrates with `launchd`. Linux / Windows support is not currently planned.
- **Local-only**: Helm runs against the local filesystem and spawns local processes. It does not ship networked control surfaces.

## Getting set up

```bash
git clone https://github.com/Codename-Inc/helm.git
cd helm
npm install
npm test
```

You need Node 20 or 22.

To use the CLI from a local checkout:

```bash
npm link
helm-tasks status --pretty
```

### Install the code-quality gate (one-time per clone)

Helm uses [`qltysh/qlty`](https://github.com/qltysh/qlty) as its canonical code-quality tool — lint, format, and maintainability smells in a single binary, with config carried in the repo at `.qlty/qlty.toml`. Install the CLI and the local git hooks once per clone:

```bash
qlty --version || curl https://qlty.sh | bash    # install the qlty CLI (Rust binary, no npm deps)
qlty githooks install                            # writes .git/hooks/pre-commit + pre-push for this clone
```

Notes:

- Git hooks are **local** — they live in `.git/hooks/`, which is not committed. Every contributor and every fresh clone runs `qlty githooks install` once. Do not commit `.git/hooks` files.
- `qlty` is a single binary; we do not add npm packages for ESLint, Prettier, Husky, lint-staged, or similar. There is no `package-lock.json` churn from the gate.
- The rule set, smell thresholds, and the five seeded waivers are documented in `.qlty/qlty.toml` and rationalized in `docs/prfaq/HELM-PRFAQ-0-9-CODE-QUALITY-GATE.md` (smell rationale + adoption decision).

## Verifying your change

Helm is a CLI for agents. **Every feature and bug fix must be manually verified by running the CLI.** Type checks and passing tests prove the code compiles and the unit behavior is correct; they do not prove the feature works.

### Pre-commit: `npm run lint`

`npm run lint` runs the file-size ratchet (`scripts/check-file-size.mjs`) and then `qlty check`. Run it before commit (the pre-commit hook also auto-formats your staged diff via `qlty fmt`):

```bash
npm run lint                  # run the full quality gate locally
npm run lint -- --summary     # quick summary
```

There is intentionally no `lint:fix` script. If the file-size gate flags a new oversized file, split it before committing. If it flags a grandfathered file growing beyond its baseline, extract the new work or intentionally lower the file elsewhere. If `qlty check` flags a smell, fix the underlying code — the gate's complaint is almost always a real signal.

### Pre-push: run `npm run preflight`

Before pushing, run the local CI mirror:

```bash
npm run preflight                              # default: 3 iterations on Node 20 + 22, Qlty=monitor
ITERATIONS=8 npm run preflight                 # surface intermittent races
QLTY_GATE_MODE=block npm run preflight         # enforce the quality gate as a hard failure
npm run preflight -- --with-coverage           # also run the coverage gate on Node 24
```

`preflight` runs the quality stage first, including the always-blocking file-size ratchet and the Qlty smell check, then uses `nvm` to install and switch to each Node version in CI's matrix and runs `npm ci && npm test` repeatedly per version. Repeating each version multiple times is what surfaces races and timing-sensitive flakes that a single local run hides; CI hardware is slower than a dev laptop and surfaces races that pass locally on the first try.

If preflight is green, CI should be green. If preflight fails, CI definitely will.

#### Rollout: monitor → block (PRFAQ-0-9)

`scripts/preflight.sh` reads `QLTY_GATE_MODE` (default `monitor`). Two-phase rollout, by deliberate human-reviewed PR — not by any scheduler, cron job, recurring Helm task, watchdog, status-email cadence, or GitHub Actions workflow:

| Day    | `QLTY_GATE_MODE`    | Behavior                                                                                                           |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Day 1  | `monitor` (default) | `qlty check --summary --no-fail` prints findings; preflight does not fail on Qlty findings.                        |
| Day 3+ | `block`             | `qlty check` non-zero counts as a preflight failure and blocks pushes that would have shipped with the regression. |

The flip happens in a follow-up PR after reviewing the Day-1 monitor output and the five seeded waivers. `npm test` and the existing correctness gates remain additive and unchanged across both phases — the Qlty gate is layered alongside, not in place of, the test suite.

#### Bypass

`git commit --no-verify` and `git push --no-verify` continue to work locally. Per existing Helm SOP, every bypass must be logged in the PR description with a one-line justification. Bare bypasses get caught in code review.

Concretely, for any change that touches job scheduling, dispatch, storage, service supervision, or notifications:

1. Run `npm test` and make sure everything passes.
2. Run `helm-tasks` directly and exercise the golden path for the feature.
3. Exercise at least one failure path (bad input, missing job, conflicting schedule).
4. Clean up test jobs and bring the service back to a known state (`helm-tasks down`).

If a change cannot be manually verified without a human-in-the-loop step, call it out explicitly in the PR description.

## Code style

- Plain Node ESM, no transpile step.
- Prefer small modules with one boundary per file (see `src/lib/` for the pattern).
- Log at boundaries (API entry, dispatch, handler exits, errors). Do not log inside hot loops. Include structured fields (`event`, `params`, `result`, `status`, `latency`).
- Never swallow errors. Propagate with context or log `error` level with the stack.
- Don't add features, abstractions, or feature-flags for hypothetical future needs.

## Tests

Tests live in `tests/` and run under `node --test`. End-to-end CLI coverage lives in `tests/e2e_helm_cli.sh`.

- Add a test alongside the behavior it covers.
- Integration-style tests that drive the CLI from the outside are preferred over unit tests that mock internal modules.
- Do not mock the filesystem store. Use a scoped temp directory instead.

## Submitting changes

1. Fork and branch from `main`.
2. Keep commits focused. Conventional commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`) are encouraged but not required.
3. Update `CHANGELOG.md` under `## [Unreleased]` with a one-line entry.
4. Open a PR. Fill in the PR template.
5. CI must be green before review.

## Reporting security issues

Do not open a public issue for security bugs. See [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
