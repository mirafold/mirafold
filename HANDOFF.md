# Session handoff — input history navigation complete

This handoff records the 2026-08-20 local closure of Phase IH on
`feature/prompt-navigation`. The feature checkpoint remains committed at
`4787702`; the runner fix, security/test-audit closure, regressions, and planning
updates recorded here form the branch's next signed-off commit. Draft pull
request #59 targets protected integration branch `next`; its new head must pass
the protected remote checks before the draft is promoted and merged. Nothing
was merged or released when this record was written. This record becomes stale
when the branch advances, pull request #59 merges, or Kyle changes the requested
work.

## Current state

- Phase IH is implemented on `feature/prompt-navigation`, cut exactly from the
  current `next` head `fbb748b`.
- The feature, same-session refactor, correctness fixes, runner fix,
  regressions, documentation, and local merge gates are complete.
- Pull request #59 must remain a draft targeting `next` until this closure is
  pushed and its protected checks pass; then it can be promoted and merged.
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
- The Tier 1 runner failure was real and shared below both model-list adapters.
  `jsonRpcOneShot` listened for errors on the child process but not its stdin
  pipe. When an immediate-exit child closed that pipe during the initial
  request, Node emitted an unhandled `EPIPE` and killed the test-file process
  with exit 1. A process-isolated regression was born failing on that exact
  crash; the stdin error now enters the existing settle-once rejection path.
- The 2026-08-20 branch security audit found no exploitable or hardening issue
  in submitted-input navigation. It found one hardening issue in the touched
  one-shot helper: provider stdout was time-bounded but not size-bounded, so a
  corrupt binary could retain arbitrary output before timeout. Cumulative
  stdout now stops at 1 MB; one byte over is rejected and an exactly-at-limit
  valid JSON response succeeds. `SECURITY.md` records the boundary.
- The 2026-08-20 feature test audit tried seventeen isolated mutations. Nine
  existing tests failed immediately; five initially survived, and the fresh
  cold review exposed two broader classes after their first repair. The seven
  repaired gaps cover later-row viewport equality, component-scale arrow
  visibility, `!`-row integration, live-shell and upload anchor suppression,
  the real-DOM non-tail phone viewport path, and single enabled-arrow visibility
  in both themes. Each repaired class now fails its matching mutation. The test
  audit changed no product source.
- One untouched CR.2 phone file-review browser test timed out in one of three
  complete unchanged Tier 3 repetitions. It passed the other two complete runs
  and all six focused repetitions. The same full-suite-only timeout was already
  recorded 2026-08-19, making this active recurrent flaky-suite debt. No cause
  is proved and no CR.2 code or test was changed; its named owner is a separate
  Changes-suite diagnosis before the next Changes phase or before relying on
  broad Tier 3 stability as a gate.
- No wire format, adapter event mapping, response grouping, ordinary
  prompt-send rule, dependency, UI behavior, or release workflow changed.

## Verification at closure

- Focused navigation and follow-tail units: **7/7**.
- The focused JSON-RPC plus Codex/Gemini model-list set passed **16/16** after
  the stdin regression first failed 0/1 on the old source with `write EPIPE`
  and the audit regression proved the old oversized-output path waited for its
  timeout. The exact 1 MB boundary variant also passes.
- The final dotenv-guarded Tier 1 aggregate passed **819/819** across 88 safe
  files, with the three deliberate dotenv-fixture files excluded.
- Guarded TypeScript, client production build, and server production build
  passed. Vite emitted only the repository's existing large-chunk warning.
- Final dotenv-safe Tier 2 passed **139/139** across 23 safe integration files.
- Final freshly built, serialized Tier 3 passed **114/114**, after the last
  phone focus-layer correction.
- Final feature Chrome regressions remain **4/4**.
- The original feature completion also passed dotenv-safe Tier 2 **139/139**,
  managed-browser matrix **3/3**, visual suite **6/6**, desktop/phone visual
  inspection, and `git diff --check`.
- Post-audit TypeScript, guarded client/server production builds, and the two
  focused navigation/tail unit files pass. The Yarn registry audit reports
  zero known advisories across 467 locked packages; `yarn check --integrity`
  reports the install in sync; the dry-run npm package contains only the 19
  allowlisted release files.
- A post-audit attempt to repeat the whole guarded Tier 1 aggregate was stopped:
  this execution environment propagates a command-line deny-open preload into
  nested Node stdout fixtures and makes their captured output empty. The same
  four affected files pass in their normal runner, including the complete
  16-test touched set above. The immediately preceding authoritative full gate
  remains **819/819**; no claim is made that the expanded 821-test aggregate
  ran after the audit hardening.
- The feature test audit then used a strictly filtered dotenv-opaque selection
  that excludes all four fixture-owning Tier 1 files. Its unchanged baseline
  passed **817/817** three times; after the five test repairs it passed
  **817/817** again. Tier 2 passed **139/139** in each of three unchanged runs.
  Unchanged Tier 3 was **114/114**, **113/114** on the CR.2 timeout above, then
  **114/114**; the post-repair complete run passed **114/114**. The managed
  browser matrix plus visual suite passed **9/9** three unchanged times and
  **9/9** after repair. Three credential-stripped Tier 4 repetitions passed the
  Codex local-model cases **3/3** with one hosted-credential skip and OpenCode
  **1/1** each time; no metered hosted model was called.
- After cold-review repair, final TypeScript, safe Tier 1 **817/817** across 87
  explicitly enumerated files, feature Chrome **5/5**, targeted visuals
  **7/7**, freshly built Tier 3 **115/115**, and combined UI/visual **10/10**
  pass. The two 59×29 enabled-arrow crops cover dark and light with zero
  differing pixels allowed. Tier 2 was not rerun after repair because only
  Tier 1, Tier 3, and UI test artifacts changed; its three unchanged baselines
  remain applicable.

## Dotenv safety

Recursive discovery explicitly excluded `.env`, `*.env`, `.env.*`, and
`*.env.*`. Authoritative Node gates ran either under a deny-open preload or in
a sanitized mirror with those files absent and fixture-owning test sources
explicitly excluded. The authoritative TypeScript/Vite/esbuild gates invoked
the installed executables directly rather than Corepack, and Vite also used
`envDir: false`.

One final test-audit Tier 1 command accidentally used the broad test glob in the
sanitized mirror and included the four known test sources that create/read
synthetic dotenv fixtures. No real repository dotenv file existed in that
mirror and no secret was exposed, but running those synthetic fixtures still
violated the opacity rule. Its **874/874** result is discarded. The corrected
authoritative run enumerated and validated 87 safe paths first, excluded all
four fixture-owning sources and every dotenv filename variant, and passed
**817/817**.

One earlier `yarn typecheck` command completed without the preload. A later
guarded Yarn attempt proved why that path is not authoritative: Corepack's
installed `loadSpec` code always attempts `readFile` on `.corepack.env` unless
`COREPACK_ENV_FILE=0`, and the guard stopped that attempt. Whether the earlier
unguarded attempt found a file and returned contents is unverified; no dotenv
contents appeared in output, and no dotenv file was inspected afterward to
resolve that uncertainty. The typecheck was rerun successfully through the
installed TypeScript executable under the guard.
