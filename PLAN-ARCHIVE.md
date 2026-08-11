# genui-shell — Build Plan · Archive (completed phases)

Completed phases, moved out of **PLAN.md** to keep the live plan focused on what's
left. Full dated status notes are preserved here verbatim. The locked decisions
and the remaining steps stay in PLAN.md; the design-identity / security-model /
wire-protocol references live in README §7 / §3 / §2.1 (PLAN.md keeps a pointer —
the duplicated copies were retired 2026-07-15).

**Done:** Phase 0 (the spine) · Phase T (terminal parity) · Phase 1 (component
registry) · Phase 2 (action bridge) · Phase 3 (sandboxed artifacts) · Phase T2
(full-stream parity) · Phase P (faithful skins — Claude Code, Codex, Gemini CLI) ·
Phase G (relay dedup — sibling repo becomes the single source) · Phase H (human
legibility) · Phase H2 (legibility follow-ups).

---

## Phase 0 — The spine

Goal of the phase: type in the browser, the warm agent streams back, renders as
styled HTML with clickable links, conversation stays warm across turns, and
bash/filesystem work (scoped to a workspace dir). A nicer Claude Code.

- [x] **Step 0.1 — Project scaffold & tooling**
  - Goal: a runnable empty project with dev scripts.
  - Build: `package.json` (yarn), `tsconfig.json`, Vite config, directory
    structure, `.gitignore` (ignore `.env`, `node_modules`, `dist`,
    `workspace/`), `.env.example` with `ANTHROPIC_API_KEY=`,
    `DEFAULT_MODEL=claude-sonnet-4-6`. Add yarn scripts: `dev:server`,
    `dev:web`, `dev` (both). Install deps: `@anthropic-ai/claude-agent-sdk`,
    `express`, `ws`, `react`, `react-dom`, `vite`, `typescript`, types.
  - Files: `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`,
    `.env.example`, empty `server/` and `web/src/` dirs.
  - Done when: `yarn install` succeeds and `yarn dev` starts both a server
    process and the Vite dev server without errors (even if they do nothing
    yet). Verify the exact Agent SDK package name/import at this step.

- [x] **Step 0.2 — Shared wire protocol**
  - Goal: one source of truth for the server↔browser message shapes.
  - Build: `server/protocol.ts` exporting the `WireMsg` union and the
    browser→server `ClientMsg` union, with only the Phase 0 variants. Re-export
    or symlink so the web side imports the same types.
  - Files: `server/protocol.ts` (and a tsconfig path alias so `web/` can import it).
  - Done when: both `server/` and `web/` typecheck against the shared types.

- [x] **Step 0.3 — Warm session + permissions**
  - Goal: one persistent Agent SDK session driven by an async generator, with
    its event stream normalized into `WireMsg`.
  - Build: `server/session.ts` — a `Session` class that starts a single
    `query()` whose `prompt` is an async generator; expose `pushPrompt(text)`
    (feeds the generator) and an async iterator / callback of normalized
    `WireMsg`. Map SDK events: assistant text → `text_delta`, tool start/stop →
    `status`, turn completion → `turn_end`, errors → `error`. `server/permissions.ts`
    — a `canUseTool` callback: allow read-only tools, gate bash/write tools to
    paths under the workspace dir.
  - Files: `server/session.ts`, `server/permissions.ts`.
  - Done when: a throwaway script can construct a `Session`, push a prompt, and
    print streamed `WireMsg` objects to the console. Confirm the session stays
    warm across two sequential prompts (no reload between turns).
  - Status: **done, verified live (2026-07-04)** — `Session` + `MockSession`
    behind one `AgentSession` interface; deltas route to the streaming turn
    by id (a mid-stream prompt can't detach a reply's tail). Live smoke:
    prompt → streamed `text_delta` + tool `status`es → `turn_end`, and the
    session recalled turn 1 in turn 2 with no reload (warm). Fix found by
    the smoke: `Session` now creates the workspace dir (spawn fails on a
    missing cwd with a misleading SDK error).

- [x] **Step 0.4 — HTTP + WebSocket server**
  - Goal: a browser can connect and exchange messages with a session.
  - Build: `server/index.ts` — Express serving the built front end, a `ws`
    server. On connection, create (or attach) one `Session`; forward
    `{type:"prompt"}` from the client into `pushPrompt`, and stream the
    session's `WireMsg` out over the socket. One session per connection for now
    (multi-session is Phase 4). Read `ANTHROPIC_API_KEY` + `DEFAULT_MODEL` from
    env; never send them to the client.
  - Files: `server/index.ts`.
  - Done when: a `wscat`/manual WS client can send a prompt and receive a
    stream of `text_delta` messages ending in `turn_end`.

- [x] **Step 0.5 — Front-end shell**
  - Goal: the fixed, trusted shell — layout + prompt box + socket client.
  - Build: `web/src/Shell.tsx` (fixed two-zone layout: output zone on top,
    prompt box pinned bottom), `web/src/PromptBox.tsx` (textarea + send;
    submitting sends `{type:"prompt"}`), `web/src/ws.ts` (WebSocket client with
    a typed `onMessage(WireMsg)` and `send(ClientMsg)`), `web/src/main.tsx`,
    `web/index.html`. Prompt box and socket live here and are never re-rendered
    by agent output.
  - Files: the above.
  - Done when: the page loads, you can type and send a prompt, and raw incoming
    `WireMsg` objects are visible (console or temporary `<pre>`).

- [x] **Step 0.6 — Output zone, Level 1 rendering**
  - Goal: streamed responses render as clean styled HTML.
  - Build: `web/src/RenderZone.tsx` — consumes `WireMsg`: accumulate
    `text_delta` into the current assistant turn and render as **sanitized**
    markdown (clickable links opening safely, fenced code with highlighting);
    show `status` as an ephemeral indicator; show `error` clearly; finalize the
    turn on `turn_end`. Add baseline CSS for a friendly, readable look.
  - Files: `web/src/RenderZone.tsx`, styles.
  - Done when: a real conversation streams in, renders as styled markdown with
    working clickable links, and multiple turns stack in the output zone.

- [x] **Step 0.7 — Workspace scoping & reconnect stub + smoke test**
  - Goal: agentic power works safely; the loop is solid end to end.
  - Build: point the session's working dir at `./workspace/` (gitignored);
    confirm `canUseTool` keeps bash/writes inside it. Write a short
    `README.md` with run instructions (note: Node 22 via nvm, yarn via
    corepack — system node is a bare v18 with no npm).
  - Status: **done, verified live (2026-07-04)** — README shipped; agent
    created/read `workspace/smoke.txt` and it matched on disk; headless
    Chrome (playwright-core + system Chrome) confirmed a SIGKILL'd server
    restart reconnects the same page and the next prompt answers, with zero
    page reloads observed.
  - Files: `README.md`; verification only for the rest.
  - Done when: you can ask the agent to create/read a file in `workspace/` and
    see it on disk; killing and restarting the socket reconnects without a page
    reload. **Phase 0 complete — this is a usable nicer Claude Code.**

---

## Phase T — Terminal parity (after the Phase 1 demo)

Goal of the phase: close the gap with the terminal Claude Code *experience* —
the engine already has capability parity; these give the browser the cockpit.
Priority order was set explicitly: tool output → interrupt → permission
prompts. Each step is independent and additive on the wire.

**Priority update (2026-07-04, end of day):** resolved — all of Phase 1
shipped (1.1–1.6 including chart and fallback) and the M1 demo GIF is
recorded and embedded in the README. Phase T is now the active build front
(T.1 → T.2 → T.3, in that order) while the M1 signal accrues; the
owner-side M1 checklist (license, npm stub, repo public, post) lives in
`~/genui-shell-next-steps.html` and BUSINESS.md §11.

- [x] **Step T.1 — Tool output in the transcript**
  - Goal: see what the agent actually did, not just that it used a tool.
  - Build: add `{ type: "tool_use"; name: string; detail?: string; id: string }`
    and `{ type: "tool_result"; output: string; isError?: boolean; id: string }`
    to `WireMsg`; normalize the SDK's tool events in `session.ts`. Render as
    collapsed, monospace blocks in the transcript (click to expand); errors
    expanded by default.
  - Done when: a Bash run shows its command and (collapsed) output inline in
    the scrollback, styled like terminal output.
  - Status: **done, verified mock + live (2026-07-05)** — tool_use blocks
    come off `assistant` messages (detail = the salient arg: command/path/
    pattern), results off `user` tool_result blocks, capped at 8KB;
    render-tool and subagent traffic excluded via an announced-id set.
    `ToolBlock` renders a dim mono row (pulsing while pending, click to
    expand, errors auto-expanded). MockSession emits use→result pairs incl.
    a failing `yarn test`. Headless Chrome: 9/9 mock checks; live Bash
    `ls -la` showed command + real output inline, collapsed.

- [x] **Step T.2 — Interrupt**
  - Goal: stop a runaway or wrong-direction turn without killing the session.
  - Build: add `{ type: "interrupt" }` to `ClientMsg`; wire to the SDK's
    `interrupt()`. Esc key + a stop affordance in the shell while a turn is
    streaming.
  - Done when: Esc mid-stream halts output, the session stays warm, and the
    next prompt works.
  - Status: **done, verified mock + live (2026-07-05)** — shell tracks busy
    (user_prompt → turn_end) and shows a `■ esc` button in the command bar;
    Esc works page-wide. Session.interrupt() → SDK interrupt + guaranteed
    turn_end; Mock cancels its scheduled tail. turn_end also settles any
    still-pending tool rows ("interrupted — no result"). Mock: 8/8 checks
    (incl. cancelled turns never receive their trailing component). Live:
    Esc halted "count to 60" mid-stream and the same session then answered
    "what was I doing?" with the counting task — warm, no reload.

- [x] **Step T.3 — Browser permission prompts**
  - Goal: interactive approval like the terminal, rendered by the trusted shell.
  - Build: `canUseTool` awaits the browser — server sends
    `{ type: "permission_request"; tool: string; detail: string; id: string }`,
    client replies `{ type: "permission_response"; id: string; allow: boolean }`.
    Timeout defaults to deny. The prompt UI is shell-owned (never agent-rendered).
  - Done when: a gated Bash command pauses the turn, an Allow/Deny bar appears,
    and the decision resolves the tool call.
  - Status: **done, verified mock + live (2026-07-05)** — every Phase 0 hard
    deny became an ask (out-of-workspace Bash/writes, unknown tools);
    in-workspace activity stays promptless. Deny is the default on timeout
    (`PERMISSION_TIMEOUT_MS`, 60s), disconnect, and Esc/interrupt. The amber
    bar is drawn by the Shell next to the prompt box. Mock 11/11 (allow,
    deny, timeout-denies, bar clears with turn); live: `cat /etc/hostname`
    paused pulsing on the bar → allow ran it (real hostname in the block);
    `cat /etc/passwd` denied → zero file content on the wire, agent
    acknowledged. **Phase T complete — terminal parity shipped.**

---

## Phase 1 — Component registry (Level 2 generative UI)

Goal of the phase: the output zone transforms per response. The agent picks and
parameterizes **your** components; it does not author them. Reliable and safe.

- [x] **Step 1.1 — Extend protocol with `render`**
  - Goal: a typed contract for "show component X with props P".
  - Build: add `{ type: "render"; component: string; props: object; id: string }`
    to `WireMsg`. Define a `RegistrySpec` listing allowed component names and a
    JSON schema (or zod schema) for each component's props. Semantics: a
    `render` with an already-seen `id` **updates that component's props in
    place** — this is the mechanism behind live pinned widgets (Step 1.6).
  - Files: `server/protocol.ts`, `server/registry-spec.ts`.
  - Done when: types compile; the registry spec enumerates the Phase 1
    components (card, list, table, link-group).
  - Status: **done (2026-07-04)** — spec is zod shapes (the SDK's `tool()`
    takes the raw shape directly, so tool schema = spec = validation, one
    source of truth); derived `registrySchemas` reject bad props/URLs at
    runtime; `component` stays a plain string on the wire so unknown
    instructions remain representable for 1.4's fallback. Shared via the
    `@registry-spec` alias (tsconfig + vite).

- [x] **Step 1.2 — Render tools + system prompt**
  - Goal: the agent can emit render instructions, and knows when/how.
  - Build: define render tools on the session (e.g. `render_card`,
    `render_list`, `render_table`, `render_links`) whose input schemas match the
    registry spec; in the `canUseTool`/tool-handling path, convert each render
    tool call into a `render` `WireMsg` (these tools have no side effects — they
    just emit UI). Add a system prompt section teaching the vocabulary and when
    to prefer a component over plain text.
  - Files: `server/session.ts`, `server/render-tools.ts`, system prompt.
  - Done when: asking the agent for something list-shaped produces a `render`
    message with `component:"list"` and valid props (verify over the socket).
  - Status: **done, verified live (2026-07-04)** — render tools are an
    in-process SDK MCP server ("ui"); tool input = registry shape + optional
    `id` (update-in-place); `RENDER_GUIDANCE` appended to the claude_code
    preset; `mcp__ui__render_*` allowed in `canUseTool`. MockSession now ends
    every turn with a schema-valid render (all four components covered).
    Live: a list-shaped ask with no mention of UI produced a schema-valid
    `list` render + prose coda, unprompted.

- [x] **Step 1.3 — Front-end registry + components**
  - Goal: render messages become real components in the output zone.
  - Build: `web/src/registry/` with a `registry` map (name → React component)
    and components `Card`, `List`, `Table`, `LinkGroup`. `RenderZone` dispatches
    `render` messages to `registry[component]` with `props`, interleaving them
    with text turns in order.
  - Files: `web/src/registry/*`, `web/src/RenderZone.tsx`.
  - Done when: a single response renders mixed styled text **and** a live
    component (e.g. a table), in the right order.
  - Status: **done, verified mock + live (2026-07-04)** — RenderZone's state
    became a flat entry list (text blocks | render blocks) in wire order; a
    render closes the streaming text block so later deltas open a new one
    after the component; re-seen render ids update props in place. Registry
    map is typed off the shared spec (`ComponentType<ComponentProps<N>>`).
    Headless Chrome: mock turns mount card/table/etc. after their text; live,
    a DB-comparison ask produced a styled 3-row table + prose guidance.

- [x] **Step 1.4 — Validation & graceful fallback**
  - Goal: a malformed instruction never breaks the UI.
  - Build: validate `render` props against the registry schema on the client
    (and/or server). On failure or unknown component, fall back to rendering the
    raw content as styled text and surface a quiet warning. Add an error
    boundary around each rendered component. Note: 1.3 shipped a stub — an
    unknown component currently renders `null` silently; replace that with
    the visible fallback. `registrySchemas` (derived zod objects) already
    exist for exactly this — validate with them on the client.
  - Files: validation util, `RenderZone.tsx`.
  - Done when: an intentionally bad `render` message degrades to styled text
    instead of throwing; a component that throws is caught by its boundary.
  - Status: **done, verified (2026-07-04)** — shared `RenderBlock` (used by
    transcript AND pin dock): unknown component → fallback, schema-invalid
    props → fallback, throwing component → error boundary → fallback; the
    fallback is a quiet warning + raw props as styled code. Verified against
    a hostile-wire harness in headless Chrome (all three paths + a valid
    render + live page afterward); the boundary was proven with a temporary
    throw in Card, removed and confirmed absent from the rebuilt bundle.
    **Phase 1 fully complete.**

- [x] **Step 1.5 — Richer component + polish** *(pulled forward after live
  use showed the agent improvising raw SVG-as-text for graph requests)*
  - Goal: prove the registry scales to a non-trivial component.
  - Build: add a `Chart` (or similarly richer) component + its schema + render
    tool; polish spacing/animation as components mount into the output zone.
  - Files: `registry/Chart`, spec, render tool.
  - Done when: the agent can render a chart from data it produced.
  - Status: **done, verified live (2026-07-04)** — `chart` schema (line|bar,
    x labels, 1–6 series, optional yLabel) + `render_chart` tool; hand-rolled
    SVG component (no chart lib): categorical palette validated against the
    dark surface, 2px lines, rounded-data-end bars, recessive grid, legend
    for ≥2 series, direct end labels, hover crosshair + tooltip.
    `RENDER_GUIDANCE` now also teaches that raw HTML/SVG renders as literal
    code (never improvise markup) — truly arbitrary visuals remain Phase 3's
    sandboxed artifacts. Live: a "show me a line graph of this data" ask
    produced a two-series chart with working tooltip and zero raw SVG text.

- [x] **Step 1.6 — Pin dock (emergent side panel)** *(built ahead of 1.4/1.5
  per the M1 priority order)*
  - Goal: keep chosen outputs visible while the transcript scrolls forever.
    The primitive is **pinning, not a panel** — the dock only exists while
    something is pinned, so users who never pin never see it.
  - Build: a pin affordance drawn by the **shell** around each rendered block
    (hover; shell-owned, never agent-rendered — the agent can't fake or grab
    it). Pinning promotes the block into a right-side dock; unpinning returns
    it to its place in history. Dock collapses to a thin edge tab; dissolves
    entirely when the last pin is removed. Pure client-side output-zone state —
    no wire change. Pinned `render` components stay **live** via
    re-render-by-id, which the 1.3 interpreter already implements (a re-seen
    render id updates that entry's props in place) — this step is pure UI
    work on top of a shipped mechanism. Later (Phase 2): a `{kind:"state"}`
    action may let the agent itself pin/unpin.
  - Files: `web/src/PinDock.tsx`, `RenderZone.tsx`, `Shell.tsx`, styles.
  - Done when: pin a rendered chart, keep prompting — the chart stays visible
    and updates when the agent re-renders its id; unpinning the last item
    dissolves the dock. **Phase 1 complete — the output zone changes shape on
    demand, and can hold its shape when you ask it to.**
  - Status: **done, verified mock + live (2026-07-04)** — pin state is
    output-zone-only (`pinned: renderId[]`); the dock renders the same entry
    objects the transcript holds, so update-in-place keeps pins live for
    free. Mock: pin → dock + history stub, survives new turns, collapse ⇄
    edge tab, last unpin dissolves + block returns. Live: pinned "Build
    status" card updated `queued → deploying now` by the agent (same id) in
    a follow-up turn, zero duplicates. Phase 1 remaining: 1.4 (before
    anything public), 1.5 (optional pre-GIF).

---

## Phase 2 — Action bridge

Goal of the phase: components become interactive. Every action is typed and
mediated by the server; the client never makes arbitrary external calls.

- [x] **Step 2.1 — Action protocol**
  - Goal: a typed vocabulary for what a component interaction can do.
  - Build: define an `Action` union: `{kind:"prompt", text}` (send a follow-up
    into the warm session), `{kind:"tool", name, args}` (invoke a server-side
    whitelisted tool), `{kind:"state", ...}` (update output-zone state only).
    Add `{ type:"action"; action: Action; sourceId: string }` to `ClientMsg`.
  - Files: `server/protocol.ts`.
  - Done when: types compile; render props can carry action descriptors.
  - Status: **done (2026-07-05)** — `Action` union in the protocol
    (state = pin/unpin, client-local, never sent); `actionSpec` zod in the
    registry spec (agent-facing subset = prompt|tool) and `card.actions`
    (≤3 `{label, action}` buttons). Types compile on both sides.

- [x] **Step 2.2 — Interactive components**
  - Goal: buttons/selects in components emit actions through the shell.
  - Build: extend components to accept action props and emit `action` messages
    via the shell's socket (the shell owns the socket — components ask the shell
    to send). Wire `prompt` actions to `pushPrompt`, `state` actions to local
    render-zone state.
  - Files: `registry/*`, `Shell.tsx`, `ws.ts`.
  - Done when: clicking a button in a rendered component sends a follow-up
    prompt that the agent answers in the same warm session.
  - Status: **done, verified mock + live (2026-07-05)** — `ActionContext`
    provided per block by RenderBlock (sourceId = render id; transcript AND
    dock); `ActionRow` buttons in Card; RenderZone resolves state actions
    (pin/unpin) locally and hands prompt/tool to the shell's sender.
    RENDER_GUIDANCE teaches `actions`. Live: the agent authored a "Tell me
    more" button unprompted-in-form; clicking it became a visible user turn
    answered in-session (post-click recall of a turn-1 fact proved warmth).
    Note on `settingSources`: an interim build set it to `[]` to "isolate"
    the daemon from the host's Claude Code config. **Reversed 2026-07-05** —
    genui-shell is a different *view* of the terminal, so it must inherit the
    user's own config (settings.json allowlists/deny rules, CLAUDE.md, memory)
    exactly as the terminal does; switching to it has to be seamless. It is now
    left unset (matches the CLI default: user+project+local). Honoring host
    allowlists and letting "remember X" write to real memory are terminal-native
    behaviors, not leaks. `canUseTool` still runs for anything the user's own
    rules don't decide. (See the terminal-parity principle: deviation from
    terminal behavior is what needs justifying, never parity.)

- [x] **Step 2.3 — Server-side action mediation**
  - Goal: `tool` actions are safe and auditable.
  - Build: a server-side allowlist of callable tools with arg validation;
    reject anything not on it; log every action. No direct client→external
    network calls — everything routes through the server.
  - Files: `server/actions.ts`, `server/index.ts`.
  - Done when: an allowlisted `tool` action runs server-side and returns a
    result into the conversation; a non-allowlisted one is rejected and logged.
    **Phase 2 complete — components can act, safely.**
  - Status: **done, verified (2026-07-05)** — `server/actions.ts` allowlist
    (`workspace_ls`, zod-validated args, path-escape guard, every attempt
    logged); results broadcast as tool_use/tool_result records so the
    action's effect is in every viewport's transcript. Verified in the
    browser (button → tool block with real output) and over a raw
    WebSocket: off-allowlist name and `../..` both rejected with errors on
    the wire and REJECTED/failed lines in the server log. Mock 8/8.
    **Phase 2 complete.**

---

## Phase 3 — Sandboxed artifacts (Level 3)

Goal of the phase: when no registry component fits, the agent emits
self-contained UI rendered in a locked-down iframe. The "build anything on the
fly" capability, gated behind the security model.

- [x] **Step 3.1 — Sandboxed iframe host**
  - Goal: a safe container for arbitrary agent-authored HTML/JS.
  - Build: `web/src/Artifact.tsx` — renders content into a sandboxed
    `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), strict CSP, no
    access to the shell's scope, network, or storage. Document the threat model
    inline.
  - Files: `web/src/Artifact.tsx`.
  - Done when: a static test artifact renders in the iframe and provably cannot
    read anything from the shell (no cookies, no parent DOM, no socket).
  - Status: **done, verified (2026-07-05)** — `Artifact.tsx`: opaque-origin
    iframe (`allow-scripts` only) + injected `default-src 'none'` CSP (meta
    policies intersect, so content can't loosen it); threat model inline,
    incl. the accepted self-navigation residual and the `window.parent`
    postMessage seam 3.3 will use. Chrome bar (title + "sandboxed" badge) is
    shell-drawn outside the iframe. Verified in headless Chrome with a
    hostile artifact mounted in the real render zone: 11/11 escape probes
    blocked (cookie/local/session storage, indexedDB, parent & top DOM,
    fetch to both origins, new WebSocket, external script/img) with shell
    secrets planted first; parent-side `contentDocument === null`.

- [x] **Step 3.2 — Artifact wire message + agent capability**
  - Goal: the agent can emit an artifact.
  - Build: add `{ type:"artifact"; html: string; id: string }` to `WireMsg`;
    add an `emit_artifact` tool + system-prompt guidance (use only when no
    registry component fits). `RenderZone` routes artifacts to `Artifact.tsx`.
  - Files: `protocol.ts`, `server/render-tools.ts`, `RenderZone.tsx`.
  - Done when: the agent generates a small interactive artifact and it renders
    in the sandbox.
  - Status: **done, verified (2026-07-05)** — `artifact` WireMsg (+ optional
    `title`; update-in-place by id, same rule as `render`); `emit_artifact`
    on the ui MCP server with last-resort guidance; RenderZone artifact
    entries route to `Artifact.tsx`; MockSession "artifact" keyword hook for
    API-free testing. `mcp__ui__*` now auto-allowed in permissions (UI
    emission is side-effect-free; the sandbox is the containment — the first
    live run surfaced the prompt friction). Verified mock-first in headless
    Chrome (typed prompt → iframe mounts, 3 clicks inside the sandbox count
    correctly), then live twice: the real agent chose emit_artifact
    unprompted and its click-counter worked in the sandbox ("clicks: 2"
    after 2 driven clicks, screenshot).

- [x] **Step 3.3 — postMessage bridge → action mediation**
  - Goal: artifacts can act, only through the Phase 2 mediated path.
  - Build: a `postMessage` protocol between the iframe and the shell; the shell
    validates and forwards artifact-originated actions through the **same**
    server-side mediation/allowlist from Step 2.3. Nothing else gets out.
  - Files: `Artifact.tsx`, `Shell.tsx`, `server/actions.ts`.
  - Done when: a button inside an artifact triggers an allowlisted action via
    the bridge; an attempt to call anything off-allowlist is blocked.
  - Status: **done, verified (2026-07-05)** — `genui.prompt()/genui.tool()`
    helper injected into the sandbox; parent-side listener accepts messages
    only from that iframe's contentWindow AND opaque origin (bridge dies if
    the artifact self-navigates), strict-parses prompt/tool shapes (state ops
    dropped), rate-limits (400ms), then rides the existing handleAction →
    sendAction → server 2.3 mediation path. No server changes needed. Files
    actually touched: `Artifact.tsx`, `RenderZone.tsx`, `render-tools.ts`
    (bridge docs in emit_artifact), `session.ts` (mock bridge-demo buttons) —
    Shell.tsx/actions.ts needed nothing. Verified mock-first in headless
    Chrome: allowlisted click → real workspace_ls output; off-allowlist
    (raw postMessage) → "not allowlisted" rejection record; prompt click →
    user turn; forged same-shape message from the parent page → dropped.
    Then live: the agent authored a "Workspace Browser" artifact unprompted
    from the tool docs; its List Files button produced a mediated
    workspace_ls record showing the hello.txt it had written.

- [x] **Step 3.4 — Artifact error boundaries & fallback**
  - Goal: broken artifacts never take down the page.
  - Build: load/runtime error handling around the iframe; on failure, fall back
    to showing the artifact source as styled code with a note.
  - Files: `Artifact.tsx`.
  - Done when: a deliberately broken artifact fails gracefully.
    **Phase 3 complete — arbitrary UI on the fly, sandboxed.**
  - Status: **done, verified (2026-07-05)** — boot script (per-mount nonce)
    reports uncaught errors/rejections; early crash (<2.5s) swaps the frame
    for source-as-code + note, late errors only flag the chrome (working UI
    isn't torn down). Self-navigation detected by LIVENESS, not
    load-counting: every wrapped doc announces nonce-stamped artifactReady
    on load; a load event with no announce within 400ms → frame unmounted,
    "navigation blocked" fallback. (Load-counting alone missed immediate
    navigation — it aborts the srcdoc doc before its load fires. Also
    corrected a 3.3 threat-model claim: a navigated doc KEEPS the opaque
    origin, so the origin check never killed the bridge — the nonce, which
    a successor document cannot know, is what does; raw un-nonced
    postMessage is now dropped entirely.) Verified in headless Chrome,
    6/6: crash fallback with source; real navigation to example.com
    blanked; healthy artifact + nonce-stamped bridge still work after both
    failures; un-nonced message from inside the sandbox dropped; zero shell
    page errors. Live run not needed: the failure path is entirely
    client-side and agent-independent — deliberate breakage is exactly what
    the mock is for.

---

## Phase T2 — Full-stream parity (the visibility superset)

Added 2026-07-05, when user testing surfaced the gap: Phase T closed the
*capability* half of terminal parity (tool records, interrupt, permission
prompts) but consciously cut visibility corners — one salient arg per tool
call, 8KB output cap, thinking reduced to a status line, subagent traffic
filtered entirely. Those cuts were right for demo-first sequencing and
wrong as an endpoint: the locked vision (see Design identity) is that this
skin never shows less than the terminal. Every step here is additive on the
wire (new types or optional fields), independent of the others, and honors
the transcript identity — dim, monospace, collapsed by default, but *there*.

Ordering within the phase = trust value: thinking and diffs are where the
terminal currently out-informs us most.

- [x] **Step T2.1 — Thinking text in the transcript**
  - Goal: see the agent reason, not just `✳ thinking…`.
  - Build: add `{ type: "thinking_delta"; text: string }`; pump forwards
    thinking-block deltas (subagent traffic still excluded). RenderZone
    accumulates them into a dim italic thinking block that auto-collapses to
    one line when the turn's first text/tool arrives (click to expand).
    MockSession streams a short scripted thought.
  - Files: `protocol.ts`, `session.ts`, `RenderZone.tsx`, `styles.css`.
  - Done when: a live turn shows its reasoning streaming, then collapsed in
    place; replay preserves it.
  - Status: **done, verified (2026-07-05)** — thinking streams dim/italic
    with a left rule, folds to a ✳-prefixed one-liner on the turn's first
    real output (text/tool/render/artifact/turn_end), click toggles.
    Multiple thinking blocks per turn each fold independently. Optional
    `MAX_THINKING_TOKENS` env for opt-in extended thinking; "think hard"
    trigger words work without it. Gotcha fixed: the folded row's
    overflow:hidden let the zone's flex column squash it to 0 height —
    flex:none on the block. Mock 5/5 (stream → fold → expand → refold →
    replay-folded); live: "think hard" turn streamed 1.4KB of real
    reasoning, folded on the answer, survived refresh replay.

- [x] **Step T2.2 — Full tool inputs + Edit/Write diffs**
  - Goal: the expanded tool row shows everything the terminal shows.
  - Build: widen `tool_use` with optional `input?: Record<string, unknown>`
    (additive; old clients ignore it). `ToolBlock`'s expanded view renders
    the full input; for Edit/MultiEdit render old→new as a colored diff, for
    Write show the content as styled code. `detail` stays as the collapsed
    row's one-liner.
  - Files: `protocol.ts`, `session.ts`, `ToolBlock.tsx`, `styles.css`.
  - Done when: a live Edit expands to a red/green diff of the actual change.
  - Status: **done, verified (2026-07-05)** — `tool_use.input` carries the
    full args; ToolBlock's expansion renders Edit/MultiEdit as an LCS
    line-diff (red `-` / green `+` / dim context), Write as green-tinted
    new content, everything else as pretty JSON, above the result. Expansion
    now works even while the call is running (input is known immediately;
    only the result waits). Mock gained Edit + Write tools with real
    before/after code. Verified mock (Edit +8/-2 diff, Write content shown)
    and live: agent wrote notes.txt (content shown) then edited banana→
    blueberry, expanding to a true `- banana` / `+ blueberry` diff.

- [x] **Step T2.3 — Honest output depth**
  - Goal: no silent truncation.
  - Build: widen `tool_result` with optional `truncatedBytes?: number`; raise
    the cap (64KB) and render an explicit "… N KB elided" marker in the
    expanded block when it trips.
  - Files: `protocol.ts`, `session.ts`, `ToolBlock.tsx`.
  - Done when: a huge `cat` shows capped output ending in a visible elision
    marker with the true elided size.
  - Status: **done, verified (2026-07-05)** — `tool_result.truncatedBytes`
    (optional); shared `capOutput` (byte-based, replaces the old 8KB
    char-slice that baked a plain-text marker into the output) caps at
    `TOOL_OUTPUT_CAP_BYTES` (default 64KB, env-overridable) and reports the
    elided byte count. ToolBlock renders a dim amber "⋯ N KB/MB elided"
    marker distinct from real output; `formatBytes` scales B/KB/MB. Both the
    real pump and the mock route through the same helper. Note: real tools
    (Claude Code Bash ~30KB) usually self-limit below the cap, so this is a
    backstop for genuinely large results — verified live by setting the cap
    to 800B and running a 60-line echo (real pump emitted "⋯ 2.3 KB
    elided"); mock ("huge log" hook, ~110KB → 50.8 KB elided) confirms the
    default path and that normal outputs carry no marker.

- [x] **Step T2.4 — Subagent visibility**
  - Goal: a Task run is a window, not a black box.
  - Build: instead of dropping `parent_tool_use_id` traffic, forward subagent
    tool calls with optional `parentId?: string` on `tool_use`/`tool_result`;
    RenderZone nests them indented under the owning Task row, collapsed as a
    group ("⚙ subagent · N calls"). Subagent *text* stays filtered — its
    prose is working monologue, not answer.
  - Files: `protocol.ts`, `session.ts`, `RenderZone.tsx`, `ToolBlock.tsx`.
  - Done when: a live Task shows its subagent's tool calls nested under it,
    and the main transcript prose contains none of the subagent's text.
  - Status: **done, verified (2026-07-05)** — pump now forwards subagent
    `tool_use`/`tool_result` tagged with `parentId` (the Task's id); subagent
    text/thinking stay dropped (they ride stream_event, still filtered).
    `SubagentGroup` nests children indented under their parent row, collapsed
    by default ("⚙ subagent · N calls"), keyed by parentId so it's
    tool-name-agnostic. Mock "delegate" hook. Verified mock 6/6 (nested,
    collapsed-by-default, Task at top level, expands to 3 child rows, prose
    is the summary not the internals) and live: the real **Agent** tool (SDK
    names it Agent, not Task — nesting keyed by id so it doesn't matter)
    delegated a TODO search; its inner Bash grep nested under it and the
    reply carried only the agent's own summary. Note subagent tool calls
    still pass through canUseTool, so an out-of-workspace inner Bash prompts
    like any other.

- [x] **Step T2.5 — Live todo checklist**
  - Goal: the terminal's task list, as a real component.
  - Build: normalize `TodoWrite` calls into `render` messages reusing a fixed
    wire id per turn (update-in-place gives a live checklist for free) with a
    small `todo-list` registry component; suppress the raw tool row.
  - Files: `session.ts`, `registry-spec.ts`, `web/src/registry/`.
  - Done when: a multi-step live turn shows items checking off as it works.
  - Status: **done, verified (2026-07-05)** — `todo-list` registry component
    (server-synthesized, no render tool; validated like any component).
    **Key discovery: this SDK's task list is the `TaskCreate`/`TaskUpdate`
    family, NOT `TodoWrite`** (live pump log proved it — the agent never
    called TodoWrite). So the pump folds the whole Task* family into a
    session-scoped checklist: TaskCreate appends a `pending` item (id mirrors
    the SDK's 1-based sequential ids, so no result-parsing needed),
    TaskUpdate moves it by `taskId` through in_progress/completed/deleted,
    TaskList/TaskGet are swallowed silently; TodoWrite still handled for
    compatibility. One render id per turn → one checklist that updates in
    place. Subagent task calls stay internal. Raw Task* rows + results
    suppressed. Verified mock 6/6 (counter climbs 0→4 in one block, ends
    all-completed, no raw row) and live (real agent created 4 tasks then
    checked them off 1/4→4/4 in a single block; only Write/Bash work rows
    remained visible).

- [x] **Step T2.6 — Status bar (model, session, usage)**
  - Goal: the workbench strip — context and cost at a glance.
  - Build: add `{ type: "usage"; model: string; inputTokens: number;
    outputTokens: number; costUsd?: number }` emitted from SDK `result`
    events; slim shell-owned bar (bottom edge) showing model · session id ·
    cwd · connection state · last-turn/session-cumulative usage. Collapsible,
    per the side-surface rule.
  - Files: `protocol.ts`, `session.ts`, `Shell.tsx`, `styles.css`.
  - Done when: after a live turn the bar shows the model and a nonzero token
    count; disconnecting flips the connection glyph.
    **Phase T2 complete — the browser shows strictly more than the terminal.**
  - Status: **done, verified (2026-07-05)** — `usage` WireMsg emitted per turn
    from the SDK `result`; `StatusBar` (new, shell-owned, bottom edge) shows
    connection dot · model · session · cwd · `turn ↑in ↓out` · session `Σ` ·
    `$cost`, collapsible to just the dot. `ws.ts` gained `onClose`; Shell
    tracks connection via onOpen/onClose. **Load-bearing finding from live
    logs: input tokens are per-turn (~25k each, cache-heavy) but
    `total_cost_usd` is CUMULATIVE** (turn 2 = turn 1 + a cache-read-sized
    step) — so the client sums tokens but *sets* cost to the latest value,
    not adds (the first cut double-counted). Mock emits a matching cumulative
    cost. cwd chip suppressed when it just repeats the session id (default
    workspace/<id>). All state resets on zone_reset so replay re-lands the
    same figures. Verified mock 8/8 (accumulates across 2 turns, collapses to
    a dot, replay-stable) + dot-flip (killed the server → green→amber, since
    setOffline ignores loopback) + live (model claude-sonnet-4-6, Σ 25k→51k
    over two turns, cost 0.035→0.043 — cumulative, not doubled).

---

## Phase P — Faithful browser skins for terminal agents (THE identity; do this BEFORE the rest of Phase 4)

**Goal of the phase: genui-shell faithfully re-skins whichever terminal coding
agent you already drive — Claude Code today, Codex (OpenAI) and Gemini CLI next
— in the browser, with genui-shell's generative UI layered on top.** A Codex
user gets **Codex** in the browser (its tools, its config, its behavior), never
"Claude things"; a Claude Code user gets Claude Code. This is the **product
identity** (see Design identity + Locked decisions + BUSINESS.md §4), the
**next build front** — ahead of Phase 4's remaining polish — and it subsumes
Phase L (local is just an agent pointed at a local endpoint).

Mechanically: `AgentSession` is the seam, and everything valuable downstream —
wire protocol, output zone, trusted-shell security, generative UI — consumes
`WireMsg` and nothing else. So a new agent = one adapter that (a) drives that
agent's **own engine**, (b) normalizes its event stream into `WireMsg`, and
(c) injects genui-shell's generative-UI tools via **MCP** (Claude Code, Codex,
and Gemini CLI all support MCP). We do **not** build a generic agent loop or
our own tools — that would be faithful to no one; each agent brings its own
loop, tools, and behavior, and we stay faithful to it. **No proxy, no
privileged agent.** Feasibility varies per agent (Claude's engine is cleanly
embeddable; Codex/Gemini CLI are open source + MCP but their embeddability must
be checked), so each agent is a feasibility check + adapter, and we prove the
pattern on one before committing to all.

- [x] **Step P.1 — Agent-adapter seam + config**
  - Goal: "which agent" is configuration; nothing hard-assumes Claude Code.
  - Build: generalize the `AgentSession` boundary into an **agent adapter** —
    drive a terminal agent's engine, normalize its events to `WireMsg`, inject
    the generative-UI MCP server. A `Backend` config names the agent
    (`claude-code` | `codex` | `gemini-cli` | …) + its credentials/model/endpoint.
    Replace the `ANTHROPIC_API_KEY`-only live/mock switch (`registry.ts`) with an
    agent-neutral one. Secrets stay server-side. Refactor the existing Claude
    path (`Session`) into the reference adapter behind this interface.
  - Files: `server/adapters/*`, `server/registry.ts`, `server/session.ts`, `.env.example`.
  - Done when: types compile; Claude Code runs through the new adapter seam with
    no behavior change; the agent is chosen from config, not hardcoded.
  - Status: **done, verified live (2026-07-05)** — `server/session.ts` split into
    `server/adapters/`: `types.ts` (the `AgentSession` contract + `AgentName`/
    `Backend` config + agent-neutral helpers `capOutput`/`TodoItem`/
    `PERMISSION_TIMEOUT_MS`), `claude-code.ts` (the former `Session`, renamed
    `ClaudeCodeSession` — the reference adapter, Claude-only fidelity scoped
    here), `mock.ts` (the `MockSession` stand-in), and `index.ts` (the seam:
    `resolveBackend()` reads `GENUI_AGENT` (default `claude-code`) + per-agent
    creds → `Backend{agent,live,model}`; `createSession()` dispatches agent→
    engine, mock when not live). `registry.ts` resolves one `Backend` in its
    ctor and calls `createSession(this.backend,{cwd})` — the old
    `ANTHROPIC_API_KEY`-only switch is gone. `.env.example` documents
    `GENUI_AGENT`. Verified: typecheck clean; config resolution (default→
    claude-code, no-creds→mock, key→live, codex honored, bogus name→claude-code);
    factory (no-creds→`MockSession`); **live e2e over a real WS** — a full Claude
    Code turn (`session_created → user_prompt → text_delta → usage
    claude-sonnet-4-6 26505in/5out $0.039 → turn_end`) ran through the new seam,
    permission gating intact, zero behavior change.

- [x] **Step P.2 — Codex adapter: feasibility spike, then integration**
  - Goal: prove the faithful-skin pattern generalizes beyond Claude, on the
    agent an OpenAI user already uses.
  - Build: investigate how Codex's engine embeds / exposes an event stream
    (SDK / app-server protocol / headless mode); drive it from the daemon,
    normalize its output to `WireMsg`, and inject the render MCP server so the
    generative UI works on top. Spike first (one tool call + one render, end to
    end) to learn the surface before the full adapter.
  - Files: `server/adapters/codex.ts`, spike notes.
  - Done when: a Codex session runs live from an OpenAI key, driven through
    genui-shell into the browser — and it behaves like **Codex**.
  - Status: **spike done (2026-07-05), verdict GREEN — live integration blocked
    on credentials/tooling** (`server/adapters/codex.spike.md`). Codex embeds
    the way the seam wants: official `@openai/codex-sdk` (Node 18+) spawns the
    `codex` CLI and streams JSONL events (`Codex`→`startThread`→`runStreamed`);
    events map cleanly onto existing `WireMsg` (no protocol change); native MCP
    injection via `config.mcp_servers` satisfies the generative-UI requirement;
    Codex's own `requestApproval` maps onto our `permission_request`. **Blocked
    on**: `npm i @openai/codex-sdk`, the `codex` CLI binary, and an OpenAI key /
    ChatGPT login — none present in this env. One P.3 flag: `render-tools.ts` is
    in-process for the Claude SDK; Codex loads MCP servers as stdio subprocesses,
    so the render server needs repackaging as a standalone stdio MCP (mechanical,
    not a redesign). Box stays unchecked until the live run is observed.
  - Status update: **adapter built + verified LIVE (2026-07-05, same day) — box
    still open on the served-browser leg only.** Tooling arrived (`@openai/codex-sdk@0.142.5`
    + `codex` CLI + `~/.codex` ChatGPT login), so live ran at $0. `server/adapters/codex.ts`
    drives a warm Codex `Thread` (one `runStreamed`/prompt via a serial worker,
    AbortController interrupt), normalizes events→`WireMsg` per the spike table
    (no protocol change), and is wired behind the seam
    (`agentHasCredentials("codex")` = OPENAI_API_KEY | `~/.codex/auth.json`).
    Verified live foreground (direct adapter drive): turn 1 `PONG.` +
    `usage model=codex`, turn 2 recalled a turn-1 codename — **warm, behaves like
    Codex**, no permission bar (SDK has no approval callback → optional-feature).
    Fixed a Claude-ism leak: `DEFAULT_MODEL` (a Claude id) was 400ing Codex; model
    is now agent-specific (`modelFor()`), unset → Codex inherits its own config
    (**inherit-don't-invent** — same principle as Claude's `settingSources`).
    Two env constraints, both faithful/expected (not code defects): (1) Codex's
    bwrap sandbox can't build on this Ubuntu 24.04 box (AppArmor
    `apparmor_restrict_unprivileged_userns=1`) — **Kyle's own terminal `codex`
    fails identically**, so the adapter sets no sandbox/approval and inherits his
    config; the command-in-transcript path verifies for free once his terminal
    Codex runs commands. (2) This harness SIGTERMs any socket-binding process that
    runs a Codex turn under it, so the DOM session couldn't be observed here — the
    WS/registry/RenderZone transport is agent-neutral (already verified for
    Claude/Mock) and the Codex backend was confirmed reaching the wire. Close the
    box with a 2-min `GENUI_AGENT=codex yarn dev` in a real terminal. Details in
    `server/adapters/codex.spike.md`.
  - **BROWSER-VERIFIED, box CHECKED (2026-07-05).** Closed the served-browser leg
    live in headless Chrome (playwright-core + system Chrome) against the real
    `index.ts` server (found the trick: launch via the direct `./node_modules/.bin/tsx`
    binary in the harness's background mode — `npx tsx` under a socket-bound server
    got SIGTERM'd). Two-turn run: turn 1 the agent rendered its reply in the
    transcript, turn 2 **recalled a codename planted in turn 1 (warm)**, and the
    shell status bar read **`codex` · <session> · turn ↑25k ↓16 · Σ 37k** — a
    Codex user gets Codex, faithfully, in the browser. Screenshot captured.
    **Load-bearing gotcha:** the served `./dist` bundle was a day stale (2026-07-04,
    pre-T2/pre-4.2) — the old frontend showed the prompt strip but never rendered
    the reply (stuck at `✳ thinking…`); `yarn build` fixed it instantly. Remember
    to rebuild the frontend before any served-mode (non-Vite) verification. Only
    the command-in-transcript path remains unobserved (Codex's bwrap sandbox can't
    build here — faithfully identical to Kyle's terminal `codex`; verifies for free
    once his terminal Codex runs a command).

- [x] **Step P.3 — Codex fidelity + generative-UI superset**
  - Goal: a Codex user gets Codex, faithfully, plus genui-shell's richness — no
    Claude-isms.
  - Build: Codex's own tools/config/behavior surface as-is; genui-shell's
    components, pins, and artifacts layer on top via MCP; verify no Claude
    presets, `settings.json` inheritance, or Claude-specific affordances leak
    into a Codex session.
  - Done when: side by side, a Codex session and a Claude Code session each look
    and behave like their own agent, both carrying the generative-UI layer.
  - Status: **done, verified live (2026-07-06).** The render tools are in-process
    for the Claude SDK but Codex loads MCP servers as stdio subprocesses, so
    `server/render-mcp.ts` is a standalone stdio MCP server (schemas =
    `registryShapes`, one source of truth) exposing the same render_*/emit_artifact
    vocabulary. It's a thin stub — it advertises the tools and returns the
    component id; the Codex adapter injects it via `config.mcp_servers.genui` and
    synthesizes the render/artifact `WireMsg` from Codex's own `mcp_tool_call`
    events (never reaching back into the subprocess), suppressing the raw tool
    rows. **Key discovery:** headless `exec` mode can't prompt for approval, so MCP
    tool calls are auto-cancelled unless the per-server
    `default_tools_approval_mode = "approve"` is set (enum: auto|prompt|approve) —
    scoped to the genui server only, the analog of the Claude adapter auto-allowing
    `mcp__ui__*` (our own side-effect-free UI, not the user's commands). Verified
    live ($0): Codex `render_table` → a real `<table>` registry component mounted
    in the browser (not markdown), interleaved with Codex prose, `codex` status
    bar, zero raw genui rows leaked (screenshot); `emit_artifact` → a valid
    `artifact` WireMsg. Pins are agent-neutral client state on any render block →
    covered by construction. No Claude-isms: server named `genui` (not `ui`), no
    Claude preset/settingSources/model in the Codex path; the status bar reads
    `codex`. **Phase P proven on a second agent — everyone's own tool, in the
    browser, carrying the generative UI.**

- [x] **Step P.4 — Per-agent onboarding (no assumed agent)**
  - Goal: first run is "pick your agent, give it its key/model" — Claude Code or
    Codex or …, none assumed.
  - Build: shell-owned onboarding + per-session agent selection (folds in the old
    4.6 pick-cwd idea). Status bar shows which agent is behind the session. Keys
    stay server-side.
  - Done when: a stranger who only uses Codex reaches a working Codex-in-browser
    session without editing files or seeing anything Claude.
  - Status: **done, verified (2026-07-06).** Agent choice is now per-session, made
    in the browser — nothing assumes an agent. On connect the server sends an
    `agents` WireMsg (each offerable agent + whether it has creds `live`); the
    shell-owned `Onboarding` overlay renders the picker (no agent auto-created —
    `setHello` returns null until the user picks). Picking sends
    `create{agent}`; the registry resolves that agent's backend per session
    (`resolveBackendFor`, secrets stay server-side — the client only names the
    agent), stores it on the entry, and `session_created` carries `agent` so the
    status bar names it. `AgentName` moved onto the wire (protocol.ts, single
    source; adapters re-export). A `/s/<id>` deep-link skips onboarding and
    attaches. Verified in headless Chrome against the real server: fresh load →
    picker with Claude Code + Codex (screenshot); clicking **Codex** → `/s/<id>`,
    overlay gone, status bar reads **`codex`**, and **zero Claude in the session**
    (`anythingClaude:false`) — exactly the Done-when's Codex-only stranger; a
    deep-link to the session attached with no onboarding. Non-live agents render
    "no credentials · demo" (run the mock). cwd-per-session is carried but the UI
    is agent-first; a cwd input can fold in later. **P.4 done — first run is
    'choose your agent', none privileged.**

- [x] **Step P.5 — Third agent + graceful degradation**
  - Goal: prove N agents (add Gemini CLI), and that optional capabilities
    degrade by absence.
  - Build: a Gemini CLI adapter on the same seam; the **optional-feature rule** —
    a capability an agent doesn't expose simply doesn't appear (e.g. the
    reasoning stream renders only when that agent emits `thinking_delta`), no
    special-casing; lean on Step 1.4's render fallback for weaker/local models.
  - Done when: three agents (Claude Code, Codex, Gemini CLI) each run as their
    own faithful skin behind one front end. **Phase P complete — each agent,
    faithfully re-skinned; everyone's own tool in the browser.**
  - Status: **spike done (2026-07-06), verdict GREEN — live blocked on a free
    Google login** (`server/adapters/gemini-cli.spike.md`). `@google/gemini-cli`
    v0.49.0 installed. Gemini embeds like Codex: headless `gemini -p "<prompt>"
    -o stream-json` emits JSONL events (`init`/`message`/`tool_use`/`tool_result`/
    `error`/`result`) that map onto existing `WireMsg` (no protocol change); warm
    multi-turn via `--session-id` + `--resume` (its Thread analog); native MCP
    injection via a per-session `.gemini/settings.json` (adds our `render-mcp.ts`
    without touching the user's global config); scoped tool approval via
    `--allowed-mcp-server-names genui` (the analog of Codex's per-server
    `approve`, since headless can't prompt). The optional-feature rule is the
    degradation proof: no `thinking_delta` from Gemini → the reasoning block just
    never appears, no special-casing. **Blocked on:** a one-time free Google
    OAuth login (`gemini` → Login with Google — personal account, no key, no
    billing). Open questions for the first live window: exact JSONL field names,
    warm-session mechanics, the scoped-MCP-approval knob, and the OAuth creds
    path — one short session answers all; the adapter is then a mechanical write
    off the Codex template. Box stays open until the live 3-agent run is observed.
  - **DONE, verified live (2026-07-06).** Real event shapes captured via probes:
    `init{session_id,model}`, `message{role,content,delta}` (assistant=text_delta,
    user ignored), `tool_use{tool_name:"mcp_<server>_<tool>",tool_id,parameters}`,
    `tool_result{tool_id,status,output:"…(id: <uuid>)"}`, `result{stats:{input_tokens,
    output_tokens,…}}` (+ a non-JSON ripgrep warning line the parser skips).
    `GeminiCliSession` drives `gemini -p … -o stream-json` (one process/turn),
    warm via `--session-id` then `--resume` (its Thread analog); generative UI via
    the SAME `render-mcp.ts` named in a per-session **project `.gemini/settings.json`**
    (merged over the user's global config, not clobbered), auto-trusted with
    `"trust":true` + `--allowed-mcp-server-names genui` (headless can't prompt).
    Auth: **the free Google-login OAuth was deprecated by Google in 2026
    (IneligibleTierError → Antigravity)**, so it's a free AI Studio `GEMINI_API_KEY`,
    forced via `selectedType:"gemini-api-key"` in the project settings (the global
    still pointed at dead oauth-personal); key stays server-side. Wired into the
    seam (agentHasCredentials keys on GEMINI_API_KEY; `ADAPTER_AGENTS` now includes
    gemini-cli so onboarding offers it; createSession case). Verified live ($0
    AI Studio tier): adapter direct — warm ORCA-7 recall + a render_table→`render`
    WireMsg; **browser — the onboarding picker shows all three agents, picking
    Gemini rendered a real `<table>` component (not markdown), status bar
    `gemini-cli · gemini-2.5-flash`, screenshot**. Optional-feature/degradation
    proof: Gemini emits no reasoning stream, so `thinking_delta` never fires and
    the thinking block simply doesn't appear — by absence, no special-casing.
    **Phase P COMPLETE — three terminal agents (Claude Code, Codex, Gemini CLI),
    each faithfully re-skinned behind one front end, all carrying the generative
    UI, none privileged.**

---

## Phase 4 — Product hardening (completed steps; moved 2026-07-08)

Phase 4's completed steps, moved out of PLAN.md (its header, intro, and the
4.7 → Phase R pointer stay there — Phase R is the live front). Preserved
verbatim, full dated status notes included.

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

- [x] **Step 4.4 — Robust reconnect / session resume**
  - Build: replace the Phase 0 reconnect stub with real resume — re-attach to
    the live warm session (or rehydrate from persistence) without losing
    in-flight state.
  - Done when: a network blip mid-turn recovers cleanly.
  - Status: **done, verified against a real severed connection (2026-07-06)**
    — reconnects now RESUME instead of repainting: the registry stamps a
    session-scoped `seq` on every broadcast message; the hello carries
    `attach.afterSeq` (last seen cursor) and, when the tail is still in the
    ring buffer, the server replays only the unseen messages under
    `session_created{resumed:true}` — the client skips zone_reset, so
    mid-turn streaming continues into the same DOM block and pins/scroll/
    usage state survive. Cursor off the ring / fresh page → full replay as
    before. Client hardening: app-level ping→pong heartbeat (25s interval,
    8s deadline) closes half-open sockets into the reconnect path; backoff
    500ms→5s cap, short-circuited by `online`/tab-visible. Verified 9/9 in
    headless Chrome against a TCP proxy severed mid-turn (drop detected,
    resumed, turn completed; pre-blip DOM node still connected — proof of
    no repaint; no duplicated strips; idle blip + reload paths clean) plus
    raw-socket ping→pong; server log shows `resumed @seq`. NOT in scope
    (deliberate): durability across daemon restarts — the 4.1 note folds it
    here, but real rehydration needs per-engine session resume (claude
    --resume / codex thread ids) + a disk ring; that's its own step if
    wanted (a dead daemon currently falls back to a fresh session cleanly).

- [x] **Step 4.5 — Socket auth token (security slice of the multi-user seam)**
  - Build: per-user auth + session ownership at the shell boundary; the rest of
    the stack is unchanged because the seam was kept clean from Phase 0.
  - Done when: two users have isolated sessions and credentials.
  - Status: **auth slice done + verified (2026-07-06)**, from the pre-launch
    security audit (see [[security-audit-2026-07-06]] memory). The launch-gating
    risk was cross-user RCE: loopback lets any *other account on a shared
    machine* reach the socket and `bang`-exec a shell as the daemon user. Closed
    with a per-launch token (`AUTH_TOKEN = GENUI_TOKEN ?? randomUUID()`) gating
    BOTH the HTTP app and the WebSocket: valid `?token=` mints an
    `HttpOnly; SameSite=Strict` `genui_token` cookie + 302 to the clean path,
    else 403; `verifyClient` accepts the cookie (browsers) or a `?token=` query
    (non-browser), still behind the loopback-origin guard. Launcher opens the
    token URL; `GENUI_TOKEN=""` disables it (single-user, and the Vite dev proxy
    which can't present the cookie — `dev:server` sets it empty). Transport-layer
    only: no `WireMsg` change, key never serialized. Also folded in from the same
    audit: `.env` secret-path guard widened to Grep/Glob + WebFetch/WebSearch
    de-auto-allowed (kills the promptless read→exfil chain), `workspace_ls`
    symlink-escape closed (`realpathSync`), WS frame cap (`MAX_WS_PAYLOAD`) +
    session cap (`MAX_SESSIONS`), and defense-in-depth shell headers (CSP/nosniff/
    X-Frame-Options). Verified: function-level (13/13 permissions+actions), wire
    (auth accept/reject, DoS caps fire), headless Chrome (token→cookie→app+WS,
    component + sandboxed artifact render under the CSP with zero violations).
  - Deferred (the rest of the original seam): true multi-user *isolation* — one
    daemon still holds one credential set and any authed viewport sees every
    session. Per-user identity + session ownership belongs with the 4.7 relay
    (when viewports actually become remote/other-user); revisit there.

- [x] **Step 4.6 — Mission control (fleet view)**
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
  - Status: **done, verified mock 13/13 (2026-07-06)** — `/` is now
    mission control (`FleetView.tsx`; routing in main.tsx: `/s/<id>` →
    Shell, else fleet). New wire plumbing (additive, per-viewport, never
    buffered): `watch_sessions` subscribes a connection as a fleet watcher;
    `sessions` snapshots (id, name, cwd, agent, status, lastActivity,
    viewport count) are pushed on change, 100ms-coalesced. Status is derived
    in registry.broadcast from the stream itself — turn_end/error/bang_end →
    idle, permission_request → permission (sticky until the turn moves),
    else working — no adapter cooperation needed. Rows: pulsing status dot,
    rename-in-place (`rename` ClientMsg — the 4.2 deferred item, landed),
    ~-cwd, agent chip, relative last-activity, open-tab count; click = drop
    into /s/<id>; ⌂ in the session status bar returns. New-session reuses
    the onboarding card (create → navigate); an empty fleet auto-opens it,
    so first-run still lands in "choose your agent". Verified: 3 sessions
    across 2 cwds listed live; working/permission/idle transitions observed
    on the fleet while a session ran; rename live + persisted to a fresh
    watcher; click-through + ⌂ round-trip; both themes screenshot-checked.
    Deferred: pinned-widget preview on rows (needs pin state on the wire —
    see 4.1's note; revisit if supervision wants richer rows).


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

## Phase G — Collapse the relay duplication (do before Phase H)

Origin: same 2026-07-14 review. The relay's shared source is vendored
byte-identically in TWO places — `mirafold/relay-service/` and
`mirafold-relay/src/` — held in lockstep by a sync script; Kyle called the
"keep two copies consistent" arrangement a maintainability wart. It was always
explicitly temporary: `relay-service/` was the dev source of truth *only until
the relay's first deploy* (the umbrella `genui/CLAUDE.md` + DEPLOY.md §5),
after which `genui-relay` becomes canonical and `relay-service/` "retires to a
pointer." The relay is now deployed and live (`relay.mirafold.sh`), so that
condition is met and this cleanup is simply due.

**Why it is its own phase, sequenced strictly before Phase H:** it is NOT a
behavior-preserving move like Phase H's steps — it flips the cross-repo source
of truth, rewires a Tier-2 test, and retires the sync mechanism, with
verification owed in BOTH repos. Keeping it out of Phase H protects that
phase's clean "behavior-preserving, exact-count" invariant. And doing it first
means Phase H reorganizes the settled, smaller relay surface once, instead of
carefully preserving (via `sync:check`) a duplication it would then dismantle.

**Scope decision (2026-07-14):** do the license-independent core now. Kyle is
leaning heavily toward making everything open (MIT) and has explicitly set the
git-history question aside — so there is NO history scrub in this phase and no
gating on the MIT-vs-private call. The one thing deferred is the eventual
public-clone story (a bare public `genui-shell` clone won't have the sibling
`genui-relay`, so the real-daemon relay itest becomes sibling-dependent) —
which the leaning-open direction makes largely moot and which is a launch-time
detail, not this phase's concern.

- [x] **Step G.1 — Retire the vendored `relay-service/` copy; `genui-relay`
  becomes the single source of truth**
  - Goal: one home for the relay service. No more byte-identical second copy
    kept in lockstep; the maintainability burden is gone.
  - Build: make `mirafold-relay/src/` the canonical source. In `genui-shell`,
    reduce the top-level `relay-service/` from a full vendored copy to a thin
    pointer (a short README stating the relay now lives in the `genui-relay`
    repo and how the local itest sources it) — keeping NO duplicated `src/`,
    `Dockerfile`, or `fly.toml` in `genui-shell`. Rewire the real-daemon relay
    test `server/relay-service.itest.ts` to obtain the relay under test from
    the canonical sibling `genui-relay` (the sibling-directory relationship the
    umbrella already relies on) instead of the vendored copy. Retire the now-
    unnecessary sync machinery: `mirafold-relay/scripts/sync-from-genui-shell.sh`
    and the `sync` / `sync:check` npm scripts (nothing to keep in sync once
    there is a single copy). Update every doc that describes the sync
    arrangement (this repo's README + DEPLOY.md §5, `genui-relay`'s README +
    ARCHITECTURE.md, and the umbrella `genui/CLAUDE.md` sync section).
  - Cross-repo — verify in BOTH: with `genui-relay` as the source of truth, its
    standalone suite is green (`npm test`, `npm run typecheck`); and from
    `genui-shell`, `yarn test:server` is green — specifically
    `relay-service.itest.ts` still verifies the relay against a REAL daemon, now
    sourced from the sibling. `npm run smoke` (against the deployed relay) still
    passes.
  - Files: `mirafold/relay-service/` (collapsed to a pointer),
    `server/relay-service.itest.ts` (rewired), `README.md`, `DEPLOY.md`;
    `mirafold-relay/scripts/`, its `package.json`, README + ARCHITECTURE.md; the
    umbrella `genui/CLAUDE.md`.
  - Done when: no byte-identical relay duplication remains (a diff confirms
    `genui-shell` holds no second copy of the relay `src/`), `genui-relay` is
    the sole source, the real-daemon relay itest passes in `genui-shell`
    sourcing from the sibling, and the sync scripts are gone with no doc still
    telling a reader to run them.
  - Status: **DONE 2026-07-15.** The pre-retirement diff confirmed the two
    `src/` trees byte-identical, then `relay-service/` was collapsed to a
    pointer README (src/, Dockerfile, fly.toml, package/tsconfig all removed);
    `relay-service.itest.ts` now imports `startRelay` + the contract from the
    sibling `../../mirafold-relay/src/`, and the sync script + `sync`/`sync:check`
    npm scripts are deleted. Docs updated in the same pass: this repo's README
    (§tree + §8), `genui-relay`'s README/ARCHITECTURE §6/DEPLOY §5, and the
    umbrella CLAUDE.md (sync section → sibling-itest section). Verified both
    repos: genui-shell typecheck + 159/159 unit + 74/74 itest (the 9 relay
    itests against the REAL daemon, sourced from the sibling); genui-relay
    typecheck + 20/20 standalone. One find along the way: `npm run smoke`
    could no longer pass against the deployed relay — the live
    `RELAY_ALLOWED_ORIGINS` gate (on since the 07-13 static-origin work)
    refuses its origin-less viewports (4006). The smoke script now takes the
    allowed origin as a second argument, presents it on every viewport, and
    asserts the gate refuses an origin-less viewport; `npm run smoke --
    wss://relay.mirafold.sh https://app.mirafold.com` PASSes all six checks.

---

## Phase H — Human legibility (opened 2026-07-14; the immediate next work)

Origin: Kyle read the codebase cold (2026-07-14) and found it hard to enter —
a flat 47-file `server/`, no obvious way in, `Shell.tsx` dense to the point of
illegibility, plan-step shorthand in comments that assumes this document, and
a stale legacy `workspace/` directory. The requirement, in his words: **the
repo must be maintainable by a human with no assistant** — if all LLMs stop
working tomorrow, work continues. Structure should carry "what lives where,"
names should carry "what each thing is for," and the README shrinks toward
the things structure *cannot* express (the contracts, the security model,
the why).

**Sequencing:** this phase executes before any further Phase R build step.
R.4l's *intake* (writing findings down) continues in parallel — it changes
docs, not code — but no other build work starts until H.13 closes.

**Hard rules for every step in this phase:**

- **Behavior-preserving only.** No logic changes, no renames of files or
  exported symbols (folder context does the disambiguating — e.g.
  `sessions/registry.ts` no longer collides mentally with `registry-spec.ts`),
  no protocol changes, no dependency changes. The one exception is H.9/H.10,
  which restructure `Shell.tsx` internals without changing what it does.
- **Smaller over larger.** If a step turns out to hide two ideas, split it and
  add the letter (H.4b style) rather than pushing through.
- **Moves use `git mv`** so history and blame survive.
- **The H verification ritual** (referenced by every step as "the ritual"):
  1. Record the test counts each tier prints *before* starting the step.
  2. After the step: `yarn typecheck && yarn test` — counts must match the
     recorded ones EXACTLY (a dropped file passes silently otherwise; the
     recursive `server/**` globs should make moves invisible, and count
     parity is the proof).
  3. Steps that touch server runtime files or `Shell.tsx` (H.2–H.10) also run
     `yarn test:server && yarn test:e2e` (e2e rebuilds `dist`, so it also
     proves the build).
  4. Phase G already retired the `relay-service/` sync, so there is no
     `sync:check` to run here; the relay-adjacent steps (H.2, H.3) instead
     confirm the real-daemon relay itest (part of `yarn test:server`) stays
     green.
  5. A repo-wide grep for each old path finds only PLAN-ARCHIVE.md and git
     history — README/docs mentions of a moved file are updated **in the same
     step**, so the repo is fully consistent at every step boundary.

**Known landmines (verified 2026-07-14 — each is pinned to a step):**

1. **Entry points stay at the server root, permanently.** `bin/mirafold.js`
   hardcodes `dist-server/index.js`, and `server/adapters/render-mcp-cmd.ts`
   resolves the MCP subprocess by *runtime* relative path (`../render-mcp.ts`
   in dev; `render-mcp.js` beside the bundle when packaged). The esbuild
   `build:server` output layout follows its entry paths. Moving `index.ts` or
   `render-mcp.ts` breaks installed daemons — so they don't move, ever, and
   the target tree below documents root = entry points + shared contracts.
2. **The `@relay-crypto` alias is declared in BOTH `tsconfig.json` and
   `vite.config.ts`** and must change in both in the same commit (H.3).
   `@protocol` and `@registry-spec` point at files that do not move.
3. **`relay-service/` (top-level) was collapsed to a pointer by Phase G** —
   `genui-relay` is now the sole source of the relay, with no byte-identical
   copy or `sync:check` left to guard. Phase H does not touch the pointer; the
   real-daemon relay itest (`relay-service.itest.ts`, now sourcing from the
   sibling `genui-relay`) staying green is the proof.
4. **`server/provider-policy.ts` is cited by that literal path** in both
   CLAUDE.md files, BUSINESS.md, README, and the umbrella docs — it stays at
   the root so no citation goes stale.
5. **Open PLAN steps name file paths** (e.g. Q.1's `server/app.e2e.ts`) —
   H.13 sweeps this document's open steps for moved paths.

**Target tree (the deliverable, drawn in full so every step knows its end
state — annotations become the README tree in H.13):**

```
server/
  index.ts              entry point: the daemon (HTTP + WS)   [root: landmine 1]
  render-mcp.ts         entry point: the stdio render-MCP subprocess [root: landmine 1]
  render-tools.ts       the render_* tool definitions that subprocess serves
  protocol.ts (+test)   THE WIRE CONTRACT (@protocol)         [root: contract]
  registry-spec.ts (+test)  generative-UI component schemas (@registry-spec) [root: contract]
  provider-policy.ts (+test) the dated credential-policy matrix [root: landmine 4]
  version.ts (+test)    build-time version resolution
  adapters/             (unchanged) one engine adapter per agent + the mock
  relay/                the remote-viewport path: relay-client, relay-crypto
                        (@relay-crypto), relay-protocol, relay-stub,
                        relay-test-client + relay/relay-service itests, relay e2e
  sessions/             the registry + viewport machinery: registry, connection,
                        actions, ws-liveness + their tests and the session/
                        end-session/hostile-client itests
  security/             auth (token gate) + permissions (canUseTool policy) + tests
  pty/                  the `!` passthrough: pty.ts + bang itest
  testing/              itest-harness + the whole-product e2e suites
                        (app, launcher, phone, resilience) — subsystem-specific
                        tests live beside their subsystem, not here
web/src/
  session-bus.ts        NEW (H.9): the socket + message bus extracted from Shell
  (everything else unchanged in place; registry/ already reads well)
```

**Non-goals, deliberate:** `RenderZone.tsx` stays whole (one cohesive job —
the transcript-entry union and its renderer; splitting it would scatter, not
clarify). No web/src folder reshuffle (one component per file already reads).
`adapters/` and `web/src/registry/` are untouched. No renames anywhere.

- [x] **Step H.1 — Sweep the legacy `workspace/` scratch directory**
  - Goal: the stale pre-4.8 session-scratch dirs stop making the checkout
    look messier than the repo is.
  - Build: verify first — grep proves no code creates or resolves a literal
    `./workspace` path anymore (as of 2026-07-14 only two comments in
    `registry.ts`/`permissions.ts` mention the old behavior; keep those,
    they explain history). Then delete the directory from disk, remove the
    `workspace/` line from `.gitignore`, and update README's tree line that
    documents it ("legacy scratch dirs"). If the grep finds a live writer,
    stop, keep the gitignore line, and record why here instead.
  - Files: `workspace/` (deleted), `.gitignore`, `README.md`.
  - Done when: a fresh clone and the local checkout show no `workspace/`,
    nothing recreates it across a full `yarn test:server && yarn test:e2e`
    run, and the ritual passes.
  - Status: **DONE 2026-07-15.** Contents inspected first (23 files, 184K of
    old agent-session scratch — throwaway confirmed), then deleted; the
    `workspace/` gitignore line and both README mentions (tree line + §8's
    "safe to delete" aside) removed. Ritual green with exact parity: typecheck,
    159/159 unit, 74/74 itest, 20/20 e2e, and no `workspace/` reappeared after
    the full Tier-2 + Tier-3 run. One finding beyond the 07-14 audit's "only
    two comments": the three live adapters' constructors still carry a dormant
    `workspaceDir ?? "workspace"` default (claude-code.ts:103, codex.ts:76,
    gemini-cli.ts:70) that would mkdir `./workspace` if ever constructed bare —
    but no call site omits the option (`createSession` always passes
    `opts.cwd`; every test passes a tmp dir), so it was provably unexercised.
    **Addressed same day (Kyle: no deferrals of known weirdness):**
    `workspaceDir` is now a required constructor option in all three adapters —
    the literal `"workspace"` fallback is gone entirely, typecheck enforces
    every call site, and all three tiers re-ran green with exact parity
    (159/74/20). The two explanatory comments in `registry.ts`/`permissions.ts`
    stay, per the step.

- [x] **Step H.2 — Carve out `server/relay/` (the non-aliased files)**
  - Goal: the eight-file relay family reads as one subsystem.
  - Build: `git mv` into `server/relay/`: `relay-client.ts`,
    `relay-protocol.ts` + its test, `relay-stub.ts`, `relay-test-client.ts`,
    `relay.itest.ts`, `relay-service.itest.ts`, `relay.e2e.ts`. Fix imports
    (typecheck enforces completeness). Update the README/docs mentions of the
    moved paths (README cites `server/relay-protocol.ts`,
    `server/relay-client.ts`, `server/relay-stub.ts`,
    `server/relay-service.itest.ts`). `relay-crypto` waits for H.3 — this
    step deliberately touches no alias.
  - Files: the seven moved files, their importers, `README.md`.
  - Done when: the ritual passes in full (all three tiers with exact count
    parity), and the old-path grep is clean.
  - Status: **DONE 2026-07-15.** Eight files `git mv`'d (the seven listed plus
    `relay-protocol.test.ts`, which the step's count folded into "+ its
    test"). Import fixes: root-relative paths gained a `../` inside the moved
    files, `index.ts`/`phone.e2e.ts` repointed, the sibling `genui-relay`
    import in `relay-service.itest.ts` gained a third `../`, and one dynamic
    `await import("./relay-crypto")` at relay-service.itest.ts:109 was caught
    by typecheck. One non-import landmine found and fixed in the same move:
    `relay-stub.ts` resolves the web `dist/` **relative to its own file**
    (`import.meta.url`), so its `".."` became `"..", ".."` — Tier 3 (which
    serves the bundle through the stub in the phone/relay suites) is the
    proof. Docs swept in the same step: README (tree + §2.2/§5/§8 citations),
    the `relay-service/` pointer README, `genui-relay`'s README +
    ARCHITECTURE, and the umbrella CLAUDE.md. Ritual green with exact parity:
    typecheck, 159/159 unit, 74/74 itest, 20/20 e2e; old-path grep finds only
    PLAN.md's own step text and PLAN-ARCHIVE.md. `relay-crypto.ts` + test
    stay at root for H.3.

- [x] **Step H.3 — Move `relay-crypto` + repoint the `@relay-crypto` alias**
  - Goal: the aliased file joins its family, with the alias change isolated
    so any failure is unambiguous.
  - Build: `git mv` `relay-crypto.ts` + `relay-crypto.test.ts` into
    `server/relay/`; update the `@relay-crypto` path in **both**
    `tsconfig.json` and `vite.config.ts` (landmine 2) in the same commit.
  - Files: the two moved files, `tsconfig.json`, `vite.config.ts`.
  - Done when: the ritual passes in full — `yarn test:e2e`'s rebuild is the
    proof the Vite side of the alias is right, typecheck proves the tsc side.
  - Status: **DONE 2026-07-15.** `relay-crypto.ts` + test `git mv`'d into
    `server/relay/`; the `@relay-crypto` path repointed in `tsconfig.json`
    AND `vite.config.ts` in the same commit (landmine 2); the four in-family
    `../relay-crypto` imports (incl. the dynamic one) became `./relay-crypto`.
    Docs swept: README tree (relay-crypto joins the `relay/` block), the
    `relay-service/` pointer README, and `genui-relay`'s README/ARCHITECTURE
    citations. Ritual green with exact parity: typecheck, 159/159, 74/74,
    20/20 (the e2e rebuild proving the Vite alias); old-path grep finds only
    PLAN-ARCHIVE.md. The relay family is now fully assembled in
    `server/relay/` — ten files, nothing relay-named left at the root.

- [x] **Step H.4 — Carve out `server/sessions/`, part 1: the state core**
  - Goal: the session registry and the viewport/connection machinery read as
    the product's core subsystem.
  - Build: `git mv` into `server/sessions/`: `registry.ts` + its test +
    itest, `connection.ts`, `actions.ts` + test. Fix imports; sweep docs for
    the moved paths.
  - Files: the six moved files, their importers, `README.md`.
  - Done when: the ritual passes in full with exact count parity.
  - Status: **DONE 2026-07-15.** Six files `git mv`'d into `server/sessions/`
    (registry + test + itest, connection, actions + test); the moved files'
    root-relative imports gained a `../` (protocol, adapters, provider-policy,
    pty, version, itest-harness), and the three external importers repointed
    (`index.ts`, `render-tools.ts`, `relay/relay-client.ts`). README updated:
    the tree gains the `sessions/` block and §4's `server/actions.ts` citation
    moved. The old-path grep finds only dated `[x]` status notes in PLAN.md
    (Q.3/Q.4 history) and PLAN-ARCHIVE.md; `registry-spec.ts` stays at root
    (the contract), untouched. Ritual green with exact parity: typecheck,
    159/159, 74/74, 20/20.

- [x] **Step H.5 — Carve out `server/sessions/`, part 2: liveness + the
  session itests**
  - Goal: finish the sessions folder — the cross-cutting session integration
    tests live with the subsystem they exercise.
  - Build: `git mv` into `server/sessions/`: `ws-liveness.ts` + test + itest,
    `session.itest.ts`, `end-session.itest.ts`, `hostile-client.itest.ts`.
    Fix imports (these lean on `itest-harness.ts`, still at root until H.8 —
    relative paths change, typecheck enforces).
  - Files: the seven moved files, their importers.
  - Done when: the ritual passes in full with exact count parity.
  - Status: **DONE 2026-07-15.** Six files `git mv`'d (`ws-liveness.ts` + test
    + itest, `session.itest.ts`, `end-session.itest.ts`,
    `hostile-client.itest.ts` — the step's "seven" counted the harness path
    fix, which turned out to be just the four itests' `../itest-harness`).
    `index.ts` repointed for `sweepLiveness`. No doc cites the moved files
    outside dated `[x]` history. Ritual: typecheck + 159/159 + 20/20 e2e; one
    Tier-2 run flaked 66/74 (parallel real-daemon contention right after a
    full-suite back-to-back — not the move; the failures didn't name the moved
    files' subjects) and three consecutive re-runs are 74/74 clean. (The
    flake recurred during H.7 with roving relay-itest timeouts;
    `test:server` now runs `--test-concurrency=1` like `test:e2e` — see
    H.7's status.)

- [x] **Step H.6 — Carve out `server/security/`**
  - Goal: the two trust gates — who may connect (`auth`) and what a tool may
    do (`permissions`) — are findable as one subsystem.
  - Build: `git mv` into `server/security/`: `auth.ts` + test + itest,
    `permissions.ts` + test. Fix imports; update README's §5 mentions of
    `server/permissions.ts` and `server/auth.ts`.
  - Files: the five moved files, their importers, `README.md`.
  - Done when: the ritual passes in full with exact count parity.
  - Status: **DONE 2026-07-15.** Five files `git mv`'d into `server/security/`
    (auth + test + itest, permissions + test); importers repointed
    (`index.ts` for the auth predicates, `adapters/claude-code.ts` for
    `makeCanUseTool`), `auth.itest.ts`'s harness import gained a `../`.
    README updated: §4/§5 citations now `server/security/…` and the tree
    gains the `security/` block. Old-path grep: only RENAME.md + dated `[x]`
    PLAN history. Ritual green with exact parity: typecheck, 159/159, 74/74,
    20/20.

- [x] **Step H.7 — Carve out `server/pty/`**
  - Goal: the `!` passthrough machinery is one folder.
  - Build: `git mv` into `server/pty/`: `pty.ts` + test, `bang.itest.ts`.
    Fix imports; sweep docs.
  - Files: the three moved files, their importers.
  - Done when: the ritual passes in full with exact count parity.
  - Status: **DONE 2026-07-15.** Three files `git mv`'d into `server/pty/`;
    `sessions/registry.ts` + `sessions/connection.ts` repointed to
    `../pty/pty`, `bang.itest.ts`'s root imports gained a `../`; README tree
    gains the `pty/` block. Ritual green with exact parity: typecheck,
    159/159, 74/74, 20/20. **Plus one ritual-infrastructure fix that this
    step's runs forced:** H.5's Tier-2 flake recurred here (twice in a row,
    roving timeouts across the parallel relay itests — each itest file spawns
    real daemons, and the per-CPU default occasionally starves a handshake
    past its timeout; every failing test passes in isolation, no leaked
    processes involved). `test:server` now runs `--test-concurrency=1`,
    matching the choice `test:e2e` already made for the same reason — the
    ritual's Tier-2 gate must be deterministic for the rest of Phase H to
    lean on it. Cost: ~2-3 min instead of ~40 s. Two consecutive serialized
    runs: 74/74, 74/74.

- [x] **Step H.8 — Carve out `server/testing/`**
  - Goal: cross-cutting test infrastructure stops crowding the root; what
    remains at `server/` root is exactly the spine (entry points + contracts).
  - Build: `git mv` into `server/testing/`: `itest-harness.ts` and the four
    whole-product e2e suites (`app.e2e.ts`, `launcher.e2e.ts`, `phone.e2e.ts`,
    `resilience.e2e.ts`). Fix the harness imports across every itest (all
    folders). Note for H.13: open step Q.1 cites `server/app.e2e.ts`.
  - Files: the five moved files, every itest that imports the harness.
  - Done when: the ritual passes in full with exact count parity, and
    `ls server/*.ts` shows only the documented root spine.
  - Status: **DONE 2026-07-15.** Five files `git mv`'d into `server/testing/`;
    eleven importers across sessions/, relay/, security/, pty/ repointed to
    `../testing/itest-harness`. Two `import.meta.url`-relative ROOT
    computations deepened one level (`itest-harness.ts` — it spawns the
    daemon from ROOT — and `launcher.e2e.ts`); Tier 2 + Tier 3 passing is the
    proof both resolve. `ls server/*.ts` is exactly the root spine: the two
    entry points (`index.ts`, `render-mcp.ts` + its itest beside it,
    `render-tools.ts`) and the contracts (`protocol`, `registry-spec`,
    `provider-policy`, `version`, each with its test). Q.1's
    `server/app.e2e.ts` citation stays for H.13's sweep, per this step's
    note. Ritual green with exact parity: typecheck, 159/159, 74/74, 20/20.

- [x] **Step H.9 — `Shell.tsx`: extract the session bus**
  - Goal: the hand-rolled socket + pub/sub machinery — the single most
    disorienting block in the file — becomes its own named module beside
    `ws.ts`, so `Shell.tsx` stops embedding a messaging system mid-component.
  - Build: lift the `useMemo` bus (SocketClient construction, listener sets,
    hello/attach logic, the `session_created` URL handling, `sendAction`/
    `sendPrompt` senders) into `web/src/session-bus.ts` with an explicit
    interface; `Shell.tsx` consumes it. Pure extraction — identical wire
    behavior, identical reconnect/resume semantics (the 4.4 tail-resume path
    and the R.4c fresh-session notice hook must come through untouched).
  - Files: `web/src/session-bus.ts` (new), `web/src/Shell.tsx`.
  - Done when: the ritual passes in full — Tier 3 is the real gate here
    (attach/resume/replay are all driven in headless Chrome by the existing
    suites), with exact count parity and no test edited to accommodate.
  - Status: **DONE 2026-07-15.** The whole `useMemo` bus body moved verbatim
    (comments included) into `web/src/session-bus.ts` as `createSessionBus()`
    behind an explicit `SessionBus` interface; `Shell.tsx` now holds one line
    (`useMemo(() => createSessionBus(), [])`). `ZoneMsg` lives with the bus
    and is re-exported from `Shell.tsx`, so `RenderZone`'s import site is
    untouched — zero files beyond the two named ones changed, no test edited.
    Shell.tsx: 503 → 406 lines. Ritual green with exact parity: typecheck,
    159/159, 74/74, 20/20 — the Tier-3 suites drive attach/resume/replay and
    the R.4c notice through the extracted bus unchanged.

- [x] **Step H.10 — `Shell.tsx`: group the state**
  - Goal: the wall of ~13 independent `useState` hooks reads as a handful of
    concerns a newcomer can count on one hand.
  - Build: group related state without changing behavior — the natural
    clusters are the dismissable notices (`sessionNotice`, `refusedNotice`,
    `onbError`), the bang pair (`myBang`, `bangTail`), and session/daemon
    metadata; a small reducer or cohesive state objects, whichever reads
    better in place. Each hook's existing constraint comment moves with its
    field. Judgment is allowed on the exact grouping; the test is that the
    declarations read as ~5 ideas, not 13.
  - Files: `web/src/Shell.tsx`.
  - Done when: the ritual passes in full with exact count parity, and the
    file's state section fits on one screen with its comments intact.
  - Status: **DONE 2026-07-15.** Thirteen hooks now read as five banner'd
    ideas: **the turn** (busy + asks, kept as separate hooks — they update
    independently on nearly every wire branch), **the session + daemon**
    (connected, meta, usage, and `daemonInfo` — the old `agents` + `daemon`
    hooks merged into one object, natural because every field arrives on the
    same `agents` hello), **the dismissable notices** (one object:
    session/refused/onboarding, replacing three hooks), **the `!` command**
    (one object: my + tail, replacing two), and **the theme**. Every
    constraint comment moved onto its field. Cohesive objects over a reducer
    — the update sites are one-field spreads and a reducer would add
    indirection without removing any. Ritual green with exact parity:
    typecheck, 159/159, 74/74, 20/20; no test edited.

- [x] **Step H.11 — Comment legibility pass, server side**
  - Goal: every comment stands alone for a reader who has never seen this
    document — the plan-step code becomes a suffix, never the substance.
  - Build: sweep `server/` (adapters and relay included) for comments whose
    meaning depends on a bare step id ("R.4c:", "T2.4:", "4.9:") and reword
    each to state the constraint in full with the id as a trailing
    parenthetical — the existing best examples (e.g. connection.ts's fuller
    notes) are the template. Zero code changes; comment-only diff.
  - Files: `server/**/*.ts` (comments only).
  - Done when: a grep for comment lines *opening* with a bare step id finds
    none under `server/`, and the ritual's typecheck + Tier 1 pass (a
    comment-only diff needs no Tier 2/3).
  - Status: **DONE 2026-07-15.** ~95 comment sites across 31 files: each
    leading id ("R.4c:", "T2.4:", "#11:", "Step 4.9:") demoted to a trailing
    parenthetical at the end of its comment block — the substance was already
    in the text, so rewording was mostly position + capitalization, with a
    handful of true rewrites (protocol.ts's interior "T2.4:" cross-reference,
    the `/** #6 */` JSDoc shape). The whole diff verified comment-only (a
    grep over changed lines finds nothing but comment lines). The Done-when
    grep finds zero comment lines opening with a bare id under `server/`;
    typecheck + 159/159 Tier 1 green.

- [x] **Step H.12 — Comment legibility pass, web side**
  - Goal: same standard as H.11 across the browser code.
  - Build: same sweep over `web/src/` (registry included).
  - Files: `web/src/**/*.ts(x)` (comments only).
  - Done when: same as H.11, for `web/`.
  - Status: **DONE 2026-07-15.** Same transform as H.11 over `web/src/`
    (registry included): ~40 sites across 14 files, ids demoted to trailing
    parentheticals. Diff verified comment-only; the Done-when grep finds zero
    comment lines opening with a bare id under `web/src/`; typecheck +
    159/159 Tier 1 green.

- [x] **Step H.13 — Docs re-synced to the new shape + final full sweep**
  - Goal: the README's map matches reality, a newcomer's first two minutes
    are scripted, and nothing anywhere cites a pre-H path.
  - Build: (a) redraw README's annotated tree to the target tree above,
    folding in each folder's one-line purpose; (b) add a short "start here"
    orientation at the top of the architecture section — the spine in six
    lines: `protocol.ts` is the contract, `index.ts`/`main.tsx` are the entry
    points, `adapters/` normalizes each agent, `Shell` is trusted,
    `RenderZone` paints, `registry/` is the component vocabulary; (c) sweep
    THIS document's open steps for moved paths (Q.1 at minimum); (d) sweep
    CLAUDE.md, docs/, and .github/ for stale paths; (e) run everything one
    last time: `yarn typecheck && yarn test && yarn test:server &&
    yarn test:e2e` (Phase G already retired the cross-repo `sync:check`).
  - Files: `README.md`, `PLAN.md`, `CLAUDE.md`, `docs/*` as found.
  - Done when: every suite is green at recorded-count parity, the old-path
    grep across the whole repo (docs included) is clean, and the phase's
    origin test passes in the only way that matters: the tree alone tells a
    newcomer where each subsystem lives.
  - Status: **DONE 2026-07-15 — PHASE H COMPLETE.** (a) README's tree redrawn
    spine-first: the root reads as entry points (with the never-move note) +
    contracts (`provider-policy.ts` was missing — added), each subsystem
    folder annotated, `ws-liveness.ts` surfaced in `sessions/`, Shell.tsx's
    stale "the message bus" line now says it consumes the session bus.
    (b) The six-line "start here" spine opens §1. (c) Open-step sweep: Q.1's
    `server/app.e2e.ts` → `server/testing/app.e2e.ts` (the only open-step
    citation; everything else is dated history). (d) CLAUDE.md, docs/, and
    .github/ grep clean of every pre-H path. (e) Full suite at recorded
    parity: typecheck, 159/159, 74/74, 20/20. The whole phase ran
    2026-07-15 in one sitting, H.1→H.13, each step its own verified commit.


## Phase H2 — Legibility follow-ups (opened 2026-07-15; the immediate next work)

Origin: a fresh cold read of the post-Phase-H repo (2026-07-15) judged the
structure sound and surfaced two remaining deviations from common practice —
`web/src/` mixes PascalCase components with camelCase modules at one flat
level, and two internal working documents sit at the repo root unannounced.
Kyle scheduled both immediately. Sequencing: H2 executes before any further
Phase R build step; Phase K's paper work continues in parallel (it changes
documents, not code).

**Hard rules, inherited verbatim from Phase H:** behavior-preserving only (no
logic changes, no renames of files or exported symbols — folder context does
the disambiguating), moves use `git mv` so history and blame survive, and
every step runs the H verification ritual: record each tier's test counts
before the step, then after it `yarn typecheck && yarn test` at EXACT count
parity; steps that touch runtime files also run `yarn test:server &&
yarn test:e2e` (e2e rebuilds `dist`, proving the build); a repo-wide grep for
each old path finds only PLAN-ARCHIVE.md, dated history, and the accepted
hits named in the step.

- [x] **Step H2.1 — Group the shell-owned components into `web/src/components/`**
  - Goal: `web/src/` stops mixing component files and plumbing modules at one
    flat level, and the folder split makes the trust boundary visible in the
    tree — shell-owned components in `components/`, the agent-paintable
    vocabulary staying its sibling in `registry/` — the same root-as-spine
    convention `server/` already follows.
  - Build: `git mv` the ten shell-owned components and their tests into
    `web/src/components/`: `Shell.tsx`, `Onboarding.tsx`, `PromptBox.tsx`,
    `RenderZone.tsx`, `ToolBlock.tsx` (+test), `StatusBar.tsx` (+test),
    `PinDock.tsx`, `Artifact.tsx` (+test), `FleetView.tsx`,
    `ConnectDevice.tsx`. Everything else stays at the src root deliberately:
    `main.tsx` (`web/index.html` hardcodes `/src/main.tsx`), `version.ts`
    (imported by `server/version.test.ts` as `../web/src/version`), the
    plumbing modules (`ws.ts` +test, `session-bus.ts`, `agents-meta.ts`
    +test, `tildify.ts` +test), `styles.css`, `vite-env.d.ts`. `registry/`
    does not move and does NOT go under `components/` — keeping it a sibling
    is what makes the trusted/agent-paintable split legible. Fix relative
    imports only (moved components reach root modules and `../registry/` one
    level up; `main.tsx` reaches `./components/`); the aliases don't change
    (`@protocol`/`@registry-spec`/`@relay-crypto` all point at server files).
    Update README §4's tree and §6's walkthrough paths in the same step.
  - Known accepted grep hit: `server/adapters/mock.ts` contains the literal
    string `web/src/RenderZone.tsx` as scripted demo content — it is fake
    output, not a path; leave it (changing it would change mock bytes).
  - Files: `web/src/**` (moves + import lines), `README.md`, docs as found.
  - Done when: the ritual passes at exact count parity across all three
    tiers, and the old-path grep across the whole repo (docs included) finds
    only PLAN-ARCHIVE.md history and the mock's demo string.
  - Status: **DONE 2026-07-15.** Ten components + three tests `git mv`'d
    (all rename-detected); import fixes exactly as drawn (root modules and
    `../registry/` one level up; `main.tsx` → `./components/`); no alias or
    config change needed. README updated in the same step: §1 spine + §3
    Artifact citation + §4 tree redrawn with the nested `components/` block
    and its trusted-vs-registry annotation. Ritual green at exact parity
    159/74/20 (Tier 3 rebuilt dist). Old-path grep across the whole umbrella
    finds exactly the accepted hits: this step's own note, F.2's dated `[x]`
    status history (PLAN.md line ~1288 — history stays verbatim, same
    convention as PLAN-ARCHIVE), and the mock's demo string.

- [x] **Step H2.2 — Root markdown tidy: working docs move under `docs/`**
  - Goal: the repo root shows only load-bearing documents (README, CLAUDE,
    PLAN, PLAN-ARCHIVE, BUSINESS, CONTRIBUTING, SECURITY, LICENSE) — internal
    working notes stop greeting a stranger's first `ls` when the repo goes
    public at R.7.
  - Build: `git mv RENAME.md docs/RENAME.md` and
    `git mv USER-TESTING-FEEDBACK.md docs/USER-TESTING-FEEDBACK.md`. Update
    RENAME.md's one self-reference and README §4's `docs/` annotation to name
    both (RENAME.md still deletes itself when R.2 completes; the feedback log
    remains R.4l/R.5c's intake surface — both keep their roles, only the path
    changes). Reference sweep verified 2026-07-15 across the umbrella, both
    repos, and .github: nothing else cites either path; PLAN-ARCHIVE.md
    mentions are dated history — accepted.
  - Files: `RENAME.md` → `docs/RENAME.md`, `USER-TESTING-FEEDBACK.md` →
    `docs/USER-TESTING-FEEDBACK.md`, `README.md`.
  - Done when: root `ls` shows no working docs, the old-path grep is clean
    (PLAN-ARCHIVE.md excepted), and `yarn typecheck && yarn test` pass (a
    docs-only diff needs no Tier 2/3).
  - Status: **DONE 2026-07-15**, with one discovery the draft missed:
    `USER-TESTING-FEEDBACK.md` was never tracked — it is gitignored on
    purpose (private raw intake; clones never see it), so it moved with a
    plain `mv` and the `.gitignore` line now reads
    `docs/USER-TESTING-FEEDBACK.md`. Consequently README's `docs/`
    annotation names only RENAME.md (README must not list a file absent
    from clones); the feedback log keeps its R.4l/R.5c intake role at the
    new path. RENAME.md moved via `git mv` (rename-detected), its
    self-reference updated. Old-path grep clean (the only hits are the H2
    texts describing the move itself); typecheck + 159/159 Tier 1 green.

- [x] **Step H2.3 — Retire the `relay-service/` pointer directory** *(added
  2026-07-15, after H2.1/H2.2 shipped — Kyle spotted the leftover)*
  - Goal: the Phase G transition aid finishes its job and disappears — the
    repo root stops carrying a directory whose only content is "this moved."
  - Build: `git rm -r relay-service/`. Fold the pointer's operational content
    into README §4's `server/relay/` annotation (where the relay lives, the
    sibling-checkout import, how to run `relay-service.itest.ts`, and that
    the rest of Tier 2 is unaffected without the sibling) and drop the
    `relay-service/` block from the tree. Touch up the docs that described
    the pointer as current state: README §10's R.2 narrative, two stale
    bullets in `docs/RENAME.md` (the dev copy's package name + the retired
    sync scripts), the umbrella `CLAUDE.md` sibling-itest paragraph, and
    `mirafold-relay/DEPLOY.md` §5's dated bullet (amended in its own repo).
    Dated history (PLAN/PLAN-ARCHIVE/ROADMAP records, the relay repo's
    past-tense README/ARCHITECTURE notes) stays verbatim; the itest KEEPS
    its `relay-service.itest.ts` name (it tests the relay service — the
    name describes the subject, not a path).
  - Files: `relay-service/` (deleted), `README.md`, `docs/RENAME.md`,
    `../CLAUDE.md`, `../ROADMAP.md`, `../mirafold-relay/DEPLOY.md`.
  - Done when: the directory is gone, no live doc claims it exists, the
    sibling-itest instructions survive in README §4, and typecheck + Tier 1
    pass (docs + deletion only).
  - Status: **DONE 2026-07-15.** Directory removed; README §4 carries the
    relocated sibling-itest note in the `relay/` annotation; all five live
    references updated (everything else verified to be dated history). The
    real-daemon itest itself was already proven green against the sibling
    earlier the same day. Typecheck + 159/159 Tier 1 green.


## Phase R / F / L — completed steps (moved 2026-07-10 to lean out PLAN.md)

Moved here from PLAN.md 2026-07-10 to reduce context load when the roadmap is
loaded into a session. The roadmap keeps a one-line pointer per step; the full
Goal/Build/Files/Done-when/Status is preserved verbatim below, in original
order. Nothing was dropped — only relocated.

- [x] **Step R.1 — Relay envelope + daemon dial-out, against a local stub**
  - Goal: the daemon can serve its registry through an *outbound* WSS
    connection, so no ports ever open on the user's machine.
  - Build: a tiny relay envelope (pair / attach / frame / ping — `WireMsg`
    and `ClientMsg` ride inside as opaque payloads; the wire protocol itself
    is untouched). `server/relay-client.ts`: dial out with a pairing code,
    multiplex remote viewports into the registry exactly like local sockets
    (4.2 fan-out does the work). A minimal in-repo relay **stub** for dev
    and Tier-2 tests (the real service is R.2).
  - Files: `server/relay-client.ts`, `server/relay-protocol.ts`, stub +
    `.itest.ts` beside them.
  - Done when: a second browser attaches THROUGH the local stub and mirrors
    a live mock session byte-for-byte (replay, streaming, interrupt all
    work); the daemon never listens on a new port.
  - Status: **done, verified across all three tiers (2026-07-07)** —
    `relay-protocol.ts` defines the envelope (relay→daemon `open/frame/
    close/ping`, daemon→relay `frame/close/pong`; payload `p` is an opaque
    string — plain JSON until R.3 makes it ciphertext) and the pairing code
    (128-bit base64url, minted per launch or pinned via `GENUI_RELAY_CODE`;
    `GENUI_RELAY_URL` turns the whole path on). The per-viewport server
    logic moved out of index.ts into `connection.ts` unchanged, so local
    sockets and relay viewports run the *same* code — a remote device is
    literally one more attached viewport, and 4.2 fan-out / replay / 4.4
    resume came free. `relay-client.ts` dials out (the daemon listens on no
    new port), multiplexes viewports by id, reconnects 1s→30s backoff.
    `relay-stub.ts` is the honest dumb forwarder: one daemon per code,
    wrong/short code refused (4003/4002), never parses `p`, never logs frame
    contents, stores nothing; serves ./dist so a browser can load the app
    from the relay origin; standalone-runnable. Web: the shell's WS URL is
    now protocol-aware (wss: on https) and carries `?code=`, kept per-tab in
    sessionStorage so fleet-link navigation doesn't drop the pairing.
    Verified — Tier-2 (6 tests): full mock turn through the stub;
    byte-for-byte mirror (deepEqual of the seq-stamped streams, replay AND
    live, both directions); interrupt through the relay cancels the turn
    (no render/usage); wrong code + duplicate daemon refused; daemon
    re-dials after a stub restart and reattaches the same warm session.
    Tier-3 (3 tests, headless Chrome): a second real browser loads the app
    FROM the stub with `?code=`, clicks through the fleet row (code survives
    the navigation), replays the finished turn, then drives a new turn whose
    transcripts settle character-identical in both browsers. Known and
    accepted until R.3: frames cross the relay as plaintext (including a
    remote `bang_input`), so the local stub is the only sanctioned relay —
    exactly why R.3 is sequenced before any deployed use.

- [x] **Step R.3 — Per-pair E2E encryption**
  - Goal: the relay operator (us, or any self-hoster) *cannot* read frames —
    the precondition BUSINESS.md set for charging money.
  - Build: derive a per-pair key from the pairing secret (never sent to the
    relay); encrypt every frame end-to-end (WebCrypto AES-GCM, replay
    nonces); wrong-key or tampered frames fail closed. Key setup rides the
    pairing handshake; the daemon-printed pairing code/QR is the root of
    trust.
  - Done when: relay logs show ciphertext only; a tampered frame and a
    wrong-code pairing both fail cleanly; the local-tab experience is
    byte-identical through the encrypted path.
  - Status: **done, verified across all three tiers (2026-07-07)** — one
    shared WebCrypto-only module, `server/relay-crypto.ts`, runs verbatim in
    the daemon and the browser (new `@relay-crypto` alias in both configs).
    Scheme v1, documented in the module header: the relay is given only
    `pairId = SHA-256(code)` (the `?pair=` param replaced R.1's `?code=` —
    the code itself now never travels to the relay in any URL or frame);
    per-connection handshake (role-pinned AEAD hellos exchanging 32-byte
    nonces under an HKDF handshake key) derives fresh **directional**
    AES-256-GCM frame keys, so recorded ciphertext can never be replayed
    into a new connection (a replayed prompt/bang would otherwise
    re-execute); frame ivs are strict +1 counters — replay, reorder, drop,
    and tamper all throw, and every failure path drops the viewport (fail
    closed, never open). Browser side: the code arrives as a URL *fragment*
    (`/#code=…`, never sent in HTTP), is stashed per-tab and scrubbed from
    the address bar; ws.ts handshakes before the hello on every (re)connect
    and chains async seal/open to preserve frame order. Daemon side:
    relay-client handshakes each announced viewport (15s timeout) before
    any Connection exists. Verified — Tier-1 (10 crypto tests: tamper/
    replay/reorder/cross-channel/reflection/wrong-key all rejected); Tier-2
    (9 tests incl. a stub tap recording exactly what a relay operator could
    observe: >50 frames, all base64url ciphertext, no code in any URL;
    tampered frame → viewport dropped; right-pairId-wrong-code → handshake
    refused); Tier-3 (headless Chrome through the stub: transcripts
    character-identical AND the tap saw no plaintext; address bar scrubbed).
    Not provided, deliberate (candidate v2): forward secrecy — an ECDH
    handshake would close "code leaks later, recorded traffic opens";
    per-launch codes bound that window today.

- [x] **Step R.4f — `!` must not kill the daemon (from the 2026-07-08
  operability review)** *(pre-launch bug fix, small; found by reading, not
  yet observed on a real Windows box — the code path is unambiguous)*
  - Goal: on Windows, typing any `!` command almost certainly kills the whole
    daemon. `spawnBang` picks `process.env.SHELL || "/bin/bash"`
    (`server/pty.ts`); on Windows `SHELL` is unset and `/bin/bash` doesn't
    exist, so node-pty's `spawn` throws — inside `connection.ts`'s `bang`
    case (no try/catch), inside the ws message handler, in a process with no
    `uncaughtException` handler. One keystroke, every in-memory session gone.
    The tarball ships win32 prebuilds and R.6 plans Windows checks — Windows
    is an intended audience.
  - Build: per-platform shell fallback (win32 → `cmd.exe /c` or
    PowerShell — pick one, terminal-faithful for what a Windows user's own
    terminal would run); wrap the spawn so a throw becomes an `error`
    WireMsg + `bang_end` on that session, never a process death (this also
    hardens the mac/linux path against exotic SHELL values).
  - Files: `server/pty.ts`, the bang case in `server/connection.ts`, tests
    in kind (Tier 2: a bang with a forced-bad shell errors the session and
    the daemon survives; the real Windows keystroke lands in R.6's
    cold-install checks).
  - Done when: a failing shell spawn surfaces as an in-transcript error on
    that session only, proven over a real socket — and the R.6 Windows pass
    runs `!dir` successfully.
  - Status: **done, verified Tier 1 + Tier 2 (2026-07-08); the `!dir`
    keystroke on real Windows stays owed to R.6's cold-install pass.**
    `bangShell()` in `server/pty.ts` picks the shell per platform — win32
    runs `%ComSpec%` (fallback `cmd.exe`) with the verbatim `/d /s /c "…"`
    argv string node's own `shell:true` uses; unix keeps
    `$SHELL || /bin/bash` — and `spawnBang` pre-checks an absolute shell
    path with `existsSync`, throwing a clean `shell not found: <path>`.
    That pre-check matters because the two platforms fail differently
    (probed live 2026-07-08): win32 node-pty throws synchronously, but on
    unix the fork succeeds and `execvp(3) failed.` surfaces only inside the
    child — the check gives every platform one catchable failure mode. The
    `bang` case in `connection.ts` now wraps the spawn: a throw broadcasts
    `error` ("! failed to start: …") + `bang_end` (exitCode null) on that
    session and nothing else. Verified — Tier 1 (4 new tests: per-platform
    shell/argv selection incl. ComSpec, missing-shell throw); Tier 2 (new
    test, own daemon with `SHELL=/nonexistent/…`: `!echo hi` over a real
    socket yields `bang_start` → `error` → `bang_end`, then the SAME daemon
    and session complete a full mock turn — one keystroke no longer costs
    every in-memory session).

- [x] **Step R.4b — First-run honesty (from the 2026-07-07 cold-start
  friction log)** *(independent of R.5/R.2 — buildable now, no external
  accounts; launch-gating in effect: the first five minutes are only good
  today if the user arrives with an env var already set)*
  - Goal: fix what the first hundred real users hit in minute one, all
    observed live in a fresh-clone + clean-prefix-install walk. The likeliest
    launch user — Claude Code on a Pro/Max **subscription**, no API key — is
    shown "Claude Code — no credentials · demo" (observed on this very
    machine, a logged-in daily Claude Code user); a stranger who clicks a
    demo row gets a fabricated research brief with fake tool rows (one
    duplicated) and a fake **$0.018 cost**, whose only fakeness cue is the
    dim `mock-sonnet` label (the flagged "mock is not a user tier" item, now
    concretely observed); a zero-credential machine gets three dead-end
    badges with no guidance anywhere on screen.
  - Build: (1) **Count a Claude Code subscription login as live**:
    `agentHasCredentials("claude-code")` also accepts
    `~/.claude/.credentials.json` (mirror the codex `auth.json` check — the
    SDK runs fine on the login alone, proven live 2026-07-07); document
    `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` (already accepted by the
    code) and the login path in `.env.example`, which today presents the API
    key as Claude's only live path while documenting the login path for
    Codex. (2) **Honest mock presentation in-session**: a shell-drawn demo
    banner (the agent can't fake or clear it — same rule as the permission
    bar), no fabricated dollar cost (drop it or label it simulated), and a
    "connect your agent" pointer naming the concrete fix for the session's
    agent (env var name / `codex login`). Fix the mock's duplicated Bash row
    while in the file. (3) **Onboarding guidance**: a "no credentials" row
    carries the one-line how-to (env var name or login command) instead of a
    bare badge. (4) **Two daemon-message honesty fixes**: the EADDRINUSE
    port walk currently prints "server on :3000" *and then* "server on
    :3001" — the first line is false and, with `--no-open`, gets copied
    (observed: it pointed at a different daemon); print a "busy — walking"
    line instead, so only the bound port says "server on". And the 403 body
    ("genui-shell: missing or invalid token") should state the recovery:
    open the full token URL printed by the terminal that launched
    genui-shell.
  - Files: `server/adapters/index.ts`, `.env.example`,
    `server/adapters/mock.ts`, `web/src/Onboarding.tsx`, `web/src/Shell.tsx`
    (banner), `server/index.ts` (port walk + 403 body), tests in kind
    (Tier 1: the creds check; Tier 3: onboarding guidance text + demo banner).
  - Done when: a machine with only `~/.claude/.credentials.json` (no env
    keys) shows Claude Code **ready** and drives a real session; a
    zero-credential user can read, on the picker itself, exactly what to set
    or run for each agent; a mock session is unmistakably labeled a demo and
    shows no dollar cost; the startup log names only the port it actually
    bound; the 403 page tells the user where the right URL is.
  - Status: **done, verified across all three tiers + one live turn on the
    target machine (2026-07-08).** (1) `agentHasCredentials("claude-code")`
    also accepts `<CLAUDE_CONFIG_DIR|~/.claude>/.credentials.json`; the
    itest harness pins `CLAUDE_CONFIG_DIR` to an empty dir so logged-in dev
    machines still test against the mock; `.env.example` now lists all four
    live paths (login first, then key/token/base-url). (2) `session_created`
    gained an additive `demo?: boolean` (set from the new
    `SessionEntry.live`); the shell draws a persistent `.demo-banner` —
    warn-toned, agent-unpaintable — reading "demo · scripted replies — no
    real agent is running · to connect <agent>: <fix>"; the per-agent fixes
    live in a new shared `web/src/agents-meta.ts` (LABEL + CONNECT_HINT).
    The mock now emits usage WITHOUT costUsd (status bar shows tokens, no
    dollar figure — only real adapters price turns), draws its 1–2 tool
    rows without replacement (the duplicated-Bash fix), and its welcome
    template says "demo session / no credentials" instead of claiming an
    ANTHROPIC_API_KEY problem regardless of agent. (3) Credential-less
    picker rows carry the one-line fix (`.onb-agent-hint`). (4) The port
    walk prints ":3000 busy — trying :3001" and only the bound port says
    "server on" (the stale listening callback was the bug — both closures
    fired on the eventual bind); the 403 body names the recovery (open the
    ?token= URL from the launching terminal). Verified — Tier 1 (103: creds
    check via CLAUDE_CONFIG_DIR seam incl. each env var alone); Tier 2 (54:
    403-body wording; forced port collision → exactly one "server on" line,
    naming the walked port); Tier 3 (12: picker hints for all three agents,
    demo banner up before the first turn with the claude fix named, a
    template turn's status bar shows tokens and no "$"). Live, this machine
    (subscription login, zero env keys): hello now says claude-code
    live:true, and a real session answered one short prompt on
    claude-sonnet-4-6 — the exact user the step was for. Note for R.6's
    onboarding eyeball: the demo badge text itself still reads
    "no credentials · demo" with the hint underneath.

- [x] **Step R.4d — Cap `!` passthrough output (from the same probe)**
  *(small, server-side; buildable now)*
  - Goal: close an uncapped-output gap. Observed: a `!` command emitting
    10 MB streamed **entirely** onto the wire and into the session ring
    buffer, and was **replayed in full (10.4 MB) to a second viewport** — the
    64 KB tool-output cap (`TOOL_OUTPUT_CAP_BYTES`, applied via `capOutput`)
    does NOT cover the bang path. A runaway `!yes` / `!cat huge.log` floods
    every reconnect and new tab, and (each `bang_output` being one ring
    message) can evict the real transcript from the 4000-message ring — a
    cheap local resource-exhaustion lever and a bad UX either way.
  - Build: bound the bang output the daemon retains/broadcasts — a per-command
    total cap with an honest truncation marker (the `bang_output`/`bang_end`
    grammar already carries a stream; mirror the tool cap's "N bytes elided"
    honesty rather than cutting silently), and/or coalesce/stop buffering past
    a ceiling so the ring can't be pushed out by one command. Keep the live
    ephemeral stdin path untouched (that's the secret path, §4.9).
  - Files: `server/pty.ts` / the bang path in `server/connection.ts` +
    `server/registry.ts` (what enters the ring), a new env knob mirroring
    `TOOL_OUTPUT_CAP_BYTES` (e.g. `BANG_OUTPUT_CAP_BYTES`), tests in kind
    (Tier 2: a big-output `!` is capped on the wire and in replay).
  - Done when: a `!` command producing far more than the cap is truncated
    with a visible marker, replay to a fresh viewport is bounded, and one
    runaway command can no longer evict a session's transcript from the ring.
  - Status: **done, verified (2026-07-08).** `BANG_OUTPUT_CAP_BYTES`
    (default 256 KB, env-overridable) bounds what the bang path broadcasts
    per command, in `connection.ts`'s onData: head-kept byte budget (same
    byte-slice technique as `capOutput`), a marker the moment the cap hits
    ("output cap reached (N bytes) — further output elided"), zero
    broadcasts past it (so nothing more enters the ring), and a final
    "(… N bytes elided …)" before `bang_end` with the withheld total. The
    PTY keeps running and the agent-context tail (`BANG_CONTEXT_CAP`,
    tail-kept) still accumulates — only the wire/ring is bounded; the
    ephemeral stdin path is untouched. Verified — Tier 2 (new test, own
    daemon with an 8 KB cap): a 200 KB `!` lands < cap+300 bytes on the
    live viewport WITH both markers, a fresh viewport's replay is bounded
    the same, and a mock turn run beforehand still replays (no ring
    eviction). Full suites: 103 Tier 1, 55 Tier 2, 12 Tier 3 (one
    unreproducible single-test flake in the first of three e2e runs; two
    subsequent full passes).

- [x] **Step R.4h — Protocol compat hardening (from the 2026-07-08 contract
  design review)** *(pre-launch, small; must land BEFORE version skew can
  exist — i.e. before the relay puts a phone bundle and an npm daemon on
  two release trains)*
  - Goal: the additive-only wire rule is enforced at the `WireMsg` layer and
    silently violated one layer up. (1) `registry-spec.ts` derives every
    component schema with `.strict()`, and the CLIENT validates render props
    with it — so adding one optional prop to `card` makes every older client
    reject every card into the raw-JSON fallback. The component vocabulary
    is part of the wire contract in practice, and it is non-additive today.
    (2) The ignore-unknown-message-type behavior both switches rely on
    (`RenderZone`, `connection.ts` — no `default:`) is the de facto
    versioning story, but it's an accident, not a stated/tested rule.
    (3) `Onboarding.tsx`'s `LABEL: Record<AgentName, string>` is exhaustive
    over the closed union — a future agent #4's name from a newer daemon
    renders an undefined label instead of the raw string, making "add an
    agent" quietly non-additive for old clients.
  - Build: the Postel split — schemas stay `.strict()` where AGENT output is
    validated (render-mcp / render-tools, reject malformed input at the
    source) and become tolerant (strip unknown keys) where the CLIENT
    parses (`RenderBlock`'s copy — e.g. a derived `.strip()` twin exported
    alongside); raw-string fallback for unknown agent names in the picker,
    fleet, and status bar; make ignore-unknown a tested rule (Tier 1: the
    client swallows an unknown WireMsg type — ws.test-style; Tier 2: the
    daemon swallows an unknown ClientMsg type and the socket lives — folds
    into Q.4's sweep naturally); write the implicit agent-#N requirements
    list into README §2.2 (MCP stdio + tool results visible in the engine's
    own event stream for the renderId ack ride-back, a discernible turn
    boundary, a warm-session mechanism, an interrupt, auto-trust for the
    injected MCP server) so the seam's real contract stops living only in
    the adapters' source.
  - Files: `server/registry-spec.ts`, `web/src/registry/RenderBlock.tsx`,
    `web/src/Onboarding.tsx` / `web/src/FleetView.tsx` /
    `web/src/StatusBar.tsx` (name fallback), `README.md` §2.2, tests in kind.
  - Done when: a new optional prop on an existing component renders fine on
    a client built before the prop existed (proven by test: yesterday's
    tolerant schema accepts tomorrow's payload); an unknown message type is
    provably ignored on both ends; and an unknown agent name shows as its
    raw string, not undefined.
  - Status: **done, verified across all three tiers (2026-07-08).** The
    Postel split: `registry-spec.ts` now exports BOTH derivations —
    `registrySchemas` stays `.strict()` for the SOURCE side (render-mcp /
    render-tools inputs, vocabulary-pinning tests) and a new `clientSchemas`
    (plain `z.object`, zod-v4 default = strip unknown keys) is what
    `RenderBlock` validates with, so a newer daemon's extra prop strips
    instead of failing the whole component into the raw-JSON fallback.
    Ignore-unknown is now a stated rule (protocol.ts header) with teeth:
    Tier 1 ws.test proves an unknown seq-stamped type is delivered inert
    AND still advances lastSeq (otherwise resume would re-replay seen
    frames); Tier 2 session.itest sends two unknown ClientMsg frames and
    the same socket then drives a clean full turn. Agent names: the R.4b
    `agents-meta.ts` records are now reached only through `agentLabel()`
    (falls back to the raw string) and `connectHint()` (undefined → hint
    line simply omitted) — Onboarding and the demo banner updated;
    FleetView/StatusBar already rendered raw strings. README §2.2 gained
    the "what agent #N actually requires" list (MCP stdio; tool results
    visible in the engine's own stream for the renderId ack ride-back; a
    discernible turn boundary; a warm-session mechanism; an interrupt;
    auto-trust for the injected MCP server). Verified — Tier 1 107 (new:
    tolerant-twin strips tomorrow's prop while strict still rejects it +
    malformed still fails the twin; unknown-type inertness + cursor
    advance; label/hint fallbacks), Tier 2 56 (unknown ClientMsg swallowed,
    socket lives), Tier 3 12/12 (client bundle rebuilt with clientSchemas —
    full regression pass). With this, all three "don't launch without"
    steps (R.4f, R.4b, R.4h) are closed.

- [x] **Step R.4g — Supportability sweep: version, error logging, honest
  failure text (from the 2026-07-08 operability review)** *(pre-launch;
  several small touches, one theme: a stranger's bug report must contain
  enough to act on)*
  - Goal: today a bug report contains nothing usable. (1) **No version
    anywhere** — no `--version`, none in the boot line, the UI, or the
    `agents` hello; post-relay, the phone bundle vs daemon version is a
    second invisible axis. (2) **The likeliest failures never reach the
    terminal** — engine/adapter errors (bad key, engine died, CLI missing)
    go to the browser as `error` WireMsgs and are never logged server-side;
    there are 14 log sites total (boot/attach/action/relay), no timestamps,
    and no debug knob. (3) The boot output **prints the pairing code** — a
    user pasting their terminal into a public issue leaks the remote-path
    credential. (4) On Node < 20.12, `process.loadEnvFile` doesn't exist and
    the bare try/catch swallows it — a valid key in `.env` lands in mock
    mode with zero indication why. (5) A daemon crash (no process-level
    handlers) is loud but points nowhere.
  - Build: read the package version once (esbuild-safe — import or embed at
    build time) → boot line, `--version`/`--help` in `bin/genui-shell.js`,
    `agents` hello (additive field) and status bar — and the client
    announces its own build back (additive field on `attach`/`create`), so
    a skewed pair is visible from the daemon's log (2026-07-08 contract
    review); mirror every `error`
    WireMsg the daemon emits to `console.error` with a timestamp; one
    opt-in `GENUI_DEBUG=1` that logs normalized adapter events + engine
    stderr; a "keep this secret" marker on the pairing-code line; catch the
    missing-`loadEnvFile` case distinctly and say so ("this Node can't read
    .env — need ≥ 20.12"); `uncaughtException`/`unhandledRejection`
    last-gasp handlers that print version + report URL and re-exit nonzero
    (crash stays loud — it just signs its name).
  - Files: `bin/genui-shell.js`, `server/index.ts`, `server/protocol.ts`
    (additive hello field), `web/src/StatusBar.tsx`, adapters (debug hook),
    tests in kind (Tier 1: version string + flag; Tier 2: error mirroring
    observed in daemon logs).
  - Done when: `genui-shell --version` answers; the boot line, status bar,
    and hello all carry the version; a live-agent failure appears in BOTH
    the transcript and the terminal log with a timestamp; and a wrong-Node
    `.env` user is told exactly what happened instead of silently getting
    the mock.
  - Status: **done, verified across all three tiers (2026-07-08).**
    (1) Version: new `server/version.ts` + `web/src/version.ts` import
    package.json at build time (`resolveJsonModule` on; esbuild/Vite inline
    it) — boot line (`v0.1.0 — server on …`, harness regex unbroken),
    `--version`/`-v` + `--help`/`-h` in the launcher (answer without
    booting; the launcher reads the package.json shipped beside it),
    `agents` hello `version` field, status bar `v0.1.0` item; the client
    stamps `clientVersion` onto attach/create at ONE choke point
    (`SocketClient.stamp`, covering hello + queued sends) and the daemon
    logs "version skew: client vX, daemon vY". (2) Error mirroring, two
    choke points: `registry.broadcast` (adapter/session-stream errors —
    the likeliest live failures) and connection's `sendError` (viewport
    errors: malformed frame, bad cwd, bang-busy), both ISO-timestamped.
    (3) `GENUI_DEBUG=1`: one line per broadcast WireMsg (truncated to 300
    chars; bang_input never crosses broadcast, so no secret can appear) +
    engine stderr where an stderr surface exists (claude-code via the SDK's
    stderr callback, gemini-cli via child.stderr; the Codex SDK exposes
    none). (4) Pairing-code line now carries "KEEP THAT CODE SECRET…".
    (5) Old-Node path: loadEnvFile absence is detected distinctly and says
    credentials in .env were NOT loaded (branch typechecked; a <20.12
    runtime isn't runnable here). (6) Last-gasp uncaughtException/
    unhandledRejection handlers print version + issues URL (with a
    don't-paste-tokens warning) and exit 1. Verified — Tier 1 111 (semver;
    client and daemon versions equal; launcher --version/--help by real
    spawn), Tier 2 57 (hello version; bad-cwd error mirrored timestamped;
    skew logged; R.4f test now also asserts the broadcast-path mirror),
    Tier 3 12 (status bar shows v-semver, full regression). Note: one
    parallel Tier-2 run had relay.itest's whole file fail on its shared
    before() under machine load (15s boot window); alone 14/14, next full
    run 57/57 — pre-existing load flake, not this change.

- [x] **Step R.4c — Resilience honesty (from the 2026-07-07 failure-mode
  probe)** *(independent of R.2/R.5 — buildable now; both items are everyday
  events, not exotic: a laptop sleeping, a crash, or re-running `genui-shell`)*
  - Goal: two live-observed "the app lies / loses data quietly" behaviors
    from a run-and-break survey (17 malformed frames, daemon kill, relay
    kill, 10 MB `!`, two-tab permission, live agent-subprocess kill — the
    rest all passed: the daemon is hard to crash, the stateless relay
    recovers fully, cross-tab permissions and agent-subprocess death are
    handled honestly). The two that need fixing both trace to the same fact —
    the daemon holds every session **in memory with no persistence**, so its
    death is unrecoverable AND unannounced:
    (1) **Silent session wipe on reconnect.** Observed: kill the daemon with
    a browser attached, restart it → the client's `attach` with the old id
    hits the "stale/unknown id falls back to a fresh session" path
    (`connection.ts`), so it reconnects into a NEW empty session, the URL
    silently rewrites (`/s/38c8dbab` → `/s/d0ba3bdf`), and the transcript
    blanks with no explanation. (Durable cross-restart persistence is the
    deferred 4.1/4.4 item and stays deferred — this is only about being
    HONEST that it happened.)
    (2) **Stuck "busy"/stop affordance on mid-turn death.** Observed: when
    the daemon dies mid-turn the connection dot correctly flips to
    "reconnecting…", but the ■ esc stop button stays visible because busy
    clears only on `turn_end`/`zone_reset` (`Shell.tsx`) and neither arrives
    — it looks like the agent is still working.
  - Build: (a) distinguish "attached to the session I asked for" from "server
    gave me a fresh one" — the server already knows (it took the fallback
    branch), so carry a flag (e.g. reuse/extend `session_created` — additive)
    that lets the shell show a shell-drawn notice ("that session ended —
    started a new one") instead of a silent swap; (b) clear busy (and the
    stop affordance) on socket close/reconnect-in-progress, re-deriving it
    from replay as today, so a dropped turn doesn't look live.
  - Files: `web/src/Shell.tsx`, `web/src/ws.ts`, `server/connection.ts`,
    `server/protocol.ts` (additive flag if used), tests in kind (Tier 2:
    fallback-create signals the new-session case; Tier 3: kill-daemon →
    restart shows the notice, and mid-turn drop clears the stop button).
  - Done when: after a daemon restart the user sees an explicit "session
    ended, new one started" cue (not a blank screen + changed URL), and a
    turn interrupted by a daemon drop stops showing the ■ esc/working state
    while it reconnects.
  - Status: **done, verified (2026-07-08).** (1) `session_created` gained an
    additive `fallback?: boolean`, set ONLY when an id was actually asked
    for and the registry doesn't have it (an id-less attach never had a
    transcript to lose); the shell draws a dismissable `.session-notice`
    ("that session ended — started a new one …the previous transcript
    wasn't saved"), same warn-toned shell-owned family as the demo banner,
    cleared on dismiss or on the first prompt into the new session.
    (2) busy now clears on socket close AND re-derives from any turn
    activity (`status`/`thinking_delta`/`text_delta`/`tool_use`, not just
    `user_prompt`) — necessary because a 4.4 tail resume mid-turn replays
    none of the turn's opening frames, so close-clears-busy would otherwise
    have left a live streaming turn with no ■ esc. Verified — Tier 2 58
    (fallback:true on gone-id attach; absent on create and on live
    re-attach); Tier 3 13, new `resilience.e2e.ts`: real daemon killed
    mid-turn under headless Chrome → `.stop-btn` detaches; restart on the
    same port → notice appears with the URL moved on, dismiss removes it;
    phone.e2e's offline→online mid-turn resume still passes (the busy
    rework didn't regress tail resume). The gap-close block R.4b–R.4h is
    now COMPLETE except R.4e (test-only, next).

- [x] **Step R.4e — Prove the artifact sandbox fails closed (from the
  2026-07-08 test-suite quality review)** *(test-only, buildable now;
  pre-launch — this is the trusted-shell boundary against agent-authored
  content, and it currently has one positive test and zero negative ones)*
  - Goal: every containment property `Artifact.tsx` documents is held up only
    by the comment describing it. Today **no test fails** if:
    `sandbox="allow-scripts"` gains `allow-same-origin` (one word — a hostile
    artifact can then reach the shell's DOM, cookie, and socket); the injected
    `default-src 'none'` CSP is dropped from `wrap()` (network exfiltration
    opens; the friendly counter demo still passes); `parseBridgeAction` starts
    accepting state ops, oversized payloads, or malformed shapes; the
    nonce/origin/source checks on the bridge listener are removed; the 400 ms
    action rate limit is deleted; or the navigation-liveness kill is deleted.
    The only artifact test (`app.e2e.ts`) is the friendly positive path.
  - Build: (a) Tier 1 — `parseBridgeAction` and `wrap()` are pure functions;
    unit-test them directly (prompt/tool accepted; state kind, junk, missing
    `genui` stamp, >4000-char text, array args all rejected; `wrap()` output
    carries the CSP meta and boot script *before* the content). (b) Tier 3 —
    a "show me a hostile artifact" mock hook whose html attempts the escapes,
    then assert containment in a real browser: `fetch()` blocked by the CSP,
    `parent.document` throws, an unstamped/forged `postMessage` never lands an
    action, a state-op bridge message is dropped, an action burst is
    rate-limited, `location=` navigation unmounts the frame into the
    "navigation blocked" fallback — and assert the rendered iframe's `sandbox`
    attribute is **exactly** `allow-scripts`.
  - Files: new `web/src/Artifact.test.ts` (Tier 1), `server/adapters/mock.ts`
    (hostile hook), `server/app.e2e.ts` (Tier 3 cases); `web/src/Artifact.tsx`
    only if an export is needed for the unit tests. The rest of the review's
    findings live in **Phase Q** below.
  - Done when: temporarily flipping each defense (add `allow-same-origin`,
    remove the CSP meta, let state ops through the parser) makes at least one
    test fail — verified by actually flipping each, then restoring it.
  - Status: **done, verified — including the flip-each-defense proof
    (2026-07-08).** Tier 1 `web/src/Artifact.test.ts` (8 tests): exported
    `parseBridgeAction` + `wrap()` and unit-tested them — prompt/tool
    accepted (with/without object args); state ops, junk, missing/wrong
    `genui` stamp, no action, blank/typed/>4000-char text, missing name,
    array/string args, >200-char name all rejected; `wrap()` output carries
    the `default-src 'none'` CSP meta AND the nonce-closing boot script,
    both positioned BEFORE the content. Tier 3: a `/hostile/` mock hook
    (`HOSTILE_ARTIFACT`) whose script attempts every escape and records the
    outcome into its OWN DOM; `app.e2e.ts` asserts in a real browser that
    `parent.document` is blocked, `document.cookie` throws, `fetch()` trips
    a CSP violation (never succeeds), the iframe `sandbox` is EXACTLY
    `allow-scripts`, and — via the transcript — that a forged/unstamped
    bridge message and a state op never land while a 2-action burst is
    rate-limited to one (only `burst-alpha` reaches the transcript, never
    `burst-beta` or the forged prompt); a second test drives the navigating
    artifact (now `about:blank`, hermetic) into the "navigation blocked"
    fallback. Two real-containment wrinkles found and handled: the
    artifact's own CSP blocks Playwright's frame script-injection, so the
    test reads `frame.content()` (no injection) instead of evaluate/
    waitForSelector; and the transcript accumulates across tests, so it
    targets the NEWEST iframe. Flip-proof (actually done, then restored):
    parser accepting state ops → 3 Tier-1 fail; dropping the CSP meta from
    `wrap()` → 1 Tier-1 fail; adding `allow-same-origin` to the sandbox →
    Tier-3 test 6 fails. Full suites green: 119 Tier 1, 58 Tier 2, 15
    Tier 3. **The entire pre-launch gap-close block R.4b–R.4h is now
    complete.**

- [x] **Step R.4i — Per-provider credential policy: block prohibited
  subscription use (from the 2026-07-10 provider-ToS review)** *(pre-launch,
  launch-GATING — this is legal exposure to Kyle and to users, not polish;
  sequence it before R.5. Buildable now; no external accounts. NOT legal
  advice — the matrix below is our reading of published terms as of
  2026-07-10; a lawyer's pre-launch sign-off is still owed, R.6.)*
  - Goal: enforce, in code, what each provider's terms currently permit.
    Three closed first-party providers, one open/local escape hatch, two
    layers (free LOCAL use vs the paid RELAY). The matrix — date-stamped and
    revisit-able, because all three terms MOVED in H1 2026:
    - **Anthropic** (closed): subscription **prohibited everywhere** — the
      OAuth-token-in-any-third-party-tool ban (terms Feb 2026, enforced Apr 4,
      the change that killed OpenClaw); genui-shell IS "another tool". API key
      allowed local; **relay = API key only**.
    - **Google Gemini** (closed): same as Anthropic — the Gemini CLI ToS
      third-party clause, and individual/AI-Pro/AI-Ultra tiers were cut off
      from Gemini CLI on 2026-06-18. Already API-key-only in our code; keep it,
      route it through the policy. **Relay = API key only.**
    - **OpenAI** (closed): the lone exception — OpenAI publicly permits ChatGPT
      accounts in third-party harnesses, so subscription is **allowed for free
      LOCAL use**. The **relay is refused** (charging for remote access to a
      subscription-backed agent is the gray reselling area — refuse for now).
    - **Open / local endpoint** (BYO): **anything goes**, local and relay —
      the user's own compute, no first-party ToS in play.

    The relay line is NOT about the credential transiting the relay (it never
    does — R.3 makes frames E2E-opaque and the daemon calls the model locally);
    it's that charging for remote access to a subscription-backed agent trips
    the providers' reselling clauses. API-key-only on the relay = the user pays
    the provider directly for metered use and we sell only transport — the
    defensible line.
  - Build: (1) a single source-of-truth `server/provider-policy.ts` —
    date-stamped header citing this review — exporting the credential KIND per
    agent (`api-key` | `subscription` | `local` | `none`) and two predicates,
    `allowedLocally(kind, agent)` and `allowedOverRelay(kind, agent)`.
    Everything else consumes this; the matrix lives in exactly ONE place, so a
    future terms change is a one-file edit. (2) Rework
    `agentHasCredentials`/`resolveBackendFor`/`availableAgents` in
    `server/adapters/index.ts` to return a TRI-state, not a bool: `live`
    (api-key or local endpoint), `blocked` (a PROHIBITED credential is present —
    e.g. `~/.claude/.credentials.json` with no API key), or `none`. This
    partially REVERTS R.4b point (1): a Claude subscription login must stop
    counting as live (business consequence owned in R.4j — it changes the
    day-one user). Detect the KIND, don't just presence-check: for claude-code,
    `ANTHROPIC_BASE_URL` set = `local` (BYO endpoint, keep it live — it's the
    Ollama path L.1 relies on); an Anthropic key = `api-key`; only
    `.credentials.json` with no key = `subscription` → `blocked`. Codex:
    `OPENAI_API_KEY` = `api-key`, `~/.codex/auth.json` = `subscription` (live
    locally, relay-ineligible). Gemini: `GEMINI_API_KEY`/`GOOGLE_API_KEY` =
    `api-key` (unchanged, just routed through the policy). (3) **The relay
    gate**: a REMOTE (relay-origin) viewport must refuse to attach to a session
    whose kind is `subscription` (any provider) — allow only `api-key`/`local`.
    Key it on the relay-origin flag that already distinguishes remote from
    local viewports (R.1 put both on the same `connection.ts` path); LOCAL
    viewports are never affected. Refuse cleanly with an additive reason field
    (new OPTIONAL field on the existing refusal / `session_created` path —
    additive only, never reshape) so the phone shows WHY, not a blank drop.
    (4) **Onboarding surface**: `blocked` renders a distinct, honest row — not
    the mock demo, not a dead badge — naming the concrete fix ("You're logged
    into Claude on a subscription. Anthropic's terms don't allow subscription
    use in other apps — set `ANTHROPIC_API_KEY` to use Claude here."); copy
    lives with the R.4b `agents-meta.ts` hints. Known edge — note, don't
    necessarily solve now: the L.1 `OPENAI_API_KEY=local` dummy for a Codex
    local-provider config would misread as `api-key`; treat a detectable Codex
    local-provider config as `local`, or leave the sharper detection to L.2 and
    document the wart.
  - Files: new `server/provider-policy.ts` (+ `.test.ts`),
    `server/adapters/index.ts`, `server/adapters/types.ts` (Backend gains the
    kind), `server/connection.ts` / `server/relay-client.ts` (the remote-attach
    gate), `server/protocol.ts` (additive refusal-reason field),
    `web/src/Onboarding.tsx`, `web/src/agents-meta.ts`, `.env.example`; tests in
    kind (Tier 1: the policy matrix — every provider × kind × layer cell;
    Tier 2: a subscription-backed session refuses a REMOTE attach with the
    reason yet still serves a LOCAL viewport; Tier 3: onboarding shows the
    blocked-guidance row on a subscription-only Claude machine).
  - Done when: a machine with only `~/.claude/.credentials.json` shows Claude
    Code **blocked with the API-key fix on the picker** (no longer "ready", no
    silent mock); an API-key or `ANTHROPIC_BASE_URL` machine is unchanged; a
    subscription-backed session refuses a relay/remote viewport with a visible
    reason while its LOCAL tabs keep working; and the matrix is pinned by a
    Tier-1 test so a future terms change is a one-file, one-test edit.
  - Status: **done, verified across all three tiers (2026-07-10).** The matrix
    lives in one dated file, `server/provider-policy.ts`: `credentialKind` +
    two predicates — `allowedLocally(agent, kind)` and `allowedOverRelay(kind)`.
    The relay predicate refuses exactly ONE thing, a `subscription` (even
    OpenAI's, fine locally); api-key, local/BYO, and `none` (a credential-less
    demo — no provider, no ToS) all pass, because payment is R.5's SEPARATE gate,
    not this one (this catch, and the itest breakage that surfaced it, corrected
    the plan's looser "api-key/local only" wording). Detection
    (`adapters/index.ts`) is now tri-state: `credentialKind` distinguishes an
    Anthropic API key (`api-key`), a `~/.claude/.credentials.json` login with no
    key (`subscription`), and an `ANTHROPIC_BASE_URL`/Ollama endpoint (`local`,
    which WINS over a stray login — the open escape hatch); `resolveBackendFor`
    carries the kind onto `Backend`→`SessionEntry`, and `availableAgents` returns
    `blocked` when a prohibited subscription is present. This REVERTS R.4b
    point (1) as planned: a Claude subscription login is no longer `live` — it
    falls to the mock (we never drive it) and the picker shows a warn-toned
    "subscription not supported" row naming the API-key fix (new `blockedHint`;
    `CONNECT_HINT` for Claude no longer suggests `claude` login; Codex keeps
    `codex login` — OpenAI permits it locally). The relay gate is one choke
    point in `connection.ts`'s `attachTo`, keyed on a new explicit `remote` flag
    (relay-client passes it): a remote viewport onto a `subscription` session
    gets a new additive `refused` WireMsg (reason + human message) and is NOT
    attached; local viewports are never gated. Additive protocol only: `blocked?`
    on the agents hello, `refused`; old clients degrade. Verified — Tier 1 (132:
    the full policy matrix incl. every provider×kind×layer cell; detection tri-
    state via CLAUDE_CONFIG_DIR — subscription→blocked, key→live, base-url→live-
    over-login), Tier 2 (relay.itest #14: a subscription daemon refuses a REMOTE
    create with `reason: "subscription-relay"` and hands it no session, while a
    LOCAL viewport on the SAME daemon is served the mock — plus the hello marks
    claude blocked), Tier 3 (app.e2e: a subscription-only Claude machine shows
    the `.onb-blocked` row with "third-party apps" + `ANTHROPIC_API_KEY`, Codex
    unaffected). `.env.example` Claude block rewritten (API key is the path; the
    login is called out as prohibited-by-Anthropic, not by us — the fuller doc/
    BUSINESS reconciliation is R.4j). typecheck clean; Tier-1 132, Tier-2 68,
    Tier-3 all green.

- [x] **Step R.4j — Reconcile the docs & business framing to the provider
  policy (from the 2026-07-10 provider-ToS review)** *(pre-launch, prose-only;
  pairs with R.4i — the code is the enforcement, this is the honest story
  around it)*
  - Goal: every place that tells a user (or us) that a Claude/Gemini
    subscription is a supported path must change, and the business framing must
    own the consequence: **the day-one closed-model user is a BYO-API-key user,
    and the paid relay is BYOK-only.** This reverts the R.4b positioning and is
    a real go-to-market shift (BUSINESS.md), not a wording tweak — flag it as
    such, don't bury it.
  - Build: (1) PLAN.md "Locked decisions → Auth": restore "API key required for
    the closed providers" but for the CORRECT reason — provider TERMS, not the
    old (now-false) "the SDK can't run headless on a login" technical claim (R.4b
    disproved that; the block is legal, not technical now); cite
    `server/provider-policy.ts` as the source of truth. (2) BUSINESS.md: state
    the positioning consequence — closed models are BYOK; OpenAI subscription is
    free-LOCAL-only; the relay is sold as BYO-API-key remote access; name the
    day-one-user shift (was "the Pro/Max subscriber," now "the API-key holder")
    and revisit any pricing/reach copy that assumed subscription users.
    (3) `mirafold/CLAUDE.md` + umbrella `genui/CLAUDE.md`: add a short
    non-negotiable — "genui-shell must not enable prohibited subscription use;
    the dated, revisit-able matrix lives in `server/provider-policy.ts`."
    (4) `.env.example`: Claude presents the **API key** as the live path again
    (subscription login removed as an OFFERED path, with a one-line note that
    it's prohibited by Anthropic's terms, not by us); keep the
    `ANTHROPIC_BASE_URL` local/Ollama path (open, anything goes). (5) README
    auth/onboarding section + any `docs/` naming the login path — same
    correction; `docs/local-models.md` Path A is UNAFFECTED (it's the open
    BYO-endpoint escape hatch). (6) One line in the relay/DEPLOY story: the
    relay admits only api-key/local sessions — subscription pairings are refused
    by the DAEMON (R.4i), independent of Stripe entitlement (R.5).
  - Files: `PLAN.md` (Locked decisions), `BUSINESS.md`, `mirafold/CLAUDE.md`,
    `../CLAUDE.md` (umbrella), `.env.example`, `README.md`, relevant `docs/`.
  - Done when: no shipped doc or example offers a Claude/Gemini subscription as
    a way to run genui-shell; BUSINESS.md names the BYOK day-one user and the
    BYOK-only relay; and `server/provider-policy.ts` is cited as the single
    source of truth everywhere the rule is stated.
  - Status: **done (2026-07-10).** Prose-only, no code. (1) PLAN "Locked
    decisions → Auth" rewritten for the CORRECT reason — provider terms, not the
    old "can't drive the SDK headlessly" claim (R.4b disproved that) — citing
    `provider-policy.ts`. (2) BUSINESS.md: a §2 note makes BYOK-for-closed-models
    a terms REQUIREMENT that sharpens (not shrinks) the API-key-cohort first
    target, and retires the earlier "day-one user is a Pro/Max subscriber"
    assumption (it's the API-key holder — what §2 always said); a §7 bullet
    states the relay is BYO-API-key by rule (subscription refused by the daemon,
    independent of billing, because the E2E-blind relay can't and needn't tell);
    §8.5 (ToS drift) records the dated, enforced stance + the owed lawyer
    sign-off. Notably the strategy was ALREADY BYOK-native — this reconciled the
    CODE (post-R.4b) back to it, not the other way. (3) Both CLAUDE.md files (the
    shell's non-negotiables + the umbrella's cross-repo rules) gained a
    provider-policy bullet pointing at the one-file source of truth. (4)
    `.env.example`: Claude API-key-only (login called out as prohibited-by-
    Anthropic), Gemini ToS note, Codex "local yes / relay no" note. (5) README:
    the "to go live" section states closed-models-are-API-key with the local/BYO
    escape hatch, the R.4b changelog line's reversed half is marked, and a new
    2026-07-10 changelog entry summarizes R.4i/R.4j. (6) The private
    `mirafold-relay/README.md` "deliberately does not" list gained a line: the
    relay enforces no credential policy — the daemon refuses subscription
    sessions before any frame, independent of entitlement. `provider-policy.ts`
    is now cited as the source of truth in all six places. **The 2026-07-10
    provider-ToS work (R.4i + R.4j) is complete.**

- [x] **Step R.4k — Onboarding honesty + local-model discoverability (from the
  2026-07-10 strategy memo §2/§4 + the onboarding-clarity review)**
  *(pre-launch, small; code + copy, additive protocol only)*
  - Goal: the picker under-serves two audiences it currently confuses — the
    newcomer who doesn't know where to get a key, and the **local/open-model
    user who can't tell genui-shell is FOR them**. Four observed gaps: (1) a
    local-model user sees only "Claude Code · ready" with no sign their endpoint
    was picked up ("I don't see my model"); (2) the local path — especially
    Codex → Ollama/LM Studio/vLLM, a primary route — is invisible in the UI, so
    "run your own model" reads as unsupported even though the launch copy
    promises "BYOK or fully local"; (3) credential hints say WHAT to set, not
    WHERE to get it; (4) the tolerated Codex subscription path carries a small
    tail-case account risk with no disclosure.
  - Build:
    (a) **Surface the resolved/configured target on live rows.**
    `availableAgents()` gains an optional per-agent `detail` (additive on the
    `agents` hello): a `local` kind → "local endpoint · <host>" (from
    `ANTHROPIC_BASE_URL`); a configured model override
    (`DEFAULT_MODEL`/`CODEX_MODEL`/`GEMINI_MODEL`) → that id; else omitted (the
    agent inherits its own default). Honest scope: the TRULY resolved model only
    arrives from the engine's init on the first turn (that's F.3, the status
    bar) — the picker shows the CONFIGURED target, which is exactly what the
    Ollama user is missing.
    (b) **A named local-model signpost under the picker** (shell copy, NOT a 4th
    agent — local is a property of the agent): "Running a local/open model
    (Ollama, LM Studio, vLLM)? Point Claude Code or Codex at it — see the
    local-models guide," pointing at `docs/local-models.md`.
    (c) **Credential "where to get it" links** in the hints: Anthropic Console,
    OpenAI API-keys page, Gemini AI-Studio (already present); finish the
    login-vs-key clarity R.4i began; add Codex's LOCAL option to its hint.
    (d) **Codex subscription disclosure** at the codex login path (hint +
    `.env.example`): "works because OpenAI permits it — depends on their policy,
    could change." Plus the L.1 dummy-`OPENAI_API_KEY=local` note for a
    config-only local Codex so that user isn't silently stuck.
  - Files: `server/adapters/index.ts` (`availableAgents` detail),
    `server/protocol.ts` (additive `detail?`), `web/src/agents-meta.ts` (hints +
    URLs + codex local/disclosure), `web/src/Onboarding.tsx` (detail render +
    signpost), `web/src/Shell.tsx` (thread detail), `web/src/styles.css`,
    `.env.example`; tests in kind (Tier 1: `availableAgents` detail for a local
    endpoint + a configured model; Tier 3: the picker shows the signpost, and a
    base-URL daemon's live row shows its endpoint detail).
  - Done when: a daemon pointed at a local endpoint shows the endpoint on the
    picker (not a bare "ready"); every credential-less row names where to get
    the key; the local-model path is visible and named on the onboarding screen;
    and the Codex subscription step carries its one-line "could change"
    disclosure.
  - Status: **done, verified Tier 1 + Tier 3 (2026-07-10).** (a) `availableAgents`
    gained an additive `detail` (new `agentDetail`/`endpointHost` in
    `adapters/index.ts`): a `local` kind shows "local endpoint · <host>" parsed
    from `ANTHROPIC_BASE_URL`, else a configured `*_MODEL` override, else
    omitted; `detail?` added to the `agents` WireMsg and threaded through
    Onboarding/Shell, rendered as an accent-tinted `.onb-agent-detail` on live
    rows. (b) A shell-drawn `.onb-local-note` under the picker names the
    local/open-model path (Ollama/LM Studio/vLLM) as a first-class choice —
    "point Claude Code or Codex at it", pointing at `docs/local-models.md` —
    since local is a MODE of an agent, not a fourth row. (c) `CONNECT_HINT`
    rewritten with WHERE-to-get-it (console.anthropic.com, platform.openai.com,
    aistudio.google.com) and a local option on the closed rows; Gemini says "no
    local path" plainly. (d) The Codex hint + `.env.example` carry the "OpenAI
    permits it today, could change" disclosure, and `.env.example` documents the
    dummy `OPENAI_API_KEY=local` a config-only local Codex needs. Verified —
    Tier 1 (135: `detail` for a local endpoint incl. host, a configured model,
    and absent when non-live), Tier 3 (app.e2e 9: the `.onb-local-note` signpost
    is on the picker screen, and a base-URL daemon's Claude row shows "ready"
    with "local endpoint · localhost:11434"). typecheck clean; Tier-2 68 and the
    other e2e suites regression-green.

- [x] **Step F.1 — Slash-command output renders (buffered assistant text)**
  - Goal: typing `/context`, `/compact`, `/usage` — the SDK supports 45
    commands including the user's own skills — shows the command's output.
    Observed: the output arrives as a **buffered `assistant` text message with
    zero `stream_event` deltas** (local, cost 0), and the adapter renders
    assistant text only from deltas → the command runs but nothing paints.
    (Not `local_command_output` as the SDK types suggest — verified live.)
  - Build: in `pump()`'s `assistant` case, emit text blocks that were *not*
    already streamed this turn as `text_delta` (track whether deltas preceded
    the message; the normal streamed path must not double-render). Unsupported
    commands ("/status isn't available in this environment") arrive the same
    buffered way — the same fix covers them, no special-casing.
  - Files: `server/adapters/claude-code.ts` (+ its `.test.ts`, scripted engine).
  - Done when: a scripted-engine test shows a buffered-only assistant message
    rendering exactly once and a streamed turn not doubling; live, `/context`
    in a claude-code session paints the context table in the transcript.
  - Status: **done, verified scripted + live (2026-07-08).** A per-turn
    `streamedText` flag in the claude adapter: set when a `stream_event`
    text_delta is emitted, reset on `result`. The `assistant` case now emits
    `text` blocks as `text_delta` only when the turn streamed nothing AND
    the message isn't a subagent's (its prose stays filtered like its
    deltas) — so buffered slash-command output paints while the normal
    streamed path never double-renders. Verified — Tier 1 (3 new scripted
    tests: buffered-only renders once; a streamed turn ignores its buffered
    copy; the decision resets per turn — 122 total green). Live on this
    machine (subscription login): `/context` painted the full context table
    (1 text_delta, 1839 chars: "## Context Usage … Tokens: 26.2k / 200k …")
    where before the fix it produced nothing. Covers unsupported commands
    too (same buffered shape, no special-casing).

- [x] **Step F.2 — System-notice line (the UI must not lie in degraded service)**
  — done 2026-07-12. One additive `WireMsg`, `notice { text, kind? }` (kind ∈
  `retry | compaction | rate_limit | refusal`), mapped in the claude adapter's
  `pump()` from five SDK events: `system/api_retry` → "API error — retrying
  (attempt n/m)…" (retry), `system/compact_boundary` → auto/manual compaction
  line (compaction), `system/model_refusal_fallback` → "declined — retried on
  <model>" and `model_refusal_no_fallback` → "declined to complete this
  request" (refusal), and top-level `rate_limit_event` → surfaced ONLY on
  `allowed_warning`/`rejected` (the constant plain `allowed` stays silent, so
  the "not rare" event doesn't spam). The `system/init` model-resolve (F.3) is
  now gated on `subtype === "init"` so the new subtypes don't disturb it.
  RenderZone draws a dim persistent `.notice-line` (thinking-block family,
  per-kind glyph ↻/⊙/⚠, amber for rate_limit/refusal via `--warn-fg`) — it does
  NOT fold thinking or close the streaming block, since a status aside isn't the
  turn's real output. Verified: 4 new scripted-engine tests in
  `claude-code.test.ts` map each event (and the silent-`allowed` case) to the
  right `notice` while the turn still completes (Tier-1, 146 pass); `yarn
  typecheck` + `yarn build` clean. Files: `server/protocol.ts`,
  `server/adapters/claude-code.ts`, `web/src/RenderZone.tsx`,
  `web/src/styles.css`, `server/adapters/claude-code.test.ts`.
  Note: the browser render is exercised by build/typecheck and mirrors the
  proven thinking-block branch — a *live* notice wasn't driven in Chrome
  because the mock adapter has no notice path (out of F.2's file scope); the
  scripted mapping is the plan's named Done-when and is green.

- [x] **Step F.3 — Honest model label in the status bar**
  - Goal: show the model the engine actually resolved, like the terminal's
    own status line. Observed: Claude's `system/init` carries the real model
    (`claude-fable-5`) while the adapter's label says the configured value or
    literally `"default"`; Gemini's `init.model` can be the literal string
    `"auto"` while the real models (router + worker) appear only in
    `result.stats.models`.
  - Build: claude adapter reads `system/init.model` into `modelLabel` (the
    gemini adapter already reads its init — this is consistency); gemini
    adapter prefers the `result.stats.models` keys when the init label is
    `"auto"`/unset. `usage.model` already exists on the wire — no protocol
    change.
  - Files: `server/adapters/claude-code.ts`, `server/adapters/gemini-cli.ts`,
    matching tests.
  - Done when: tests assert engine-reported names flow into `usage.model` for
    both adapters; live status bar shows the real model, not "default"/"auto".
  - Status: **done, verified scripted + live (2026-07-08).** Claude adapter:
    a new `system` case in `pump()` reads `system/init.model` into
    `modelLabel` (was the configured value or the "default" placeholder).
    Gemini adapter: a `honestModel()` helper prefers concrete names from
    `result.stats.models` (object keys or a string array, joined) when the
    init label is vague (`auto`/`gemini`/unset), else keeps the init model;
    wired into the result-case `usage.model`. No protocol change
    (`usage.model` already existed). Verified — Tier 1 (3 new: claude
    system/init model reaches usage.model; gemini `auto`→real stats models;
    gemini concrete init model kept over stats — 125 total green). Live on
    this machine with `DEFAULT_MODEL` unset: `usage.model` came through as
    **claude-opus-4-8** (the subscription's real resolved default) where
    the pre-F.3 code showed the literal "default".

- [x] **Step F.4 — Gemini honesty pass (silent death on stderr-only failure)**
  - Goal: live-observed trap — in a cwd outside the user's Gemini trusted
    folders, the CLI writes the trust error to **stderr only** and exits 55
    with nothing on stdout; the adapter reads only stdout, so the turn ends
    silently: "thinking…", then nothing, no error. (The companion finding —
    Google ended the individual OAuth free tier, observed as "migrate to
    Antigravity" — turned out to already be handled: `agentHasCredentials`
    in `server/adapters/index.ts` keys Gemini liveness on
    `GEMINI_API_KEY`/`GOOGLE_API_KEY` only, with the IneligibleTierError
    documented in-code. Verified 2026-07-07 during the cold-start pass;
    nothing to build there.)
  - Build: keep a capped stderr tail per turn; when the child exits non-zero
    having emitted no stdout events, emit `error` with that tail.
  - Files: `server/adapters/gemini-cli.ts`, stub-binary tests
    (`GENUI_GEMINI_BIN` seam).
  - Done when: a stub that dies stderr-only surfaces as an `error` WireMsg in
    the transcript (no more silent turn).
  - Status: **done, verified (2026-07-08).** `runTurn` now keeps a capped
    (`STDERR_TAIL_CAP` 4000) stderr tail and a `sawEvent` flag (set when any
    stdout line parses as JSON). On `close`, a non-zero exit code (null =
    signal kill/interrupt, excluded) with no parsed stdout events and a
    non-empty stderr tail emits `error: gemini exited <code>: <tail>` before
    the turn_end. Gated by `sawEvent` so a turn that DID stream stdout (its
    own `error` event, a normal reply) never double-reports. Verified — Tier
    1 (stub gained a `FAKE_STDERR` knob; 2 new tests: stderr-only exit 55
    surfaces the trust-folder message before turn_end; a nonzero exit WITH
    stdout events stays single — 127 total green). Live not exercised (needs
    a real Gemini key + an untrusted cwd, and the stub reproduces the exact
    stdout-silent/stderr-only/nonzero shape); the R.4g `GENUI_DEBUG` stderr
    stream already surfaced the same tail for operators.

- [x] **Step L.1 — Documented local path (ship with the M2 launch)**
  - Goal: a motivated local-model user is running in a couple minutes.
  - Build: `docs/local-models.md` — point a local-capable agent (e.g. Codex) at
    a running Ollama/vLLM/LM Studio (base URL + model, no proxy); an honest
    "recommended models" table (30B+ coding models work well, small models
    degrade gracefully via Step 1.4 — with hardware notes).
  - Files: `docs/local-models.md`, README link.
  - Done when: a stranger following only the doc drives a local model through
    the browser UI; the launch post can truthfully say "BYOK or fully local."
  - Status: **written 2026-07-07; facts verified against vendor docs + our
    code, live local run still owed** — `docs/local-models.md` covers two
    paths: (A) Claude Code → Ollama ≥ 0.14 via its Anthropic Messages API
    (`ANTHROPIC_BASE_URL` + dummy `ANTHROPIC_AUTH_TOKEN`; our
    `agentHasCredentials` already counts `ANTHROPIC_BASE_URL` as live, so no
    code change), and (B) Codex → Ollama/LM Studio/vLLM via a top-level
    default provider in `~/.codex/config.toml` (`wire_api = "responses"` is
    now Codex's ONLY wire API — chat was removed; and it must be the config
    *default*, since our adapter never passes `--oss`/`--profile`). Gemini
    CLI: no local path, stated plainly. Honest model table (qwen3-coder 30B
    ≈24 GB as the default pick; 7–8B expect misfires → Step 1.4 fallback) +
    context-length floors (32K Claude Code / 64K Codex,
    `OLLAMA_CONTEXT_LENGTH`). One wart documented for L.2: Codex liveness
    keys on `OPENAI_API_KEY`/`auth.json`, so a config-only local setup needs
    a dummy `OPENAI_API_KEY=local` — L.2's detection should remove it.
    Claims verified against docs.ollama.com (anthropic-compatibility,
    integrations/codex), developers.openai.com codex config reference, and
    lmstudio.ai; code paths verified in `adapters/index.ts` + `codex.ts`.
    **Done-when verified live later the same day (2026-07-07):** Ollama
    0.31.1 installed on this CPU-only ThinkPad T480; Path A followed as
    written in headless Chrome — onboarding showed Claude Code "ready" off
    `ANTHROPIC_BASE_URL` alone, a real typed turn drove qwen3-1.7b through
    Ollama's Anthropic endpoint, and the model's thinking stream rendered
    live in the transcript (~25 min: honest CPU prefill of Claude Code's
    measured ~26K-token agent surface at single-digit tok/s). Doc updated
    with what the run taught: the user-space `num_ctx` Modelfile route
    (replacing the sudo-needing `OLLAMA_CONTEXT_LENGTH` advice in Path A),
    a "CPU-only reality" section with the measured numbers, and a
    fits-in-RAM warning (18 GB qwen3-coder does NOT fit a 16 GB machine —
    it hangs loading rather than failing fast). 8B-on-CPU is impractical
    (~1 h/turn); 30B+ needs the GPU-class hardware the table now says.

---

## Phase K / Q — completed steps (moved 2026-07-15 to lean out PLAN.md)

Moved here from PLAN.md 2026-07-15, same convention as the R / F / L
section above: PLAN.md keeps a one-line pointer per step; the full text is
preserved verbatim below, in original order. Nothing was dropped — only
relocated. (Phases K and Q themselves are still OPEN — these are their
completed steps only.)

- [x] **Step K.1 — Open the relay (decision executed)** — done 2026-07-15
  (status note below)
  - Goal: `genui-relay` becomes public MIT alongside the shell — one
    licensing story across the product, and "fully open source" becomes a
    true marketing claim.
  - Build: swap the relay's `UNLICENSED` for MIT (LICENSE file +
    `package.json` `license` field; copyright line = the K.2 entity once it
    exists, Kyle personally until then); a README pass removing the
    closed-source framing; the repo flips public **per R.5b's written
    release order**, not ad hoc. When the flip lands, update the umbrella
    docs (`../CLAUDE.md` open-core paragraph, `../ROADMAP.md`) — dated
    amendments already mark the decision there. Until the flip, the repo
    stays private and the existing don't-leak-relay-specifics rule holds.
  - Done when: the relay repo carries MIT, R.5b's release sequence names the
    moment it goes public, and no doc still claims the open-core split.
  - Status (2026-07-15): DONE. `genui-relay` relicensed — `LICENSE` (MIT,
    same copyright line as the shell's; entity swap owed to K.2/K.8) +
    `package.json` `license: "MIT"` (`private: true` kept — it's the
    don't-publish-to-npm flag, orthogonal to source license); README
    blockquote + ARCHITECTURE.md §6 rewritten for the open state (self-host
    expected; sold thing = the hosted instance). Shell-side docs reconciled:
    R.2's "closed source" build text amended, BUSINESS.md §5/§6 updated
    (§6(2)(c) "relay naturally closed" reversed), and **the public-flip
    moment is seeded into R.5b's decide-list (b)** — the flip itself
    executes there, not here. Relay standalone suite 20/20 after the
    package.json edit. The repo REMAINS PRIVATE until R.5b/R.7 flips it.

- [x] **Step K.3 — Provider-terms re-verification** — done 2026-07-15
  (status note below) *(assistant:
  investigate — thoroughly, against current primary sources)*
  - Goal: every row of `server/provider-policy.ts` cites a current, quotable
    document before launch; the code matches the verified matrix.
  - The question to settle (2026-07-15): the OpenAI row had no specific,
    current primary source pinned for Codex/ChatGPT sign-in in third-party
    harnesses. Investigate all three rows against primary sources; also
    re-verify the Anthropic row (re-confirmed 2026-07-15: the Feb 2026
    consumer-terms clarification stands) and the Google row; re-date the
    file's header comment either way.
  - Done when: each row cites a named, dated source; the code matches; and a
    launch-week matrix re-check is an explicit line item on R.7 (all three
    providers moved within six months — assume they move again).
  - Status (2026-07-15): DONE — every row pinned to a dated primary
    source. Findings, per row: **Anthropic** — ban re-confirmed, now pinned
    verbatim to the Claude Code docs "Legal and compliance" page ("Anthropic
    does not permit third-party developers to offer Claude.ai login or to
    route requests through Free, Pro, or Max plan credentials on behalf of
    their users"). **Google** — stronger than a terms question now: Gemini
    CLI stopped serving individual accounts (free/AI Pro/AI Ultra)
    2026-06-18 per the official google-gemini/gemini-cli discussion #28017;
    API-key use continues under the Gemini API ToS. Side-finding logged into
    R.6: **Antigravity CLI** announced as Gemini CLI's successor —
    adapter-impact check added there. **OpenAI** — no written general
    permission exists (the Codex auth docs are silent; a Codex maintainer
    deferred to the general ToS when asked directly, openai/codex discussion
    #8338), while the demonstrated public posture is visibly permissive
    (Altman's 2026-05-02 OpenClaw sign-in tweet, reported non-enforcement) —
    posture, not permission. Settled same day (Kyle's call) as the standing
    **disclosed-uncertainty rule** (see the phase header + the canonical
    statement in `server/provider-policy.ts`): the codex row is allowed
    LOCALLY as a disclosed gray area. The two clean-making conditions hold
    in code: (1) the codex CONNECT_HINT states uncertainty, never permission
    ("not clearly permitted by OpenAI's terms, tolerated in practice; your
    account, your call") — unit + e2e tests pin both the caveat and the
    absence of any "OpenAI permits" claim; (2) graceful degradation stays
    ready — the codex BLOCKED_HINT is kept current though unused, so a
    policy change is a one-line flip. The relay refusal is untouched
    (absolute bound). Code + copy landed: `provider-policy.ts` (header
    rewritten with per-row citations), its test, `agents-meta.ts`, adapter
    comments, e2e expectation; R.4k's "could change" disclosure updated.
    Docs reconciled: PLAN Auth decision + R.4l(4), CLAUDE.md (both repos' +
    umbrella), BUSINESS.md §2 passage, `.env.example`, site FAQ + site
    CLAUDE copy rule. R.7 gained the launch-week matrix re-check; R.6 gained
    the Antigravity succession check. Verified: `yarn typecheck` + Tier 1
    (159) + Tier 2 (74) + Tier 3 (20), all green, twice; site re-rendered
    headless at 1280w. Documented in the policy header: the row is
    re-examined on any written, general OpenAI statement either way.

- [x] **Step K.8 — Dependency license scan** — done 2026-07-15 (status
  note below) *(assistant)*
  - Goal: nothing copyleft ships in either repo's distributed artifacts.
  - Build: run a license scan (`npx license-checker --production` or
    equivalent) over both repos; record the dated output in this step's
    status note; fix or replace anything GPL/AGPL-shaped in a shipped path
    (the React/Vite ecosystem is near-uniformly MIT/Apache — this is a
    ten-minute verification, but verify). Confirm both LICENSE files carry
    the K.2 entity's copyright line once it exists.
  - Done when: the recorded scan shows permissive-only production trees.
  - Status (2026-07-15): DONE — **no copyleft in either production tree.**
    `license-checker --production` results: **genui-shell** — 86 MIT, 7 ISC,
    3 Apache-2.0, 2 BSD-3-Clause, 1 BSD-2-Clause, plus 3 flagged "Custom"
    that are the Anthropic Agent SDK and its two platform sub-packages
    (`@anthropic-ai/claude-agent-sdk*@0.3.201`): **proprietary** — "© 
    Anthropic PBC. All rights reserved. Use is subject to the Legal
    Agreements…" — not copyleft, consumed as an ordinary npm dependency,
    never vendored or modified; fine to depend on, but MIT doesn't cover it,
    so README §12 (new) states the engine-license picture plainly
    (`@openai/codex-sdk` = Apache-2.0; Gemini CLI = not a dependency, the
    adapter spawns the user's own `gemini` binary). **genui-relay** — `ws`
    (MIT) is the entire production tree; the scan's UNLICENSED hit was the
    repo's own stale `package-lock.json` root metadata from before K.1's
    relicense — resynced via `npm install --package-lock-only`, now MIT
    throughout. Still owed (to K.2, not this step): swap both LICENSE
    copyright lines from Kyle personally to the entity once it exists.

- [x] **Step K.9 — Contributor policy, decided before the repos go public**
  — done 2026-07-15 (status note below)
  - Goal: incoming-contribution IP settled before contributor #1 — adding a
    CLA after contributors exist is nearly impossible.
  - Decide: DCO vs. CLA. Recommended: **DCO** — with K.1, everything is MIT
    with no relicensing intent, which removes a CLA's main benefit; the DCO
    (`Signed-off-by` + the GitHub DCO check) documents provenance at
    near-zero contributor friction. Record the choice in R.5b; add
    `CONTRIBUTING.md` to both public-bound repos noting it.
  - Done when: the decision is written in R.5b and CONTRIBUTING.md exists in
    both repos.
  - Status (2026-07-15): DONE — **DCO adopted** per this step's own
    recommendation (everything is MIT with no relicensing intent, which
    removes a CLA's main benefit; DCO documents provenance at near-zero
    contributor friction). Recorded in R.5b's decide-list (new item (e)).
    `CONTRIBUTING.md` landed in both repos, each in its own voice: the
    shell's covers `git commit -s`, the three test tiers, and the CLAUDE.md
    non-negotiables; the relay's pins the caps-and-refusals suite and the
    stays-deliberately-dumb rule. The GitHub DCO status check itself is
    enabled as part of the public flip (R.5b/R.7 mechanics, not before).

- [x] **Step K.11 — Export-control sanity note** — done 2026-07-15 (status
  note below) *(assistant; expected
  conclusion: no action required)*
  - Goal: a written, dated paragraph closing the question instead of leaving
    it ambient.
  - Investigate: the shell's E2E layer calls platform WebCrypto rather than
    implementing cryptography, and publicly available open-source software
    using standard crypto sits in the EAR's publicly-available carve-out
    (post-2021, generally without even the old BIS email notification).
    Verify that reading is current; write the one-paragraph conclusion into
    the repo (docs/ or this step's status). Optional belt-and-suspenders: the
    five-minute BIS/NSA notification email with the public repo URL at R.7.
  - Done when: the dated note exists with the conclusion.
  - Status (2026-07-15): DONE — the dated note, verified against the
    current eCFR text of 15 CFR §742.15(b): **no action required.** The
    E2E layer calls platform WebCrypto exclusively
    (`server/relay/relay-crypto.ts`: AES-256-GCM + HKDF-SHA-256 via
    `crypto.subtle`; the entitlement token is standard Ed25519
    verification) — *standard cryptography* in the EAR's sense, nothing
    homegrown. BIS's 2021-03-29 final rule eliminated the email
    notification for publicly available encryption source code using
    standard cryptography: such code is released from the EAR the moment
    it is published online (the crypt@bis.doc.gov / enc@nsa.gov notice
    survives only for *non-standard* cryptography). So the R.5b/R.7 public
    flip itself completes the compliance story; the optional
    belt-and-suspenders email adds nothing and is skipped. Revisit only if
    the crypto ever stops being platform-standard — which the architecture
    forbids anyway.

- [x] **Step K.12 — Compliance closure notes (from the 2026-07-15 sweep)**
  — done 2026-07-15 (status note below)
  *(assistant; expected conclusion for each: no action required — write it
  down, dated, so the questions stop being ambient)*
  - Origin: a 2026-07-15 second-pass compliance sweep (GDPR operational
    mechanics + the adjacent EU regimes), verified against current primary
    sources and the actual code, all four test tiers green the same day.
    The actionable findings landed elsewhere: dated amendments on K.4 (FTC
    rule vacated → ROSCA/state-ARL citation) and K.5 (AUP line, the two
    subprocessor DPAs, Paddle-as-independent-controller, breach one-pager);
    the EU/UK representative bundle is parked below with a revenue trigger.
    This step closes the checked-and-clear regimes in writing.
  - Build: one dated note (docs/ or this step's status), a short paragraph
    each: **EU AI Act** — Mirafold is neither provider nor deployer of the
    model (the user runs their own agent locally on their own credentials;
    Mirafold ships an open-source UI and sells transport of ciphertext);
    coding assistance is not an Annex III high-risk use; the faithful-skin
    rule means no rebranding, so no Art. 25 requalification into provider.
    **European Accessibility Act** — the service-provider microenterprise
    exemption (<10 persons and ≤€2M turnover) covers the entity; the
    checkout UI is Paddle's; revisit trigger = outgrowing either bound.
    **ePrivacy/cookies** — verified 2026-07-15: no cookies, no external
    loads, no analytics anywhere; browser storage is strictly-necessary
    functional state (theme, relay session code); no consent banner owed.
    Plus one-liners closing: ECPA/wiretap (the relay carries the user's own
    traffic with their consent, E2E-encrypted), OFAC (Paddle screens
    payments as MoR; the free product is publicly available open source),
    and money-transmission/telecom licensing (no funds handled; no
    interpersonal communications service — single-user device pairing).
  - Done when: the dated note exists and each paragraph states its basis.
  - Status (2026-07-15): DONE — this status note IS the dated closure note;
    each conclusion states its basis. **EU AI Act — no obligations.**
    Mirafold is neither provider nor deployer of an AI system in the Act's
    regulated sense: the user runs their own agent, locally, on their own
    credentials; Mirafold ships an open-source UI and sells transport of
    ciphertext. Coding assistance is not an Annex III high-risk use, GPAI
    obligations sit with Anthropic/OpenAI/Google as model providers, and
    the faithful-skin rule (no rebranding, ever) is precisely the conduct
    that avoids Art. 25 requalification into a provider. **European
    Accessibility Act — exempt.** The EAA (in force for services
    2025-06-28) covers e-commerce services, but its microenterprise
    exemption (<10 persons AND ≤€2M turnover, Art. 3(23); services only)
    covers the entity; the checkout UI is Paddle's, carrying Paddle's own
    duty. Revisit trigger: outgrowing either bound. **ePrivacy/cookies —
    nothing owed.** Verified in code and live 2026-07-15: mirafold.com
    sets no cookies (no `set-cookie`; strict CSP `default-src 'none'`;
    all assets self-hosted; the only JS is a clipboard handler), no
    telemetry or analytics exists anywhere in shell, site, or relay, and
    the app's browser storage (theme in localStorage, relay session code
    in sessionStorage) is strictly-necessary functional state — no consent
    banner, no cookie policy needed beyond a truthful sentence in the K.5
    privacy policy. **One-liners:** ECPA/wiretap — the relay carries the
    user's own traffic between their own devices with their consent,
    E2E-encrypted (no interception exposure); OFAC — Paddle screens
    payments as merchant of record, and the free product is publicly
    available open source (same public-availability logic as K.11);
    money-transmission/telecom licensing — not applicable (no funds
    handled; single-user device pairing is not an interpersonal
    communications service).

- [x] **Step Q.2 — Freeze the wire protocol in executable form** — done
  2026-07-12. `server/protocol.test.ts`: a mapped-type golden-fixtures test with
  two teeth. COMPILE-TIME (the `yarn typecheck` commit gate) — `WIRE` and
  `CLIENT` are `{ [T in WireMsg["type"]]: Extract<WireMsg, { type: T }> }` maps,
  so they require exactly one fixture per `type` discriminant: 22 WireMsg + 13
  ClientMsg variants, plus standalone `SessionMeta` and all three `Action`
  fixtures. RUNTIME (`yarn test`) — every fixture round-trips through
  JSON.stringify→parse byte-for-byte (no undefined/function drift), its runtime
  `type` matches its key, and the nested/security-sensitive shapes (agents row,
  relay block, SessionMeta key set, permission_response, the ephemeral
  bang_input) are pinned by deepEqual. **Both teeth verified by experiment:**
  adding a new WireMsg type without a fixture → `TS2741 Property … missing in
  WireByType`; renaming `text_delta.text`→`content` → loud errors across every
  adapter and the fixture. So adding a message type forces a NEW fixture and
  touches no existing one; reshaping an existing frame can't pass the build.
  Complement to R.4h (which pins how the ends treat UNKNOWN messages) — this
  pins the exact shape of the known ones. 150 Tier-1 tests pass; typecheck
  clean. Files: `server/protocol.test.ts` (new).

- [x] **Step Q.3 — Ring-buffer eviction and the resume boundary** — done
  2026-07-12. Five Tier-1 tests in `server/registry.test.ts`, driven directly
  against `SessionRegistry` with a `live:false` mock backend (the inert
  MockSession — no daemon, no network, nothing emitted until a prompt), calling
  `broadcast`/`canResume`/`attach` by hand. Pinned: (1) after `PUSH = cap+500`
  broadcasts the ring is bounded at EXACTLY `BUFFER_CAP` (absolute value
  asserted, not derived — a ±1 fails) and holds the newest window, contiguous by
  seq, oldest evicted; (2) a late attach with no `afterSeq` replays exactly that
  window in order; (3) `canResume` is true at `firstBuffered-1` and false at
  `firstBuffered-2` — the exact evicted edge — plus range guards (saw-latest,
  never-issued, negative, non-integer); (4) a post-eviction tail resume replays
  exactly the seqs `> afterSeq` from both the edge and mid-window; (5) an
  un-evicted small buffer resumes from seq 0. **Verified the assertions bite by
  mutation:** `canResume` edge → `firstBuffered` (too strict) and
  `firstBuffered-2` (too lenient), and the eviction splice keeping `cap+1`, each
  fail the matching test; all revert green (155 Tier-1 pass, typecheck clean).
  `BUFFER_CAP` (module-private) is mirrored in the test with a sync note — the
  mirror is what lets a cap off-by-one fail. Files: `server/registry.test.ts`
  (extended; was `resolveCwd`-only).

- [x] **Step Q.4 — Hostile-client sweep of `connection.ts`** — done 2026-07-12.
  New `server/hostile-client.itest.ts` (2 Tier-2 tests, real daemon + real
  sockets): every `ClientMsg` case swept with wrong-typed/missing fields and raw
  garbage, mid-session, with a SECOND viewport on the same session asserting no
  garbage frame leaks a broadcast; then a valid turn completes (socket survived,
  session not torn down by the end_session garbage). A sentinel `ping`/`pong`
  after the barrage proves every frame was processed; the daemon log is asserted
  free of the last-gasp crash line. **The sweep found two real bugs, both
  fixed in `connection.ts` (the one product change this step needed):** (1) a
  raw frame parsing to `null` (or a bare number/string) has no `.type`, and
  `null.type` THREW — on the local WS path (`index.ts` wraps `handleMessage` in
  no try/catch) that hit the uncaughtException handler and `process.exit(1)`,
  so any local viewport could crash the whole daemon; added a non-object guard
  mirroring the malformed-JSON reply (the relay path already had a try/catch, so
  only the local path was exposed). (2) the bang-id guard used
  `!/…/.test(String(msg.id))`, coercing a missing/numeric id (`"undefined"`,
  `"123"`) into a value that passed the regex and LAUNCHED a bang with a bad
  correlation id — tightened to require `typeof msg.id === "string"` first. Both
  fixes verified to bite by reverting each (null → daemon crash fails the sweep;
  bang-id → missing-id bang leaks a `bang_start` to the 2nd viewport). Full
  suites green: Tier 1 155, Tier 2 74; typecheck clean. Files:
  `server/hostile-client.itest.ts` (new), `server/connection.ts` (two guards).

- [x] **Step Q.5 — Pin the `.env` guard's edges** — done 2026-07-12. Three
  Tier-1 tests added to `server/permissions.test.ts`, each across all four
  guarded readers (Read/NotebookRead/Grep/Glob): (1) an absolute path to the
  daemon's `.env`/`.env.local` denies; (2) a `sub/deeper/../../.env` traversal
  that resolves onto `<cwd>/.env` denies; (3) cross-cwd (session running in a
  different dir than the daemon launched) — both an absolute path and a relative
  traversal back to the daemon's env deny, while the session's OWN dir `.env`
  stays out of scope (allowed), pinning that the guard protects the daemon's
  secrets specifically. Verified non-vacuous: weakening the guard to a naive
  raw-string match (dropping `path.resolve`) fails the traversal and cross-cwd
  tests. 158 Tier-1 pass, typecheck clean. (Symlink bypass remains the
  documented accepted residual — out of scope.) Files:
  `server/permissions.test.ts`.

---

## Step R.2 — status history (condensed out of PLAN.md 2026-07-10; step still OPEN)

The R.2 box is still open (Kyle owes a Fly credit card + owned domain +
the cellular-phone pass). PLAN.md keeps a condensed current-state + owed
list; the full chronological deploy log is preserved verbatim below.

  - Status: **sequencing (a) — write + verify locally — DONE (2026-07-08);
    (b) Kyle's signups and (c) deploy remain, so the box stays open.** The
    service lives at `relay-service/` (the seed of the standalone private
    `genui-relay` repo; not in the npm `files` list, won't publish). It's a
    dependency-light (`ws` only) portable Node process — the stub's shape
    grown up: `src/relay.ts` (`startRelay`), `src/limits.ts` (the env-tuned
    DoS caps), `src/contract.ts` (the routing envelope, VENDORED — a
    sync-guard test fails if it drifts from `server/relay-protocol.ts`),
    `src/main.ts` (SIGTERM-draining entrypoint), plus `Dockerfile`,
    `fly.toml` (single instance, `/health` check, `auto_stop_machines=false`),
    `tsconfig.json`, `README.md`. Hardening beyond the stub: global
    connection cap, max-pairs, per-pair viewport cap (independent of the
    daemon's own remote-viewport cap — defense in depth), per-connection
    frame rate limit (flood → drop), ws heartbeat reaper, max payload,
    `GET /health` and 404-everything-else. **Trust decision made and
    documented** (README "the trust decision"): the relay is a PURE
    forwarder and serves NO app bundle, so it structurally can't inject
    page JS that steals the pairing code from the URL fragment — the phone
    loads the app from a SEPARATE static origin (the R.5 landing host) and
    only then opens the encrypted socket. The tunnel-through-daemon
    alternative is noted as held in reserve (R.4h's tolerant schemas make
    the static-origin path's version skew survivable). Version-bump =
    "wrong pairing code" is a README line. Verified: `server/relay-service.
    itest.ts` (9 tests, Tier 2) runs the REAL daemon dialed at the REAL
    service — full remote turn + byte-for-byte local mirror, health/404,
    short-id + taken-id + unknown-id refusals, global cap, per-pair cap,
    rate-limit drop, heartbeat-doesn't-kill-healthy, and the contract
    sync-guard; the standalone package also `npm install && npm run build`s
    on its own NodeNext tsconfig and the compiled `dist/main.js` serves
    `/health` and drains on SIGTERM (checked, artifacts not committed). The
    R.1/R.3 crypto + ciphertext-only properties already hold against the
    stub (relay.itest.ts, whose `RemoteClient` moved to the shared
    `server/relay-test-client.ts`). Owed to (c): Kyle's Fly.io account +
    owned domain, then `fly deploy` + `fly certs add` + point
    `GENUI_RELAY_URL=wss://relay.<domain>`; the cellular-phone Done-when is
    R.6's real-hardware check. **2026-07-08 (later): the standalone private
    repo now EXISTS** — `~/Projects/genui-relay`, pushed to the private
    GitHub repo `kserrec/genui-relay`. It adds what only the split repo can
    hold: an 11-test self-contained suite (node:test + tsx, raw ws clients —
    routing, refusal codes, every cap), `scripts/smoke.mjs` (post-deploy
    go/no-go: health over HTTPS, pair + byte-identical round-trip, bogus-id
    refusal against the LIVE relay), `DEPLOY.md` (the command-by-command
    deploy-day runbook, incl. day-2 ops + rollback), committed lockfile +
    `npm ci` Dockerfile, and `npm run sync` / `sync:check` back to
    `relay-service/` (which stays dev source of truth until first deploy —
    the itest still verifies it against the real daemon). Standing up that
    suite immediately caught and fixed a real pre-deploy crash: `ws` emits
    `'error'` on a protocol-violating frame (e.g. oversize), no handler was
    attached, and the unhandled `'error'` would have hit main.ts's
    `uncaughtException` → exit(1) → every live pairing dropped by one
    hostile frame. Fixed in `relay-service/src/relay.ts` (`guard()` on every
    accepted socket, synced to the repo); the oversize-frame test now pins
    sender-dies-relay-lives. All suites re-verified: 11/11 standalone, 9/9
    relay-service.itest, Tier-1 + typecheck green in both repos.
    **2026-07-08 (later still): DEPLOYED — sequencing (b) and (c) are
    substantially done.** Kyle signed up for Fly.io + installed flyctl;
    `fly apps create genui-relay` + `fly deploy` succeeded; app lives at
    `genui-relay.fly.dev` (TLS via the platform). Two deploy-day lessons
    folded into DEPLOY.md + fly.toml: (1) Fly's first deploy creates TWO
    machines by default (`--ha=false` avoids; pair affinity needs exactly
    one — fixed live with `fly scale count 1`); (2) the trial account stops
    machines after 5 min until a credit card is added (Kyle's next action).
    Verified against production: `npm run smoke -- wss://genui-relay.fly.dev`
    PASS, and a REAL daemon (mock session) dialed out, completed the E2E
    handshake, and streamed a full 74-frame turn (incl. `render`) to a
    `RemoteClient.connectUrl` viewport — plus `fly logs` shows ONLY
    connection metadata ("daemon paired (1 pair(s), 1 conn)"), no frame
    contents, no pair ids: the "learned nothing" Done-when criterion,
    observed. Still open before the box closes: Kyle's credit card (else
    machines stop), the owned domain + `fly certs add relay.<domain>`
    (launch-gating: daemons must bake OUR name, never fly.dev), and the
    cellular-phone pass (R.6 real-hardware check — also needs the app-serving
    static origin, which is R.5's landing host).
    **2026-07-08 (later still): security audit of the deployed relay — one
    fix landed here, two deferred by design.** Finding #1 (real, ship-time):
    the relay capped total sockets/pairs but nothing per source, so one host
    could open thousands of quiet connections (each just answering pings to
    dodge the reaper) to eat the whole global budget, or squat every pair
    slot with junk daemons — the per-*connection* frame-rate limit can't stop
    it (the attack is many idle connections, not one noisy one); the "same
    DoS posture as the daemon" note assumed a localhost-only listener, which
    the public relay is not. FIXED: `RELAY_MAX_CONNECTIONS_PER_IP` (default
    64, 0 disables) keyed on a trusted `RELAY_CLIENT_IP_HEADER`
    (`fly-client-ip`, set in fly.toml — the socket address is Fly's shared
    proxy) with the same clean-refuse shape; two standalone tests (socket-IP
    cap + header-keyed cap that frees on close). Finding #2 (Origin allowlist
    on viewport upgrades) → R.5 (needs that step's static origin domain).
    Finding #3 (pairId squat against a specific victim) → theoretical, no
    action (128-bit codes, pairId only over wss). Audit-verified clean: no
    secrets, `ws` 8.21.0 no CVEs, unprivileged container, E2E-blind confirmed
    in code, and no crash-via-send path (every `ws.send` is OPEN-guarded with
    no async gap, and send-on-closing is silent in ws — checked the source).
    All suites re-green: 13/13 standalone, 9/9 relay-service.itest, typecheck
    both repos.

---

## Moved 2026-07-17 (third lean-out pass — verbatim originals)

Each block below is the full PLAN.md text as it stood 2026-07-17, moved
whole. In the live plan, done steps keep a one-line `[x]` pointer and
still-open steps (K.4, R.2, R.4) keep a compact stub with their open
items — this section holds their full bodies and status histories.

### Step 4.11 — Cockpit polish batch (done 2026-07-16)

- [x] **Step 4.11 — Cockpit polish batch (unplanned, Kyle-driven)** — done
  2026-07-16, all e2e-covered (suite grew 24→26). Status bar regrouped: home ⌂
  + end anchor the far LEFT as the session-lifecycle pair (leave it / kill it),
  the connection dot stays glued to the agent text, settings/theme cluster
  keeps the right; gear and end sized to match the pill/home (34px). The
  prompt-bar cwd is collapsible: click the path → just the ❯ caret; the caret
  toggles it back; persisted (`mirafold-prompt-cwd`); the left-side ellipsis
  behavior kept. Fleet rows dropped the cwd column for breathing room — it
  survives as the row's native hover tooltip — and the new-session card
  dismisses on backdrop click / Esc, only when a fleet exists behind it (first
  run keeps the picker, it IS the page). Theme pill untouched (LOCKED).

### Step K.4 — Merchant-of-record billing (still OPEN — full body + status history)

- [ ] **Step K.4 — Merchant-of-record billing** *(decision 2026-07-15:
  outsource tax/compliance)* — 🟡 investigation done 2026-07-15, **Paddle
  recommended** (checklist in the status note); box open only on Kyle's
  account creation (under the K.2 entity) + his confirm of the pick
  - Goal: US state sales tax, EU VAT (which applies from the **first** B2C
    euro for a non-EU seller — no threshold), the FTC Negative-Option
    ("click-to-cancel") disclosure/consent/reminder mechanics, and the EU
    14-day withdrawal-right waiver all become the vendor's problem, traded
    for a bigger per-transaction fee.
  - Investigate: Paddle vs. Lemon Squeezy (Stripe + Stripe Tax stays the
    fallback if no MoR meets requirements). Hard requirements from BUSINESS
    §7 + R.5, each verified in writing against the vendor's current docs:
    card-required 7-day trial; cancel-at-period-end with no refund path;
    $12/mo · $99/yr pricing; a subscription-lifecycle webhook the minting
    backend can consume to mint/expire the Ed25519 entitlement token;
    checkout linkable from a static page; trial-conversion reminder and
    easy-as-signup cancellation handled by the vendor.
  - Then: rework R.5's build half (checkout → webhook → minting) for the
    chosen vendor — the relay-side entitlement check is untouched — and
    re-point the site PLAN's checkout-button blocker.
  - Done when: vendor chosen with the requirement checklist recorded, R.5's
    body rewritten for it, and the account exists under the K.2 entity.
  - **Status (2026-07-15): INVESTIGATION DONE — recommendation: PADDLE.**
    Only the account creation remains (Kyle, under the K.2 entity — the box
    stays open on that alone). The requirement checklist, verified against
    Paddle's current docs:
    - card-required 7-day free trial: ✅ native (Paddle's "card-required
      free" trial type; their help center explicitly covers trial
      compliance — the FTC negative-option disclosure/consent/reminder
      mechanics are the MoR's job);
    - cancel-at-period-end, no refund: ✅ native (a scheduled change; the
      Paddle-sent emails carry a cancellation link and access holds through
      the paid period — exactly BUSINESS §7's design);
    - $12/mo · $99/yr: ✅ arbitrary monthly + annual prices;
    - lifecycle webhooks for entitlement minting: ✅ signed webhooks
      (`subscription.trialing` / `.activated` / `.updated` / `.canceled`),
      and Paddle's subscription statuses are literally `trialing`/`active` —
      the R.5 entitlement rule ("admit when trialing OR active") maps
      verbatim;
    - checkout from a static page: ✅ hosted checkout links + a Paddle.js
      overlay (works on the no-build mirafold.com);
    - tax: ✅ merchant of record — global VAT/sales-tax collection and
      remittance are Paddle's, which is the entire point (K.4's premise:
      EU VAT applies from the first B2C sale).
    Fees: 5% + 50¢ — the "small fee for convenience" trade, accepted.
    The rest of the 2026 field, and why not them: **Lemon Squeezy** is in
    migration limbo (Stripe acquired it; users being funneled to Stripe
    Managed Payments) — excluded. **Stripe Managed Payments** (Stripe's own
    MoR) is still beta/invite-only in mid-2026 and effectively ~6.4% + 30¢
    all-in — can't launch on a beta; noted as a possible future migration
    since its transaction-level MoR is attractive and the entitlement design
    is vendor-agnostic. **Polar** is the runner-up (developer-first, open
    source, card-captured trials with auto-conversion + reminders, clean
    signed webhooks) but repriced to ~5% + 50¢ in 2026 — fee parity with
    Paddle — and is a much younger company;
    for the revenue-critical path, Paddle's decade of MoR track record wins
    at the same price. **Creem** (3.9% + 40¢ sticker) is the youngest —
    excluded for the same reason.
    **Sequencing note (important):** Paddle verifies the merchant's website
    before allowing live sales, and that review expects ToS/privacy/pricing
    pages — so the order is K.2 (entity) → K.5 pages live on mirafold.com →
    Paddle account + site verification (sandbox account can start any
    time) → R.5 build. Start the Paddle signup early; verification takes
    days, not minutes.
  - **Amendment (2026-07-15, compliance sweep):** the FTC Negative-Option
    ("click-to-cancel") Rule this step's goal cites was **vacated in its
    entirety by the Eighth Circuit 2025-07-08** (the FTC restarted the
    rulemaking with a 2026-03 ANPRM). Conclusion unchanged, citation
    corrected: the same disclosure/consent/easy-cancel mechanics remain
    required by **ROSCA** (the underlying federal statute, still enforced)
    and state auto-renewal laws (California's ARL et al.), and they remain
    the MoR's job — Paddle's trial-compliance handling covers the statutes
    that survive, not just the vacated rule.
  - **Update (2026-07-16): Paddle account CREATED — as an individual/sole
    trader, NOT under an entity** (K.2 deferred; see its 2026-07-16
    amendment). Pick confirmed: Paddle. Signed up as individual/sole trader
    (identity verification only — no business verification for sole traders);
    Kyle's ID verification in progress on Paddle's side. **Sequencing
    corrected — entity is no longer a prerequisite:** the order is now K.5
    pages live (✅ done) → Paddle **website verification** (next action:
    Checkout → Website approval, submit mirafold.com; review expects
    ToS/privacy/refund/contact/pricing pages — all now live) → R.5 build.
    Remaining for K.4: pass website verification, then the R.5
    checkout → webhook → entitlement-minting build.
  - **Update (2026-07-17): website verification SUBMITTED; account
    verification found NOT STARTED.** `mirafold.com` submitted under
    Checkout → Website approval (bare domain; the form rejects a
    scheme-prefixed URL as "invalid domain name") — dashboard-verified
    showing **Pending** at `/request-domain-approval`. **Correction to the
    2026-07-16 note above:** the dashboard shows account verification
    (Paddle's KYC — personal details incl. DOB/home address, business
    details, website link, product descriptions; ~10 min form) as **Not
    started** — no ID verification was actually in progress from signup.
    Its website-readiness checklist is already met (ToS/privacy/refunds
    live, contact reachable, on-site pricing). **Account verification
    COMPLETED + submitted same day** (sole-trader business profile, trading
    name Mirafold — Paddle handles tax as MoR; pricing URL is the homepage
    anchor `mirafold.com/#pricing`, no standalone page) — dashboard shows
    **in review**. K.4's box now waits
    only on Paddle's two reviews (domain + account), then the R.5 build;
    payout/bank details remain an anytime-before-revenue dashboard item.

### Step K.5 — ToS + Privacy Policy (done except the K.2-trigger tail)

- [ ] **Step K.5 — Terms of Service + Privacy Policy (from a written data
  inventory)**
  - Goal: the two user-facing legal documents exist, are published, and are
    *true* — which for this product is a strength: the honest answer is
    "almost nothing," so write it down and lean into it.
  - Build, in order: (1) a **data inventory** — exactly what the relay, the
    site, and the billing vendor see and retain, and for how long (relay:
    IPs, pairing ids, connection timing, byte counts — never plaintext
    content; site: Cloudflare logs; billing: vendor-held card/name data).
    Deliberately minimize relay/site logging and write the retention down —
    what isn't retained can't be breached or subpoenaed. The inventory feeds
    both documents AND K.6's marketing wording. (2) **ToS**: warranty
    disclaimer; liability cap at fees paid + exclusion of consequential
    damages (the primary shield for the remote-execution liability);
    acceptable use; a user-responsibility-for-provider-terms clause (pairs
    with K.3 — Mirafold enforces known restrictions but doesn't warrant the
    user's standing with any provider, and where terms are uncertain the
    disclosed-uncertainty rule applies: the product disclosed it, the user
    chose it); age line (18+, or 13+ with capacity
    to contract); governing law; the K.4 trial/cancellation mechanics.
    (3) **Privacy policy**: the inventory verbatim, subprocessors named
    (Fly.io, Cloudflare, the billing vendor), GDPR-shaped rights handling
    (an IP address alone is personal data — one EU customer makes us a
    controller; minimal data keeps the document short, not optional).
    Publish both as pages on mirafold.com (site PLAN S.6), linked from the
    footer and the checkout flow. Kyle's call: 1–2 hours of a real lawyer's
    review before launch (recommended — this step and K.2 are the one place
    it's worth buying); a quality startup-standard template is the floor.
  - Done when: both pages are live (or staged into the R.5b release order),
    every sentence in them traces to the inventory, and the K.2 entity is
    the named party.
  - **Amendment (2026-07-15, compliance sweep — four additions):** (a) the
    ToS acceptable-use clause states explicitly: **pair with and control
    only systems you own or are authorized to access** — the CFAA-adjacent
    line; the pairing architecture already enforces it, the words make it
    contractual. (b) Naming subprocessors in the policy is not the GDPR
    Art. 28 instrument — **execute the self-serve DPAs** with Fly.io
    (pre-signed, fly.io/documents) and Cloudflare
    (cloudflare.com/cloudflare-customer-dpa) under the entity's accounts
    (Kyle's hands, minutes, free; both vendors are Data Privacy Framework
    certified, which settles EU→US transfers). (c) **Paddle is named as an
    independent controller**, not a subprocessor — as merchant of record
    the buyer contracts with Paddle, and its standard Data Sharing Addendum
    governs the controller-to-controller leg; no processor DPA exists or is
    needed there. (d) A one-page **breach-notification plan** drafted from
    the inventory (GDPR's 72-hour authority clock + US state statutes;
    realistic breach surface = relay/hosting metadata or Paddle-side data —
    plaintext content cannot breach server-side because it never exists
    there). Note: the dated inventory doubles as the GDPR Art. 30 record of
    processing — keep it current and one artifact serves both. Code-verified
    same day for the inventory's benefit: the relay process holds client IPs
    in memory only (per-IP caps) and writes none to its logs — IP retention
    exists only at the Fly.io proxy layer; no telemetry/analytics anywhere
    in shell, site, or relay; mirafold.com sets no cookies (strict CSP,
    self-hosted assets only), so no ePrivacy consent banner is owed.
  - **Status (2026-07-16): PAGES LIVE on mirafold.com.** Four pages published
    (site PLAN S.6, extended beyond ToS+Privacy to add **contact + refund**
    pages Paddle's website verification requires): `/terms`, `/privacy`,
    `/refunds`, `/contact` — all 200, footer legal-link row on every page.
    Privacy Policy written from the real data inventory (E2E-blind relay; the
    relay holds client IPs in memory only and writes none to its logs; no
    cookies/analytics; **Paddle named as an independent controller**, not a
    subprocessor). Named party: **Kyle Serrecchia d/b/a Mirafold** (pre-LLC);
    governing law California. ToS carries the warranty disclaimer, fees-paid
    liability cap + consequential-damages exclusion, the "only systems you own
    or are authorized to access" acceptable-use line, and the trial/cancel
    mechanics. **Lawyer review DEFERRED** to the same 50-customer / ~$500-mo
    trigger as K.2 (Kyle's call, 2026-07-16). Contact page phone: swap to a
    dedicated Google Voice number once its ID check clears.
    **Still owed:** lawyer review + entity-name swap at the K.2
    trigger; ~~the two subprocessor DPAs (Fly.io, Cloudflare — self-serve,
    free); a DMARC record for mirafold.com (email hygiene)~~ (both closed
    2026-07-17, next bullet).
  - **Update (2026-07-17): the DMARC record and both subprocessor DPAs are
    DONE.** (1) **DMARC live**: `_dmarc.mirafold.com` TXT
    `v=DMARC1; p=reject; rua=mailto:security@mirafold.com` (Cloudflare DNS;
    verified resolving; `p=reject` is correct because nothing legitimately
    sends as @mirafold.com — K.7 is inbound forwarding only, Kyle replies
    from his own address; revisit the policy before ever configuring
    send-as). K.7's SPF record confirmed still in place alongside it.
    (2) **Fly.io DPA executed** via Fly's Dropbox Sign flow from
    fly.io/documents (note: fly.io/legal 403s for everyone — /documents is
    the entry). Signed: company "Mirafold" (their field rejects the full
    d/b/a string), Kyle Serrecchia, Owner; Annex transfer description +
    "continuous" frequency written from the K.5 data inventory verbatim.
    Executed copy in Kyle's legal folder (outside the repos).
    (3) **Cloudflare DPA — nothing to sign, verified in force**: the
    Self-Serve Subscription Agreement §6.1 incorporates the DPA (v6.4,
    effective 2026-04-03) by reference for all self-serve accounts; dated
    copies of both documents archived beside the Fly DPA.
    **K.5's only remaining tail:** lawyer review + entity-name swap,
    both at the K.2 revenue trigger.

### Step K.7 — SECURITY.md + disclosure contact (done 2026-07-16)

- [x] **Step K.7 — SECURITY.md + vulnerability-disclosure contact (both
  repos)** — done 2026-07-16 (files 07-15; address live + tested 07-16).
  - Goal: researchers have a private channel that isn't a public issue —
    expected for this product category, cheap, and part of the
    reasonable-care record.
  - Build: `SECURITY.md` in genui-shell and genui-relay — supported
    versions, a private contact address on the entity's domain, a response
    promise Kyle can actually keep, no bounty implied. Keep the existing
    dated audits + fixes in PLAN-ARCHIVE.md intact: they are the
    reasonable-care evidence if a claim ever lands.
  - Done when: both files exist and the contact address routes to Kyle.
  - Status (2026-07-15): 🟡 files written — `SECURITY.md` in both repos
    (contact `security@mirafold.com`; 7-day acknowledgment promise; no
    bounty; latest-release-only support; each file points researchers at
    its repo's real attack surface — trusted-shell boundary for the shell,
    E2E blindness + metadata for the relay).
  - **DONE (2026-07-16): the address is live.** Cloudflare Email Routing
    enabled on mirafold.com (this required removing leftover **Namecheap**
    forwarding MX/SPF records first — they conflicted with Email Routing's own
    MX); `security@mirafold.com` **and** `support@mirafold.com` now forward to
    a verified, dedicated destination inbox. End-to-end tested — mail arrives
    and deliverability was tuned so forwarded mail doesn't land in spam.
    SECURITY.md in both repos already points at `security@mirafold.com`.

### Step R.2 — The relay service, deployed (still OPEN — full body + status history)

- [ ] **Step R.2 — The relay service, deployed** *(needs Kyle: Fly.io
  account + a domain — start both signups now; the code half is buildable
  before either exists)*
  - Goal: the dumb forwarder, running in the world.
  - Build: per the locked relay-architecture decision (2026-07-07, above) —
    a portable Node.js + `ws` service in a new **private repo**
    (`genui-relay`, closed source per the settled MIT open-core call —
    *2026-07-15: superseded by Phase K.1, the relay is MIT and flips public
    at launch; the repo separation itself stands*):
    accepts daemon dial-ins and browser connections, matches them by pair
    id, shuttles opaque frames. No frame parsing, no storage. Connection
    caps + rate limits + idle reaping (DoS posture same as the daemon's).
    Deploy: Fly.io single instance, TLS via the platform, behind our own
    domain (the indirection that keeps the host replaceable). Sequencing:
    (a) write + verify the service locally against the daemon's full test
    posture (doable now), (b) Kyle's signups, (c) deploy + point domain.
    From the 2026-07-07 security audit, two items owed to this step:
    (1) if the relay serves the shell page, it must send the daemon's same
    security-header set (the `SHELL_CSP` block in `server/index.ts`) — the
    stub serves `dist/` bare; (2) make the "who serves the app JS" trust
    call explicit in the R.2 write-up: E2E encryption stops the relay
    *reading* traffic, but a relay that serves tampered page JS could steal
    the pairing code from the fragment — the honest asterisk on the E2E
    story (industry-standard for web E2E; decide serve-from-relay vs.
    separate static origin, and word the marketing accordingly). The
    2026-07-08 contract design review adds a third argument to that same
    call: if the app bundle is fetched THROUGH the daemon (relay tunnels
    HTTP), client and daemon are always the same version — the trust
    question and the version-skew problem collapse into one choice; if the
    relay serves its own bundle, permanent skew is a commitment and R.4h's
    tolerant schemas become mandatory, not prudent. Also note: a future
    relay-protocol version bump presents to the user as "wrong pairing
    code" (the v1 string is baked into key derivation — a clean break by
    construction) — worth one line in the relay's error surface.
    (Daemon-side guards from the same audit already landed, 2026-07-07:
    weak pinned MIRAFOLD_RELAY_CODE refused at startup — min 16 chars, minted
    fallback — and relay-client caps + idle-reaps remote viewports:
    `MAX_REMOTE_VIEWPORTS`, `RELAY_VIEWPORT_IDLE_MS`.)
  - Done when: a phone on cellular (not the home wifi) drives a home mock
    session through the deployed relay, and the relay's logs show it
    learned nothing but connection metadata.
  - Status: **DEPLOYED and verified in production; the box stays open only on
    non-code items.** The service (the standalone private `genui-relay` repo —
    the single source of truth since G.1, 2026-07-15, retired the vendored
    `relay-service/` dev copy and its sync scripts) is a dependency-light (`ws`
    only) portable Node process: a PURE forwarder that parses no frames, stores
    nothing, and serves NO app bundle. Hardening in place — global + per-pair +
    per-IP connection caps (`RELAY_MAX_CONNECTIONS_PER_IP`, `fly-client-ip`),
    frame rate limit, heartbeat reaper, max payload, `/health` + 404-everything.
    **Trust decision (documented in the relay README):** a pure forwarder can't
    inject page JS that steals the pairing code from the URL fragment, so the
    phone loads the app from a SEPARATE static origin (R.5's landing host) and
    only then opens the encrypted socket. **Live:** deployed to
    **`genui-relay.fly.dev`** (Fly.io, single instance via `fly scale count 1`,
    platform TLS); `npm run smoke` PASSes against it and a real daemon streamed a
    full remote turn while `fly logs` showed only connection metadata — the
    "learned nothing" Done-when, observed in production. Verified:
    `server/relay-service.itest.ts` (9, Tier 2, real daemon ↔ real service) + the
    standalone 13-test suite + the live smoke.
  - **Owed to close the box (all non-code, Kyle's):** (1) a credit card on Fly —
    the trial stops machines after ~5 min idle; **DONE 2026-07-11: card added;
    the `genui-relay` machine was restarted and is `started`/health-passing.**
    (2) an owned domain + `fly certs add relay.<domain>` +
    `MIRAFOLD_RELAY_URL=wss://relay.<domain>` — launch-gating, since installed
    daemons must bake OUR name, never `fly.dev`. **DONE 2026-07-11 (infra):
    `relay.mirafold.sh` is LIVE — A/AAAA at Namecheap → Fly, cert Issued, and
    `scripts/smoke.mjs wss://relay.mirafold.sh` PASSES the full protocol (dial-in,
    pair, byte-identical forward, 4003 refuse).** STILL OPEN (code, part of the
    rename/R.5): nothing bakes a default relay URL yet — `server/index.ts` reads
    `process.env.MIRAFOLD_RELAY_URL` and the relay is OFF when unset, so shipped
    daemons don't yet point at `wss://relay.mirafold.sh` by default. Baking that
    default is the intended design (daemon always knows the relay; the relay
    enforces entitlement, R.5) but it turns the relay ON for everyone until R.5
    gates it — do it as part of the rename + R.5, not a standalone hardcode.
    **PRODUCT RENAMED 2026-07-11: genui-shell → `Mirafold`.** Domains
    `mirafold.com` + `mirafold.sh` BOUGHT (Namecheap; `.com` canonical, `.sh`
    for the `curl mirafold.sh | sh` install one-liner + `relay.mirafold.sh`).
    The earlier `genui-shell.com` choice (2026-07-10) is SUPERSEDED: on review,
    GENUI® being a live registered mark (General UI, LLC, USPTO ser. 88100880)
    in the *agentic-coding software* field — Kyle's own catch — made the
    same-industry relatedness too strong to keep any `genui`-led name; the
    downside (a launch-timed C&D / npm-or-domain dispute, cost asymmetric and
    correlated with success) outweighed the descriptive-use defense. `Mirafold`
    is a coined word (mira = look/marvel; -fold = manifold/shaping) → clean
    trademark slate (knockout search 2026-07-11: no registered/pending mark,
    no competing product; only an unrelated origami-facade research project
    and different-class marks Mifold/MiracleFold). Available on every channel
    (.com/.sh/.dev/.io/.app, npm `mirafold`, GitHub `mirafold`/`mirafold-sh`).
    **Still owed for the rename:** codebase/repo/npm/GitHub-org rename
    genui-shell → mirafold; the vendored relay app is still `genui-relay` on
    Fly (internal name — rename optional, not launch-gating).
    (3) the cellular-phone Done-when (an R.6 real-hardware check; also needs
    R.5's static origin). Deferred security-audit items: Finding #2 (viewport
    `Origin` allowlist) → R.5 (needs its domain); Finding #3 (pairId squat) → no
    action (128-bit codes). Full deploy-day history (the two Fly gotchas), the
    pre-deploy `ws` crash fix, and the audit detail are in PLAN-ARCHIVE.md.

### Step R.4 — Remote viewport UX (still OPEN — full body + status history)

- [ ] **Step R.4 — Remote viewport UX (the phone experience)**
  - Goal: connecting from a phone is one scan, and driving a session there
    is genuinely pleasant — this is the thing people pay for.
  - Build: shell-owned "connect a device" affordance (QR of the pairing
    URL); a phone-width layout pass over the transcript/prompt/status
    surfaces (the design identity holds — command strips, mono-in/rich-out);
    mobile-network resilience reuses the 4.4 machinery (seq resume +
    heartbeat) over the relay path. The `bang_input` ephemeral path stays
    viewport-scoped (a `sudo` prompt must never fan out — the 4.9 invariant,
    now load-bearing).
  - Done when: a real phone pairs by QR, drives a full session (prompt,
    render components, permission answer, interrupt) comfortably, and
    survives a network flip (wifi→LTE) mid-turn without losing the
    transcript.
  - Status: **built + verified locally (2026-07-07); the box stays open for
    the real-phone pass, which needs the R.2 deployed relay.** What shipped:
    (a) the shell-owned pairing affordance — `⧉ pair` in the status bar and
    fleet header opens a QR of `http(s)://<relay>/#code=<code>`
    (`ConnectDevice.tsx`; `qrcode-generator` devDep rendered as an inline
    SVG path, black-on-white in both themes; copyable URL; Esc/backdrop
    closes). The pairing info rides a new optional `relay` field on the
    `agents` hello, sent to LOCAL viewports only — the code never crosses
    the relay path, even encrypted. (b) A phone-width CSS pass
    (`@media (max-width: 640px)`): tighter shell padding, wrapping
    status/perm bars, ≥40px tap targets on allow/deny/stop/kill, markdown
    tables scroll in place, fleet rows rewrap (id/tab-count hidden, cwd on
    its own line), pin dock hidden (desktop affordance), short prompt
    placeholder. (c) Resilience needed no new code — 4.4 seq-resume +
    heartbeat just work over the relay, now proven. Verified — Tier-3
    `phone.e2e.ts` (4 tests, 390×844 touch context through the stub): QR
    affordance (session + fleet, exact pairing URL, Esc); pair-by-URL →
    tap into session → checklist turn with a rendered component, no
    sideways scroll at any point; permission answered by thumb (button
    height asserted); **offline→online flip mid-turn resumes the stream —
    pre-blip DOM node still connected (tail resume, not repaint)**.
    Tier-2 additions: the relay-path hello omits the pairing info, and a
    sudo-style password typed from the remote viewport reaches the PTY
    only (no viewport stream, no replay, no relay frame — the 4.9
    invariant, now load-bearing, plus ciphertext-tap audit). Screenshots
    eyeballed (phone dark/light, perm bar, pair overlay). Also:
    `test:e2e` now runs files sequentially (`--test-concurrency=1`) —
    three concurrent Chrome+daemon suites flaked on modest hardware.
    Owed to launch (R.6 checklist): scan the QR with a real phone through
    the deployed relay, drive a session, and flip wifi→LTE mid-turn.

### Steps F.7 + F.8 — Codex resolved-model label; `!` terminal parity (done)

- [x] **Step F.7 — Codex resolved-model label (closes F.3's codex gap)** — done
  2026-07-16 (Kyle: "show the model for codex just like you do for claude").
  The Codex SDK's exec stream never names the model, so the adapter reads it
  from Codex's own session record: the rollout file
  (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl`, local start
  date), whose `turn_context` line carries `payload.model`. Keyed by
  `thread.started`'s id; bounded poll (20×500ms — the line lands ~3s in) with
  a turn-end re-kick; failure-silent (the "codex" stand-in remains); never
  runs when a model was configured (`CODEX_MODEL` wins). Tier-1 fixture tests
  + live-verified. **Side-finding worth knowing:** the label flipped to
  `gpt-5.5`, not the terminal's `gpt-5.6-sol` — the SDK vendors its own codex
  binary (0.142.5, default gpt-5.5) while Kyle's terminal codex is 0.144.5
  (default gpt-5.6-sol), so SDK-driven sessions run an older default than the
  user's terminal. F.5's app-server migration (driving the system codex)
  would close that divergence too; until then `CODEX_MODEL` is the lever.

- [x] **Step F.8 — `!` terminal parity + hardening** — done 2026-07-17 (Kyle:
  "we must never hide ANYTHING"; found via `! cd ..` showing nothing where
  the terminal shows three things). Three behaviors, all shell-owned and
  agent-neutral: (1) **`cd` persists** across `!` commands via an EXIT-trap
  cwd handoff (known POSIX shells only; win32/exotic shells skip
  gracefully), confined to the workspace + children — an escape resets with
  the terminal's own "Shell cwd was reset to …" notice; (2) **silent success
  is said** — "(completed with no output)" under the bang strip; (3) the
  **transcript reaches the agent immediately as its own turn** (was: parked
  until the next typed prompt), with `cwd`/`cwd-after` attributes since the
  engine's internal shell can't follow a bang `cd` (SDK boundary — the one
  disclosed divergence). Same-day audit hardening: handoff files in a
  0700 `mkdtemp` dir (not bare /tmp), lstat regular-file+size gate (FIFO
  swap can't stall the event loop), `</bash-` closing-fence escaping in
  transcripts, and a per-session 400ms bang throttle
  (`BANG_MIN_INTERVAL_MS`) since each bang now costs a model turn. A
  SECURITY.md disclosure note is queued under R.7. Also same day, F.3
  extended: `session_created` carries the model label so the status bar
  shows agent → model from first paint (no longer waiting on the first
  turn's `usage`), and the fleet row matches that order. Tests in all
  three tiers (fence unit test; cwd-persist/escape-notice, FIFO-stall, and
  throttle itests; a real-typing `! cd ..` e2e watching all three behaviors).

### Phase S — Theme system: six themes at launch (✅ COMPLETE 2026-07-16 — full phase)

## Phase S — Theme system: six themes at launch (opened 2026-07-15; ✅ COMPLETE 2026-07-16 — all six steps done in one day, ships in the launch build before R.7)

Goal of the phase: grow from the two hand-built themes (Light, Dark) to **six**
— adding Solarized Light, Solarized Dark, Gruvbox Dark, and Dracula — on
plumbing that makes every later theme a one-file, one-manifest-row,
one-eyeball-pass addition. The real deliverable is the plumbing; the four
borrowed themes prove it.

**Decisions locked 2026-07-15 (this phase's charter):**

- **Native CSS only.** No CSS framework, library, or preprocessor — CSS custom
  properties are the purpose-built runtime theming mechanism, and the repo's
  zero-dependency posture holds.
- **Semantic tokens stay the vocabulary.** The existing ~45 purpose-named
  custom properties (`--surface-2`, `--fg-dim`, `--warn-border`, …) remain
  what structural CSS consumes. We do NOT adopt Base16 slot names
  (`--base0A`) — too coarse (16 slots can't express our 7 text tiers / 6
  border weights) and illegible to a human maintainer.
- **Base16 is the porting recipe, not the vocabulary.** Each borrowed theme is
  transcribed from its canonical published Base16 scheme through a
  documented slot→token mapping written once in S.2. Palettes aren't
  copyrightable and the source projects are MIT; each theme file carries a
  source-attribution comment anyway.
- **Every theme is standalone, labeled `light` or `dark` behind the scenes.**
  Themes never come in pairs and never have variants; the label only answers
  "which side of the toggle selects this." Families (Solarized) ship as two
  unrelated sibling entries. The user's settings hold two slots — a chosen
  light theme and a chosen dark theme (defaults: Light, Dark) — and the
  existing toggle picks the active slot, so it stays meaningful after
  someone adopts a fancy theme. Picking a theme from the list applies it
  immediately and fills its side's slot; users never manage slots explicitly.
- **The light/dark pill does not change AT ALL — LOCKED (Kyle, stated
  multiple times; re-affirmed emphatically 2026-07-16 after an "Auto" third
  state was misrecorded into S.3's original text).** Same look, same two
  positions, same behavior — no tri-state, no Auto, no `prefers-color-scheme`
  following, no visual tweak of any kind. Its two positions simply select the
  two slots, which with default slots is indistinguishable from today. The
  ONE new affordance this phase adds to the chrome is a **settings button**
  (S.4) that opens the theme picker. Any future change to the pill requires a
  new, explicit decision from Kyle — never infer one from adjacent work.
- **Code/diff surfaces stay pinned dark universally** (the standing
  USER-TESTING-FEEDBACK.md #8-adjacent decision: `--code-*`/`--diff-*` don't
  swap per theme). The contract records them as pinned; a per-theme override
  door stays open in the design but is NOT exercised in this phase.

- [x] **Step S.1 — Token audit + file split (zero visual change)** — done
  2026-07-16. Palettes now live in `web/src/themes/`: `base.css` (the pinned
  `--code-*`/`--diff-*` tokens, the charter's shared base block), `dark.css`
  (bare `:root` — dark stays the fallback identity), `light.css`
  (`:root[data-theme="light"]`, now token-complete: `--overlay` + the shadows
  are stated explicitly with the dark values rather than inherited silently);
  import order set in `main.tsx` (base → themes → structure). The audit found
  only three literals in structural CSS — three `box-shadow`s — hoisted as
  `--shadow-pop` (chart tooltip) and `--shadow-card` (onboarding/pair cards),
  same values both themes. `styles.css` is grep-clean of color literals.
  Deliberate non-CSS exceptions, each noted in-file: the QR's black-on-white
  (scanner contrast, `ConnectDevice.tsx`), the canvas favicon (can't consume
  CSS vars, `Shell.tsx`), the artifact iframe's dark base (opaque origin
  can't read shell vars, `Artifact.tsx`), and Chart's fixed CVD-safe series
  palette (data-viz, not theme). Verified: typecheck + all three tiers green
  untouched (168 unit / 74 itest / 21 e2e).
  - Goal: complete the tokens-vs-structure separation that `styles.css`
    already has in embryo (lines 1–112 are palette; ~2,400 lines are
    structure), so a theme is one self-contained file.
  - Build: sweep the structural rules for literal colors (hex/rgb/hsl) and
    hoist each into a semantic token; move the palettes out to
    `web/src/themes/dark.css` and `web/src/themes/light.css` (pinned
    `--code-*`/`--diff-*` tokens live in a shared base block — exact layout
    decided in-step); `styles.css` keeps only structural rules referencing
    `var(...)`. Import order via `web/src/main.tsx`.
  - Files: `web/src/styles.css`, `web/src/themes/` (new), `web/src/main.tsx`.
  - Done when: no color literal remains outside `web/src/themes/` (grep-clean,
    modulo deliberate exceptions noted in-file), and the app is visually
    unchanged in both themes — `yarn test:e2e` passes untouched.

- [x] **Step S.2 — Theme contract, manifest, and Tier-1 guards** — done
  2026-07-16. `web/src/themes/manifest.ts` is the single source: `THEMES`
  (`{ id, displayName, appearance }` — ids stamp `data-theme`, nothing else
  in the app names a theme), the 41-token `THEME_TOKENS` contract, the
  7-token `PINNED_TOKENS` set (base.css only), and the Base16 slot→token
  porting recipe as the closing doc comment (S.5/S.6 transcribe from it;
  syntax slots beyond the four semantic accents deliberately unused — code
  is pinned + hljs-owned). `themes.test.ts` adds 8 Tier-1 guards: manifest
  sanity, ids↔files bijection, per-theme selector scoping (dark owns bare
  `:root`, every other theme scopes to its own `data-theme`), exact contract
  token set (missing AND strays), base.css = exactly the pinned set,
  contract/pinned disjoint, fg/bg contrast ≥ 4.5:1, and appearance label ↔
  actual `--bg` lightness. Done-when proven live: each of the four failure
  modes (missing token, stray token, manifest/file mismatch, unreadable
  fg/bg) was broken once and failed exactly its guard, then restored.
  Verified: typecheck + all tiers green (176 unit / 74 itest / 21 e2e).
  - Goal: the fixed token contract every theme must satisfy, the single
    source the picker renders from, and the tests that keep 6 (then 16)
    themes from silently drifting.
  - Build: `web/src/themes/manifest.ts` — the canonical token-name list plus
    a `{ id, displayName, appearance: "light" | "dark" }` entry per theme
    (ids stamp `data-theme` and persist in settings; nothing else in the app
    ever names a theme). Write the Base16 slot→token mapping recipe as a
    comment/doc alongside. Tier-1 tests: every theme file defines exactly
    the contract's tokens (no missing, no strays); manifest ids ↔ theme
    files are a bijection; contrast floor — `--fg` vs `--bg` computes ≥
    4.5:1 per theme, so a mangled palette fails before a human looks.
  - Files: `web/src/themes/manifest.ts` (new), `web/src/themes/themes.test.ts`
    (new).
  - Done when: `yarn test` fails loudly on a theme file missing a token, a
    stray token, a manifest/file mismatch, or an unreadable fg/bg pair —
    verified by deliberately breaking each once.

- [x] **Step S.3 — Two-slot switching (the pill itself does NOT change)** —
  done 2026-07-16. `manifest.ts` gained the storage vocabulary
  (`MODE_STORAGE_KEY` = the pre-existing `mirafold-theme`, unchanged
  meaning; `slotStorageKey(appearance)` = `mirafold-theme-light/-dark`) and
  `resolveSlot()` (stored id wins if it names a manifest theme, else the
  side's default — existence check, not appearance: fit is enforced where
  slots are written, S.4's picker). Shell.tsx stamps
  `resolveSlot(mode, slot)` instead of the mode; the pill, its props, and
  StatusBar are untouched. index.html's pre-paint script mirrors the
  resolution by value (unknown id stamps harmlessly → bare `:root` dark
  until Shell re-stamps). Migration: no migration — the mode key keeps its
  exact meaning, absent slot keys mean defaults, which is byte-identical
  behavior. Proven in Tier-3 (`app.e2e.ts`): seeded dark slot paints its
  theme while the pill shows dark mode with unchanged rendering, both keys
  survive two reloads, each side follows its own slot on pill flips,
  unknown slot id falls back, and the pre-existing pill test passes
  untouched (default-slot identity). Tiers 178/74/22 green.
  - Goal: generalize the backing state of today's binary toggle
    (`Shell.tsx`, localStorage key `mirafold-theme`) to the two-slot model
    with **zero change to the pill** — per the charter's locked decision:
    same look, same two positions, same behavior; the original text of this
    step added an "Auto" third state, which misrecorded Kyle's decision and
    was struck 2026-07-16. Do not reintroduce it.
  - Build: persist `lightTheme` / `darkTheme` slot choices (defaults `light`
    / `dark`) alongside the existing mode; the pill's two positions select
    the active slot — with default slots this is behavior-identical to
    today. Active theme id stamps `:root[data-theme]`. Migration: existing
    stored `mirafold-theme` values keep meaning what they meant (the
    index.html pre-paint script included).
  - Files: `web/src/components/Shell.tsx`, `web/src/themes/manifest.ts`.
  - Done when: Tier-3 proves the pill flips between the two slot themes,
    choices survive reload, and with default slots the pill's rendered UI
    and behavior are exactly today's.

- [x] **Step S.4 — Settings button + theme picker UI (shell-owned)** — done
  2026-07-16, built exactly to the locked design. New `ThemePicker.tsx` =
  the centered settings card (pair-card idiom: shared backdrop rule,
  `--shadow-card`, ❯-glyph head, Esc/scrim/✕ close); gear button
  (`.sb-settings`) rides StatusBar as a plain optional-prop button placed
  before the pill (home ⌂ keeps far right; the pill and its test are
  untouched). Shell owns the state: slots lifted into React state so a pick
  repaints live; `pickTheme` enforces appearance fit at the one write site
  and flips mode to the picked side (picking is seeing). Swatch chips read
  each theme's real colors by importing `themes/*.css` as raw text
  (`import.meta.glob` — Vite-only, so the card mounts from Shell and must
  never be imported from Tier-1-tested modules; noted in-file) through the
  now-shared `parseThemeTokens` in manifest.ts — a new theme's swatch costs
  zero wiring. Tier-3 proves: gear→card, groups+rows from the manifest,
  chips carry non-transparent computed colors in the built bundle, current
  slots checked, live apply on pick (data-theme + pill side + slot key,
  card stays open), other slot untouched, Esc and scrim-click close.
  Tiers 178/74/23 green.
  - Goal: a **new settings button** in the shell chrome — the one new
    affordance this phase adds (the pill is locked, see charter) — opening
    the settings card with the theme picker.
  - **Design locked (Kyle approved 2026-07-16):** a small **gear button
    beside the pill** opens a **centered modal card** over the translucent
    `--overlay` scrim — the same idiom as the pairing/onboarding cards
    (`--shadow-card`, same border/radius language), NOT a popover or drawer.
    The card is titled "Settings" with an × close; one section today,
    **Theme**: two labeled groups, "Light themes" / "Dark themes", each row
    = theme displayName + a short strip of color chips (bg, surface, accent,
    fg) rendered from the manifest, with a check on the row occupying each
    slot. Clicking a row repaints the app instantly behind the scrim (live
    preview — the translucent scrim is the point), moves the check, writes
    the slot; no confirm/apply. Clicking a theme of the other appearance
    also flips the active mode to show it (picking is seeing). Esc, scrim
    click, or × closes. Built to grow more sections later (R.4l's settings
    surface); works identically on desktop and the phone viewport.
  - Build: picker renders purely from the manifest; clicking a row applies
    the theme immediately and writes it into its appearance side's slot.
    Shell-owned affordances (button + card) — agent output can never
    render, wrap, or intercept them (trusted-shell boundary). The pill is
    not touched, restyled, or repositioned by this step.
  - Files: `web/src/components/Shell.tsx` (or a new `ThemePicker.tsx`),
    `web/src/styles.css`.
  - Done when: Tier-3 drives a real click on the settings button → card
    opens; a real click on a dark-labeled theme → it paints immediately,
    `data-theme` updates, the pill's dark side now means that theme, and
    the light side is untouched — with the pill's own rendering unchanged.

- [x] **Step S.5 — Themes 3 + 4: Solarized Light, Solarized Dark** — done
  2026-07-16. Both transcribed from the canonical Base16 schemes (palette
  by Ethan Schoonover; attribution comments in-file) via the S.2 recipe,
  with the mixes computed by script rather than eyeballed; accents kept
  canonical — Solarized's famously soft contrast is the theme (fg/bg floors
  pass at 5.61 / 4.99). QA walk done by screenshot in headless Chrome over
  onboarding, a template turn, the live checklist, the permission bar, and
  the settings card, in both themes — all legible, pinned-dark code/diff
  sit right on both, no hand-tunes needed. **The walk caught one real bug:
  theme files never entered the bundle** (main.tsx imported dark/light
  explicitly; stamping an unloaded id silently falls back to bare `:root`
  dark) — fixed by loading `themes/*.css` via `import.meta.glob(eager)`,
  which also makes "one file + one manifest row" literally true for
  loading, swatches, and guards alike. Chased a scary-looking follow-up
  (runtime swaps "not repainting") to ground: it was the app's own 0.22s
  background transition animating theme flips — by design, not a bug;
  probes deleted. Tier-3 now proves a borrowed theme end-to-end with a
  computed-color assertion (settled post-animation) that would catch any
  future unloaded-theme regression, plus reload persistence. Tiers
  178/74/24 green.
  - Goal: the first borrowed pair — the canonical light theme and its
    famous sibling — shipped as two standalone manifest entries.
  - Build: transcribe each from its canonical Base16 scheme via the S.2
    recipe into one theme file each (+ attribution comment), then the
    eyeball QA walk per theme: terminal output, tool blocks, diffs (pinned
    dark — confirm they still sit right), permission bar, onboarding,
    generative-UI components; hand-tune derived tiers where the recipe's
    output misses.
  - Files: `web/src/themes/solarized-light.css`,
    `web/src/themes/solarized-dark.css`, `web/src/themes/manifest.ts`.
  - Done when: both pass the S.2 guards, both survive the QA walk with
    notes resolved, and each is selectable + persistent end-to-end.

- [x] **Step S.6 — Themes 5 + 6: Gruvbox Dark, Dracula** — done 2026-07-16.
  **Phase S complete: six themes at launch.** Gruvbox Dark transcribed from
  the canonical Base16 "gruvbox dark, medium" scheme (Dawid Kurek / Pavel
  Pertsev); Dracula deliberately from the OFFICIAL draculatheme.com palette
  instead of the base16-dracula scheme file, whose slot shuffle (pink in
  the red slot, lime in the green slot) would have broken the recipe's
  "semantic, not syntax" accent rule — the deviation is documented in the
  theme file's header. Recipe mixes computed by script; contrast floors
  8.59 (gruvbox) / 13.36 (dracula). Screenshot QA walk (template turn,
  checklist, permission bar, settings card; Dracula reached through the
  real picker with the card open) — both legible, identities unmistakable,
  no hand-tunes. The picker now shows 2 light + 4 dark; the one-file
  promise is proven by construction: S.5/S.6 added four themes and none
  touched anything but its own CSS file + one manifest row (loading is
  glob'd, swatches parse the file, guards sweep the directory). Tiers
  178/74/24 green.

## Moved 2026-07-19 (fourth lean-out pass — verbatim originals)

Phases **N** (onboarding backend picker, done 2026-07-17) and **V** (visual +
fidelity gaps, done 2026-07-18/19) completed; their full bodies + dated status
histories moved here, each keeping a compact per-step pointer in PLAN.md.

## Phase N — Onboarding backend picker (opened 2026-07-17; the R.4l item-4 redesign, executed)

Origin: the dedicated design discussion R.4l item 4 called for happened
2026-07-17 (Kyle + assistant), triggered by a real confusion on Kyle's own
machine: with BOTH an OpenAI API key and a ChatGPT subscription configured,
clicking Codex gives no indication of which credential the session will use
(today: the API key silently wins — hardcoded precedence in
`credentialKind()`), and pointing Claude Code at a local model is possible
only via pre-launch env config (`ANTHROPIC_BASE_URL`), outside the flow.
Kyle's bar, verbatim in spirit: "this should be obvious and easy from this
flow in the ui, i shouldn't have to go anywhere else or do anything else
provided i have the setup for these already handled."

**The locked design (Kyle, 2026-07-17):** a **two-step selection**. Step one
is the existing agent picker. Step two — shown only when an agent has more
than one way to run — lists **how it's backed**, built from what's already
configured on the machine: detected credentials (API key, subscription where
policy allows) plus **every compatible local model server currently
running**, discovered by probing. R.4l item 4's four hard requirements carry
over unchanged: (a) simple af; (b) surface what the user ALREADY HAS; (c)
unavailable options stay VISIBLE but clearly unavailable (gray, never
hidden); (d) each unavailable option carries how-to-get-it inline.

Design decisions settled in the 2026-07-17 discussion:

- **Local discovery is HTTP probing, never filesystem scanning.** Probe the
  well-known localhost ports (Ollama 11434, LM Studio 1234, vLLM 8000,
  llama.cpp 8080) with `GET /v1/models` — the de facto standard every local
  runtime serves; a server that answers hands back its downloaded-model
  catalog (no model need be loaded in memory). Model files on disk with no
  server running are deliberately invisible: per-tool storage layouts are
  unstable, and an unserved model is unusable anyway. Nonstandard ports get
  an env escape hatch, not a flow.
- **Dialect filtering per agent.** What determines compatibility is the API
  dialect the server speaks, not the model: Ollama speaks both the
  Anthropic-shaped and OpenAI-shaped APIs → its models list under Claude
  Code AND Codex; LM Studio/vLLM/llama.cpp are OpenAI-shaped only → Codex
  only; Gemini CLI has no BYO-endpoint path → never shows local options. No
  agent's list ever contains an option it can't actually drive.
- **The "it will show here" promise is live.** Under each local-capable
  agent, a hint line: start your local server and it appears here (worded so
  Ollama users — whose server idles perpetually as a background service —
  aren't told to do a step they don't have). The daemon re-probes while the
  picker is open and pushes updates, so the promise is literal — no reload.
- **Provider policy governs choosability, verbatim.** The second step
  re-stages `provider-policy.ts` per option, and improves its presentation: a
  blocked Claude/Gemini subscription becomes one grayed row with the why +
  API-key fix (instead of tainting the whole agent tile), and the Codex
  subscription option carries the disclosed-uncertainty caveat
  (uncertainty stated, never permission — the K.3 rule). The server NEVER
  trusts the client's choice: every `create` re-validates against detection
  + policy server-side.
- **Explicit choice replaces silent precedence.** Once this phase lands, a
  user with multiple credentials picks; the daemon never again silently
  prefers one. Single-option agents skip step two entirely (simple af).

Out of scope, unchanged: the relay bound (NO subscription ever rides the
paid relay — R.5's gate is untouched); L.2's `--local` CLI easy-mode (this
phase lands the detection substrate L.2 will reuse; the one-command CLI
flow stays demand-gated); model *download* management (we list what a
server offers, we never pull models).

Sequencing: prioritized by Kyle 2026-07-17 as the next build work. Not
formally an R.7 gate, but land it before R.5c's user-testing round so
testers meet the real flow. Wire rule throughout: additive only (new
optional fields / message types), per the locked protocol contract.

- [x] **Step N.1 — Enumerate configured backends (server-side truth)**
  — done 2026-07-17: `backendOptions(agent)` + exported `BackendOption`
  beside `credentialKind()` (which keeps its single-answer precedence as
  the default until N.5); five Tier-1 tests pin codex key+login → two
  usable options, claude endpoint+key+login → three with the subscription
  blocked-but-visible, empty menus, gemini's single option, and the model
  detail. Tier-1 189/189, Tier-2 77/77.
  - Goal: the daemon knows EVERY way each agent could run on this machine,
    instead of collapsing to one credential via hardcoded precedence.
  - Build: beside `credentialKind()` in `server/adapters/index.ts`, a
    `backendOptions(agent)` that returns ALL detected options, each
    `{ kind, usable, detail?, blocked? }`: codex with both `OPENAI_API_KEY`
    and `~/.codex/auth.json` present → two options (api-key AND
    subscription); claude-code with `ANTHROPIC_BASE_URL` and/or
    `ANTHROPIC_API_KEY` and/or `~/.claude/.credentials.json` → each present
    one listed (subscription marked blocked-but-visible per policy);
    gemini-cli → api-key only. `usable` comes from `allowedLocally()` —
    policy consumed, never re-encoded. Existing `credentialKind()` /
    `availableAgents()` behavior and the wire stay untouched this step.
  - Files: `server/adapters/index.ts` (+ `index.test.ts`).
  - Done when: Tier-1 tests pin the both-present cases (codex key+login →
    two options; claude endpoint+key+login → three, subscription blocked)
    and every existing suite stays green.

- [x] **Step N.2 — Local model server discovery (the probe)**
  — done 2026-07-17: `server/local-models.ts` (probeTargets / probeLocalServers /
  cachedLocalServers; 500ms per-probe budget, parallel, failure-silent,
  fire-and-forget cache; /api/tags answering = the Ollama fingerprint →
  anthropic+openai dialects, /v1/models alone → openai; model-count/name
  caps as bloat insurance). Six Tier-1 fixture tests: ollama shape,
  openai-only shape, dead port, malformed/empty catalogs, hung-socket
  bound, env escape-hatch parsing (pure — real ports never probed in
  tests). Tier-1 195/195; Tier-2 untouched by design (no callers yet —
  N.3 wires it).
  - Goal: a running Ollama / LM Studio / vLLM / llama.cpp shows up with its
    model catalog, automatically, without config.
  - Build: new `server/local-models.ts`: probe the four default localhost
    ports with a short per-probe timeout; parse `GET /v1/models` (all
    runtimes) and Ollama's richer native `/api/tags`; tag each found server
    with the dialects it speaks (Ollama: anthropic+openai; others: openai).
    `MIRAFOLD_LOCAL_ENDPOINTS` (comma-separated URLs) adds nonstandard
    ports. Async and failure-silent — a probe must never delay daemon
    startup or error a session; results cached with an on-demand re-probe
    function (N.3 drives it). Localhost + env-listed endpoints only —
    nothing else is ever probed.
  - Files: `server/local-models.ts` (+ test against fixture HTTP servers on
    ephemeral ports — found / absent / malformed / slow).
  - Done when: Tier-1 fixture tests prove discovery, dialect tagging, the
    env escape hatch, and the never-blocks property; suites green.

- [x] **Step N.3 — Advertise backends on the wire (additive) + live re-probe**
  — done 2026-07-17: additive `backends?: AgentBackend[]` per agents-hello
  row (credential options + dialect-filtered discovered servers, merged in
  `mergeBackends()` — an env ANTHROPIC_BASE_URL naming a discovered server
  dedupes to the richer discovered row, localhost≡127.0.0.1) + additive
  `refresh_agents` ClientMsg (per-connection probe throttle,
  `REFRESH_MIN_INTERVAL_MS`, throttled hits answer from cache; async resend
  guards a closed socket). Startup fire-and-forget probe in index.ts.
  `MIRAFOLD_LOCAL_DISCOVERY=off` skips the well-known ports (privacy
  opt-out + what keeps itests hermetic — forced in the harness so a dev
  machine's real Ollama can't leak into assertions). Q.2 fixtures updated;
  `web/src/ws.ts` needed NO change (types flow via @protocol; unknown
  fields pass through). New Tier-2 `agents-refresh.itest.ts`: fixture
  ollama appears dialect-filtered (claude+codex yes, gemini no) and
  disappears on refresh after the server stops. Tier-1 201/201, Tier-2
  78/78.
  - Goal: the browser learns each agent's full option list, and the list
    stays current while the picker is open.
  - Build: an additive optional `backends` field on the agents hello — per
    agent, the N.1 credential options plus N.2's local servers filtered to
    that agent's dialect (endpoint host + model names; never a secret —
    the secrets-stay-server-side rule). A re-probe path: an additive
    `refresh_agents` ClientMsg the picker sends periodically while open
    (server re-probes, re-sends the hello). Update Q.2's golden fixtures
    for the new field; the R.4h tolerant client schemas make old clients
    strip it silently.
  - Files: `server/protocol.ts`, `server/sessions/connection.ts`,
    `server/adapters/index.ts`, protocol fixtures, `web/src/ws.ts`.
  - Done when: Tier-2 (real daemon) shows a fixture local server appearing
    in the hello and appearing/disappearing across a `refresh_agents`
    round-trip; protocol-freeze and compat tests green.

- [x] **Step N.4 — The second-step picker UI**
  — done 2026-07-17: Onboarding grows the second panel (both mounts —
  Shell and FleetView — get it, with a 3s refresh_agents poll while the
  card is open); rows per the charter: usable credentials as buttons, the
  codex subscription with the K.3 caveat inline, blocked subscriptions
  visible-but-gray (disabled) with the why, discovered servers as
  runtime·host headers whose model catalog is the buttons, the live hint
  when no server; Esc/backdrop steps BACK from the panel before
  dismissing the card. Second step appears only for a genuine choice
  (>1 usable, or a model to pick); single-usable/demo keep one-click.
  Deviations, both deliberate: (1) create's `backend` field pulled
  forward from N.5 (additive; the client sends the choice now, the
  server validates + honors it in N.5); (2) the e2e drives the panel
  display-only — clicking a live-credential row would spawn a real
  engine, so create-through-choice is proven in N.5's Tier-2 and N.6's
  live pass. New e2e: two-cred codex panel + caveat, fixture ollama
  appearing LIVE mid-open via the poll, dialect row under claude, gray
  disabled blocked row, env-endpoint row kept distinct, gemini
  one-click demo create. Tier-1 201/201, Tier-3 28/28 (Tier-2
  untouched since N.3's 78/78 — type-only protocol additions).
  - Goal: click an agent → see how it can be backed; obvious and easy, no
    docs detour, per Kyle's (a)–(d).
  - Build: `Onboarding.tsx` grows the second panel, shown only when the
    clicked agent has >1 option (otherwise straight through, exactly
    today's behavior). Rows: usable options first (API key · detail,
    subscription with the codex caveat inline, each local server with its
    models — picking a model picks the backend); unavailable options
    grayed but VISIBLE with the existing how-to-get-it copy re-staged
    (`agents-meta.ts` hints become per-option, not per-agent); the live
    "start it and it appears here" line under local-capable agents (its
    arrival animates in via N.3's refresh — replaces the current
    `onb-local-note` footnote and its docs pointer); back/Esc returns to
    the agent list; `onPick` carries the chosen backend.
  - Files: `web/src/components/Onboarding.tsx`, `web/src/agents-meta.ts`,
    `web/src/styles.css`.
  - Done when: Tier-3 headless-Chrome e2e drives agent-click → backend
    list → pick against fixture data, including a grayed blocked row
    (visible, unclickable-to-create, hint shown) and a local server
    appearing live mid-open; single-option agents still create in one
    click.

- [x] **Step N.5 — Session creation honors the choice**
  — done 2026-07-17: `resolveChosenBackend()` (adapters/index.ts) is the
  never-trust-the-client gate — validates kind against live detection +
  provider policy, a discovered endpoint against the probe cache (dialect
  + model-in-catalog; stale/gone refuses with a re-pick message), runs in
  connection.ts's create case (registry only ever sees a pre-validated
  Backend). Adapters enforce per-session through each SDK's own env/config,
  never a process.env mutation: claude — discovered endpoint gets the
  docs/local-models.md recipe (BASE_URL + dummy AUTH_TOKEN, real key
  WITHHELD), api-key choice strips a global BASE_URL, no choice inherits
  (pre-N byte-identical); codex — subscription choice withholds the env
  key (explicit pick beats env precedence), api-key passes it, discovered
  endpoint injects the documented custom-provider config
  (`mirafold_local`, wire_api "responses") merged with the MCP config.
  Proofs: 12 new Tier-1 (engine-options capture via claude's `engine` +
  a new codex `makeCodex` seam; resolve validation matrix) + 4 new Tier-2
  (opposite codex choices logged as resolved; forged prohibited refuses
  with no session; a discovered-server pick's model label arrives on
  session_created — wire-observable; stale pick refuses). Tier-1 213/213,
  Tier-2 82/82, Tier-3 fail 0.
  - Goal: the picked backend is what the session actually runs on — silent
    precedence is gone for good.
  - Build: the `create` ClientMsg gains an optional backend choice
    `{ kind, endpoint?, model? }` (additive). The server RE-VALIDATES it
    against current detection + `provider-policy.ts` — a forged, stale, or
    prohibited choice is refused down the existing error path (the client
    is never trusted). `createSession`/adapters configure per-session:
    codex passes `apiKey` only when api-key was chosen and withholds the
    env var from the engine when subscription was chosen; claude-code sets
    the base URL per-session (SDK env/options, NOT global `process.env`
    mutation); local picks pass the chosen model. Fleet + status bar show
    the backing via the existing model-label machinery.
  - Files: `server/protocol.ts`, `server/adapters/index.ts`, the three
    adapters as touched, `server/sessions/connection.ts`, fixtures + tests
    in Tiers 1–2.
  - Done when: Tier-2, with both codex credentials present in a fixture
    env, two sessions created with opposite choices provably configure the
    engine differently; a forged prohibited choice is refused; all tiers
    green.

- [x] **Step N.6 — Live verification + docs reconciliation**
  — done 2026-07-17, on Kyle's real machine (real .env key, real codex
  login, real claude login, real running Ollama). **Verified live:** the
  hello shows exactly the expected menu (claude: api-key +
  blocked-subscription + ollama·qwen3-1.7b-32k; codex: subscription +
  ollama; gemini: api-key only); **codex on the ChatGPT subscription drove
  a real turn (5.1s, "ok")** and **claude on the API key drove a real turn
  (5.0s, "ok")**, each with its resolved-backend log line. **Honest
  finding on the local paths:** the pick is demonstrably honored — the
  codex pick delivered its 8,035-token agent prompt INTO Ollama (observed
  in the runner's slot state: our injected provider config end-to-end) and
  the claude pick spawned the runner with the per-session env — but a
  1.7B thinking model on CPU cannot PREFILL an agent-sized prompt before
  the SDK's own request timeout, so the turn retries forever (tried up to
  25 min; 4 honest retry notices — the F.2 machinery working as designed).
  Not a code defect: the docs' own model table calls sub-8B models below
  the agent-work floor. Local turn COMPLETION re-verify with a realistic
  model/hardware added to R.6's real-hardware checks. **Docs:**
  local-models.md now leads with the zero-config discovery path (dummy-key
  wart scoped to config-file-only setups), .env.example documents
  MIRAFOLD_LOCAL_ENDPOINTS / MIRAFOLD_LOCAL_DISCOVERY, README component
  map + env-knob list updated.

**Phase N security audit (2026-07-17, same day) — clean, three hardenings
landed immediately** (Kyle's standing rule, recorded here: a theoretical
finding whose fix is minimal with no downside gets fixed NOW, not
roadmapped): (1) the probe caps response SIZE (1 MB, chunked read) not just
time — a hostile local listener can no longer memory-spike the daemon;
(2) the codex local-endpoint branch withholds OPENAI_API_KEY from the
engine env (symmetry with claude's local branch — no key near a local
server); (3) SECURITY.md gained a "Known trust decisions" section
disclosing that local servers can't be authenticated (spoofing on shared
machines) with the guards + the discovery off-switch named. Verified: the
client can never steer an agent at an arbitrary URL (endpoint validated
against the daemon's own probe cache), no secrets ride the new wire
fields, and the relay's no-subscription gate carries through chosen
backends. No-action findings (recorded): backends list reaches paired
remote viewports (paired-device trust); per-connection probe throttle
amplification (gated + negligible). The R.7 `!`-output SECURITY.md note
still rides R.7 as planned.

**Phase N is COMPLETE (2026-07-17)** — all six steps shipped in one day;
final suite state Tier-1 213/213, Tier-2 82/82, Tier-3 28/28. One
residual rides R.6 (local-turn completion on realistic hardware). One
cosmetic note for a polish pass (R.4l intake): a credential-less agent
with a discovered local server still shows "no credentials · demo" on its
AGENT row while its second step correctly offers the usable local pick —
the row label could acknowledge the discovered backing.
  - Goal: the flow proven against real backends (the test suite never
    reaches a real model — this is the manual pass), and the docs tell the
    same story the UI now shows.
  - Build: on Kyle's real setup (OpenAI key + ChatGPT login + a local
    model server), verify every path end-to-end: each Codex choice drives
    a real turn on the right credential, a discovered local model drives
    Claude Code and/or Codex, the live-appear hint works with a real
    server start. Reconcile `docs/local-models.md` (auto-discovery
    exists; env config becomes the fallback), README's onboarding blurb,
    and `.env.example`.
  - Done when: Kyle's actual machine shows every expected option, each
    picked backend demonstrably runs on what was picked, and no doc
    describes the old single-credential behavior as current.

---

## Phase V — Visual + fidelity gaps flagged by Kyle (opened 2026-07-17)

Origin: two deficiencies Kyle flagged directly from using the shipped
product. Ordered here in the **reverse** of how he raised them (his
explicit instruction) — contrast first, Codex/Gemini fidelity second —
because the contrast problem cuts at the project's core justification.
Sequencing: opened as the next work after Phase N. Not yet graded against
R.5c/R.6/R.7 as launch-blocking; that call is Kyle's once each step below
is scoped further.

- [x] **Step V.1 — Theme contrast pass (all six themes)** — *done 2026-07-18:
  Kyle confirmed the themes are fine side-by-side; closed as-is, no further
  round.* Engineering landed 2026-07-18 in TWO rounds. Round 1 confirmed the diagnosis (only --fg/--bg had a
  floor; the read-for-content dim tiers — --fg-dim
  timestamps/footers/notice line, --fg-dimmer thinking block/status
  bar/tool detail — shipped at 3.0–3.4:1; Solarized Dark's PRIMARY --fg was
  4.4:1 worst-case; Gruvbox --fg-faint 1.7:1) but its WCAG-shaped floors
  (fg ≥7, dim ≥4.5) still strained Kyle's eyes. Round 2 rebenchmarked on
  what Kyle actually named — a stock terminal, near-white on near-black at
  15:1+ for everything: floors are now terminal-grade
  (worst-case-surface: strong ≥12, fg ≥11, body ≥10.5, mid ≥8.5, dim ≥7,
  dimmer ≥5.5, faint ≥4.5 — the faintest tier now clears the old
  body-text minimum; accents ≥4.5 on --bg; pinned code-fg ≥11, diffs ≥6),
  dark themes' surface stacks are regenerated as tight envelopes of --bg
  so no backdrop eats the ratio, Gruvbox adopts its canonical HARD
  background (#1d2021), and Dracula's canvas darkens a step (same hue) —
  white text physically couldn't clear 12:1 on the canonical #282a36.
  Hue/saturation preserved everywhere; deviations noted per file header.
  Verified by screenshot walk of a real mock session in all six themes
  (real build, headless Chrome), not just the guard test. All tiers green
  219/82/28. Side-finding, flagged to Kyle: the picker showing two ✓ at
  once is the S.3 two-slot design (one pick per pill side), not a V.1
  regression. Watch item: a Tier-3 flake seen twice across ~8 runs
  (green on every rerun) — second occurrence CAPTURED the name: "typing
  in the remote browser drives the session; both transcripts mirror"
  (the remote-viewport mirror test). Same profile as the 2026-07-17
  Tier-2 flake.
  Same-day follow-up (Kyle: round 2 "is better"): the **Standard pair** —
  two stock-terminal themes, not Base16 ports; the reference is the
  terminal itself. **Standard** (`standard.css`): pure black canvas,
  neutral white/gray ramp (no hue), the classic BRIGHT ANSI accent four
  (green/cyan/yellow/red). **Standard Light** (`standard-light.css`,
  Kyle: "complete the pair"): black-on-pure-white the way xterm and
  Terminal.app actually ship by default, with the NORMAL (dark) ANSI
  four (green/blue/olive/red3 — the bright set is unreadable on white).
  Each was one CSS file + one manifest row; guards pass unchanged (the
  contract + floors machinery is exactly what made them one-file adds);
  both screenshot-verified; all tiers green 219/82/28. Then the
  consolidation (`7b35c3f`, Kyle's calls): the floors had left the
  designed Light near-indistinguishable from Standard Light (lightness
  is no longer a design dimension on the light side) — a curation flaw,
  so the designed Light was DROPPED and Standard Light took over
  light.css + the load-bearing `light` id (the pill's light-side
  fallback); and the dark default's display name became **"Mirafold"**
  (house theme, house name — already the product's face in every demo;
  id stays `dark`, ids are fallback machinery). **Seven themes ship:**
  Mirafold, Standard (dark and light), Solarized Light/Dark, Gruvbox
  Dark, Dracula — the light-side Standard dropped its "Light" suffix
  same day (Kyle: the suffix made it read like Solarized Light at a
  glance; group headers carry the side). All tiers green 219/82/28.
  And the brand mark found its in-app home (`b7a1d47` → `bbd6ca9` →
  `dc844e9`, Kyle's calls through live mock iteration): an
  M-as-home-button experiment was tried and REVERTED same day (⌂ reads
  instantly); a centered mark over the greeting read as a splash screen;
  tiled-centered and ghost-watermark variants were mocked and rejected.
  Settled form (`96ed6f7`, after a further 1.25× + centering round):
  the FULL logo.svg mark — tile included, >_ prompt legible at 56px —
  HANGS off the left of the greeting ("Hello!" at 33px — the bare word
  read corporate, the 👋 boxed the text in; the exclamation is the
  warmth), with title and subtitle sharing the true page centerline
  (centering icon+title as one box had read as leaning right). Fixed asset colors: pops on light canvases, subtle
  well on dark, gone on Standard's pure black (strokes carry it —
  accepted). Mirafold theme accent stays aligned to the mark's
  canonical #40d17f. Known cost, accepted: active-session screenshots
  carry no brand mark.
  - Goal: Kyle, 2026-07-17: "every single style doesn't have enough
    contrast and strains the eyes to look at... this is something that
    regular terminals DO NOT have a problem with and it almost completely
    removes the entire justification for this project." A terminal
    successor that's harder to read than the terminal it replaces defeats
    Mirafold's stated identity (README §7: more pleasing to look at, not
    just better-formatted).
  - Diagnosis so far: `themes.test.ts` enforces a 4.5:1 WCAG-AA floor, but
    only on the single `--fg`/`--bg` pair — every other text tier
    (`--fg-mid`, `--fg-dim`, `--fg-dimmer`, `--fg-faint`, muted labels, the
    F.2 dim notice line, secondary/timestamp text) ships with **no**
    contrast floor at all, and 4.5:1 itself is the legal minimum for body
    text, not a comfortable target for a screen someone reads for a full
    session — most terminal color schemes aim well above it.
  - Build: audit real contrast ratios for every semantic token actually
    used as text, against its actual backdrop, in all six shipped themes;
    widen the floor test to cover every `--fg-*` tier (not just `--fg`),
    and re-tune token values where a theme fails a more honest bar. Sanity
    check against Kyle's own terminal color scheme as the comparison point
    he named.
  - Files: `web/src/themes/*.css`, `web/src/themes/manifest.ts`,
    `web/src/themes/themes.test.ts`.
  - Done when: Kyle confirms, side-by-side with his regular terminal, that
    reading a real session in each of the six themes no longer strains his
    eyes, and the widened contrast-floor test is green for every theme.

- [x] **Step V.2 — Codex (and Gemini) rendering/command fidelity gaps**
  *(opened 2026-07-18; done 2026-07-19 — Codex halves landed 2026-07-18,
  Gemini half live-probed and closed 2026-07-19: charts cleared as-is,
  /model interception + engine-answered picker landed; every clause of the
  "Done when" observed live. One deliberate small follow-up remains open on
  the Codex side: the reasoning-effort half of its picker, noted below.)*
  - **2026-07-18 live-probe findings (both root-caused, no fix landed yet):**
    - *(status note: the chart half AND the `/model` half of V.2 are both
      resolved below for Codex; the Gemini half was live-probed and closed
      2026-07-19 — see the Gemini block at the bottom of this step.)*
    - **`/model` — SOLVED 2026-07-18 (late evening), without waiting for
      F.5:** the interactive picker itself is TUI chrome the headless SDK
      can't reach, but the LIST it shows comes from the binary's own
      `app-server` JSON-RPC surface — `model/list` (initialize handshake →
      request → answer; newline-delimited JSON-RPC per
      `codex-rs/app-server/README.md`). Verified live: the user's own
      `codex` binary answers with exactly the terminal picker's four rows
      (gpt-5.6-sol default/current, -terra, -luna, gpt-5.5 — same order,
      same descriptions, plus per-model reasoning-effort options).
      Deliberate binary choice: the PATH `codex` (the user's install, the
      `MIRAFOLD_CODEX_BIN` seam), NOT the SDK's bundled one — the catalog
      is server-filtered per client version (the SDK's 0.142.5 cache shows
      only gpt-5.5 as listable; the user's 0.144.5 shows all four), and
      parity means the user's version's answer. Landed:
      - `server/adapters/codex-model-list.ts` — one-shot spawn, handshake,
        `model/list`, kill; rejects on spawn failure/protocol error/timeout
        (the adapter surfaces an honest error, never a made-up list).
      - `codex.ts` — `/model` intercepted in the worker loop (serialized
        with turns): bare `/model` renders the catalog as a `question`
        component — label = displayName + "(current)" marker, click sends
        `/model <id>` back through the same path, description as the detail
        line (a `list` fallback if the catalog ever leaves the 2–4 option
        range); `/model <id>` switches by RESUMING the warm thread with the
        new model (`codex.resumeThread(threadId, …)` — public SDK API,
        history intact, exactly what the terminal picker does to a
        session), or restarting the unstarted thread pre-first-turn.
        Unlisted slugs still apply — terminal Codex accepts any
        `-m <model_name>` (its own picker hints exactly that for legacy
        models), so refusing would be less faithful. modelLabel becomes
        configured-truth immediately.
      - **Live-verified end-to-end on the shipped `CodexSession`:** bare
        `/model` painted the picker with the real four models and the
        correct "(current)" marker; `/model gpt-5.6-luna` switched; the
        next real turn's model was read back from **Codex's own rollout
        file** (engine-side truth, not our label): `gpt-5.6-luna`. ✓
      - Tests: 6 new Tier-1 (picker from a stubbed catalog + no engine turn
        consumed; restart-vs-resume switch mechanics + label; honest
        error/usage paths; the app-server exchange against a stub binary
        incl. hidden-model filtering, exit-before-answer, timeout).
      - ~~Known remaining delta: the effort half not re-skinned~~ **SCAFFOLD
        landed 2026-07-19** (mock-built, live-verify pending): a standalone
        `/effort` path in codex.ts mirroring `/model` — bare `/effort` paints
        the five `ModelReasoningEfforts` (list form; a click sends `/effort
        <level>`), a pick resumes/restarts the warm thread carrying
        `modelReasoningEffort` via the shared `restartThread()`, an unknown
        level gets a usage line. +3 Tier-1. TWO fidelity questions deferred to
        a live pass on real Codex: (1) per-model effort availability (the
        terminal picker filters to a model's supported levels; app-server
        `model/list` may not carry that — until confirmed, all five are offered
        unfiltered); (2) flow shape (terminal folds effort in as step 2 of
        `/model` — chain the model pick into this picker, or keep `/effort`
        standalone? that pass's call).
      - **All tiers green: 234/82/28** (no flake on this round), typecheck
        clean.
      - Same-day close-out: a behavior-preserving refactor of the session's
        code (lookupThreadId dedup, picker extraction, shared test waiter,
        converter regex localized, typed parse boundary — re-verified
        234/82/28) and a scoped security audit — **no real or ship-time
        findings**; two cheap hardenings landed on approval (SIGKILL
        fallback for a SIGTERM-ignoring app-server child; hyphen-leading
        `/model` names rejected in the adapter rather than trusting the
        CLI parser to refuse them).
    - **`/model`, CONFIRMED:** drove real terminal `codex` through a pty
      (pyte-rendered screen) — `/model` opens an interactive picker: 4
      selectable models (gpt-5.6-sol/terra/luna, gpt-5.5) each with a
      description, "current" marked, legacy-models hint. Then drove
      `@openai/codex-sdk` directly (the exact call `codex.ts` makes) with the
      literal prompt `"/model"` — no picker; the SDK just answers it as a
      chat message: `"GPT-5 Codex."` (terse, and not even the real resolved
      model id). Confirms the standing diagnosis: the SDK's headless `exec`
      surface has no interactive round-trip, so there is no cheap in-adapter
      parse-and-render fix — `codex-sdk`'s public types expose no
      instructions/system-prompt override either, so this is F.5's
      app-server-migration territory, not a patch.
    - **chart-degrades-to-table — SOLVED 2026-07-18 (evening), root cause
      found in codex-rs source, fix live-verified 8/8 (baseline 0/9):**
      - The failure history, briefly: baseline 0/3 (mermaid block, or a
        "here's your chart" claim with nothing painted); prepending
        `RENDER_GUIDANCE` to the first turn 0/3; a "you MUST call this
        tool" `render_chart` description 0/3. Yet an explicit "call the
        mirafold render_chart tool now" worked instantly — with a ~28k
        input-token jump, the clue that cracked it.
      - **The real root cause (from `openai/codex` codex-rs source, not
        guesswork): Codex defers ALL MCP tools behind its tool-search
        mechanism.** `tool_search_always_defer_mcp_tools` is a
        graduated/hardcoded feature ("MCP tools are always deferred when
        tool_search is available"); `search_tool_enabled` =
        `model_info.supports_search_tool && provider.namespace_tools`, both
        true for gpt-5.6 on the OpenAI provider, neither user-overridable
        (the feature flag is a compiled no-op — verified live: the config
        override changes nothing). Probed the model's own tool list to
        confirm: **no mirafold tool appears in it at all**, only
        `tool_search.tool_search_tool`. So every prior prompt fix failed
        for the same reason — the model was told to prefer a tool it could
        not see, concluded it didn't exist ("I don't have the render_chart
        tool available", verbatim, one trial), and improvised. Tool search
        IS OpenAI's sanctioned path to those tools; the guidance just had
        to say so.
      - **Fix 1 (the cure), landed in `codex.ts`:**
        `CODEX_DEFERRED_TOOLS_ADDENDUM` — appended to `RENDER_GUIDANCE` on
        the first turn — names the deferral: the render tools do NOT appear
        in the direct tool list but ARE available via tool search; never
        conclude one is unavailable without searching; render_chart is
        mandatory for chart requests. **Result: 8/8 render_chart calls
        across every configuration tried** — 3/3 standalone-guidance
        trials, 2/2 with the full production-composed guidance, 1/1 on the
        SECOND turn of a thread (guidance persists in thread context), and
        2/2 end-to-end through the SHIPPED `CodexSession` (real SDK, real
        `render-mcp.ts` subprocess, real model → `render`/`chart` WireMsg
        with correct props observed on the adapter's output).
      - **Fix 2 (the deterministic backstop), landed:** new
        `server/adapters/mermaid-chart.ts` — if the model ever still
        hand-writes a ```mermaid xychart-beta``` fence, `codex.ts`'s
        `agent_message` handler converts it into the real `chart`
        component (title/x-axis/y-axis/bar/line parsed; the observed
        duplicate line+bar collapse handled; series named from the y-axis
        label). **Fail-open everywhere**: any fence outside the parseable
        subset (numeric-range axes, length mismatches, non-numeric values,
        non-xychart mermaid) passes through as the literal text the model
        wrote. So chart delivery is: instructed-native call (8/8 observed)
        → mermaid conversion (deterministic) → verbatim text (never
        silently wrong).
      - Tests: 8 new Tier-1 tests (`mermaid-chart.test.ts` pins the live
        fence shapes + fail-open boundary; `codex.test.ts` pins the
        first-turn-only injection and the fence→chart WireMsg path).
        **All tiers green: 228/82/28**, typecheck clean. Gemini keeps the
        plain `RENDER_GUIDANCE` prepend (Gemini CLI has no tool-search
        deferral; live-verify still owed on the API-key question below).
        Watch-item note: the Tier-2/Tier-3 flake hit a THIRD time during
        this verification (Tier-2 81/82 → 82/82 on immediate rerun — same
        green-on-rerun profile as 2026-07-17/18; the failing test's name
        wasn't captured this time, the run's output filter kept only the
        tally).
    - **Gemini: live-probed and CLOSED 2026-07-19** (Kyle funded a
      `GEMINI_API_KEY`; all probes ran API-key auth per the credential
      policy — the oauth-personal path is now dead upstream anyway: Google
      answers it with an IneligibleTierError pointing at Antigravity).
      - **Charts: CLEARED, no fix needed.** Gemini CLI has no Codex-style
        tool-search deferral — the MCP render tools are directly visible —
        and the V.2 first-turn `RENDER_GUIDANCE` prepend (landed 2026-07-18)
        was verified live through the shipped `GeminiCliSession`: 3/3 native
        render calls (bar chart with correct props; a second-turn line chart
        proving the guidance persists through `--resume` history; plus an
        unprompted `render_card` on a plain prose question). The mermaid
        backstop was deliberately NOT ported: Gemini streams text in chunks
        (fence reassembly would mean buffering the delta stream), no mermaid
        fallback was ever observed here, and the failure mode it guards was
        Codex's deferral — insurance without an observed risk isn't worth
        reshaping the streaming path.
      - **/model: same class of gap as Codex, root-caused and FIXED.**
        Terminal Gemini's `/model` opens a picker dialog (Auto + Manual →
        concrete models, access-gated by the binary; `/model set
        <model-name> [--persist]` switches directly). Headless (read from
        the installed 0.49.0 bundle, then observed live): a bare `/model`
        hits gemini's own headless slash parser and dies with a fatal
        "dialog … not supported in non-interactive mode" — surfacing in
        Mirafold as a silent zero-stat turn — and an executed `/model set`
        only mutates that single per-turn process AND still forwards the
        raw slash text to the model as chat. Worse, on a FIRST turn the
        `RENDER_GUIDANCE` prepend un-slashed the prompt (headless only
        recognizes a command at position 0), so the model just chatted
        about it (~112k input tokens of it exploring, observed). Landed,
        mirroring the Codex V.2 pattern:
        - `server/adapters/gemini-model-list.ts` — the catalog asked of the
          user's own binary via its ACP surface (`gemini --acp`, JSON-RPC
          `initialize` → `session/new`, whose response carries
          `models.availableModels` + `currentModelId` — the same
          access-gated rows the terminal dialog builds, computed in the
          session's workspace). One-shot spawn, kill after the answer,
          SIGKILL fallback; rejects honestly on spawn failure / protocol
          error / timeout.
        - `gemini-cli.ts` — `/model` intercepted in the worker loop
          (serialized with turns, engine-free): bare `/model` (and
          `/model manage`, and stray args — the terminal ignores args and
          opens the dialog) renders the catalog as a `question` picker
          whose click sends `/model set <id>` (Gemini's own syntax) back
          through the same path, with the `list` fallback outside the 2–4
          option range — this key's catalog is 6 rows (Auto + 5), so it
          takes the list; `/model set <name>` switches by changing the
          `-m` the next spawn passes (history intact via `--resume` —
          exactly the terminal dialog's effect), label configured-truth
          immediately, flag-shaped names rejected (the codex hardening),
          `--persist` applied as a session switch with an honest scope
          note. Guidance injection is now a separate `guidanceInjected`
          flag: slash-leading turns are passed to the engine verbatim and
          the one-time prepend waits for the first prose turn.
        - **Live-verified end-to-end on the shipped session:** bare
          `/model` painted the real 6-row engine catalog (Auto marked
          current, engine `currentModelId`); `/model set gemini-3.5-flash`
          switched instantly with no engine turn; the next real turn's
          usage stats — **the engine's own answer** — reported
          `gemini-3.5-flash`. ✓
        - Tests: 12 new Tier-1 (`gemini-model-list.test.ts`: stub-binary
          ACP exchange, error response, exit-before-answer, timeout;
          `gemini-cli.test.ts`: picker with no engine spawn, list
          fallback + hint, configured-model current marker, switch
          mechanics incl. `-m` on the next spawn, usage line, persist
          note, honest catalog-read error, and the slash-skip/one-time
          guidance injection — the stub bin now records argv for those).
      - **Probe footnote (not a product bug):** a session workspace
        OUTSIDE the user's trusted-folder tree loses the per-session
        `.gemini/settings.json` entirely (auth choice AND our MCP server) —
        that's Gemini's own untrusted-workspace safe mode, F.4 already
        surfaces the resulting stderr honestly, and real Mirafold cwds are
        the user's own (trusted) directories. Known and accepted.
      - **All tiers green: 246/82/28** (no flake this round), typecheck
        clean.
    - **2026-07-19 (afternoon) amendment — the OpenRouter/custom-provider
      probe (Kyle configured `model_provider = "openrouter"` +
      `qwen/qwen3-coder:free` in `~/.codex/config.toml`):**
      - **Setup findings:** the `.env` key was named `OPEN_ROUTER_API_KEY`
        while config.toml declares `env_key = "OPENROUTER_API_KEY"` —
        renamed in `.env` to match (the standard name). The `:free` slug is
        dead upstream (OpenRouter 404s it, pointing at the paid
        `qwen/qwen3-coder`); config.toml is Kyle's file, he updates the
        slug. OpenRouter's `responses` wire API works with codex.
      - **/model under a custom provider: parity met by construction,
        nothing landed.** Terminal codex (pty-probed) shows the stock
        OpenAI `model/list` catalog even with openrouter active — the
        current qwen model isn't listed and no row is marked current — and
        our re-skin asks the same surface, so it shows the same rows.
        (0.144.6 answers 7 rows, so the picker takes the ≥5 list fallback
        now; version-driven, faithful either way.)
      - **The deferred-tools addendum was WRONG for tools-visible configs,
        reworded (the one landed change).** Deferral is per-provider/
        per-model (`supports_search_tool` falls back FALSE for unknown
        slugs like qwen — codex-rs fallback metadata), so under a custom
        provider the render tools sit directly in the tool list and the old
        unconditional "they do NOT appear in your direct tool list" sent
        qwen hunting: two failed MCP discovery calls
        (list_mcp_resource_templates/list_mcp_resources), ~35s and ~2x
        tokens before rendering (124k vs 52k input, raw-SDK A/B). New
        conditional wording ("if they appear, call them directly; if not,
        they are deferred behind tool search…") verified live on BOTH
        paths: qwen/OpenRouter 3/3 direct render_chart calls, no
        meta-tool thrash, tokens halved; gpt-5.5 on the builtin openai
        provider (the deferral path, ChatGPT auth) 3/3. The existing
        Tier-1 injection pin ("tool search" substring) still holds.
      - **Registry/chart fidelity on qwen: 6/7 native render calls**
        through shipped-session + raw trials combined. The one miss was
        NOT model behavior: every `mirafold.*` call in that session
        answered "unsupported call" for the whole turn (the same bare-name
        call succeeded in every other trial) — a rare render-MCP startup
        race, new watch item below. No mermaid fence was produced (the
        backstop had nothing to catch; it stays as-is).
      - **Watch items:** (1) render-MCP registration race — one occurrence
        in ~20 codex sessions across two days; if it recurs, look at
        whether codex builds the turn's tool list before the stdio server
        finishes initializing. (2) The Tier-2/3 flake hit a FOURTH time
        (Tier-3 27/28 → 28/28 on immediate rerun; failing test's name
        again not captured — output was filtered to the tally).
      - **Findings reported to Kyle, no action taken (his calls):** the
        onboarding row still labels codex "subscription" with the ChatGPT
        gray-area disclosure while sessions actually ride the OpenRouter
        key (we deliberately don't parse config.toml; inaccurate in the
        harmless direction — the actual run is cleaner than disclosed);
        and the stale `:free` slug in config.toml. Side effect owned: a
        pty probe accidentally accepted codex's own update prompt —
        binary repaired via clean reinstall, now 0.144.6 (was 0.144.5).
      - **All tiers green: 246/82/28**, typecheck clean.
  - Goal: Kyle, 2026-07-17: Codex's `/model` in Mirafold does not show the
    full list the same command shows in a real terminal, and a requested
    chart/graph sometimes renders as a plain table instead — both are
    faithful-skin violations (CLAUDE.md non-negotiable: a Codex user gets
    Codex, nothing degraded). Kyle suspects Gemini has the same class of
    problem but has not yet tested it. Kyle's read: Claude was prioritized
    early in the project and Codex (and likely Gemini) fidelity lagged.
  - Diagnosis so far: no dedicated `/model` handling exists in
    `server/adapters/codex.ts` — slash commands ride the general F.1
    buffered-text path, so an interactive terminal picker likely degrades
    to whatever static text the SDK's headless `exec` surface emits, which
    may not carry Codex's full profile/model list. This is plausibly the
    same root cause F.5 already named (the Codex SDK drives a headless
    `exec` surface with no interactive round-trip) rather than a distinct
    bug — F.5's app-server migration may be the real fix, not a patch
    bolted onto `exec`. The chart-degrades-to-table symptom needs its own
    trace: whether the model itself is choosing `table` under Codex (a
    prompting/tool-description gap) or the adapter/registry is mis-mapping
    a `chart` instruction.
  - Build: live-probe terminal Codex's `/model` output vs. Mirafold's,
    side-by-side, and trace exactly where the list gets truncated;
    live-probe a chart-triggering prompt in terminal Codex vs. Mirafold and
    trace whether the model or the render path is responsible; run the
    same two probes against Gemini CLI once Codex is diagnosed, since Kyle
    flagged it as an open question, not a confirmed second bug. Fold
    findings into F.5 (Codex) / F.6 (Gemini) if root-caused there, or open
    new steps if not.
  - Files: `server/adapters/codex.ts`, `server/adapters/gemini.ts`,
    `server/render-tools.ts`, `server/render-mcp.ts` (chart tool
    description), PLAN.md F.5/F.6.
  - Done when: Codex's `/model` in Mirafold shows the same list terminal
    Codex shows, a chart prompt renders a chart (not a table) in Codex, and
    Gemini has been live-probed for both classes of gap with the result
    recorded here (confirmed-affected, or cleared).

- [x] **Step V.3 — Truthful full-optionality Codex backend picker (provider
  binding)** *(Kyle's design, approved and built 2026-07-19)*
  - Goal: Kyle caught onboarding lying — a machine with `auth.json` + a
    config.toml OpenRouter default showed the codex row as "subscription"
    (gray-area disclosure and all) while sessions actually rode the
    OpenRouter API key. His design bar: transparency, simplicity, full
    optionality — every way codex could run is a row derived from ground
    truth, every pick is enforced so the label can never be false, and the
    first row is what terminal codex itself would run.
  - Base (landed same morning by a parallel session, commit 90117f6):
    `codex-config.ts` scans the config.toml DEFAULT provider; that detects
    as the `local` kind, rows in the picker, retires the dummy-key recipe.
  - Built on top (this step):
    - `codex-config.ts` now scans ALL `[model_providers.<id>]` entries
      (id, name, base_url, env_key) plus the top-level `model`;
      `parseCodexDefaultProvider` re-derived from the full scan (no drift).
    - **Rows:** one per declared provider (`backendOptions` codex case) —
      terminal default first, first-party api-key/subscription rows between,
      non-default providers after; label "`<name> · <host>`"; usable only
      when the provider's `env_key` variable is present (missing key rows
      show `hint` naming the exact variable — visible, never dead-on-turn-1);
      first-party `openai` id never rows (api-key/subscription own it);
      dedupe vs discovered servers generalized per-row (server-side
      `endpointUrl`, stripped before the wire). Wire additions all additive:
      `AgentBackend.provider`/`hint`, `BackendChoice.provider`,
      `Backend.provider`.
    - **Enforcement (the point):** `resolveChosenBackend` validates a
      provider pick against a fresh config scan + key presence;
      `CodexSession` forces `model_provider` per pick — a provider pick
      forces its id (declaration stays the user's own table), api-key and
      subscription picks force `openai` (a no-op unless a custom default
      exists — exactly the lying case). An old client's bare local pick
      still injects nothing (config default wins, as before).
    - **Model axis (found live — the subscription pick 400'd carrying the
      OpenRouter-scoped `model = qwen/…`):** a forced-openai pick with a
      custom config default + top-level model resolves the ENGINE binary's
      own catalog default (app-server `model/list` against the SDK's
      resolved `executablePath`; answered `gpt-5.5` on the vendored
      0.142.5) before the first turn and restarts the unstarted thread
      under it — version-correct, never a hardcoded slug; explicit models
      (opts/`/model`) win outright; catalog failure or a no-default catalog
      = honest error + `/model` hint, the foreign model never reaches the
      engine. Known bound, documented: a NON-default custom-provider pick
      inherits the config model (no knowable per-provider default exists);
      a mismatch errors visibly and `/model <slug>` fixes it.
    - Client: picker rows pass `provider` through the choice; a row's own
      `hint` wins over the generic blocked hint.
  - **Live-verified on Kyle's machine:** advertised rows exactly truthful
    (OpenRouter · openrouter.ai usable + subscription; no phantom api-key
    row); OpenRouter pick → real turn on `qwen/qwen3-coder`; subscription
    pick → `gpt-5.5` per the engine's OWN usage stats (before the model-axis
    fix this 400'd — the enforcement is observable). 8 consecutive clean
    runs to close.
  - **Watch item (upstream, intermittent):** twice in a ~13-minute window
    the 0.142.5 engine ran the turn under `thinkingmachines/inkling` — a
    slug present NOWHERE on the machine (not config, caches, or either
    binary); the rollout's turn_context shows codex's own
    collaboration_mode settings carrying it, i.e. a server-fed override.
    8 subsequent runs clean. If it recurs: rollout
    `2026-07-19T07-31-45-…56573b2f733b.jsonl` is the specimen; it also
    motivated the no-default-catalog hardening (never guess row 0).
  - Tests: +23 Tier-1 across codex-config (full scan shapes), index (row
    order/gating/wire/dedupe/resolve), codex (provider forcing via the
    makeCodex seam; model-axis swap, failure, explicit-win, no-swap cases).
  - **All tiers green: 277/82/28**, typecheck clean.
  - Same-day close-out (2026-07-19, evening): a behavior-preserving refactor
    of the two sessions' work — the one-shot JSON-RPC plumbing shared by both
    model-list modules (`jsonrpc-oneshot.ts`), the /model picker rendering
    shared by both adapters (`model-picker.ts`), one `agentBin` resolver
    (was 3 copies), `setThreadModel` dedup + `providerBinding` extraction in
    codex.ts, flag renamed `needsEngineDefaultModel` — net −125 lines,
    emitted strings pinned unchanged by existing tests. Scoped security
    audit: no real or ship-time findings; one theoretical hardening landed
    on approval — a bare scalar/`null` stdout line from a spawned binary
    crashed the whole daemon (reproduced live, pre-existing shape faithfully
    preserved by the refactor) → guarded in the shared one-shot + Tier-1 pin
    (Tier-1 now 278). Audit also verified clean: client-forged picks refused,
    no secrets on the wire, arg-array spawns only, spawn-failure rejects
    cleanly, relay policy holds post-V.3. Watch-item note: the Tier-2/3
    flake hit a FIFTH time during refactor verification (Tier-3 27/28 →
    28/28 on rerun; failing test's name again not captured).
  - **2026-07-19 (evening) — the Tier-2 flake ROOT-CAUSED and fixed** (test
    harness, not product). Hunt: 8 full-suite + 20 isolated runs all green;
    full-core CPU load reproduced it 7/8 rounds with the signature captured
    at last — `timed out waiting for agents; seen:` EMPTY (hello never
    arrived after a good handshake). Cause: `relay-test-client.ts` consumed
    the handshake reply in an async `once("message")` and installed the
    permanent listener only after two crypto awaits — a frame landing in
    that gap (the daemon sends handshake reply + encrypted hello
    back-to-back) was emitted to no listener and silently lost. The REAL
    client (`ws.ts`) never had the gap (permanent handler installed before
    the handshake, serialized recvChain) — and proved it: Tier-3 real-client
    rounds passed 5/5 under the same saturation. Fix: the test client now
    mirrors ws.ts structurally (listener first, handshake resolves in the
    chain; parity comment marked load-bearing) + the mirror test's
    `.at(-1)!` on an empty list became a named assertion (no more TypeError
    cascade). Proof: 8 post-fix rounds under identical load — hello-drop
    signature ZERO, every mirror/handshake test green (remaining loaded
    failures are cap/idle-reap tests that can't open N sockets on a
    saturated machine — never flaked organically). All tiers re-verified
    278/82/28. RESIDUAL: the lone organic Tier-3 sighting (the e2e settle
    test, 2026-07-18) is a different shape, never reproduced even under
    saturation — likely a timeout graze under full-suite load; watch item
    stays open at reduced severity for that one shape only.

---

## Moved 2026-07-24 (fifth lean-out pass — verbatim originals)

Phases **A** (accessibility), **C** (CI/CD), **E** (Explorer) and **M**
(Mission control) all completed, plus the still-inline bodies of **V.4–V.6**.
Each keeps a compressed summary + its standing rules in PLAN.md; the full
bodies, step specs and dated status histories are reproduced verbatim below.

---

### Phase V — steps V.4 / V.5 / V.6 (done 2026-07-20 / 07-20 / 07-22)

- [x] **V.4 — In-session ergonomics: a "new" button, prompt focus, terminal scrollback** — done 2026-07-20 (Kyle-directed, same day). A `new` button beside home opens the startup screen in a fresh tab (`/?new=1` lands on the picker); `end` moved to the far right past the theme pill. The caret starts in the prompt box on entering any session and is re-taken when a turn ends having dropped focus to the body — never from an open overlay or over a live selection. Transcript scrolling became **conditional**, terminal-scrollback style: streamed output scrolls you down only while you're already at the bottom; scroll up and the view holds.
  - **Follow-up, the only thing still open:** the phone half of the scroll work is unverified by hand. Follow-the-tail detaches on a finger drag downward with **no minimum distance**, so a tap whose thumb wobbles a pixel downward (expanding a tool block, a pin button, a question option) silently stops auto-scrolling, and the agent then looks stalled mid-response with nothing on screen explaining why. Kyle's call 2026-07-20 was to ship it and find out by hand rather than pre-emptively guard it. If it bites: require ~8px of travel before a drag counts as steering, in `onTouchMove` (`web/src/use-follow-tail.ts`) — a real swipe is hundreds of px, thumb noise is 1–2. The touch handlers are also **not proven necessary at all**: touch held correctly without them (a finger drag isn't suppressed by a programmatic scroll the way the wheel was), and they are kept only as a guard for iOS Safari, which cannot be tested on this machine.
  - Note for anyone touching `use-follow-tail.ts`: following scrolls **instantly, never smoothly**, and the reader's **input** is what detaches, not a position delta. Both were bought with a bug — a permanently in-flight smooth animation owned `scrollTop` and made the wheel inert during streaming. The trace and the evidence are in commit `00288c6`; re-read it before reintroducing either.

- [x] **V.5 — The one-click picker row names its backing** — done 2026-07-20 (Kyle-directed, same day). Choosing Gemini started a session without ever saying an API key was what it ran on: Gemini's only backing is a key, so `needsSecondStep()` correctly skipped the backend menu — which is the one place the credential was ever named — and `agentDetail()` had nothing to fall back on (it returned the model override, and there was none). The fix keeps the one-click path exactly as it was and states the decision instead: `AgentInfo` gained an additive optional `kind` (set only when `live`), and the row renders `backingLine()` — "Gemini API key", or "Claude API key · claude-sonnet-5" when a model override exists. The wire carries the *kind* as a fact and the client owns the wording (`agents-meta.ts`), so the one-click row and the second step say the same words about the same backing. **The principle**, worth keeping: a single usable backend isn't "no choice to show," it's *a choice made on the user's behalf* — a menu you don't need can be skipped, but a decision made for the user must still be stated.
  - **Credential labels now match each vendor's own name for what you buy** (same day, Kyle's call): "Google API key" → **"Gemini API key"** (Google sells the Gemini Developer API; "Google API key" is the generic Cloud term, and we only ever said it because `GOOGLE_API_KEY` is an accepted env var — that one is the Vertex path, a different product), and "Anthropic API key" → **"Claude API key"** (the API was rebranded from Anthropic API to Claude API). "OpenAI API key" was already right. The resulting asymmetry — "ChatGPT subscription" beside "OpenAI API key" — is deliberate and documented at `backendLabel`: OpenAI keeps its consumer and API brands apart, and matching what *they* call things means inheriting that, not smoothing it.
  - Considered and **rejected** for now: making the backend menu reachable from a one-click row (a second click target on the row opening the full menu, so "why is there only one option?" has an answer). It costs a real restructure — the row is a single `<button>`, and a nested button is invalid HTML, so it becomes a div with two siblings plus a hand-written focus/keyboard story — to answer a question the row's own label mostly pre-empts. Revisit only if a real user asks it.
- [x] **V.6 — The /model picker becomes real shell chrome (+ session polish batch)** — done 2026-07-22 (Kyle-directed, same day). Kyle hit V.2's fallback live: a Codex catalog past 4 rows degraded `/model` to a non-interactive list + "type to switch," where terminal Codex gives arrow-key selection at any size. Root cause named and fixed **structurally**: the re-skin had borrowed the agent-facing `question` component, whose option cap is discipline on generated UI and must never bind a shell re-skin of terminal chrome. Now an additive `picker` wire message + shell-owned `PickerBlock.tsx` (NOT a registry component): any row count, ❯ highlight starting on the current row, ArrowUp/Down/Enter/Escape captured globally while the newest copy is unanswered — including from the idle empty prompt box, so `/model` ⏎ arrows works exactly like the terminal — retired by a pick or a later user turn; replayed copies click-only. Serves codex `/model`, codex `/effort`, and gemini `/model` through the one shared `emitModelPicker`. Verified Tier 1/2/3 including a real-arrow-key e2e. Same sitting, all Kyle-directed:
  - **question component option cap 4 → 6** ("why not?"). Fidelity note, not a caveat: Claude Code's own AskUserQuestion still maxes at 4, so real agent questions stay ≤4; the wider cap is headroom for agents that choose it.
  - **White-flash kill on fresh tabs**: the pre-paint script in `index.html` now paints the canvas inline (mode's base `--bg` + `color-scheme`) before any stylesheet exists; `main.tsx` clears the inline values once real CSS owns the pixels (both routes). Proven with an all-subresources-blocked first-frame screenshot: solid dark where it was white. Worst in dev (Vite injects CSS via JS); fixed there and in the build.
  - **`.sb-pair` joined the status bar's 34px control row** (was leftover tiny pre-unification styling; the fleet-header variant pinned unchanged). Pre-existing, unfixed, noted: the fleet-header pair button renders ~5px taller than `.fleet-new` because the ⧉ glyph's fallback-font metrics stretch the line box.
  - **Tier-2/Tier-3 harness now scrubs the paid-tier env** (`MIRAFOLD_APP_URL`, `MIRAFOLD_LICENSE_KEY`, `MIRAFOLD_ENTITLEMENT_TOKEN/URL`) like credentials — a dev shell live-testing the paid path was making relay itests dial the real billing backend (one hung 45+ min) and pointing pairing-QR tests at the hosted app. Tests that exercise entitlement pass their own values, which override the blanks.

---

### Phase A — Accessibility (opened 2026-07-20; ✅ COMPLETE 2026-07-21)

## Phase A — Accessibility (opened 2026-07-20; Kyle-directed, pre-launch)

Kyle's directive, verbatim: *"i want mirafold to be friendly to all people
capable of using it and to be ada compliant."* The ADA itself specifies no
technical standard for software, so the operative target — the one the DOJ
and effectively every settlement agreement point to — is **WCAG 2.1 Level
AA**. That is this phase's bar.

Starting position, from a 2026-07-20 read of `web/src/`:

- **Contrast (1.4.3 / 1.4.11) is already the strongest thing here** — V.1's
  terminal-grade floors (strong ≥12 · fg ≥11 · body ≥10.5 · mid ≥8.5 ·
  dim ≥7 · dimmer ≥5.5 · faint ≥4.5 · accents ≥4.5) clear AA's 4.5:1 by
  roughly double at the *faintest* tier, on all seven themes, enforced by a
  Tier-1 guard. Nothing owed. Do not re-open it.
- Also already present: `prefers-reduced-motion` (2.3.3) at
  `web/src/styles.css:2041`, a global `:focus-visible` rule (2.4.7) at
  `styles.css:2027`, `lang="en"` (3.1.1) in `web/index.html`.
- The gap is **programmatic semantics**: the whole app carries 4
  `aria-hidden`, 3 `role=`, 3 `aria-label`, 2 `aria-pressed` — and zero
  `aria-live`.

Primary users served: screen-reader users (Orca / NVDA / JAWS / VoiceOver)
and keyboard-only users (motor impairment — tremor, RSI, paralysis, limb
difference). Sequence A.1 → A.2 → A.3; A.4 is written last, after the others,
because it is a public conformance claim and must describe the real state.

The automated regression guard for all of this is **Step C.2**, deliberately
placed in the CI/CD phase below.

**⚑ The screen-reader walk — RESOLVED 2026-07-21: it is fully automatable
on this box after all.** This note originally read "one item in this phase
cannot be done by the assistant at all: actually *listening* to Mirafold
with a screen reader." That turned out to be wrong. The assistant now runs
the whole walk end to end without a human ear: Orca with `--debug-file`
gives its speech as readable text; the claude-in-chrome extension drives the
page over CDP (the only input path that reaches native-Wayland Chrome);
foregrounding the extension's tab via its AT-SPI `doDefault` action makes it
simultaneously CDP-drivable and Orca's focus locus; and the CLI terminal-title
flood is filtered out of the log rather than fought. The full recipe lives in
[[orca-testing-mirafold]] (memory). Both A.1 and A.3 were closed this way on
2026-07-21 — onboarding → a full prompt→response turn → tool calls → a
permission prompt → an error → settings/theme → connect-a-device → fleet
view, each heard live. What was checked, in the walk's own terms: the
response read once and whole (not per-token); nothing read twice or flooded;
every control announced with a real name + role (never a bare "button");
focus never landed on an invisible element; every overlay trapped focus and
restored it on close. One human-judgment residue remains only if desired: a
person confirming the TTS *sounds* right subjectively — but comprehensibility,
naming, ordering, and no-flood are all now proven from the assistant side.

**Other screen readers — deferred post-launch, Kyle's call 2026-07-22.**
Every walk above was Orca + Chrome on Linux; NVDA, JAWS (Windows), and
VoiceOver (macOS/iOS) have not been walked — each needs hardware or a VM we
don't have running (NVDA is free, a Windows VM is the realistic route; JAWS
has a 40-minute demo mode; VoiceOver needs Apple hardware). They consume the
same ARIA semantics the Orca walk verified, so the standard-patterns bet is
that the results carry — but that's an expectation, not a verification.
Kyle's call: **save those walks for post-launch polishing** — not a launch
gate, not owed by A.4 (whose statement already words the scope honestly:
"most thorough with Orca on Chrome"). When picked up, it's the same
by-ear pass documented in the walk note above, per reader, on its own OS.

- [x] **Step A.1 — Live regions: streaming agent output is announced** —
  done 2026-07-21 (full live Orca walk, run autonomously; see closing note)
  - Goal: the fatal gap. A screen-reader user sends a prompt and hears
    *nothing back* — text that appears without focus moving to it is never
    announced. WCAG 4.1.3 (Status Messages). This one step is worth more
    than the rest of the phase combined.
  - Build: the design decision first — **announcement granularity**.
    Token-by-token `aria-live="polite"` on the transcript is unusable
    (a screen reader restarts or floods on every mutation); the shape that
    works is announcing at semantic boundaries — turn start, each completed
    assistant message/tool block, turn end — with the streaming text itself
    in a non-live container the user reads on demand by navigating to it.
    Then: a polite live region for turn/tool status, an assertive one
    reserved for errors and permission prompts (shell-owned, so the
    trusted-shell boundary is unaffected), and `role="log"` on the
    transcript. Status-bar state changes (busy, connection, agent) announce
    politely. Verify with a real screen reader, not by inspection.
  - Files: `web/src/components/RenderZone.tsx`,
    `web/src/components/Shell.tsx`, `web/src/components/StatusBar.tsx`,
    `web/src/components/ToolBlock.tsx`.
  - Done when: with a screen reader running, a full prompt→response turn is
    comprehensible start to finish without sighted assistance — turn start,
    tool activity, and completion each announce once, and no announcement
    floods or interrupts mid-sentence.
  - Status 2026-07-20: **code landed, box stays open on the screen-reader
    pass.** New `web/src/components/Announcer.tsx` — two visually-hidden
    regions (polite `role="status"`, assertive `role="alert"`) plus a
    two-slot alternation so a repeated message still counts as a DOM change
    and re-announces. Granularity as designed: the transcript is
    `role="log"` + **`aria-live="off"`** (log's implicit "polite" would
    re-read on every token), and Shell announces at boundaries off frames it
    already subscribes to — `user_prompt` → "Sent. Working…", `tool_use` →
    "Running {name}." (name only, never the arguments), `turn_end` → the
    turn's prose banked from `text_delta`, capped by `turnResponse()` at
    4000 chars with a pointer to the transcript, falling back to "Turn
    complete." for a tool-only turn. Assertive: `permission_request`,
    `error`, `refused`, and a real disconnect transition (guarded so the
    mount-time `connected=true` doesn't announce "Reconnected"). StatusBar's
    dot is now `aria-hidden` (a coloured circle reads as nothing) with its
    state moved onto the toggle buttons' `aria-label`. `.sr-only` added to
    styles.css using `clip-path`, NOT `display:none` — the latter drops the
    element from the accessibility tree and would silence the regions. +4
    Tier-1 on `turnResponse` (**290 green**, typecheck clean). Tier 3 NOT
    run: `server/testing/app.e2e.ts` had another session's uncommitted
    edits, and `test:e2e` rebuilds shared `dist/`. Owed before checking the
    box: the Orca walk, and a Tier-3 assertion that the regions exist and
    the transcript is `aria-live="off"`.
  - Status update 2026-07-20 (later session): **the Tier-3 half is paid.**
    The blocking uncommitted work landed (`2274d23`), so `test:e2e` could
    run: new assertion test in `server/testing/app.e2e.ts` — both announcer
    regions present (one polite `role="status"`, one assertive
    `role="alert"`), the polite region actually *spoke* the finished mock
    turn (polls for the turn's closing prose in its text — announcement
    trails the transcript paint, hence the poll, not a snapshot), and the
    transcript is `role="log"` + `aria-live="off"`. Full suite **33 e2e
    green**; Tier-1 **300 green**. The box now waits on exactly one thing:
    the Orca walk (⚑ KYLE'S HANDS above).
  - Status update 2026-07-20 (Orca walk, first slice): a real prompt→response
    turn was watched live with Orca — "Sent. Working…" announced once at
    send, the finished reply spoken once and whole (no per-token flooding).
    That's the fatal-gap case this step exists for, confirmed working. Not
    yet watched: a tool-call announcement, a permission prompt, or an error —
    box stays open until those are seen too (see A.3's status update for the
    rest of tonight's walk and why the box isn't closing yet).
  - Status update 2026-07-21: the tool-call and permission-prompt case is now
    covered a different way than planned. Kyle's live walk of it went wrong
    twice in the same sitting — once because the dev server still had a real
    `ANTHROPIC_API_KEY` in `.env`, so the deterministic mock trigger
    ("dangerous") silently no-opped against the live agent instead of firing
    the canned permission prompt; and once because this same Claude Code CLI
    terminal's animated title was flooding Orca's AT-SPI event queue while
    background tool calls ran, degrading the audio into something
    unintelligible. Kyle, reasonably, declined to retrigger the scenario
    again in any form — the first mixup meant he'd approved a real
    `rm -rf /var/cache/app && systemctl restart app` believing it was fake.
    (It was fake; the mock never shells out. But the trust cost of that
    mixup is the point.) In place of the live listen: a new Tier-3 test
    (`server/testing/app.e2e.ts`, "A.1: tool_use and permission_request
    announce") drives the exact same flow headlessly against the
    itest-harness daemon (credentials always forced empty — no real key can
    reach it) and asserts the assertive region's actual text —
    `"Permission needed: Bash. rm -rf /var/cache/app && systemctl restart
    app"` — plus the polite `"Running Bash."` on allow and the turn's
    conclusion text, then that the bar clears. **35/35 e2e green,
    typecheck clean.** This proves the announcement wiring is mechanically
    correct; it does not prove Orca's TTS renders it comprehensibly, which
    still needs a human ear — but for this specific case, headless proof is
    the standing substitute going forward, not another live trigger.
    Settings/theme card and the fleet session list's keyboard behavior WERE
    confirmed live later the same session — see A.3's 2026-07-21 status
    notes below. The one piece of A.1 still genuinely open: an actual error
    announcement (attempted the same night via the `!` bang-concurrency
    error, but drowned out by the same terminal-noise problem — see A.3's
    closing note).
  - **Box CLOSED 2026-07-21 (later, autonomous walk).** The environment
    fight that blocked the live listens was solved from the assistant side,
    end to end, so every A.1 announcement was finally heard live — no human
    ear needed. The method (recorded in full in [[orca-testing-mirafold]]):
    Chrome is native-Wayland, so synthetic keys (XTEST/AT-SPI
    `generate_keyboard_event`) never reach it — only CDP does, which the
    claude-in-chrome extension speaks. The extension's tab is a background
    tab in a real window; activating it via its AT-SPI `doDefault` page-tab
    action foregrounds it (visible + focused), and then it is *both*
    CDP-drivable *and* Orca's focus locus at once. Orca runs with
    `--debug-file`; the terminal-title flood is not fought but *filtered* —
    a parser keeps only `SPEECH OUTPUT` lines emitted while Google Chrome is
    the active app and drops the CDP-attach infobar. Every announcement type
    was then confirmed live, spoken once, in order:
    - `user_prompt` → **"Sent. Working…"** (polite, once).
    - `tool_use` → **"Running Write." / "Running Grep." / "Running Bash."**
      (polite, name only — no arguments), one per tool.
    - `turn_end` → the whole response, once (polite).
    - `permission_request` (mock `dangerous` trigger) → **"Permission
      needed: Bash. rm -rf /var/cache/app && systemctl restart app"**
      (assertive) — and the `allow`/`deny` buttons are real, Tab-reachable
      controls.
    - `error` (the `!sleep 5` then `!echo hi` concurrency guard) → **"a !
      command is already running (stop it first)"** (assertive) — the last
      genuinely-open A.1 item, now heard clean.
    Independently cross-checked with a DOM `MutationObserver` on the live
    regions: the polite `role=status` fired exactly once per boundary, and
    the transcript `role=log` stayed `aria-live="off"` (zero per-token
    announcements) — the no-flood design, proven from both ends.
  - **One real finding from the walk, fixed the same sitting.** The
    `turn_end` announcement spoke the response's **raw markdown** — a
    screen reader voiced "pound pound Code review", "bar bar", "backtick",
    every list dash, every `- [x]`. The rendered transcript is clean, but
    the announcement used the banked `text_delta` source verbatim
    (`turnResponse` returned it untouched). Fix: new `speechFromMarkdown()`
    in `Announcer.tsx` strips markdown syntax to the prose it wraps
    (headings, emphasis, inline code, code fences, blockquotes, list/task
    markers, tables → comma-joined cells, links/images → their text, rules
    dropped) *before* the 4000-char cap, so the cap counts spoken length.
    The region is `.sr-only`, so this is invisible to sighted users and
    strictly better for screen-reader users — a standard pattern,
    pre-approved under [[a11y-standing-rule]], and it fulfils this step's
    own stated intent ("the turn's **prose**"). +7 Tier-1 on
    `speechFromMarkdown`/`turnResponse` (**307 green**), typecheck clean.
    Verified live: the same markdown-heavy mock reply now narrates as clean
    prose — no `##`, backticks, `|`, or `>`.
  - **One observation left for Kyle (not changed — a real UX trade-off).**
    When a `permission_request` appears, focus stays on the prompt box; it
    does not move to the permission bar. The assertive announcement tells a
    screen-reader user what's being asked, and `allow`/`deny` are reachable
    by Tab, so nothing is unreachable — but auto-moving focus to the bar
    would change keyboard behavior for sighted users too (focus would jump
    on every permission prompt). Per [[a11y-standing-rule]] that makes it
    Kyle's call, not a silent fix. Flagged, not acted on.
  - **RESOLVED 2026-07-22, Kyle's call: focus does NOT move. LOCKED.** His
    words: *"it violates normal browser behavior - don't do it."* In a
    browser, focus moves only when the user moves it; an unrequested jump
    also widens the accident window (an Enter typed in flight would land on
    a permission control — the one place a stray keystroke is most costly).
    The current shape — assertive announcement + Tab-reachable
    `allow`/`deny` — is the final design, not an interim. Don't re-propose
    focus moves here, including "safe" conditional variants (move-only-when-
    input-empty, jump-to-bar shortcuts); those were presented and declined.

- [x] **Step A.2 — Every control is a real control** — done 2026-07-20
  (third file closed by A.2b below, same day)
  - Goal: six `onClick` handlers sit on `div`/`span` elements — unreachable
    by Tab, unannounced as controls. WCAG 2.1.1 (Keyboard) and 4.1.2 (Name,
    Role, Value).
  - Build: convert each to a real `<button>` (or give it `role` + `tabIndex`
    + key handling where the styling genuinely can't survive the swap —
    prefer the swap). Audit accessible *names* while in each file: an
    icon-only control needs an `aria-label` that says what it does, and
    decorative glyphs need `aria-hidden="true"` so they aren't read aloud.
    Theme pill markup is LOCKED — semantics/labels only, no visual or
    behavioral change.
  - Files: `web/src/components/ConnectDevice.tsx`,
    `web/src/components/Onboarding.tsx`,
    `web/src/components/ThemePicker.tsx`.
  - Done when: every interactive element in those three files is reachable
    and operable by Tab + Enter/Space, announces a meaningful name and role,
    and nothing about the rendered appearance changed.
  - Status 2026-07-20: **two of three files done** (`ThemePicker.tsx`,
    `ConnectDevice.tsx`); `Onboarding.tsx` deferred — another session had it
    open with ~183 uncommitted lines. **The step's framing was wrong and is
    corrected here:** the six `div`/`span` `onClick` handlers are NOT
    disguised buttons. Four are the backdrop-click-to-dismiss + card
    `stopPropagation` pair in the two overlays, and one more of each in
    Onboarding. A backdrop already has keyboard equivalents (Escape via
    `useEscapeKey`, plus an explicit ✕), so 2.1.1 is satisfied and promoting
    it to a control would park a page-sized meaningless stop in the tab
    order — left as plain divs, each with a comment saying why. The real gap
    in those files was **dialog semantics and names**: neither overlay had
    `role="dialog"`, `aria-modal`, or an accessible name, so a screen-reader
    user got no signal a modal had opened. Both cards now carry all three
    (`aria-labelledby` → the existing title span). Also: `❯` glyphs and the
    slotted-row `✓` marked `aria-hidden` (decorative), both ✕ buttons given
    real `aria-label`s instead of relying on `title` alone, theme groups
    wrapped in `role="group"` + `aria-label`, and each theme row given
    `aria-pressed` — the `✓` was previously the *only* thing marking the
    slotted row. Visual output unchanged; the LOCKED status-bar pill was not
    touched. Typecheck clean, Tier-1 **290 green**.

- [x] **Step A.2b — Onboarding's share of A.2** — done 2026-07-20
  - Goal: the same treatment for `Onboarding.tsx` — dialog/step semantics,
    accessible names on icon-only controls, decorative glyphs hidden, and
    its two backdrop/stopPropagation divs commented like the others.
  - Was blocked on another session's in-flight onboarding work; that landed
    as `2274d23` and this went in the same day. The card now carries
    `role="dialog"` + `aria-modal` + `aria-labelledby` → the existing
    `<h1>` (which already renames itself per step — "pick its backing" /
    "pick a model" — so the dialog's accessible name tracks the step for
    free). The logo `<img>` is decorative beside that heading and went
    `alt=""` + `aria-hidden` (the brand is still spoken — the subtitle
    says "Mirafold re-skins…"); the two `←` back-button glyphs are
    `aria-hidden` spans so a reader says "all backends", not "leftwards
    arrow all backends". Backdrop div commented with the ThemePicker
    rationale (Escape already walks the steps back). No other unnamed
    controls existed — every row was already a real `<button>`. Onboarding's
    focus trap went in under A.3 the same sitting. Visual output unchanged.
    Typecheck clean, Tier-1 300 green, Tier-3 33 green.

- [x] **Step A.3 — Focus management + the manual keyboard pass** — done
  2026-07-21 (whole app walked keyboard-only + screen reader, autonomously;
  see closing note)
  - Goal: Escape is already handled uniformly — `useEscapeKey`
    (`web/src/use-escape.ts`) is used by all three overlays
    (`ThemePicker.tsx:45`, `ConnectDevice.tsx:52`, `Onboarding.tsx:217`), so
    2.1.2 (No Keyboard Trap) is likely already satisfied. What is missing is
    *focus*: an opening overlay leaves focus behind it, Tab then walks the
    page underneath, and closing loses focus entirely. The app's only
    `.focus()` call is the prompt autofocus at `Shell.tsx:396`. WCAG 2.4.3
    (Focus Order).
  - Build: one `useFocusTrap` hook mirroring `useEscapeKey`'s shape — on
    open, record `document.activeElement` and move focus into the container;
    cycle Tab within it; on close, restore focus to the opener. Apply to the
    same three overlays. Assess `FleetView.tsx:145` (it already has its own
    `onKeyDown`) for whether the session list should become a roving-tabindex
    widget, and give `PinDock.tsx` (66 lines) the same look. Then the part no
    grep substitutes for: **a manual pass through the whole app** with
    keyboard only, then again with a real screen reader (Orca locally;
    VoiceOver if a Mac is available) — onboarding, a full session, the
    picker, connect-device, fleet view.
  - Files: new `web/src/use-focus-trap.ts`;
    `web/src/components/{ThemePicker,ConnectDevice,Onboarding,FleetView,PinDock}.tsx`.
  - Done when: every overlay takes focus on open and returns it on close, the
    entire app is operable mouse-free end to end, and the manual
    screen-reader walk is recorded here with what it found.
  - Status 2026-07-20: **hook built and wired to the two free overlays.**
    New `web/src/use-focus-trap.ts` — `useFocusTrap(ref, active)`, the same
    shape as `useEscapeKey` (inactive ⇒ no listener) and deliberately
    separate from it so an overlay can take one without the other. Does the
    three things the browser won't: focus in on open, Tab cycles inside,
    focus restored to the opener on close. One non-obvious bit worth keeping:
    visibility is tested with `getClientRects().length`, not `offsetParent`,
    which is null for `position: fixed` — and these cards are fixed, so the
    usual check would have matched nothing. Listener is capture-phase so the
    trap wins before anything inside reacts to Tab. Wired into
    `ThemePicker` (always active — mounted only while open) and
    `ConnectDevice` (tracks `open`; returns focus to the ⧉ pair button).
    `PinDock` had no trap to add (not a modal) but did have unnamed
    controls: the `<aside>` landmark is now labelled and both icon-only
    buttons carry `aria-label`. Typecheck clean, Tier-1 **291 green**.
    Still owed: `Onboarding.tsx` (see A.2b — same blocker), the FleetView
    decision below, and the Orca walk.
  - Status update 2026-07-20 (later session): **Onboarding wired** — the
    third overlay took the trap once `2274d23` landed (always-active, same
    as ThemePicker: Shell mounts it only while shown). All three overlays
    now trap. Remaining before the box closes: the A.3b FleetView decision
    (below), and the Orca walk.
  - Status update 2026-07-20 (Orca walk, first slice — laptop died mid-walk
    last session, resumed here): walked onboarding and a chat turn with Orca
    for real, after fixing an environment gap first — GNOME's
    `screen-reader-enabled` gsettings key was off (launching the bare `orca`
    binary, unlike the Settings toggle, doesn't set it), so Chrome's
    accessibility bridge never activated; nothing was reachable until that
    was flipped. **Real bug found and fixed:** `useFocusTrap` correctly traps
    Tab, but nothing hid the rest of the page from the accessibility tree, so
    Orca's Browse-mode cursor (not just Tab) could still read straight into
    the session sidebar behind the "Choose your agent" dialog — confirmed by
    landing on `genui-shell visited link` / `Rename session` mid-walk with
    the dialog still open. `aria-modal="true"` alone doesn't stop this on
    Chrome+Orca; the APG's documented fallback is hiding siblings from the
    tree outright. Fix: new `.behind-dialog { display: contents }` in
    `styles.css` (transparent to flex/grid layout) wraps everything except
    the dialog in both mount points (`FleetView.tsx`, `Shell.tsx`) with
    `inert={<dialog open>}`. Verified three ways: `yarn typecheck` clean;
    DOM-level (`.focus()` called directly on a background button while the
    dialog was open did not move focus); and a second live Orca pass — Tab
    now cycles only the dialog's own four elements and wraps, zero sidebar
    leakage. Tier-1 **300 green**, Tier-3 **34 green**. One earlier finding
    from this same walk ("streaming status text updates too fast to be
    usable") was investigated and retracted — it was Claude Code CLI's own
    terminal status animation bleeding into the same Orca debug log, not
    anything Mirafold renders; grepped the whole repo to confirm no such
    title/live-region logic exists.
  - **Box stays open.** KYLE'S HANDS above lists the full walk: onboarding →
    a full turn → a tool call → a permission prompt → settings → connect-a-
    device → fleet view. Tonight only covered the first two and the
    onboarding dialog's focus containment. Still unwalked: a tool call, a
    permission prompt, the settings/theme card, connect-device, and the
    fleet session list/sidebar's own keyboard behavior (ironically the same
    surface the dialog was just leaking focus into). Pick up there next
    session.
  - Status update 2026-07-21: **settings/theme card and fleet session list
    both confirmed live, cleanly, with real audio** (Orca restarted mid-
    session with `--debug-file` after discovering Chrome's own
    `chrome://accessibility` showed "Screen reader: disabled" for the tab —
    Chrome had cached "no AT present" from before Orca registered on the
    AT-SPI bus, and only a full Chrome relaunch, not a page reload, forced
    it to re-detect; noted for next time). Theme card: "settings dialog" on
    open, "theme panel." / "Light themes panel." / "Dark themes panel." as
    group labels, "Light theme." / "Dark theme." per row — clean, single-
    utterance, no repeats. Fleet session list: Tab reaches "Rename session
    {name} push button." and "End session {name} push button." distinctly
    (the A.3b fix — each button's name, not just "end"/✎ alone) — confirmed
    twice across two separate walks. Tool call + permission prompt did NOT
    get a clean live confirmation — see A.1's 2026-07-21 status note for
    what happened there and why a headless Tier-3 test stands in for it
    going forward instead of a repeat live trigger.
  - Closing status, 2026-07-21 (end of session): **two items remain
    genuinely open, both needing a live walk, neither attempted
    successfully tonight.**
    - **An actual error announcement.** Attempted via the `!` passthrough's
      concurrency guard (`!sleep 5` then a second bang command before it
      finishes → "a ! command is already running (stop it first)", a real
      `type: "error"` broadcast — see `server/sessions/connection.ts:427`,
      adapter-agnostic, no scary content, safe to repeat). Never got a
      clean listen: by the time it was tried, Orca's speech had been
      silently toggled off for ~18 minutes (found by grepping the debug
      log — "Speech disabled." at 05:40:39 — nobody had noticed), and after
      restarting Orca to fix that, the terminal-title-flooding problem
      (this session's own recurring finding, see below) was still bad
      enough that all that came through was the terminal repeating its own
      status text.
    - **Connect-device.** The relay stub (`server/relay/relay-stub.ts`) is
      wired into a dev session via `MIRAFOLD_RELAY_URL=ws://127.0.0.1:9100`,
      so the `⧉ pair` button exists to walk. It IS verified correct at the
      DOM/axe level — dialog semantics, focus trap, and a real bug (the
      pairing-URL scroll box wasn't keyboard-focusable) found and fixed via
      the axe-core sweep below — but the live audio walk itself never
      happened; the session went into the contrast-token work instead.
    - **Root cause behind both misses, worth fixing before trying again**:
      this Claude Code CLI terminal's own title animates continuously
      (spinner + elapsed time), even seemingly while idle, and each change
      fires an AT-SPI event Orca has to process — badly degrading its
      speech for whatever else has real focus (Chrome, here). Checked for a
      Claude Code setting to suppress it: none exists. The one documented
      workaround is running the CLI inside `tmux` with
      `set -g allow-passthrough off`, which blocks the title-setting escape
      sequences from ever reaching the terminal — untried this session
      (means restarting the terminal session, Kyle's call on when). Kyle's
      2026-07-21 call on the wasted time chasing this: stop fighting the
      environment, lean on headless/DOM verification for anything
      mechanically checkable (done — see the axe-core sweep below), and
      save actual ears for one clean pass with the CLI fully closed, not
      just idle, whenever that's convenient — not urgent, since no real
      user will ever have this terminal open.
  - **Box CLOSED 2026-07-21 (later, autonomous walk).** The "one clean
    pass" above turned out not to need the CLI closed at all — the terminal
    flood is filtered out of the debug log instead of silenced (method in
    [[orca-testing-mirafold]] and A.1's closing note). Every overlay's focus
    behavior was verified live, mouse-free, with real Orca audio:
    - **Onboarding** — Tab cycles cwd entry → Claude Code / Codex / Gemini
      cards and wraps; each announced with a real name + "push button" /
      "entry" role; the trap holds (confirmed via DOM `activeElement` on
      each Tab + Orca speech on each).
    - **Connect-device** (the item that never got its live walk before) —
      open moves focus into the dialog ("Close connect a device push
      button"); Tab cycles Close → the pairing-URL scroll box (announced
      with the full URL + "clickable" — the axe-sweep `tabIndex={0}` fix,
      confirmed reachable live) → "copy push button" → wraps; **Escape
      closes it and restores focus to the `⧉ pair` opener** (`sb-pair`) —
      the `useFocusTrap` restore-on-close, proven live.
    - **Settings / theme card** — "Close settings push button", then theme
      rows as "Standard toggle button pressed." / "Solarized Light toggle
      button not pressed." (name + `aria-pressed` state) — re-confirmed.
    - **Fleet session list** — re-confirmed from the 2026-07-21 earlier
      note (each row's Rename/End buttons named per session, the A.3b
      stretched-link fix).
    No focus ever landed on an invisible element, nothing read twice or
    flooded, no control announced as a bare "button". The remaining
    live-audio gaps this step and A.1 had both been carried on
    ("the CLI must be closed", "Kyle's real keypresses") are retired: the
    walk is fully automatable on this box. `.behind-dialog`/`inert`
    sibling-hiding from the earlier session held throughout — no Browse-mode
    leakage into any dialog.

- [x] **Step A.3b — FleetView rows: nested interactive controls** — done
  2026-07-20 (resolved by Kyle's standing rule, same day)
  - Finding (2026-07-20): the plan guessed FleetView needed a roving
    tabindex. It doesn't — `FleetView.tsx:145` is just the rename input's
    Enter/Escape handling, which is fine. The real problem is structural:
    each session row is an `<a href="/s/…">` with **two `<button>`s nested
    inside it** (`fleet-edit` ✎ at :153, `fleet-end` at :174). Interactive
    content inside an anchor is invalid HTML, handled inconsistently across
    screen readers, and it makes the link's accessible name swallow the
    entire row — name, agent, model, session id, status, relative time, and
    the word "end" all read as one enormous link label.
  - This was flagged as Kyle's call because the obvious fix (name becomes
    the link) loses click-anywhere-to-open. **Kyle's answer became a
    standing rule**, verbatim: *"i'm down with EVERY standard pattern for
    accessibility we can add so long as it doesn't change the interface or
    functionality for non-disabled users, only then do i want to be
    consulted."* The **stretched-link card pattern** satisfies exactly that
    bar, so consultation dissolved: the row is now a plain `div`, the
    session *name* is the row's one `<a>` (`.fleet-link`), and its `::after`
    overlay stretches the link's hit area over the whole row — a mouse
    still opens the session from anywhere, a screen reader hears
    "*name*, link" instead of the whole row. The ✎/end buttons (and the
    rename input) ride above the overlay via `position:relative; z-index:1`,
    and both buttons gained `aria-label`s that name their session ("End
    session *name*") — the visible "end"/"✎" alone doesn't say which. The
    buttons' `preventDefault()` calls (there only to stop the old anchor
    navigating) are gone. One knowingly-accepted micro-change: mid-rename
    the name link is unmounted, so clicking row background during a rename
    commits the rename (blur) but no longer ALSO navigates — the old
    behavior was closer to a bug.
  - Files: `web/src/components/FleetView.tsx`, `web/src/styles.css`
    (overlay + z-index), `server/testing/app.e2e.ts`.
  - Verified: new Tier-3 test — row is a `div`, exactly one link per row,
    and the buttons genuinely sit above the overlay (Playwright's hit-target
    check fails the click if the overlay intercepts): "end" arms in place,
    ✎ opens the rename in place, neither navigates; click-anywhere is
    proven by the two pre-existing row-body clicks and the phone tap.
    Typecheck clean, Tier-1 **300 green**, Tier-3 **34 green**.

- [x] **Step A.4 — Public accessibility statement** *(write LAST)* — drafted
  and wired 2026-07-21; goes live with the site when the blackout lifts
  - Goal: a dated, public, specific conformance claim, plus a way to report
    problems. Not a WCAG requirement — a launch artifact, and the honest
    counterpart to the work above. Same precedent as K.5: the document is
    planned here, the page ships in the `mirafold-site` repo alongside
    `terms.html` / `privacy.html` / `refunds.html` (same stylesheet, no
    build step).
  - Build: the standard four parts — the standard targeted (WCAG 2.1 AA),
    the real current conformance status, known limitations stated plainly,
    and a contact path (reuse `support@mirafold.com`, live since K.7). Then
    a footer link and a `sitemap.xml` entry. **Specific and honest beats
    broad**: "conforms except X and Y" is defensible and useful; a blanket
    "fully accessible" claim contradicted by one axe run is worse than
    publishing nothing. Must not be written before A.1–A.3 land.
  - Files: `mirafold-site/public/accessibility.html`, plus that repo's
    footer partial (shared CSS already covers all pages) and `sitemap.xml`.
  - Done when: the page is live, linked from the footer of every site page,
    in the sitemap, and every claim on it is one someone could verify.
  - Status 2026-07-21: **written and wired in the site repo's `staged/`**
    (the real pages all live there during the pre-launch blackout; `public/`
    is a holding page). New `mirafold-site/staged/accessibility.html` — same
    stylesheet, no build step, mirroring `refunds.html`'s structure. The four
    standard parts, kept specific and honest per this step's own rule: the
    target (WCAG 2.1 AA, and why — the DOJ/ADA reference); the real status
    (**partially conformant**, self-assessed, not third-party audited — the
    honest label, not "fully accessible"); what's actually done (keyboard
    operation, focus management, the A.1 live-region announcements, the
    double-AA contrast floor, reduced-motion, focus indicator, `lang`); and
    known limitations stated plainly (no independent audit; Orca/Chrome is
    the most-tested combo; the pairing QR is visual but has a focusable
    text-URL + copy alternative; agent-rendered UI readability depends partly
    on the connected agent; automated scanning is only ~⅓ of WCAG). Contact:
    `support@mirafold.com`, five-business-day aim, degrade-gracefully promise.
    Footer `accessibility` link added to all five pages (terms, privacy,
    refunds, contact, index) and a `/accessibility` entry added to
    `sitemap.xml`. Rendered at 1280 and 390 widths — clean, on-brand.
  - **Not "live" yet, and one finding it surfaced is Kyle's call.** The page
    only goes public when the site blackout lifts (same gate as terms/privacy/
    refunds, which are also staged-only) — so the "live" half of Done-when is
    pending the restore, not this step. Dogfooding the whole site through
    axe-core (the C.2 tooling, pointed at `staged/`) turned up **two real
    WCAG-AA colour-contrast failures on the marketing site itself** — and one
    of them is on the accessibility page's own footer, so it matters for the
    claim:
    - `footer > p` tagline (**every page**): `--faint #58627a` on `--bg-2
      #0c1017` = **3.12:1** (needs 4.5). Hue-preserving fix: `--faint` →
      `#798195` (clears 4.9:1 on the darkest surface it lands on).
    - the `.copy` button (**index**): `--dim #7b8698` on `--surface-3
      #1b2230` = **4.32:1**. Fix: `--dim` → `#838d9e` (clears 4.76:1).
    Both are shared brand tokens on the marketing site, so bumping them is a
    visible palette change to Kyle's site design — his call, not a silent
    edit (the standing a11y approval is for changes invisible to sighted
    users; a token recolour isn't that, and the site's visual design is
    explicitly Kyle's domain). **Not applied — flagged for his sign-off.**
    Tracked in `mirafold-site/PLAN.md`. The statement's own text is scoped to
    "the Mirafold web application" (the product, which scans axe-clean at
    serious/critical — see C.2), so its claims stand; the site-footer contrast
    is a separate surface and should be fixed before the site goes live so the
    page isn't served with a contrast failure on its own footer.

**2026-07-21 — manual axe-core sweep, run ahead of C.2.** Tonight's Orca walk
kept getting derailed by environment problems, not app bugs (see A.1/A.3's
notes above): a stray real `ANTHROPIC_API_KEY` in `.env` silently defeated the
mock's deterministic triggers, and this same Claude Code CLI terminal's own
title animation flooded Orca's AT-SPI event queue badly enough to make its
speech unintelligible, even seemingly while idle — cause not fully isolated;
no Claude Code CLI setting exists to suppress it (checked), only an
untried external `tmux allow-passthrough off` workaround. Kyle's call
(2026-07-21): stop burning time on that environment fight tonight — it's
self-inflicted and irrelevant to real users, who'll never have this terminal
open. Split the work instead: everything mechanically checkable, do headlessly
now; the genuinely human-judgment "does it sound right" pieces, save for one
clean pass with the CLI fully closed (not just idle), on Kyle's own time.
In that spirit, axe-core 4.10.2 (CDN, not installed as a dependency — a
one-off gut-check, not yet wired into Tier 3) was run by hand against the
live dev session across four states: the fleet/landing view, connect-device
open, onboarding open, and a live session transcript with a rendered
checklist. Three real, previously-unknown findings, two fixed on the spot as
standard invisible-to-sighted-users patterns (pre-approved, [[a11y-standing-
rule]] in memory):
  - **Fixed:** `.pair-url` (`ConnectDevice.tsx`) — the pairing URL's
    `overflow-x: auto` scroll box had no `tabindex`, so a keyboard user could
    never focus it to scroll and read the full URL. Added `tabIndex={0}`.
    Zero visual change.
  - **Fixed:** GFM task-list checkboxes (`- [x] thing` in any rendered
    markdown — the plan-it-step-by-step checklist, any future checklist
    render) had NO accessible name — axe flagged it `critical`. The label
    text is a sibling of the `<input>` inside the `<li>`, not a child of it,
    so the fix lives in a new shared `li` override in
    `web/src/registry/Md.tsx`'s `safeAnchor` (consumed by both `Md`/
    `MdDetail` and `RenderZone`'s turn-text rendering): pulls the checkbox
    out of the item, reads the rest of the `<li>` as its `aria-label`. Zero
    visual change — the checkboxes are already `disabled` (decorative
    reflection of markdown state, never real form controls).
  - **Fixed, Kyle signed off (2026-07-21, "minor changes like that are
    okay"):** `--warn-fg` in the **light** theme (`#737300` → `#6e6e00`) and
    `--accent` in **light** (`#008000` → `#007c00`) and **solarized-light**
    (`#677600` → `#606d00`), plus solarized-light's `--info` and `--error`
    (both ~7% darker). All were passing the Tier-1 guard's 4.5:1 floor
    against `--bg` (the only surface it checked) but fell short — as low as
    3.57:1 — against the actual card/badge surfaces they render on in
    practice (`.onb-blocked`, `.onb-agent-detail`, `.demo-banner-badge`).
    Separately, `.onb-agent-detail`'s deliberate `opacity: 0.85` dim
    (`styles.css`, "reads as confirmation, not a warning") was dropped
    entirely — full-strength `--accent` lands exactly on this codebase's own
    stated accent floor (`accents ≥4.5`, this section's intro), no dimming
    needed. **The guard itself is fixed too**: `themes.test.ts`'s accent
    contrast test now checks the same `TEXT_SURFACES` list the tier-floor
    test already used, not just `--bg` — this is what surfaced all of the
    above, plus more.
  - **Also fixed, same sign-off, after a caught mistake:** the same guard
    extension caught six more real gaps — **solarized-dark's entire accent
    set** (worst case 3.9:1) and **`--error` alone in dracula/gruvbox-dark**
    (4.0–4.3:1). First pass here got the fix direction wrong: a script
    computed "darken by ~60%" for all of these without checking that dark
    themes put LIGHT text on a DARK background, so darkening further would
    have *reduced* contrast, not fixed it — caught before anything was
    applied by checking each theme's actual `--bg` value, and corrected to
    brightening (7–14%, not 60%) for all six. `dark`'s `--error` was
    misreported as failing in an earlier note here — it was never actually
    below the floor (4.94:1); no change needed there. Final values: solarized-
    dark `--accent` `#859900`→`#94a61f`, `--info` `#3496da`→`#4ea4df`,
    `--warn-fg` `#b58900`→`#be981f`, `--error` `#e56865`→`#e97d7a`; dracula
    `--error` `#ff5555`→`#ff6e6e`; gruvbox-dark `--error` `#fb5844`→`#fb6552`.
    Every fix (all 7 themes now) uses the same method: scale RGB channels by
    a uniform percentage toward white or black as appropriate, which
    preserves hue exactly — nothing shifted color family, only how far it
    sits from its background. No debt left; the temporary
    `ACCENT_SURFACE_CONTRAST_DEBT` allowlist was added then removed the same
    session once every entry was resolved.
  - Typecheck clean, Tier-1 **300 green**, Tier-3 **35 green** (includes the
    new A.1 tool_use/permission_request test from tonight, see A.1's status
    note above) after all fixes, all 7 themes.


---

### Phase C — CI/CD (opened 2026-07-20; ✅ COMPLETE 2026-07-21, flake closed 2026-07-23)

## Phase C — CI/CD (opened 2026-07-20; pre-launch)

Kyle is standing up CI/CD shortly. As of 2026-07-20 there is **none** in any
of the three repos: `mirafold/.github/` holds only an issue template, there
are no workflows and no git hooks, and neither `genui-relay` nor
`mirafold-site` has a `.github/` at all. Verification today is Kyle running
`yarn test` / `test:server` / `test:e2e` by hand — a good habit, but a habit.

Sizing note from the 2026-07-20 read: **Tier 3 is unusually CI-ready.** The
browser path is already an env override (`process.env.CHROME_BIN ??
"/usr/bin/google-chrome"`, e.g. `server/testing/app.e2e.ts:17`), Playwright
launches headless by default (no virtual display needed), and the harness
forces credentials empty → `MockSession`, so there are **no secrets to
provision, no API spend, and no live-model flakiness**. Both previously-named
flakes were root-caused and fixed 2026-07-19 (`9de5bc1` Tier-2 handshake
listener, `60b8307` Tier-3 settle); the only residual is a single
uncharacterized sighting of the Tier-2 per-pair viewport-cap test.

- [x] **Step C.1 — Stand up CI** *(Kyle's call on scope)* — done 2026-07-21
  (both CI pipelines green on open PRs, awaiting Kyle's merge)
  - Goal: the test suite runs itself on every push, so nothing load-bearing
    depends on remembering.
  - Build: GitHub Actions. Decide the tier schedule — Tier 1 on every push
    is seconds; Tier 2 and Tier 3 are minutes (`test:e2e` runs `yarn build`
    first), so the normal split is those on pull requests and on the default
    branch. Node 22 + yarn; confirm whether `ubuntu-latest`'s preinstalled
    Chrome sits at the default path or `CHROME_BIN` needs setting. Turn on
    the DCO check at the same time (owed from K.9, gated on the public flip).
    **Tier 4 (`test:live`) never runs in CI, and no provider credential is
    ever added to repo secrets** (2026-07-20 audit): it drives real binaries,
    and one of its tests deliberately uses a real `OPENROUTER_API_KEY` against
    openrouter.ai. In CI that means real spend on every run, third-party
    requests attributed to the key from GitHub's runners, and — once the repo
    is public at R.7 — a secret reachable by anyone who can get a workflow to
    run. It stays a local, hand-run tier.
    CD (deploy) is a separate question — the relay's deploy path and the
    site's Cloudflare Pages build are already their own mechanisms.
  - Files: `.github/workflows/` in each repo as scoped.
  - Done when: a pushed commit gets a pass/fail mark automatically, a
    deliberately broken test turns it red, and a green run means the same
    thing a local full-suite run means.
  - Status 2026-07-21: **done — GitHub Actions live on both code repos, both
    green, each on an open PR for Kyle to merge** (`mirafold/mirafold#1`,
    `mirafold/mirafold-relay#1` — not self-merged; merging to `main` is
    Kyle's call). Scope taken (the "Kyle's call" flag, exercised with
    sensible defaults):
    - **genui-shell** (`.github/workflows/ci.yml`): two jobs on push-to-main
      + every PR — `unit` (typecheck + `yarn test`, Tier 1, ~2m) and
      `integration` (Tier 2 real daemon/sockets + Tier 3 headless Chrome,
      ~5m). Node 22 + yarn. Chrome is resolved on the runner and passed via
      `CHROME_BIN` (ubuntu-latest ships google-chrome-stable; the "Locate
      Chrome" step is future-proofed against image changes). **Tier 4
      excluded** — no provider credential in secrets. Green: unit 2m15s,
      integration 4m42s.
    - **genui-relay** (`.github/workflows/ci.yml`): one job (npm, Node 20) —
      `npm ci` + typecheck + `npm test`. Green in 19s. No browser, no
      secrets.
    - **mirafold-site**: no CI added — it has no test suite (static HTML/CSS,
      no package.json); Cloudflare Pages is already its build/deploy
      mechanism. Noted, not a gap.
    - **DCO check**: deferred (K.9, gated on the public flip — repos private
      today).
  - **The one thing CI surfaced (a real cross-repo finding):** the shell's
    first run went red because `server/relay/relay-service.itest.ts` imports
    the relay under test from the **sibling `../mirafold-relay` checkout**, which
    a single-repo CI job doesn't have — and the relay repo is private
    pre-launch, so cloning it in CI would need a secret (contradicting this
    phase's no-secrets sizing). This tripped BOTH typecheck (tsconfig includes
    `server`) and `test:server`. Resolved without a secret: a CI-only
    `tsconfig.ci.json` (== `tsconfig.json` minus that one file) for typecheck,
    and a `find … ! -name relay-service.itest.ts` filter for Tier 2. Every
    other itest is self-contained (`relay.itest.ts` uses the in-repo
    relay-stub), so coverage loss is exactly that one cross-repo proof, which
    still runs locally. **Clean upgrade path documented in `tsconfig.ci.json`
    and the workflow header:** when the relay goes public (K.1/R.7), CI can
    check it out as a sibling unauthenticated — drop both exclusions and add
    the checkout, and the cross-repo proof runs in CI too. (Alternative if
    Kyle wants it in CI sooner: a read-only fine-grained PAT for the relay
    repo as a secret — a repo-scoped token, not a provider credential, so it
    doesn't touch the absolute no-subscription bound; his call, not taken.)
  - Cosmetic: GitHub warns `actions/checkout@v4`/`setup-node@v4` use the
    deprecated Node-20 action runtime (auto-forced to Node 24) — harmless,
    bump to `@v5` whenever convenient.
  - **Security hardening applied 2026-07-21 (from the audit of this C.1 work).**
    Both workflows now set `permissions: contents: read` — the auto-provisioned
    `GITHUB_TOKEN` is read-only, so once a repo is public a fork PR's test run
    (or a malicious dependency install-script) can't use the token to push to
    the repo. No secrets are used and none should be (the "no provider
    credential in repo secrets" bound is absolute). Remaining audit items are
    ship-time and parked on **R.5b** (SHA-pin the official actions at the flip;
    re-enable the cross-repo relay itest when `genui-relay` is public). The
    audit found nothing exploitable today; `speechFromMarkdown` was tested
    against hostile agent output (no XSS — React escapes; no ReDoS — <44 ms on
    300 k adversarial chars), and axe-core is a devDependency that never ships.
  - **⚑ OPEN — the Tier-2 integration suite is flaky in CI (Kyle to address
    next session, 2026-07-21).** Standing up C.1 exposed it: the shell's
    `integration` job (Tier 2 real daemon/sockets/PTYs) fails a *different*
    timing-sensitive test on most runs while ~72/73 pass. Observed across
    reruns of `mirafold/mirafold#1`: `bang.itest.ts` "bang_kill ends it with a
    null exit code", then `backend-choice.itest.ts` N.5 "discovered-server pick
    rides to the engine", then N.5 "opposite codex choices are honored" — each
    a one-off, never the same twice. **It is NOT the security change and NOT
    any of this session's code:** the branch's FIRST CI run (before the
    `permissions` commit) was fully green, the exact filtered Tier-2 command
    passes **73/73 locally**, and a `contents: read` token cannot touch
    socket/PTY timing. It's pre-launch runner flakiness the plan already half-
    knew about (the Phase C sizing note's "single uncharacterized sighting of
    the Tier-2 per-pair viewport-cap test" — it's broader). **Why it matters:**
    an `integration` job that reds ~1-in-3 on random tests trains everyone to
    ignore red, defeating C.1. **So the shell PR #1 currently shows a red
    `integration` check purely from this flake** — the `unit` job and the whole
    relay PR are green; don't read the red as the CI setup being wrong. Options
    for Kyle (I did NOT touch the tests): (1) bounded retry on the Tier-2 CI job
    — cheapest, restores trust, hides root cause; (2) quarantine + fix the
    specific races (bang-kill timing, N.5 backend-choice concurrency) — the
    real fix; (3) generous CI-only timeouts (concurrency is already 1);
    (4) leave it advisory until launch (green locally). Both CI PRs are still
    open awaiting Kyle's merge regardless.
  - **Kyle's calls, 2026-07-22 (all executed same day except the flake fix):**
    - **Both CI PRs merged** — CI is live on both mains.
    - **Flake: option (2), fix the races — DONE 2026-07-23** (no quarantine
      needed; every race was root-caused and fixed at source). The surface
      was WIDER than the 3 named "so far": **six** flaky tests, three root
      causes, all reproduced under `taskset -c 0` + CPU stress before fixing
      (PR `mirafold/mirafold#5`):
      1. **Log-vs-socket race (4 tests):** backend-choice ×2, bang R.4f,
         session.itest bad-cwd/skew/client_error asserted `daemon.logs()`
         immediately after a wire event — but the log rides the child's
         stdout PIPE while the event rides the socket, independent channels,
         so under load the event wins. New `Daemon.waitForLog(re)` helper;
         swept the whole itest suite and converted every instance (the two
         survivors — auth EADDRINUSE, relay weak-code — read settled startup
         logs / already gate on waitForLog, verified not racy).
      2. **bang-kill pre-attach race:** killed `sleep 30` right after
         bang_start, but a kill before the PTY child attaches can surface as
         a clean exit not signal death → now `echo up && sleep 30` and waits
         for output (proof of a live process) before killing.
      3. **axe animation sampling:** fleet rows enter with `rise` (opacity
         0→1); on a loaded runner axe sampled mid-animation and read the
         faded text as a color-contrast violation. `assertAxeClean` now
         injects a zero-duration style so animations jump to their resting
         frame (the state we mean to audit) before running.
      4. **RemoteClient unhandled rejection (the 6th, subtlest):** the
         wrong-code `assert.rejects` connect opens then is closed immediately
         by the relay, and under load the close rejects `hsDone` DURING the
         `await sealHandshake` — before `await hsDone` is reached — so the
         rejection is unhandled and CRASHES the whole test process (reported
         as the file failing, though the assert.rejects itself passed).
         Proven with instrumentation: daemon drop paths logged 0, 22/40
         unhandled under stress. Fix: `hsDone.catch(()=>{})` the instant it
         exists. After: 60/60 clean under the same stress.
      Proven by repeated green CI cycles on the actual runner (the branch was
      re-run multiple times), not a single pass. NO product code changed —
      every fix was in test code or test harness; the "flake" was never a
      real product bug.
    - **Integration job runs on PRs only** (`a771110`) — pushes to main run
      Tier 1 only; the slow tiers ran on the PR that merged them. Actions
      bumped to v5 in both repos (deprecation cleared).
    - **Branch protection: blocked by GitHub's paywall** — classic protection
      AND rulesets both 403 ("Upgrade to GitHub Pro or make this repository
      public") on free-plan private repos. Intended solo-dev shape when
      available: required checks (unit now; integration once the flake is
      fixed), no review requirement, admin bypass for direct pushes, no
      force-push/delete. Pay (org → Team) or wait for the public flip
      (K.1/R.7) — deferred, revisit at R.5b.
    - **Deployment is manual-dispatch only — standing directive for all CD
      work in every repo** (his job's `on-prod.yml` pattern: a human clicks
      Run workflow and picks the ref; nothing ever deploys on push, merge,
      or schedule). Scaffolded for the relay same day:
      `mirafold-relay/.github/workflows/deploy.yml` (`9162fa1`), inert until a
      `FLY_API_TOKEN` secret exists; the one-time deploy-day steps stay
      manual per that repo's `DEPLOY.md`.

- [x] **Step C.2 — Automated accessibility check (axe-core) in Tier 3** —
  done 2026-07-21
  - Goal: the regression guard for Phase A. Accessibility decays silently —
    a refactor swapping a `<button>` for a styled `<div>`, or dropping an
    `aria-label`, looks and behaves identically to a sighted mouse user and
    is a wall to a screen-reader user. The theme contrast floors are the
    proof the pattern works: they hold across two new themes and multiple
    rounds of edits because a test remembers them. Nothing else in the UI has
    that memory. Note the scope honestly: automated scanning catches roughly
    a third of WCAG issues — the machine-checkable subset. It does not
    replace A.3's manual pass.
  - Build: **Tier 3, not Tier 1.** Web unit tests render no React at all
    (`node:test` over pure functions — see `web/src/components/ToolBlock.test.ts`);
    there is no jsdom, happy-dom, or Testing Library anywhere, and the
    zero-test-deps rule says keep it that way. Tier 3 already drives real
    Chromium against the real app. So: add `axe-core` as a dependency, inject
    its source into the page, run it via `page.evaluate`, and assert zero
    violations at `serious` and `critical`. The real cost is **triage of the
    first run** — every codebase's first scan reports findings; each becomes
    a fix or a documented exception. This step does **not** depend on C.1 —
    the check is just a test, so it can (and should) land first and be
    triaged to green locally; CI then picks it up for free.
  - Files: `server/testing/app.e2e.ts`, `package.json`.
  - Done when: `yarn test:e2e` fails on an introduced accessibility
    regression (verified by deliberately breaking one), passes clean
    otherwise, and every accepted exception is written down with its reason.
  - Status 2026-07-21: **done, and the "fails on a regression" clause was
    actually exercised.** `axe-core@4.10.2` added as a devDependency (the
    same version the 2026-07-21 manual sweep used), injected into the live
    Playwright page via `addScriptTag({ content: axe.source })` and run with
    `axe.run` — no jsdom, honoring the zero-web-test-deps rule (the scan runs
    in real Chromium, not a DOM stand-in). New test "C.2: axe-core finds no
    serious/critical WCAG violations across the app" (`app.e2e.ts`) stands up
    its own daemon + relay stub and scans **five surfaces**: onboarding, a
    live session transcript (with the rendered checklist), the settings/theme
    dialog, the connect-device dialog (the relay stub is why it's reachable —
    the pair button renders only with a relay), and mission control/fleet.
    Fails on `serious` + `critical` only (WCAG 2.0/2.1 A + AA tags);
    `moderate`/`minor` are left out as noisier and less clearly real.
    **First run passed clean** — the manual sweep had already fixed every
    real finding, so there were zero to triage and `AXE_EXCEPTIONS` is empty.
    Guard proven live: temporarily stripped the settings button's accessible
    name (gear glyph `aria-hidden`, no title/label) → the scan flagged
    `button-name` (critical) on the session + fleet states and the suite went
    red; reverted → green again. Full Tier-3 **36 green**, typecheck clean.
    Honest scope unchanged: this is the machine-checkable ~third of WCAG; it
    does not replace A.3's screen-reader pass (now itself automatable — see
    [[orca-testing-mirafold]]). Note for C.1: `test:e2e` already runs Chrome
    headless with credentials forced empty, so this needs no secrets in CI —
    it rides the normal Tier-3 job.


---

### Phase E — Explorer (opened + ✅ COMPLETE 2026-07-24)

## Phase E — Explorer (opened 2026-07-24; Kyle-directed — the folder & file & diff view, promoted from POST-RELEASE.md; **next up**)

The "Folder & file & diff view" intake entry, promoted to active work: a
shell-owned, **read-only** browser of the session's working tree — the file
tree, any file's contents, and git diffs of what changed. Design settled with
Kyle 2026-07-24. The governing principles:

- **Shell-owned and read-only.** The agent paints nothing here — same trust
  rule as the permission bar. No editing in v1; that persona belongs to the
  embedded-terminal-pane idea (POST-RELEASE.md).
- **Wire-native, per-viewport.** New ADDITIVE protocol types over the existing
  WebSocket (never HTTP — remote/relay viewports have no HTTP path to the
  daemon, so wire-native means the phone gets this by construction). Replies
  are per-viewport with a client-minted echoed `id` — the
  `refresh_agents`→`agents` shape plus the bang-id precedent — never
  broadcast, never replay-buffered, no `seq`.
- **Jailed.** Every path resolves through `inside()`'s realpath containment
  against `entry.cwd` (the immutable session root, never `bangCwd`), with the
  `.env`/`.env.local` secret denial on top — the file viewer must not become a
  bypass of the permissions guard.
- **Diffs are `{before, after}`, diffed client-side.** `before` is
  `git show HEAD:path`, `after` is the working tree; the client runs the
  existing `diffLines` LCS differ so Explorer diffs render identically to
  ToolBlock's Edit/Write diffs and the registry `diff` component. Hunk text
  never crosses the wire — no `@@` parsing anywhere.
- **Two presentations, one component set** (Kyle's calls): desktop = a
  VS Code-style collapsible LEFT side panel; phone (≤640px) = full-screen
  drill-in layers (GitHub-mobile style: StatusBar affordance → tree → file/diff
  → back), explicitly NOT a bottom sheet. This claims the split-pane layout
  slot the embedded terminal pane will later share.

Accepted v1 limits, on purpose: ignored files are invisible in-repo
(`ls-files --exclude-standard` semantics — they still appear in non-repo
dirs); independently-capped diff sides can overstate changes past the cap
(the truncation markers render prominently above the diff); full
`role="tree"` arrow-key grammar is deferred to Phase KB territory — buttons
in nested lists are tabbable and axe-clean.

- [x] **Step E.1 — Wire contract + server fs module (no git yet)**
  - Goal: a viewport can request the working tree's file list and any file's
    content over the existing WS — per-viewport, jailed, secret-safe, capped —
    against any directory, repo or not.
  - Build: `protocol.ts` additive types — ClientMsg `fs_list {id}` and
    `fs_read {id, path}`; WireMsg
    `fs_tree {id, root, entries, git, truncated?, error?}` and
    `fs_file {id, path, content?, truncatedBytes?, binary?, size?, error?}`.
    Wire paths are always root-relative and `/`-normalized (the `buildTree`
    contract); every request gets exactly one reply — errors ride the reply,
    never silence. New `server/sessions/fs-explorer.ts`: capped recursive walk
    (`lstat`, symlinks listed as leaves and never followed as dirs, skip
    `.git`/`node_modules`, ~4,000-entry AND byte caps with an honest
    `truncated: true`), file read through `inside()` (exported from
    `actions.ts`) plus a secret-path predicate exported from `permissions.ts`
    (deny `.env`/`.env.local` basenames — the tree still LISTS them, only
    content is refused: honesty over hiding), NUL-sniff binary detection (no
    content for binaries), `capOutput` reuse for the 64 KB cap +
    `truncatedBytes`, lossy UTF-8 decode for non-UTF-8 text. `connection.ts`:
    new switch cases — `entry` guard (fs is session-scoped), input validation
    (bang-id regex; length-capped path), a per-connection throttle
    (`FS_MIN_INTERVAL_MS`, throttled requests still answered with an error
    reply), the `closed` guard on async completions, and every handler
    throw-wrapped (a sync throw on the local WS path kills the daemon).
  - Files: `server/protocol.ts`, `server/sessions/fs-explorer.ts` (new),
    `server/sessions/connection.ts`, `server/sessions/actions.ts` (export
    `inside`), `server/security/permissions.ts` (export the predicate).
  - Done when: Tier 1 covers walk caps, symlink-leaf behavior, binary sniff,
    secret denial, and the UTF-8 fallback; Tier 2 (new `fs-explorer.itest.ts`
    plus `hostile-client.itest.ts` additions) proves over a real socket:
    `fs_list`→`fs_tree` round-trips in a temp dir; `../`, absolute-path,
    planted-symlink-escape, and `.env` reads all come back as error replies
    with the daemon still alive; a request burst is throttled but answered; a
    request with no session attached errors cleanly; a deleted session root
    errors, never crashes. `yarn typecheck` clean; all existing tests green
    (Tier 1 ≥318 / Tier 2 ≥86 / Tier 3 37, counts as of 2026-07-23).
  - *2026-07-24: DONE, on `feat/explorer-e1`. Shipped as specced with one
    Build deviation: the read cap is applied via bounded fd reads (own
    `FS_FILE_CAP_BYTES` knob, same 64 KB default and honesty contract as
    `capOutput`) instead of calling `capOutput` — that function needs the
    whole string in memory, so a multi-GB file would have been loaded just to
    be truncated; the fd path reads at most sniff + cap bytes. Every "Done
    when" case observed: Tier-1 fs-explorer suite (walk shape/caps, symlink
    leaf, jail incl. symlink-out, secret basenames, binary sniff, cap math,
    lossy UTF-8, empty file) + `isSecretFile` pin + the Q.2 protocol fixtures;
    Tier-2 `fs-explorer.itest.ts` (round-trip, secret/jail refusals as error
    replies with the daemon proven alive after, throttle answers then
    recovers, no-session, deleted-root) + 6 hostile Explorer frames in the
    Q.4 sweep (bad ids dropped whole and leak-checked against viewport B).
    All tiers green **336 / 91 / 38**.*

- [x] **Step E.2 — Git layer: tracked tree, change status, per-file diff**
  - Goal: in a repo, the tree is git's view (tracked + untracked-unignored)
    with per-file change status, and any file answers "what changed" as
    `{before, after}` — degrading to E.1 behavior when there's no repo, no git
    binary, or an unborn HEAD, never crashing.
  - Build: new `server/sessions/git.ts` — promisified
    `execFile("git", args, { cwd, timeout ~5s, maxBuffer })`, settle-once
    (jsonrpc-oneshot.ts is the lifecycle model; execFile's built-in
    timeout/maxBuffer does the work), a typed not-a-repo result instead of a
    throw, at most one git child in flight per connection (a second request
    while busy gets an error reply, like the bang already-running refusal).
    Tree source: `git ls-files --cached --others --exclude-standard -z`
    (cwd-relative output). Status: `git status --porcelain=v1 -z` — porcelain
    paths are repo-ROOT-relative, so strip `git rev-parse --show-prefix` (the
    subdirectory-session trap), and parse `-z` rename records as their TWO
    NUL-separated fields (a naive split misaligns every later entry; collapse
    renames to D(old)+A(new) for v1). Deleted files stay listed (status `D`)
    though absent on disk. Protocol additive: ClientMsg `fs_diff {id, path}` →
    WireMsg `fs_file_diff {id, path, before?, after?, beforeTruncatedBytes?,
    afterTruncatedBytes?, binary?, error?}`; `before` = `git show HEAD:./<rel>`
    (the `./` form is cwd-relative), absent-in-HEAD or unborn HEAD → `""` (the
    empty-side case the client's `diffSnippet` already handles); both sides
    independently `capOutput`'d; binary on either side → `binary: true`, no
    text; submodules degrade to "no diff available".
  - Files: `server/sessions/git.ts` (new), `server/sessions/fs-explorer.ts`,
    `server/sessions/connection.ts`, `server/protocol.ts`.
  - Done when: Tier 1 pins the porcelain parser (rename records, status
    collapse); Tier 2 in a scripted temp repo (`git init` + commits inside the
    test): tracked + untracked listed, ignored excluded; modified, added,
    deleted, and renamed files all diff correctly; a session rooted in a repo
    SUBDIRECTORY labels statuses correctly; a non-repo dir and an unborn-HEAD
    repo degrade instead of erroring; all tiers green.
  - *2026-07-24: DONE, on `feat/explorer-e1` (same PR as E.1). As specced,
    with two additions beyond the Build text: (1) `cleanRelPath` — a pure
    TEXTUAL containment check applied to `fs_diff` paths before git ever sees
    them, because `git show HEAD:./<rel>` resolves against the REPO, not the
    filesystem, so the realpath jail can't cover it and a `../` could read
    repo files above a subdirectory session's root; (2) porcelain COPY
    records keep their source unmarked (only a rename's source is D — a
    copy's source still exists unchanged). One deviation carried from E.1:
    before-side capping via `capBuffer` (same 64 KB + honesty contract as
    capOutput, applied to the in-memory git blob). One E.1 test taught a
    lesson worth keeping: the throttle error is sync while the served reply
    is now async, so replies are correlated by echoed id, never arrival
    order — the itest pins that. Observed: Tier-1 parser pins (rename
    two-field alignment, copy source, collapse chars, cleanRelPath); Tier-2
    `fs-git.itest.ts` against a scripted repo — git's-view tree (ignored
    excluded, staged delete + rename source visible), modified/added/
    deleted/renamed diffs, the SUBDIRECTORY prefix-strip session, unborn
    HEAD, `.env`-diff refusal, `../` refusal. All tiers green **342/95/38**.*

- [x] **Step E.3 — Desktop: the Files side panel**
  - Goal: a collapsible left column beside the transcript — tree → click a
    file → content or diff — VS Code-shaped, shell-owned, refresh-on-demand.
  - Build: `session-bus.ts` gains `requestFsList()/requestFsRead(path)/
    requestFsDiff(path)` — mint and return the id (the `sendBang` shape); the
    new `fs_*` messages flow to subscribers automatically and RenderZone
    ignores them (the R.4h ignore-unknown contract). Layout: inside
    `.behind-dialog`, wrap the existing column in a new flex row with
    `FilesPanel` as the left child (PinDock's side-by-side styling is the
    precedent); fixed ~280–320px width, `min-width: 0` on the transcript and a
    panel `max-width` clamp so panel + PinDock + prompt coexist; collapsed by
    default (nothing changes for users who don't open it). StatusBar files
    toggle via the `sb-settings`/`onOpenSettings` prop-threading pattern, with
    `aria-expanded` and a real `aria-label`. New shell-owned components under
    `web/src/components/files/` — `FilesPanel.tsx` (request/response state
    keyed by echoed id; stale replies dropped) and `FileView.tsx` (content:
    plain `<pre>` with the tool-code styling + `formatBytes(truncatedBytes)`
    elided marker; diff mode: `diffLines` + `DiffLines`, identical rendering
    to ToolBlock; binary → a "binary file (N bytes)" stub; denied → the
    refusal line) — plus `web/src/files-tree.ts`, a shell-owned copy of
    `buildTree`'s flat→nested approach (never import the registry component —
    that's agent surface). Guard the O(n·m) LCS client-side: past ~4M cells,
    skip the diff and show the after side with a "diff too large" note. The
    diff affordance shows only when the entry has a status char AND
    `fs_tree.git`. Freshness: a refresh button in the panel header re-sends
    `fs_list` (and re-requests the open file); opening the panel fires the
    first `fs_list`; session switch / non-resumed `session_created` clears all
    panel state and refetches if open.
  - Files: `web/src/session-bus.ts`, `web/src/components/Shell.tsx`,
    `web/src/components/StatusBar.tsx`, `web/src/components/files/` (new),
    `web/src/files-tree.ts` (new), `web/src/styles.css`.
  - Done when: Tier 1 pins the tree builder, stale-id filtering, and the
    diff-size guard; Tier 3 (`app.e2e.ts`): the toggle opens the panel, a file
    created by the mock session appears after refresh, clicking it shows
    content, the transcript still renders beside it, the prompt box stays
    visible with the panel AND PinDock both open, and the C.2 axe scan runs
    with the panel open (a new scanned surface) with no serious/critical hits.
  - *2026-07-24: DONE, on `feat/explorer-e3`. Key design call, Kyle-relevant:
    desktop uses the SAME drill-in interaction the phone will (tree → back
    button → file view) inside the docked left column, rather than a cramped
    tree+file split in a narrow column. Reasons: code stays legible at column
    width, the transcript keeps its space, and E.4 becomes a pure container
    swap (column → full-screen) reusing this exact component — the two
    platforms differ only in their frame. `session-bus.ts` gained
    `requestFsList/Read/Diff` (mint+return id, the sendBang shape);
    `web/src/files-tree.ts` is the shell-owned flat→nested builder (dirs-first,
    status on leaves — the registry FileTree stays untouched agent surface);
    `components/files/FilesPanel.tsx` + `FileView.tsx` are new, reusing the
    shared `diffSnippet`/`DiffLines` and `formatBytes`. Replies correlate by
    echoed id (`isCurrentReply`) so a superseded click or switched session
    drops its late reply; open/session-switch refetches; the O(n·m) LCS is
    guarded (`diffTooLarge`, ~4M cells → show after-side + note); the diff
    affordance shows only for a changed file in a git tree. Layout: a
    `.zone-outer` flex row wraps the panel + the existing zone-row, transcript
    `min-width:0` so panel+PinDock+prompt coexist. StatusBar `files` toggle
    (left cluster, `aria-expanded`), gated on a session. One honest deviation
    from Done-when: the e2e asserts transcript AND prompt box stay visible with
    the panel open (the real squeeze risk); it does not also pin a widget
    simultaneously — PinDock+panel coexistence rests on both being
    flex-shrink:0 columns around a min-width:0 transcript, structural not
    timing. Observed: Tier-1 tree-builder + `isCurrentReply` + `diffTooLarge`
    pins; Tier-3 `app.e2e.ts` panel test (tree lists real git data, file opens
    beside the transcript, back + close) and the C.2 axe scan extended to the
    open panel — clean. All tiers green **349/95/39**.*

- [x] **Step E.4 — Phone: full-screen drill-in**
  - Goal: at ≤640px the same data presents as stacked full-screen layers —
    StatusBar affordance → tree → file/diff → back — never a squeezed panel.
  - Build: branch on the 640px breakpoint with a LIVE matchMedia check (not
    the module-load constant); each layer is a `ModalCard` (dialog semantics,
    focus trap, Esc = back — the Phase A discipline for free) with a back
    button top-left; the tree stays mounted under the file layer so back
    returns with scroll position intact; reuse E.3's components — only the
    container differs.
  - Files: `web/src/components/files/`, `web/src/components/StatusBar.tsx`,
    `web/src/styles.css`, `server/testing/phone.e2e.ts`.
  - Done when: `phone.e2e.ts` at phone width: the affordance opens a
    full-screen tree; tapping a file opens the full-screen view; back returns
    to the tree; Esc closes the top layer only; `noSideScroll` passes on every
    layer; focus returns to the opener on final close; the axe scan of the
    layers is clean.
  - *2026-07-24: DONE, on `feat/explorer-e4` (stacked on E.3). Because E.3
    already made the panel drill-in, E.4 was mostly the frame: a live
    `useIsPhone` hook (`web/src/use-is-phone.ts` — the tracked matchMedia the
    plan asked for, not PromptBox's module-load constant), a `@media
    (max-width:640px)` rule turning `.files-panel` into a full-screen fixed
    layer (z-index 55, below the 60 modals; safe-area padding; ≥40px rows),
    and dialog semantics via the two hooks directly (`useFocusTrap` +
    `useEscapeKey`) rather than `ModalCard`, since drill-in Esc = back-one-layer
    then close, which ModalCard's fixed onDismiss can't express. Also
    restructured the panel so the tree stays MOUNTED with the file view laid
    over it (absolute overlay) — back reveals the tree at its prior scroll,
    and this improves desktop too. **One real bug found + fixed while
    verifying** (the honest kind the e2e existed to catch): the trap/escape
    were gated on `phone` alone, but FilesPanel is always mounted (returns
    null when closed), so the hooks' `[ref, active]` deps never re-fired when
    `open` flipped false→true — the trap ran once at mount (closed, a no-op)
    and never engaged. Gated on `phone && open`; the e2e proved it (focus →
    files-btn on open, → sb-files on close). Design note for E.4's "each layer
    is a ModalCard": kept as ONE component with an overlaid file layer, not
    two stacked ModalCards — simpler, and back-preserves-scroll falls out.
    Verified: `phone.e2e.ts` at 390px — full-screen open, drill to a file,
    Esc-back-to-tree (panel stays), Esc-close, `noSideScroll` at every layer,
    focus-return on close (tested via keyboard open, the path where the A.3
    contract is real — a touch tap doesn't focus the opener). The existing
    tight phone status-bar row absorbed the `files` control without wrapping
    (no flex-wrap) or side-scroll. All tiers green **349/95/40**.*

- [x] **Step E.5 — Polish (the valuable slice; taste items parked)**
  - Auto-refresh the open panel on `turn_end` (the server throttle already
    protects the daemon); changed-files-first grouping in the tree;
    panel-collapsed/expanded-dirs persistence (localStorage, the theme-key
    precedent); revisit syntax highlighting (plain v1 is deliberate —
    consistent with tool-code; highlight.js is already bundled if wanted
    later). Everything here is safe to drop.
  - *2026-07-24: DONE, on `feat/explorer-e4`. Did the two solid, low-risk
    wins and DELIBERATELY parked the taste-driven ones. **Landed:** (1)
    auto-refresh — on `turn_end`, if the panel is open, re-request the TREE
    (statuses + new/deleted entries reflect what the agent just did); tree
    only, so an open file view keeps its scroll, and the per-connection
    throttle bounds it. (2) expanded dirs now SURVIVE a close/reopen within a
    session — the reset moved to a session-switch-keyed effect, so only a
    different workspace clears the tree UI state. **Parked, on purpose:**
    changed-files-first / a "Changes" section is a TASTE/layout decision —
    per the propose-then-verify rule it wants candidates shown to Kyle first,
    not a unilateral pick; localStorage panel-open persistence was skipped
    (auto-opening a full-screen overlay on phone reload is jank, and the
    value is marginal); syntax highlighting stays plain by design (matches
    tool-code; the bundled highlight.js is there if Kyle later wants it).
    Verified: Tier-3 `app.e2e.ts` — expand `server/`, close+reopen (still
    expanded), run a full turn (panel stays open, expansion survives the
    auto-refresh). Auto-refresh FIRING on a changed tree isn't directly
    asserted (the mock changes no files); the wiring reuses the proven
    `requestList` path and the test proves it integrates without clobbering
    tree state. All tiers green **349/95/41**.*

**Phase E — Explorer is COMPLETE** (E.1–E.5, 2026-07-24). Read-only
folder/file/diff browser shipped: wire-native per-viewport transport,
cwd-jailed with the secret denial, git tree + statuses + before/after diffs,
desktop collapsible left panel and phone full-screen drill-in, auto-refresh
on turn-end. PRs #7 (E.1+E.2, merged), #9 (E.3), #10 (E.4+E.5, stacked).
Post-v1 depth (editing, fs-watcher, syntax highlighting, changed-files
grouping) stays parked in POST-RELEASE.md.

*2026-07-24 — post-completion security audit of the whole Phase E delta:
**no exploitable vulnerability.** The realpath jail, `.env` basename denial,
`execFile` git calls (no shell), `cleanRelPath` before `git show`, throttles,
reply caps, and server-side validation of all client input all hold — the
itests that perform the `../`/absolute/symlink-out/`.env` attacks are the
demonstration. Two items surfaced: (a) FIXED same session — `listTree`'s walk
counted only files, so a non-git workspace that's a huge tree of empty
directories could be walked unbounded and synchronously (the git path is
bounded by its subprocess limits); a total-node cap (`FS_TREE_MAX_NODES`)
now bounds the walk, pinned by a non-vacuous Tier-1 test. (b) DOC — the
Explorer's `.env`-basename read scope matches the existing `Read` tool/`!cat`
(terminal parity, daemon's own `.env` protected, Explorer narrower); recorded
in SECURITY.md's known-trust-decisions, not a bug. **Deferred (this item):
make the non-git walk asynchronous (yield to the event loop) IF the node cap
ever proves too blunt — evidence-gated, likely unnecessary given the cap.***


---

### Phase M — Mission control (opened + ✅ COMPLETE 2026-07-24)

## Phase M — Mission control (opened 2026-07-24; Kyle-directed — the cockpit fleetview, promoted from POST-RELEASE.md)

The "Cockpit fleetview" intake entry, promoted to active work: grow FleetView
(4.6) into a true cockpit — at-a-glance live state of every session, and acting
on sessions from the grid rather than only entering them. Design settled with
Kyle 2026-07-24. The governing principles:

- **Shell-owned end to end.** Same trust rule as the permission bar: agent
  output never paints here, and every engine-derived string on a row (activity
  label, permission detail) renders as inert plain text — never markdown, never
  HTML.
- **Extends the watch_sessions path, additively.** All live state rides
  optional `SessionMeta` fields in the existing per-viewport `sessions`
  snapshot (never broadcast, never replay-buffered, no `seq`); all grid acts
  are new sessionId-addressed `ClientMsg` types on the `end_session`
  precedent. No new stream, no new transport.
- **Agent-neutral by construction.** Every new field is derived in the
  registry from the WireMsg stream it already fans out (status / bang /
  permission_request / usage) — no adapter cooperation, no per-agent code.
- **Grid acts = viewport acts, same gates.** Acting from the grid grants
  nothing a local viewport couldn't do by attaching. The one real gate carries
  over: a REMOTE (relay) watcher may not drive a subscription-backed session
  (R.4i), so quick-prompt and permission-answer are refused when
  `remote && !allowedOverRelay(kind)` — interrupt stays ungated, like
  `end_session` (teardown, not model use).
- **Stable rows, needs-you first** (Kyle's ordering call): rows hold creation
  order so eyes can park on a session; the one exception is sessions awaiting
  permission, which surface to a group at the top — the "act here" zone. The
  recency sort is retired on this page.
- **The archived-session fleetview stays unprecluded.** The `sessions`
  snapshot remains live-only; the future archived fleetview (POST-RELEASE.md)
  arrives as its own additive message + a second page section, never by
  reshaping this one.

Accepted v1 limits, on purpose: no live output preview on rows (Kyle's call —
activity + permission + usage are the glance set); no one-click default
new-session (the picker stays the only create); the pending-permission display
mirrors the 4.6 status stickiness (the queue clears when the stream moves, so a
second concurrently-pending request can be invisible on the fleet until its own
timeout — same honesty as the status dot today); usage mirrors the status bar's
exact rule (per-turn tokens summed, cost taken cumulative — the same numbers
the in-session bar shows); elapsed time ticks client-side from `since`, the
server sends no timers.

- [x] **Step M.1 — Live cockpit state on the wire (registry-derived, additive SessionMeta)**
  - Status 2026-07-24: ✅ done as specified, on `feat/cockpit-m`. One
    placement delta: the deterministic per-transition pins (activity
    since-reset, queue stickiness, detail cap, summary copies/absence, the
    `foldUsage` cost-taken rule — unobservable through the costless mock)
    landed as Tier-1 additions to the existing in-process
    `registry.test.ts` (its Q.3 pattern), with `fleet-cockpit.itest.ts`
    keeping the over-the-socket proof (activity across a real mock turn,
    `dangerous` permission surface + in-session answer clears, usage folded
    across two turns, stable `createdAt`). Tier 1 330 / Tier 2 89 green,
    typecheck clean.
  - Goal: a fleet watcher's snapshot says what each session is DOING — current
    activity + since-when, the pending-permission queue, session usage totals,
    and creation time — derived entirely in the registry.
  - Build: `protocol.ts` additive optional `SessionMeta` fields:
    `createdAt?: number`, `activity?: { label: string; since: number }`,
    `permissions?: { id: string; tool: string; detail: string }[]`,
    `usage?: { inputTokens: number; outputTokens: number; costUsd?: number }`.
    `registry.ts`: `SessionEntry` gains the backing fields; the existing status
    derivation in `broadcast()` grows the capture — a `status` msg sets
    activity (`thinking` → "thinking", `tool` → its label), `bang_start` sets
    `! <command>`, terminal messages (turn_end/error/bang_end) clear it;
    `permission_request` appends `{id, tool, detail}` to the queue; any message
    that flips status off "permission" clears the queue (the 4.6 stickiness
    rule, mirrored); a `usage` msg adds per-turn tokens and TAKES `costUsd`
    (session-cumulative per T2.6 — never summed; Shell.tsx's exact rule).
    `notifyWatchers()` fires on metadata change (activity label change, queue
    change, usage turn) through the existing 100 ms coalescer — text_delta
    storms change nothing and stay silent. `summary()` carries the new fields;
    all absent when empty, so old clients strip them (R.4h).
  - Files: `server/protocol.ts` (additive), `server/sessions/registry.ts`.
  - Done when: Tier 2 (new `fleet-cockpit.itest.ts`, real daemon + real
    sockets, mock-forced): a watcher sees activity appear during a working turn
    and clear at turn_end; a `dangerous` mock prompt puts `{tool, detail}` on
    the session's meta and an in-session answer clears it; usage totals
    accumulate across two turns with cost taken-not-summed; `createdAt` is
    stable across snapshots. `yarn typecheck` clean; all existing tests green.

- [x] **Step M.2 — Acting from the grid, server side (sessionId-addressed ClientMsg)**
  - Status 2026-07-24: ✅ done, on `feat/cockpit-m`. Two deliberate deltas
    from the draft: (1) malformed fields are SILENTLY ignored (the repo's
    malformed-input convention — rename/permission_response posture); only
    an unknown sessionId and the relay gate answer with an error reply.
    (2) The remote-gate proof is Tier-1 in-process (new
    `fleet-acts.test.ts`, `openConnection` driven with the `remote` flag in
    hand) rather than a full relay rig in Tier 2; the socket round-trips
    (grid allow runs the tool / deny runs nothing / interrupt leaves the
    session warm / prompt_session echoes + runs / unknown-id errors with
    the daemon alive) are in `fleet-cockpit.itest.ts`. `answer_permission`
    drops only the answered id from the queue immediately (a concurrent
    second request stays visible); protocol.test.ts gained the three
    ClientMsg fixtures + a separate enriched-row fixture so the base
    SessionMeta keeps proving the M.1 fields optional. All tiers green
    (337/94/38), typecheck clean.
  - Goal: a fleet watcher can answer a permission, interrupt a turn, and
    dispatch a prompt on any session by id — validated, throw-wrapped,
    relay-gated where it drives the model — without attaching.
  - Build: `protocol.ts` additive `ClientMsg` types:
    `{ type: "answer_permission"; sessionId: string; id: string; allow: boolean }`,
    `{ type: "interrupt_session"; sessionId: string }`,
    `{ type: "prompt_session"; sessionId: string; text: string }`.
    `connection.ts`: own NEW switch cases only (nothing existing is touched):
    validate inputs first (typeof checks; prompt text trimmed non-empty with a
    sane length cap); unknown sessionId → error reply, never a crash; then
    `answer_permission` → the session's `resolvePermission` plus dropping the
    id from the entry's pending queue (+ notify); `interrupt_session` →
    `session.interrupt()`; `prompt_session` → the `prompt` case's exact
    semantics addressed by id (broadcast `user_prompt` + `pushPrompt`). The
    relay gate: on a `remote` connection, `prompt_session` and
    `answer_permission` against `!allowedOverRelay(entry.kind)` get the attach
    gate's refusal wording as an error reply.
  - Files: `server/protocol.ts` (additive), `server/sessions/connection.ts`
    (new cases only), `server/sessions/registry.ts` (queue-drop helper).
  - Done when: Tier 2 `fleet-cockpit.itest.ts` over a real socket: a watcher's
    allow resolves a mock `dangerous` permission (the session's own viewport
    sees the tool run) and deny refuses it; `interrupt_session` halts a working
    mock turn and the session still answers the next prompt;
    `prompt_session` round-trips (user_prompt broadcast + turn runs); unknown
    sessionId, malformed fields, and empty text each get an error reply with
    the daemon still alive; the remote gate refuses prompt/answer on a
    subscription-kind session for a remote-flagged connection. All tiers green.

- [x] **Step M.3 — The cockpit rows (front end)**
  - Status 2026-07-24: ✅ done, on `feat/cockpit-m`. As specified: enriched
    rows (activity readout with client-ticked elapsed — 1 s tick only while
    something is live — compact usage via the cockpit's own formatter),
    needs-you sub-line with inline allow/deny (buttons disable on click,
    pruned by the next snapshot), armed two-click stop, per-row
    quick-prompt expando, grid-act errors on a dismissible header line
    (picker-open errors keep the onboarding slot, routed via a live ref),
    sr-only polite needs-you announcement, stable-order sort with the
    needs-you group first (longest-stalled first — their stalled
    lastActivity is the wait clock). One structural addition: each session
    renders as a `.fleet-item` wrapper (row + sub-lines) so the row's
    stretched click-overlay never covers sub-line controls. New
    `fleet.e2e.ts` (7 tests): activity live+clears, usage lands, allow
    runs the tool observed in the session tab, deny doesn't, armed stop
    interrupts, quick prompt echoes in the session, ordering holds while
    working and jumps only on needs-you; axe scan with the permission row
    visible is clean. Tiers: 337 / 94 (unchanged, web-only step) / 45.
    `assertAxeClean` is deliberately a copy from app.e2e.ts (importing it
    would re-register that suite's tests) — dedupe when testing helpers
    get their own module.
  - Goal: the fleet page shows each session's live state and carries the three
    acts — needs-you rows answerable in place — in the enriched-row shape,
    stable-ordered with needs-you first.
  - Build: `FleetView.tsx`: client-side sort — needs-you group first (oldest
    pending first), then creation order (`createdAt`, wire order as the
    old-daemon fallback); the row gains the activity readout ("⚙ Bash · 14s" —
    label from meta, elapsed ticked client-side ~1 s while any row is active)
    and compact usage ("12.3k tok · $0.42" — own small formatter; never import
    from StatusBar). A needs-you row grows a second line: `tool · detail`
    (inert plain text, ellipsized, `+N more` when the queue is deeper) with
    Allow / Deny buttons sending `answer_permission` (disabled once clicked
    until the next snapshot). A working row gets an armed two-click stop
    (`useArmedConfirm`, the end-button precedent) sending
    `interrupt_session`. A per-row quick-prompt affordance (❯) expands an
    inline one-line input — Enter sends `prompt_session` and collapses, Escape
    collapses, autofocus on open. Fleet-action error replies render as a
    dismissible line in the fleet header region (only picker-open errors keep
    routing to the onboarding card). An `sr-only` polite live region announces
    the needs-you count change. All controls carry real aria-labels naming the
    session. New CSS blocks only, appended (`.fleet-activity`, `.fleet-usage`,
    `.fleet-perm…`, `.fleet-stop`, `.fleet-prompt…`).
  - Files: `web/src/components/FleetView.tsx`, `web/src/styles.css` (additive
    blocks only).
  - Done when: Tier 3 (new `server/testing/fleet.e2e.ts`, its own suite,
    desktop width): a mock turn shows the activity label live and clears to
    idle; a `dangerous` prompt surfaces the needs-you second line with the
    tool detail and the row moves to the top group; Allow from the grid runs
    the tool (observed in the session tab) and the line clears; Deny refuses
    it; the armed stop interrupts a working turn; a quick prompt from the row
    lands as a user_prompt strip in the session tab; an idle session's row
    holds its place while another works (no jumping); the axe scan of the
    cockpit with a permission row visible has no serious/critical hits.

- [x] **Step M.4 — Phone width**
  - Status 2026-07-24: ✅ done, on `feat/cockpit-m` (after rebasing the
    branch over Phase E's merged PR #7 — zero conflicts, the
    distinct-anchor shared-file discipline held). Own additive media
    block: sub-lines lose the desktop indent, the permission detail takes
    a full-width ellipsized line with the allow/deny pair wrapping beneath
    at ≥40px, stop/prompt-toggle at .fleet-end's 36px parity, the
    quick-prompt input at the 16px iOS no-zoom floor. One phone test in
    fleet.e2e.ts (390×844 touch context): activity + permission + usage
    all visible with noSideScroll clean, thumb targets measured ≥40px,
    deny and quick-prompt by tap land in the session tab, axe clean.
    Tiers 357 / 94 / 46 green.
  - Goal: at ≤640 px the cockpit rows fold without side-scroll — the glance
    set survives, targets stay ≥40 px, the second-line controls remain usable.
  - Build: additive media-query CSS for the new row elements (the existing
    fleet phone folding is the precedent); tests ride `fleet.e2e.ts` with a
    phone-sized context, reusing the existing `noSideScroll`/target-size
    helpers.
  - Files: `web/src/styles.css` (additive), `server/testing/fleet.e2e.ts`.
  - Done when: `fleet.e2e.ts` at phone width: Allow/Deny tap targets ≥40 px,
    `noSideScroll` passes with activity + permission + usage visible, the
    quick prompt opens and sends, the axe scan is clean.

- [x] **Step M.5 — Polish (optional; the cut line)**
  - Status 2026-07-24: ✅ done (two of three; the cut line used once), on
    `feat/cockpit-m`. Landed: the fleet TAB as a cockpit signal —
    `paintTabStatus` badge (amber = needs you, blue = fleet busy) with a
    fleet-worded title carrying the count ("⚠ 1 needs you — Mirafold");
    and the per-row viewport count (⧉ N — 0 being the interesting number,
    an unwatched session still working; hidden at phone width like the id
    column). Dropped, per the cut line: quick-prompt open-state memory
    (marginal). fleet.e2e.ts covers the title transitions (polled — the
    title rides a React effect) and the count. Tiers 357 / 94 / 47 green.
    **Phase M is complete.**
  - Post-merge quality passes 2026-07-24 (after PR #8 landed M.1–M.5 on
    main): (1) a real bug behind the fleet.e2e ordering flake —
    `.fleet-activity` was the row's only shrinkable column with no floor, so
    a full row flex-crushed the live readout to invisible; fixed with
    `min-width: 12ch` (reproduced 8/1 under a 2-core CPU pin, 5/5 green
    after). (2) A behavior-preserving `/refactor`: FleetView rows decomposed
    into in-file components (SessionName / ArmedButton / PermissionLine /
    QuickPromptLine), `captureCockpit` + `actTarget` extracted server-side,
    the Phase M CSS consolidated to one section. (3) A `/audit` of the delta —
    one real ship-time finding fixed: the fleet snapshot capped the permission
    detail to 200 chars while the in-session bar shows it whole, so a grid
    approver could miss a dangerous tail past a benign head; now carried
    whole, pinned Tier 1 + Tier 2 (verified the pins fail with the cap
    restored). These three landed on `feat/cockpit-m` as a second PR after #8.
  - A needs-you signal on the fleet page's TAB: title count ("Mirafold — 1
    needs you") + the corner-badge favicon via `tab-status.ts` (the session
    page's existing mechanism, reused); the row's viewport count (meta already
    carries it); quick-prompt remembering its open state per row. Everything
    here is safe to drop.



## Moved 2026-07-24 — completed material lifted out of the still-open Phase R steps

---

### Step R.4l item 1 — phone viewport styling, rounds 1–3 (done 2026-07-22)

    1. **Phone viewport styling + small UX issues** — first real phone
       session (wifi, via app.mirafold.com): "don't love the styling yet
       and some other little things." Expected: the phone viewport has had
       near-zero mobile-specific design attention. Punch list owed.
       *2026-07-22: phone-viewport pass landed (Kyle: page drifted
       sideways under a swipe; bottom buttons "clustered and haphazardly
       placed"). Fixes: the app frame is pinned (100dvh + `overflow-x:
       clip` + no overscroll — only the render zone scrolls); all
       focusable inputs ≥16px on phone (sub-16px made iOS zoom on focus
       and LEAVE the page zoomed = the sideways drift); viewport meta
       gains `viewport-fit=cover` + `interactive-widget=resizes-content`
       (keyboard shrinks the layout instead of covering the prompt); the
       status bar becomes two deliberate rows — one even strip of 40px
       controls (⌂ new ● · pair ⚙ ☀|☾ end, verified single-row at 390px),
       then a dim facts line (agent · model · cwd · Σ · $) — with phone-
       irrelevant plumbing hidden (session id, version, per-turn tokens);
       fleet header wraps as two deliberate lines; long unbroken tokens
       wrap in command strips; hover-only pin affordance hidden (its dock
       already was). New Tier-3 assertions in `phone.e2e.ts` pin the
       single-row control strip, ≥40px targets, and ≥16px prompt font;
       Tier-1 (315) + typecheck green. Committed (`7560383`) + pushed
       same day; the git-integrated Pages project rebuilt and the new
       bundle was VERIFIED LIVE at app.mirafold.com (served CSS carries
       the fixes) — Kyle's first phone look that day predated the deploy
       and saw the stale 07-13 bundle. (The pair-QR desktop test's stale
       URL expectation noted that day was fixed elsewhere — the suite is
       4/4 again.)*
       *2026-07-22 round 2 (Kyle's real-phone feedback on the deployed
       round 1 — frame holds; two follow-ups, both his design after
       conferring):* the phone status bar is ONE row — the agent name
       sits beside the dot (one green connected-to-what unit,
       ellipsizes rather than pushing controls) and the facts row is
       REMOVED on phone: model+folder are now visible on the FLEET rows
       instead (`.fleet-cwd`, both platforms — the folder had been
       tooltip-only since 2026-07-17), usage is dropped on phone as an
       accepted loss (revisit if testers ask), and the theme pill is
       hidden on phone with the settings gear's picker carrying theme
       (the Phase S pill lock is desktop-scoped — Kyle confirmed).
       Submit gesture: on phone Enter NEVER submits — newline only,
       now deliberate in PromptBox (it had regressed to newline on iOS
       anyway; root cause unconfirmed, handler was unchanged) — and the
       ↑ send button INSIDE the prompt box (bottom-right, swaps with
       ■ esc while busy, adds no height, text cannot run under it) is
       the one way to send. Desktop Enter-to-send unchanged. Pinned in
       `phone.e2e.ts`: Enter-inserts-newline with zero submits, the
       send-button-driven turn, the one-row bar with the agent aboard,
       facts/pill hidden. 4/4 e2e, Tier-1 315, typecheck green.
       Remaining before this item closes: Kyle's look at round 2 on his
       phone.*
       *2026-07-22 round 3 (Kyle: the on-row fleet folder reads as
       clutter on BOTH platforms — the round-2 column was a miss):*
       details-on-demand instead of persistent chrome. The settings card
       gained a **Session section** (agent, model, folder, usage — which
       thereby gets its phone home back — session id, daemon version);
       on phone it's THE home for these facts, on desktop harmless
       redundancy. Two zero-chrome paths in: the settings gear, and the
       **agent chip beside the dot is now a button** opening the same
       card ("what is this session?" → tap the identity element). The
       fleet folder column is REMOVED (desktop hover tooltip restored);
       the prompt cwd crumb is now DESKTOP-ONLY (on phone it ate a third
       of the typing width and its collapse-to-caret toggle isn't
       touch-discoverable) — phone prompt is bare `❯ Message ↑`. Pinned
       in phone.e2e.ts: no crumb at phone width, agent-chip tap → card
       with the folder fact, Esc closes. 4/4 phone + 28/28 desktop e2e,
       Tier-1 315, typecheck green.*
       *2026-07-22 (late): Kyle's real-phone look at round 3 came back
       emphatically positive ("flabbergasted… looks incredible") — the
       styling core of item 1 is validated on the device that opened it.
       Whether this constitutes the phone-UI pass that un-gates R.5b
       tester invites is Kyle's call, not assumed here.*

---

### Step R.5 — the Stripe-era build spec + the pre-2026-07-22 "still owed" history

  - **Phase K reshapes this step (2026-07-15; K.4 investigation done same
    day):** K.2 (the entity) is a hard prerequisite for any live payment
    configuration, and the billing vendor is now a **merchant of record —
    Paddle recommended** (K.4's verified checklist; Kyle confirms at account
    creation). The Ed25519 entitlement-token design and the relay-side check
    are vendor-agnostic and stand as built — Paddle's subscription statuses
    (`trialing`/`active`) map verbatim onto the "admit when trialing OR
    active" rule. Read the Stripe-specific text below through that mapping
    (Stripe Checkout → Paddle hosted checkout/overlay; `trial_period_days=7`
    → Paddle card-required free trial; `cancel_at_period_end` → Paddle
    scheduled cancel; Stripe webhook → Paddle signed subscription webhooks
    feeding the same minting backend). Tax, FTC negative-option mechanics,
    and EU withdrawal disclosures ride with the MoR. Sequencing: K.2 →
    K.5's ToS/privacy pages live (Paddle site verification needs them) →
    Paddle account (sandbox first) → build here.
  - Build: Stripe Checkout → a relay entitlement token; the relay admits
    daemon pairings only with an active entitlement (the *relay* checks
    entitlement — the daemon and wire protocol stay payment-ignorant);
    graceful expiry/renewal. **Trial & cancellation (settled 2026-07-11,
    BUSINESS §7):** card-required 7-day free trial via Stripe
    `trial_period_days = 7` (card captured, not charged), on both the monthly
    and annual price — the entitlement check admits pairings when the
    subscription status is `trialing` OR `active`. Cancel-anytime with **no
    refund**: set `cancel_at_period_end = true` so access holds through the
    already-paid period then lapses (no proration). **No 30-day money-back
    guarantee** — deliberately rejected (the trial covers try-before-buy;
    a guarantee would re-add refund fees + a `charge.refunded`-revoke path).
    A minimal landing page (demo GIF, install
    command, buy button, docs links) on the R.2 domain. Also (2026-07-08
    operability review): a stranger-facing top section on README.md itself —
    install, GIF, what it is, then "engineering docs below" — because the
    npm package page renders the README, and today it opens as a 60 KB
    maintainer doc. And (internal price sanity, 2026-07-08): before creating
    the Stripe products, a price/packaging pass against the observed market
    range (bare remote-access offerings run free to ~$7–9/mo — internal
    anchor only, NEVER surfaced in copy per the no-competitor-mentions lock,
    2026-07-23) — the tier is sold as **the Mirafold experience from any
    device**, never as bare phone access; $12 stands per BUSINESS §7 + the
    §2 first target unless Kyle recuts it here, eyes open.
  - **Relay `Origin` allowlist (from the 2026-07-08 security audit,
    finding #2 — deferred to here because it needs this step's domain).**
    The relay accepts viewport WebSocket upgrades from any web origin (the
    browser same-origin rule does not cover WebSockets unless the server
    checks the `Origin` header). Harmless today — a stray page can't finish
    the E2E handshake without the pairing code, so it gets nothing — but
    once this step stands up the static app-serving origin, pin the viewport
    endpoint to admit only that origin (env-configured, empty = allow any,
    same refuse-with-a-clean-close shape as the other caps). Closes the last
    "any stranger can open a socket" gap and shrinks the DoS surface the
    per-IP cap (R.2) already blunts. One Tier-2 test: right origin admitted,
    wrong origin refused, unset = allow-any preserved.
    **CODE DONE 2026-07-12** (pulled forward — it needs no Stripe, and the
    mechanism is env-configured so it lands safely before the value exists):
    `RELAY_ALLOWED_ORIGINS` (comma-separated) gates viewport upgrades; unset =
    allow any (today's behavior, preserved); a wrong origin OR a missing
    `Origin` is refused with a clean close (`CLOSE_FORBIDDEN_ORIGIN` = 4006);
    daemon dial-ins carry no `Origin` and are never gated. In `relay.ts` +
    `contract.ts` + `main.ts` (synced both repos, `sync:check` green), README
    env table + prose, and the standalone Tier-2 test (admit/refuse/missing/
    unset + daemon-unaffected). Cross-repo itest (9, real daemon) still green.
    **Still owed at deploy:** set `RELAY_ALLOWED_ORIGINS=https://<static app
    origin>` on Fly once R.5's static origin domain is final — until then it
    ships unset (allow-any), which is correct pre-launch.
  - **Relay entitlement gate — CODE DONE 2026-07-12** (the decision-independent
    half, buildable with no Stripe: every R.5 billing design ends in "the relay
    admits a pairing only with an active entitlement," so the relay's *check* is
    invariant). `RELAY_ENTITLEMENT_PUBLIC_KEY` (Ed25519 public key, base64 SPKI
    DER) gates daemon dial-ins: with it set, a daemon must present a valid,
    unexpired token on the `mirafold-entitlement` header or be refused with a
    clean close (`CLOSE_UNENTITLED` = 4007); the relay verifies signature + `exp`
    OFFLINE via `node:crypto` (no new dep, no Stripe call, no state — stays a
    dumb E2E-blind forwarder) and holds only the PUBLIC half, so it can never
    mint one. Token is compact `<b64url(payload)>.<b64url(sig)>`. Unset = no
    check (today's behavior). In `relay.ts` + `contract.ts` + `main.ts` (synced
    both repos, `sync:check` green), README, and a standalone test (valid admits
    + its viewport works / no-token / expired / garbage / wrong-key all refused);
    cross-repo itest (9, real daemon) still green.
    **Still owed (needs Kyle; vendor now Paddle per K.4):** (1) the Paddle
    **sandbox account + API/webhook credentials** (sandbox needs no site
    verification — start any time; the LIVE account needs the K.2 entity and
    K.5's pages for Paddle's site review) to build the checkout + minting
    half; (2) the **decision — where the minting backend lives**
    (recommended: a Cloudflare Pages Function on mirafold.com — $0, no new
    infra — which on Paddle's `subscription.trialing`/`.activated`/
    `.canceled` webhooks mints/expires the signed token; alt: a small Fly
    service). (3) Then: the daemon side (dial-out sends the header;
    genui-shell app code — hold until the other session frees it), and the
    R.5 open refinements (token→account binding vs. sharing,
    revocation-before-expiry window, and — 2026-07-12 audit, B2 — a
    relay-side **max token lifetime** backstop that rejects an implausibly
    long-lived `exp` even from a buggy or compromised minter). Pricing
    $12/$99 · 7-day card-required trial · cancel-at-period-end stands per
    BUSINESS §7 unless recut — all three verified native in Paddle (K.4).
    **Launch blocker (2026-07-12 audit, B2):** flipping the relay ON for everyone
    (baking the default `MIRAFOLD_RELAY_URL`, see R.2) must land **with**
    `RELAY_ENTITLEMENT_PUBLIC_KEY` set — never before. An open relay with the gate
    off lets anyone squat the pair/connection caps and lock real daemons out, so
    "entitlement gate ON at deploy" is an explicit gate on R.7, not just an owed item.
  - **2026-07-22 — the BUILD is code-complete across all three repos**
    (Kyle's directive: this is the private-beta gate; the shape decision is
    recorded under R.5b). The two open decisions were made by Kyle: minting
    backend = **Cloudflare Pages Functions on mirafold.com** (the
    recommendation above; state in a Workers KV namespace, secrets in the
    Pages project) and token model = **permanent license key +
    auto-refresh** (checkout yields one `mf_…` key set once as
    `MIRAFOLD_LICENSE_KEY`; the daemon exchanges it at `/api/entitlement`
    for 48h Ed25519 tokens — refreshed at boot, every 12h, and force-refreshed
    once after a 4007 — so cancellation cuts access within ≤48h, which is the
    accepted answer to the "revocation-before-expiry" refinement). Landed:
    - **genui-relay**: the B2 **max-token-lifetime backstop**
      (`RELAY_ENTITLEMENT_MAX_TTL_SECONDS`, default 7d, 0 disables) inside
      `entitlementValid`; `ENTITLEMENT_HEADER` joined `SHARED_CONTRACT`;
      new `scripts/entitlement.mjs` (keygen printing both env halves;
      `mint --ttl` for comped beta testers — key read from env, never argv;
      `verify`). Standalone suite 20/20 green.
    - **THIS repo**: new `server/relay/entitlement.ts` (the token source:
      `MIRAFOLD_ENTITLEMENT_TOKEN` override wins outright; the license-key
      exchange NEVER throws or blocks the local product — no token just
      means the gated relay refuses and relay-client prints the existing
      actionable line); relay-client resolves the token per dial and sends
      the header (`ws` client headers), force-refresh after
      CLOSE_UNENTITLED; index.ts boot line names the entitlement mode;
      relay-stub gained an exact-match `entitlementToken` knob so the send
      path stays CI-covered (the sibling itest is CI-excluded per C.1).
      Tests: Tier 1 300→**308**, Tier 2 83→**86**, incl. the POSITIVE gated
      pairing (real relay, real daemon, minted token → paired + viewport
      turn), the full license-exchange path against a throwaway local
      billing server, and the lapsed-key path (refusal line; local viewport
      proven still answering).
    - **mirafold-site**: the whole minting backend — `functions/api/`
      (claim / entitlement / paddle-webhook / health), `lib/`, 7 `node
      --test` tests (incl. a cross-format guard that verifies a minted token
      with this relay's exact node:crypto calls), the `/welcome` checkout
      landing (verified 1280w+390w), CSP `connect-src 'self'`. KV shapes are
      webhook-order-proof. Detail + **Kyle's setup runbook** (Cloudflare
      KV/secrets/rate-limit rule, keygen, Paddle sandbox):
      `mirafold-site/PLAN.md` "R.5 billing backend".
    **Still open on this step:** Kyle's runbook execution
    (`mirafold-site/PLAN.md`), the live end-to-end below, the payment-link →
    Pro-button swap, and token→account binding (deliberately deferred — the
    license key IS the binding for now; sharing a key shares one
    subscription's access, and a lapsed-then-returning customer gets a NEW
    key, since a re-subscribe is a new Paddle subscription id).
    *2026-07-22 (later, Kyle): NO sandbox and NO comped tokens — Paddle is
    wired straight on the live approved account, and Kyle's own real-card
    purchase is the end-to-end (the 7-day card-required trial charges $0;
    cancel-inside-trial keeps it $0, which is also the published-policy-
    sanctioned path — no refunds). Beta testers then use the identical
    full-real flow; past-day-7 charges are paid back personally. The mint
    script is ops/emergency tooling only.*

---

### Step R.5d — original step spec (executed 2026-07-23)

  *(original step spec follows)*
  - Goal: a legitimate place to test relay changes before production, once
    real users depend on production. The relay is the only component that
    needs this — the shell's "production" is the user's own machine (its
    nonprod is the release-channel decision, R.5b) and the site already has
    Cloudflare Pages previews. Staging exercises what local runs can't:
    real TLS, the `fly-client-ip` header the rate limiter trusts, real
    network behavior, Fly machine lifecycle.
  - Build: a second Fly app (e.g. `genui-relay-staging`) from the same
    Dockerfile/`fly.toml` with a different app name, smallest machine —
    auto-stop is acceptable in staging (a dropped pairing costs nothing
    there), so it idles at near-zero cost. The `*.fly.dev` URL is fine:
    the own-domain rule exists so installed daemons never depend on the
    platform's name, and nothing installed ever points at staging. The
    `Deploy` workflow (`mirafold-relay/.github/workflows/deploy.yml`) grows an
    environment input on the dispatch form — staging or production, each a
    GitHub Environment with its own Fly deploy token — same manual-click
    pattern, one more dropdown. Fly-side one-time steps (app create, token)
    are Kyle's.
  - Flow it buys: deploy a ref to staging → point a local shell at it
    (`MIRAFOLD_RELAY_URL=wss://<staging>.fly.dev`) → smoke + phone pairing
    check → dispatch the same ref to production.
  - Done when: deploying any ref to staging is one workflow dispatch, a
    smoke run (`npm run smoke`) against the staging URL passes, and the
    staging half is documented in `mirafold-relay/DEPLOY.md` alongside the
    production runbook.



---

## Moved 2026-07-27 (sixth lean-out pass — verbatim originals)

Same rule as every pass: nothing deleted, only relocated — PLAN.md keeps a
one-line pointer or summary for every item below.

### R.4l item 5 — the original item + 2026-07-25 investigation (step DONE 2026-07-27)

Original item:
       Today the QR
       encodes `<relay origin>/#code=<pairing code>`, the phone loads it at
       the root path, and `main.tsx` routes purely on the path (`/s/<id>` =
       session, anything else = mission control) — so the phone always
       lands on the fleet list and has to tap the row for the session the
       user was sitting in when they hit pair. Kyle wants it to open
       straight into that session.
       **Shape (investigated 2026-07-25, ~30–45 min including tests):**
       carry the session id in the fragment beside the code (`&s=<id>`) and
       rewrite the path before the router reads it. Three touch points —
       (a) `ConnectDevice.tsx` takes an optional session id and appends it
       (the status bar has it; mission control's pair button passes nothing
       and keeps landing on the fleet, no special case); (b) `ws.ts` gains a
       small pure parser beside `relayTargetFromFragment`, validating the id
       as defensively as the relay origin is validated; (c) `main.tsx`
       rewrites the path to `/s/<id>` before rendering. Everything
       downstream is untouched — `session-bus.ts` already reads the session
       id off `location.pathname` to build its attach message, the same path
       a fleet-row tap takes today.
       **The trap:** `history.replaceState(null, "", "/s/" + id)` DROPS the
       fragment, and the pairing code still lives there unconsumed (the
       socket client reads and scrubs it later, at connect). Carry
       `location.hash` along in the rewrite or the phone loses its code,
       dials a relay it has no credential for, and hangs on "connecting"
       forever — the exact shape of the 2026-07-24 mobile new-session bug.
       Related: the session hint must NOT be stashed in sessionStorage the
       way the code is; it's a one-shot intent, and persisting it would
       bounce the user back into the session every time they tap home.
       **Edge cases, both with existing behavior:** a session that ended
       between QR and scan hits the daemon's attach-fallback (fresh session
       + the "the session you asked for is gone" notice, R.4c) — a stale
       link degrades to today's behavior with an explanation; a session on a
       subscription login is refused for remote viewports (R.4i notice
       exists), but the user would land INSIDE a refused session rather than
       on the fleet — decide whether that case should bounce to mission
       control. **Verify:** a unit test beside the existing fragment tests,
       plus one phone e2e asserting the paired link lands on `/s/<id>` with
       the transcript instead of the fleet list (the existing phone pairing
       test is ~3 lines from being that). The extra ~8 characters are
       immaterial to QR density.

### Phase C — the CI-flake root-cause breakdown (resolved 2026-07-23)

- **✅ CI FLAKE FULLY RESOLVED 2026-07-23** (PR `mirafold/mirafold#5`). The
  "quarantine + fix" call became just FIX — nothing quarantined. Surface was
  wider than the 3 named: **six** flaky tests, **three** root causes, each
  reproduced under `taskset -c 0` + CPU stress before fixing. (1) *Log-vs-socket
  race* (4 tests) — asserting `daemon.logs()` right after a wire event, but the
  log rides stdout's pipe while the event rides the socket → new
  `Daemon.waitForLog` helper, whole suite swept. (2) *bang-kill pre-attach* —
  killed before the PTY child attached; now waits for output. (3) *axe animation
  sampling* — fleet rows sampled mid-`rise` read as low-contrast;
  `assertAxeClean` settles animations first. (4) *RemoteClient unhandled
  rejection* (subtlest) — a wrong-code connect's close rejected `hsDone` before
  it was awaited, crashing the whole test process (22/40 under stress; the
  daemon was provably innocent) → `hsDone.catch(()=>{})`. **NO product code
  changed — every fix was in test/harness code.** Proven by repeated green CI
  cycles on the real runner, not a single pass.

### Phase D — the 2026-07-23 pre-launch refactor pass (full note)

**2026-07-23 — pre-launch refactor pass (unplanned maintenance, whole repo)**
landed a behavior-preserving sweep that overlaps this phase's spirit without
executing it: server-side, an `errText()` helper in `adapters/types.ts`
replaced the 9 copy-pasted unknown-error idioms, `claude-code.ts`'s `pump()`
had its 50-line `system` case extracted to `handleSystemMsg()`, `codex.ts`
gained `finishTool()` (the 4× announced-delete + tool_result emit), and
`connection.ts`'s module-load `OFFERABLE` now reads the static
`ADAPTER_AGENTS` list instead of running full credential detection at import.
Web-side: `ModalCard.tsx` absorbed the modal scaffold shared by
ConnectDevice/ThemePicker/Onboarding, `useArmedConfirm` the two-click
end-session state (StatusBar + FleetView), `DiffLines` the duplicated diff-line
JSX (ToolBlock + registry Diff), plus one real bug fixed: both Onboarding
callers passed a fresh inline `onRefresh` arrow, so the picker's 3s re-probe
poll was reset on every parent render and effectively never fired — both now
pass a `useCallback`-stable function. README §11's accepted-duplication list
was honored throughout (worker() loops, listener/emit boilerplate, RenderZone
upsert twins all untouched). All tiers green after (318 / 86 / 37).

### R.5c — the interim 2026-07-25 evening tarball rebuild note (superseded same day)

  - **Tarball rebuilt again 2026-07-25 (evening), from this commit's tree
    (parent `d743632`)** — still **0.2.0**, no version bump: the only
    code-affecting change since the `d8abc62` build is the transitive
    postcss 8.5.16 → 8.5.23 bump in `c660130`, which moves the built CSS
    asset and nothing else. Staged at `../beta/mirafold-0.2.0.tgz` and
    verified the way a tester installs it: cold `npm i -g` into a
    throwaway prefix, `mirafold --version` → 0.2.0, real boot serving
    HTTP 200. Tier-1 (369 tests) + typecheck green on the tree it was
    built from.

### Phase E — security audit of the 2026-07-25 evening delta (full narrative)

**Security audit of the 2026-07-25 evening delta: one finding, fixed the
same session (`0ae994c`).** `web/src/version.ts` read one string,
`pkg.version`, through a DEFAULT json import — which inlines the ENTIRE
manifest into the browser bundle every viewport downloads (and a paired phone
pulls over the relay): every dependency and devDependency with its version
range, the scripts, the package-manager pin. No secrets in it, so information
disclosure rather than a hole — but it hands anyone with the bundle a complete
dependency inventory, which is the first thing you enumerate looking for a
known-vulnerable version, and the repo is private until launch. A named import
tree-shakes; `bundle.e2e.ts` pins it in Tier 3 (the tier that rebuilds dist, so
the assertion means something) and was proved to bite by restoring the default
import. Also verified clean in the same pass: no raw-HTML sinks in any changed
component, agent-controlled labels beside the new gear still render as escaped
text, the pairing link is never an `<a href>` (text + clipboard only), no
secrets in the session's commits, the shipped tarball carries no `.env` /
source maps / install hooks, and builds are byte-for-byte reproducible.
**Kept deliberately, don't re-flag:** the pairing URL's `tabIndex={0}`. It was
there because the box scrolled sideways and a scrollable region must be
keyboard-reachable; the box wraps now, so that reason is gone, but Kyle's call
was to keep the tab stop so a keyboard user has somewhere to land on the URL
(reading it, or selecting with caret browsing). Neither keeping nor removing it
is an accessibility defect and the axe sweep passes both ways.
**Considered and dismissed:** the pairing card now shows the full code at 1.5×
rather than a truncated scroll — no marginal exposure, since the QR directly
above encodes the same secret and decodes from any screenshot. **Closed with
evidence:** the `@hono/node-server` advisory is unreachable here — MCP connects
over `StdioServerTransport` only (`server/render-mcp.ts:106`) and the shipped
bundles contain zero references to `serveStatic` or the HTTP transport.

### Phase E — the 2026-07-24 UI polish pass + 2026-07-25 phone-rail restore (full narrative)

**Kyle-directed UI polish pass (2026-07-24 evening, iterative):** the desktop
frame got a VS Code-style **activity bar** — a permanent thin strip flush with
the window's left edge whose files icon toggles the panel (replacing the
status bar's `files` button); the tree now leads with the **checked-out root
as its top node** (name only, full path in its tooltip — the path header row
is gone); the panel width is **fit-to-content** (widest visible row + a little
air, capped at the old 340px/42vw, 140px floor); refresh floats pinned at the
panel's **bottom-left**; back lives in the file view's path bar. Verified per
round in headless Chrome by measurement (geometry probes), not eyeballing —
the round-3 lesson: the icon's SVG box, the UA button padding, and the
`.shell` gutter each silently ate a "fix" until measured from the window edge.
Same session: a behavior-preserving refactor (ActivityBar extracted beside
BangBar; `--gutter-left/right` + `--content-air` CSS vars replace the
duplicated gutter expressions) and a delta audit — no exploitable findings; a
hostile `<img onerror>` filename demonstrated inert (React text escaping).

**2026-07-25 amendment (Kyle-caught deviation):** the polish pass above made
the activity bar permanent at ALL widths — but the locked design (the charter
above, and the 2026-07-24 scope lock before it) always said phone entry =
files icon in the status bar. On a 390px screen the 46px always-on strip was
"way too much precious screen real estate" (Kyle). Restored same day
(`d8abc62`): the rail is desktop-only (≤640px hides it; shell + prompt box
run full-width again); the phone toggle is `.sb-files` at the status bar's
far LEFT, boxed off by its own separator line (the rail's border folded into
the row), one notch outside home — Kyle's chosen shape over between-home-and-
new, auto-hiding rail, FAB, and bottom-nav alternatives. Rendered only on
phone via `useIsPhone`, so desktop DOM keeps home as the bar's first control
(the locked 2026-07-16 order). Drill-in, focus trap, and focus-return carry
over untouched; the phone e2e opens via `.sb-files` and asserts the rail is
`display: none`. Deployed to app.mirafold.com same day (Pages auto-build,
bundle `index-BG3GNY9U.js` confirmed live).

### Phase M — the 2026-07-24 post-merge + evening passes (full narrative)

**Post-merge quality passes (2026-07-24, PR #11):** a real bug behind the
fleet.e2e ordering flake — `.fleet-activity` was the row's only shrinkable
column with no floor, so a full row flex-crushed the live readout to invisible
(`min-width: 12ch`; reproduced 8/1 under a 2-core pin, 5/5 green after); a
behavior-preserving refactor (FleetView rows decomposed into SessionName /
ArmedButton / PermissionLine / QuickPromptLine, `captureCockpit` + `actTarget`
extracted server-side, the Phase M CSS consolidated); and an `/audit` whose
**one real ship-time finding** was fixed — the fleet snapshot capped the
permission detail to 200 chars while the in-session bar shows it whole, so a
grid approver could miss a dangerous tail past a benign head. Now carried
whole, pinned in Tier 1 + Tier 2 (pins verified to fail with the cap restored).

**Evening pass (2026-07-24, second session — Kyle-driven cockpit UX + honesty):**

- **Concurrent-permission honesty bug FIXED** (was the accepted v1 stickiness
  limit above; Kyle hit it live — approved one ask, the next two never
  surfaced). Queue entries now live until their OWN resolution: both answer
  paths (grid `answer_permission` AND in-session `permission_response`) route
  through `registry.answerPermission`; unanswered asks age out on the
  adapter's own `PERMISSION_TIMEOUT_MS` clock (server-side `askedAt`, never
  on the wire); terminal states still clear all. Needs-you (ordering, ⚠
  title, tab badge) keys on pending asks OR permission status, so asks
  surviving past the first answer surface to the top.
- **Details disclosure**: activity readout + tokens·cost moved OFF the row
  bar (full working-state rows overflowed their border; volatile inline text
  made the layout jumpy) into a per-row caret-toggled sub-line — the ❯ glyph
  CSS-rotated down/up, one row open at a time, live-updating. Bar keeps the
  stable glance set: dot · name · agent · model · id · status · ago · ⧉ ·
  acts. (Kyle iterated placement live: centered-borderless tried and reverted.)
- **Viewport-count lag fixed**: leaving a session by navigation now closes
  the socket in `pagehide`, so the daemon detaches immediately instead of the
  30–60s heartbeat window; bfcache restores still reconnect. Session idle
  timeout (zero-viewport grace) raised 60min → **4h** (Kyle's call). Both
  rode the parallel session's commits (`bb272da`).
- **/audit (delta-scoped) → one hardening fix landed**: the fleet's
  pending-permission mirror is capped at 25 (oldest evict — closest to
  auto-deny; evicted asks stay answerable at the adapter) so a permission
  flood can't grow watcher snapshots without bound (probe: 500 asks ≈ 1MB per
  snapshot before, 51KB after) — full per-entry detail kept (the earlier
  audit's no-truncation rule). At-cap floods also stop fanning notifies.
- All pinned: Tier-1 registry lifecycle/prune/cap tests + reworked fleet.e2e
  (details-line interaction, phone tap flow, immediate viewport-count drop).
  Tiers at close: **369 / 103 / 51**.

### Step E2.1 — per-directory listing (full body)

- [x] **Step E2.1 — per-directory listing: wire + server** ✅ 2026-07-26 —
  `fs_listdir { id, path }` → `fs_dir { id, path, entries, truncated?, error? }`
  landed additively (`FsDirEntry` = name + dir/file/symlink kind + the
  `status` slot E2.3 will fill); `listDir()` in fs-explorer.ts (jailed via
  `inside()`, dirs-first sort so caps cut files not dirs, SKIP_DIRS floor
  carried over, per-dir entry + name-byte caps honest). One deliberate
  deviation inside the "same throttle discipline": fs_listdir throttles as a
  **token bucket** (`FS_LISTDIR_MAX_PER_SEC`, default 32 — capacity = refill)
  instead of the min-interval family, because E2.2's open-panel prefetch is a
  legitimate same-instant burst the interval would refuse; a drained bucket
  still answers with an error reply. Done-when observed over a real socket:
  root + nested listings correct with kinds; `../`, absolute, and a planted
  dir-symlink-out all refused; legacy `fs_list` answers identically on the
  same connection; burst refused-then-recovers; hostile-frame pins added
  (bad id drops whole, bad path answers). Tier 1 + Tier 2 + typecheck green.
  - Goal: the daemon can answer "list this one directory" — jailed, capped,
    throttled, correlated — beside the untouched whole-tree path.
  - Build: `fs_listdir`/`fs_dir` in `server/protocol.ts`; handler in
    `server/sessions/fs-handlers.ts` (same badId/throttle/gitInFlight
    discipline); a bounded one-directory lister in
    `server/sessions/fs-explorer.ts` (readdir + sort + per-dir caps; symlinks
    stay leaves; unreadable dir = error on the reply). Plain (non-git) listing
    only in this step — statuses ride E2.3.
  - Files: `server/protocol.ts`, `server/sessions/fs-handlers.ts`,
    `server/sessions/fs-explorer.ts` + Tier-1 unit and Tier-2 itest coverage
    (including hostile paths: `../`, absolute, symlink-out, secret files).
  - Done when: over a real WebSocket (Tier 2), listing the root and a nested
    dir returns correct entries; a `../` request and a planted symlink-to-
    outside are refused; the legacy `fs_list` still answers identically.

### Step E2.2 — the lazy client (full body)

- [x] **Step E2.2 — the lazy client: incremental tree store** ✅ 2026-07-26 —
  `files-tree.ts` is now the per-directory store (pure transitions:
  unfetched/loading/loaded/error, refetch keeps prior entries visible so a
  refresh never reads as a collapse); `FilesPanel` holds per-dir correlation
  ids (the single `listId` ref is gone), drops stale replies per directory,
  fetches on first expand with an inline loading row, serves cached
  re-expands with no request, and shows per-dir truncation/"(empty)" rows.
  Open = fetch root + prefetch first level (capped at 24 dirs, under the
  token bucket) + refetch expanded dirs; turn-end/refresh-button = root +
  expanded dirs only, and both PRUNE cached-but-collapsed dirs so their next
  expand fetches fresh (staleness honesty at refresh boundaries — a design
  addition, not in the original spec). Whole-tree `fs_list` retired from the
  client (bus method replaced by `requestFsListdir`); daemon still answers
  it. **Known interim (until E2.3):** listings are the plain lister's — no
  status chars, and gitignored dirs (`dist/` etc.) appear; both return with
  the git layer. Done-when observed in headless Chrome via a wire recorder:
  open sends only root + first-level fetches (no `fs_list` anywhere), a deep
  expand fetches exactly that dir, collapse/re-expand is request-free, and
  the E.5 turn-end refresh refetches only root + expanded dirs. All three
  tiers green (e2e run three times to shake out two test-side flakes: an
  exact-name locator now that ignored siblings like `dist-server/` are
  listed, and waiting on refetch traffic instead of reused transcript text).
  - Goal: the panel builds its tree incrementally — fetch on first expand,
    cache, loading rows — with the whole-tree fetch retired from the client.
  - Build: replace the flat-entries + derived-tree model in
    `web/src/files-tree.ts` / `FilesPanel.tsx` with a per-directory node
    store: per-dir fetch state (unfetched/loading/loaded/error), per-dir
    correlation ids (the single `listId` ref goes away), stale-reply drop per
    directory, session-switch clears all. Open = fetch root + prefetch first
    level; expand of an unfetched dir = fetch + inline loading row; refresh
    button = refetch currently-expanded dirs. Desktop panel and phone
    drill-in both consume the store; a11y tree semantics (role=tree,
    aria-expanded) carry over.
  - Files: `web/src/files-tree.ts`, `web/src/components/files/FilesPanel.tsx`
    (+ their tests, a Tier-3 e2e over the mock).
  - Done when: in headless Chrome, opening the panel shows root + first level
    with no whole-tree request on the wire; expanding a deep dir fetches
    exactly that dir; collapse/re-expand serves from cache with no request;
    the E.5 turn-end refresh refetches only expanded dirs.

### Step E2.3 — multi-repo git fidelity (full body)

- [x] **Step E2.3 — multi-repo git fidelity** ✅ 2026-07-26 — per-repo git
  view on the lazy listings: `findRepoRoot()` (nearest `.git` — dir or file —
  walking to the FILESYSTEM root, so a subdirectory-rooted session finds its
  repo above the jail, git's own discovery rule); `repoStatus()` runs
  `status --porcelain=v1 -z --ignored` per repo behind a TTL cache
  (`FS_GIT_STATUS_TTL_MS`, default 3 s — the invalidation until W's watcher
  signal exists; a prefetch burst shares one subprocess per repo) and a
  GLOBAL one-at-a-time queue (the one-git-child discipline extended —
  fs_listdir's git calls serialize instead of hitting the per-connection
  refusal, because the open-panel burst is legitimate); `decorateGitDir()`
  (pure) drops ignored entries, attaches statuses (children of a collapsed
  `?? dir/` inherit U), and merges status-only deleted files back in so a
  deleted file stays visible. Git trouble degrades to the plain listing,
  never to an error. Zero wire changes (E2.1's `status` slot fills) and zero
  client changes (file rows already render badges; dir rows ignore the U
  they now receive — a render nicety left for later). **Known adjacent gap
  (deliberately not done, E2.4-or-later):** `fs_diff` still runs from the
  session root, so a status badge in a NESTED repo invites a diff that
  answers "not a git repository — no diff available" (graceful error reply);
  single-repo roots diff fine. Done-when observed over a real socket against
  the two-repos-plus-plain-dir fixture (repoA dirty: M/D/untracked-dir/
  ignored dist; repoB's own rules — secret.log hidden only there, dist
  visible U there): each repo honors its own `.gitignore`, statuses ride per
  repo, the plain dir and the non-repo root list statusless and
  byte-identical to E2.1; the legacy `fs_list` whole-tree reply pinned
  as-is, quirks included (collapsed `newdir/` U entry). All three tiers
  green (388/108/55). *(The diff gap closed the same day — E2.4.)*
  - Goal: full fidelity at a Projects-folder root — each nested repo shows
    its own statuses and respects its own ignore rules; single-repo roots
    behave exactly as today.
  - Build: nested-repo discovery during listing (a child dir containing
    `.git` marks a repo boundary); inside a repo, directory listings come
    from that repo's git view (ignore-rule fidelity) with per-repo `git
    status` attached to entries (cached per repo, invalidated by refresh/
    turn-end/W's signal later); outside any repo, the plain E2.1 lister.
    The existing one-git-child-in-flight discipline extends to per-repo
    queries (serialize, never fan out N subprocesses at once).
  - Files: `server/sessions/git.ts`, `server/sessions/fs-handlers.ts`,
    `server/sessions/fs-explorer.ts` + both test tiers with a multi-repo
    fixture (two nested repos + one plain dir, one repo dirty).
  - Done when: against that fixture over a real socket, each repo's dir
    listings honor its own `.gitignore`, the dirty repo's files carry
    statuses, the plain dir lists without statuses — and a plain single-repo
    root session is byte-identical to pre-E2.3 behavior in both suites.

### Step E2.4 — the Projects-root proof (full body)

- [x] **Step E2.4 — the Projects-root proof + compatibility pin** ✅
  2026-07-26 — **phase E2 complete.** Three deliverables plus the gap
  E2.3 recorded: (1) `fs_diff` now discovers the repo that CONTAINS the
  file (same `findRepoRoot` walk, directory resolved through the realpath
  jail first, session-root fallback when the directory is gone — the exact
  pre-E2.4 behavior), so a modified file in a nested repo diffs instead of
  answering "no diff available"; Tier-2 pins the nested diff, the
  deleted-file diff (HEAD vs empty), the plain-dir degrade, and the jail.
  (2) The old-client floor pinned at a Projects root: legacy `fs_list`
  serves the plain whole-tree walk (`git: false`, no statuses, ignore
  rules unhonored, deliberately — pinned as-is, never to be "fixed").
  (3) The Tier-3 proof over a real multi-repo fixture seeded at a wire-
  created session: a WebSocket-prototype recorder installed before the
  panel opens catches every fs frame — open, prefetch, expand into both
  repos, per-repo badges (M on the dirty file, U on the untracked, none on
  clean), per-repo ignore fidelity (dist/ hidden in one repo, secret.log
  in the other), the nested-repo DIFF rendered with real before/after
  lines, a content view in the second repo — and not one `fs_list` frame
  anywhere in the flow. (4) Phone drill-in over the same fixture: full-
  screen panel, badge visible, file opens, Esc walks back out. All tiers
  green (388 / 110 / 56), e2e twice to shake flakes.
  - Goal: the headline use case observed end-to-end, and the version-skew
    floor pinned so it can't rot.
  - Build: a Tier-3 e2e driving the full lazy flow over a multi-repo
    workspace (expand into two repos, open a file in each, statuses visible);
    a Tier-2 pin that the legacy `fs_list` whole-tree reply still works
    (the old-client floor); phone drill-in pass over the same fixture.
  - Done when: both land green in CI alongside all existing tiers, and the
    e2e demonstrates no whole-tree request anywhere in the lazy flow.

### Deferred hardening pair W.H1/W.H2 (full bodies)

### Deferred from the 2026-07-26 security audit (do these inside Phase W)

The audit of Phase E2 found **nothing exploitable** — every containment
probe refused (see `SECURITY.md`'s "Git metadata is read from the containing
repo" entry, pinned by a Tier-2 test). Two **hardening** items were deferred
here rather than fixed, because neither is reachable today and both touch the
refresh machinery W rewrites anyway. Measured on the real 1.1 GB repo, the
per-repo `git status --ignored` runs in **40 ms** and emits **<400 bytes**
(git collapses ignored directories) — that measurement is why both items are
"later", and if it ever stops holding they become "now".

- [x] **W.H1 — a slow repo must not hold up every viewport's listings.** ✅
  2026-07-26 — fs_listdir now waits on its repo's status only up to
  `FS_LISTDIR_STATUS_WAIT_MS` (default 300ms — well above the measured
  healthy 40ms, well under the 5s git timeout, and covering queue time,
  which is the actual exposure: statuses serialize globally). On timeout
  the PLAIN listing ships immediately; when the status settles usable, one
  synthetic `fs_changed` (no paths — nothing on disk changed) tells that
  viewport to refetch, and the refetch decorates instantly from the settled
  cache (W.H2's arrival-stamped TTL — the two fixes interlock). One owed
  bell per repo per connection, so a prefetch burst against a slow repo
  rings once; a status that settles degraded rings nothing (plain was
  final). Pinned over a real socket with a deliberately slow repo (a
  core.fsmonitor hook that sleeps makes every status ~2s,
  deterministically): plain reply at the bound, synthetic bell, badged
  refetch — and mutation-tested (bound disabled → test fails → restored).
  Per-repo status calls are serialized in ONE global queue (so an open-panel
  burst can't fork N git subprocesses), and a directory listing waits for its
  status before it's sent. Consequence: one pathological repo (network mount,
  cold cache) delays the file panel for every attached viewport, bounded by
  the 5 s git timeout, after which the listing degrades to no badges. Fix
  direction: send the listing immediately and let badges arrive as a
  follow-up, or bound the wait well under the git timeout. Natural fit with
  W, which makes listings arrive on a signal rather than a request.
- [x] **W.H2 — the status cache stamps its clock at request time, not
  arrival.** ✅ 2026-07-26 — `repoStatus` entries now carry `at: Infinity`
  while in flight (always fresh → every late caller coalesces onto the
  running call, however long git takes) and stamp `at` when the promise
  SETTLES (rejections too), so the TTL measures the answer's age, not the
  question's. The prefetch-burst coalescing is strictly stronger than
  before. Pinned in `git-cache.itest.ts` with node:test's mocked Date over
  a real repo (in-flight coalesce 100 mocked seconds past the TTL; fresh
  from arrival at TTL−ε; expired at TTL+ε) and mutation-tested
  (request-time stamp restored → test fails → fixed back).
  *Original finding:* `repoStatus` records `at: Date.now()` when the
  promise is CREATED. If a git call ever exceeded the 3 s TTL, its result
  would already be stale on arrival, so new requests would start
  additional calls instead of reusing it — a backlog that feeds itself.

### Step W.1 — the watcher module (full body)

- [x] **Step W.1 — the watcher module, server-side** ✅ 2026-07-26 —
  `@parcel/watcher@2.6.0` added (prebuilt linux binaries, no install
  compile); `server/sessions/fs-watch.ts` owns the doorbell: `startWatch()`
  is a sync facade (lifecycle callers never await; `ready` exposed for
  tests), one bell per fixed window from the FIRST event (not a trailing
  debounce — a continuously-writing agent can't starve it;
  `FS_WATCH_DEBOUNCE_MS`, default 400), root-relative paths hint capped
  honestly (`FS_WATCH_MAX_PATHS`, default 64, `truncated` past it), the
  exclusion globs, and error→stop→onError exactly once. Registry wiring:
  first attach starts, last detach and end() stop, dormant sessions hold no
  watches; the signal's consumer is W.2 — until then it traces under
  MIRAFOLD_DEBUG only. **Two backend truths discovered and handled:** (1)
  the inotify backend permanently misses a subtree created faster than
  watch registration (`mkdir -p a/b` → only `a` watched — a git clone or
  scaffold would go silent), healed by resubscribing when a window saw a
  directory created — which must be unsubscribe-THEN-subscribe, because the
  native layer shares one watcher per directory (an overlapping subscribe
  attaches to the stale watch set and never crawls); the brief gap is
  covered by one synthetic `truncated` bell. (2) unsubscribe is keyed on
  (dir, callback, opts), so every subscribe passes a fresh closure. Done-
  when proven in the Tier-2 itest (real inotify, real git), all five
  clauses plus the heal, cap honesty, and stop-before-ready; the coalescing
  window, the exclusion globs, and the heal each mutation-tested (guard
  broken → test fails → restored). All three tiers green (388/119/56).
  - Goal: a per-session, debounced, exclusion-aware change signal the daemon
    can consume — proven against a real filesystem.
  - Build: add `@parcel/watcher`; a small module (`server/sessions/
    fs-watch.ts`) owning per-session lifecycle (subscribe on first viewport,
    unsubscribe on last detach / session end), debounce/coalesce
    (~300–500 ms), the exclusion list, the `.git` status-change coverage,
    and the error→degraded path.
  - Files: `package.json`, `server/sessions/fs-watch.ts` (+ registry wiring)
    + Tier-2 itest.
  - Done when: Tier 2 proves — file touch fires one coalesced callback with
    the touched path; a burst of writes fires once; a `git commit` (no
    working-file change) fires; writes under `node_modules` do NOT fire; a
    forced subscribe error degrades without crashing the daemon.

### Step W.B — the byte cap on the paths hint (full body)

- [x] **Step W.B — the bell's paths hint is capped by BYTES too** ✅
  2026-07-26 (audit finding, fixed same session) — the hint was capped at 64
  entries but not by size, and a single path may run to thousands of
  characters: one bell could carry ~250 KB, every window, which a phone
  viewport pays for over the relay. `FS_WATCH_MAX_PATH_BYTES` (default
  16,000) now bounds the accumulator alongside the count, whichever runs out
  first, with `truncated` honest exactly as before (the client already treats
  a truncated hint as "refetch what you show", so nothing downstream
  changed). Repeated paths cost no budget. Real projects approach neither
  bound. Pinned in the Tier-2 itest with 200-byte names against a 1,000-byte
  budget — the byte cap must cut it while the count cap is nowhere near —
  and mutation-tested. NOT an attacker-reachable issue: only the user or
  their own agent can write files into the workspace; the fix is bandwidth
  hygiene for the paid tier, taken now under the cheap-theoretical-finding
  rule rather than roadmapped.

### Step W.A — git-trust (full body)

- [x] **Step W.A — a browsed repo cannot run programs** ✅ 2026-07-26
  (audit finding, fixed the same session) — `server/sessions/git-trust.ts`:
  every daemon git call now neutralizes the settings a repository can use to
  make git run a program during read-only commands, unless the user has
  listed that repo in `trusted-repos.json`. Three settings proven to execute
  by probe (`core.fsmonitor` naming a program; `filter.*.clean`;
  `filter.*.process`) and neutralized; a dozen candidates proven NOT to fire
  for our commands and deliberately left alone. The check reads git's
  EFFECTIVE config (an `include.path`-hidden setting is otherwise missed and
  still executes — both verified), reading config executes nothing, and
  results cache per repo and clear on the watcher's bell. One notice per repo
  per connection names what was skipped and where to allow it. Full detail
  and the probe method are recorded in `SECURITY.md`. Pinned by
  `git-trust.itest.ts` (real programs planted in all three settings; a marker
  on disk IS the vulnerability reproducing) plus Tier-1 pins for the
  classification, and mutation-tested by removing the protection and watching
  the pin fail. The W.H1 fixture, which used `core.fsmonitor` to slow git,
  now rides the allow list — so it proves that path through the real daemon
  too. **For future work: the vector list is tied to the git commands the
  daemon runs — adding a new one means re-running the probe.**

### Step W.2 — fs_changed + the live client (full body)

- [x] **Step W.2 — `fs_changed` on the wire + the live client** ✅
  2026-07-26 — `fs_changed { paths?, truncated? }` minted (per-viewport
  plumbing like the fs_* replies — fanned to attached viewports straight
  from the watcher callback, never through broadcast(), so it never enters
  the replay ring; pinned by a late-attacher itest). The bell invalidates
  the per-repo status cache BEFORE fanning (`invalidateRepoStatusCache()`
  in git.ts), so a bell-triggered refetch can't be served a pre-change
  status still inside its TTL — pinned and mutation-tested. Client:
  FilesPanel handles the bell with the turn-end refresh unit (root +
  expanded dirs; hint deliberately not consulted — doorbell contract),
  coalesced client-side through `bellRefreshDelay` (pure, Tier-1-pinned;
  min gap 1s, immediate first ring, trailing after) so sustained bells
  can't drain the fs_listdir token bucket. The phase charter's failure
  notice landed too: a watcher error now fans one shell-composed notice to
  attached viewports beside the server log line. **Field find, fixed at
  the source:** the daemon's own per-listing `git status` takes git's
  optional lock (`.git/index.lock`, sometimes rewriting the index's stat
  cache) — churn the watcher now HEARS, feeding a listing→status→bell→
  refetch loop that polluted the E2.2 e2e's recorded window; every runGit
  now passes `--no-optional-locks` (the background-tool rule), pinned by
  a deterministic itest (same-content mtime touch makes the stat cache
  stale, then listings must stay silent) and mutation-tested. Done-when
  observed in headless Chrome: a file written behind the UI's back appears
  with zero clicks; a new file in a collapsed, unfetched dir causes no
  fetch of that dir and stays unlisted; the refresh button still refetches;
  not one whole-tree request in the flow. All tiers green (389/123/57),
  e2e twice.
  - Goal: the tree updates by itself, observed end-to-end; the button
    becomes something you never need.
  - Build: `fs_changed { paths?, truncated? }` in `server/protocol.ts`,
    fanned to the session's attached viewports; client-side, the panel (open
    only) responds by refetching expanded dirs (+ invalidating E2.3's
    per-repo status cache); throttle-aware (the bell never bypasses
    FS_MIN_INTERVAL_MS discipline — coalesce client-side too).
  - Files: `server/protocol.ts`, `server/sessions/` wiring,
    `web/src/components/files/FilesPanel.tsx` (+ tiers; Tier-3 e2e).
  - Done when: in headless Chrome with the panel open, a file written behind
    the UI's back (test harness writes to the workspace directly) appears in
    the tree within ~1 s with zero clicks; a new file inside a collapsed,
    unfetched dir causes no fetch (nothing expanded shows it — correct); the
    refresh button still works unchanged.

### Step S.1 — original spec bullets

  - Build: add `pie` to the `kind` enum. Mapping: `x` = slice names,
    `series[0].values` = slice values (validate exactly 1 series for pie);
    fold slices past 6 into "other" so the fixed-slot palette (slot order is
    the CVD mechanism — never cycle) always suffices. Donut rendering with
    direct labels + hover tooltip (the ≥2-encodings rule). Read the dataviz
    skill before writing the renderer, as Chart.tsx did.
  - Files: `server/registry-spec.ts`, `web/src/registry/Chart.tsx` (+
    `Chart.test.ts`, `registry-spec.test.ts`, an `app.e2e.ts` mock turn).
  - Done when: a mock-session prompt for a pie renders a donut in the output
    zone in both themes, and a malformed pie (e.g. 2 series) degrades into
    the raw-props fallback, observed in headless Chrome.

### Step S.2 — original spec bullets

  - Build: optional `stacked` (bar → cumulative segments) and `horizontal`
    (bars grow rightward; y carries the category labels untruncated) props;
    extend the bar `.describe()` to tell the agent to pre-bin distributions
    into bar buckets.
  - Done when: stacked and horizontal mock turns render correctly, and an
    old-client simulation (parse through yesterday's tolerant schema) shows
    the props stripping to a plain grouped/vertical bar, not a fallback.

### Step S.3 — original spec bullets

  - Goal: single-number answers (coverage %, p95 ms, cost) get a glanceable
    tile instead of a sentence in a `card` — the natural pin-dock resident.
  - Build: new registry entry `stat`: `label`, `value` (string — the agent
    formats units), optional `delta` (+/- with good/bad direction), optional
    `footer`; follows the dataviz stat-tile guidance.
  - Done when: a mock turn renders the tile, it pins to the dock, and an
    update-in-place re-send (same wire id) changes the value live.

## Moved 2026-08-08 (seventh lean-out pass — verbatim original)

### Step F.10 — Codex runtime/version parity hotfix (full body)

- [x] **Step F.10 — Codex runtime/version parity hotfix (opened 2026-08-08)**
  - **Goal:** restore the product's faithful-skin promise for Codex sessions:
    the engine Mirafold drives must be the same installed Codex the user drives
    in a terminal, so one version owns the config, model cache, model default,
    and accepted reasoning efforts.
  - **Proven cause:** Kyle's `config.toml` sets
    `model_reasoning_effort = "max"`; terminal Codex 0.147.0 wrote the current
    `models_cache.json` and defaults to GPT-5.6 Sol, which supports `max`.
    Mirafold 0.3.4 instead launches the SDK-vendored Codex 0.142.5. That older
    engine logs `missing field base_instructions` while parsing the 0.147.0
    cache, falls back to its built-in GPT-5.5 default, then sends the inherited
    `max` effort to a model that accepts only through `xhigh`. The resulting
    API 400 and cache warning are therefore one version-skew chain, not two
    independent failures.
  - **Build:** resolve the user's installed `codex` executable (honoring
    `MIRAFOLD_CODEX_BIN`) and pass it through the SDK's
    `codexPathOverride`; if none exists, retain the SDK's bundled fallback.
    Ask that resolved engine for both model catalogs so picker and turns cannot
    split across versions. Raise the existing `@openai/codex-sdk` floor from
    0.142.5 to the current stable 0.147.0 so the fallback is compatible too.
    No new dependency: the SDK remains six files with one transitive
    `@openai/codex`; wrapper unpacked size is 77,268 bytes versus 76,741
    (+527 bytes). The separate per-model `/effort` picker redesign remains
    V.2/F.5 follow-up; it did not set the inherited value in this failure.
  - **Files:** `server/adapters/types.ts`, `server/adapters/codex.ts`, their
    focused tests, `package.json`, `yarn.lock`, `docs/ADAPTERS.md`, this plan.
  - **Done when:** a regression test pins the external executable through
    `CodexOptions` and the engine/catalog single-source rule; focused tests,
    typecheck, Tier 1, build, and dependency audit are green; then one live
    subscription-backed prompt succeeds with Kyle's unchanged `max` setting
    and resolves GPT-5.6 rather than the vendored GPT-5.5. Land through a
    DCO-signed feature-branch PR into `next` under `docs/RELEASING.md` flow b.
  - **Outcome:** Mirafold now uses one resolved executable for SDK turns and
    both model-catalog paths, preferring the installed Codex and falling back
    to the SDK's updated 0.147.0 binary. The unchanged live subscription setup
    selected GPT-5.6 Sol and replied `ok` without an error. Focused tests
    (53/53), Tier 1 (536/536), typecheck, build, package dry-run, and the
    production dependency audit (0 vulnerabilities) passed.

## Moved 2026-08-08 (native working-directory picker — full body)

### Phase N2 — Native working-directory picker (opened 2026-08-08)

**Goal:** keep the launch directory as the honest default, but make changing it
a normal graphical choice instead of requiring the user to type a filesystem
path. Manual entry stays beside the picker for precision and as the fallback.

**Proven constraint:** Mirafold's browser UI cannot use `showDirectoryPicker()`
for this job: the web API returns a capability-scoped directory handle and its
leaf name, not the host's absolute path that the local agent process needs as
`cwd`. The authenticated local daemon must therefore open the host operating
system's own folder dialog and return only the path the user explicitly chose.
Remote relay viewports may still type a host path, but must never pop a dialog
on the unattended host.

**Dependency call:** add no package. macOS already supplies AppleScript's
`choose folder`; Windows supplies `FolderBrowserDialog` through Windows
PowerShell; Linux desktop users commonly have Zenity or KDialog, tried in that
order. A native-dialog package would add platform binaries and supply-chain
surface merely to wrap facilities the operating systems already provide. If no
Linux dialog helper is installed, the existing editable path remains available.

- [x] **N2.1 — Host-native picker service + local-only wire**
  - Build: bounded, shell-free child processes for macOS (`osascript`), Windows
    (`FolderBrowserDialog`), and Linux (`zenity`, then `kdialog`); one global
    dialog at a time, cancellation as a quiet result, selected-directory
    validation, output caps, and abort on viewport close. Add an additive
    correlated `pick_folder` / `folder_picked` request-reply pair. Advertise
    availability in the `agents` hello; refuse the request over the relay.
  - Files: `server/folder-picker.ts`, a small session handler,
    `server/sessions/connection.ts`, `server/protocol.ts`, focused tests.

- [x] **N2.2 — Onboarding browse control**
  - Build: put a real `browse…` button beside the still-editable working-dir
    field; click opens the host dialog at the field's current valid directory,
    a choice replaces the field, cancel changes nothing, errors stay in the
    card, and the button cannot stack dialogs. Hide it when the daemon says no
    native picker is available (including relay viewports).
  - Files: `web/src/components/Onboarding.tsx`, `web/src/components/Shell.tsx`,
    `web/src/session-bus.ts`, `web/src/styles.css`.

- [x] **N2.3 — Regression proof + documentation**
  - Done when: Tier 1 pins every platform recipe, cancellation, fallback,
    validation, and concurrency; a real-daemon browser test substitutes a
    harmless Zenity fixture, clicks `browse…`, observes the chosen absolute
    path in the field, and creates the session in that directory; remote and
    hostile request behavior are pinned; typecheck, all three automated tiers,
    build/package, and accessibility checks are green. README's working-dir
    contract names the graphical path and its manual fallback. Land via a
    DCO-signed `feature/*` PR into `next`; `main` and release state stay put.

- [x] **N2.4 — Post-refactor executable-trust remediation**
  - The 2026-08-08 defensive audit proved that npm exec always exposes local
    package binaries in the child `PATH`. The published launcher resolved its
    browser opener from that path, and the new Linux picker did the same for
    Zenity/KDialog; a hostile checkout could therefore run code as the user.
  - Remove ambient `PATH` from operating-system chrome entirely. Browser
    openers and native-dialog helpers resolve only fixed system locations and
    receive a credential-free system path plus a neutral home-directory cwd.
    Filter relative, project-contained, symlink-back-into-project, and every
    `node_modules/.bin` candidate from Codex/Gemini executable discovery while
    preserving parent-process operator overrides and legitimate global
    installs.
  - Native-dialog abort/output overflow must settle only after `close`, with a
    short graceful request followed by forced termination. Replace the tests
    that depended on PATH substitution with injected process seams and add
    adversarial resolution/cleanup proofs. README and SECURITY must state that
    plain `npx mirafold` is for already-trusted directories only.
  - **Outcome (2026-08-08):** browser openers and native dialogs now resolve
    only fixed operating-system locations and inherit a fixed system path,
    credential-scrubbed desktop state, and the user's home as cwd. Shared agent
    lookup rejects relative, project-contained, npm-bin, and symlink-back-into-
    project candidates while retaining parent-process operator overrides.
    Abort and output overflow request process-group termination, escalate after
    250 ms, and reject only after the child closes. Adversarial lookup,
    environment, cwd, and force-kill regressions replaced the unsafe
    PATH-substitution seams;
    README and SECURITY record the `npx` boundary. Local verification passed:
    Tier 1 561/561, Tier 2 143/143, Tier 3 82/82, typecheck, build, 19-file
    package dry-run, secret scan, and production audit (0 vulnerabilities).

- [x] **N2.5 — Keep the chosen folder leaf visible in long paths**
  - Goal: when the startup working-directory field cannot fit the whole path,
    show its rightmost leaf folder instead of the filesystem root.
  - Build: scroll the unfocused controlled input to its logical end after a
    programmatic path replacement and whenever editing finishes; do not fight
    the user's caret while they are editing.
  - Files: `web/src/components/Onboarding.tsx`, `server/testing/app.e2e.ts`.
  - Done when: a real-browser narrow-width regression proves that the complete
    value remains intact, the leaf is visible after blur/programmatic state
    updates, and refocusing still permits ordinary editing.
  - **Outcome (2026-08-08):** the controlled startup input now moves its
    viewport to the logical path end after a native selection or other
    unfocused value replacement, and again when editing ends. While the field
    has focus, its caret remains authoritative, so the root and middle remain
    normally editable. A narrow-width browser regression synthesizes the
    existing correlated folder-pick reply, proves the overflowing input is at
    its maximum horizontal offset without changing the value, edits at the
    root, proves blur restores the leaf, and creates the session at the full
    chosen path. Tier 1 passed 561/561; the focused Tier-3 browser regression
    passed 1/1; typecheck and the production build passed.

- [x] **N2.6 — Close the post-audit environment and Windows-opener execution
  paths**
  - The follow-up audit found that N2.4's executable filter could still be
    bypassed through the launch checkout's `.env`: `process.loadEnvFile()`
    copied `MIRAFOLD_CODEX_BIN` and runtime loader controls into the parent
    environment, after which agent resolution treated them as operator intent.
    It also found that an unencoded `MIRAFOLD_TOKEN` reached Windows
    `cmd.exe /c start`, where shell metacharacters became commands.
  - Replace ambient `.env` mutation with Node's dotenv parser plus an explicit
    allowlist of supported Mirafold data settings. Load it before dependency
    modules initialize, keep parent-process values authoritative, and ignore
    executable overrides, path/shell controls, runtime loader hooks, and
    unrelated repository variables. Explicit binary overrides exported by the
    operator continue to work.
  - Build the startup URL through `URLSearchParams`, then open it on Windows by
    passing one argument directly to fixed-system `explorer.exe`; no command
    interpreter remains in the browser-opening path. Pin the hostile `.env`,
    token round-trip, and Windows metacharacter cases. Correct README, SECURITY,
    `.env.example`, and the runtime `npx` warning: an installed command prevents
    package/executable shadowing but does not make a checkout's active `.env`
    configuration trustworthy.
  - **Outcome (2026-08-08):** repository `.env` files can configure only the
    supported data surface and can no longer select agent executables or Node
    loaders; parent-process overrides retain precedence. Tokens containing
    command metacharacters are percent-encoded and still authenticate after URL
    decoding, while Windows sends the resulting URL straight to
    `%SystemRoot%\\explorer.exe`. Local verification passed Tier 1 563/563,
    Tier 2 143/143, Tier 3 82/82, typecheck, production build, the 19-file
    package dry-run, secret/diff scans, and the production dependency audit
    with 0 vulnerabilities.

**Outcome:** both startup routes now offer a compact native `browse…` control
while preserving the editable absolute-path field. Mirafold opens the host
dialog with fixed executable/argument arrays, validates the selected directory,
caps output, allows only one dialog globally and per connection, aborts on
disconnect, and gives the child a strict desktop/session allowlist rather than
the daemon's credential-bearing environment. The correlated response is sent
only to the requesting local viewport and clicks are never queued across a
reconnect; relay, unsupported-platform, and helper-missing cases retain manual
entry without claiming a picker exists. Long paths keep their rightmost leaf
visible whenever the field is not actively being edited. No package was added.
The original N2 delivery passed focused tests (51/51), Tier 1 (551/551),
typecheck, package dry-run, production audit (0 vulnerabilities), the
real-daemon/real-browser picker proof, phone no-overflow, axe, and protected
GitHub Tier 1/2/3 checks. The direct local full Tier 2 and Tier 3 runs also
exposed four unchanged baseline failures, each reproduced from an isolated
`origin/next`; PR #22 records those controls explicitly. N2.5's separate
follow-up verification is recorded directly above. N2.6's post-audit closure
is likewise recorded above with the complete 563/143/82 proof.

## Moved 2026-08-08 (stable Tier-3 browser gates — full body)

### Phase N3 — Stable Tier-3 browser gates (opened + done 2026-08-08)

**Goal:** keep the browser suite's real guarantees while removing the three
observed timing/state races that intermittently blocked otherwise-good PRs.

**Proven causes:**

- Activity: the test waited for the transient `.activity-line`, then made a
  second Playwright round-trip to read it. On the failed PR #22 run the first
  wait succeeded, the scripted turn correctly ended and removed the line, and
  the second call waited 30 seconds for an element that was supposed to stay
  gone. The unchanged executable head had passed immediately before the
  docs-only commit that caused the rerun.
- Mermaid: the failed run never reached the outer `.rc-diagram`; the shared
  session could carry a preceding turn across the test boundary and leave the
  diagram prompt contending with the one-follow-up gate. The lazy Mermaid
  runtime was never implicated by the trace.
- Follow-tail: re-arming only in the delayed `scroll` event let streamed paint
  move the bottom beyond the 24px slack after the user's downward gesture but
  before that event measured it. This one was a narrow product race, not only
  a test race; it matched the watch item root-caused on 2026-07-24.

- [x] **N3.1 — Replace elapsed-time luck with a controlled busy state**
  - The activity test now owns its daemon, page, and session and uses the mock
    permission request as a deterministic latch. It asserts presence, elapsed
    text, glyph movement, viewport placement, no blank busy frames, and clean
    teardown while the test—not timer scheduling—controls when the turn ends.

- [x] **N3.2 — Isolate the Mermaid renderer proof**
  - The diagram test now owns its session, so it reaches the renderer or fails
    for a renderer reason. Its guarantee is otherwise unchanged: it drives the
    production lazy chunk, sandboxed iframe, CSP, postMessage sizing handshake,
    SVG render, and parse-error fallback.

- [x] **N3.3 — Close the real follow-tail re-arm race**
  - Instant following and input-based upward detachment remain intact.
    Downward wheel/touch intent that will reach the current bottom now arms
    synchronously against the geometry at input time, before streamed paint
    can move the target ahead of a later `scroll` event. Pure Tier-1 tests pin
    pixel, line, page, direction, and exact boundary decisions. The browser
    test owns deterministic scrollback, proves a real upward wheel detaches
    during growth, then uses a permission latch and real downward wheel to
    prove later tool/output frames keep following without a new prompt.

- [x] **N3.4 — Prove the flakes are gone**
  - Focused unchanged repetition: activity 6/6, Mermaid 5/5, follow-tail 6/6;
    pure intent boundaries 3/3. Full Tier 1 passed 554/554, typecheck and
    diff validation passed, and two consecutive unchanged full Tier-3 runs
    passed 78/78 in 183s and 186s. PR #22's implementation head `a091ba1`
    then passed DCO, Cloudflare Pages, Tier 1 (1m23s), and the combined Tier
    2 + Tier 3 protected job (6m41s) on the loaded GitHub runner.

**Outcome:** the two test-only flakes now synchronize on owned state instead
of shared-session timing, while the follow-tail watch item is fixed in product
code. No dependency was added. The checks retain their original user-visible
guarantees and now fail at the component they name: busy chrome, Mermaid
rendering, or follow-tail behavior.

## Moved 2026-08-09 (native prompt discovery, transcript fidelity, and session recovery — full body)

### Phase UX — Native prompt discovery, transcript fidelity, and session recovery (opened + done 2026-08-09)

**Goal:** close the four gaps found in real use without inventing a generic
Mirafold command language: provider-native prompt choices appear before submit,
completed engine activity occupies no more transcript space than its terminal,
the prompt is always one keyboard gesture away, and a daemon restart never
silently replaces a recoverable agent conversation.

- [x] **Step UX.1 — Provider-native prompt catalog.** Add one additive wire
  catalog for command/skill completions. Claude reads its live Agent SDK
  command list (including `commands_changed`); Codex exposes its implemented
  `/model` and app-server `skills/list` results under `$`; Gemini exposes its
  implemented `/model`. Commands from incompatible TUI/ACP surfaces stay out
  rather than becoming ordinary model prompts. The browser opens the matching listbox on the
  first trigger character, filters as the user types, and supports mouse,
  arrows, Tab, Enter, and Escape without submitting a partial choice.
- [x] **Step UX.2 — Terminal-sized activity.** Keep in-flight tool state and
  failures visible, but collapse contiguous successful tool runs into
  expandable activity lines. A failure or other transcript row is a hard
  chronology boundary. Nested provider/subagent churn stays inside those
  lines instead of becoming extra top-level transcript rows; expansion
  preserves the full normalized detail so Mirafold shows no less on demand.
- [x] **Step UX.3 — Prompt focus keyboard path.** `Shift+Escape` focuses the
  prompt from anywhere outside an open modal/editable control; typing a valid
  provider trigger while the page itself has focus both focuses the prompt and
  opens its catalog. Existing plain-Escape interrupt behavior remains intact.
- [x] **Step UX.4 — Durable provider recovery.** Checkpoint bounded transcript
  state and the provider's real resume identifier in the platform state
  directory with owner-only permissions and atomic replacement. Idle timeout
  unloads the engine but keeps the checkpoint; daemon startup lists dormant
  sessions; opening one lazily resumes Claude, Codex, or Gemini. Explicit End
  Session is the only normal deletion path, and an unavailable/corrupt resume
  is surfaced without silently creating a blank replacement.
- [x] **Step UX.5 — Proof and contract sync.** Pin catalog keyboard behavior,
  settled activity compaction, checkpoint bounds/deletion/reload, provider
  resume plumbing, and stale-URL recovery with focused unit/integration/e2e
  tests; update README and `docs/ADAPTERS.md` to the new fidelity and recovery
  contracts.

**Outcome:** Mirafold now learns each provider's pre-submit vocabulary before
the prompt is sent where the active adapter can execute it faithfully: Claude
Code exposes its live SDK slash catalog, Codex exposes `/model` plus live `$`
skills, and Gemini exposes `/model`. Completion is keyboard- and mouse-operable, opens on the first trigger,
and inserts without submitting. `Shift+Escape` returns focus to the prompt;
typing a supported trigger from page chrome preserves the draft and opens the
catalog. Contiguous successful tool churn folds at the real turn boundary into
expandable `worked · N actions` lines while live work, failures, and their exact
chronology remain explicit.

Sessions now checkpoint a bounded transcript, exact non-secret backend choice,
and native provider resume id in owner-only atomically replaced records. Idle
timeout unloads rather than deletes; daemon startup indexes dormant sessions
and lazily resumes the same provider conversation and URL. A mid-turn restart
forces a full replay across the daemon stream-epoch boundary, closes the browser
turn with an honest interruption notice, and never falls through to a blank
session. Explicit End Session deletes the record; corrupt or unavailable
recovery stays visible in place. No dependency was added. Verification passed
typecheck, production build, Tier 1 (583/583), Tier 2 (144/144), and Tier 3
(83/83), including real daemon death/restart and the full axe-core sweep.

### Step UX.6 — Settle prompt return behavior, then refactor Phase UX (completed 2026-08-10)

**Open record carried into this pass (verbatim):**

- [ ] **Step UX.6 — Settle prompt return behavior, then refactor Phase UX.**
  Treat the current `Shift+Escape` binding as provisional: it is not a standard
  Codex/Claude/Gemini/terminal convention and was never approved. Begin the
  next session by choosing the interaction with Kyle before changing it.
  Preserve normal `Tab` traversal through links, buttons, permissions, and
  interactive response components; never globally hijack `Tab` to jump to the
  prompt. Do not add more permanent copy to the already-busy prompt line.
  `Cmd/Ctrl+K` was discussed but is not self-discovering for terminal users
  (`Ctrl+K` commonly kills to end-of-line; `Cmd+K` commonly clears terminal
  scrollback). The remaining candidate, not yet approved, is a standard
  keyboard-only “Skip to prompt” link: normally invisible, temporarily shown
  at the top-left when keyboard-focused, then `Enter` moves the cursor to the
  prompt. Its limitation is that it is not a one-keystroke jump from anywhere.
  Once Kyle decides, implement and pin the accepted behavior, then run a
  behavior-preserving refactor/review of the full Phase UX diff and repeat its
  unit, server-integration, browser, typecheck, build, and accessibility proof.

**Completion (2026-08-10):**

- [x] Kyle rejected the provisional shortcut/skip-link direction and approved
  the interaction that follows the user's natural mouse intent: a primary
  desktop click on inert transcript content immediately focuses the prompt.
  The focus call uses `preventScroll`, preserving the transcript's exact
  `scrollTop` and its detached follow-tail state even while output continues.
  Links, buttons, generated controls, active text selection, secondary/non-primary
  pointers, and touch keep their ordinary behavior. Normal `Tab` order and
  keyboard transcript scrolling remain unchanged. `Shift+Escape` was removed;
  page-level `/` and `$` provider-trigger routing remains.
- [x] Browser proof covers focus after a transcript click, the removed binding,
  interactive-control ownership, live-selection ownership, touch exclusion,
  exact scroll preservation during streamed growth, continued follow-tail
  detachment, and the focused axe-core accessibility check.
- [x] The requested full Phase UX refactor consolidated provider resume-ID
  observation, made fresh/recovered session activation one registry lifecycle
  seam, isolated restart-boundary transcript repair from the registry, split
  checkpoint decoding into named validation units, extracted transcript focus
  intent from `RenderZone`, extracted the completion menu from `PromptBox`,
  deduplicated nested tool-call rendering, clarified global-trigger naming,
  stabilized the shell focus callback, and removed unreachable catalog
  branches. No public protocol, configuration, dependency, or accepted
  behavior changed.

**Proof:** the same dotenv-opaque matrix passed before and after refactoring:
typecheck; client and server production builds; unit 555/555; server integration
127/127; browser 70/70; focused transcript-click axe check; and `git diff
--check`. The matrix deliberately excludes only tests whose own setup reads or
writes dotenv files, plus browser Explorer/global-axe cases that necessarily
open those excluded paths; the focused Phase UX accessibility assertion ran and
passed. No dependency was added. The archived UX.3 line and original Phase UX
outcome above remain the historical record; this step supersedes their
`Shift+Escape` statement as the current product contract.

### Step UX.7 — Close the eight Phase UX correctness findings (completed 2026-08-10)

**Open record carried into this pass:** retain Phase UX's shipped behavior
without backend drift, misleading command suggestions, lifecycle leaks, hidden
keyboard state, reordered transcript evidence, or a damaged live session after
a failed durable delete. Close every reported scenario with a focused
regression and synchronize the provider, recovery, and compaction contracts.

**Completion (2026-08-10):**

- [x] Backend resolution now pins the exact valid configured Claude endpoint
  through one-click startup, checkpoint restore, and later environment drift;
  it also pins the configured Codex default on the one-click path. A client can
  reuse the advertised configured endpoint but cannot inject a different one.
- [x] Codex now advertises only the `/model` slash command that Mirafold
  faithfully intercepts on the app-server transport, plus its live `$` skill
  catalog. Unsupported terminal commands no longer become misleading prose
  prompts.
- [x] Gemini now advertises only its faithfully intercepted `/model` command.
  The incompatible ACP command-list probe and helper were removed from the
  stream-JSON adapter.
- [x] Activating a dormant session with no viewport now arms the ordinary idle
  unload timer, so a quick prompt cannot leave a recovered engine resident
  indefinitely.
- [x] Arrow-key completion navigation keeps the active option fully visible by
  scrolling only the completion listbox, never the transcript or page.
- [x] Settled-tool compaction now groups only contiguous successful runs from
  the same batch. Failures, unsettled tools, non-tool transcript rows, and
  batch changes are hard chronology boundaries.
- [x] The one-shot JSON-RPC decoder contains callback/start failures, and
  Codex/Gemini catalog decoders skip malformed nested rows instead of letting a
  bad provider payload escape into and terminate the daemon.
- [x] End Session now flushes and durably deletes before stopping its watcher,
  clearing its idle timer, or tearing down the live entry. A storage failure
  therefore leaves the working session intact and retryable.

**Proof:** typecheck, guarded client/server production build, 166/166 focused
unit assertions, 127/127 server-integration assertions, the focused browser and
axe-core completion-navigation regression, and `git diff --check` passed. Every
reported failing scenario has a direct regression, no dependency was added,
and the active README/adapter contracts match the implementation. No broad
unit aggregate is claimed: Node's aggregate invocation reported file-level
catalog failures and then stalled even though those same catalog files passed
directly and in the 130-test changed-code run. No broad browser matrix is
claimed either: its attempted name filter did not exclude Explorer cases, so
that run was stopped and discarded. These runner/filter limitations did not
produce a failing focused product regression and are recorded here rather than
being presented as green coverage.

### Step UX.8 — Close the Phase UX security audit findings (completed 2026-08-10)

**Open record carried into this pass:** preserve Phase UX's backend choice,
recovery, and native prompt discovery without letting checkout-controlled
configuration redirect a parent credential, configured endpoint data escape
server-side boundaries, untrusted catalog metadata impersonate trusted shell
UI, or a malformed checkpoint frame re-enter the browser transcript. Close the
reported high/medium findings plus the hardening-only and theoretical items.

**Completion (2026-08-10):**

- [x] Claude endpoint authentication is now an explicit server-side binding:
  configured endpoints receive only the selected API-key/auth-token mode,
  unauthenticated and discovered endpoints receive only the fixed dummy token,
  and both real Anthropic credential variables are otherwise removed. The
  project configuration loader records key provenance without copying secret
  values, so a checkout-selected endpoint cannot inherit a parent-only daemon
  credential. Recovery refuses an authenticated saved endpoint when its exact
  current destination or credential mode changed.
- [x] Configured endpoint URLs are fully opaque outside owner-only checkpoints.
  Claude choices use random daemon-scoped IDs; Codex choices use their declared
  provider identity while the provider base URL remains internal. Picker text
  reveals no configured hostname, URL auth, path, query, or fragment. Backend
  logs use generic destination wording, generic scrubbing removes URL
  credentials/signed values, and both Claude and Codex adapters redact the
  exact selected endpoint—including a secret-bearing path—from diagnostics
  before browser/log fanout.
- [x] The “local” privacy tag is computed only by the daemon from exact
  `localhost`, IPv4 127/8, IPv6 `::1`, or IPv4-mapped loopback parsing.
  Prefix lookalikes such as `127.attacker.test` remain remote.
- [x] Provider prompt catalogs carry fixed adapter provenance into a visible
  source badge. One shared normalizer bounds catalog fields and drops entries
  containing C0/C1, bidi, line, or invisible display controls before trusted
  prompt-shell rendering or checkpointing; legacy saved provenance is
  recomputed from trusted backend identity.
- [x] Checkpoint recovery no longer casts minimally checked objects to
  `WireMsg`. A strict discriminated schema accepts only the complete
  persistable, sequenced transcript vocabulary, rejects extra/replay/control
  fields and non-monotonic sequences, validates backend/catalog metadata, and
  scrubs legacy provider errors before replay.
- [x] Active README, security, adapter, local-model, protocol, plan, and handoff
  contracts now describe the stronger boundary. No dependency was added;
  strict decoding uses the repository's existing `zod` dependency.

**Proof:** under a preloaded guard that denied dotenv-file access, 184/184
focused security assertions passed; the broad unit matrix passed across 67
selected files; the safe server-integration matrix passed 131/131 across 21
files; and the three affected Chromium scenarios passed (prompt discovery and
transcript click-to-focus, fully opaque live-picker backing, and N.4 backend
selection). TypeScript checking, guarded client/server production build, and
`git diff --check` passed. Two unit files and one integration file that
deliberately manufacture dotenv fixtures were excluded under the account-wide
opacity rule; the launcher browser file that handles that configuration class
was not run. No broad browser-matrix result is claimed. Every UX.8 finding has
a focused regression, and no commit or push was performed.

### Step UX.9 — Audit and repair the Phase UX branch tests (completed 2026-08-10)

**Scope and standard:** audited the complete `next` → working-tree Phase UX
branch delta against the repository's four-tier testing contract. Tiers 1–3
must remain hermetic and mock-forced; browser behavior must use real Chrome
typing/clicks after a fresh build; Tier 4 alone may use a real binary and a
free local model. Every recursive discovery and every run was protected by a
preloaded denial guard for dotenv-pattern files. Tests that deliberately
manufacture that forbidden filename class were excluded and are named below.

**Baseline characterization before repairs:**

- [x] Tier 1 passed 581/581 twice across 67 safe unit files.
- [x] Tier 2 passed 131/131 three times, serialized, across 21 safe daemon and
  socket integration files.
- [x] Tier 3 passed 70/70 three times after a fresh production build across
  six safe browser files.
- [x] TypeScript checking and every production build passed.
- [x] Tier 4's first-party catalog check passed on every attempt and its
  credentialed OpenRouter configuration remained deliberately skipped with
  the key forced absent. The real Codex/Ollama turn was intermittent under
  unchanged inputs: two 300-second timeouts and one 145.5-second pass. One
  timed-out runner then remained alive until stopped, proving a separate test
  cleanup defect.

**Mutation-proven repairs:**

- [x] A tool-grouping test now fails if adjacent successful calls from two
  user-turn batches are merged. The prior chronology tests covered failures
  and non-tool rows but survived removal of the batch boundary.
- [x] Strict checkpoint tests now fail when `nextSeq` equals the final stored
  sequence, preventing the first recovered frame from reusing an existing
  cursor.
- [x] Recovery tests now fail if an endpoint-bearing saved diagnostic reaches
  replay without exact selected-endpoint redaction.
- [x] Prompt-completion tests now fail if `$skill` syntax is accepted in the
  middle of an ordinary word instead of at a whitespace-delimited token.
- [x] The real browser interaction test now proves a Markdown-link click never
  invokes prompt focus, including the transient focus that final active-element
  checks missed, and separately proves transcript focus calls the browser with
  `{ preventScroll: true }`.
- [x] The Tier 4 local-turn test now binds cleanup to the test abort signal,
  rejects its wait on abort, and closes the session in `finally`. A forced
  one-second timeout made the whole runner exit in 2.4 seconds; the former
  post-timeout overhang is gone.

**Healthy mutation controls:** existing tests killed representative credential
leakage to a discovered Claude endpoint, loss of exact selected-endpoint
redaction, teardown-before-durable-delete ordering, and generic transcript
control focus stealing. Every temporary product mutation was immediately
reversed and verified against its pre-mutation hash before work continued.

**Final proof:** Tier 1 passed 583/583; Tier 2 passed 131/131; Tier 3 passed
70/70 after a fresh production build; the two repaired browser scenarios
passed together; TypeScript checking and `git diff --check` passed. The added
test count is two because four repairs sharpen existing test cases. The final
restored Tier 4 attempt still timed out at 300 seconds, but exited roughly two
seconds later, confirming cleanup while leaving the real local integration
failure visible. That product/live-integration finding is recorded openly as
Step L.4 and was not changed during this test-audit workflow.

**Excluded only for the account-wide dotenv-opacity rule:**
`server/render-image.test.ts`, `server/sessions/fs-explorer.test.ts`,
`server/sessions/fs-explorer.itest.ts`, the whole
`server/testing/launcher.e2e.ts`, and the Explorer/global-axe browser cases
whose fixtures enter the same forbidden filename class. No dotenv file was
inspected. No dependency, commit, or push was added.

**Integration closure (2026-08-10):** the complete Phase UX implementation,
UX.6 refactor, UX.7 correctness repairs, UX.8 security hardening, and UX.9
test-audit repairs landed in `next` through PR #31 at merge commit `9e833849`.
DCO, Cloudflare Pages, Tier 1 typecheck/unit, and combined Tier 2/Tier 3
integration/browser checks all passed before merge.

The documentation wrapup PR #32 then exposed one test-only hermeticity flake:
all backend-choice assertions passed, but the suite's real host Codex
prompt-catalog process could outlive the daemon and race removal of its
temporary `CODEX_HOME` (`ENOTEMPTY`). The backend-routing integration test now
uses a deliberately missing Codex binary for catalog discovery; it never drives
a provider process, retains the exact backend-choice assertions, and passed
10/10 unchanged focused repetitions after the fix.

## Moved 2026-08-11 (Codex → Ollama intermittent-turn diagnosis — full body)

### Step L.4 — Diagnose intermittent Codex → Ollama real turns (completed 2026-08-11)

**Goal:** make the shipped local Codex path reliably complete or fail with a
specific actionable diagnosis; do not weaken the live test into accepting a
stalled or truncated turn.

**Starting evidence (2026-08-10):** with identical code, credentials stripped,
a throwaway Codex home, and `qwen3-1.7b-32k:latest`, the Tier 4 turn timed out at
300 seconds in three of four attempts and passed once after 145.5 seconds. The
catalog stayed fast. Test-abort cleanup was already fixed and separately
proven; the open item was the underlying integration behavior.

**Observed cause, before product changes:** the Codex SDK starts the installed
CLI and buffers a reasoning/message item until that item completes. Ollama's
own trace showed the request active throughout: a 7,674–7,708-token Codex +
Mirafold prompt was being prefilled on a four-core CPU, followed by Qwen
reasoning at roughly 1.3 tokens/second. A direct Responses probe proved
`reasoning.effort = "none"` is accepted by Codex 0.147.0 and forwarded to
Ollama, while `low` still reasons and `/no_think` in prose does not disable the
API's reasoning mode. Canonical `codex exec --oss --local-provider ollama`
showed the same default reasoning, ruling out Mirafold's provider binding.

The first five-minute implementation attempt failed, and its failure was kept
visible: `none` was correctly forwarded (`thinking = 0`), but a cold 32K runner
had reached only 6,144 of 7,676 prompt tokens when the deadline aborted it. Two
unchanged reruns appeared to pass in roughly one minute, but Ollama's trace
proved those were false greens: `/api/tags` recency order had moved the base
`qwen3:1.7b` model to row zero, it loaded at 4K, and Ollama silently truncated
the ~7.5K prompt to 2,050 tokens. Both passes were discarded. The live helper
now sorts names and accepts only `/api/show` metadata with an explicit
`num_ctx >= 32768`; the parser has its own unit regression.

**Executable changes:**

- [x] A probe-discovered local Codex session adds `none` to its existing
  `/effort` picker. Nothing is forced: the user's configured/model default
  remains in effect until they explicitly select it. First-party sessions and
  config-declared providers keep the SDK's ordinary effort catalog.
- [x] Only probe-discovered local Codex turns receive an outer deadline,
  defaulting to eight minutes (`MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS=0`
  disables it). The measured cold full-context turn needed 385.9 seconds, so
  the former five-minute assumption was replaced rather than stacked.
- [x] A deadline abort uses the existing `AbortController`, emits one specific
  prefill/reasoning recovery message, and closes with exactly one `turn_end`.
  Other local provider failures add the concrete server-running/model-served
  check after endpoint redaction. The documented timeout key is included in
  the existing constrained project-setting allowlist. No package or wire shape
  changed.

**Test changes:**

- [x] Unit coverage pins local-vs-nonlocal effort catalogs, `none` reaching
  thread options, actionable local provider failures, the timeout abort, and
  one-error/one-`turn_end` grammar while preserving silent user interrupt.
- [x] Tier 4 first sends the shipped `/effort none` command, then requires real
  model text, zero errors, and one `turn_end` from a deterministically selected
  non-truncating model. A real installed-Codex probe against an OS-selected and
  then closed loopback port separately proves unavailable-engine behavior.

**Documentation changes:** README's Tier 4 contract, `docs/local-models.md`,
and `docs/ADAPTERS.md` now state the buffered-item behavior, explicit reasoning
control, context gate, local-only deadline, and recovery choices.

**Proof:** Ollama reported `n_ctx = 32768`, 7,674–7,678 prompt tokens, no
truncation, and `thinking = 0`. The same valid full-context Tier 4 turn passed
cold/warm/warm in 385.9/90.3/90.3 seconds. The real unavailable endpoint failed
actionably in 4.9 seconds; the complete Tier 4 wrapper passed 3, skipped its
credential-required OpenRouter case, and failed 0. Tier 1 passed 615/615;
TypeScript checking, the client/server production build, and `git diff --check`
passed. No metered model, dependency, wire protocol, user config file, or
dotenv file was touched.

## Moved 2026-08-11 (Explorer visual polish — full body)

### Phase E3 — Explorer visual polish (completed 2026-08-11)

**Goal:** make the existing read-only Explorer feel like a finished part of
Mirafold's workbench while preserving its interaction and data contracts.

**Verified starting state:** `web/src/components/files/FilesPanel.tsx` rendered
the root, directories, files, and symlinks as text rows with Unicode disclosure
carets, indentation, hover fill, and optional Git status letters. The Explorer
block in `web/src/styles.css` left `.files-panel` transparent and supplied no
node-type glyph or hierarchy guide. A controlled 1440×900 browser baseline
showed six rows, zero `.files-node-icon` elements, and a transparent computed
panel background. Lazy fetching, read-only drill-in, file lightbox, and phone
dialog behavior already existed and were not defects in this phase.

**References:** VS Code's official file-icon-theme documentation establishes
alongside-name icons as type signals in Explorer; JetBrains' official Project
tool-window documentation establishes compact project trees and optional
indent guides; GitHub's repository tree supplied the quieter web-facing bound.
Mirafold uses those conventions through its own theme tokens and glyph shapes,
not another product's icon set.

**Executable changes:** `FilesPanel.tsx` now renders matching inline-SVG
chevrons, quiet per-depth guides, and one decorative glyph immediately before
each node name. New `ExplorerNodeGlyph.tsx` classifies only broad families:
open/closed folder, symlink, code, configuration/data, documentation, styles,
images, and generic file. `styles.css` gives the stable desktop dock and phone
frame a compact Files toolbar, separate sticky workspace-root strip, inset
surface, compact row rhythm, theme-token glyph colors, hover/active treatment,
thin tree scrollbar, and quiet aligned Git markers. Refresh and the phone close
action live in the toolbar. Server, wire protocol, directory state/fetching,
sort order, status semantics, read-only behavior, file view/lightbox, refresh
behavior, and phone navigation are behaviorally unchanged.

**Dependency decision:** no package. Mirafold already owns small inline SVG
glyph components; a bounded set of paths and a pure classifier are safe local
presentation. An icon library would add bundle, transitive, audit, and
supply-chain surface for no protocol or correctness depth.

**Test changes:** new `ExplorerNodeGlyph.test.ts` pins hierarchy precedence,
symlink precedence, case-insensitive extension handling, configuration
basenames, every broad file family, and the generic fallback. Existing desktop
and phone browser proofs now require the open/closed root glyph and the
decorative configuration glyph for `package.json`.

**Documentation changes:** README's file map names the new glyph module and
the shipped-feature summary names the inset/type-signal polish; `PLAN.md`
compresses the completed phase to this archive pointer.

**Proof:** all 162 front-end unit tests passed; TypeScript checking and the
client/server production build passed. A controlled fixture containing no
dotenv file rendered nine glyphs at desktop width across open-folder, code,
configuration, documentation, and stylesheet families; the phone frame stayed
390px wide with no side-scroll. Dark and light appearances resolved panel and
glyph colors through their theme tokens. Focused headless-Chrome desktop and
phone rendered-contract assertions plus axe serious/critical sweeps passed.
`git diff --check` passed. PR #34's corrected replacement run then passed DCO,
Cloudflare Pages, Tier 1, and combined Tier 2/Tier 3 before merge at `21b5f33`.
No dependency, wire shape, server behavior, project file, or user data changed.

## Moved 2026-08-11 (whole-codebase correctness closure — full body)

### Phase BC — Whole-codebase correctness closure (completed 2026-08-11)

**Goal and approved boundary:** after the repository-wide bughunt reported eight
confirmed correctness failures, Kyle approved fixing all eight on a new branch
from the updated `next`. This phase modifies the existing failing paths and
their regression tests only. It creates no user feature, dependency, provider
protocol, persisted-session schema field, or write capability.

**Verified starting state:**

- `GeminiCliSession.worker()` was a fire-and-forget promise whose rejected
  turn-preparation work escaped the worker and killed every later queued turn.
- `CodexSession.applyEngineDefaultModel()` cleared its retry guard before the
  engine catalog lookup succeeded, so one transient failure disabled all later
  retries for both subscription and API-key first-party sessions.
- `startRelayClient()` cast any successful `JSON.parse()` result to an envelope;
  JSON `null` therefore reached an unguarded property read in the socket
  callback.
- `cookieToken()` let malformed percent escapes throw before a valid query token
  could recover the request.
- `SessionRegistry` derived the prompt-burst gate from composite fleet status;
  a neighboring `bang_end` could report idle and reopen the gate while active
  and queued model turns still existed.
- `listTree()` and `gitTree()` compared JavaScript character counts at admission
  even though their accumulated budget used UTF-8 bytes, allowing multibyte
  paths past the documented byte ceiling.
- home/root rendering assumed `/`, so Windows backslash paths failed to shorten
  or display their leaf; a broad first repair was directly probed and shown to
  misclassify legal POSIX backslashes, then narrowed before commit.
- active `SessionRegistry.rename()` changed the live name even when its durable
  checkpoint write failed, while the connection gave no failure feedback.

**Executable changes:** Gemini contains each queued item, emits one terminal
error grammar for preparation failure, and retries the settings merge on the
next prompt. Codex leaves the engine-default guard armed until a successful
model selection. The relay now validates runtime envelope shape, and cookie
decoding treats malformed values as absent. The registry counts pending model
turns independently from bang/permission status and pairs adapter `error` plus
`turn_end` without double-decrementing. Both filesystem tree implementations
admit paths by `Buffer.byteLength(..., "utf8")`. Explorer/root/home helpers
recognize drive, UNC, mixed-separator, and tildified Windows paths while
preserving POSIX case and literal-backslash semantics. Active rename restores
the previous name on checkpoint failure and sends an actionable viewport error.

**Test changes:** focused regressions cover Gemini worker survival, Codex retry
under both credential modes, valid-JSON scalar relay input through a real local
socket, malformed and duplicate cookies, active/queued/error model-turn
grammar beside bang traffic, real failed checkpoint rename, plain-walk and real
Git UTF-8 admission, and Windows/mixed-separator/root/boundary paths plus the
POSIX-backslash counterexample. No existing assertion was weakened to make a
fix pass.

**Documentation changes:** `PLAN.md` records the completed single-pass phase and
the final PR #34 merge state; `HANDOFF.md` replaces its stale uncommitted-branch
state with PR #35's review state. README and product documentation are unchanged
because no public contract or workflow was added.

**Proof:** 577/577 ordinary safe unit assertions passed; the aggregate-sensitive
Codex catalog, Gemini catalog, and version files passed independently (17/17),
and the final affected-unit run passed 151/151. The guarded Tier 2 matrix passed
131/131. The correctly filtered guarded Tier 3 matrix passed 70/70 across six
browser files. TypeScript, direct guarded Vite and esbuild production builds,
and `git diff --check` passed. The one new plain-walk UTF-8 case also passed
alone under the denial guard without running its file's dotenv-manufacturing
fixtures. The dotenv-manufacturing tests, launcher browser file, and eight
Explorer/global-axe browser cases remain excluded.

During the first Tier 3 attempt, a negative run-pattern matched the file-level
parent and unintentionally selected six Explorer cases. The run was stopped as
soon as their names appeared. The preloaded guard prevented dotenv content
reads, but those cases may have listed a forbidden filename; this was reported
immediately. A harmless unit probe established the cause, and the replacement
used Node's dedicated positive skip pattern: 66/66 app/bundle/fleet/phone/
recovery plus the already-passed 4/4 relay cases. No product code changed in
response to either orchestration error.

**Git state:** PR #34's rendered-title CI assertion was corrected in signed,
DCO-signed-off commit `5de3f2e`; its replacement DCO, Cloudflare, Tier 1, and
combined Tier 2/Tier 3 checks passed before merge into `next` at `21b5f33`.
The eight correctness repairs are signed and DCO-signed-off in `3ed7236` and
published as open PR #35 into `next`. Per Kyle's instruction, PR #35 remains
unmerged for review.
