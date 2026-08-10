# Session handoff — Phase UX integrated / next work

This handoff is current as of 2026-08-10 after Phase UX was integrated into
`next`. It becomes stale when `next` receives later work or the roadmap priority
changes.

**Project**: Mirafold, a browser re-skin of Claude Code, Codex, and Gemini CLI.
Phase UX and its UX.6/UX.7/UX.8/UX.9 follow-ups are complete: faithful pre-submit
discovery, quieter provider-faithful tool presentation, durable provider-session
recovery, and the approved transcript-click prompt return behavior.

**Completed**

- Added additive `prompt_options` wire data. Claude consumes the SDK's live
  supported-command updates; Codex and Gemini expose the `/model` command they
  faithfully reimplement on their current headless surfaces; Codex `$` skills
  come from live app-server metadata. The browser filters from the first
  trigger character and supports mouse, visible arrow-key selection,
  Tab/Enter insertion, and Escape dismissal before submission.
- Collapsed contiguous successful tool runs into expandable `worked · N
  actions` rows. In-flight work, failures, and intervening transcript rows are
  hard chronology boundaries, with every normalized detail available on
  expansion.
- Added bounded, owner-only, atomically replaced session checkpoints containing
  transcript state, exact server-side backend selection, and native provider
  resume identifiers. Idle timeout unloads without deletion; daemon restart
  reindexes dormant sessions and resumes the same provider conversation when a
  resume id exists. Configured endpoints remain exact through one-click startup
  and environment drift; viewportless quick prompts still unload. Explicit End
  Session deletes, but a failed durable delete leaves the live session intact;
  unavailable recovery never silently creates a blank replacement.
- Completed Step UX.6 after Kyle approved the replacement for provisional
  `Shift+Escape`: a primary desktop mouse click on inert transcript content
  focuses the prompt with `preventScroll`. Exact transcript position and
  detached follow-tail state remain unchanged during streaming. Interactive
  controls, live text selection, secondary/non-primary pointers, and touch keep
  control. Normal `Tab` traversal and keyboard scrolling are untouched. The
  global `/` and `$` provider-trigger path remains.
- Refactored the full Phase UX diff without intended behavior change: shared
  provider resume-ID observation, one fresh/recovered registry activation seam,
  isolated restart transcript repair, named checkpoint validation units,
  isolated transcript-click intent, a separated prompt-completion menu, shared
  nested tool-call rendering, clearer global-trigger naming, a stable shell
  focus callback, and removal of unreachable catalog branches. No dependency
  or wire/config contract changed.
- Closed all eight Step UX.7 correctness findings. Configured backend identity
  survives one-click startup and recovery; Codex/Gemini expose only commands
  their headless transports execute faithfully; viewportless dormant sessions
  regain idle unload; keyboard completion remains visible without page scroll;
  tool compaction preserves chronology; malformed catalog payloads fail
  locally; and failed durable deletion leaves the live session usable.
- Closed the complete Step UX.8 security audit, including its hardening-only
  and theoretical findings. A checkout-selected Claude endpoint cannot receive a parent-only
  Anthropic credential; configured endpoint URLs and hostnames (including URL
  auth/path/query data) stay server-side behind generic labels and opaque
  selection identities, and exact Claude/Codex destinations are removed from
  provider diagnostics and raw logs; authenticated recovery refuses
  endpoint/credential-mode drift;
  discovered endpoints receive neither real Anthropic credential; the local
  tag uses exact daemon-side loopback classification; Claude/Codex catalog
  metadata is visibly source-badged and display-control-safe; and checkpoints
  strictly decode only the complete sequenced transcript vocabulary before
  replay. Legacy saved catalogs have provenance recomputed from their trusted
  backend identity.
- Completed Step UX.9's branch test audit. Mutation-proven regressions now pin
  cross-turn tool grouping, checkpoint cursor collision and replay redaction,
  whitespace-delimited `$` completion, transcript-link focus ownership, and
  the `preventScroll` focus contract. Tier 4 aborts now close their Codex
  session and settle immediately instead of leaking the runner.

**Current state**

- Phase UX and its UX.6–UX.9 follow-ups are committed, pushed, and integrated
  into `next` through PR #31 (`9e833849`). All implementation, test, and
  product-documentation changes from the completed feature work are integrated;
  this documentation-only wrapup corrects the stale plan and handoff metadata.
- PR #31 carried the same product tree as closed draft PR #30, replacing that
  draft only so the final follow-up commit could carry the repository's
  required DCO sign-off.
- Main seams: `server/sessions/session-store.ts`, transcript repair in
  `server/sessions/session-recovery.ts`, lifecycle in `server/sessions/registry.ts`,
  provider plumbing under `server/adapters/`, `web/src/prompt-completions.ts`,
  `web/src/transcript-focus.ts`, prompt UI in `web/src/components/PromptBox.tsx`,
  and settled activity in `web/src/tool-visibility.ts` /
  `web/src/components/RenderZone.tsx`.
- `PLAN.md` marks UX.6 through UX.9 complete. Step L.4 is an explicit open
  follow-up for the real Codex/Ollama turn instability found by the test audit;
  the next earlier open roadmap pointer in document order remains Step 4.7,
  expanded into Phase R.

**Verification**

- Test-audit baselines passed twice at Tier 1 (581/581), three times at Tier 2
  (131/131), and three times at Tier 3 (70/70). After the test repairs, the
  final guarded gates passed at 583/583 unit, 131/131 server integration, and
  70/70 browser, plus TypeScript checking, fresh client/server production
  builds, focused mutation reruns, and `git diff --check`.
- PR #31 passed every reported merge check: DCO, Cloudflare Pages, Tier 1
  typecheck/unit, and combined Tier 2/Tier 3 integration/browser. GitHub then
  merged it into `next` as `9e833849`.
- Tier 4 remains intentionally red rather than hidden: the real local
  Codex/Ollama turn timed out in three of four unchanged attempts and passed
  once after 145.5 seconds. Its timeout cleanup is fixed and forced-abort
  tested; Step L.4 owns diagnosis of the underlying real integration.
- Two unit files and one integration file that deliberately manufacture dotenv
  fixtures were excluded under the account-wide opacity rule. The launcher
  browser file and Explorer/global-axe cases that handle that configuration
  class were excluded from the otherwise-complete safe 70-test browser matrix.
  The temporary denial guard lives only under `/tmp`.

**Watch-outs**

- Do not restore `Shift+Escape`, globally hijack `Tab`, add a skip link, or add a
  permanent prompt hint as if any were the accepted behavior. The transcript
  click is deliberate mouse intent; keyboard users retain ordinary traversal
  and the provider's naturally typed `/` or `$` discovery path.
- A click-to-focus change must keep `preventScroll`, control/selection ownership,
  and touch exclusion together. Losing any one changes the approved contract.
- Recovery protects only sessions checkpointed by this implementation. If a
  provider dies before yielding a native resume identifier, Mirafold must remain
  honest rather than promise the same provider conversation.
- Catalog suggestions are promises about the current headless transport. Do not
  re-advertise Codex terminal commands or Gemini ACP commands unless Mirafold
  implements their exact behavior on the transport it actually runs.
- Settled-tool compaction must never cross a failure, unsettled tool, non-tool
  transcript row, or batch boundary; those rows are chronology evidence.
- Do not weaken or skip the Tier 4 local-turn assertion to make the suite
  green. Diagnose Step L.4's real Codex/Ollama stall; the test now cleans up
  correctly and is exposing an unresolved live behavior.
- Preserve dotenv opacity: never inspect `.env`, `*.env`, `.env.*`, or
  `*.env.*`, and explicitly exclude them from recursive searches/listings.
