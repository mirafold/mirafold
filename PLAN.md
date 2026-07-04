# genui-shell — Build Plan

A generative-UI shell over Claude Code. Claude Code's full agentic backend
(filesystem, bash, tools, the warm session loop) runs behind a web front end
where the agent's output stream is treated as a **UI-instruction stream**: the
agent paints into an output zone whose components change shape per response,
while a fixed, trusted shell holds the prompt box and the connection.

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
- **Dev without the API:** when `ANTHROPIC_API_KEY` is unset the server falls
  back to a `MockSession` — same `AgentSession` interface, same wire protocol,
  scripted replies (5 shuffled demo templates). Every UI capability is built
  and tested against the mock first; live-agent verification comes last.
- **UI verification:** every front-end step is verified in headless Chrome via
  `playwright-core` (drives real typing/clicks against the system browser).

## Design identity (locked during Phase 0)

genui-shell is a **terminal successor, not a chat app** — the design signals
terminal lineage on the input side and web richness on the output side:

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
  // Phase 1 adds:  { type: "render"; component: string; props: object; id: string }
  //                (re-sending an id updates that component's props in place —
  //                 this is what makes pinned widgets live, see Step 1.6)
  // Phase T adds:  { type: "tool_output"; ... } and { type: "permission_request"; ... }
  // Phase 2 adds:  action descriptors carried inside render props
  // Phase 3 adds:  { type: "artifact"; html: string; id: string }
```

Browser→server is just `{ type: "prompt"; text: string }` plus
`{ type: "interrupt" }` / `{ type: "permission_response"; ... }` (Phase T)
and `{ type: "action"; ... }` (Phase 2). The output zone is an **interpreter** for
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

- [ ] **Step 0.3 — Warm session + permissions**
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
  - Status: **code complete** — `Session` + `MockSession` behind one
    `AgentSession` interface; deltas route to the streaming turn by id (a
    mid-stream prompt can't detach a reply's tail). The live "done when"
    is the only remaining item and needs `ANTHROPIC_API_KEY` in `.env`.

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

- [ ] **Step 0.7 — Workspace scoping & reconnect stub + smoke test**
  - Goal: agentic power works safely; the loop is solid end to end.
  - Build: point the session's working dir at `./workspace/` (gitignored);
    confirm `canUseTool` keeps bash/writes inside it. Write a short
    `README.md` with run instructions (note: Node 22 via nvm, yarn via
    corepack — system node is a bare v18 with no npm).
  - Status: reconnect stub already shipped in `web/src/ws.ts` (re-opens on
    drop, queues sends while closed); workspace dir + `canUseTool` are wired
    in `session.ts`/`permissions.ts`. Remaining: live smoke test (needs API
    key) + README.
  - Files: `README.md`; verification only for the rest.
  - Done when: you can ask the agent to create/read a file in `workspace/` and
    see it on disk; killing and restarting the socket reconnects without a page
    reload. **Phase 0 complete — this is a usable nicer Claude Code.**

---

## Phase T — Terminal parity (interleave with Phase 1 as desired)

Goal of the phase: close the gap with the terminal Claude Code *experience* —
the engine already has capability parity; these give the browser the cockpit.
Priority order was set explicitly: tool output → interrupt → permission
prompts. Each step is independent and additive on the wire.

- [ ] **Step T.1 — Tool output in the transcript**
  - Goal: see what the agent actually did, not just that it used a tool.
  - Build: add `{ type: "tool_use"; name: string; detail?: string; id: string }`
    and `{ type: "tool_result"; output: string; isError?: boolean; id: string }`
    to `WireMsg`; normalize the SDK's tool events in `session.ts`. Render as
    collapsed, monospace blocks in the transcript (click to expand); errors
    expanded by default.
  - Done when: a Bash run shows its command and (collapsed) output inline in
    the scrollback, styled like terminal output.

- [ ] **Step T.2 — Interrupt**
  - Goal: stop a runaway or wrong-direction turn without killing the session.
  - Build: add `{ type: "interrupt" }` to `ClientMsg`; wire to the SDK's
    `interrupt()`. Esc key + a stop affordance in the shell while a turn is
    streaming.
  - Done when: Esc mid-stream halts output, the session stays warm, and the
    next prompt works.

- [ ] **Step T.3 — Browser permission prompts**
  - Goal: interactive approval like the terminal, rendered by the trusted shell.
  - Build: `canUseTool` awaits the browser — server sends
    `{ type: "permission_request"; tool: string; detail: string; id: string }`,
    client replies `{ type: "permission_response"; id: string; allow: boolean }`.
    Timeout defaults to deny. The prompt UI is shell-owned (never agent-rendered).
  - Done when: a gated Bash command pauses the turn, an Allow/Deny bar appears,
    and the decision resolves the tool call.

---

## Phase 1 — Component registry (Level 2 generative UI)

Goal of the phase: the output zone transforms per response. The agent picks and
parameterizes **your** components; it does not author them. Reliable and safe.

- [ ] **Step 1.1 — Extend protocol with `render`**
  - Goal: a typed contract for "show component X with props P".
  - Build: add `{ type: "render"; component: string; props: object; id: string }`
    to `WireMsg`. Define a `RegistrySpec` listing allowed component names and a
    JSON schema (or zod schema) for each component's props. Semantics: a
    `render` with an already-seen `id` **updates that component's props in
    place** — this is the mechanism behind live pinned widgets (Step 1.6).
  - Files: `server/protocol.ts`, `server/registry-spec.ts`.
  - Done when: types compile; the registry spec enumerates the Phase 1
    components (card, list, table, link-group).

- [ ] **Step 1.2 — Render tools + system prompt**
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

- [ ] **Step 1.3 — Front-end registry + components**
  - Goal: render messages become real components in the output zone.
  - Build: `web/src/registry/` with a `registry` map (name → React component)
    and components `Card`, `List`, `Table`, `LinkGroup`. `RenderZone` dispatches
    `render` messages to `registry[component]` with `props`, interleaving them
    with text turns in order.
  - Files: `web/src/registry/*`, `web/src/RenderZone.tsx`.
  - Done when: a single response renders mixed styled text **and** a live
    component (e.g. a table), in the right order.

- [ ] **Step 1.4 — Validation & graceful fallback**
  - Goal: a malformed instruction never breaks the UI.
  - Build: validate `render` props against the registry schema on the client
    (and/or server). On failure or unknown component, fall back to rendering the
    raw content as styled text and surface a quiet warning. Add an error
    boundary around each rendered component.
  - Files: validation util, `RenderZone.tsx`.
  - Done when: an intentionally bad `render` message degrades to styled text
    instead of throwing; a component that throws is caught by its boundary.

- [ ] **Step 1.5 — Richer component + polish**
  - Goal: prove the registry scales to a non-trivial component.
  - Build: add a `Chart` (or similarly richer) component + its schema + render
    tool; polish spacing/animation as components mount into the output zone.
  - Files: `registry/Chart`, spec, render tool.
  - Done when: the agent can render a chart from data it produced.

- [ ] **Step 1.6 — Pin dock (emergent side panel)**
  - Goal: keep chosen outputs visible while the transcript scrolls forever.
    The primitive is **pinning, not a panel** — the dock only exists while
    something is pinned, so users who never pin never see it.
  - Build: a pin affordance drawn by the **shell** around each rendered block
    (hover; shell-owned, never agent-rendered — the agent can't fake or grab
    it). Pinning promotes the block into a right-side dock; unpinning returns
    it to its place in history. Dock collapses to a thin edge tab; dissolves
    entirely when the last pin is removed. Pure client-side output-zone state —
    no wire change. Pinned `render` components stay **live** via
    re-render-by-id (Step 1.1), so the agent can update a pinned chart while
    the conversation continues. Later (Phase 2): a `{kind:"state"}` action may
    let the agent itself pin/unpin.
  - Files: `web/src/PinDock.tsx`, `RenderZone.tsx`, `Shell.tsx`, styles.
  - Done when: pin a rendered chart, keep prompting — the chart stays visible
    and updates when the agent re-renders its id; unpinning the last item
    dissolves the dock. **Phase 1 complete — the output zone changes shape on
    demand, and can hold its shape when you ask it to.**

---

## Phase 2 — Action bridge

Goal of the phase: components become interactive. Every action is typed and
mediated by the server; the client never makes arbitrary external calls.

- [ ] **Step 2.1 — Action protocol**
  - Goal: a typed vocabulary for what a component interaction can do.
  - Build: define an `Action` union: `{kind:"prompt", text}` (send a follow-up
    into the warm session), `{kind:"tool", name, args}` (invoke a server-side
    whitelisted tool), `{kind:"state", ...}` (update output-zone state only).
    Add `{ type:"action"; action: Action; sourceId: string }` to `ClientMsg`.
  - Files: `server/protocol.ts`.
  - Done when: types compile; render props can carry action descriptors.

- [ ] **Step 2.2 — Interactive components**
  - Goal: buttons/selects in components emit actions through the shell.
  - Build: extend components to accept action props and emit `action` messages
    via the shell's socket (the shell owns the socket — components ask the shell
    to send). Wire `prompt` actions to `pushPrompt`, `state` actions to local
    render-zone state.
  - Files: `registry/*`, `Shell.tsx`, `ws.ts`.
  - Done when: clicking a button in a rendered component sends a follow-up
    prompt that the agent answers in the same warm session.

- [ ] **Step 2.3 — Server-side action mediation**
  - Goal: `tool` actions are safe and auditable.
  - Build: a server-side allowlist of callable tools with arg validation;
    reject anything not on it; log every action. No direct client→external
    network calls — everything routes through the server.
  - Files: `server/actions.ts`, `server/index.ts`.
  - Done when: an allowlisted `tool` action runs server-side and returns a
    result into the conversation; a non-allowlisted one is rejected and logged.
    **Phase 2 complete — components can act, safely.**

---

## Phase 3 — Sandboxed artifacts (Level 3)

Goal of the phase: when no registry component fits, the agent emits
self-contained UI rendered in a locked-down iframe. The "build anything on the
fly" capability, gated behind the security model.

- [ ] **Step 3.1 — Sandboxed iframe host**
  - Goal: a safe container for arbitrary agent-authored HTML/JS.
  - Build: `web/src/Artifact.tsx` — renders content into a sandboxed
    `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), strict CSP, no
    access to the shell's scope, network, or storage. Document the threat model
    inline.
  - Files: `web/src/Artifact.tsx`.
  - Done when: a static test artifact renders in the iframe and provably cannot
    read anything from the shell (no cookies, no parent DOM, no socket).

- [ ] **Step 3.2 — Artifact wire message + agent capability**
  - Goal: the agent can emit an artifact.
  - Build: add `{ type:"artifact"; html: string; id: string }` to `WireMsg`;
    add an `emit_artifact` tool + system-prompt guidance (use only when no
    registry component fits). `RenderZone` routes artifacts to `Artifact.tsx`.
  - Files: `protocol.ts`, `server/render-tools.ts`, `RenderZone.tsx`.
  - Done when: the agent generates a small interactive artifact and it renders
    in the sandbox.

- [ ] **Step 3.3 — postMessage bridge → action mediation**
  - Goal: artifacts can act, only through the Phase 2 mediated path.
  - Build: a `postMessage` protocol between the iframe and the shell; the shell
    validates and forwards artifact-originated actions through the **same**
    server-side mediation/allowlist from Step 2.3. Nothing else gets out.
  - Files: `Artifact.tsx`, `Shell.tsx`, `server/actions.ts`.
  - Done when: a button inside an artifact triggers an allowlisted action via
    the bridge; an attempt to call anything off-allowlist is blocked.

- [ ] **Step 3.4 — Artifact error boundaries & fallback**
  - Goal: broken artifacts never take down the page.
  - Build: load/runtime error handling around the iframe; on failure, fall back
    to showing the artifact source as styled code with a note.
  - Files: `Artifact.tsx`.
  - Done when: a deliberately broken artifact fails gracefully.
    **Phase 3 complete — arbitrary UI on the fly, sandboxed.**

---

## Phase 4 — Product hardening (the "others would want it" path)

Goal of the phase: persistence, multiple sessions, polish, robust resume, and
the multi-user seam. Each step is optional/independent — do as needed.

- [ ] **Step 4.1 — Session persistence**
  - Build: persist conversation + render history; restore on reconnect so a
    drop/refresh resumes the same view.
  - Done when: refreshing the page restores the conversation and rendered
    components.

- [ ] **Step 4.2 — Multi-session UI**
  - Build: list / switch / create sessions in the shell; one warm session per
    active conversation server-side.
  - Done when: you can keep several conversations and switch between them.

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
