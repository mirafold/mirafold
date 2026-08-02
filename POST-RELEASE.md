# Mirafold — post-release backlog

The unordered post-R.7 idea intake, moved out of PLAN.md 2026-07-19 to keep
that file the ACTIVE plan. Nothing here gates any Phase R (launch) work; the
reorder/prioritize pass happens after R.7. ROADMAP.md summarizes this list and
its cross-repo implications.


Feature ideas parked for after launch. This is deliberately an unordered
intake — the reordering/organizing pass happens when we get there,
post-R.7 — and none of these gates a Phase R step. Where an idea already
has a home in this plan, the entry points there instead of duplicating it.

- [x] **Desktop app** — BUILT 2026-08-02, in its own repo. An Electron shell
  so running Mirafold needs no terminal/Node/npm: it consumes the published
  `mirafold` package (which ships daemon + built client together, so there's
  no UI or server duplication) and opens the daemon's URL in its window.
  Linux (`.deb`/`.tar.gz`/`.AppImage`) and Windows (unsigned NSIS) build in
  CI; macOS deferred until signing is worth its annual cost.

  **This repo needs NO change to support it, and the previously-planned
  `startDaemon(opts) → { url, close }` export is NOT being cut.** The desktop
  app spawns the daemon as a **child process** instead, using Electron's own
  binary under `ELECTRON_RUN_AS_NODE=1`. That was the better design on the
  merits, not just the cheaper one: this file's crash handlers end in
  `process.exit(1)`, which in-process would kill the whole desktop app with
  nothing on screen; the daemon's continuous pty/watcher/serialization work
  would share an event loop with window management; and `process.cwd()` is
  global, so a folder picker would be one-shot per launch. As a child
  process all three are free, and the desktop build exercises the exact npm
  artifact users install.

  Reopen the programmatic-entry idea only if some OTHER embedder wants it —
  the desktop app doesn't.

- [ ] **Phone apps** — distant followers, behind the desktop app. The phone
  is a viewport, never the daemon host — the relay path (R.2–R.4) already
  *is* the phone architecture. Two stages: **(1) PWA** — manifest + service
  worker + mobile polish on the deployed app-origin bundle; near-free, no
  store, no new repo. **(2) Native store wrapper** (Capacitor-class, its own
  thin repo) only when push notifications / store presence earn the review
  and revenue-cut bureaucracy; push must stay content-free pings so the
  relay's E2E-blind story survives.

- [ ] **Subscriptions + metered model access (paid tier #2)** — sell
  Mirafold-provisioned, metered access to open models, so a subscriber gets
  a working model with zero key management. **Launch ships with the relay as
  the only paid product (locked 2026-07-15); this comes after.** Shape
  (from the 2026-07-15 design discussion): provision a scoped, spend-limited
  per-user key on an existing metered inference provider (OpenRouter-class)
  and bill from the provider's usage reports — the daemon talks to the
  provider **directly**, so Mirafold is never in the inference path and
  never sees a prompt (the no-proxy and E2E trust stories survive intact).
  Rides the agents' own custom-endpoint support (Anthropic-compatible
  endpoints, Codex custom providers) — no homegrown loop. Grows R.5's
  checkout + token-minting backend (the private billing service) with key
  provisioning, usage reconciliation, and a quota endpoint — **no new
  repo**. Enforcement is server-side only: open client code may *display*
  quota, never enforce it. Clean under the provider credential policy — this
  is the API-key path, no subscription-ToS exposure. Store-distribution
  caveat when it reaches phones: in-app purchase rules (15–30% cut, no true
  metered billing — credit packs/tiers instead); the PWA path avoids them.

- [ ] **Cockpit fleetview** — grow FleetView (4.6) into a true cockpit:
  at-a-glance live state of every session, and acting on sessions from the
  grid rather than only entering them. The v1 (live activity / pending
  permission / usage on enriched rows; permission allow/deny, interrupt, and
  quick prompt from the grid) was promoted to active work 2026-07-24 and is
  tracked in PLAN.md as **Phase M — Mission control**; this entry parks the
  post-v1 depth — a live output-preview line on rows, one-click default
  new-session, a card-grid presentation (all considered and deliberately not
  picked for v1). The **archived-session fleetview** below stays its own
  entry — Phase M leaves the `sessions` snapshot live-only so it can arrive
  additively.

- [ ] **Folder & file & diff view** — shell-owned project browsing: the
  working tree, file contents, and diffs of what the agent changed. The
  read-only v1 (file tree, contents, git diffs; desktop collapsible side
  panel + phone full-screen drill-in) was promoted to active work 2026-07-24
  and is tracked in PLAN.md as **Phase E**. Of the post-v1 depth this entry
  parked: the **filesystem watcher** was promoted 2026-07-26 to PLAN.md
  **Phase W** (live tree), and **editing** is superseded by Kyle's
  2026-07-26 call — the explorer stays read-only, possibly forever; editing
  arrives only via the terminal pane (PLAN.md **Phase TP**). Still parked
  here: **syntax highlighting**.

- [ ] **Embedded terminal pane — interactive full-screen programs (vim, top)**
  (2026-07-22) — the deferred **Tier 2** of the `!` passthrough (Step 4.9): a
  real terminal box inside the session where vim/top just work. **Promoted
  2026-07-26 to PLAN.md as Phase TP** (last phase of the Explorer→panes→
  terminal arc); the settled scope decisions this entry carried
  (viewport-local stream, desktop-only, alternate-screen auto-open, the
  cheap-backend deltas over `server/pty/pty.ts`) moved into that charter,
  where the desktop-only call is hardened to **local-viewports-only,
  daemon-enforced, fail-closed** (Kyle, 2026-07-26). The KB-shared modal
  key-routing decision is recorded there too.

- [ ] **Keyboard power-user layer — the "vim guys" keymap** (2026-07-22) —
  never needing the mouse OR the Tab-slog: fast, discoverable keys plus a
  prompt box that speaks vim. Same terminal-native persona as the embedded
  terminal pane above, and they share one design decision (below). The
  **pre-launch identity slice** (focus-visibility fixes, `?` overlay, command
  palette, opt-in prompt-box vim mode) is tracked in PLAN.md as **Phase KB**;
  this entry parks the **post-launch depth**. Two constraints govern the whole
  thing and point at the *cheapest* build: (1) nothing changes for non-vim
  users — Kyle's standing A.3 rule — met by making vim mode an opt-in setting
  (default off = today's exact textarea) and gating global shortcuts to
  focus-not-in-prompt; (2) mirror how vim users already work in a terminal,
  which the same focus-state rule delivers (prompt focused = insert mode, `Esc`
  out = normal mode where shortcuts wake — no invented mode system). Post-launch
  depth parked here:
  - **Transcript keyboard navigation** — `j`/`k` + `Ctrl-d`/`Ctrl-u` to move,
    jump next/prev turn, expand/collapse the focused tool/thinking block, pin
    the focused block. The real work is a "current entry" cursor that survives
    streaming (the transcript mutates under you), so it's post-launch, not part
    of the identity slice. ~3–5 days.
  - **True app-wide normal mode** (optional, ambitious) — beyond focus-gated
    shortcuts, a real vim-style normal mode over the whole UI (h/j/k/l +
    operators). The focus-gated v1 is 80% of the value; only build this on
    demand.
  - **Shared decision with the embedded terminal pane** — once keystrokes can
    reach the prompt, an app shortcut, OR the vim pane, the modal routing
    (which context owns the key) must be settled once and reused by both. Decide
    it with whichever of the two ships first.

- [ ] **Multiuser chat** — multiple people in one session's conversation;
  rides Phase 4's multi-user seam (Locked decisions: "architected so
  multi-user is additive later").

- [ ] **Input augment** — drag & drop and paste (files, images) into the
  prompt box; eventually voice input. All shell-owned — the trusted-shell
  boundary is untouched.

- [ ] **Skills as buttons** — surface the agent's skills / slash commands as
  clickable shell affordances instead of typed invocations.

- [ ] **Action-button transparency** (2026-07-15 audit #5, optional
  hardening) — a question/card button's visible label can differ from the
  text it sends as the user's turn (both model-authored). Backstops exist
  (the sent text echoes visibly; consequential tools still ask), so this is
  comfort, not a hole: show the exact to-be-sent text on hover (title
  attribute) so a user can inspect before clicking.

- [ ] **Archived-session fleetview** — a fleetview over ended sessions, to
  find and resume old ones.

- [ ] **Visibility** — usage and metrics surfaced in the shell (tokens,
  cost, per-session and fleet-level), and more over time.

- [ ] **Live preview** — display the project while the agent builds it
  (e.g. the project's dev server rendered beside the session).

- [ ] **Grok agent** — a fourth adapter behind the `AgentSession` seam, same
  rules as Phase P (faithful skin, no agent privileged); demand-gated on
  xAI's agent tooling maturing.

- [ ] **More protocol components** — already started: the Stretch goals
  above (S.1 pie, S.2 stacked/horizontal, S.3 stat tile) are the first
  concrete batch; keep extending the registry additively (add message
  types/kinds, never reshape) as session needs surface.
  - **HOW to grow it — the two mechanisms, and the ceiling** (2026-08-02
    analysis). The registry is loaded FLAT and UPFRONT: every render tool's
    full JSON Schema (all props, all `.describe()` strings) goes to the agent
    at session start, in both servers, plus a prose bullet each in
    `RENDER_GUIDANCE`. Nothing is deferred. Measured at 18 components:
    ~3.6k tokens of schema + ~950 of tool descriptions + ~1,050 of guidance
    + ~900 of per-tool `id`/`emit_artifact` boilerplate ≈ **6.5k tokens
    resident in every request**. That is NOT the constraint — it's a static
    prompt prefix, so prompt caching makes it near-free, and it occupies the
    same ~3% of a 200k window on turn 40 as on turn 1 (it does not
    accumulate). **The constraint is tool-selection accuracy**: each added
    tool makes the neighbors it crowds harder to pick correctly, and
    produces false positives (reaching for a narrow tool where a generic one
    fit), not just misses. The pressure is already visible in the three
    monospace components (`code`/`diff`/`console`) and the three
    ordered-items ones (`list`/`status-list`/`timeline`), whose descriptions
    spend real words fencing each other off. Two consequences:
    - **1. Prefer PROP-SPACE growth to new components — do this first, it is
      nearly free.** `render_chart` is the model: line/bar/pie + stacked +
      horizontal are one tool with a `kind` enum and two booleans, not five
      tools. Adding a `kind` costs ~40 tokens and ZERO new selection
      decisions (the model already committed to the tool; picking `kind` is
      a within-tool choice made with full context). A sibling tool costs
      ~250 tokens AND a new boundary both descriptions must defend. **Rule:
      if a proposed component would ever be confusable with an existing one,
      it belongs as a prop on that one.** Prop-space growth is ~unbounded;
      tool-space growth is capped.
    - **2. Two-tier discovery — the restructure, due at ~30 components.**
      Ceiling for the current flat design is **~30 tools** (they sit atop
      the agent's own native tools, so the real menu is already >30; past
      ~50 the industry answer is deferred loading, incl. Claude Code's own
      tool-search). Past that: keep the ~12 that fire constantly
      always-loaded, put the long tail behind `render_specialized(kind,
      props)` + a schema-fetch tool, so the agent pays ONE round-trip the
      first time per session it wants something exotic. List the available
      kinds by NAME ONLY in `RENDER_GUIDANCE` (cheap) so it knows to look.
      Watch `RENDER_GUIDANCE` as the tighter ceiling — it's sequential prose
      that shapes the decision, and it degrades with length faster than
      reference schemas do.
    - **NOT a user-facing opt-in "component pack" setting** (considered and
      rejected 2026-08-02). The user can't know at session start which
      vocabulary the agent will want three tool calls into unplanned work —
      it routes a decision to the actor with no information, and the failure
      is silent (prose where a diagram belonged, and nobody learns why).
      Auto-enable from workspace context if a pack is ever truly
      domain-bound. The legitimate user-facing mode is the INVERSE —
      **subtraction**: a plain-prose / reduced-vocabulary setting, which
      earns its keep on local models where 6.5k is ~10% of a 64k window
      (`docs/local-models.md`).
  - ✅ 2026-07-15 — first batch landed: four new registry components
    (`key-value`, `progress`, `timeline`, `file-tree` — flat paths on the
    wire, nested client-side) plus an additive `kind` callout tint on `card`
    (info/success/warning/error). Each rides the full seam: registry-spec
    schema, render tool in BOTH servers (render-tools.ts + render-mcp.ts),
    RENDER_TOOL_COMPONENT entry, React component + registry entry, guidance
    line, mock payloads. All three test tiers green; observed rendering
    against the mock in headless Chrome.
  - ✅ 2026-07-15 — `question` registry component (`render_question`): a
    structured 2–4-option fork; clicking an option sends its text as the
    user's next turn over the existing Phase-2 prompt-action path, and the
    clicked copy locks (chosen marked, buttons disabled). Same full seam as
    the batch above, plus a deterministic mock hook (`playQuestion`,
    /question|choose|decide/) and a Tier-3 e2e driving the real click →
    user-turn round trip. All three tiers green (e2e 21/21).
  - ✅ 2026-07-15 — `diff` registry component (`render_diff`): red/green
    line diff of a made/proposed change, one entry per file. Schema takes
    BEFORE/AFTER SNIPPETS, never unified-patch text (models botch @@ line
    math; snippets need no bookkeeping) — the client diffs them via
    `web/src/diff.ts`, the LCS differ hoisted out of ToolBlock so
    agent-painted diffs and Edit/Write tool diffs render identically.
    Empty before = new file (pure +), empty after = deletion (pure −).
    Same full seam; all three tiers green.

---

