# Session handoff — input history navigation checkpoint

This handoff records the 2026-08-19 checkpoint on
`feature/prompt-navigation`. The implementation is preserved in the checkpoint,
but the branch is deliberately not merge-ready: the required Tier 1 aggregate
runner failure below still needs diagnosis. If a remote branch and draft pull
request exist, continue there; otherwise publish this checkpoint before doing
more work. This record becomes stale when the branch advances or Kyle changes
the requested work.

## Current state

- Phase IH is implemented on `feature/prompt-navigation`, cut exactly from the
  current `next` head `fbb748b`.
- The feature, same-session refactor, correctness fixes, focused regressions,
  and documentation are complete. The aggregate Tier 1 runner investigation
  and final merge gate remain pending.
- Any pull request must remain a draft targeting protected integration branch
  `next`; nothing in this checkpoint is merged or released.
- `PLAN.md` records **PN.2 — the pane frame** as the next unfinished roadmap
  step.

## Product result

- Desktop submitted ordinary prompts and `!` command strips carry always-
  visible older/newer arrows inside their right edge. Empty-prompt ArrowUp
  enters at the newest input; selected strips own chronological ArrowUp,
  ArrowDown, and Escape without wrapping.
- Phone keeps inline arrows hidden. A 40px `⋯` immediately above submit opens
  an anchored count plus older/newer card, remains open for repeated taps, and
  consumes no prompt or status-bar height. Permission, live shell-input, and
  upload strips temporarily own that shared physical space.
- Navigation preserves the unsent draft and changes only viewport-local
  selection, transcript focus, and transcript scroll. It never edits,
  resubmits, or sends history.
- Explicit jumps suspend live-tail following even when browser clamping lands
  at the current bottom. Scrolling away and back, or unmodified End from a
  selected input or the focused transcript scroller, resumes following.
- Provider pickers keep their established global key priority without stealing
  native Enter from desktop or phone navigation controls. Phone navigation
  never summons the prompt keyboard during replay, streaming completion, or
  touch/hardware-keyboard movement. Keyboard focus leaving the phone card for
  another shell control closes it before that control can open a modal or
  workspace; the selected transcript stop remains its keyboard continuation.

## Correctness and boundary record

- Serial bughunt passes proved and closed the clamped-tail, no-motion End,
  repeated same-destination, replay focus, Tab order, Escape focus/ownership,
  phone endpoint, phone ownership, and provider-picker arbitration sibling
  paths, including modal/workspace focus layering. The latest completed
  settled review reported 0 confirmed, 0 likely, and 0 latent findings.
- The replay browser regression removes only the temporary session directory
  it creates; its endpoint loop is bounded and waits for each committed move,
  so a no-op fails instead of hanging.
- No wire format, server runtime, provider adapter, response grouping,
  ordinary prompt-send rule, dependency, or release workflow changed.

## Verification at checkpoint

- Focused navigation and follow-tail units: **7/7**.
- An earlier dotenv-guarded Tier 1 run passed **818/818** across 87 files, with
  the three deliberate dotenv-fixture test files excluded. The final aggregate
  rerun is unresolved: `codex-model-list.test.ts` and
  `gemini-model-list.test.ts` exit 1 only inside the multi-file runner, while
  their isolated reruns pass **9/9** and **4/4**. Default, four-file, and
  one-file runner concurrency all reproduced it; each aggregate then stalled
  in the existing folder-picker forced-exit fixture and was stopped. No source
  change was made during diagnosis.
- TypeScript, guarded client production build, and guarded server production
  build passed. Vite emitted only the repository's existing large-chunk
  warning.
- Final feature Chrome regressions: **4/4**. Complete serial Tier 3 previously
  passed **114/114** before the last phone focus-layer correction; a complete
  final rerun remains part of the merge gate.
- The original feature completion also passed dotenv-safe Tier 2 **139/139**,
  managed-browser matrix **3/3**, visual suite **6/6**, desktop/phone visual
  inspection, and `git diff --check`.

## Dotenv safety

No dotenv file was opened or inspected. Recursive discovery explicitly
excluded `.env`, `*.env`, `.env.*`, and `*.env.*`. Node-based gates ran with a
deny-open preload, and the Vite build used `envDir: false` through the temporary
guarded build configuration.
