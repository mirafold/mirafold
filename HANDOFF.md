# Session handoff — correctness PR #35 open for review

This handoff is current as of 2026-08-11 after PR #34 was repaired, verified,
and merged into `next`, and after all eight confirmed whole-codebase bughunt
findings were fixed on the new `fix/bughunt-correctness` branch. It becomes
stale when PR #35 changes or merges, `next` advances, or Kyle changes the hold.

## Current state

- Repository: Mirafold, a browser re-skin of Claude Code, Codex, and Gemini
  CLI with generative UI layered on top.
- Branch: `fix/bughunt-correctness`, based on updated `next` merge commit
  `21b5f33`.
- Open review: PR #35 targets `next`. Kyle explicitly asked for a new PR and
  asked that work stop there so he can review it. Do not merge PR #35 or move
  the roadmap forward without a new instruction.
- Implementation commit: signed and DCO-signed-off `3ed7236` (`fix: close
  whole-codebase correctness findings`). The plan/archive/handoff sync is the
  only separate documentation commit.
- No dependency, provider protocol, stored-session schema, or user-facing file
  write capability was added.

## PR #34 and the reported CI failure

- PR #34 contained the visually approved Explorer E3.2 pass and the
  behavior-preserving Codex D.1 decomposition.
- Its failed combined Tier 2/Tier 3 job was diagnosed from the exact output:
  E.3 expected rendered title text `Files`, but the intentional uppercase CSS
  rendered `FILES`; E.6 then timed out only because E.3 aborted before closing
  shared panel state.
- The assertion alone was corrected. Signed and DCO-signed-off commit
  `5de3f2e` replaced the initial unsigned-off metadata. Local E2E passed 83/83,
  then GitHub passed DCO, Cloudflare Pages, Tier 1, and combined Tier 2/Tier 3.
- PR #34 merged into `next` as `21b5f33`. D.1 remains unchecked only because
  its roadmap definition still requires Tier 4 plus manual subscription and
  OpenRouter turns; do not run those as part of PR #35.

## PR #35 executable changes

- `server/adapters/gemini-cli.ts`: one rejected queued preparation no longer
  kills the fire-and-forget worker; the failed settings merge remains eligible
  for retry on the next prompt.
- `server/adapters/codex.ts`: a transient first-party model-catalog failure no
  longer clears the guard; both subscription and API-key sessions retry before
  a later prompt reaches the engine.
- `server/relay/relay-protocol.ts` and `relay-client.ts`: parsed relay traffic
  is runtime-validated before the multiplexer reads envelope fields. JSON
  scalars, null, arrays, and wrong-shaped objects are ignored.
- `server/security/auth.ts`: malformed percent escapes in the target cookie
  behave as no cookie, allowing a later duplicate or valid query token to
  recover.
- `server/sessions/registry.ts` and `bang-handlers.ts`: pending model turns are
  counted independently from bang and permission status. `bang_end` cannot
  create false idle or reopen the prompt gate; queued turns remain working;
  adapter `error` plus `turn_end` consumes one pending turn, not two.
- `server/sessions/fs-explorer.ts` and `git.ts`: path admission uses UTF-8 byte
  length consistently with the accumulated cap.
- `web/src/tildify.ts`, `web/src/components/files/FilesPanel.tsx`, and
  `server/sessions/registry.ts`: drive, UNC, mixed-separator, and tildified
  Windows paths work while POSIX case sensitivity and literal backslashes
  remain intact.
- `server/sessions/registry.ts` and `connection.ts`: an active rename restores
  its previous name when checkpointing fails and tells the viewport that the
  name was not saved.

## Regression and verification state

- Every finding has a focused regression. The final affected-unit batch passed
  151/151; the new plain-walk UTF-8 case passed alone under the denial guard.
- The ordinary safe unit matrix passed 577/577. The aggregate-sensitive Codex
  catalog, Gemini catalog, and version files passed independently, 17/17.
- The guarded Tier 2 server-integration matrix passed 131/131 across 21 safe
  files.
- The guarded Tier 3 browser matrix passed 70/70: 66/66 app/bundle/fleet/phone/
  recovery plus 4/4 relay.
- TypeScript, fresh guarded Vite and esbuild production builds, and
  `git diff --check` passed.
- Excluded for the account-wide opacity rule: unit/integration fixtures that
  deliberately manufacture dotenv files, the launcher browser file, and the
  Explorer/global-axe browser cases whose fixtures enter that filename class.
- One initial Tier 3 command used a negative run-pattern that matched the
  file-level parent, so six Explorer cases ran before the mistake was visible.
  The run was stopped immediately. The preloaded guard prevented content
  reads, but those cases may have listed a forbidden filename. The mistake was
  reported; a harmless unit probe proved the filter behavior, and the green
  replacement used Node's positive `--test-skip-pattern`. No product edit was
  made in response.

## Important invariants

- Never inspect, search, print, diff, parse, source, or otherwise read dotenv
  contents. Every recursive search/listing must explicitly exclude `.env`,
  `*.env`, `.env.*`, and `*.env.*`. The temporary denial guard lives only at
  `/tmp/mirafold-deny-dotenv.cjs` and is not repository state.
- `modelTurnsPending` is live-only and initializes to zero for fresh and
  recovered sessions. `midTurnPromptUsed` is derived from whether more than one
  model turn is pending. Only model-terminal grammar decrements the count;
  `bang_end` derives display status without consuming it.
- Keep adapter `error` plus `turn_end` paired as one model terminal event in the
  registry. A queued next turn must remain `working` and earn exactly one new
  follow-up slot when the prior turn ends.
- Windows recognition must require a drive/UNC shape (or a `~\\` root label),
  not merely any backslash. Backslash is legal filename data on POSIX.
- PR #35 is intentionally open and unmerged. The next action is Kyle's review,
  not another roadmap phase, Tier 4 spend, manual provider turn, or merge.
