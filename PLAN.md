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
- **Distribution: local-first.** The daemon ships as `npx genui-shell` and
  runs on the user's machine; we host only a static site/billing and (paid
  tier) a dumb WebSocket relay that forwards wire-protocol frames. The engine
  never runs on hosted compute; the API key never leaves the user's machine.
  Hosted execution is explicitly out of scope. (Rationale: BUSINESS.md §5.)
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

- [ ] **Step P.5 — Third agent + graceful degradation**
  - Goal: prove N agents (add Gemini CLI), and that optional capabilities
    degrade by absence.
  - Build: a Gemini CLI adapter on the same seam; the **optional-feature rule** —
    a capability an agent doesn't expose simply doesn't appear (e.g. the
    reasoning stream renders only when that agent emits `thinking_delta`), no
    special-casing; lean on Step 1.4's render fallback for weaker/local models.
  - Done when: three agents (Claude Code, Codex, Gemini CLI) each run as their
    own faithful skin behind one front end. **Phase P complete — each agent,
    faithfully re-skinned; everyone's own tool in the browser.**

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

- [ ] **Step 4.3 — Theming & output-zone polish**
  - Build: theme system, transitions as components mount, friendlier visuals.
  - Done when: the experience feels deliberately designed, not default.

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
