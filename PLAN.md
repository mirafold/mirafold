# genui-shell — Build Plan

A faithful browser re-skin of terminal coding agents — Claude Code, Codex,
and Gemini CLI, one adapter each (Phase P, shipped). The agent's full backend
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
  you already use** — Claude Code, Codex (OpenAI), and Gemini CLI, all three
  shipped (Phase P) — with genui-shell's generative UI layered on top. A
  Codex user gets **Codex** in the browser (its tools, its behavior, its
  config), never "Claude things";
  a Claude Code user gets Claude Code. "Provider-neutral" here means **faithful
  to each agent**, NOT one homogenized experience, and **no agent is
  privileged**. Mechanically: behind the `AgentSession` seam we run **each
  agent's own engine** and normalize its event stream into `WireMsg`;
  genui-shell's `render_*` / `emit_artifact` tools inject into each agent via
  **MCP** (Claude Code, Codex, and Gemini CLI all support MCP). No translation
  proxy in the request path. We do **not** build a generic agent loop or our
  own tools — that would be faithful to no one. The substrate is already right:
  the wire protocol, output zone, security model, and generative UI consume
  `WireMsg` only, so a new agent is one adapter, not a rewrite. Built as
  **Phase P (shipped 2026-07-06; steps archived in PLAN-ARCHIVE.md)**; the
  normative adapter contract is **docs/ADAPTERS.md**. (Local models
  come through whichever agent can point at a local endpoint — Phase L is the
  ergonomics; Step 1.4's render fallback lets weaker/local models degrade to
  styled text.)
- **Relay service architecture (locked 2026-07-07):** the R.2 relay is a
  **portable Node.js + `ws` process** — the stub's shape grown up — in a
  separate **private repo** (`genui-relay`, the open-core split). No
  proprietary programming model (Cloudflare Workers/Durable Objects
  explicitly rejected: rewrite-to-leave lock-in on the launch-critical
  path). Initial deploy: **Fly.io, single instance/region** — automatic
  TLS, container deploys, and a later multi-region path whose only
  platform-specific code is a ~20-line `fly-replay` routing shim (pair
  affinity), added ONLY if growth demands it. The same artifact runs on
  any VPS/app host, so the vendor is replaceable behind the domain we
  own. Rationale: pair affinity is the hard part of "global relay";
  every zero-ops global offering sells proprietary routing for it, and
  the stateless dumb-forwarder design already caps any future migration
  at reworking one small service while every installed daemon just
  re-dials. (Kyle's constraints, all met: no lock-in, easy scaling, no
  rewrite-on-success beyond that bounded service.)
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
Phase 4's completed steps (4.1–4.6, 4.8–4.10) joined them 2026-07-08; its
header stays below with the 4.7 → Phase R pointer. Everything below is the
remaining work.

---

## Phase 4 — Product hardening (the "others would want it" path)

Goal of the phase: persistence, multiple sessions, polish, robust resume, and
the multi-user seam. Each step is optional/independent — do as needed. Phase P
shipped first, as required (provider-neutrality was a prerequisite, not a
parallel track); everything below except the 4.7 relay is now done — and 4.7
is expanded into **Phase R** below (the 2026-07-07 launch-complete pivot:
the relay ships *before* launch, purchasable on day one, not after an M2
signal).

Steps 4.1–4.6 and 4.8–4.10 are **done** — moved to **PLAN-ARCHIVE.md**
2026-07-08 with their full dated status notes (same convention as the
earlier phases). Only 4.7 remains below, as the pointer to Phase R.

- [ ] **Step 4.7 — Hosted relay seam (the paid tier)** → **expanded into
  Phase R below** (launch-complete pivot, 2026-07-07). The original scope —
  daemon dials out via WSS with a pairing token; the relay is a dumb
  forwarder shuttling `WireMsg`/`ClientMsg` frames; to the registry a
  remote device is just another attached viewport; per-pair E2E encryption
  before charging — is unchanged; it's now sized into R.1–R.7 and sequenced
  *before* launch instead of behind the M2 signal. Check this box when
  Phase R ships.

---

## Phase R — The relay + one full launch (pivot, locked 2026-07-07)

Goal of the phase: launch **once, complete** — the demo post, repo public,
`npm publish`, and a purchasable Pro tier (the relay: your sessions from any
device) all on the same day. Strategy rationale and accepted trade-offs:
BUSINESS.md §9 (pivot note) + §8 risk 2. Target ≈ two weeks (~2026-07-21);
R.1–R.3 are the security-sensitive core — do them first, inside the Fable-5
window (~2026-07-12). Non-negotiables apply throughout, two above all:
secrets/keys never transit the relay, and the relay never becomes a proxy in
the agent's request path — it forwards opaque frames between viewports and
the registry, nothing more. L.2/L.3 stay demand-gated post-launch;
notifications are **not** part of the launch and are not sold until built.

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

- [ ] **Step R.2 — The relay service, deployed** *(needs Kyle: Fly.io
  account + a domain — start both signups now; the code half is buildable
  before either exists)*
  - Goal: the dumb forwarder, running in the world.
  - Build: per the locked relay-architecture decision (2026-07-07, above) —
    a portable Node.js + `ws` service in a new **private repo**
    (`genui-relay`, closed source per the settled MIT open-core call):
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
    weak pinned GENUI_RELAY_CODE refused at startup — min 16 chars, minted
    fallback — and relay-client caps + idle-reaps remote viewports:
    `MAX_REMOTE_VIEWPORTS`, `RELAY_VIEWPORT_IDLE_MS`.)
  - Done when: a phone on cellular (not the home wifi) drives a home mock
    session through the deployed relay, and the relay's logs show it
    learned nothing but connection metadata.

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

**The gap-close block (R.4b–R.4h), re-sequenced 2026-07-08.** Seven
pre-launch steps from the evaluation series. Step ids are
discovery-stamped and STABLE — commits, memories, and cross-references
cite them — so the letters don't move; the ORDER below is the order to
work them (priority, not discovery date). Cut line if the launch window
forces one: **R.4f, R.4b, R.4h — don't launch without** (a crash bug, the
likeliest-user honesty fix, and the compat fix that's only cheap before
relay skew exists); **R.4d, R.4g — strongly should** (a DoS lever and the
bug-report surface); **R.4c, R.4e — slip only as a last resort** (honesty
polish and security-test insurance).

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

- [ ] **Step R.4g — Supportability sweep: version, error logging, honest
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

- [ ] **Step R.4c — Resilience honesty (from the 2026-07-07 failure-mode
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

- [ ] **Step R.4e — Prove the artifact sandbox fails closed (from the
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

- [ ] **Step R.5 — Entitlement + billing** *(needs Kyle: Stripe account +
  price confirmation — BUSINESS.md §7 says $12/mo · $99/yr)*
  - Goal: paying unlocks the relay, on launch day, with almost nothing
    standing between "want" and "paid."
  - Build: Stripe Checkout → a relay entitlement token; the relay admits
    daemon pairings only with an active entitlement (the *relay* checks
    entitlement — the daemon and wire protocol stay payment-ignorant);
    graceful expiry/renewal. A minimal landing page (demo GIF, install
    command, buy button, docs links) on the R.2 domain. Also (2026-07-08
    operability review): a stranger-facing top section on README.md itself —
    install, GIF, what it is, then "engineering docs below" — because the
    npm package page renders the README, and today it opens as a 60 KB
    maintainer doc. And (2026-07-08 competitive scan): before creating the
    Stripe products, a price/packaging sanity pass against the observed
    anchors — Happy $0 (free E2E relay, native apps, 22.5k stars),
    CloudCLI Cloud €7/mo, Omnara $9/mo — the tier is sold as **the genUI
    experience from any device** (uncontested), never as bare phone access
    (zero-priced by the market); $12 stands per BUSINESS §7 + the §2 first
    target unless Kyle recuts it here, eyes open.
  - Done when: a Stripe test-mode purchase unlocks pairing end-to-end, and
    expiry re-locks it without breaking the local product in any way.

- [ ] **Step R.6 — Launch prep (the week before; everything verifiable
  without publishing)** *(split out of the old launch-day mega-step
  2026-07-08 — same items, grouped so nothing hides mid-paragraph; nothing
  here requires `npm publish`, most of it requires R.2's deploy)*
  - Goal: on launch morning, R.7 is a three-move sequence, not a scramble.
  - **Assets & copy** (2026-07-08 competitive scan):
    - Refresh the demo GIF with the phone beat (the §6 launch asset as
      originally imagined) — the phone beat must show a RENDERED COMPONENT
      on the phone (live checklist, chart, pinned widget), not a chat
      transcript on a phone, which is Happy/Omnara/CloudCLI's already-free
      table stakes.
    - Launch copy leads with "your terminal agent with a real UI —
      faithfully, whichever agent you run"; phone second.
    - Pre-write the honest comparison (vs Happy, CloudCLI, Omnara, Claude
      Code on the web / Codex cloud — they're good, here's the different
      bet) as a README/site FAQ section: the Show HN thread will ask "how
      is this different from Happy" in the first hour and the answer
      should be ours, not the thread's.
  - **Package & repo hygiene** (2026-07-07 friction log + 2026-07-08
    operability review):
    - Pin a `packageManager` field in package.json (no pin today — corepack
      users get whatever yarn resolves; the v1 lockfile implies classic).
    - Add `bugs` / `homepage` / `author` to package.json (homepage = the
      R.2 domain; `npm pack --dry-run` itself verified clean 2026-07-08 —
      9 files, 259 KB, LICENSE + README included, no strays).
    - README §8's tarball footnote: name its real prerequisites (`yarn` on
      PATH + a prior `yarn install` — `prepack` runs `yarn build`) and
      correct the tarball size (~259 KB, not ~235 KB).
    - Refresh the dated `DEFAULT_MODEL=claude-sonnet-4-6` suggestion in
      `.env.example`.
    - GitHub issue template warning against pasting boot output verbatim
      (it contains the `?token=` URL and, with the relay on, the pairing
      code — the remote-path credential).
    - Final secrets sweep of both repos.
  - **Real-hardware checks** (need R.2 deployed; none need the registry):
    - Scan the QR with a real phone through the deployed relay, drive a
      session, flip wifi→LTE mid-turn (owed by R.4 — now listed, not just
      owed).
    - macOS and Windows cold-installs from the tarball; on the Windows
      pass, run `!dir` (the R.4f fix's real-hardware check).
    - The real `!sudo -v` password entry (Kyle — verified through the
      masked prompt earlier, killed before entry; only Kyle can finish it).
    - Kyle's final eyeball of the credential-less onboarding presentation
      (R.4b builds the fix; this is the last look at how it reads).
  - Done when: every box above is checked and the only remaining
    launch-blocking action is R.7's publish sequence itself.

- [ ] **Step R.7 — Launch day (the M1+M2+M3 splash, one event)**
  - Goal: everything fires together and the signals start reading.
  - Build, same day, in order: repo public → `npm publish` over the 0.0.1
    placeholder → verify `npx genui-shell` against the real registry (the
    one check that's unverifiable until publish) → post (X + Show HN +
    r/ClaudeAI + r/LocalLLaMA with the "BYOK or fully local" line) with
    Pro purchasable from minute one.
  - Done when: a stranger can watch the GIF, install cold, run their own
    agent, pay, and drive it from their phone — all within the launch
    hour. Signals per BUSINESS.md §9 read concurrently from here.

---

## Phase F — Fidelity gap-close (from the 2026-07-07 parity evaluation)

Source: a parity evaluation of each adapter against its engine's **full** event
vocabulary — `@anthropic-ai/claude-agent-sdk@0.3.201` (38-type `SDKMessage`
union; the adapter handles 4), `@openai/codex-sdk@0.142.5` (vocabulary 100%
covered; the gaps are behavioral), `@google/gemini-cli@0.49.0` (stream-json
emitter read in the installed bundle) — then live-probed cheaply (Claude
subscription login, Codex ChatGPT login $0, one small Gemini flash call).
Every claim below marked "observed" was seen in a live run, not inferred.
F.1–F.4 are small, adapter-scoped, additive-protocol-only — sequence them
anywhere, including as pre-launch polish. F.5–F.6 are engine-surface
migrations: post-launch, demand-gated. Faithful-skin rule throughout: each
fix restores what that agent's *terminal* user already sees — nothing invented.

- [ ] **Step F.1 — Slash-command output renders (buffered assistant text)**
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

- [ ] **Step F.2 — System-notice line (the UI must not lie in degraded service)**
  - Goal: surface the service events the terminal shows and the adapter drops:
    `rate_limit_event` (**observed live on an ordinary one-word turn** — it is
    not rare), `system/api_retry` (terminal shows "retrying (attempt n)…";
    genui-shell sits on "thinking…" looking hung), `system/compact_boundary`
    (context silently compacts today), and `model_refusal_*` (turn appears to
    end for no reason).
  - Build: one additive `WireMsg` — `notice { text, kind? }` — mapped from
    those four in the claude adapter; RenderZone draws it as a dim persistent
    system line (thinking-block styling family, not agent markdown).
  - Files: `server/protocol.ts`, `server/adapters/claude-code.ts`,
    `web/src/RenderZone.tsx`, `web/src/styles.css`, tests in kind.
  - Done when: scripted-engine tests map each of the four to a `notice`; a
    forced api_retry (scripted) is visible in the transcript instead of a
    silent stall.

- [ ] **Step F.3 — Honest model label in the status bar**
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

- [ ] **Step F.4 — Gemini honesty pass (silent death on stderr-only failure)**
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

- [ ] **Step F.5 — Codex app-server migration (approvals, streaming, visible
  reasoning)** *(post-launch, demand-gated — the big one)*
  - Goal: close the three live-confirmed divergences from terminal Codex, all
    rooted in the SDK's headless `exec` surface: (1) **no approval round-trip**
    — observed: in a cwd outside the user's trusted projects, headless Codex
    runs read-only with approvals disabled and *narrates* a refusal where the
    terminal would prompt; trust is location-dependent and invisible (our
    `workspace/` sessions work only because they sit under the trusted repo
    path). (2) **No streaming** — the reply lands as one buffered
    `item.completed` lump. (3) **Reasoning can be entirely absent** — observed:
    79 reasoning tokens spent, no `reasoning` item emitted at all.
  - Build: drive Codex's **app-server** (JSON-RPC 2.0, the surface behind the
    VS Code extension — see codex.spike.md's original event table):
    `requestApproval` → `permission_request` (the browser bar + wire machinery
    already exist), `item/agentMessage/delta` → `text_delta`,
    `item/agentReasoning/delta` → `thinking_delta`, live command output.
    Inherit-don't-invent still governs: surface Codex's own approval
    semantics, never re-implement policy. Contract note (2026-07-08 design
    review): this is the first step to hit the binary-permission wall —
    `resolvePermission(id, boolean)` on the seam and allow/deny-only on the
    wire can't express "approve for session" or edited input; widening both
    (additively: an optional `options` field on `permission_request`, a
    richer response variant) is part of this step's work, not a surprise.
  - Done when: a gated command in an untrusted cwd raises the permission bar
    and proceeds on allow — exactly what the terminal does — and text/
    reasoning stream token-wise.

- [ ] **Step F.6 — Gemini ACP migration (thinking + approvals)** *(post-launch,
  demand-gated — the F.5 analog)*
  - Goal: terminal Gemini visibly shows its thinking; the stream-json emitter
    forwards only `text` parts (confirmed in the bundle source AND live with a
    forced-reasoning prompt: no thought events on a thinking-capable model).
    Approvals hit the same headless wall as Codex. The P.5 spike already named
    ACP as the upgrade path.
  - Build: drive `gemini --acp` (Agent Client Protocol, the surface Zed uses):
    `agent_thought_chunk` → `thinking_delta`, `session/request_permission` →
    `permission_request`. stream-json remains the fallback surface.
  - Done when: a Gemini session shows the folding thinking block live, and a
    gated tool raises the permission bar instead of failing silently.

---

## Phase Q — Test-suite bite (from the 2026-07-08 test-quality review)

Source: a critical read of all 28 test files in all three tiers against the
code they guard, asking one question — *which load-bearing behaviors could
regress tomorrow without any test failing?* The verdict on the existing suite
was good: the relay crypto tests are genuinely adversarial (tamper, replay,
reorder, reflection, wrong-key all asserted to fail), the relay itests prove
via a tap that the operator sees only ciphertext, the bang-secret test checks
absence from streams + replay + logs, and the adapter tests pin the full
event→WireMsg grammar including error paths. Almost nothing passes vacuously.
The gaps concentrate where the browser renders the trusted-shell boundary
(the pre-launch item is **Step R.4e** above) and in a handful of server
invariants held only by convention. Every step below is **test-only** — no
product code changes — and keeps the zero-test-deps rule (node:test + tsx;
DOM behavior is proven in Tier-3 headless Chrome, never jsdom). Sequence
anywhere; each is independent.

- [ ] **Step Q.1 — Render pipeline fails soft, and update-in-place is real
  in the DOM**
  - Goal: Step 1.4's promise — "a malformed instruction must never break the
    UI" — has three fallback layers in `RenderBlock.tsx` (unknown component,
    schema-failing props, crash → error boundary) and **zero tests**; the mock
    only ever sends valid renders. Client-side update-in-place is proven only
    at the wire (`session.itest.ts` asserts five frames share one id) — no
    test asserts the DOM holds *one* checklist rather than five, so a
    regression in `RenderZone`'s `findIndex` update path passes every tier.
    The pin machinery (pin → dock, live update while pinned, pins re-binding
    across a `zone_reset` replay) — a shell-owned affordance — is untested.
  - Build: a "render something malformed" mock hook (unknown component name +
    schema-invalid props for a known one), then Tier-3 assertions: the
    fallback block paints with the raw props visible, the zone keeps working
    afterwards; the existing checklist e2e additionally asserts exactly one
    todo-list block in the DOM; a pin e2e: pin a component, drive an update
    (dock copy repaints), reload mid-session (pin survives the replay),
    unpin returns it to the transcript.
  - Files: `server/adapters/mock.ts` (malformed hook), `server/app.e2e.ts`.
  - Done when: malformed instructions visibly degrade instead of crashing in
    a real browser, the five-frame checklist paints one block not five, and a
    pinned widget stays live across an update and a reload.

- [ ] **Step Q.2 — Freeze the wire protocol in executable form**
  - Goal: the first non-negotiable — "later work ADDS message types, never
    reshapes existing ones" — is a comment, not a check. The itests assert
    some fields incidentally, but a deliberate reshape refactor would update
    those tests in the same commit and go green. Since the relay, this is
    load-bearing for real: a phone can run yesterday's bundle against today's
    daemon.
  - Build: a Tier-1 golden-fixtures test — one canonical JSON sample per
    `WireMsg` and `ClientMsg` variant, assigned to the type in both directions
    (compile-time: the fixture satisfies the type; runtime: field names and
    representative values asserted). Adding a new message type means adding a
    fixture; changing an existing shape breaks the build or the test.
    (Complement, not overlap: Step R.4h owns the other half of the compat
    story — unknown types ignored on both ends, tolerant client prop
    schemas. Fixtures pin what exists; R.4h pins how the ends treat what
    doesn't yet.)
  - Files: new `server/protocol.test.ts`.
  - Done when: renaming or retyping any existing on-wire field fails the
    suite loudly, and adding a message type touches no existing fixture.

- [ ] **Step Q.3 — Ring-buffer eviction and the resume boundary**
  - Goal: `BUFFER_CAP` (4000) eviction has zero tests, and `canResume`'s edge
    (`afterSeq >= firstBuffered - 1`) is exactly the off-by-one that regresses
    silently: if eviction broke, memory grows unbounded; if the boundary
    broke, a long session replays a corrupted tail after eviction. Nothing
    would catch either today.
  - Build: Tier-1 unit tests directly against `SessionRegistry` (constructible
    with a mock backend, no daemon): push past the cap, assert the buffer
    stays bounded and holds exactly the newest window; a late attach replays
    exactly the retained window; `canResume` flips false precisely at the
    evicted edge and a valid post-eviction tail resume replays the right
    messages.
  - Files: `server/registry.test.ts` (extend — today it covers only
    `resolveCwd`).
  - Done when: cap, eviction contents, and the resume boundary at the evicted
    edge are each pinned by an assertion that an off-by-one would fail.

- [ ] **Step Q.4 — Hostile-client sweep of `connection.ts`**
  - Goal: the malformed paths are dead code to the suite. No test sends
    non-JSON (the `"malformed client message"` reply is never observed), a
    bang id failing the `^[\w-]{1,64}$` regex, a non-string prompt text, or a
    junk `action` object. The oversized-frame test exists; the garbage-frame
    tests don't.
  - Build: one Tier-2 itest sweeping every `ClientMsg` type with wrong-typed
    fields, missing fields, and raw garbage over a real socket; after the
    sweep, assert the connection is still attached and a valid turn completes
    normally (nothing crashed, nothing wedged, no spurious broadcast reached
    a second viewport).
  - Files: new `server/hostile-client.itest.ts` (or extend
    `server/session.itest.ts`).
  - Done when: every `case` in `connection.ts`'s message switch has at least
    one malformed-input assertion, and the socket provably survives the whole
    sweep mid-session.

- [ ] **Step Q.5 — Pin the `.env` guard's edges**
  - Goal: the `SECRET_PATHS` deny in `permissions.ts` is tested only on the
    literal relative strings (`.env`, `.env.local`). Untested but currently
    working via `path.resolve`: an absolute path to the daemon's `.env`, a
    `subdir/../.env` traversal, and the cross-cwd case (session cwd ≠ daemon
    launch dir). Nothing pins that these resolve into the guard. (The symlink
    bypass is a documented accepted residual — out of scope.)
  - Build: extend the Tier-1 permissions tests with those resolutions across
    all four guarded readers (Read/NotebookRead/Grep/Glob).
  - Files: `server/permissions.test.ts`.
  - Done when: absolute, traversal, and cross-cwd routes to the daemon's env
    files are each asserted denied.

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
