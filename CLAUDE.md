# CLAUDE.md

genui-shell — a generative-UI shell over the Claude Agent SDK. Orientation
lives in **README.md** (architecture, the two load-bearing contracts,
conventions). What to build next lives in **PLAN.md** (work steps in order,
one per prompt; don't start a step until the previous "Done when" is
satisfied; check steps off with a dated status note). Why, and in what
sequence, lives in **BUSINESS.md** (milestone gates).

## Environment

- Node 22 via nvm — `source ~/.nvm/nvm.sh && nvm use 22` in every shell.
  System node is a bare v18 with no npm.
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
- **Shared modules** cross server/web only via aliases declared in BOTH
  `tsconfig.json` and `vite.config.ts` (`@protocol`, `@registry-spec`).
- **Verification**: front-end steps are verified end-to-end in headless
  Chrome (`playwright-core` + `/usr/bin/google-chrome`), driving real
  typing/clicks; server steps over a real WebSocket. A step isn't done until
  its "Done when" has actually been observed.
- **Comments** only for non-obvious constraints — the code says what it does.
