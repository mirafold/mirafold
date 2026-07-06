# genui-shell — Build Plan

A generative-UI shell over Claude Code. Claude Code's full agentic backend
(filesystem, bash, tools, the warm session loop) runs behind a web front end
where the agent's output stream is treated as a **UI-instruction stream**: the
agent paints into an output zone whose components change shape per response,
while a fixed, trusted shell holds the prompt box and the connection.

Business strategy — positioning, wedges, pricing, go-to-market, and the
milestone gates that sequence this plan — lives in **BUSINESS.md**. The two
build-relevant conclusions from it: ship the Phase 1 demo (1.1–1.3 + 1.6)
before Phase T, and design every seam so the daemon stays local-first.

## Locked decisions

- **Scope:** personal-first, architected so multi-user is additive later.
- **Rendering:** curated component registry first (Level 2), sandboxed
  arbitrary artifacts later (Level 3).
- **Model:** `claude-sonnet-4-6` default, `claude-opus-4-8` switchable per-task.
- **Auth:** personal `ANTHROPIC_API_KEY`, server-side only. The Claude
  subscription / `claude login` cannot drive the SDK headlessly — API key is
  required.
- **Stack:** TypeScript end to end. Server: Node + Agent SDK + Express + `ws`.
  Front end: React + Vite. Package manager: **yarn**.
- **Distribution: local-first, installed like a terminal agent.** Ships as a
  global install — `npm i -g genui-shell`, then `genui-shell` run from **any**
  directory, on PATH exactly like `claude`/`codex`/`gemini` (`npx genui-shell`
  is the zero-install try path). The daemon runs on the user's machine; we host
  only a static site/billing and (paid tier) a dumb WebSocket relay that
  forwards wire-protocol frames. The engine never runs on hosted compute; the
  API key never leaves the user's machine. Hosted execution is explicitly out
  of scope. (Rationale: BUSINESS.md §5; packaging is PLAN Step 4.10.)
- **Sessions are decoupled from connections.** A connection is a *viewport*
  that attaches to a session in a server-side registry; sessions survive
  refreshes/disconnects and fan out to many viewports (second tab, phone via
  relay). Phase 0 ships the simpler one-session-per-connection stopgap; the
  registry lands in Step 4.2 and is the substrate for persistence (4.1), the
  fleet view (4.6), and the relay (4.7).
- **A faithful browser skin of terminal agents — the product identity, and a
  core requirement.** genui-shell is **not** a generic UI with a swappable
  model. It is a **faithful browser re-skin of whatever terminal coding agent
  you already use** — Claude Code today, Codex (OpenAI) and Gemini CLI next —
  with genui-shell's generative UI layered on top. A Codex user gets **Codex**
  in the browser (its tools, its behavior, its config), never "Claude things";
  a Claude Code user gets Claude Code. "Provider-neutral" here means **faithful
  to each agent**, NOT one homogenized experience, and **no agent is
  privileged**. Mechanically: behind the `AgentSession` seam we run **each
  agent's own engine** and normalize its event stream into `WireMsg`;
  genui-shell's `render_*` / `emit_artifact` tools inject into each agent via
  **MCP** (Claude Code, Codex, and Gemini CLI all support MCP). No translation
  proxy in the request path. We do **not** build a generic agent loop or our
  own tools — that would be faithful to no one. The substrate is already right:
  the wire protocol, output zone, security model, and generative UI consume
  `WireMsg` only, so a new agent is one adapter, not a rewrite. It is the
  **next build front (Phase P)**, ahead of the rest of Phase 4. (Local models
  come through whichever agent can point at a local endpoint — Phase L is the
  ergonomics; Step 1.4's render fallback lets weaker/local models degrade to
  styled text.)
- **Dev without the API:** when `ANTHROPIC_API_KEY` is unset the server falls
  back to a `MockSession` — same `AgentSession` interface, same wire protocol,
  scripted replies (5 shuffled demo templates). Every UI capability is built
  and tested against the mock first; live-agent verification comes last.
- **UI verification:** every front-end step is verified in headless Chrome via
  `playwright-core` (drives real typing/clicks against the system browser).

## Design identity (locked during Phase 0)

genui-shell is a **terminal successor, not a chat app** — the design signals
terminal lineage on the input side and web richness on the output side.

**Visibility superset (locked 2026-07-05):** genui-shell is a different skin
on the same terminal agent, and it must never show *less* than the terminal
does — richness is added on top of raw visibility, never traded against it.
Anything a terminal Claude Code user can see in the stream (thinking text,
full tool arguments and diffs, subagent progress, todo checklists, output
depth, cost/context meters) must eventually be surfaced here, because any
line the terminal shows and we hide is a reason for a terminal user to go
back. Phase T was the *capability* cut of parity (act, interrupt, approve);
**Phase T2** below tracks the remaining *visibility* gaps.

The offer, in one sentence: **total faithfulness to the terminal and its
abilities, with a much better view and far more functionality, because the
full power of HTML/CSS/JS is available to the output.** And fidelity costs
nothing here precisely because of that power — the standard pattern for any
stream that would muddy the transcript (thinking, verbose tool detail,
subagent churn) is: render it live while the turn runs, then fold it to a
dim one-liner (click to expand) once the final response lands. Collapsed-by-
default is fine — invisible is not. The web skin gets to do what the
terminal can't: keep every line AND keep the transcript clean.

- Full-width canvas; no centered column. If long prose lines ever itch, cap
  prose only (`max-width: 80ch`) — never tables, code, or components.
- User input renders as a **command strip**: tinted full-width band, green
  `❯` glyph, monospace, left-aligned. No bubbles. Strips segment the
  scrollback; everything between strips is agent output.
- Input is a slim command bar (glyph + monospace textarea). Enter sends,
  Shift+Enter newlines. No send button.
- Agent output stays proportional type + rich markdown. The mono-in /
  rich-out contrast **is** the visual identity.
- Status is a dim monospace activity line (`✳ thinking…` / `⚙ Bash`), not a pill.
- Future: slim status bar (model, connection, session) fits the workbench
  feel; any side panels must be emergent/collapsible (see Step 1.6).

## The core security model (do not violate)

Two zones, hard boundary between them:

```
┌─ OUTPUT ZONE — agent-controlled, sandboxed ──────────┐
│   Level 1: styled markdown                            │
│   Level 2: registry components                        │
│   Level 3: sandboxed-iframe artifacts                 │
├─ SHELL — TRUSTED, never re-rendered by the agent ─────┤
│   prompt box · WebSocket client · all credentials     │
└────────────────────────────────────────────────────────┘
```

- The prompt box, the socket, and the API key live in the **shell**. The agent
  can never touch, re-render, or read them.
- The agent only ever emits content into the **output zone**.
- The API key never reaches the browser. It lives in the server process only.
- Anything the agent generates that executes (Level 3) runs in a sandboxed
  iframe with no access to the shell's scope, talking back only through the
  mediated action bridge (Phase 2).

## The wire protocol (the spine everything hangs off)

A tiny envelope sent server→browser over the WebSocket. Seeded in Phase 0 with
the minimum; later phases **add message types**, never reshape the existing
ones.

```ts
type WireMsg =
  | { type: "text_delta"; text: string }                 // Level 1
  | { type: "status"; state: "thinking" | "tool"; label?: string }
  | { type: "turn_end" }
  | { type: "error"; message: string }
  | { type: "render"; component: string; props: object; id: string }
  //                (shipped in 1.1–1.3; re-sending an id updates that
  //                 component's props in place — this is what makes pinned
  //                 widgets live, see Step 1.6)
  // Phase T adds:  { type: "tool_output"; ... } and { type: "permission_request"; ... }
  // Phase 2 adds:  action descriptors carried inside render props
  // Phase 3 adds:  { type: "artifact"; html: string; id: string }
  // Phase 4 adds:  { type: "session_created"; sessionId: string; cwd: string }
  //                and session metadata for the fleet view (Step 4.6)
  // Phase T2 adds: { type: "thinking_delta"; text: string }, optional fields
  //                widening tool_use (full input) / tool_result (truncation),
  //                subagent attribution, and { type: "usage"; ... } for the
  //                status bar — all additive; optional fields old clients
  //                simply ignore.
  // Step 4.9 adds: bang_start / bang_output / bang_end (the `!` PTY stream;
  //                up: bang / bang_input (ephemeral stdin) / bang_kill).
```

Browser→server is just `{ type: "prompt"; text: string }` plus
`{ type: "interrupt" }` / `{ type: "permission_response"; ... }` (Phase T),
`{ type: "action"; ... }` (Phase 2), and
`{ type: "attach"; sessionId }` / `{ type: "create"; cwd? }` (Phase 4 —
connections become viewports onto registry sessions). The output zone is an **interpreter** for
`WireMsg`; building new UI capability = adding a message type + a handler.

## How to use this plan

Each step below is sized to be completed reliably in a single prompt. Work them
in order. Each has **Goal / Build / Files / Done when**. Do not start a step
until the previous step's "Done when" is satisfied. Check items off as you go.


---

## Completed phases (archived)

Phases 0, T, 1, 2, 3, T2, and P are **done** — their steps and full dated status
notes now live in **PLAN-ARCHIVE.md** (moved out to keep this document focused).
Everything below is the remaining work.

---

## Phase 4 — Product hardening (the "others would want it" path)

Goal of the phase: persistence, multiple sessions, polish, robust resume, and
the multi-user seam. Each step is optional/independent — do as needed. **Do
Phase P first:** provider-neutrality is a prerequisite, not a parallel track,
and the remaining Phase 4 polish (theming, resume, fleet view, relay) waits on it.

- [x] **Step 4.1 — Session persistence**
  - Build: persist conversation + render history; restore on reconnect so a
    drop/refresh resumes the same view.
  - Done when: refreshing the page restores the conversation and rendered
    components.
  - Status: **done via 4.2 (2026-07-05)** — the registry's per-session ring
    buffer replays the full WireMsg history on every attach, so refresh
    restores transcript + components. NOTE (corrected 2026-07-05): a genuine
    page reload does **not** restore *pins* — pin state is un-persisted
    output-zone React state, never on the wire and not in the replay buffer,
    so a hard refresh repaints the components un-pinned (verified in headless
    Chrome: pin → Ctrl+R → component returns, pin gone). Pins survive only a
    socket-level reconnect (React state isn't torn down), not a page reload.
    Persisting pins across refresh (e.g. localStorage keyed by session id) is
    unbuilt. In-memory only: durability across daemon restarts folds into 4.4.

- [x] **Step 4.2 — Session registry (decouple sessions from connections)**
  - Goal: sessions survive refreshes and disconnects; a connection is a
    viewport, not a session. This is the substrate for 4.1, 4.4, 4.6, 4.7.
  - Build: server-side `Map<sessionId, Session>` that outlives sockets. Add
    `{type:"attach", sessionId}` / `{type:"create", cwd?}` to `ClientMsg` and
    `{type:"session_created"}` to `WireMsg`; route each connection's prompts
    to its attached session and fan the session's `WireMsg` stream out to
    **all** attached viewports. `ws.on("close")` detaches (never closes) the
    session; sessions die only on explicit close or idle timeout. Keep a
    per-session ring buffer of emitted `WireMsg`s and replay it on attach so
    a mid-conversation tab catches up (the cheap precursor to 4.1). Each
    session gets its own working dir (`create` takes a `cwd`) — the mental
    model is **session ≈ project**. Front end: URL routing `/s/<sessionId>`
    (a tab is a session view — refresh-safe, bookmarkable), a session strip
    in the shell (name = last cwd segment or first-prompt summary,
    renamable), and browser-tab affordances: `document.title` + favicon
    reflect state (thinking / idle / needs-permission) so the tab bar itself
    reads as a fleet view.
  - Files: `server/index.ts`, `server/registry.ts`, `server/protocol.ts`,
    `web/src/Shell.tsx`, `web/src/ws.ts`, router.
  - Done when: two tabs on the same `/s/<id>` see the identical live stream;
    refreshing mid-turn reattaches without losing the session; two different
    ids run two agents in different cwds concurrently.
  - Status: **done, verified mock + live (2026-07-05)** — `SessionRegistry`
    (create/attach/detach/broadcast, 4000-msg ring buffer, 60-min idle
    reaper); user strips come off the wire (`user_prompt` WireMsg, local
    echo removed); `zone_reset` + replay repaint on every (re)open; stale
    ids fall back to create; `/s/<id>` via history.replaceState; tab
    title+favicon reflect idle/working/permission. Mock 12/12; live: two
    concurrent agents in different `workspace/<id>` cwds + post-refresh
    codename recall on the same warm session. Deferred to 4.6: the session
    strip / rename UI (needs a session-list message).

- [x] **Step 4.3 — Theming & output-zone polish**
  - Build: theme system, transitions as components mount, friendlier visuals.
  - Done when: the experience feels deliberately designed, not default.
  - Status: **done, verified in headless Chrome (2026-07-06)** — the ~65
    scattered hex values became one semantic token system (`:root` custom
    properties; accidental near-duplicates like #8b94a7/#8b96a8 merged), and
    a **light theme** landed with the identity-preserving twist: the terminal
    chrome (prompt box, command strips, bang/perm/status bars, onboarding)
    re-declares the dark palette inside light mode — mono-in/rich-out made
    literal — and code/diff surfaces are pinned dark everywhere (hljs
    github-dark unswapped; code reads as a terminal window on any canvas).
    Chart SVG inks moved to token-driven `style` props (series palette
    unchanged). ☾/☀ toggle in the status bar, localStorage-persisted,
    applied pre-paint in index.html (no flash). Motion: 160ms rise on
    transcript entries, theme-fade transitions, ::selection/focus-visible/
    scrollbar polish, all off under prefers-reduced-motion. Verified 8/8:
    default dark, toggle to light (chrome stays #161c28/#18202e, code stays
    #0d1117), persistence across reload, toggle back; screenshots eyeballed
    in both themes (dark unchanged; light shows dark terminal blocks on a
    light canvas as designed).

- [ ] **Step 4.4 — Robust reconnect / session resume**
  - Build: replace the Phase 0 reconnect stub with real resume — re-attach to
    the live warm session (or rehydrate from persistence) without losing
    in-flight state.
  - Done when: a network blip mid-turn recovers cleanly.

- [ ] **Step 4.5 — Multi-user seam (optional)**
  - Build: per-user auth + session ownership at the shell boundary; the rest of
    the stack is unchanged because the seam was kept clean from Phase 0.
  - Done when: two users have isolated sessions and credentials.

- [ ] **Step 4.6 — Mission control (fleet view)**
  - Goal: the ambient supervision surface — wedge 1 in BUSINESS.md made
    literal. Only possible because 4.2 gave sessions identity.
  - Build: root page at `/` listing all live sessions from the registry —
    name, cwd, status, last activity, optionally a pinned widget preview —
    each row linking to `/s/<id>`, plus a "new session" affordance (pick
    cwd). Server exposes session metadata (registry summary broadcast or
    fetch-on-load + status pushes).
  - Files: `web/src/FleetView.tsx`, `server/registry.ts`, `protocol.ts`.
  - Done when: with three sessions running, `/` shows all three with live
    status, and clicking one drops into its transcript.

- [ ] **Step 4.7 — Hosted relay seam (the paid tier)**
  - Goal: see and drive local sessions from another device (phone), without
    the engine or the API key ever leaving the user's machine.
  - Build: the daemon dials **out** via WSS to the relay with a pairing
    token; the relay is a dumb forwarder that matches a remote browser to
    the daemon and shuttles `WireMsg`/`ClientMsg` frames — to the registry
    it is just another attached viewport (4.2 fan-out does the work). The
    relay never executes anything and never sees the key; it does see frame
    content in transit, so plan for per-pair E2E encryption before charging
    for it. Relay service itself lives in a separate repo/deploy; this step
    is the daemon-side pairing + client-side "connect via relay" path.
  - Files: `server/relay-client.ts`, config for pairing token; relay service
    external.
  - Done when: a phone on a different network attaches to a home session
    through the relay and the stream matches the local tab byte-for-byte.
    (Business gating: BUSINESS.md §9, gate M3 — build only after M2 passes.)

- [x] **Step 4.8 — Working directory = terminal parity**
  - Goal: launching `genui-shell` behaves like launching a terminal agent — it
    operates on a **real** directory you chose, and you can always see which
    one. Closes the "why is my agent stuck in a scratch workspace?" gap.
  - Build: (a) default a session's cwd to the directory the daemon was launched
    from (`process.cwd()`), not `workspace/<id>` — the terminal's own model
    (`registry.ts:59`; arbitrary-cwd safety was already settled 2026-07-05 —
    loopback bind + Origin guard close the remote-cwd vector, not the retired
    jail). (b) Onboarding gains a working-directory choice beside the agent
    picker: a type/paste-a-path field first (a browsable folder tree, backed by
    a local directory-listing endpoint, can fold in later). (c) The trusted
    shell shows the session's cwd as a prompt-line affordance (e.g.
    `~/Projects/foo ❯`), shell-owned so the agent can never spoof it — the data
    already arrives via `session_created.cwd` (`Shell.tsx`).
  - Files: `server/registry.ts`, `server/index.ts`, `web/src/Onboarding.tsx`,
    `web/src/Shell.tsx`, `web/src/PromptBox.tsx`, `web/src/styles.css`.
  - Done when: a stranger runs `genui-shell` in a real project and the session
    operates on that directory (not a scratch dir), the cwd is visible at the
    prompt, and a second session can be pointed at a different folder from the
    picker.
  - Status: **done, verified mock (2026-07-06)** — default cwd is
    `process.cwd()` (`resolveCwd` in registry.ts: `~` expands, path must
    exist — `cd` semantics, a typo rejects the create instead of mkdir-p'ing
    a stray dir); onboarding gained a prefilled working-directory field
    (rejection error shown inline, retry works); the prompt line shows the
    shell-owned `~/Projects/foo ❯` (left-ellipsized, spoof-proof) and the
    status bar the cwd leaf. Additive protocol: `agents` hello now carries
    `cwd`+`home` (for the prefill and ~-display). Fixed en route: a
    `session_created` now zone_resets before replay, so a rejected-create
    error never lingers above the new transcript. Headless Chrome 14/14
    (default dir, refresh, second session in a typed dir, bad→retry) +
    replay-after-reload intact. Live path unchanged (cwd flows to adapters
    exactly as before). Deferred as planned: browsable folder tree.

- [x] **Step 4.9 — `!` bash passthrough (interactive, via PTY)**
  - Goal: terminal-faithful `!`, and *better* than the terminal agents' `!` —
    theirs run without a TTY and so can't do `sudo`, `ssh`, or any program that
    prompts. genui-shell's `!` is a **real** shell: interactive commands work.
    No feature is lost switching from the terminal.
  - Build: the trusted shell intercepts a leading `!` and runs the rest as a
    shell command in the session's cwd, **not** routed through the model
    (instant, zero tokens, deterministic). Spawn it through a **PTY**
    (`node-pty`), not a plain pipe, so `isatty()` is true and interactive
    programs prompt normally. Add **new, additive** `WireMsg`/`ClientMsg` types
    for the PTY output stream, input, and lifecycle (never reshape existing
    ones). Output streams to the output zone **and into the agent's context**
    (terminal-faithful — the model sees what you ran; injected at the adapter
    seam, mechanism per-engine). Interactive input (e.g. a `sudo` password) is
    a **shell-owned, masked** affordance on a **special ephemeral path**: never
    written to the replay ring, never persisted, never echoed to other
    viewports, never in a serialized secret (per the wire-protocol
    non-negotiable). The prompt is **scoped to the viewport that issued the
    `!`** and is *not* broadcast — matters once the relay exists (a `sudo`
    prompt must never fan out to a phone).
  - Tier 1 (this step): line-interactive prompts — `sudo`, `y/n`, ssh
    host-key. Tier 2 (**deferred, stretch**): a full embedded terminal
    (`node-pty` + xterm.js — pure-JS front end, no new native module) so
    `!vim`/`!top`/curses apps render; arguably its own feature.
  - Files: `server/protocol.ts`, `server/index.ts`, `server/registry.ts`, a new
    `server/pty.ts`, `server/adapters/*` (context injection), `web/src/Shell.tsx`,
    `web/src/PromptBox.tsx` (masked input), `web/src/ws.ts`.
  - Done when: `!ls` runs instantly in the session cwd and its output is visible
    *and* referenced by the agent on the next turn; `!sudo -v` prompts for a
    password in a masked shell-owned field, accepts it, and succeeds; the
    password never appears in the replay buffer or a second viewport.
  - Status: **done, verified mock + live (2026-07-06)** — `server/pty.ts`
    (node-pty 1.1.0, ANSI-stripped for Tier 1), additive wire types
    (`bang_start/output/end` broadcast+replayed; `bang`/`bang_input`/
    `bang_kill` up), one command at a time per session, PTY killed with the
    session. Stdin is the ephemeral path: only the issuing viewport mounts
    the BangBar (auto-masks when the output tail is a password prompt, manual
    toggle, Ctrl-C→SIGINT, Esc/■→kill); `bang_input` goes PTY-only. Context
    injection is agent-neutral: finished transcripts (16KB tail cap) ride the
    next `pushPrompt` as `<bash-input>/<bash-output>`; the user_prompt strip
    stays raw. Mock 14/14 in headless Chrome (broadcast, replay-secrecy —
    password absent from both viewports and post-refresh replay — y/n echo
    parity, kill, exit codes); live: real `!sudo -v` prompted masked through
    the PTY (killed, not answered — full success is Kyle's password), and
    Codex quoted the `!` marker back on the next turn. Fixed en route: the
    4.8 prompt-cwd ellipsis was right-side (bidi) — now LRM-wrapped, leaf
    stays visible. Deferred as planned (Tier 2): xterm.js full terminal for
    curses apps; raw-ANSI stream; concurrent bangs; stdin re-attach after
    refresh.

- [x] **Step 4.10 — Package & publish: `genui-shell` on PATH (M2 launch)**
  - Goal: satisfy the M2 gate's "`genui-shell` works cold on a stranger's
    machine." Turn this repo from a clone-and-`yarn-dev` app into an installed
    tool. This is the last-mile launch step — sequence it at the M2 gate.
  - Build: a `bin` entry + launcher that boots the server and opens the browser;
    bundle the built web assets so production serves `./dist` (not the Vite dev
    split); a `files` allowlist; flip `private:false` and publish over the
    `0.0.1` name-reservation placeholder. Because Step 4.9 adds **`node-pty`, a
    native module**, packaging must rely on its **prebuilt binaries** so a
    normal `npm i -g` stays a clean download (no compile-on-install): pin to
    Node versions with prebuild coverage and test the install on macOS / Windows
    / Linux. **Accepted limitation (decided 2026-07-06):** users on an unusual
    platform/Node with no matching prebuild may hit compile-on-install — we do
    **not** service that long tail perfectly; document the fallback, don't
    engineer around it.
  - Files: `package.json` (bin/files/private/exports), a new `bin/genui-shell`
    launcher, `server/index.ts` (prod static serving).
  - Done when: on a clean machine, `npm i -g genui-shell` then `genui-shell` in
    any directory boots the daemon, opens the browser, and drives the user's own
    agent — no clone, no `yarn`. (Ties to BUSINESS.md §9 gate M2 + §5.)
  - Status: **built + verified cold 2026-07-06; the `npm publish` itself is
    deliberately NOT run — it's the M2 launch trigger and Kyle's call** (repo
    held private by choice; `npm publish` when ready, over the 0.0.1
    placeholder). What shipped: `bin/genui-shell.js` (spawns the bundle from
    the launch dir, opens the browser off the printed URL, `--no-open`);
    `yarn build` now also esbuilds `dist-server/{index,render-mcp}.js`
    (deps external); adapters spawn the render-MCP via `renderMcpCommand()`
    (compiled twin beside the code, else tsx+TS — codex/gemini both);
    dist served package-relative, not cwd; EADDRINUSE walks up to 20 ports
    (plus a ws quirk fix: WebSocketServer re-emits listen errors — swallow
    EADDRINUSE there or the walk dies); package.json: bin/files/engines
    (>=20.12), web-only deps demoted to devDependencies → 9-file 235 KB
    tarball, 109-package install. Verified: `npm pack` → `npm i -g` into a
    clean prefix (~28 s incl. node-pty Linux compile — macOS/Win have
    prebuilds, Linux toolchain fallback documented in README §8), then from
    two different dirs: onboarding prefills each launch dir, mock turn +
    `!` PTY work through the production bundle, second daemon walks to
    :3001, xdg-open called with the right URL (stubbed); live: Codex
    session in the installed copy spawned the COMPILED render-mcp.js and
    painted a render_card. `npx genui-shell` untested against the registry
    (needs the publish); macOS/Windows install untested here — both are
    launch-day checks.

---

## Phase L — Local models: zero-friction (ergonomics on top of Phase P)

Goal of the phase: someone running a local LLM uses their agent in genui-shell
as easily as a cloud user — inference never leaving the machine. **Local isn't
a genui-shell feature; it's a property of the agent.** A terminal agent that
can point at a local endpoint (e.g. Codex against a local OpenAI-compatible
server — Ollama / vLLM / LM Studio) already runs locally; genui-shell just
re-skins that agent, so a "local" session is just that agent configured for
localhost — **no LiteLLM, no shim.** This phase is only the ergonomics and
honest guidance. (Prereq: Phase P, and Step 1.4's render fallback so small
models degrade to styled text, not broken UI.)

**Posture (locked 2026-07-05):** best-effort support for *whatever* endpoint a
user's agent points at, with an honest heads-up that small/unusual local models
may misfire (tool calls, loops) and degrade to plain text. Don't gate on a
curated model list. Agent- or model-specific niceties (tuned prompts,
capability toggles) for the big popular ones can come **later**, as demand
shows which matter — not a launch prerequisite.

- [ ] **Step L.1 — Documented local path (ship with the M2 launch)**
  - Goal: a motivated local-model user is running in a couple minutes.
  - Build: `docs/local-models.md` — point a local-capable agent (e.g. Codex) at
    a running Ollama/vLLM/LM Studio (base URL + model, no proxy); an honest
    "recommended models" table (30B+ coding models work well, small models
    degrade gracefully via Step 1.4 — with hardware notes).
  - Files: `docs/local-models.md`, README link.
  - Done when: a stranger following only the doc drives a local model through
    the browser UI; the launch post can truthfully say "BYOK or fully local."

- [ ] **Step L.2 — `--local` easy mode (post-M2, demand-gated)**
  - Goal: one command instead of a couple minutes — build only if setup
    friction shows up in the tracker.
  - Build: `npx genui-shell --local` detects a running Ollama/LM Studio, lists
    installed models, and configures a local-capable agent to use it with sane
    defaults (no proxy). Status bar shows the active agent/model.
  - Done when: on a machine with Ollama + a supported model, `--local` cold
    start reaches a working session with zero manual config.

- [ ] **Step L.3 — Per-session provider (stacks on 4.2, optional)**
  - Goal: mix providers in one daemon — Claude for the hard refactor, a
    local model for the log-tailing session.
  - Build: `create` (Step 4.2) accepts an optional `provider`/`model`;
    registry passes per-session env/config to the Agent SDK session; fleet
    view (4.6) shows each session's model.
  - Done when: two concurrent sessions run on two different providers and
    the fleet view distinguishes them.

---

## Conventions

- TypeScript everywhere; yarn for all package operations.
- The wire protocol is the contract — add message types, never reshape existing
  ones, so each phase is additive.
- API key and any secret stay server-side. Never serialize them into a
  `WireMsg` or send them to the browser.
- The trusted shell (prompt box, socket, credentials) is never rendered or
  controlled by agent output. Treat that boundary as inviolable.
- Comments only where there's a non-obvious constraint (e.g. the iframe sandbox
  threat model) — the code says what it does.
