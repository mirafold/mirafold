# genui-shell

A **generative-UI shell over the Claude Agent SDK**. Claude Code's full agentic
engine — filesystem, bash, tools, a warm persistent session — runs behind a web
front end, and the agent's output stream is treated as a **UI-instruction
stream**: today it paints streamed markdown into an output zone; in later
phases it will paint live components, then sandboxed arbitrary UI. A fixed,
trusted shell owns the prompt box, the socket, and all credentials, and the
agent can never touch any of them.

Think of it as a terminal successor, not a chat app: monospace command strips
in, rich rendered output back.

![genui-shell demo — paste data, get a live chart, pin it, keep working; the agent updates the pinned chart in place](demo/demo.gif)

*The arc above, live and unscripted: paste numbers → the agent chooses a
chart component → hover it (it's a real component, not a picture) → pin it →
keep working → ask for a change and the agent updates the **pinned** chart
in place.*

This document is the technical orientation for someone taking ownership of the
codebase. Companion documents:

- **[PLAN.md](PLAN.md)** — the phased build plan. Every step has
  Goal / Build / Files / Done-when. The repo currently implements **Phase 0**
  (the spine); PLAN.md is the source of truth for what comes next and why.
- **[BUSINESS.md](BUSINESS.md)** — positioning, wedges, pricing, and the
  milestone gates that sequence the plan. The two build-relevant conclusions:
  ship the Phase 1 demo before Phase T, and keep every seam local-first.

---

## 1. The one-paragraph mental model

The server holds a **warm agent session** (one long-lived `query()` from
`@anthropic-ai/claude-agent-sdk`, fed prompts through an async generator so
the conversation and prompt cache never reset between turns). The session's
SDK event stream is **normalized into a tiny wire protocol** (`WireMsg`) and
pushed over a WebSocket to the browser. The browser is split into two zones
with a hard security boundary: a **trusted shell** (prompt box + socket
client, never re-rendered by agent output) and an **output zone** that is
purely an *interpreter* of `WireMsg` — it renders whatever messages arrive
and has no other inputs. Growing the product = adding message types to the
wire protocol and handlers to the interpreter. Nothing else changes shape.

## 2. The two load-bearing contracts

Everything in the repo hangs off two interfaces. Internalize these and you
can navigate the whole codebase.

### 2.1 The wire protocol (`server/protocol.ts`)

The contract between server and browser. Currently on the wire:

```ts
// Server → browser
type WireMsg =
  | { type: "text_delta"; text: string }                          // streamed markdown
  | { type: "status"; state: "thinking" | "tool"; label?: string } // activity line
  | { type: "turn_end" }                                           // finalize the turn
  | { type: "error"; message: string }
  | { type: "render"; component: string; props: Record<string, unknown>; id: string };
    // ^ Phase 1: "mount registry component X with props P". Re-sending an id
    //   updates that component in place (the live-pinned-widget mechanism).
    //   `component` is a plain string so unknown instructions stay
    //   representable and can degrade gracefully (Step 1.4).

// Browser → server
type ClientMsg = { type: "prompt"; text: string };
```

**The cardinal rule: later phases ADD message types; existing shapes never
change.** That's what makes every phase additive and keeps old clients from
breaking. PLAN.md's protocol section sketches exactly which types each phase
adds (`render` for components, `tool_use`/`tool_result`, `permission_request`,
`artifact`, session-registry messages, …).

Both sides import the *same file*: the web build resolves `@protocol` to
`server/protocol.ts` via a Vite alias + tsconfig path. There is one source of
truth for message shapes, enforced by the type checker on both ends.

### 2.2 `AgentSession` (`server/session.ts`)

```ts
interface AgentSession {
  pushPrompt(text: string): void;          // feed a user turn in
  onMessage(cb: (msg: WireMsg) => void): void; // subscribe to normalized output
  close(): void;
}
```

Two implementations exist behind this interface, and the server (and
everything downstream, including the entire front end) cannot tell them
apart:

- **`Session`** — the real thing, wrapping the Agent SDK.
- **`MockSession`** — a scripted stand-in used automatically when
  `ANTHROPIC_API_KEY` is unset. Emits every wire message type with
  realistic pacing, drawing replies from a shuffled deck of five demo
  templates (welcome, analytics report, code review, migration plan,
  research brief), and ends every turn with a schema-valid `render` so the
  Phase 1 component pipeline is exercised API-free.

This is a deliberate development strategy, not a testing afterthought:
**every UI capability is built and verified against the mock first**; live
verification with a real key comes last. You can develop the whole front end
without spending a token.

## 3. The security model (do not violate)

Two zones in the browser, hard boundary between them:

```
┌─ OUTPUT ZONE — agent-controlled, sandboxed ──────────┐
│   Level 1: styled markdown            (shipped)      │
│   Level 2: registry components        (shipped)      │
│   Level 3: sandboxed-iframe artifacts (Phase 3)      │
├─ SHELL — TRUSTED, never re-rendered by the agent ────┤
│   prompt box · WebSocket client · all credentials    │
└──────────────────────────────────────────────────────┘
```

The invariants, and where each is enforced today:

- **The API key never reaches the browser.** It lives only in the server
  process (`server/index.ts` reads env; nothing ever serializes it into a
  `WireMsg`).
- **The agent only emits content into the output zone.** `RenderZone` is the
  sole consumer of agent output, and it only ever renders — it holds no
  socket, no credentials, no callbacks into the shell beyond subscription.
- **No raw HTML from the agent.** `react-markdown` never emits raw HTML from
  its source by default, so streamed markdown can't smuggle script or markup.
  Links are forced to `target="_blank" rel="noopener noreferrer"`.
- **Tool use is gated server-side** (`server/permissions.ts`, see §5.3).
- **WebSocket hijacking guard**: browser connections must present a loopback
  `Origin`; a malicious web page can't drive your local agent through a
  cross-site socket. Non-browser clients (wscat, tests) send no Origin and
  pass — they aren't weaponizable the way a browser socket is.

When Phase 3 lands, agent-authored executable UI runs in a sandboxed iframe
(`allow-scripts`, no `allow-same-origin`) that can only talk back through a
mediated, allowlisted action bridge (Phase 2). The trusted shell is why this
product can safely let an agent paint UI at all — treat the boundary as
inviolable, and treat "the shell draws it, the agent can't fake it" as the
extension of the same rule: the pin affordance is already drawn this way (a
frame *around* rendered blocks, unreachable from agent props), and Phase T's
permission prompts will follow it.

## 4. Repository layout

```
server/            the local daemon (Node, run with tsx)
  protocol.ts        WireMsg/ClientMsg — the shared wire contract
  registry-spec.ts   zod shapes per component — spec = tool schema = validation
  render-tools.ts    render_* tools (in-process MCP server) + RENDER_GUIDANCE
  session.ts         Session (real SDK) + MockSession behind AgentSession
  permissions.ts     canUseTool policy: workspace-scoped tool gating
  index.ts           Express + ws server; binds sockets to sessions
web/               the browser app (React 19 + Vite)
  index.html         entry html
  src/main.tsx       mounts <Shell/>, imports global CSS + highlight theme
  src/Shell.tsx      TRUSTED SHELL: owns socket + prompt box; message bus
  src/PromptBox.tsx  the command bar (auto-grows to 8 lines; Enter sends)
  src/RenderZone.tsx OUTPUT ZONE: WireMsg interpreter → entries + status line
  src/PinDock.tsx    right-side dock for pinned components (live via entries)
  src/registry/      Card, List, Table, LinkGroup, Chart + RenderBlock
                     (RenderBlock = validate → fallback → error boundary)
  src/ws.ts          SocketClient: typed send/onMessage, auto-reconnect
  src/styles.css     the design identity in CSS (see §7)
demo/              the M1 demo GIF embedded at the top of this README
dist/              built front end (vite build output; served by Express)
workspace/         the agent's cwd — gitignored; all mutation is confined here
PLAN.md            the phased build plan (source of truth for next steps)
BUSINESS.md        strategy; gates that sequence the plan
vite.config.ts     web root, @protocol alias, /ws proxy → :3000, dist output
tsconfig.json      one tsconfig for both sides; @protocol path
.env.example       ANTHROPIC_API_KEY / DEFAULT_MODEL / PORT
```

There is intentionally **no** shared `common/` package, monorepo tooling, or
build step for the server — the repo is one yarn package, the server runs
TypeScript directly via `tsx`, and the single shared file (`protocol.ts`)
crosses the boundary via a path alias.

## 5. The server, top to bottom

### 5.1 `index.ts` — transport

Express serves `dist/` (the built front end; in dev you use Vite's server
instead) and hosts a `ws` WebSocketServer at `/ws` with the loopback-Origin
guard. On each connection it constructs **one session per connection**
(`Session` if `ANTHROPIC_API_KEY` is set, else `MockSession`), wires
`session.onMessage → ws.send(JSON)`, and forwards valid
`{type:"prompt"}` client messages into `session.pushPrompt`. Socket close
closes the session.

One-session-per-connection is an explicitly temporary stopgap: the locked
design is that **sessions are decoupled from connections** — a connection is
a *viewport* that attaches to a session in a server-side registry, sessions
survive refreshes, and one session fans out to many viewports (second tab,
phone via relay). That registry is PLAN Step 4.2 and is the substrate for
persistence, the fleet view, and the paid relay. Until then, a page refresh
means a fresh session.

### 5.2 `session.ts` — the warm session

`Session` is the heart of the server. Key mechanics:

- **One `query()` for the life of the object.** The SDK call's `prompt` is
  an async generator (`promptStream`) backed by a tiny unbounded
  `AsyncQueue`. `pushPrompt(text)` pushes into the queue; the generator
  yields it to the SDK as a user message. Because the query never ends
  between turns, the conversation stays **warm and prompt-cached** — this is
  the "warm session loop" and it's why multi-turn feels instant and cheap.
- **`pump()` normalizes SDK events into `WireMsg`:**
  - `stream_event` → `content_block_delta` (text) becomes `text_delta`
    (enabled by `includePartialMessages: true`, which is what gives
    token-level streaming rather than whole-message chunks);
    `content_block_start` for a thinking block becomes
    `status:{state:"thinking"}`, for a tool_use block becomes
    `status:{state:"tool", label:<tool name>}`.
  - Events carrying a `parent_tool_use_id` are **subagent traffic** and are
    skipped — a subagent's inner monologue must not paint into the user's
    transcript.
  - `result` → `error` (if `is_error`) then always `turn_end`.
- **`close()`** pushes a sentinel that ends the generator and calls
  `interrupt()` on the SDK query.
- Session options: `cwd` is the resolved `workspace/` dir (created on
  construction — spawning into a missing cwd fails with a misleading SDK
  error), model comes from `DEFAULT_MODEL` (default `claude-sonnet-4-6`,
  switchable to `claude-opus-4-8` per the locked decisions), and
  `canUseTool` comes from `permissions.ts`.
- **Generative UI (Phase 1):** the session mounts an in-process MCP server
  (`server/render-tools.ts`) exposing side-effect-free `render_card` /
  `render_list` / `render_table` / `render_chart` / `render_links` tools
  whose input schemas are the registry spec (`server/registry-spec.ts`) plus
  an optional `id` for update-in-place. Calling one emits a `render` WireMsg
  at that point in the stream and returns the id to the model.
  `RENDER_GUIDANCE` (appended to the `claude_code` system-prompt preset)
  teaches when to prefer a component over prose — and that raw HTML/SVG
  renders as literal code, so the agent never improvises markup (arbitrary
  visuals are Phase 3's sandboxed artifacts). The tool schemas' `.describe()`
  strings are written for the model. The agent reaches for components
  unprompted — verified live.

`MockSession` implements the same interface with `setTimeout`-scheduled
emissions: a `thinking` status, 1–3 fake tool statuses, the reply streamed
in 16-char chunks at ~12ms, then `turn_end`. `close()` clears all pending
timers.

### 5.3 `permissions.ts` — the Phase 0 tool policy

`makeCanUseTool(workspaceDir)` returns the SDK's `canUseTool` callback:

1. **Read-only tools** (Read, Glob, Grep, WebFetch, WebSearch, TodoWrite,
   Task, NotebookRead) → always allowed. Likewise `mcp__ui__render_*` —
   our render tools emit UI and have no side effects.
2. **Path-targeted mutations** (Write/Edit/MultiEdit/NotebookEdit) → allowed
   only if the target path resolves inside the workspace root (`isInside`
   does a resolve-then-prefix check).
3. **Bash** → the session's cwd *is* the workspace, so confinement is
   heuristic: a regex denies commands containing absolute paths, `..`, or
   `~` where they end a token (so `cd .. && …` can't slip through
   mid-command). It can false-positive on legitimate commands (e.g. a path
   inside a quoted string) — accepted as coarse-on-purpose for a
   personal-first Phase 0; real interactive permission prompts are Phase T.3.
4. **Everything else** → denied.

## 6. The front end, top to bottom

### 6.1 `Shell.tsx` — the trusted shell and its message bus

`Shell` builds (once, in a `useMemo`) a tiny **bus**: a `SocketClient` plus a
listener set. It exposes exactly two capabilities downward:

- `subscribe(listener)` — RenderZone's only way to receive messages.
- `sendPrompt(text)` — PromptBox's only way to send. It forwards
  `{type:"prompt"}` over the socket **and** synthesizes a local
  `{type:"user_prompt"}` echo into the bus, which is how the user's own turn
  appears in the transcript without a server round-trip.

`ZoneMsg = WireMsg | {type:"user_prompt"}` is therefore the output zone's
full input vocabulary: the wire protocol plus one local echo. Note the
direction of the design: components ask the shell to send; nothing below the
shell ever holds the socket.

### 6.2 `ws.ts` — `SocketClient`

A thin typed WebSocket wrapper: `send(ClientMsg)` / `onMessage(WireMsg)`.
Two behaviors matter:

- **Auto-reconnect**: on non-deliberate close it retries every 1s. This is
  the Phase 0 stub — the socket comes back, but the server gives it a *new*
  session (real resume is Phase 4).
- **Send queueing**: sends while closed are buffered and flushed on open, so
  typing during a blip isn't lost.

In dev it connects to `ws://<page-host>/ws` and Vite proxies `/ws` to the
server on :3000; in prod Express serves both HTTP and WS on one port, so the
same relative URL works unchanged.

### 6.3 `RenderZone.tsx` — the interpreter

State: a flat list of `Entry`s — text blocks (`{kind:"text", role, text,
done}`) and rendered components (`{kind:"render", renderId, component,
props}`) — in the exact order they arrived on the wire, plus an ephemeral
`Status`. The reducer-like subscription handles each `ZoneMsg`:

- `user_prompt` → append a done user text entry, show `thinking`.
- `text_delta` → append to the **streaming text block**, or open one if
  none is active. The streaming block's id lives in a ref
  (`streamingId`), *not* derived from "last entry in the list" — this is a
  deliberate correctness detail: if the user sends a new prompt mid-stream,
  the user entry is appended after the streaming block, and deltas still
  route to the right block by id instead of gluing the reply's tail onto
  the wrong one.
- `render` → if the wire `id` has been seen, **update that entry's props in
  place** (this is what keeps pinned widgets live); otherwise append a
  render entry and close the streaming text block, so later deltas open a
  new block *after* the component — the transcript keeps wire order.
  Dispatch goes through `RenderBlock` (`web/src/registry/RenderBlock.tsx`),
  the single guarded path shared with the pin dock: unknown component or
  schema-invalid props degrade to a quiet warning + raw props as styled
  code, and a component that throws anyway is caught by a per-block error
  boundary — a malformed instruction can never break the UI.
- `status` → set the activity line (`✳ thinking…` / `⚙ Bash`).
- `turn_end` → mark the streaming block done, clear the ref and status.
- `error` → rendered as a bold-prefixed assistant entry.

**Pinning (Step 1.6):** every rendered block gets a shell-drawn 📌 on hover.
Pinning promotes it to a right-side dock (`PinDock.tsx`) and leaves a dashed
stub holding its place in history; the dock collapses to a thin edge tab and
dissolves when the last pin is removed. Pin state is pure output-zone state
(`renderIds` in pin order) — no wire changes — and the dock renders the same
entry objects the transcript holds, so update-in-place keeps pinned
components live for free.

Assistant turns render through `react-markdown` + `remark-gfm` (tables,
task lists) + `rehype-highlight` (fenced code), with links forced to open
safely in a new tab. Auto-scroll keeps the bottom in view as content
streams.

Adding UI capability = adding a `case` here for a new message type (plus, in
Phase 1, dispatching `render` messages into a component registry). That's
the whole extension model.

### 6.4 `PromptBox.tsx`

A textarea with the green `❯` glyph that auto-grows with content (wraps and
newlines both) up to 8 lines, then scrolls internally — a thin scrollbar is
the "there's more" cue — and collapses back to one line on send. Enter
submits (trimmed, non-empty), Shift+Enter inserts a newline. No send
button — that's part of the identity, not an omission.

## 7. Design identity (locked)

The visual language is a **terminal transcript, not a chat app** — worth
knowing because it constrains future UI work:

- Full-width canvas, no centered column. If long prose ever needs a cap, cap
  prose only (`max-width: 80ch`) — never tables, code, or components.
- **Mono-in / rich-out is the identity**: user input renders as a monospace
  "command strip" (tinted full-width band, green left edge, `❯` glyph) that
  *segments* the scrollback; everything between strips is agent output in
  proportional type with rich markdown. No bubbles, ever.
- Status is a dim, pulsing monospace activity line — not a spinner, not a
  pill.
- Dark palette lives in `styles.css`; `highlight.js`'s github-dark theme for
  code.
- Future side surfaces (pin dock, status bar) must be emergent/collapsible —
  users who never pin never see a panel.

## 8. Running it

### Prerequisites

- **Node 22 via nvm** — the system node here is a bare v18 with no npm.
  Source nvm in any shell you use:
  ```sh
  source ~/.nvm/nvm.sh && nvm use 22
  ```
- **yarn** for all package operations (via corepack: `corepack enable`).

### Development

```sh
yarn install
yarn dev          # concurrently: tsx watch server (:3000, blue) + Vite (:5173, green)
```

Open **http://localhost:5173**. Vite serves the front end with HMR and
proxies `/ws` to the server. With no `.env`, you're in **mock mode** — type
anything and the scripted personas exercise the full rendering pipeline.

To go live: `cp .env.example .env`, set `ANTHROPIC_API_KEY`, restart the
server. The env file is loaded with `process.loadEnvFile()` and is optional
by design. `DEFAULT_MODEL` and `PORT` can also be set there.

Individual processes: `yarn dev:server` / `yarn dev:web`.

### Production-ish

```sh
yarn build        # vite build → dist/
yarn dev:server   # Express serves dist/ and ws on :3000
```

Open http://localhost:3000 — one port, no proxy.

### Checks

```sh
yarn typecheck    # tsc --noEmit over server + web + vite config
```

There is no test suite yet. The project's verification convention (from
PLAN.md) is: every front-end step is verified end-to-end in headless Chrome
via `playwright-core` (real typing/clicks), and every capability is proven
against the mock before the live agent.

### The workspace

The agent's working directory is `./workspace/` (gitignored, created on
demand). All file mutation and bash activity is confined there by the
permission policy. Deleting it between sessions is a clean reset.

## 9. Life of a turn (end to end)

1. User types in `PromptBox`, hits Enter → `Shell.sendPrompt(text)`.
2. Shell sends `{type:"prompt", text}` over the socket and echoes
   `{type:"user_prompt"}` locally → command strip appears instantly,
   status shows `✳ thinking…`.
3. `server/index.ts` parses the message, calls `session.pushPrompt(text)`.
4. `Session`'s queue feeds the text into the async prompt generator; the
   warm SDK `query()` picks it up as the next user message.
5. The agent thinks/uses tools. Each tool call passes through `canUseTool`
   (workspace gating). The SDK's stream events flow through `pump()`:
   thinking/tool starts → `status`, text tokens → `text_delta`.
6. Every `WireMsg` is JSON-serialized to the socket; `SocketClient`
   dispatches to the bus; `RenderZone` interprets: statuses update the
   activity line, deltas accumulate into the streaming assistant turn,
   markdown re-renders as it grows.
7. The SDK emits `result` → server sends (`error` if failed, then)
   `turn_end` → RenderZone finalizes the turn, clears status. The session
   stays warm, waiting on the queue for the next prompt.

## 10. Where the code is going (orientation, not a roadmap copy)

Read PLAN.md for the real thing; the shape in one breath:

- **Shipped (2026-07-04):** Phase 0 verified live, and **all of Phase 1** —
  the `render` message + component registry (card, list, table, chart,
  links — the agent picks and parameterizes *our* components, unprompted),
  the pin dock (pinned components stay visible and *live*, updated in place
  by re-sends of the same render id), and validation/graceful fallback (a
  malformed render degrades to styled text; a crashing component is caught
  by its boundary). The M1 demo GIF is recorded and embedded above.
- **Now:** distribution — post the demo and read the M1 signal (BUSINESS.md
  §9). On the build side: Phase T (tool output in the transcript, Esc
  interrupt, browser permission prompts), which makes it daily-drivable.
- **Then:** Phase 2 (typed, server-mediated actions from components),
  Phase 3 (sandboxed-iframe artifacts), Phase 4 (session registry —
  sessions as durable, multi-viewport things — persistence, fleet view,
  and the phone relay, which is the paid tier).

Distribution intent shapes the architecture: the daemon ships as
`npx genui-shell` and always runs on the user's machine; the only hosted
piece is ever a dumb WebSocket relay. The API key never leaves the user's
machine. Keep every seam compatible with that.

## 11. Conventions and gotchas

- **TypeScript everywhere; yarn for everything.** One tsconfig covers both
  sides; the server runs uncompiled via `tsx`.
- **Wire protocol discipline:** add message types, never reshape existing
  ones. If you're changing an existing `WireMsg` shape, you're doing it
  wrong.
- **The trusted-shell boundary is inviolable:** nothing agent-controlled may
  render, wrap, or intercept the prompt box, the socket, or (later)
  permission prompts and pin affordances.
- **Secrets stay server-side.** Never serialize a credential into a
  `WireMsg`.
- **Comments only for non-obvious constraints** (e.g. the Origin guard's
  reasoning, the streaming-id detachment case) — the code says what it does.
- **`@protocol` alias:** declared in *both* `tsconfig.json` (for the
  compiler) and `vite.config.ts` (for the bundler). Add new shared types to
  `server/protocol.ts`; don't create a second shared module without also
  aliasing it.
- **Mock-first development:** if a UI feature can't be exercised without an
  API key, add the message flow to `MockSession` first.
- **`dist/` is gitignored build output** served by Express; rebuild with
  `yarn build` when the front end changes and you're testing the one-port
  path.
- **PLAN.md step hygiene:** work steps in order, don't start one until the
  previous step's "Done when" is satisfied, and check items off as you go.
