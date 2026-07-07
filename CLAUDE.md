# CLAUDE.md

genui-shell — a **faithful browser re-skin of terminal coding agents**. It
re-skins whichever terminal agent you already use — **Claude Code, Codex, and
Gemini CLI** all shipped (PLAN Phase P complete) — faithful to that agent, with
genui-shell's generative UI layered on top — a Codex user gets Codex, never
"Claude things". One adapter per agent in `server/adapters/`, none privileged;
the agent is picked per session at onboarding. Orientation lives in
**README.md** (architecture, the two load-bearing contracts, conventions). What to build next lives in **PLAN.md** (work steps in order,
one per prompt; don't start a step until the previous "Done when" is
satisfied; check steps off with a dated status note). Why, and in what
sequence, lives in **BUSINESS.md** (milestone gates).

## Environment

- Node 22 via nvm, and `nvm alias default` is 22 — plain shells resolve
  node 22 + npm with no sourcing. Only the OS copy at `/usr/bin/node` is
  still a bare v18; don't hardcode that path.
- yarn for all package operations. `yarn dev` = server (:3000) + Vite
  (:5173, use this one in dev). `yarn typecheck` must pass before committing.
- No `ANTHROPIC_API_KEY` in `.env` → `MockSession`. Build and verify every
  UI capability against the mock first; live verification (real key) last.

## Non-negotiables

- **Wire protocol** (`server/protocol.ts`): later work ADDS message types,
  never reshapes existing ones.
- **Trusted-shell boundary**: agent output never renders, wraps, or
  intercepts the prompt box, the socket, credentials, or shell-owned
  affordances (permission prompts, pin UI). No raw agent HTML outside the
  Phase 3 sandboxed iframe.
- **Secrets stay server-side** — never serialize one into a `WireMsg`.
- **Faithful skin per agent** (identity + core requirement, PLAN Phase P):
  genui-shell re-skins each terminal agent faithfully — a Codex user gets Codex,
  never "Claude things" — and no agent is privileged. A new agent is one adapter
  behind the `AgentSession` seam: drive that agent's **own** engine, normalize
  its events to `WireMsg`, inject the render tools via **MCP**. Never build a
  generic homegrown agent loop, never a proxy in the request path, and never
  bake a Claude-only assumption into shared code (wire protocol, output zone,
  security, generative UI stay agent-neutral). Claude-specific behavior (the
  `claude_code` preset, inherited `settings.json`) is Claude Code's fidelity,
  scoped to that adapter only.
- **Shared modules** cross server/web only via aliases declared in BOTH
  `tsconfig.json` and `vite.config.ts` (`@protocol`, `@registry-spec`).
- **Verification**: front-end steps are verified end-to-end in headless
  Chrome (`playwright-core` + `/usr/bin/google-chrome`), driving real
  typing/clicks; server steps over a real WebSocket. A step isn't done until
  its "Done when" has actually been observed. The test suite (README §8):
  `yarn test` (Tier-1 unit, every commit) · `yarn test:server` (Tier-2, real
  daemon + real sockets, mock-forced) · `yarn test:e2e` (Tier-3 headless
  Chrome, rebuilds dist first). node:test + tsx, zero test deps; no test may
  ever reach a real model. New code lands with tests in the matching tier.
- **Comments** only for non-obvious constraints — the code says what it does.
