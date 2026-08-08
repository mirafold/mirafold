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
| `feature/*` | working branches, cut from `next` | none — name them anything, force-push freely |
| `release/x.y.z` | short-lived release prep, cut from `next` (or from `main` for a hotfix) | none — it exists for hours |

Two mechanics to know:

- **Every commit headed for a PR needs a DCO sign-off** — commit with
  `git commit -s`. The DCO check is required on both protected branches.
- **A `v*` tag publishes only `main`'s current tip.** The release workflow's
  first step fails any tag pointing elsewhere (a feature branch, an old `main`
  commit). The tag trigger itself is branch-blind by platform design; the
  guard is what makes a mis-aimed tag a red workflow run instead of a bad
  release.

## The release cycle

1. **Feature work**: branch off `next`, commit with `-s`, PR into `next`,
   merge on green. Repeat until `next` holds the release you want.
2. **Cut the release branch**: `git switch -c release/x.y.z origin/next`.
3. **Bump the version** in `package.json` to `x.y.z` on that branch — commit
   `release: vx.y.z` (signed off). npm refuses to republish an existing
   version, so a missing bump kills the publish at the last step.
4. **PR `release/x.y.z` → `main`**, merge on green.
5. **Tag and push — this is the publish, and it's a human act** (the signing
   key lives only on the release manager's machine):

   ```
   git switch main && git pull
   npm pack                       # builds; prints mirafold-x.y.z.tgz
   sha256sum mirafold-x.y.z.tgz   # goes into the tag message
   git tag -s vx.y.z -m "sha256 <that hash>"
   git push origin vx.y.z
   ```

   The tag message carries the tarball's SHA-256 so the signed tag attests to
   the exact bytes. No hand-run `npm publish`, ever — the tag push triggers
   `.github/workflows/release.yml`, which re-verifies (guard, tag↔version
   check, typecheck, tests) and publishes with provenance via npm trusted
   publishing. A manual dispatch of that workflow is a dry-run rehearsal.
6. **Verify the same day**: the release run is green including the guard step;
   `npm view mirafold version` shows `x.y.z`; the registry tarball's sha256
   matches the signed tag message (`curl` it down and `sha256sum`).
7. **Close the loop — do not skip**: PR `main` → `next` and merge it. The
   version bump and release merge commit now exist on `main` only; until this
   sync lands, the next cycle's release PR will conflict on `package.json`.
   Push `main`'s tip to a `sync/*` branch first
   (`git push origin main:refs/heads/sync/main-into-next-vx.y.z`) so the PR is
   a fixed snapshot rather than tracking `main`.
8. Delete the merged `feature/*`, `release/*`, and `sync/*` branches.

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
