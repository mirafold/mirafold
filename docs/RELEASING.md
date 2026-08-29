# Releasing Mirafold — the flow-b runbook

Adopted 2026-08-07 (first exercised as the `v0.3.3` release). One principle
generates every rule here:

> **`main` is the production mirror: it advances only at release time, so the
> code on `main` and the code people install are always the same thing.**

"Production" is two surfaces that update together on a `main` push: the npm
package (published by CI on a tag) and app.mirafold.com (Cloudflare Pages
rebuilds on every push to `main`). Flow b keeps them in lockstep by making a
`main` push and a release the same event.

## The branches

| branch | what it is | protection (GitHub rulesets) |
| --- | --- | --- |
| `main` | the production mirror — every commit on it is inside some release | required checks (Tier 1, Tier 2+3, DCO), no force-push/delete; repo-admin bypass exists for emergencies but a direct push breaks the flow-b invariant — don't, except as step one of an immediate release |
| `next` | staging — day-to-day work accumulates here | PR-only for everyone (0 approvals, same required checks), no bypass, no force-push/delete |
| `feature/*`, `fix/*`, `refactor/*` | working branches, cut from `next` | none — name them anything, force-push freely |
| `release/x.y.z` | short-lived release prep, cut from `next` (or from `main` for a hotfix) | none — it exists for hours |

Three mechanics to know:

- **Every commit headed for a PR needs a DCO sign-off** — commit with
  `git commit -s`. The DCO check is required on both protected branches.
- **An open or green feature PR is not approval to merge it.** Keep the PR
  open through the requested review and refactor passes. When it appears
  ready, ask Kyle explicitly whether to merge; merge only after he approves.
- **Every PR gets automated review comments — read them before any merge.**
  Two bots review each PR on open: CodeQL's code-quality scan (inline
  "unused import" style notes) and the Codex reviewer (inline P1/P2 findings
  with a claimed failure). They post minutes after the PR opens, so a
  PR that "went green" can still be carrying findings. Before asking for
  merge approval on a feature PR, and before merging a release PR, pull
  every comment (`gh api repos/mirafold/mirafold/pulls/<n>/comments`,
  plus `/issues/<n>/comments` and `/pulls/<n>/reviews`), verify each claim
  against the code — a reviewer's failure scenario is a hypothesis, not a
  finding, until it is reproduced — and fix the legitimate ones with a test
  per class. On a release PR the fixes go to a `fix/*` branch off `next`,
  merge into `next`, and `next` merges into the release branch; never
  commit them on `release/*` directly, or staging only receives them via
  the post-release sync. Adopted 2026-08-29 (v0.6.0: ten findings, all
  legitimate, first seen after the release PR was already green).
- **A `v*` tag publishes only `main`'s current tip.** The release workflow's
  first step fails any tag pointing elsewhere (a feature branch, an old `main`
  commit). The tag trigger itself is branch-blind by platform design; the
  guard is what makes a mis-aimed tag a red workflow run instead of a bad
  release.

## The release cycle

1. **Feature work**: branch off `next`, commit with `-s`, and open a PR into
   `next`. Keep implementation follow-ups and refactors on that open PR.
   Once the work and required checks appear ready, read the automated
   review comments (mechanic above) and address the legitimate ones on the
   same PR; then ask Kyle explicitly for merge approval and leave the PR
   open until he gives it. Repeat until `next`
   holds the release you want.
2. **Cut the release branch**: `git switch -c release/x.y.z origin/next`.
   On it, regenerate the bundled-license notices and commit any change —
   `node scripts/third-party-notices.mjs` (required whenever a browser-side
   dependency moved; CI fails the release if the file is stale).
3. **Bump the version** in `package.json` to `x.y.z` on that branch — commit
   `release: vx.y.z` (signed off). npm refuses to republish an existing
   version, so a missing bump kills the publish at the last step.
4. **PR `release/x.y.z` → `main`.** When the checks are green, read the
   automated review comments on it; a legitimate finding goes through
   `next` first (mechanic above), and the release branch takes the refreshed
   `next` with `git merge origin/next` — the PR updates itself and the checks
   re-run. Merge when green with the findings addressed.
5. **Tag and push — this is the publish, and it's a human act** (the signing
   key lives only on the release manager's machine):

   ```
   git switch main && git pull
   npm pack                       # builds; prints mirafold-x.y.z.tgz
   sha256sum mirafold-x.y.z.tgz   # goes into the tag message
   git tag -s vx.y.z -m "sha256 <that hash>"
   git push origin vx.y.z
   ```

   The release workflow verifies the tag's SSH signature against
   `.github/allowed_signers` before anything publishes (2026-08-26 audit) — a
   new signing key means a new line in that file, merged to `main` first.
   The tag message carries the tarball's SHA-256 so the signed tag attests to
   the exact bytes. No hand-run `npm publish`, ever — the tag push triggers
   `.github/workflows/release.yml`, which re-verifies (guard, tag↔version
   check, typecheck, tests), packs once, **refuses unless its pack's SHA-256
   equals the one in the tag message**, and publishes that exact tarball
   with provenance via npm trusted publishing — so the signed tag, the
   workflow summary, and the registry bytes are one file, not three packs
   assumed identical. A manual dispatch of that workflow is a dry-run
   rehearsal (no tag, so the SHA check is skipped).
6. **Verify the same day**: the release run is green including the guard step;
   `npm view mirafold version` shows `x.y.z`; the registry tarball's sha256
   matches the signed tag message (`curl` it down and `sha256sum` — the
   workflow already proved tag ↔ pack, this proves pack ↔ registry); and the
   packaged smoke passes against the published package —
   `node scripts/packaged-pass.mjs` (a global install driven in a real
   browser; it has caught launch blockers the test tiers cannot see).
7. **Close the loop — do not skip**: PR `main` → `next` and merge it. The
   version bump and release merge commit now exist on `main` only; until this
   sync lands, the next cycle's release PR will conflict on `package.json`.
   Push `main`'s tip to a `sync/*` branch first
   (`git push origin main:refs/heads/sync/main-into-next-vx.y.z`) so the PR is
   a fixed snapshot rather than tracking `main`.
8. Delete the merged work (`feature/*`, `fix/*`, `refactor/*`), `release/*`,
   and `sync/*` branches.

## Hotfixes

Same cycle in miniature, starting from `main` instead of `next`:
cut `release/x.y.(z+1)` **from `main`**, commit the fix + version bump there
(signed off), PR → `main`, merge on green, tag, verify — then the same
`main` → `next` sync, which delivers the fix to staging too.

## Holding a feature out of a release

Don't merge it into `next` yet — that's the whole mechanism. The branch stays
alive and periodically merges `next` *into itself* to avoid rotting. If
something already on `next` must not ship: cut `release/x.y.z` from the last
good commit before it, or revert the unwanted merge on the release branch
only. There is no second staging branch, deliberately.
