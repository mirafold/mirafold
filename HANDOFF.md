# Session handoff — Changes CR.3 axe investigation is next

This handoff is current as of 2026-08-11. It becomes stale when
`feature/changes-workspace` advances, CR.3's ordered browser failure is
diagnosed, or Kyle changes the requested work.

## Current state

- Repository: Mirafold, a faithful browser re-skin of Claude Code, Codex, and
  Gemini CLI with generative UI layered on top.
- Branch: `feature/changes-workspace`, based directly on `next` commit
  `923d1ec`. Push this branch itself; no pull request was requested or created
  during this wrap-up.
- CR.1 and CR.2 are complete. Commit `6832caf` contains the reusable file-view
  foundation and the responsive Workspace changes surface.
- CR.3 is implemented but deliberately remains unchecked in `PLAN.md` because
  the ordered browser suite has an intermittent accessibility result. A new
  session invoking `$next` must stay on CR.3 and diagnose that result before
  adding CR.4 or any unrelated roadmap work.
- No dependency, server protocol, agent adapter, permission path, or
  user-facing filesystem write capability was added by CR.3.

## CR.3 implementation present on the branch

- `web/src/change-review.ts` derives stable HEAD/current line coordinates,
  navigable hunks, bounded selections, syntax-language names, and exact
  path/range/diff prompt text from the existing diff data.
- `web/src/components/changes/ReviewDiff.tsx` renders the full contextual diff
  with the existing highlighting stack. Desktop supports pointer drag and
  keyboard ranges; phone supports one-line taps and whole-hunk selection.
- `Explain` and `Request change` append visible text to the trusted prompt,
  preserve text already being composed, focus the textarea, and never send.
  The user still edits and submits through the ordinary prompt path.
- Selection state survives an identical refresh and clears with an explicit
  notice when the file content, selected file, or selected textual view changes.
- The phone Changes surface and raised prompt act as one focus-contained review
  surface while a draft is visible. Rapid file navigation is coalesced beyond
  the daemon's 250 ms diff-request floor.
- Focused unit coverage and real-browser desktop/phone coverage are present in
  `web/src/change-review.test.ts`, `web/src/prompt-draft.test.ts`, and
  `server/testing/changes.e2e.ts`.

## Unresolved failure — first task for the next `$next`

- In the ordered Changes browser suite, after CR.3's desktop case sends a mock
  turn, a later phone axe check intermittently reports the serious
  `scrollable-region-focusable` rule twice. The reported targets are highlighted
  transcript code nodes with `.language-diff` and `.language-ts`, not the new
  selectable diff rows.
- The CR.2 phone test passes alone. The CR.3 phone test passes alone. The
  desktop-then-phone subset has both passed and failed without a code change,
  so no product cause is established yet.
- Two hypotheses were tested independently and reverted after the failure
  persisted: an inner scroller on `.markdown pre code.hljs`, then an inner
  scroller on `.rc-code-body code.hljs`. Do not restore or stack either edit.
- First, characterize the recurrence rate on the smallest ordered subset with
  no code changes. Then capture each flagged node's `clientHeight`,
  `scrollHeight`, computed overflow, focusability, and ancestor scroll chain
  inside the same axe evaluation that reports it. Name the causal chain before
  making a third fix attempt.
- Keep CR.3 unchecked until the ordered suite passes repeatedly. Do not start
  CR.4 merely because the focused cases are green.

## Verification at handoff

- Focused CR.3 and directly affected Tier 1 tests passed 25/25.
- TypeScript typecheck, the production Vite build with dotenv loading disabled,
  the server production build, and `git diff --check` passed.
- The focused CR.3 desktop browser case passed, and the focused CR.3 phone
  browser case passed.
- The complete Changes browser suite is not considered green because the
  intermittent ordered axe result above remains unresolved.

## Standing safety boundary

- Never inspect, search, print, diff, parse, source, or otherwise read dotenv
  contents. Every recursive search or listing must explicitly exclude `.env`,
  `*.env`, `.env.*`, and `*.env.*`. The temporary denial guard used this
  session lives only at `/tmp/mirafold-deny-dotenv.cjs`; it is not repository
  state and may not exist in the next session.
