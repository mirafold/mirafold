# TESTS_PLAN.md — temporary bootstrap plan

**Purpose:** stand up a baseline automated test suite, once. This file is
scaffolding — a transient ledger for the build-out only. When the suite is fully
built (all chunks checked, `yarn test` documented in README/CLAUDE.md), **this
file is deleted**; from then on we just add tests alongside normal development,
no plan needed.

Not in PLAN.md on purpose: PLAN.md tracks permanent product milestones; reaching
a test baseline is a one-time bootstrap, not a roadmap step.

## Ground rules

- **Runner: `node:test` + `tsx`, zero new dependencies.** Node 22 has the runner
  built in; `tsx` runs the TS and resolves the `@protocol`/`@registry-spec`
  aliases. No vitest/jest/jsdom.
- **No tests against real models.** Claude/Codex/Gemini are metered,
  non-deterministic, flaky. Everything runs against pure functions or the
  `MockSession`. (Aligns with the cost-sensitive-testing rule.)
- **No React shallow-render.** Components are covered by schema validation
  (Tier 1) + the existing headless-Chrome path (Tier 3), not by mounting them.
- **One chunk = one commit** (mirrors the PLAN.md commit cadence). Check the box
  and add a dated status note here as each lands.
- Tests live next to source as `*.test.ts`. Scripts:
  - `test` → Tier 1 (pure/unit), fast, every commit
  - `test:server` → Tier 2 (mock integration over a real WebSocket)
  - `test:e2e` → Tier 3 (headless Chrome), opt-in, needs google-chrome

## Chunks

### [x] L.2a — Tier 1: all pure/unit (one chunk, one commit)
Two enabling refactors baked in: extract `server/auth.ts` (`cookieToken`,
`isLoopbackOrigin`, `verifyToken`, token resolution) out of `index.ts`, and
export the adapter normalizers (`normalizeTodos`, `resultText`, `mcpText`,
`extractRenderId`, `parseRenderId`) — both clean splits anyway, both make the
logic unit-testable. Add the `test` script.

Security core (protects what we just shipped — write these first within the chunk):
- `makeCanUseTool` (permissions.ts): `.env`/`.env.local` denied for
  Read/NotebookRead/Grep/Glob; read-only allowed; WebFetch/WebSearch/Bash/Write/
  unknown ask; `mcp__ui__*` allowed; deny message propagates.
- `capOutput` (types.ts): under cap untouched; exactly at cap; over cap →
  correct `truncatedBytes`; multibyte char straddling the byte cap → U+FFFD, no
  crash.
- `runActionTool` + `inside` (actions.ts): off-allowlist rejected; bad args
  rejected; `workspace_ls` lists a real subdir; **symlink escape blocked**; `.`
  and nested paths work.
- `auth.ts`: `cookieToken` parsing (present/absent/malformed/url-encoded);
  `isLoopbackOrigin` (localhost/127.0.0.1/[::1]/missing → ok, foreign → no);
  `verifyToken` (cookie ok, query ok, wrong/missing → no, disabled → always ok).

Rest of the pure-logic net:
- `toolDetail` (types.ts): key precedence; `{}` → undefined; 160-char cap.
- `cleanPtyOutput` (pty.ts): CSI/OSC/single-char ESC stripping; CRLF/lone-CR → LF.
- `resolveCwd` (registry.ts): `~` expansion; missing dir throws; non-dir throws;
  valid dir → absolute.
- registry-spec round-trip: every `MOCK_RENDERS` payload passes its schema;
  malformed props rejected (guards the RenderBlock fallback + wire contract).
- adapter normalizers: the exported helpers above, happy + malformed input.
- client pure fns: `diffLines` (LCS — add/delete/context, empty sides),
  `niceTicks`/`fmt` (Chart), `tildify`, `tokens`/`formatBytes`.
- **Done when:** `yarn test` green across all of the above; every security-core
  case maps to a shipped invariant (HIGH-1 exfil guard, HIGH-2 auth, symlink).

### [ ] L.2b — Tier-2 mock integration (`test:server`)
Spins up the daemon on the mock, drives the real socket. (Formalizes the
throwaway smoke scripts from the security work.)
- Auth: HTTP 403 (no/wrong token) / 302+cookie / 200; WS reject vs accept via
  cookie and via `?token=`.
- DoS caps: session cap → error (not crash); oversized frame → close 1009.
- Mock-turn contract: create → full `user_prompt → thinking → tool → render →
  usage → turn_end`; each hook (checklist single-id progression, subagent
  nesting, huge-output elision, artifact, permission allow/deny).
- Registry: broadcast fan-out to two viewports; ring-buffer replay on attach;
  `canResume`/tail-resume vs full replay; stale-id → fresh session; idle timeout
  (short override); `watch_sessions` snapshot + status derivation.
- **Bang secrets invariant** (Step 4.9's core security promise): drive a `!`
  command, send `bang_input` data, assert that data never appears in any
  viewport's stream, the session ring buffer, or server logs — while the
  command's own `bang_output` does. One test locks the ephemeral path forever.
- **Done when:** `yarn test:server` green with a mock-backed daemon.

### [ ] L.2b2 — Tier 1: adapter event mapping + error-path turn grammar
Synthetic events only — no real models (per ground rules). One enabling
refactor, same move L.2a made for the normalizers: export the per-adapter
event handlers (Codex's `handleEvent`, Gemini's `consume`/`handleEvent`) so
they can be fed fake `ThreadEvent`s / JSONL lines directly.
- Full event→WireMsg mapping tables for `codex.ts` and `gemini-cli.ts` against
  synthetic events (locks the spike tables against SDK/CLI drift): text,
  reasoning→thinking, command/file/mcp tool pairs, render-tool suppression →
  `render`/`artifact`, usage fields (`cached_input_tokens` never re-added).
- **Exactly-one-`turn_end` grammar on every exit path** — the busy-state wedge
  guard: normal `result`, spawn failure (`child.on("error")`), crash/kill
  (`close` with no result event), thrown `runStreamed`, interrupt. Assert one
  and only one `turn_end`, and `error` before it on failure paths.
- `tool_result` only for announced ids (orphan results dropped) on both
  adapters; `capOutput`/`truncatedBytes` applied at the adapter seam.
- **Done when:** `yarn test` green with the new handler exports covered.

### [ ] L.2b3 — Tier 1: `SocketClient` reconnect state machine (`web/src/ws.ts`)
The one load-bearing client module with zero coverage in any tier. Testable
with `node:test` + a stubbed `globalThis.WebSocket` (a tiny class exposing
`readyState`, handler props, and instance tracking) — no jsdom, no browser.
Stub `window`/`document` listeners with no-op shims.
- **At most one live socket, ever**: overlapping reconnect triggers —
  `online`/`visibilitychange` firing while the previous socket is CLOSING
  (the half-open `ws.close()` window) — must supersede, not duplicate; a
  superseded socket's late `onclose` must not kill the new heartbeat, fire
  spurious close listeners, or schedule an extra connect. (Asserts the FIXED
  behavior — the duplicate-socket bug fix is tracked in the 2026-07-06 review
  handoff; land that fix first or these tests are the red harness for it.)
- Heartbeat hygiene: `pingTimer`/`pongTimer` cleared across reconnects and on
  `close()`; unanswered ping → `close()` → reconnect path; any inbound
  traffic (not just pong) clears the pong deadline.
- Hello ordering: on every open, hello is sent before the pending queue
  flushes; sends while closed are queued, none lost or reordered.
- Resume cursor: `lastSeq` tracks only seq-stamped messages; `pong` is
  swallowed (never reaches listeners); backoff resets on successful open and
  caps at `BACKOFF_MAX_MS`; no reconnect after deliberate `close()`.
- **Done when:** `yarn test` green with the stubbed-socket harness in
  `web/src/ws.test.ts`.

### [ ] L.2c — Tier-3 E2E (`test:e2e`, opt-in)
Formalize the headless-Chrome checks; kept out of the default run (needs Chrome,
slower).
- token→cookie→app boot; a full turn rendering in the DOM; **sandboxed-artifact
  iframe renders under the CSP** (protects the artifact security model from a CSP
  regression).
- **Done when:** `yarn test:e2e` green against `/usr/bin/google-chrome`.

### [ ] L.2d — Durable trace, then delete this file
- Document `yarn test` / `test:server` / `test:e2e` in README §8 and CLAUDE.md's
  verification note (the permanent record).
- Delete `TESTS_PLAN.md`.
- **Done when:** the suite is discoverable from README/CLAUDE.md and this
  scaffold is gone.

## Status log
- **2026-07-06 — chunks L.2b2/L.2b3 + the L.2b bang-secrets bullet added** from
  the Fable 5 max-effort review of the reconnect/permission/adapter code. The
  same review found real bugs (ws.ts duplicate-socket race is the big one) —
  fixes are a separate work item (see the review handoff), sequenced before or
  alongside L.2b3, whose harness asserts the fixed behavior.
- **2026-07-06 — L.2a done.** 52 tests green via `yarn test` (node:test + tsx,
  zero deps). Refactors landed: `server/auth.ts` extracted from index.ts (pure
  auth predicates); adapter normalizers + `MOCK_RENDERS` + client pure helpers
  (`diffLines`/`formatBytes`/`niceTicks`/`fmt`/`tokens`) exported for testing.
  Files: `{auth,permissions,actions,pty,registry,registry-spec}.test.ts`,
  `adapters/{types,normalizers}.test.ts`, `web/src/{tildify,StatusBar,
  ToolBlock,registry/Chart}.test.ts`. Typecheck picks them up (tsconfig include).
  Runtime auth wiring re-smoked after the extraction (HTTP 403/302, WS
  reject/accept). Next: L.2b (Tier-2 mock integration).
