# Session handoff — Phase UX / agent-session-continuity

This handoff is current as of 2026-08-09. It becomes stale once Step UX.6 in
`PLAN.md` is completed and the feature branch is integrated or replaced.

**Project**: Mirafold, a browser re-skin of Claude Code, Codex, and Gemini CLI.
This session implemented native pre-submit discovery, quieter provider-faithful
tool presentation, and durable provider-session recovery.

**Completed this session**

- Created `feature/agent-session-continuity` from `next`; `next` is verified as
  an ancestor.
- Added additive `prompt_options` wire data. Claude consumes the SDK's live
  supported-command updates, Gemini consumes ACP command updates, Codex uses a
  version-matched broad slash catalog, and Codex `$` skills come from the live
  app-server skills list. The browser opens and filters the appropriate picker
  from the first trigger character, before submission, with mouse, arrow,
  Tab/Enter insertion, and Escape dismissal.
- Collapsed each completed turn's successful tool churn into one expandable
  `worked · N actions` row. In-flight work and failures remain visible, and the
  normalized details remain available on expansion.
- Added bounded, owner-only, atomically replaced session checkpoints containing
  transcript state, exact non-secret backend selection, and native provider
  resume identifiers. Idle timeout unloads the engine without deleting the
  checkpoint. Daemon restart reindexes dormant sessions, reopens the same URL,
  and resumes Claude, Codex, or Gemini when that provider supplied a resume id.
  Explicit End Session deletes the record; corrupt/unavailable recovery is
  shown instead of silently creating a blank conversation.
- Added restart correctness for mid-turn death: full replay across daemon
  epochs, an honest interruption/turn boundary, and closure of unmatched shell
  activity. Added deterministic provider/picker/tool/recovery coverage and
  synchronized `README.md`, `docs/ADAPTERS.md`, `PLAN.md`, and
  `PLAN-ARCHIVE.md`. No dependency was added.
- Verified the exact final implementation before this handoff: typecheck,
  production build, unit 583/583, server integration 144/144, browser
  end-to-end 83/83, the full axe-core accessibility sweep, and `git diff
  --check` all passed.

**Current state**

- Branch: `feature/agent-session-continuity`, based on `next`.
- The 2026-08-09 wrapup committed and pushed all Phase UX implementation,
  tests, documentation, plan, and handoff state to this feature branch.
- Main new seams are `server/sessions/session-store.ts`, session lifecycle in
  `server/sessions/registry.ts`, provider catalog plumbing under
  `server/adapters/`, `web/src/prompt-completions.ts`, prompt UI in
  `web/src/components/PromptBox.tsx`, and settled tool presentation in
  `web/src/tool-visibility.ts` / `web/src/components/RenderZone.tsx`.
- The current code binds `Shift+Escape` to focus the prompt. That mechanism
  works and is tested, but the binding is not an accepted product decision.

**Next step**

- Continue **PLAN.md Step UX.6**. First discuss and obtain Kyle's decision on
  how a keyboard user returns to the prompt; do not assume a binding. Then
  implement and test that decision and run the `refactor` skill over the Phase
  UX / agent-session-continuity diff without changing its accepted behavior.

**Watch-outs**

- Never describe the focus issue as resolved while `Shift+Escape` remains
  provisional. It was invented during implementation and was not confirmed.
- Normal `Tab` order is accessibility-critical because response content has
  interactive links, buttons, permissions, and generated controls. Do not
  redirect every Tab press to the prompt.
- Kyle does not want another permanent hint in the prompt line. A keyboard-only
  “Skip to prompt” link was explained as a possible compromise: hidden normally,
  visible at the top-left only while focused, activated with Enter. It was not
  approved, and its inability to jump from anywhere was acknowledged.
- `Cmd/Ctrl+K` was also discussed but terminal users may understand those keys
  as kill-to-end-of-line or clear-scrollback, not focus-prompt.
- Recovery can protect only sessions checkpointed by this implementation; it
  cannot resurrect the session that died before this code existed. If a
  provider dies before ever yielding a native resume identifier, Mirafold must
  remain honest about that rather than promise the same provider conversation.
- Preserve dotenv opacity: never inspect `.env`, `*.env`, `.env.*`, or
  `*.env.*`, and explicitly exclude them from recursive searches/listings.
