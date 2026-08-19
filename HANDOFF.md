# Session handoff — Changes CR.5 complete; PN.2 is next

This handoff is current as of 2026-08-12. It becomes stale when
`feature/changes-workspace` advances, PN.2 starts, or Kyle changes the requested
work.

## Current state

- Repository: Mirafold, a faithful browser re-skin of Claude Code, Codex, and
  Gemini CLI with generative UI layered on top.
- Branch: `feature/changes-workspace`. Its latest commit is `5ac458d`
  (`feat: add conversational workspace diff review`). The working tree contains
  the uncommitted CR.3 closure, CR.4 implementation/refactor, and completed
  CR.5 correctness remediation, tests, and documentation. Nothing from this
  session was committed or pushed.
- CR.1 through CR.5 are complete. `PLAN.md` marks **PN.2 — the pane frame** as
  the next unfinished single-pass step in roadmap order.
- No real-provider adapter, ordinary prompt-send path, native permission policy,
  filesystem-write behavior, dependency, or PN.2 implementation changed in
  CR.5. Git trust enforcement remains behaviorally unchanged.

## Completed Changes workspace

- CR.1 supplied the reusable correlated file-view controller and bounded
  multi-repository changed-set query. CR.2 supplied the responsive live review
  workspace. CR.3 supplied stable HEAD/current coordinates, hunk navigation,
  desktop and phone selection, and visible unsent feedback drafts.
- CR.3's closure remains in this working tree: deterministic mock feedback,
  keyboard-reachable highlighted fenced-code scrollers, richer axe failure
  evidence, and a named safe README browser fixture.
- CR.4 adds an optional `fs_file_diff.revision`: a per-daemon keyed identity of
  the exact HEAD + working-tree bytes. Current-file revision work is opt-in and
  capped at 1 MB; oversized or unstable snapshots remain viewable but cannot be
  marked reviewed. Secret refusal remains before content access.
- Review progress is local to one browser viewport and resets with the session.
  Mark/unmark and next-unreviewed work through buttons or `R` / `N` outside the
  prompt and editable controls. Complete path hints invalidate only related
  markers; HEAD or incomplete hints invalidate all. The mounted panel processes
  watcher bells even while its surface is closed, and an exact reply reconciles
  any stale revision when a file is opened.
- Review rendering now runs one Markdown/Highlight.js pipeline for the whole
  diff and mounts at most 1,000 interactive rows. A 1,001-line input honestly
  falls back to current contents. Hunk scrolling honors reduced motion; 641px
  desktop and 390px phone layouts remain overflow-free, with 40px phone review
  controls.
- CR.4's narrower correctness/security closure reported no unresolved finding,
  and its mutation checks proved the progress invalidation, exact revision,
  interactive ceiling, and then-current browser stale-marker tests. The later
  whole-feature bughunt reproduced ten additional paths; CR.5 below closes all
  ten. `PLAN-ARCHIVE.md` preserves both scopes and their evidence.
- A post-completion refactor is also in the working tree. `ChangesPanel.tsx`
  now composes the responsive surface; `use-changes-controller.ts` owns the
  request/watcher/review lifecycle; `ChangesChrome.tsx` owns panel
  chrome; and `ReviewRows.tsx` owns syntax-row rendering beneath
  `ReviewDiff.tsx`. That refactor itself was behavior-preserving; CR.5 then
  deliberately repaired the lifecycle and rendering defects below.

## CR.5 whole-feature correctness closure

- Changes now reconciles the exceptional Git states where porcelain describes
  the index rather than the net HEAD-versus-working-tree result: a staged
  deletion restored identically disappears, an added-then-deleted path
  disappears, and assume-unchanged/skip-worktree paths are compared exactly.
- Nested repository markers are structurally validated. A malformed `.git`
  marker no longer hides a real repository below it or steals ownership from a
  real repository above it; a deleted subtree resolves through its nearest
  surviving ancestor to the correct nested repository.
- Diff reads distinguish missing from unreadable paths and read a tracked
  symlink's link text rather than its target bytes. Descriptor reads are
  no-follow, nonblocking, bounded, and revision-stable.
- A successful session reattach abandons request ids lost with the old socket,
  clears unverifiable review markers, and requests a fresh set/diff. Manual
  Refresh also clears all review claims before revalidation. Late Git status
  completion carries additive `fs_changed.reason: "status"`, refreshing Files
  without announcing a disk mutation to Changes.
- A truncated result with zero visible files says the change list is
  incomplete, never clean. Line splitting no longer turns a terminal newline
  into a numbered blank source line; diffs and feedback drafts carry the
  conventional no-newline marker.

## Next `$next`

Execute **PN.2 — the pane frame** from `PLAN.md`:

- Add a desktop pane region beside the transcript and let Explorer open files
  into tabs there.
- Support two-file tab creation, switch, close, keyboard traversal, focus into
  the pane on open, and sensible focus restoration on close.
- Keep the phone Explorer drill-in behavior unchanged and expose no pane
  affordance at phone width.
- The plan explicitly reserves the Explorer row's default-click behavior as
  Kyle's product call at build time. Do not infer that choice if the existing
  repository does not establish it.

The verified seam already exists: `web/src/components/files/use-file-view.ts`
owns an independent correlated read/diff lifecycle, and Files plus Changes are
its first two hosts. PN.2 begins at the pane frame; multiple simultaneous panes
mean one controller instance per file viewer.

## Verification at handoff

- CR.5's focused model/protocol/Git/revision run passed 44/44. The dedicated
  real-Git diff integration passed 8/8 and the status-signal integration passed
  5/5. TypeScript and both production bundles pass; Vite's standard
  large-chunk warning is unchanged.
- The complete Changes browser file passes 10/10 against real Git, a real
  daemon, and Chromium. Its four new browser cases pin reconnect freshness and
  orphaned requests, manual refresh after an unwatched HEAD change, status-only
  decoration without review invalidation, and zero-visible incomplete state.
- Safe Tier 1 passes 638/638 across 75 files. Safe Tier 2 passes 137/137 across
  22 files. After a fresh client build with Vite's env directory set to a new
  empty temporary directory, complete Tier 3 passes 93/93 across all eight
  browser files.
- Before the refactor, the isolated CR.4 browser case passed 3/3 across three
  unchanged runs; its complete 6/6 file then passed again after the refactor.
- The CR.4 desktop and phone axe gates, 641px/390px overflow checks, 40px phone
  control checks, and reduced-motion behavior passed. The final phone and
  desktop screenshots were visually inspected.
- Final `git diff --check` and documentation/boundary review should be rerun if
  this working tree changes before PN.2.

## Dotenv safety note

Aggregate file discovery explicitly excluded `.env`, `*.env`, `.env.*`, and
`*.env.*`. The final client production build used Vite's configuration API
with `envDir` set to a freshly created empty temporary directory; the server
build does not load Vite environment files.

Two earlier CR.5 verification builds invoked the ordinary `yarn build` command
before the handoff's Vite safeguard was reread. No dotenv contents appeared in
their output, but whether Vite probed for a matching file during those two
invocations is unverified. Do not describe the entire CR.5 session as having a
proven no-open guard; use the final redirected build as the verified artifact.

The safe Tier 1 aggregate deliberately excluded
`server/render-image.test.ts` and `server/sessions/fs-explorer.test.ts`; safe
Tier 2 excluded `server/sessions/fs-explorer.itest.ts`. Those three test files
open and write temporary dotenv-named fixtures, so running them would violate
the literal account-wide rule even though their fixture bytes are synthetic.
