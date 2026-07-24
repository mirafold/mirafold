# Mirafold — post-release backlog

The unordered post-R.7 idea intake, moved out of PLAN.md 2026-07-19 to keep
that file the ACTIVE plan. Nothing here gates any Phase R (launch) work; the
reorder/prioritize pass happens after R.7. ROADMAP.md summarizes this list and
its cross-repo implications.


Feature ideas parked for after launch. This is deliberately an unordered
intake — the reordering/organizing pass happens when we get there,
post-R.7 — and none of these gates a Phase R step. Where an idea already
has a home in this plan, the entry points there instead of duplicating it.

- [ ] **Desktop app** — the first follower after release. An Electron shell
  so running Mirafold needs no terminal/Node/npm: a thin, separate repo that
  consumes the published `mirafold` package (which ships daemon + built
  client together, so there's no UI or server duplication) and opens the
  daemon's URL in its window. Shell-side seam to cut first: export a
  programmatic entry (`startDaemon(opts) → { url, close }`) beside the CLI.
  Known lifts beyond packaging: a folder picker replaces "run in the current
  directory," macOS launched-from-Finder PATH resolution, and
  signing/notarization + auto-update CI per platform.

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
  grid rather than only entering them.

- [ ] **Folder & file & diff view** — shell-owned project browsing: the
  working tree, file contents, and diffs of what the agent changed. The
  read-only v1 (file tree, contents, git diffs; desktop collapsible side
  panel + phone full-screen drill-in) was promoted to active work 2026-07-24
  and is tracked in PLAN.md as **Phase E**; this entry parks the post-v1
  depth — editing, a filesystem watcher for live updates, syntax
  highlighting.

- [ ] **Embedded terminal pane — interactive full-screen programs (vim, top)**
  (2026-07-22) — the deferred **Tier 2** of the `!` passthrough (Step 4.9): a
  real terminal box *inside* the session (a tmux-style split pane, NOT a
  separate window or app) where curses programs run, so a `!vim`/`!top` reflex
  just works instead of garbling through the ANSI-stripped Tier-1 stream.
  Serves the vim user who lives in vim beside their terminal agent today and
  would otherwise lose that when the browser replaces their tmux pane. Scope
  settled in discussion:
  - **Viewport-local, not session-shared.** The live keystroke stream is tied
    to the one viewport that opened it — explicitly NOT fanned out to the
    session's other viewports and NOT written to the replay ring. This is the
    first stream that opts out of the broadcast/replay model, so it's the part
    to design deliberately rather than bolt on. The *work* stays session-bound:
    same cwd/files, and the agent is handed the resulting **diff** on exit,
    never the keystroke stream (which would blow up tokens).
  - **Desktop/laptop viewports only.** Not offered on a phone viewport — a
    touch keyboard plus a small screen make full-screen modal editing a
    non-use-case, and gating it here sidesteps both relay keystroke latency and
    the narrow-split layout problem. Phone degrades gracefully (the "open in
    vim" affordance simply isn't shown).
  - **Cheap on the backend, ordinary on the front.** The PTY is already
    `xterm-256color` and stdin already flows (`server/pty/pty.ts`); the deltas
    are a raw (un-stripped) output path beside `cleanPtyOutput` plus a `resize`
    on `BangProc`, additive wire messages (raw bytes as base64 since
    `bang_output` is text today; resize; keystroke routing — add, never
    reshape), and an xterm.js split pane with focus management on the front
    end. Auto-open when a program enters the alternate screen (`\x1b[?1049h`),
    collapse on exit. Adjacent to "Folder & file & diff view" above but
    distinct (a live terminal, not a viewer). Rough size: ~a week for a solid
    v1; the viewport-local stream is the only part that touches a core
    assumption.

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

