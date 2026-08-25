# Contributing to Mirafold

Thanks for wanting to help. Two things to know before your first PR.

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) rather than a CLA: a one-line statement, per commit, that you have the
right to contribute the code under the project's MIT license. Add it with

```
git commit -s
```

which appends `Signed-off-by: Your Name <you@example.com>` to the commit
message. PRs with unsigned commits can't be merged.

## Before you open a PR

- Node 22, yarn. `yarn typecheck` must pass.
- The core test tiers are summarized in [README.md](README.md#development):
  `yarn test` (unit, fast),
  `yarn test:server` (real daemon + real sockets, mock-forced),
  `yarn test:e2e` (headless Chrome, rebuilds dist first). New code lands
  with tests in the matching tier. UI-facing changes also run through
  `yarn test:ui` (managed Chromium, Firefox, and WebKit plus the Ubuntu visual
  baselines). Tiers 1–3 never reach a model or the network; `yarn test:live`
  (Tier 4, opt-in, never CI) may drive installed agent binaries and a local
  model server.
- Comments only for non-obvious constraints — the code says what it does.
- The non-negotiables in [CLAUDE.md](CLAUDE.md) bind every change: the wire
  protocol only ever *adds* message types; agent output never touches
  shell-owned affordances (the trusted-shell boundary); secrets stay
  server-side; every agent gets a faithful skin and none is privileged.

Security issues: don't open a public issue — see [SECURITY.md](SECURITY.md).
