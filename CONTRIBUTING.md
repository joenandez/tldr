# Contributing

## Unified repository integration status

This repository is the source of truth for the tldr; product shell at `/`, Helm
at `/scheduling`, and Tightbeam at `/messaging`.

The retained, non-squashed subtree imports are:

| Component                | Source repository                                     | Source commit                              | Source tree                                | Import commit                              |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| Helm (`/scheduling`)     | `https://github.com/joenandez/helm.git`               | `7c245ad9dc5c7c2fc5a739c6f893e2409ae84b6a` | `2cc93f4944c9c62909df8f9d90f2fb9d1c01ac28` | `446618a1ff978d6a8700c4e3bcfd443ebd957c1f` |
| Tightbeam (`/messaging`) | `https://github.com/joenandez/tightbeam-internal.git` | `98148bf4e0e0225296ddaf3a3997b724c6864680` | `03dfc97bd5ffb93c1738a8e83e10b048dc697db5` | `9609ce55524a6909bb2ebe01a248bc2341925d6a` |

The imports retain each source commit's reachable history. Git's subtree
metadata maps an imported path back to its source commit, but path history is
not a single linear history across the three component roots; that is the
accepted subtree-history limitation.

The root package `@joenandez/tldr` is the only package: one `package.json`, one
`package-lock.json`, and one set of test commands for all three components.
Helm and Tightbeam keep their own source trees, CLIs, and state roots. The
external Helm and Tightbeam source repositories remain untouched and
unarchived.

Install once at the root and run every component's tests from there:

```bash
npm ci
npm test                  # tldr, then Helm, then Tightbeam
npm run test:tldr         # tldr only
npm run test:helm         # Helm only (serialized; runs from scheduling/)
npm run test:tightbeam    # Tightbeam only (runs from messaging/)
node scripts/test-unified-repo.mjs
```

`scripts/run-component-tests.mjs` defines the Helm and Tightbeam suites; Helm's
test lists live in `scheduling/tests/suites.json`. The unified runner
(`scripts/test-unified-repo.mjs`) is the repository acceptance command: it runs
the packed lane, then each component lane with its skip baseline and receipts.
For Helm-specific contributor guidance, see
[scheduling/CONTRIBUTING.md](scheduling/CONTRIBUTING.md).
