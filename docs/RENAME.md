# Rename: genui-shell → Mirafold (working plan)

Full product rebrand decided 2026-07-11. The **product** is now **Mirafold**.
The **repos, folders, GitHub remotes, and the Fly app stay `genui-shell` /
`genui-relay`** (Kyle's explicit call). This doc is the checklist; delete it
when the rename is done and verified.

## RENAME (the product surface)

- **Env vars** `GENUI_*` → `MIRAFOLD_*` (9 vars: TOKEN, RELAY_URL, RELAY_CODE,
  AGENT, DEBUG, MCP, NO_OPEN, GEMINI_BIN, TEST_RECORD). Both repos + all tests
  + `.env.example` + active docs.
- **UI brand strings** `genui-shell` → `Mirafold` (Shell.tsx, FleetView.tsx,
  Onboarding.tsx, StatusBar.tsx, RenderZone.tsx, `web/index.html`).
- **npm package name + bin**: `genui-shell` → `mirafold` (root package.json).
- **Cookie name**: `genui_token` → `mirafold_token` (`server/auth.ts`
  COOKIE_NAME + auth tests + app.e2e cookie assertion).
- **localStorage key**: `genui-theme` → `mirafold-theme` (Shell.tsx).
- **Artifact bridge**: `window.genui` → `window.mirafold` and the postMessage
  stamp `genui:1` → `mirafold:1` (Artifact.tsx boot script + both host checks +
  Artifact.test.ts fixtures — rename setter and all checkers together).
- **MCP server name**: `render-mcp.ts` McpServer `name: "genui"` → `"mirafold"`
  (+ the `genui-itest` client name in render-mcp.itest.ts).
- **Docs (user-facing)**: README.md, docs/*.md — product references → Mirafold;
  keep repo/path/install-technical references accurate.

## KEEP (load-bearing or Kyle's call — do NOT rename)

- **`relay-crypto.ts` `VERSION = "genui-relay v1"`** — the HKDF salt /
  domain-separation constant, byte-identical across the sync boundary and baked
  into the DEPLOYED relay's key derivation. Changing it breaks every pairing and
  forces a lockstep redeploy. It's a protocol version, not a brand. **Untouched.**
- **Repo / folder / GitHub names**: `genui-shell`, `genui-relay`.
- **Fly app** `genui-relay` and `relay-service`'s package name (matches the
  private repo + deploy target).
- **Cross-repo sync scripts** (`sync-from-genui-shell.sh`) — key off the sibling
  `genui-shell/` dir.
- **Wire protocol** — never reshaped.
- **`PLAN-ARCHIVE.md`** — historical record, left as-is.
- **Test temp-dir prefixes** (`genui-cwd-`, `genui-act-`, …) — throwaway, no
  value in churning.
- Relay repo's own self-references (`genui-relay entrypoint`, the 404 body,
  `genui-relay listening…`) — that's the app's kept name.

## Phases (check off as done)

- [x] **P1 — env vars** `GENUI_*`→`MIRAFOLD_*` (shell repo). typecheck GREEN.
- [x] **P2 — Artifact bridge** window.genui + stamp → mirafold (+ mock fixtures).
- [x] **P3 — UI brand strings** → Mirafold (+ app.e2e fleet-title assert).
- [x] **P4 — package name + bin** → mirafold (bin file git-mv'd, usage text).
- [x] **P5 — cookie + localStorage + MCP name/identifier** (incl. `MIRAFOLD_MCP`
  value "genui"→"mirafold" and the gemini `mcp_mirafold_` tool-prefix fixture).
- [x] **P6 — docs** (README, docs/) product→Mirafold, command→mirafold, URLs kept.
- [x] **P7 — relay repo**: DEPLOY.md/README env var + daemon command; shared src
  UNCHANGED (`sync:check` = in sync); `genui-relay` app/repo name kept.
- [x] **P8 — verify**: typecheck + T1 142/142 + T2 72/72 + T3 20/20; relay
  `npm test` 13/13; smoke PASS vs relay.mirafold.sh; sync:check clean.
- [ ] **P9 — commit** both repos. NB: `BUSINESS.md` is a PARALLEL session's
  pricing work — do NOT stage it. Its own genui→Mirafold rebrand is DEFERRED
  until that session lands.

## Docs — DONE (product refs → Mirafold, commands → mirafold)

BUSINESS.md, PLAN.md, CLAUDE.md, relay-service/README.md, the issue template,
and both adapter spikes now name the product **Mirafold**. Deliberately KEPT as
`genui-shell`: repo/folder/path refs, GitHub URLs, PLAN.md's rename-record lines
+ the rejected `genui-shell.com` domain, this file (docs/RENAME.md, at the
repo root until H2.2), and PLAN-ARCHIVE.md (history).

## npm — DONE (2026-07-11)

- **`genui-shell` deprecated** on npm, pointing at `mirafold`.
- **`mirafold` name secured**: a minimal `mirafold@0.0.0` placeholder published
  (coming-soon bin; no product code). Kept at
  `../mirafold-npm-placeholder/` outside both repos.
- The REAL `mirafold` publish (full build over the placeholder) is still a LAUNCH
  step (R.6/R.7) — bump the version above 0.0.0 then `npm publish` from the repo.

The rename is complete. This doc can be deleted; it stays as the record of what
was kept load-bearing (esp. the `genui-relay v1` crypto salt) and why.
