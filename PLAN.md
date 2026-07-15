# Mirafold — Build Plan

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
- **Auth:** personal API keys, server-side only — and for the **closed
  providers** (Anthropic, OpenAI, Google) an API key is the only *fully*
  supported credential. Their terms restrict driving a subscription/OAuth login
  from a third-party app: Anthropic and Google prohibit it outright (local and
  relay); OpenAI permits it for free LOCAL use but not the paid relay. So
  Mirafold refuses prohibited subscription use — a Claude/Gemini login shows
  as `blocked` with the API-key fix, and NO subscription (even OpenAI's) is
  driven over the relay. API keys and local/BYO endpoints (Ollama, a proxy) are
  the live paths. The one dated source of truth is `server/provider-policy.ts`
  (R.4i, 2026-07-10). *(This corrects the earlier "the subscription can't drive
  the SDK headlessly — API key is required" claim: R.4b proved it technically
  can; the block is a LEGAL rule, not a technical limit.)*
- **Stack:** TypeScript end to end. Server: Node + Agent SDK + Express + `ws`.
  Front end: React + Vite. Package manager: **yarn**.
- **Distribution: local-first, installed like a terminal agent.** Ships as a
  global install — `npm i -g mirafold`, then `mirafold` run from **any**
  directory, on PATH exactly like `claude`/`codex`/`gemini` (`npx mirafold`
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
  core requirement.** Mirafold is **not** a generic UI with a swappable
  model. It is a **faithful browser re-skin of whatever terminal coding agent
  you already use** — Claude Code, Codex (OpenAI), and Gemini CLI, all three
  shipped (Phase P) — with Mirafold's generative UI layered on top. A
  Codex user gets **Codex** in the browser (its tools, its behavior, its
  config), never "Claude things";
  a Claude Code user gets Claude Code. "Provider-neutral" here means **faithful
  to each agent**, NOT one homogenized experience, and **no agent is
  privileged**. Mechanically: behind the `AgentSession` seam we run **each
  agent's own engine** and normalize its event stream into `WireMsg`;
  Mirafold's `render_*` / `emit_artifact` tools inject into each agent via
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

Mirafold is a **terminal successor, not a chat app** — the design signals
terminal lineage on the input side and web richness on the output side.

**Visibility superset (locked 2026-07-05):** Mirafold is a different skin
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
header stays below with the 4.7 → Phase R pointer. **2026-07-10:** the
fully-complete steps of Phases R, F, and L (R.1, R.3, R.4b–R.4k, F.1, F.3, F.4,
L.1) were archived the same way to lean this file out — each keeps a one-line
`[x]` pointer inline; the full Goal/Build/Files/Status is in PLAN-ARCHIVE.md
("Phase R / F / L — completed steps"). Only OPEN steps carry their full body
here. Everything below marked `[ ]` is the remaining work.

---

## Phase G — Collapse the relay duplication (do before Phase H)

Origin: same 2026-07-14 review. The relay's shared source is vendored
byte-identically in TWO places — `genui-shell/relay-service/` and
`genui-relay/src/` — held in lockstep by a sync script; Kyle called the
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
  - Build: make `genui-relay/src/` the canonical source. In `genui-shell`,
    reduce the top-level `relay-service/` from a full vendored copy to a thin
    pointer (a short README stating the relay now lives in the `genui-relay`
    repo and how the local itest sources it) — keeping NO duplicated `src/`,
    `Dockerfile`, or `fly.toml` in `genui-shell`. Rewire the real-daemon relay
    test `server/relay-service.itest.ts` to obtain the relay under test from
    the canonical sibling `genui-relay` (the sibling-directory relationship the
    umbrella already relies on) instead of the vendored copy. Retire the now-
    unnecessary sync machinery: `genui-relay/scripts/sync-from-genui-shell.sh`
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
  - Files: `genui-shell/relay-service/` (collapsed to a pointer),
    `server/relay-service.itest.ts` (rewired), `README.md`, `DEPLOY.md`;
    `genui-relay/scripts/`, its `package.json`, README + ARCHITECTURE.md; the
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
    sibling `../../genui-relay/src/`, and the sync script + `sync`/`sync:check`
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

- [ ] **Step H.1 — Sweep the legacy `workspace/` scratch directory**
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

- [ ] **Step H.2 — Carve out `server/relay/` (the non-aliased files)**
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

- [ ] **Step H.3 — Move `relay-crypto` + repoint the `@relay-crypto` alias**
  - Goal: the aliased file joins its family, with the alias change isolated
    so any failure is unambiguous.
  - Build: `git mv` `relay-crypto.ts` + `relay-crypto.test.ts` into
    `server/relay/`; update the `@relay-crypto` path in **both**
    `tsconfig.json` and `vite.config.ts` (landmine 2) in the same commit.
  - Files: the two moved files, `tsconfig.json`, `vite.config.ts`.
  - Done when: the ritual passes in full — `yarn test:e2e`'s rebuild is the
    proof the Vite side of the alias is right, typecheck proves the tsc side.

- [ ] **Step H.4 — Carve out `server/sessions/`, part 1: the state core**
  - Goal: the session registry and the viewport/connection machinery read as
    the product's core subsystem.
  - Build: `git mv` into `server/sessions/`: `registry.ts` + its test +
    itest, `connection.ts`, `actions.ts` + test. Fix imports; sweep docs for
    the moved paths.
  - Files: the six moved files, their importers, `README.md`.
  - Done when: the ritual passes in full with exact count parity.

- [ ] **Step H.5 — Carve out `server/sessions/`, part 2: liveness + the
  session itests**
  - Goal: finish the sessions folder — the cross-cutting session integration
    tests live with the subsystem they exercise.
  - Build: `git mv` into `server/sessions/`: `ws-liveness.ts` + test + itest,
    `session.itest.ts`, `end-session.itest.ts`, `hostile-client.itest.ts`.
    Fix imports (these lean on `itest-harness.ts`, still at root until H.8 —
    relative paths change, typecheck enforces).
  - Files: the seven moved files, their importers.
  - Done when: the ritual passes in full with exact count parity.

- [ ] **Step H.6 — Carve out `server/security/`**
  - Goal: the two trust gates — who may connect (`auth`) and what a tool may
    do (`permissions`) — are findable as one subsystem.
  - Build: `git mv` into `server/security/`: `auth.ts` + test + itest,
    `permissions.ts` + test. Fix imports; update README's §5 mentions of
    `server/permissions.ts` and `server/auth.ts`.
  - Files: the five moved files, their importers, `README.md`.
  - Done when: the ritual passes in full with exact count parity.

- [ ] **Step H.7 — Carve out `server/pty/`**
  - Goal: the `!` passthrough machinery is one folder.
  - Build: `git mv` into `server/pty/`: `pty.ts` + test, `bang.itest.ts`.
    Fix imports; sweep docs.
  - Files: the three moved files, their importers.
  - Done when: the ritual passes in full with exact count parity.

- [ ] **Step H.8 — Carve out `server/testing/`**
  - Goal: cross-cutting test infrastructure stops crowding the root; what
    remains at `server/` root is exactly the spine (entry points + contracts).
  - Build: `git mv` into `server/testing/`: `itest-harness.ts` and the four
    whole-product e2e suites (`app.e2e.ts`, `launcher.e2e.ts`, `phone.e2e.ts`,
    `resilience.e2e.ts`). Fix the harness imports across every itest (all
    folders). Note for H.13: open step Q.1 cites `server/app.e2e.ts`.
  - Files: the five moved files, every itest that imports the harness.
  - Done when: the ritual passes in full with exact count parity, and
    `ls server/*.ts` shows only the documented root spine.

- [ ] **Step H.9 — `Shell.tsx`: extract the session bus**
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

- [ ] **Step H.10 — `Shell.tsx`: group the state**
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

- [ ] **Step H.11 — Comment legibility pass, server side**
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

- [ ] **Step H.12 — Comment legibility pass, web side**
  - Goal: same standard as H.11 across the browser code.
  - Build: same sweep over `web/src/` (registry included).
  - Files: `web/src/**/*.ts(x)` (comments only).
  - Done when: same as H.11, for `web/`.

- [ ] **Step H.13 — Docs re-synced to the new shape + final full sweep**
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

- [x] **Step R.1 — Relay envelope + daemon dial-out** — done 2026-07-07; the relay envelope + outbound WSS dial-out, remote viewports multiplexed as ordinary Connections, verified across all tiers against the in-repo stub. Full status → PLAN-ARCHIVE.md.

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

- [x] **Step R.3 — Per-pair E2E encryption** — done 2026-07-07; WebCrypto AES-GCM, per-connection directional keys off the pairing code, fail-closed on tamper/replay/reorder; the relay sees only ciphertext. → PLAN-ARCHIVE.md.

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
**Added 2026-07-10 (provider-ToS review — different provenance, same
pre-launch block): R.4i, R.4j. R.4i is don't-launch-without (legal
exposure to Kyle and to users, not polish); R.4j is the prose that pairs
with it. Both sequence BEFORE R.5.**

- [x] **Step R.4f — `!` must not kill the daemon** — done 2026-07-08; per-platform shell selection + wrapped spawn, so a bad shell errors only that session, never the daemon. → PLAN-ARCHIVE.md.

- [x] **Step R.4b — First-run honesty** — done 2026-07-08; live-credential detection, an honest shell-drawn demo banner with no fake cost, onboarding hints, and port-walk + 403 wording fixes. (Its subscription-login-counts-as-live half was later reversed by R.4i.) → PLAN-ARCHIVE.md.

- [x] **Step R.4d — Cap `!` passthrough output** — done 2026-07-08; `BANG_OUTPUT_CAP_BYTES` bounds bang output on the wire and in the replay ring so one runaway command can't flood viewports or evict the transcript. → PLAN-ARCHIVE.md.

- [x] **Step R.4h — Protocol compat hardening** — done 2026-07-08; the Postel split (strict schemas at the source, tolerant `clientSchemas` at the client), tested ignore-unknown on both ends, raw-string fallback for unknown agent names. → PLAN-ARCHIVE.md.

- [x] **Step R.4g — Supportability sweep** — done 2026-07-08; version everywhere (`--version`, boot line, hello, status bar, client skew log), timestamped error mirroring, `MIRAFOLD_DEBUG=1`, secret-scrub warnings, last-gasp crash handlers. → PLAN-ARCHIVE.md.

- [x] **Step R.4c — Resilience honesty** — done 2026-07-08; an explicit "that session ended — started a new one" notice replaces the silent URL swap, and busy/stop clears on a mid-turn daemon drop. → PLAN-ARCHIVE.md.

- [x] **Step R.4e — Prove the artifact sandbox fails closed** — done 2026-07-08; Tier-1 unit tests on `parseBridgeAction`/`wrap()` + a Tier-3 hostile-artifact suite, with a flip-each-defense proof (each containment property has a test that fails when the defense is removed). → PLAN-ARCHIVE.md.

- [x] **Step R.4i — Per-provider credential policy** — done 2026-07-10; `server/provider-policy.ts` is the one source of truth: Claude/Gemini subscription blocked, no subscription over the relay, tri-state onboarding (`live`/`blocked`/`none`), the relay gate in `connection.ts`. Verified all three tiers. → PLAN-ARCHIVE.md.

- [x] **Step R.4j — Reconcile docs & business to the provider policy** — done 2026-07-10 (prose-only); PLAN Auth decision, BUSINESS.md §2/§7/§8.5, both CLAUDE.md files, `.env.example`, README, and the private `genui-relay/README` all cite `provider-policy.ts`. → PLAN-ARCHIVE.md.

- [x] **Step R.4k — Onboarding honesty + local-model discoverability** — done 2026-07-10; live-row endpoint/model `detail`, a named local-model signpost under the picker, where-to-get-it credential links, and the Codex subscription "could change" disclosure. Verified Tier 1 + Tier 3. → PLAN-ARCHIVE.md.

- [ ] **Step R.4l — Pre-release polish + fidelity intake** *(opened
  2026-07-13, the day of the first real-phone pass through the deployed
  relay; Kyle's explicit instruction: document now, fix NOTHING yet)*
  - Goal: every rough edge Kyle has seen gets written down concretely,
    triaged, and scheduled — nothing carried in anyone's head. This is the
    same intake muscle R.5c formalizes for outside testers, started early
    on Kyle's own findings.
  - Known items so far (all reported 2026-07-13; each needs Kyle's
    concrete enumeration before it's actionable):
    1. **Phone viewport styling + small UX issues** — first real phone
       session (wifi, via app.mirafold.com): "don't love the styling yet
       and some other little things." Expected: the phone viewport has had
       near-zero mobile-specific design attention. Punch list owed.
    2. **Desktop styling issues too** — "from the session to the
       fleetview": the session view AND FleetView both have styling
       problems in Kyle's eyes. Details owed; enumerate screen by screen
       with him.
    3. **Permission prompts diverge from terminal behavior — FIDELITY
       BUG, not polish.** Kyle: "permissions questions seem to work
       differently than they do in the terminal, breaking our fidelity
       commitment." The faithful re-skin is the product's core promise
       (never less than the terminal), so treat this as a bug with an
       investigation shape: reproduce per agent (Claude Code / Codex /
       Gemini CLI), write down the exact terminal behavior vs. what the
       shell does (which prompts appear, their wording, approve/deny
       semantics, session-scoped vs. permanent grants, where the answer
       is stored), then close each gap or document the divergence as a
       deliberate, disclosed exception. Specifics owed from Kyle: which
       agent(s) and which prompt flows he saw diverge.
    4. **Startup/onboarding flow — redesign discussion. BIG (Kyle's
       word).** Kyle's sketch (2026-07-13, explicitly not settled — "im
       not sure"): a staged flow — pick the agent first, then how it's
       backed (subscription vs. API keys), then the model. Hard
       requirements he voiced: (a) "simple af"; (b) surface what the
       user ALREADY HAS — detected credentials make it obvious what they
       can pick right now; (c) unavailable options stay VISIBLE but
       clearly unavailable (gray out, not hide — it must read as "an
       option if you want it"); (d) each unavailable option carries
       how-to-get-it instructions inline. Raw material that already
       exists: R.4b/R.4i/R.4k built live-credential detection, the
       tri-state picker (`live`/`blocked`/`none`), per-row `detail`
       labels, and where-to-get-it links — this redesign re-stages that
       material, it doesn't start from zero. One constraint the
       discussion must start from: the "subscription or keys" step
       collides with the provider policy (`server/provider-policy.ts`) —
       Claude/Gemini subscriptions are BLOCKED by their providers' terms
       (only Codex allows subscription use, locally only, never over the
       relay), so "subscription" can't be a symmetric choice across
       agents; the flow has to present that honestly per agent. Also
       new vs. today: a model-selection step (today model comes from
       DEFAULT_MODEL/agent config, not the onboarding UI). Next action:
       a dedicated design discussion with Kyle BEFORE any build.
  - Done when: each item above is enumerated concretely with Kyle,
    triaged (fix now / R.6 pre-release blocker / post-launch), and either
    fixed or explicitly scheduled — and the permissions fidelity item has
    a written terminal-vs-shell comparison behind whatever triage it gets.

- [ ] **Step R.5 — Entitlement + billing** *(needs Kyle: Stripe account +
  price confirmation — BUSINESS.md §7 says $12/mo · $99/yr, held over
  $10/$79.99 on 2026-07-11)*
  - Goal: paying unlocks the relay, on launch day, with almost nothing
    standing between "want" and "paid."
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
    maintainer doc. And (2026-07-08 competitive scan): before creating the
    Stripe products, a price/packaging sanity pass against the observed
    anchors — Happy $0 (free E2E relay, native apps, 22.5k stars),
    CloudCLI Cloud €7/mo, Omnara $9/mo — the tier is sold as **the genUI
    experience from any device** (uncontested), never as bare phone access
    (zero-priced by the market); $12 stands per BUSINESS §7 + the §2 first
    target unless Kyle recuts it here, eyes open.
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
    **Still owed (needs Kyle):** (1) the Stripe **test secret key** (test mode,
    in a gitignored `.env`) to build the Checkout + minting half; (2) the
    **decision — where the minting backend lives** (recommended: a Cloudflare
    Pages Function on mirafold.com — $0, no new infra — which on the subscription
    webhook mints the signed token; alt: a small Fly service). (3) Then: the
    daemon side (dial-out sends the header; genui-shell app code — hold until the
    other session frees it), and the R.5 open refinements (token→account binding
    vs. sharing, revocation-before-expiry window, and — 2026-07-12 audit, B2 — a
    relay-side **max token lifetime** backstop that rejects an implausibly
    long-lived `exp` even from a buggy or compromised minter). Pricing $12/$99 ·
    7-day trial · cancel-at-period-end stands per BUSINESS §7 unless recut.
    **Launch blocker (2026-07-12 audit, B2):** flipping the relay ON for everyone
    (baking the default `MIRAFOLD_RELAY_URL`, see R.2) must land **with**
    `RELAY_ENTITLEMENT_PUBLIC_KEY` set — never before. An open relay with the gate
    off lets anyone squat the pair/connection caps and lock real daemons out, so
    "entitlement gate ON at deploy" is an explicit gate on R.7, not just an owed item.
  - Done when: a Stripe test-mode purchase unlocks pairing end-to-end, and
    expiry re-locks it without breaking the local product in any way.

- [ ] **Step R.5b — Release strategy, locked (all three repos)** *(a
  decision to make + write down, not a build; do before R.6's final week)*
  - Goal: one agreed, written release sequence so R.6/R.7 execute a plan
    instead of improvising how each piece ships.
  - Decide and record: (a) **shape of the release** — private beta / staged
    rollout vs. the single M1+M2+M3 public splash R.7 currently assumes;
    (b) **per-repo mechanics + order** — `genui-shell` (repo public + `npm
    publish` + versioning/cadence), `genui-relay` (deploy pipeline, when the
    entitlement gate flips ON, when the default `MIRAFOLD_RELAY_URL` bake
    lands — see R.2), `mirafold-site` (Stripe button flip, demo swap); (c)
    **rollback / kill-switch** for each (the relay gate and per-daemon relay
    URL are the levers); (d) how the codebase/npm/GitHub rename (R.2) is
    sequenced into all of the above.
  - Done when: a written release-sequence exists that R.6 and R.7 just
    follow, with no open "how do we actually ship this" questions.

- [ ] **Step R.5c — User-testing round before release (Kyle-led)** *(needs
  R.2 deployed + the phone experience end-to-end; gates R.7)*
  - Goal: real users other than Kyle drive real sessions — across the three
    agents, on real hardware and phones, through the deployed relay — before
    a stranger ever does at launch.
  - **Expect this to grow the roadmap.** It is near-certain that testing
    surfaces a batch of small, must-fix-before-release items; each gets
    logged and triaged into Phase R as an explicit launch blocker (its own
    R.5c-N sub-item or folded into R.6), not carried in someone's head. This
    step is the intake for that backlog as much as the testing itself.
  - Done when: the testing round is complete, every finding is written down,
    and each must-fix item is either fixed or explicitly scheduled as a
    Phase R blocker ahead of R.7.

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
    operability review) — **ALL DONE 2026-07-08:**
    - [x] Pin a `packageManager` field in package.json — `yarn@1.22.22`
      (matches the v1 lockfile; corepack now resolves a fixed yarn).
    - [x] Add `bugs` / `homepage` / `author` to package.json (author =
      "Kyle Serrecchia (github.com/kserrec)"; homepage/bugs = the GitHub
      repo for now — swap homepage to the R.2 domain once it exists).
      `npm pack --dry-run` re-verified: 9 files, ~264 KB, LICENSE + README
      in, `.github/` NOT shipped (not in the `files` whitelist).
    - [x] README §8 tarball footnote: names the real prerequisites (`yarn`
      on PATH + a prior `yarn install`, since `prepack` runs `yarn build`)
      and the corrected size (9 files, ~264 KB — the real current number,
      not the ~259 KB estimate).
    - [x] Refresh the dated `DEFAULT_MODEL` suggestion in `.env.example` —
      now unset by default (Claude Code inherits its OWN configured model,
      the faithful-skin default) with a comment showing how to pin one
      (`claude-sonnet-5` as the example); no stale id shipped.
    - [x] GitHub issue template (`.github/ISSUE_TEMPLATE/bug_report.md`)
      leading with the SCRUB-two-secrets warning (`?token=` URL + relay
      pairing code) before any log paste; asks for `--version` and
      `MIRAFOLD_DEBUG=1`.
    - [x] Secrets sweep of the repo (relay-service included): `.env`
      gitignored + untracked; no secret-shaped strings in tracked files
      (only doc prose + the deliberate `OPENAI_API_KEY=local` dummy).
    - [ ] Dependency vulnerability audit right before publish (`yarn audit`
      / `npm audit` on the daemon AND `relay-service/`) — clear or pin
      anything flagged in `express`, `ws`, `react-markdown`, the agent
      SDKs, etc. (2026-07-08 security audit: the one item that can't be
      cleared offline; a known-vuln transitive dep is a real ship risk).
  - **Real-hardware checks** (need R.2 deployed; none need the registry):
    - Scan the QR with a real phone through the deployed relay, drive a
      session, flip wifi→LTE mid-turn (owed by R.4 — now listed, not just
      owed).
    - Relay cap sanity under real load (from the 2026-07-08 security audit,
      finding #1 follow-up): the per-IP / global / pair caps ship as reasoned
      defaults (`RELAY_MAX_CONNECTIONS_PER_IP=64`, 2000/1000); once the relay
      is on real hardware behind Fly, confirm the numbers against actual
      resource use and a NAT'd-office case (many legit users, one IP) before
      relying on them — tune via env, no redeploy. Confirm `fly-client-ip`
      reaches the process (the per-IP cap keys on it, not Fly's proxy IP).
    - Pre-handshake flood hardening (2026-07-12 audit, B3): every relay cap
      (global / per-IP / pair) is checked *after* the WebSocket handshake, so raw
      TCP / half-open HTTP connections that never upgrade are bounded only by
      Node's defaults and Fly's edge — fine on Fly, but the DEPLOY.md self-host/
      VPS path has no such floor. Set `server.headersTimeout` / `requestTimeout` /
      `maxConnections` explicitly in `relay.ts` (cheap, local) and fold a
      slowloris-style connection flood into this step's load-test, not just the
      frame/connection caps.
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
    placeholder → verify `npx mirafold` against the real registry (the
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

- [x] **Step F.1 — Slash-command output renders** — done 2026-07-08; buffered assistant text (e.g. `/context`) paints exactly once without double-rendering a streamed turn. → PLAN-ARCHIVE.md.

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

- [x] **Step F.3 — Honest model label in the status bar** — done 2026-07-08; the adapters read the engine-resolved model (`system/init`, gemini `result.stats.models`) into `usage.model` instead of "default"/"auto". → PLAN-ARCHIVE.md.

- [x] **Step F.4 — Gemini honesty pass** — done 2026-07-08; a stderr-only non-zero exit surfaces as an `error` WireMsg instead of a silent turn. → PLAN-ARCHIVE.md.

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

## Phase L — Local models: zero-friction (ergonomics on top of Phase P)

Goal of the phase: someone running a local LLM uses their agent in Mirafold
as easily as a cloud user — inference never leaving the machine. **Local isn't
a Mirafold feature; it's a property of the agent.** A terminal agent that
can point at a local endpoint (e.g. Codex against a local OpenAI-compatible
server — Ollama / vLLM / LM Studio) already runs locally; Mirafold just
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

- [x] **Step L.1 — Documented local path** — done 2026-07-07; `docs/local-models.md` (Claude Code→Ollama, Codex→local providers), facts verified vs vendor docs and live on CPU. → PLAN-ARCHIVE.md.

- [ ] **Step L.2 — `--local` easy mode (post-M2, demand-gated)**
  - Goal: one command instead of a couple minutes — build only if setup
    friction shows up in the tracker.
  - Build: `npx mirafold --local` detects a running Ollama/LM Studio, lists
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
  - Note (2026-07-10): the fleet view already distinguishes sessions by model
    (the model column, done this session). A user-testing pass surfaced the
    matching onboarding need — lead with the model/backend *source* (make
    local/open-source models first-class; let Codex pick subscription vs API
    key) — which folds into L.2/L.3, since it needs exactly this per-session
    provider/model choice.

---

## Stretch goals (unscheduled — polish, no milestone gates on these)

Pick one up only when the phases above are quiet.

**Chart-vocabulary investigation (2026-07-10).** A session prompt asked for a
pie chart; the registry `chart` only knows `line | bar`, so the agent fell
back to a sandboxed artifact — correct behavior, but heavier (iframe), outside
the theme tokens, and outside the registry's palette/interaction rules. Survey
of the remaining gaps, ranked by how likely a coding-agent session is to hit
them:

| data shape the agent can't express | today | fill |
| --- | --- | --- |
| part-of-whole (language mix, pass/fail split) | artifact fallback | `kind: "pie"` → S.1 |
| composition over an axis (tokens by model per day) | grouped bars only | `stacked?: boolean` on bar → S.2 |
| long category labels (file paths, test names) | 12-char x-label truncation | `horizontal?: boolean` bars → S.2 |
| distribution (latency histogram) | agent must think to pre-bin | no new kind — teach pre-binning in the bar `.describe()` → S.2 |
| single KPI (coverage %, p95, session cost) | prose in a `card` | new `stat` registry component → S.3 |
| paired numerics / correlation (scatter) | none | defer: needs a numeric-x data shape, rare in-domain — revisit on demand |
| matrix shading (heatmap) | plain `table` | defer with scatter |

Wire-contract check (all additive, nothing reshapes): new *optional props*
(`stacked`, `horizontal`) strip silently on older clients — the R.4h tolerant
schemas' ideal degradation; a new *`kind` enum value* fails an old client's
parse into the Step 1.4 raw-props fallback — legible, and the designed path.

- [ ] **Step S.1 — `chart` kind: pie (donut)**
  - Goal: a proportions ask renders as a native, theme-tokened chart — never
    an artifact fallback.
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

- [ ] **Step S.2 — chart ergonomics: `stacked`, `horizontal`, histogram hint**
  - Goal: composition and long-label asks stop degrading (cramped grouped
    bars, truncated labels).
  - Build: optional `stacked` (bar → cumulative segments) and `horizontal`
    (bars grow rightward; y carries the category labels untruncated) props;
    extend the bar `.describe()` to tell the agent to pre-bin distributions
    into bar buckets.
  - Done when: stacked and horizontal mock turns render correctly, and an
    old-client simulation (parse through yesterday's tolerant schema) shows
    the props stripping to a plain grouped/vertical bar, not a fallback.

- [ ] **Step S.3 — `stat` registry component (KPI tile)**
  - Goal: single-number answers (coverage %, p95 ms, cost) get a glanceable
    tile instead of a sentence in a `card` — the natural pin-dock resident.
  - Build: new registry entry `stat`: `label`, `value` (string — the agent
    formats units), optional `delta` (+/- with good/bad direction), optional
    `footer`; follows the dataviz stat-tile guidance.
  - Done when: a mock turn renders the tile, it pins to the dock, and an
    update-in-place re-send (same wire id) changes the value live.

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
