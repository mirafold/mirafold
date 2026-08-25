# CLAUDE.md

Mirafold — a **faithful browser re-skin of terminal coding agents**. It
re-skins whichever terminal agent you already use — **Claude Code, Codex,
Gemini CLI, and OpenCode** all shipped — faithful to that agent,
with Mirafold's generative UI layered on top: a Codex user gets Codex, never
"Claude things". One adapter per agent in `server/adapters/`, none privileged;
the agent is picked per session in the agent picker.

Where things live: **docs/ARCHITECTURE.md** — architecture, the two
load-bearing contracts, trust boundaries, and conventions. **README.md** —
the user and contributor essentials. **PLAN.md** — work steps in order, one
per prompt; don't start a step until the previous "Done when" is satisfied;
check steps off with a dated status note. **`/next` is permission within the
phase already in progress, never permission to start a new phase — a new
phase starts only on Kyle's express request naming it (PLAN.md, "How to use
this plan"; absolute, 2026-08-25). **BUSINESS.md** — why and in what
sequence (milestone gates). **GLOSSARY.md** — the decided product vocabulary
(paintings vs. decks, the surfaces, prompt box, …); use its terms in docs,
copy, and conversation — the "(was)" column exists to recognize old terms,
not reuse them.

## Environment

- Node 22 via nvm, and `nvm alias default` is 22 — plain shells resolve
  node 22 + npm with no sourcing. Only the OS copy at `/usr/bin/node` is
  still a bare v18; don't hardcode that path.
- yarn for all package operations. `yarn dev` = server (:3000) + Vite
  (:5173 — use this one in dev). `yarn typecheck` must pass before committing.
- No `ANTHROPIC_API_KEY` in `.env` → `MockSession`. Build and verify every
  UI capability against the mock first; live verification (real key) last.

## Git workflow

- Normal work branches (`feature/*`, `fix/*`, `refactor/*`) start from
  `next` and open pull requests back into `next`.
- **One branch at a time: finish it, merge it, then branch.** A new work
  branch is cut only from a fresh `next` after the previous branch has
  merged — never stacked on an unmerged branch, never opened while another
  is still in review (absolute, 2026-08-25).
- **Every commit carries `Signed-off-by`** (the DCO check blocks merges
  without it). A local `prepare-commit-msg` hook appends it automatically —
  if a commit somehow lacks it, `git rebase --signoff` repairs the branch.
- A feature pull request stays open even after its checks pass. Complete the
  requested review and refactor work there, then ask Kyle explicitly whether
  to merge when it appears ready. Opening the pull request or getting green
  checks is not merge approval; merge only after Kyle says yes.
- `docs/RELEASING.md` is the canonical branch and release runbook.
- **No handoff files in the tree.** Session state belongs in memory and in
  PLAN.md; a `HANDOFF.md` or any per-session note is never committed, and
  `.gitignore` blocks the name. (One rode along in feature commits from
  2026-08-09 to 2026-08-25 and its stale "next step" line steered a later
  session into on-hold work.)

## Non-negotiables

- **Wire protocol** (`server/protocol.ts`): later work ADDS message types,
  never reshapes existing ones.
- **Trusted-shell boundary**: agent output never renders, wraps, or
  intercepts the prompt box, the socket, credentials, or shell-owned
  affordances (permission prompts, pin UI). No raw agent HTML outside the
  Phase 3 sandboxed iframe. The shell's VOICE is shell-owned too: a string
  taken verbatim from an engine, rendered where the user reads Mirafold as
  speaking (the dim `notice` line), must be attributed to that engine —
  `notice.source` badges it. Compose the sentence yourself and it's ours;
  pass the engine's words through and it carries `source`
  (docs/ARCHITECTURE.md, “Trust boundaries,” 2026-07-20 audit).
- **Trust is never broken, under any reasonable interpretation** — of
  anything Mirafold has claimed or reasonably suggested, not only what's
  written down explicitly. This is the general standard, not a file-specific
  one: it covers consent (no code may read, parse, back up, or write
  anything a user already owns — a file, a setting, any state predating
  Mirafold's involvement — before real permission for that specific action
  exists; "backed up first," "low severity," "fully reversible" are not
  exceptions) and it covers honesty (what Mirafold says or plainly implies
  about its own behavior must match what it does, including things never
  written down anywhere — the `notice.source` rule above is one instance of
  this, not the whole of it). The test is what a reasonable user would
  conclude, never a narrow technical reading that happens to comply with the
  letter of a claim while missing what it plainly suggested. (2026-08-06:
  originating case was the Gemini adapter writing into
  `.gemini/settings.json` — including overwriting a pre-existing file —
  before workspace trust was granted; the rule generalizes past that one
  case and past files specifically.)
- **Secrets stay server-side** — never serialize one into a `WireMsg`.
- **Faithful skin per agent** (identity + core requirement, PLAN Phase P):
  a new agent is one adapter behind the `AgentSession` seam — drive that
  agent's **own** engine, normalize its events to `WireMsg`, inject the
  render tools via **MCP**. Never build a generic homegrown agent loop,
  never a proxy in the request path, and never bake a Claude-only assumption
  into shared code (wire protocol, output zone, security, generative UI stay
  agent-neutral). Claude-specific behavior (the `claude_code` preset,
  inherited `settings.json`) is Claude Code's fidelity, scoped to that
  adapter only.
- **Provider credential policy** (R.4i 2026-07-10; re-verified 2026-07-15,
  K.3): Mirafold must not enable prohibited subscription use. Anthropic +
  Gemini prohibit third-party subscription use in writing → a Claude/Gemini
  login shows as `blocked` (API-key fix). OpenAI is uncertain (no written
  permission, visibly permissive posture) → a Codex/ChatGPT login runs
  LOCALLY as a **disclosed gray area** under the **disclosed-uncertainty
  rule**: the user sees the uncertainty stated plainly (never "OpenAI
  permits") and makes the call; the `blocked` machinery stays ready for a
  one-line flip if OpenAI enforces. NO subscription of any kind is driven
  over the paid relay — absolute bound. The canonical statement + dated
  per-row citations live in **one file**, `server/provider-policy.ts`;
  consume it, never re-encode the rule elsewhere.
- **Shared modules** cross server/web only via aliases declared in BOTH
  `tsconfig.json` and `vite.config.ts` (`@protocol`, `@registry-spec`,
  `@relay-crypto`).
- **Verification**: front-end steps are verified end-to-end in headless
  Chrome (`playwright-core` + `/usr/bin/google-chrome`), driving real
  typing/clicks; server steps over a real WebSocket. A step isn't done until
  its "Done when" has actually been observed. The suite (README.md,
  “Development,” and CONTRIBUTING.md):
  `yarn test` (Tier-1 unit, every commit) · `yarn test:server` (Tier-2, real
  daemon + real sockets, mock-forced) · `yarn test:e2e` (Tier-3 headless
  Chrome, rebuilds dist first). node:test + tsx, zero test deps; no test may
  ever reach a real model. New code lands with tests in the matching tier.
- **Comments** only for non-obvious constraints — the code says what it does.
