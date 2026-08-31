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
  relay) — a Claude/Gemini login shows as `blocked` with the API-key fix — and
  OpenAI grants no written permission either way, so a Codex/ChatGPT login is
  allowed for free LOCAL use as a **disclosed gray area** under the
  **disclosed-uncertainty rule** (Kyle, 2026-07-15: uncertain terms +
  permissive provider posture + minimal exposure ⇒ permissive reading with
  the uncertainty stated to the user, never asserted as permission; the
  `blocked` machinery stays ready for a one-line flip if OpenAI enforces).
  NO subscription of any kind is driven over the paid relay — that bound is
  absolute. API keys and local/BYO endpoints (Ollama, a proxy) are the fully
  supported paths. The one dated source of truth — including the canonical
  statement of the disclosed-uncertainty rule — is `server/provider-policy.ts`
  (R.4i 2026-07-10; re-verified with per-row citations + rule locked
  2026-07-15, K.3). *(This corrects the earlier "the subscription can't drive
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
  rewrite-on-success beyond that bounded service.) *(2026-07-15: the
  open-core half of this decision is REVERSED — Kyle's call, the relay goes
  open (MIT) too; we sell the hosted convenience, and open relay code is a
  trust asset for the E2E story. The separate repo, Fly deploy, and paid
  entitlement gate all stand unchanged. Executed by Phase K.1; until that
  flip lands the repo remains private.)*
- **Dev without the API:** when `ANTHROPIC_API_KEY` is unset the server falls
  back to a `MockSession` — same `AgentSession` interface, same wire protocol,
  scripted replies (5 shuffled demo templates). Every UI capability is built
  and tested against the mock first; live-agent verification comes last.
- **UI verification:** every front-end step is verified in headless Chrome via
  `playwright-core` (drives real typing/clicks against the system browser).

## Design identity · security model · wire protocol (locked)

These three load-bearing references were seeded here in Phase 0 and later
maintained in the README. The duplicate plan copies were retired 2026-07-15 to
end the drift risk; the current forms now live in the architecture
documentation:

- **Design identity** → `docs/ARCHITECTURE.md`, “Standing constraints” —
  terminal successor, not a chat app:
  mono-in / rich-out, no bubbles ever, and **provider-native transcript
  fidelity + collapse-on-finalize**: show the same user-visible activity the
  selected terminal agent shows, neither raw adapter internals nor less useful
  state; noisy live activity folds to one expandable record when it settles.
- **The core security model** → `docs/ARCHITECTURE.md`, “Trust boundaries” —
  trusted shell vs. sandboxed output zone; the boundary is inviolable, and the
  API key never reaches the browser.
- **The wire protocol** → `docs/ARCHITECTURE.md`, “Wire protocol” —
  `server/protocol.ts` is the one
  shared contract, and **later phases ADD message types (or optional
  fields), never reshape existing ones** — every step below relies on that
  rule.

## How to use this plan

Each step below is sized to be completed reliably in a single prompt. Work them
in order. Each has **Goal / Build / Files / Done when**. Do not start a step
until the previous step's "Done when" is satisfied. Check items off as you go.

**`/next` is permission WITHIN a phase only — never permission to start a new
phase (Kyle, 2026-08-25, absolute).** `/next` (or `$next`) means: do the next
unfinished step of the phase that is already in progress. When the current
phase's last step is done, or no phase is in progress, `/next` STOPS and
reports — it does not open the next phase, and it does not pick a branch that
happens to exist. Starting a phase requires Kyle's EXPRESS request naming
that phase, in his own words, in the conversation; a phase in this file, a
memory note saying "next = X", or an existing `feature/*` branch is never
that request. This rule exists because Phase PN was started twice without it
being asked for (the `feature/file-panes` branch, and again on 2026-08-25).

---

## Completed phases (archived)

**The rule this file follows:** only OPEN steps carry a full body here.
A step that finishes is compressed to a one-line `[x]` pointer, and its
Goal/Build/Files/dated-status history moves **verbatim** to
**PLAN-ARCHIVE.md** — nothing is deleted, only relocated. A completed *phase*
keeps a short summary block plus any **standing rules that outlive it** (those
stay here, because they still bind future work). Everything below marked `[ ]`
is the remaining work.

**Done and archived:** Phases **0, T, 1, 2, 3, T2, P** (the spine through the
faithful per-agent skins) · **4** except 4.7 (→ Phase R) · **G, H, H2**
(relay dedup + human legibility) · **S** (theme system) · **N** (onboarding
backend picker) · **V** (visual + fidelity gaps) · **A** (accessibility) ·
**C** (CI/CD) · **E** (Explorer) · **M** (Mission control) · **E2** (Explorer at scale) ·
**E3** (Explorer visual polish) · **W** (live tree), **UX** (native prompt discovery, transcript fidelity,
durable provider recovery, and branch test-audit closure) · **CR** (Changes
review workspace) · **NF** (needs-you notifications) · **FD** (file
drag-and-drop) · the paintings polish batch · **OC** (OpenCode adapter) ·
the superseded Gemini deprecation record · **RC** (remote OpenCode create) · **SA** (subagent
view) · **RF** (pre-release findings closure) · **LD** (live document view), plus the finished steps of the
still-open Phases **K, R, F, Q, L**.

Archive passes, each a section header in PLAN-ARCHIVE.md you can navigate to:
2026-07-08 · 2026-07-10 · 2026-07-15 · "Moved 2026-07-17" · "Moved 2026-07-19"
· "Moved 2026-07-24" (Phases A/C/E/M + V.4–V.6, and the completed material
lifted out of the still-open Phase R steps) · "Moved 2026-07-27" (Phases
E2/W step bodies, the Phase E/M narrative passes, the R.4l item-5
investigation, the CI-flake breakdown, and finished stretch-goal specs) ·
"Moved 2026-08-09" (Phase UX) · "Moved 2026-08-12 (prune — completed
bodies)" (a sweep of finished bodies across Phases 4/R/A/Q, the 2026-07-27
audit section, and the stretch goals) · "Moved 2026-08-14 (post-SA prune —
completed bodies)" (the NF/FD step bodies, paintings polish, Phase OC, the
superseded Gemini deprecation record, Phase RC, and the whole Phase SA record) ·
"Moved 2026-08-14 (Phase RF — completed body)" (Gemini support restoration,
OpenCode interrupt recovery, and corrective validation) · "Moved 2026-08-19
(Phase LD — completed Step LD.1–LD.4 bodies)" (live document composition,
visual treatment, responsive closure, and final regression proof).

---

## Phase UX — Native prompt discovery, transcript fidelity, and session recovery

- [x] **Phase UX implementation, approved follow-up, correctness closure, and security closure complete (2026-08-10).**
  Provider-native pre-submit catalogs, terminal-sized settled activity, durable
  provider-conversation recovery, and scroll-preserving transcript-click prompt
  focus are implemented across Claude Code, Codex, and Gemini CLI. The eight
  follow-up correctness findings and every security-audit item—including the
  hardening-only and theoretical findings—are closed with direct regressions. Full
  specification, implementation/refactor/correctness/security record, and proof live in
  **PLAN-ARCHIVE.md** under “Moved 2026-08-09.” The complete phase and its
  UX.6–UX.9 follow-ups landed in `next` through PR #31 (`9e833849`) after DCO,
  Cloudflare Pages, Tier 1, and combined Tier 2/Tier 3 all passed.
- [x] **Steps UX.6–UX.10** — all done 2026-08-10/12 (prompt-return settle +
  behavior-preserving refactor; the eight correctness findings; the security-
  audit findings; the branch test audit — whose real-turn instability was
  closed in Step L.4; collapse-on-finalize surviving narrating engines).
  Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."

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
earlier phases). Only 4.7 remains below (the pointer to Phase R), plus dated
records of later unplanned polish batches.

- [ ] **Step 4.7 — Hosted relay seam (the paid tier)** → **expanded into
  Phase R below** (launch-complete pivot, 2026-07-07). The original scope —
  daemon dials out via WSS with a pairing token; the relay is a dumb
  forwarder shuttling `WireMsg`/`ClientMsg` frames; to the registry a
  remote device is just another attached viewport; per-pair E2E encryption
  before charging — is unchanged; it's now sized into R.1–R.7 and sequenced
  *before* launch instead of behind the M2 signal. Check this box when
  Phase R ships.

- [x] **Step 4.11 — Cockpit polish batch (unplanned, Kyle-driven)** — done 2026-07-16, all e2e-covered; status bar regrouped (home ⌂ + end far left), collapsible prompt-bar cwd, fleet cwd column → hover tooltip, dismissible new-session card. Theme pill untouched (LOCKED). → PLAN-ARCHIVE.md.

- [ ] **Step 4.12 — Interstitial on `exp://` links (deferred hardening, 2026-07-28 audit)** —
  transcript markdown renders Expo Go deep links as tappable (the
  mobile-app preview workflow; scheme allowance + dead-link fix landed
  2026-07-28, pinned in `web/src/registry/Md.test.ts`). Link text can lie
  about its target, and Expo Go runs the bundle at whatever address the
  link names — disclosed in SECURITY.md's known-trust-decisions. This step
  adds the active layer: tapping an `exp://`/`exps://` link first shows a
  small shell-owned card (the ModalCard idiom) revealing the link's TRUE
  target, and the user confirms the hand-off. Defeats masked link text at
  the cost of one tap per preview. **Trigger:** do this when phone/relay
  mobile-app sessions become a real usage path (Kyle's call, 2026-07-28 —
  deliberately not built while phone usage is just us). Sized ~half a day
  including an e2e pin (tap → card shows raw target → confirm opens,
  dismiss doesn't).

- [x] **Step 4.13 — Phone-testing bug batch (unplanned, Kyle-driven)** —
  done 2026-07-28; three phone/relay bugs fixed, e2e-pinned +
  mutation-tested (busy-turn activity line, tappable permission strip,
  `exp://` links). Standing: the uncapped permission `detail` is accepted,
  no action (Kyle 2026-07-28 — don't re-litigate absent an engine emitting
  huge payloads); relay port-tunneling explored and parked (revisit only if
  phone-first app-building becomes real usage). Full record → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

- [x] **Step 4.14 — The activity indicator, done right (Kyle-driven rework
  of 4.13's fix #1)** — done 2026-07-29; Kyle's bar: at all times while
  Mirafold works with nothing painting, something visibly alive says so.
  `ActivityLine.tsx` chrome above the prompt box + Shell-owned label +
  replay-safe open-turn counter — now the pure reducer
  `web/src/turn-busy.ts`, whose Tier-1 pin is the dependable guard (the
  e2e's queued-turn boundary assertion remains a smoke test; its
  honest-limits caveat is preserved verbatim in the archive). Full record →
  PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

- [x] **Step 4.15 — Beta-channel trust follow-ups (beta tester 002's
  evaluation)** — done 2026-07-29; SECURITY.md ships in the package, the
  tarball fingerprint is published where testers look, and WELCOME.md
  carries a "cautious first run" recipe. Full record → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

- [x] **Step 4.16 — Whole-repo bughunt batch (2026-07-29, Kyle: "do em
  all")** — 27 verified findings across six subsystems (adapters, sessions,
  server core+pty, relay, web core, web components), all fixed same day,
  each with a pinned regression (several mutation-proven). One deliberate
  non-fix stands: no client-side prompt-size cap (a feature call — a >cap
  paste costs one clean socket close; add only if that UX bites). Full
  finding ledger → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

- [ ] **Step 4.17 — Relay hello freshness (deferred hardening, 2026-08-11
  audit)** — the daemon's relay hello (`relay-crypto.ts` / `relay-client.ts`)
  carries no relay-supplied freshness (nonce/timestamp challenge), so a hostile
  or compromised relay can REPLAY a recorded hello and open up to
  MAX_REMOTE_VIEWPORTS (16) zombie viewport channels, each held ~90 s. Bounded
  and resource-only: the replayer gains no confidentiality or integrity — the
  per-connection E2E keys derive from `nonceD`, which travels sealed, so the
  replayer can't read or drive any session; it only ties up viewport slots
  against a party (the relay) that can already withhold service by refusing to
  forward. Acknowledged inline in `relay-client.ts`. The fix is a real protocol
  change — a relay→daemon challenge the hello must echo — so it is sized as a
  step, not folded into a bugfix: add a server-issued nonce to the pre-hello
  frame, bind it into the hello's AAD, and reject a hello whose challenge the
  daemon didn't just issue. **Trigger:** before the relay carries non-trivial
  third-party traffic, or any time the relay operator is less trusted than
  today (it's ours). Sized ~half a day incl. a sibling-itest pin (recorded
  hello + fresh challenge → refused).

- [x] **Step 4.18 — Test-audit pass (2026-08-11)** — all three tiers
  repeated clean; 10 stated invariants falsified by product mutation; two
  tests genuinely repaired (chart old-client, fs-explorer small-tree),
  three assertions tightened. The redundant-but-backstopped tests it chose
  to report rather than delete still await Kyle's call — the list is
  preserved in the archive. Full record → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

---

## Phase K — Legal & compliance readiness (opened 2026-07-15; gates the remaining Phase R steps)

Origin: a 2026-07-15 full legal review (provider terms re-verified against
current published docs the same day). The finding, in one line: the
architecture already sits on the defensible side of every hard line (the
provider-policy gate, E2E blindness, local-first execution) — what's missing
is almost entirely *paper*: an entity, the two user-facing legal documents,
disclosure hygiene, and a handful of one-command checks. Two decisions Kyle
locked the same day, recorded here:

- **The relay goes open (the 2026-07-07 open-core split is REVERSED).**
  Kyle's call: we sell the hosted convenience, not code secrecy — and open
  relay code is a comfort to exactly the security-conscious audience the E2E
  story courts ("verify what the relay can't see"). The paid tier and the
  entitlement gate are unchanged; only the source visibility flips. Two
  consequences: the deferred git-history-scrub question is now **moot**
  (nothing private left to leak from the shell's history), and the site's
  "open source" line can cover the whole product. Executed by K.1.
- **Billing/tax is outsourced to a merchant of record** (Paddle /
  Lemon Squeezy class) for a fee premium — convenience over margin, Kyle's
  explicit call. K.4 picks the vendor and reworks R.5's Stripe-specific half;
  the Ed25519 entitlement-token design is vendor-agnostic and stands as built.
- **The disclosed-uncertainty rule** (locked 2026-07-15, after K.3 executed):
  when a provider's terms are uncertain — neither clearly permitting nor
  prohibiting — and our exposure is minimal with a visibly permissive provider
  posture, take the PERMISSIVE reading and put the uncertainty in front of the
  user (their account, their call), under two hard conditions: the disclosure
  states uncertainty, never permission; and enforcement degrades gracefully
  (the blocked state + one-line flip stay ready). Written prohibitions are
  always honored; the paid relay always fails closed. Canonical statement
  lives in `server/provider-policy.ts`; first application: the codex
  subscription row.

**Sequencing:** these steps gate the remaining Phase R build steps (R.5
onward) and the R.7 launch — R.7 must not execute while any K step is open
except K.10's actual filing and the parking lot. Nearly everything here is a
decision, a document, or Kyle's-hands account work, so Phase K may proceed in
parallel with Phase H without disturbing H's behavior-preserving invariant;
the only code it touches is a LICENSE file, dated comment edits in
`server/provider-policy.ts`, and (K.3, conditionally) one boolean in that
same file. Steps marked *(assistant: investigate)* need thorough
re-verification against current primary sources before acting — do not act
on this plan's summary alone.

**Sequencing amendment (2026-07-16):** a load-bearing premise was reversed
after verifying Paddle's onboarding directly — **a registered entity is NOT
required to sell.** Individuals/sole traders open *live* Paddle accounts with
identity verification only (no business verification). So **K.2 (the LLC) is
deferred to a revenue trigger** — 50 paying customers or ~$500/mo recurring
revenue, whichever first — alongside K.10, and **R.7 may now launch with both
K.2 and K.10 still open**; the interim seller is Kyle as a sole proprietor
(Kyle Serrecchia d/b/a Mirafold). What still gates R.7: K.5's pages (now live)
and K.6's site pass. Detail in the K.2 / K.4 / K.5 / K.7 notes below.

- [x] **Step K.1 — Open the relay (decision executed)** — done 2026-07-15; genui-relay relicensed MIT (LICENSE + package.json), READMEs rewritten for the open state, shell/BUSINESS docs reconciled, the public-flip moment seeded into R.5b(b); repo stays private until that flip lands. → PLAN-ARCHIVE.md.

- [ ] **Step K.2 — Legal entity before the first charge** *(Kyle's hands —
  external filings; ~a week of lead time, start early)*
  - Goal: no natural person is the counterparty to paid traffic whose
    product feature is "a phone on the internet drives a shell on a
    customer's machine." Unbounded personal liability → bounded entity
    liability, for a few hundred dollars.
  - Do: single-member LLC (state filing directly, or a bundler like Stripe
    Atlas — fine even if billing lands on a merchant of record); EIN;
    business bank account; the billing/MoR account created **under the
    entity** (migrating a personal payments account later is painful). The
    entity becomes the named party in K.5's ToS, the site footer, and both
    repos' LICENSE copyright lines.
  - Done when: the entity exists and K.4/R.5's live payment configuration is
    created under it — a **hard prerequisite**: no live checkout under a
    personal account, ever.
  - **Amendment (2026-07-16 — the "hard prerequisite" is WITHDRAWN, deferral
    decided).** Verified against Paddle's own docs that a registered entity is
    NOT required to go live — individuals/sole traders create live accounts
    with identity verification only. That was the sole hard reason to form the
    entity before launch, so it's gone. K.2 is now **deferred to a revenue
    trigger: 50 paying customers or ~$500/mo recurring revenue, whichever
    first** (Kyle's call — California's flat $800/yr LLC franchise tax isn't
    worth spending before the idea earns). **Interim posture:** sell as a sole
    proprietor; Kyle Serrecchia d/b/a Mirafold is the named party in K.5's ToS
    and the site, with K.5's ToS liability cap + consequential-damages
    exclusion applying in the interim. **When the
    trigger fires:** form the CA single-member LLC (~$70 + $800/yr franchise
    tax), EIN (free), business bank account, **convert the Paddle account from
    individual to business** (supported flow via `sellers@paddle.com` — a
    re-verification cycle, not a rebuild), swap the entity name into ToS / site
    footer / both LICENSE lines, and file the trademark (K.10) under the LLC.

- [x] **Step K.3 — Provider-terms re-verification** — done 2026-07-15; every row pinned to a dated primary source: the Anthropic ban verbatim, Gemini individual-account service ended 2026-06-18 (API keys continue; Antigravity succession check → R.6), and the codex row settled as allowed-locally under the standing **disclosed-uncertainty rule** (no written permission exists, posture visibly permissive; canonical statement in `server/provider-policy.ts`). All four tiers green, twice. → PLAN-ARCHIVE.md.

- [x] **Step K.4 — Merchant-of-record billing** — vendor: **PADDLE**
  (investigation 2026-07-15; every hard requirement from BUSINESS §7 + R.5
  verified native against Paddle's docs: card-required 7-day trial,
  cancel-at-period-end, $12/mo · $99/yr, signed `trialing`/`active`
  lifecycle webhooks that map verbatim onto the Ed25519 minting rule,
  hosted checkout from a static page, MoR tax; fees 5% + 50¢, accepted.
  Field comparison — Lemon Squeezy / Stripe Managed Payments / Polar /
  Creem — and the FTC-rule→ROSCA citation correction: → PLAN-ARCHIVE.md).
  Account created 2026-07-16 as individual/sole trader (the finding that
  deferred K.2). **Closed 2026-08-12 as long since satisfied:** both
  Paddle reviews PASSED 2026-07-19 (KYC verified + `mirafold.com` domain
  approved + SaaS taxable category — Kyle's dashboard read), and the
  Done-when was met live 2026-07-22 when R.5's checkout → webhook →
  entitlement-minting build ran against the account end-to-end on Kyle's
  real purchase, through the closed relay gate. Payout/bank details set
  up (confirmed 2026-07-30). Full status history → PLAN-ARCHIVE.md; the
  superseded pending-review text → PLAN-ARCHIVE.md, "Moved 2026-08-12
  (prune addendum — verified-stale items)."

- [x] **Step K.5 — ToS + Privacy Policy (from a written data inventory)** —
  done: four pages LIVE on mirafold.com 2026-07-16 (`/terms` `/privacy`
  `/refunds` `/contact` — refund + contact added because Paddle's review
  needs them), written from the real data inventory (E2E-blind relay, IPs
  in memory only and never logged, no cookies/analytics anywhere; Fly.io +
  Cloudflare named as subprocessors, **Paddle an independent controller**);
  named party Kyle Serrecchia d/b/a Mirafold, governing law California;
  ToS carries the warranty disclaimer, fees-paid cap + consequential
  exclusion, the only-systems-you-own AUP line, and the trial/cancel
  mechanics. 2026-07-17: **DMARC live** (`p=reject`, rua→security@ —
  nothing legitimately sends as @mirafold.com; revisit before any
  send-as), **Fly.io DPA executed** (Dropbox Sign via fly.io/documents),
  **Cloudflare DPA verified in force** by incorporation (self-serve
  agreement §6.1, DPA v6.4) — dated copies in Kyle's legal folder, outside
  the repos. The dated inventory doubles as the GDPR Art. 30 record.
  **Open tail rides the K.2 revenue trigger:** lawyer review +
  entity-name swap. Small chore owed: swap the contact page's phone for a
  dedicated Google Voice number once its ID check clears. Full build
  spec + amendments + status history → PLAN-ARCHIVE.md.

- [x] **Step K.6 — Claim accuracy + third-party trademark hygiene** —
  **executed 2026-07-27** (both halves; goes live on each repo's next push).
  Site half (S.7): E2E copy qualified everywhere it appears (index Pro
  bullet + both FAQ answers + their JSON-LD mirrors, llms.txt, beta.html) —
  "ciphertext plus bare connection metadata, never content or keys"; the
  non-affiliation footer line on all six standard-footer pages; ™ on the
  wordmark (masthead + footer, small/quiet, CSS in styles.css); the
  open-source line upgraded to cover the relay code itself. Verified
  headless at 1280w + 390w. README half: the same non-affiliation line in
  the stranger-facing top, and both relay E2E passages qualified with the
  metadata clause. Word-marks-only re-confirmed (no provider logos exist in
  either repo).
  *(original contract below)*
  *(executes in the site repo — site PLAN S.7; this step is the contract)*
  - Goal: everything the marketing says about security and about other
    companies' products stays literally true and safely nominative.
  - Build: E2E claims qualified to match the K.5 inventory (the relay sees
    ciphertext plus connection metadata; the R.2 "who serves the app JS"
    asterisk stays honestly worded). A non-affiliation footer on the site
    and in the README's stranger-facing top (the npm page renders it):
    "Claude Code, Codex, and Gemini CLI are trademarks of their respective
    owners; Mirafold is not affiliated with or endorsed by Anthropic,
    OpenAI, or Google." Word marks only — never provider logos, never their
    branded visual identity in our marketing (naming a product to state
    compatibility is nominative fair use; logos and implied endorsement are
    where it dies). ™ on Mirafold until K.10 registers. The K.1 decision
    upgrades the site's "Free and open source — MIT" line to cover the whole
    product — a copy opportunity, not just compliance.
  - Done when: the site pass ships (verified per the site's own
    conventions) and the README carries the same non-affiliation line.

- [x] **Step K.7 — SECURITY.md + vulnerability-disclosure contact (both repos)** — done 2026-07-16; SECURITY.md in both repos (7-day acknowledgment, no bounty, latest-release support, each pointing at its repo's real attack surface), and `security@` + `support@mirafold.com` live via Cloudflare Email Routing → verified inbox, end-to-end tested (leftover Namecheap MX removed; deliverability verified). → PLAN-ARCHIVE.md.

- [x] **Step K.8 — Dependency license scan** — done 2026-07-15; no copyleft in either production tree (shell: MIT/ISC/Apache/BSD + the proprietary Anthropic Agent SDK, stated plainly in the README's License section; relay: just `ws`, MIT — stale lockfile metadata resynced). Copyright-line swap to the entity stays owed to K.2. → PLAN-ARCHIVE.md.
  *2026-07-27 amendment (external legal review):* the scan's
  `--production` method structurally misses the browser bundle — the
  web-side libraries are devDependencies but `vite build` compiles them
  into the shipped `dist/` (react, react-markdown, mermaid + its embedded
  dompurify, …). Closed the same day: `THIRD-PARTY-NOTICES.md` (212
  packages, full license texts, ships in the npm package via `files`),
  generated by `scripts/third-party-notices.mjs` — regenerate on any
  web-side dependency change. dompurify is dual `MPL-2.0 OR Apache-2.0`;
  the notices file elects Apache-2.0, so the no-copyleft claim holds for
  the bundle too. The README's License section was updated.

- [x] **Step K.9 — Contributor policy** — done 2026-07-15; **DCO adopted** over CLA, recorded in R.5b(e); CONTRIBUTING.md in both repos; the GitHub DCO check turns on at the public flip (R.5b/R.7 mechanics). → PLAN-ARCHIVE.md.

- [ ] **Step K.10 — Mirafold trademark filing** *(Kyle's hands; NOT
  launch-gating; assistant: investigate first)*
  - Goal: a priority date on the coined mark before launch attention — the
    GENUI® lesson, applied forward. The 2026-07-11 knockout search was
    clean; an intent-to-use application locks priority **before** launch.
  - Investigate first (assistant): confirm classes (expect 9 + 42), filing
    basis (intent-to-use pre-launch vs. use-in-commerce at launch), specimen
    expectations, and current TEAS fees (~$250–350/class as of the review) —
    deliver Kyle a filing brief he can follow without a lawyer.
  - Do (Kyle): file via TEAS under the K.2 entity. ™ in use until
    registration; ® only after.
  - Done when: the brief is delivered (assistant half) and the application
    is filed (Kyle's half — before or shortly after launch both work).
  - Status (2026-07-15): 🟡 **assistant half DONE — filing brief delivered**
    (written into Step 6 of the Phase-K brief document,
    `~/mirafold-phase-k-your-steps.html`); box open on Kyle's filing.
    Findings, verified against the USPTO's current (post-Jan-2025) fee
    structure: **base application $350/class** (the old TEAS Plus/Standard
    split is gone — one base fee for all §1 and §44 filings); classes
    confirmed **9** (downloadable software — the npm-distributed client)
    **+ 42** (software as a service — the hosted relay) = **$700 up front**;
    **avoid the $200/class free-form-description surcharge** by picking
    pre-approved entries from the Trademark ID Manual inside the filing UI;
    basis **§1(b) intent-to-use** recommended (locks priority pre-launch;
    no specimens at filing), which owes a **$150/class Statement of Use**
    (~$300) with specimens once sales are real ($125/class per 6-month
    extension if needed; windows run from the Notice of Allowance, up to
    36 months). Realistic all-in for both classes: ≈$1,000. Alternative
    recorded: file §1(a) use-based at launch instead — saves the SOU fees
    but gives up the pre-launch priority date, which defeats this step's
    purpose (the GENUI® lesson). Applicant must be the K.2 entity.

- [x] **Step K.11 — Export-control sanity note** — done 2026-07-15; platform WebCrypto only = *standard* cryptography, so the public flip itself completes EAR compliance (15 CFR §742.15(b), post-2021 rule — no BIS notice owed). → PLAN-ARCHIVE.md.
  *2026-07-27 note (external review):* BIS's live guidance page still
  describes the §742.15(b) one-time email (to crypt@bis.doc.gov +
  enc@nsa.gov, with the repo URL) as what takes publicly available
  encryption source out of the EAR; a reading of the 2021 rule says the
  email is only owed for non-standard crypto. The email costs $0 and five
  minutes — **send it at the public flip regardless** (belt and
  suspenders); added to the R.5b/R.7 flip mechanics by this note.

- [x] **Step K.12 — Compliance closure notes** — done 2026-07-15; dated closures, each with its basis: EU AI Act (neither provider nor deployer; faithful-skin rule avoids Art. 25 requalification), EAA (microenterprise exemption; checkout UI is Paddle's), ePrivacy (no cookies/telemetry anywhere on the site — verified in code and live; the daemon's own local auth cookie is strictly-necessary and consent-exempt), plus ECPA/OFAC/money-transmission one-liners. → PLAN-ARCHIVE.md.

**Phase K parking lot (post-launch, revenue-triggered — explicitly NOT R.7
gates):** cyber/E&O insurance once real revenue exists; CCPA formalities at
its thresholds (far off at launch scale); **the EU/UK formalities bundle**
(parked 2026-07-15, Kyle's call — a deliberate, written deferral): the GDPR
Art. 27 EU representative, the separate UK representative + ICO
data-protection fee (Tier 1, £40/yr), and the DSA Art. 13 legal
representative for the relay (a mere-conduit-shaped service; no
small-company exemption on paper) are owed only while actually serving
EU/UK residents, and enforcement at launch scale is a paper risk, not a
practical one. **Trigger to act: a meaningful EU/UK customer base — ≈ the
first $1k of EU-sourced revenue or ~10 EU customers. Then: appoint a
bundled EU+UK+DSA representative service under the K.2 entity (a few
hundred dollars/yr) and pay the ICO fee — an afternoon, funded by the
revenue that triggered it.** Until then: sell everywhere via Paddle (VAT
collection is theirs regardless), and this written deferral is the record
that the posture is deliberate.

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

- [x] **Step R.2 — The relay service, deployed** — completed 2026-08-09.
  DEPLOYED and verified in production: the standalone `mirafold-relay` repo
  (single source of truth since G.1), a `ws`-only pure forwarder, live at
  **`wss://relay.mirafold.sh`** — a real daemon streamed a full turn while
  the logs showed only connection metadata (the Done-when, observed). The
  cellular-phone pass closed 2026-07-30 (marginal rural LTE + the wifi→LTE
  mid-turn flip, twice); the default `MIRAFOLD_RELAY_URL` bake landed
  2026-07-30 (entitled daemons only — an unentitled daemon never dials;
  `off` opts out) with the same-day false-"paired" backoff fix; the rename
  completed 2026-08-09 — the deployed Fly app names (`genui-relay*`) and
  the `genui-relay v1` key-derivation salt stay frozen as protocol
  contracts. Full build/deploy/closure history → PLAN-ARCHIVE.md ("Step
  R.2 — status history" + "Moved 2026-08-12 (prune — completed bodies)").

- [x] **Step R.3 — Per-pair E2E encryption** — done 2026-07-07; WebCrypto AES-GCM, per-connection directional keys off the pairing code, fail-closed on tamper/replay/reorder; the relay sees only ciphertext. → PLAN-ARCHIVE.md.

- [ ] **Step R.4 — Remote viewport UX (the phone experience)**
  - Goal: connecting from a phone is one scan, and driving a session there
    is genuinely pleasant — this is the thing people pay for.
  - Status: built + verified locally 2026-07-07 — the shell-owned `⧉ pair`
    QR affordance (pairing info rides the hello to LOCAL viewports only;
    the code never crosses the relay, even encrypted), a phone-width CSS
    pass (≥40px tap targets, wrapping bars, no sideways scroll), and
    resilience via the existing 4.4 seq-resume + heartbeat. Tier-3
    `phone.e2e.ts` proves QR → pair → drive → permission-by-thumb → a
    mid-turn offline→online flip that RESUMES the stream (pre-blip DOM
    node still connected); Tier-2 pins that a sudo-style password from
    the remote viewport reaches the PTY only (the 4.9 invariant, now
    load-bearing). **2026-07-13: worked end-to-end on a real phone over
    wifi** through the deployed relay + app.mirafold.com. Full build
    detail → PLAN-ARCHIVE.md.
  - ✅ **CLOSED 2026-07-30 — the cellular pass is done** (R.2/R.6's LTE
    check). Kyle paired and ran a session on **cellular with wifi off** on
    the fixed 0.3.0 build, from the single spot in a rural house that gets
    data — a marginal link, not a strong one. Then the **wifi→LTE mid-turn
    flip, twice**: wifi dropped while a turn was streaming, and the session
    recovered on its own both times with the transcript intact. The
    machinery behind that is `web/src/ws.ts` — 25s ping / 8s pong deadline
    to catch the half-open socket, 500ms→5s reconnect backoff
    short-circuited by the browser's `online` event and tab-visible. The
    styling/UX punch list that first phone session surfaced is R.4l
    item 1, not this step.
  - Done when: a real phone pairs by QR, drives a full session (prompt,
    render components, permission answer, interrupt) comfortably, and
    survives a network flip (wifi→LTE) mid-turn without losing the
    transcript.

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

- [x] **Step R.4j — Reconcile docs & business to the provider policy** — done 2026-07-10 (prose-only); PLAN Auth decision, BUSINESS.md §2/§7/§8.5, both CLAUDE.md files, `.env.example`, README, and the private `mirafold-relay/README` all cite `provider-policy.ts`. → PLAN-ARCHIVE.md.

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
    1. **Phone viewport styling + small UX issues** — ✅ RESOLVED
       2026-07-22 over three same-day rounds on Kyle's real phone
       ("flabbergasted… looks incredible"); pinned in `phone.e2e.ts`. The
       theme pill is hidden on phone (the settings picker carries theme) —
       the Phase S pill lock is desktop-scoped, Kyle confirmed. Round
       detail → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
    2. **Desktop styling issues too** — "from the session to the
       fleetview": the session view AND FleetView both have styling
       problems in Kyle's eyes. Details owed; enumerate screen by screen
       with him.
       **Progress (2026-07-25, Kyle-directed session):** the workbench
       frame settled — the activity bar's border line runs unbroken from
       window top to window bottom, the status bar moved inside the
       workbench column (top border meets the line in a T; controls
       vertically centered in the bottom band); fleet rows dropped the
       status word (the dot alone carries state, sr-only text kept for
       screen readers) and the fleet page renders at 1.15× (phone reset);
       styles.css reorganized by surface (pure permutation, rule set
       proven identical); plus one real bug fixed — Fast Refresh re-runs
       `useMemo`, so every dev hot edit leaked an attached socket and
       inflated the fleet's viewport counts (Shell + FleetView now use
       `useState` lazy init).
       **Found, not fixed (same pass — each an equal-specificity CSS
       override killing an intended declaration; one-rule fixes):**
       (a) `.status-line`'s pulse is dead — the cross-cutting rise list
       overrides its `animation`, so the working line never pulses;
       (b) `.onb-agent`'s own transitions are dead — the theme-fade list
       overrides them (press/hover easing off-spec);
       (c) `.files-refresh`'s surface background is dead — `.files-btn`'s
       later `transparent` wins, so the floating refresh button is
       see-through over the rows it scrolls above.
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
    4. **Startup/onboarding flow redesign** — ✅ CLOSED: the design
       discussion happened and its outcome shipped as Phase N (2026-07-17),
       the four hard requirements carried into that charter verbatim.
       Original sketch + constraints → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
    5. **Pairing lands IN the session you paired from** — ✅ DONE
       2026-07-27 to the investigated shape (`&s=<id>` fragment hint,
       hash carried through the rewrite — mutation-tested). Decided: a
       refused-subscription device still lands IN the session, where the
       R.4i notice explains — never bounced to mission control. →
       PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
    6. **Phone session died after backgrounding** — ✅ FIXED 2026-07-25
       (`0c993e0`): the pairing stash is the device's, bounded by a 7-day
       expiry, so a browser-discarded backgrounded tab recovers its
       session with transcript. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
    7. **Swipe-to-open the Explorer on phone — DECIDED AGAINST 2026-07-25
       (Kyle):** iOS reserves a left-edge swipe for browser back-navigation
       and a page cannot reliably override it. Don't re-propose without a
       way around that. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
    8. **2026-07-28 whole-repo review leftovers** — (a) a daemon-initiated
       viewport drop reads as "desktop not reachable" on the phone; triaged
       nice-to-have (Kyle): ride the NEXT deliberate envelope revision,
       never a drive-by (head start: CLOSE_OVERLOADED 4004 already maps to
       a capacity message client-side). (b) `announcedTools` cross-turn
       retention — ✅ RESOLVED 2026-07-28, Kyle's call: turn-boundary
       clear, Tier-1-pinned. Full detail → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
  - Done when: each item above is enumerated concretely with Kyle,
    triaged (fix now / R.6 pre-release blocker / post-launch), and either
    fixed or explicitly scheduled — and the permissions fidelity item has
    a written terminal-vs-shell comparison behind whatever triage it gets.

- [ ] **Step R.5 — Entitlement + billing** *(vendor = Paddle per K.4; the
  build is done and live — see "Still open" at the end of this step)*
  - Goal: paying unlocks the relay, on launch day, with almost nothing
    standing between "want" and "paid."
  - **Vendor + shape (settled).** Phase K.4 replaced the original Stripe
    design with a **merchant of record — Paddle**; the Ed25519 entitlement
    token and the relay-side check were always vendor-agnostic and stood as
    built (Paddle's `trialing`/`active` map verbatim onto "admit when trialing
    OR active"). Pricing **$12/mo · $99/yr**, card-required **7-day free
    trial**, **cancel-at-period-end with no refund**, no money-back guarantee
    (deliberately rejected — the trial covers try-before-buy and a guarantee
    would re-add refund fees plus a revoke path) — all per BUSINESS §7, all
    verified native in Paddle. The original Stripe-worded build spec, the
    K.2-entity prerequisite (later withdrawn), and the pre-build "still owed"
    lists → PLAN-ARCHIVE.md ("Moved 2026-07-24").
  - **Relay `Origin` allowlist — DONE.** Code landed 2026-07-12
    (`RELAY_ALLOWED_ORIGINS`; unset = allow any, a wrong OR missing `Origin`
    refused with a clean close, `CLOSE_FORBIDDEN_ORIGIN` = 4006; daemon
    dial-ins carry no `Origin` and are never gated), and the production value
    was set 2026-07-13 (`https://app.mirafold.com`, live-probed; re-verified
    as surviving the 2026-07-19 redeploy). Closes the 2026-07-08 audit's
    finding #2 — the last "any stranger can open a socket" gap.
  - **Relay entitlement gate — DONE and ON in production.**
    `RELAY_ENTITLEMENT_PUBLIC_KEY` gates daemon dial-ins; the relay verifies
    signature + `exp` OFFLINE via `node:crypto` (no new dep, no vendor call,
    no state — it stays a dumb E2E-blind forwarder) and holds only the PUBLIC
    half, so it can never mint one. Refusal is a clean `CLOSE_UNENTITLED`
    (4007). Backstopped by `RELAY_ENTITLEMENT_MAX_TTL_SECONDS` (7d default)
    per the 2026-07-12 audit's B2.
    **The B2 launch blocker it carries is still live:** baking the default
    `MIRAFOLD_RELAY_URL` (see R.2) must land **with** the gate set, never
    before — an open relay with the gate off lets anyone squat the
    pair/connection caps and lock real daemons out.
  - **2026-07-22 — the BUILD landed across all three repos, and the whole
    path is proven live.** Kyle's two decisions: minting backend =
    **Cloudflare Pages Functions on mirafold.com** (KV state, Pages secrets)
    and token model = **permanent license key + auto-refresh** — checkout
    yields one `mf_…` key set once as `MIRAFOLD_LICENSE_KEY`, and the daemon
    exchanges it at `/api/entitlement` for **48h** Ed25519 tokens (refreshed
    at boot, every 12h, and force-refreshed once after a 4007), so
    cancellation cuts access within ≤48h — the accepted answer to the
    "revocation-before-expiry" refinement. Site: `functions/api/`
    claim/entitlement/paddle-webhook (HMAC-verified raw-body signatures,
    webhook-order-proof KV via an `occurredAt` guard) + the `/welcome`
    landing + CSP `connect-src 'self'` + a 7-test zero-dep suite incl. a
    cross-format guard that mints with WebCrypto and verifies with the
    relay's exact `node:crypto` calls. Shell: `server/relay/entitlement.ts`
    (override env wins outright; the license exchange **never throws or
    blocks the local product** — no token just means the gated relay refuses
    and relay-client prints the existing actionable line), dial-out header,
    boot mode line, a relay-stub gate knob so the send path stays CI-covered.
    Tier 1 **308** / Tier 2 **86**, incl. positive gated pairing against a
    real relay + daemon and the full license-exchange itest. Runbook executed
    the same night and **Kyle's real purchase went end-to-end** — live Paddle
    overlay on `/pay` (hosted checkouts are Paddle-gated; that pivot is
    recorded) → `/welcome` license key → daemon token exchange → paired
    through the closed gate. Per-repo build detail → PLAN-ARCHIVE.md;
    site-side detail + Kyle's runbook → `mirafold-site/PLAN.md` "R.5 billing
    backend".
    *No sandbox and no comped tokens, by decision (Kyle): Paddle is wired
    straight on the live approved account, the 7-day card-required trial
    keeps the end-to-end at $0, testers use the identical full-real flow, and
    past-day-7 charges are paid back personally. `scripts/entitlement.mjs`
    is ops/emergency tooling only.*
  - **Still open on this step:**
    1. The **Pro button → `/pay` link** swap on the site — *staged
       2026-07-30 on the site repo's `launch-flip` branch ("start free
       trial" + 7-day-trial badge, rendered and verified); merges to main
       at T-0, never before (the button must not go live ahead of the npm
       publish).*
    2. ✅ **The Paddle.js default-payment-link page — DONE 2026-07-28.** The
       dashboard setting still pointed at `/welcome` (the 07-22 setup's
       wrong target — no Paddle.js there, so Paddle's card-update /
       renewal-recovery emails dead-ended). Kyle repointed it to
       `https://mirafold.com/pay` — which was built for exactly this
       (Paddle.js auto-opens checkout on `?_ptxn=`) and was verified live
       the same day — ahead of the first real charges (his own trial
       converts ~07-29).
    3. ✅ Deploying the **phone app bundle to the site origin** — resolved:
       the static app origin is `https://app.mirafold.com` (its own
       git-integrated Pages project), live and serving the bundle since
       2026-07-13, rebuilt on every main push. *(Marked done 2026-07-30 —
       this line predated the separate-origin decision and had gone
       stale.)*
    4. The pre-public-launch hardening trio — claim window ✅ and revocation
       runbook ✅ (both 2026-07-23); the **genui-shell dependabot findings**
       ✅ **cleared 2026-07-25** (postcss bump `c660130` closed the last
       one — zero open alerts on the repo; see R.5b's sweep note).
    5. **token→account binding — deliberately deferred.** The license key IS
       the binding for now: sharing a key shares one subscription's access,
       and a lapsed-then-returning customer gets a NEW key (a re-subscribe is
       a new Paddle subscription id).
  - Done when: a REAL purchase on the live Paddle account (Kyle's own,
    riding the trial) unlocks pairing end-to-end, and expiry/cancellation
    re-locks it without breaking the local product in any way. *(Was
    "sandbox-mode purchase" — superseded by the 2026-07-22 no-sandbox
    decision above.)*

- [x] **Step R.5b — Release strategy, locked + EXECUTED (all three
  repos)** — ratified 2026-07-31 (every precondition measured, not read off
  a doc) and executed the same evening: both repos public, signed `v0.3.0`
  tag pushed → the provenance release workflow published
  **`mirafold@0.3.0`** (tarball sha256 `804bd065…`, SLSA attestation
  verified end-to-end, cold-install proven), quiet tester window Sat–Mon,
  the single announcement Tuesday 2026-08-04. The full ratified sequence,
  per-step execution record, and decision history (real-billing beta shape,
  ONE-splash, the quiet-flip amendment, CI/DCO/dependency-sweep/EAR flip
  mechanics, release provenance via npm trusted publishing) →
  PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
  - **Rollback levers, standing:** npm = re-point the `latest` dist-tag +
    `npm deprecate` (NEVER unpublish); relay = `fly deploy --image <prev>`;
    site = Pages one-click rollback (KV does not roll back with it).
  - **Tails recorded as owed at execution** (verify current state before
    acting on either): the hand-made GitHub Release for `v0.3.0` carrying
    the tarball SHA-256, and the BIS §742.15(b) email. The other execution
    tails (cross-repo relay itest, branch protection) are recorded done in
    Phase C.

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
  - **Tester-002 thread CLOSED 2026-07-30** — every concern resolved by
    standard practice, not bespoke exceptions: SECURITY.md ships in the
    package with a "Running it safely" section; the sole real blocker
    (supply-chain provenance) dissolved at the public flip. →
    PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
  - Finding #5 (2026-07-30, the live-Gemini check — LAUNCH BLOCKER, FIXED
    same day): Gemini CLI 0.53.0 stopped loading project settings in
    untrusted folders, so the adapter's auth selection was ignored. Fixed
    by the shell-owned once-per-workspace trust ask (P.6b,
    `server/sessions/workspace-trust.ts`), mutation-checked. **Standing
    caveat: Gemini is the most volatile of the three engines — re-run
    R.6's live-Gemini check after Google releases.** Full diagnosis, incl.
    the two measured negatives that each cost a round of wrong belief →
    PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
  - Finding #4 (2026-07-30, LAUNCH BLOCKER, fixed same day): `sendFile`
    with an absolute path 404'd the SPA fallback for every
    version-manager install (dot-segment policy); fixed with
    `{ root: DIST }` + a Tier-3 install-shaped pin. **The lesson that
    spawned R.6b: only exercising the packaged artifact from a realistic
    install path proves the packaged artifact.** → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
  - Finding #3 (2026-07-24, real phone — SERIOUS, fixed): a noopener new
    tab inherits neither fragment nor sessionStorage, so "new" on the
    relay path had no pairing code; `newSessionHref()` re-encodes the
    relay target (PR #6, deployed). → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
  - Finding #2 + sweep (2026-07-23): overlay cards had `max-width` but no
    `max-height` and overflowed short windows; fixed on the shared card
    idiom (onboarding's fix later refined into the fluid `--onb-squeeze`
    ramp, e2e-pinned). Settings/pair got the same two-line cap; internal
    scroll is the accepted behavior for the settings card at short heights
    (the theme picker's layout is Kyle-locked). → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
  - **Beta-tarball era mechanics + status (2026-07-23 → 07-25)** —
    invites SENT 2026-07-23 to 5–6 people (tarball + mirafold.com/beta;
    the private beta genuinely ran with real invitees — external fact,
    recovered 2026-08-19 from a stranded branch note), hand-sent tarball
    distribution, the testers-subscribe-FOR-REAL rule,
    the first finding (an untrue stand-in model label; Kyle's standing
    call: show NOTHING until the real model is known), 0.2.0 rebuilds, the
    npm-audit-noise investigation (testers never see it — npm skips audit
    on global installs; unfixable from our side and measured so), and the
    where-the-version-lives sweep (`package.json` is the single source —
    a bump touches nothing else). The channel itself is superseded by the
    public npm path (R.5b). Full history → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

  - **Do not run `npm install` in this repo** (learned 2026-07-25):
    `npm install --package-lock-only` silently rewrote `yarn.lock` —
    dropped every non-Linux platform entry (`@lydell/node-pty`, the agent
    SDK's darwin/win32 binaries) and all the integrity hashes. Restored
    from git and re-verified with `yarn install --frozen-lockfile`. Use
    yarn for every package operation, as CLAUDE.md already says; npm is
    for `npm pack` only.

- [x] **Step R.5d — Relay staging (nonprod) environment** — DONE
  2026-07-23; `genui-relay-staging` on Fly (auto-stop, idles at zero,
  ungated), deploy-workflow environment dropdown with per-environment
  app-scoped tokens, first staging deploy + full smoke passed. The relay
  is the only component needing a nonprod (real TLS, `fly-client-ip`,
  machine lifecycle); the flow: deploy a ref to staging → point a local
  shell at it → smoke + phone check → dispatch the same ref to
  production. Runbook: DEPLOY.md §6. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
- [ ] **Step R.6 — Launch prep (the week before; everything verifiable
  without publishing)** *(split out of the old launch-day mega-step
  2026-07-08 — same items, grouped so nothing hides mid-paragraph; nothing
  here requires `npm publish`, most of it requires R.2's deploy)*
  - Goal: on launch morning, R.7 is a three-move sequence, not a scramble.
  - **Availability posture (from the 2026-07-23 error-monitoring + DDoS
    review; uptime monitors on `relay.mirafold.sh/health` + `mirafold.com`
    are already live and tested on Kyle's UptimeRobot account):**
    - Verify the Cloudflare WAF rate-limiting rule on `/api/*` actually
      exists in the dashboard — it's step 4 of the billing runbook in
      `mirafold-site/PLAN.md` and the one item there never check-marked.
      `/api/entitlement` is the only public surface doing per-request work
      on attacker-suppliable input; the rule is the throttle in front of it.
    - [x] **DDoS acceptance + exit path — DOCUMENTED 2026-07-23** in
      `mirafold-relay/DEPLOY.md` §8: the accepted-risk position (stateless,
      E2E-blind relay; local sessions untouched; blast radius = remote
      uptime) plus the ready-to-execute Cloudflare-fronting shelf plan —
      DNS proxied to the Fly origin, `RELAY_CLIENT_IP_HEADER` →
      `cf-connecting-ip` (env-only, no code change), origin-bypass lockdown
      so the header can't be spoofed, optional CF rate rule. Document-only,
      as directed.
    - [x] ~~The next relay deploy must land before launch~~ **DEPLOYED
      2026-07-23** — `HEAD /health` + structured JSON event logging live and
      verified in production (typed refusal events observed; entitled daemon
      paired post-deploy). The smoke script gained `RELAY_ENTITLEMENT_TOKEN`
      support the same day (it predated the gate flip and couldn't fully
      pass against the gated relay; now it passes with a minted token and
      fails fast + actionable without one).
    - [x] **License-KV re-derivation check — ANSWERED 2026-07-23** (full
      writeup in `mirafold-site/PLAN.md` "KV durability"): license keys are
      minted random (`crypto.getRandomValues`) and stored ONLY in KV, never
      pushed to Paddle — so a lost `LICENSES` namespace is NOT re-derivable
      (status rebuilds from Paddle, but the key↔sub binding is gone, and a
      support re-mint yields a DIFFERENT key forcing every customer to update
      `.env`). Decision: a **periodic KV export** is the cheaper mitigation
      (owed pre-launch, not yet built); Paddle `custom_data` write-back is
      the noted self-healing upgrade if ever warranted.
  - [x] **npm install-scripts blocking — SOLVED at the root same day
    (2026-07-23):** recent npm blocks packages' install scripts by default,
    so upstream `node-pty`'s postinstall compile never ran and the daemon
    crashed at first boot (found in the beta cold-install check). Fixed by
    swapping to `@lydell/node-pty` (Kyle's requirement: no breakage, no
    manual workaround, ever): identical API, prebuilt binaries for six
    platform/arch combos as `optionalDependencies` — no install script to
    block, no toolchain needed on any platform. Verified: all tiers green
    (319/86/38, PTY bang tests included) + a cold tarball install under
    blocked scripts boots and spawns a real PTY with zero interventions.
    README native-module note updated; the welcome note's workaround
    section deleted.
  - [x] **Standing-secrets rotation runbook — WRITTEN 2026-07-23**
    (rotate-on-event policy, per-secret order + disruption window). The
    Pages-side three (`ENTITLEMENT_PRIVATE_KEY`, `PADDLE_API_KEY`,
    `PADDLE_WEBHOOK_SECRET`) are in `mirafold-site/PLAN.md` "Standing-secrets
    rotation runbook"; the deploy-side two (`FLY_API_TOKEN` per environment,
    and the relay's `RELAY_ENTITLEMENT_PUBLIC_KEY` half of the coupled
    entitlement-keypair cutover) are in `mirafold-relay/DEPLOY.md` §7. Key
    findings captured: the webhook-secret rotation is zero-downtime (Paddle
    allows multiple active `h1=` and `verifyWebhookSignature` already loops
    them); the entitlement-keypair cutover has no overlap window (the relay
    holds one key) so it MUST be rehearsed on the R.5d staging relay before
    production, with daemons self-healing via the 4007 refusal. Still owed
    as a BUILD (not a doc): the periodic KV export from the re-derivation
    finding above.
  - **Gemini CLI succession check (from K.3's re-verification, 2026-07-15):**
    Google stopped serving Gemini CLI requests for individual accounts on
    2026-06-18 and announced **Antigravity CLI** as the successor terminal
    agent (API-key/enterprise users continue on the legacy CLI for now).
    Verify our `gemini-cli` adapter still drives a real turn with an API key
    on current bits, and write down the Antigravity question (new adapter?
    rename? drop?) as a post-launch decision — the faithful-skin seam means
    it's one adapter either way, not a rewrite.
  - **Assets & copy** — **POSITIONING LOCKED (Kyle, 2026-07-23): NO
    competitor mentions, anywhere, ever. Act as if they don't exist —
    because they don't; no one owns this space like we do.** All copy stands
    on what Mirafold IS, never on a contrast with anyone else. This
    supersedes the earlier 2026-07-08 "competitive scan" framing below.
    - [x] **Public-beta framing (Kyle's call, 2026-07-29)** — *executed
      2026-07-30 where it could be: the README top carries the working
      phrase + the issue tracker as front door (`ac5fb39`), and the
      README's opening paragraph is now the crisp quotable definition the
      item below asks for (same commit). The site placements (hero
      install area + the post-flip `/beta` live note) are staged on the
      site repo's `launch-flip` branch, deployed at T-0. Kyle still tunes
      the exact words; launch posts carry the phrase per the drafts.*
      Original spec: the launch
      presents Mirafold as a **public beta**, stated plainly and
      consistently everywhere it speaks — ONE phrase (working draft:
      "Mirafold is in public beta — new, moving fast, and issues are
      wanted"; Kyle tunes the words) used in the README top, the site's
      hero/install area, the post-flip `/beta` live note, and every
      launch post; the GitHub issue tracker named as the front door for
      reports. The point is honesty as positioning: expectations set as
      "new, may have bugs" rather than implied maturity — the audience
      rewards the plain version over implied polish. Pairs with the 0.x
      version number (R.5b open call (i); 0.3.0 recommended). Pro stays
      purchasable — normal for a public beta and consistent with R.5b's
      real-billing beta shape.
    - Refresh the demo GIF with the phone beat (the §6 launch asset as
      originally imagined) — the phone beat must show a RENDERED COMPONENT
      on the phone (live checklist, chart, pinned widget), not a chat
      transcript on a phone.
    - Launch copy leads with "your terminal agent with a real UI —
      faithfully, whichever agent you run"; phone second.
    - **The README opening paragraph is a crisp, quotable, standalone
      definition of Mirafold** (it's what AI chatbots draw on when asked
      what the product is). Written purely as what it is — the faithful
      per-agent skin + generative UI + your-machine trust story — with zero
      comparison. NO "honest comparison" / "how is this different from X"
      FAQ — that item is REMOVED by the locked decision above. If asked "how
      is this different," the answer is what Mirafold does, stated plainly,
      not a competitor teardown.
  - **Launch-channel prep (added 2026-07-25 — Kyle: try basically everything
    feasible and worth the time; every channel below is $0 via its free
    route — paid placements exist at some of them but are advertising, not
    submission fees, and are not used):**
    - **Product Hunt** ($0): draft the listing + maker comment ahead of
      launch morning — launches run midnight-to-midnight Pacific and the
      first hours of votes decide surfacing. Fires launch day with the rest
      of the splash (added to R.7's sequence).
    - **Dev-newsletter submissions** ($0, organic forms): TLDR / TLDR AI,
      JavaScript Weekly + Node Weekly (Cooperpress — Mirafold is a Node
      tool, squarely eligible), Console.dev, Changelog News. Submit all of
      them launch week; editors also trawl HN front pages, so a good HN
      showing compounds here.
    - **Lobste.rs** ($0, but posting is invite-only): seek an invite before
      launch; if none materializes, skip — don't chase it.
    - **GitHub discovery surfaces** ($0): once the repo is public, PR a
      one-line entry to the established awesome lists (the Claude Code
      ecosystem list, local-LLM tooling lists). Trending needs no action —
      a launch-day star spike feeds it on its own.
    - **Post-launch follow-ups, not launch-day** ($0): an Indie Hackers
      launch post (the solo-builder-ships-a-real-product story), and
      podcast pitches (Changelog, Syntax and the like — weeks of lead
      time; pitch once the launch gives a story to tell).
  - **Package & repo hygiene** (2026-07-07 friction log + 2026-07-08
    operability review) — **ALL DONE 2026-07-08:**
    - [x] Pin a `packageManager` field in package.json — `yarn@1.22.22`
      (matches the v1 lockfile; corepack now resolves a fixed yarn).
    - [x] Add `bugs` / `homepage` / `author` to package.json (author =
      "Kyle Serrecchia (github.com/kserrec)"; homepage/bugs = the GitHub
      repo for now — swap homepage to the R.2 domain once it exists).
      `npm pack --dry-run` re-verified: 9 files, ~264 KB, LICENSE + README
      in, `.github/` NOT shipped (not in the `files` whitelist).
    - [x] The then-current README's tarball footnote named the real prerequisites (`yarn`
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
    - [x] **Cap the engine-supplied label length where it enters the wire**
      (2026-07-16 audit, hardening tier) — **DONE 2026-07-29**, and widened
      past the original model-label scope by that day's audit. `LABEL_CAP`
      (120) + `capWireLabels()` in `registry.broadcast()` bound
      `status.label`, `tool_use.name` AND `usage.model` at one choke point
      that covers every adapter, sitting BEFORE the replay ring, the cockpit
      derivation and every viewport — so replay and fleet snapshots inherit
      it. Why it stopped being "bloat insurance only": the 4.14 indicator
      moved the tool label into prompt-area CHROME, where growth widens the
      page instead of a scroll box — measured, a 200 KB label took the
      page's scroll width from 1,100 px to 1.6 M. The realistic source is
      not a corrupt engine but any third-party **MCP server** the user
      installed (`mcp__server__tool` names pass through verbatim). Second
      bound in CSS (`.activity-label` ellipsizes). Pinned: two Tier-1 tests
      (cap fires + ordinary labels untouched) and a Tier-3 layout test; all
      three mutation-tested.
  - **Real-hardware checks** (need R.2 deployed; none need the registry):
    - Local-model turn COMPLETION (Phase N.6 residual, 2026-07-17): the
      discovery→pick→configure path is fully verified (the picked model's
      prompt observed arriving inside Ollama), but the only model on the
      dev machine (1.7B, CPU) can't prefill an agent-sized prompt before
      the SDK request timeout. Drive one full turn through a
      picker-chosen local model on realistic hardware or with a
      realistically-sized model (docs table: qwen3-coder-class) —
      claude→ollama and codex→ollama both.
    - Scan the QR with a real phone through the deployed relay, drive a
      session, flip wifi→LTE mid-turn (owed by R.4 — now listed, not just
      owed).
    - ~~Relay cap sanity under real load~~ **✅ done 2026-07-19 (evening).**
      Per-IP cap (64) verified on the LIVE relay behind Fly — holds at exactly
      64, logs `per-IP cap reached (64) — refusing one source`, which also
      **confirms `fly-client-ip` reaches the process** (fired on the real
      client IP, not Fly's proxy IP). Global cap verified locally (holds at
      cap, reclaims on close). All read SERVER-SIDE (relay logs +
      `connections()`); a client-side harness was unreliable for the
      refuse-after-handshake pattern (relay `close(4004)`s just after the WS
      `open`, so the client briefly sees "open"). **That harness now exists and
      handles exactly that pattern — `mirafold-relay/scripts/load.mjs`, added
      2026-07-28 (`npm run load -- <staging-url>`).** It reads a refusal by
      waiting out a grace window after `open` instead of racing it, so an
      "open" that is about to be closed is counted correctly; four phases
      (connection ramp, frame-rate flood, byte-rate flood, slowloris) each
      report which cap fired at what threshold, and it exits non-zero when a
      phase hits NO cap. Validated against a deliberately tiny-capped local
      relay — reported thresholds matched the configured caps exactly, and the
      no-cap-fired path was confirmed to FAIL rather than pass. Run it on
      STAGING, never production (runbook: `mirafold-relay/DEPLOY.md` §6), after any
      cap retune or machine resize, and compare the numbers. The client can't
      tell the three capacity caps apart (all close 4004), so read the relay's
      own log line alongside it. Side effect: the live relay
      was **redeployed to current code** (had been v4/Jul-13 — all Phase-G+
      work was unshipped; now current + health-verified). Still NOT done (not
      blockers): the NAT'd-office many-users-one-IP case; a daemon-side check
      that a client cleanly surfaces the 4004 refusal (fold into R.4).
    - ~~Pre-handshake flood hardening (2026-07-12 audit, B3)~~ **✅ done
      2026-07-19 (evening).** `server.headersTimeout`/`requestTimeout`/
      `maxConnections` are set explicitly in `relay.ts` (were already wired as
      `createServer` options). Slowloris load-test PASSED against a local relay
      with dialed-down knobs: a frozen handshake is cut by `headersTimeout`, a
      *dribbling* one (writes a header byte every 400ms to defeat the headers
      timeout) is cut by `requestTimeout` at the total-request bound, while a
      real upgrade opens in ~40ms amid the flood and survives past both
      timeouts (they clear on upgrade), and the socket floor (`maxConnections`)
      bounds raw half-open sockets.
    - macOS and Windows cold-installs from the tarball; on the Windows
      pass, run `!dir` (the R.4f fix's real-hardware check).
    - The real `!sudo -v` password entry (Kyle — verified through the
      masked prompt earlier, killed before entry; only Kyle can finish it).
    - Kyle's final eyeball of the credential-less onboarding presentation
      (R.4b builds the fix; this is the last look at how it reads).
  - Done when: every box above is checked and the only remaining
    launch-blocking action is R.7's publish sequence itself.

- [x] **Step R.6b — The packaged-artifact pass (opened + done 2026-07-30,
  after the day's two blockers)** — `scripts/packaged-pass.mjs`: `npm pack`,
  `npm i -g`, then drive the INSTALLED global through onboarding, session
  creation, a hard reload of the session URL, generative-UI paint, the pin
  dock, the `!` PTY, the Explorer, and a standalone start of
  `dist-server/render-mcp.js` — nine checks, mock-forced, discovery off, no
  model reached. **9/9 on 0.3.0.**
  - Why it exists: both 2026-07-30 blockers (Finding #4's dot-path 404,
    Finding #5's Gemini folder gate) were invisible to all three tiers by
    construction — the checkout has no dot-segment, `yarn dev` serves the
    front end from Vite so the daemon's own routes never execute, and the
    cold-install check only read `--version`. Only an install shows them.
  - NOT wired into `yarn test:e2e` on purpose: it drives a global install CI
    doesn't have. It is a pre-release ritual — run it against the artifact
    about to ship, i.e. immediately before the R.7 publish.

- [x] **A turn that ends by `error` wedged the activity indicator forever —
  found and FIXED 2026-07-30** (chasing the Tier-3 flake below; the two are
  related in symptom, NOT in cause).
  - **The defect:** `server/sessions/registry.ts` treats `turn_end` OR
    `error` as terminal — that is what flips the session to idle and clears
    the burst gate. The shell's counter (`web/src/turn-busy.ts`) decremented
    only on `turn_end`. So any turn dying by error — an adapter crash, an
    engine killed mid-stream, a dropped frame — left the count permanently
    high: the indicator read "working…" for the LIFE of the session, on
    every viewport, while the daemon knew it was idle. **A reload did not
    heal it**, because replay rebuilds the same imbalance out of history.
  - **The fix:** the client mirrors the daemon's terminal set, and
    `Shell.tsx`'s error branch drops the indicator the way `turn_end` does.
    Tradeoff, stated in the code: with two turns genuinely in flight an
    error may read idle a beat early — which self-heals on the next activity
    frame, where the wedge it replaces never healed at all.
  - **Pinned:** four Tier-1 cases in `turn-busy.test.ts` (mutation-checked —
    reverting the terminal set fails three), plus a Tier-3 test driving a
    new deterministic mock scenario (`playTurnError`: `status` then `error`,
    no `turn_end`) through the live path AND a reload, in its own session.
    That converts a 1-in-4 heisenbug class into a test that always runs.

- [x] **The artifact-chain flake — ROOT-CAUSED AND FIXED 2026-07-30.** The
  Tier-3 wedge (`update-in-place artifacts survive the liveness tripwire`,
  ~1 in 4 in a full run, ~64% running `app.e2e.ts` alone) was
  `MockSession.interrupt()`: it calls `abandonTurn()`, which clears the
  ENTIRE timer table — including a queued turn's scheduled `turn_end` — then
  emits exactly one. One turn is orphaned, the shell's counter never comes
  down, and the indicator sticks on "working…" for the session's life.
  - **Proven, not inferred.** A socket probe: two overlapping turns + one
    interrupt → `{user_prompt: 2, turn_end: 1}`. The daemon's own verbose
    frame log showed the same imbalance server-side (22 prompts / 21 ends,
    zero `error`, zero `bang_end`), which ruled out transport, the replay
    ring and delta coalescing in one measurement.
  - **Two open turns is the NORMAL case:** the burst gate deliberately
    admits one mid-turn prompt (terminal parity), so the trigger is "type,
    type again, hit stop".
  - **Real adapters do not share the shape** — claude-code emits after the
    engine's abort settles, gemini-cli on child close, codex on stream end;
    each turn completes on its own path rather than through a shared timer
    table. That is why this stayed a fixture-only symptom.
  - **Fix + pin:** the mock emits one `turn_end` per open turn (floor of
    one, matching claude-code's deliberate extra after an abort), and
    `server/sessions/interrupt-turn-grammar.itest.ts` asserts the invariant
    over a real socket — every admitted `user_prompt` answered by exactly
    one `turn_end`, with an interrupt and without. Mutation-checked.
    **Verified: 0 failures in 8 runs of the file that failed ~64%.**
  - **What it cost, and the lesson:** most of a session, nearly all of it
    before the instrumentation existed. The trace
    (`web/src/turn-trace.ts` + `waitTurnIdle`'s two-sided dump) is what
    turned it from guessing into reading, and it should have been the first
    move rather than the fifth. Both halves stay in the tree for next time.

- [x] **Two timing-fragile Tier-3 assertions — resolved 2026-08-08 (N3).**
  Neither failure was a product-rendering defect. The activity test split a
  transient-element assertion across two Playwright calls, so a legitimate
  `turn_end` could remove the line between the wait and the read. Its own
  session now uses a permission request to hold the exact busy state under
  test. Mermaid's outer component never arrived at all: the shared session
  could inherit the preceding turn's one-follow-up prompt gate. Its test now
  owns a session while retaining the production lazy chunk, sandbox, CSP,
  postMessage, and parse-error paths. Focused repetition and two complete
  78-test browser runs passed unchanged; protected proof remains N3.4.

- [ ] **Step R.7 — Launch day (the M1+M2+M3 splash, one event)**
  - Goal: everything fires together and the signals start reading.
  - **Launch-week provider-terms re-check (K.3's standing item):** within
    the launch week, re-verify all three rows of `server/provider-policy.ts`
    against current provider documents and re-date the file — all three
    providers moved within H1 2026, and launching on a stale row is exactly
    the exposure K.3 exists to close. Includes re-checking the codex
    disclosed-gray-area row both ways: a written OpenAI allowance would let
    its caveat drop; signs of enforcement (the Anthropic pattern:
    server-side blocks first, docs later) mean flipping it to blocked —
    one line, the copy sits ready. *Added 2026-07-27 (external review):*
    also evaluate Anthropic's June-15-2026 credit-pool regime — paid plans
    now carry a dedicated monthly programmatic/"Agent SDK" credit pool
    (~$20–$200/mo by tier) spendable on third-party agents. Whether a
    faithful re-skin driving the official binary can legitimately ride it
    has no published answer (dated note in `server/provider-policy.ts`);
    it's a possible sanctioned subscription path — an OPPORTUNITY to
    verify with Anthropic in writing, never to assume. Until verified, the
    Claude subscription row stays blocked.
  - **Tracked-docs & history disclosure review (2026-07-15 audit):** before
    "repo public", read what actually goes public — the full git history plus
    tracked candor docs (`BUSINESS.md`, `PLAN.md`/archive: pricing strategy,
    provider-policy legal reasoning, negotiation-sensitive detail). Decide
    keep / trim / move-private for each; no secrets exist in history
    (verified 2026-07-15), this is a business-disclosure call, not a leak hunt.
  - **Theme guards: constrain token VALUES before accepting community theme
    PRs (2026-07-16 audit; partially closed by V.1, 2026-07-18):** the
    Tier-1 guards pin token names exactly but not all values — a
    contributed theme file could carry a working-but-weird value (e.g.
    `url(...)` in a color slot). *V.1's contrast floors now force every
    text tier, accent, and surface token (~18/theme) to parse as plain
    6-digit hex, so the remaining gap is only borders, the tinted
    families, and the misc tokens (overlay/selection/shadows, which
    legitimately use rgba()/shadow lists).* The shell CSP already blocks
    the fetch at runtime and a reviewer sees the diff, so this is
    belt-and-suspenders: add a guard asserting the REMAINING values parse
    as colors/alpha-colors/shadow lists, so `yarn test` rejects it
    mechanically. Matters only once the repo is public and taking PRs —
    land it with (or before) the public flip. ✅ **DONE 2026-07-30**
    (`7723010`, themes.test.ts): hex-only for every color slot (borders,
    tints, --bg-inset, --warn-bg-2 included), rgba() for
    overlay/selection, lengths-then-color layers for shadows, base.css's
    pinned set hex-only; `url()` mutations in a border slot and a shadow
    layer both verified failing loudly.
  - ~~**SECURITY.md: name the `!`-output → model path (2026-07-17
    audit)**~~ — **done early, 2026-07-23**: landed in SECURITY.md's
    "Known trust decisions" section, together with the Q.5 symlink
    residual of the `.env` guard (also now disclosed there).
  - Build, same day, in order: repo public → push the **signed release
    tag** (the R.5b release workflow publishes with provenance over the
    0.0.1 placeholder — no hand-run `npm publish`) → verify `npx mirafold`
    AND `npm audit signatures` against the real registry (the two checks
    that are unverifiable until publish) → post (X + Show HN +
    Product Hunt + r/ClaudeAI + r/LocalLLaMA with the "BYOK or fully
    local" line) with Pro purchasable from minute one. Same week, riding
    the splash: the newsletter submissions and awesome-list PRs prepped
    in R.6's launch-channel item (all $0).
  - Done when: a stranger can watch the GIF, install cold, run their own
    agent, pay, and drive it from their phone — all within the launch
    hour. Signals per BUSINESS.md §9 read concurrently from here.

---

## Phase N — Onboarding backend picker (opened + completed 2026-07-17; the R.4l item-4 redesign)

✅ COMPLETE — full bodies + dated status in PLAN-ARCHIVE.md ("Moved 2026-07-19").
Two-step onboarding: pick the agent, then how it's backed — every detected
credential (explicit choice replaces silent API-key-wins; server-validated)
plus running local model servers found by probing
(Ollama/LM Studio/vLLM/llama.cpp), dialect-filtered per agent, with a live
re-probe while the picker is open; per-session enforcement through each SDK's
own env/config. Live-verified on Kyle's machine.

- [x] **N.1 — Enumerate configured backends (server-side truth)** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.2 — Local model server discovery (the probe)** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.3 — Advertise backends on the wire (additive) + live re-probe** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.4 — The second-step picker UI** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.5 — Session creation honors the choice** — done 2026-07-17. → PLAN-ARCHIVE.md.
- [x] **N.6 — Live verification + docs reconciliation** — done 2026-07-17. → PLAN-ARCHIVE.md.

## Phase N2 — Native working-directory picker (opened + ✅ COMPLETE 2026-08-08)

✅ COMPLETE — full body + dated outcome in PLAN-ARCHIVE.md ("Moved 2026-08-08").
The startup screen keeps the launch directory as an editable default and adds
an operating-system folder dialog for local viewports. The request is bounded,
credential-scrubbed, never replayed, and refused over the relay; no dependency
was added. Protected Tier 1/2/3 checks, Cloudflare, and DCO passed on PR #22.

- [x] **N2.1–N2.6** — all done 2026-08-08 (picker service + local-only wire;
  onboarding browse control; regression proof; post-refactor executable-trust
  remediation; leaf-visible long paths; `.env`/Windows-opener closure).
  Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."

## Phase N3 — Stable Tier-3 browser gates (✅ COMPLETE 2026-08-08)

- [x] **N3.1–N3.4** — all done 2026-08-08 (busy-state, Mermaid renderer and
  follow-tail re-arm proofs made deterministic; two unchanged full Tier-3
  runs 78/78 on PR #22). Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."

## Phase V — Visual + fidelity gaps flagged by Kyle (opened 2026-07-17; ✅ COMPLETE)

Full bodies + dated status in PLAN-ARCHIVE.md ("Moved 2026-07-19").

- [x] **V.1 — Theme contrast pass (all six themes)** — done 2026-07-18; terminal-grade worst-case-surface contrast floors in the Tier-1 guard, hues preserved; seven-theme lineup settled (Mirafold house default; Standard dark + light; Solarized Light/Dark; Gruvbox Dark; Dracula); brand mark beside the empty-session greeting. → PLAN-ARCHIVE.md.
- [x] **V.2 — Codex (and Gemini) rendering + command fidelity** — done 2026-07-19; Codex chart-degradation root-caused (Codex hides MCP tools behind tool-search) and fixed (deferred-tools addendum + a deterministic mermaid backstop); `/model` re-skinned for BOTH Codex and Gemini from each binary's own catalog (Codex app-server JSON-RPC / Gemini ACP); Codex-on-OpenRouter probed. **Follow-up:** the `/effort` reasoning-effort scaffold landed 2026-07-19 (mock-built; TWO fidelity questions — per-model effort availability, and fold-into-`/model`-vs-standalone — pending a live Codex pass). → PLAN-ARCHIVE.md.
- [x] **V.3 — Truthful full-optionality Codex backend picker** — done 2026-07-19; every way codex can run is a picker row from config.toml ground truth (all `[model_providers]`), key-gated, provider carried on the wire, per-session enforced. → PLAN-ARCHIVE.md.
- [x] **V.4 — In-session ergonomics: a "new" button, prompt focus, terminal scrollback** — done 2026-07-20 (Kyle-directed, same day); `new` button beside home opening the startup screen in a fresh tab, `end` moved far right, caret starts in the prompt box on entering a session (never stolen from an open overlay or a live selection), and terminal-scrollback conditional autoscroll. → PLAN-ARCHIVE.md.
  - **⚠ The one thing still open:** the phone half of the scroll work is unverified by hand. Follow-the-tail detaches on a downward finger drag with **no minimum distance**, so a tap whose thumb wobbles a pixel (expanding a tool block, a pin button, a question option) silently stops auto-scrolling and the agent then looks stalled with nothing on screen explaining why. Kyle's call 2026-07-20 was to ship it and find out by hand. If it bites: require ~8px of travel before a drag counts as steering, in `onTouchMove` (`web/src/use-follow-tail.ts`) — a real swipe is hundreds of px, thumb noise is 1–2. The touch handlers are also **not proven necessary at all** (touch held correctly without them); they are kept only as a guard for iOS Safari, untestable on this machine.
  - **Note for anyone touching `use-follow-tail.ts`:** following scrolls **instantly, never smoothly**, and the reader's **input** is what detaches, not a position delta. Both were bought with a bug — a permanently in-flight smooth animation owned `scrollTop` and made the wheel inert during streaming. The trace and evidence are in commit `00288c6`; re-read it before reintroducing either.
- [x] **V.5 — The one-click picker row names its backing** — done 2026-07-20 (Kyle-directed, same day). Choosing Gemini started a session without ever saying an API key was what it ran on; `AgentInfo` gained an additive optional `kind` (set only when `live`) and the row renders `backingLine()` — the wire carries the *kind* as a fact, the client owns the wording, so the one-click row and the second step say the same words. Same day, Kyle's call: credential labels now use each vendor's OWN name — **"Gemini API key"** (not "Google API key" — that's the Vertex path), **"Claude API key"** (the API was rebranded from Anthropic API); the "ChatGPT subscription" / "OpenAI API key" asymmetry is OpenAI's own brand split, inherited deliberately and documented at `backendLabel`. → PLAN-ARCHIVE.md.
  - **The principle, worth keeping:** a single usable backend isn't "no choice to show," it's *a choice made on the user's behalf* — a menu you don't need can be skipped, but a decision made **for** the user must still be stated.
  - Considered and **rejected** for now: making the backend menu reachable from a one-click row. It costs a real restructure (the row is a single `<button>`; a nested button is invalid HTML) to answer a question the row's own label mostly pre-empts. Revisit only if a real user asks it.
- [x] **V.6 — The /model picker becomes real shell chrome (+ session polish batch)** — done 2026-07-22 (Kyle-directed, same day). Kyle hit V.2's fallback live: a Codex catalog past 4 rows degraded `/model` to a non-interactive list, where terminal Codex gives arrow-key selection at any size. Root cause named and fixed **structurally** — the re-skin had borrowed the agent-facing `question` component, **whose option cap is discipline on generated UI and must never bind a shell re-skin of terminal chrome**. Now an additive `picker` wire message + shell-owned `PickerBlock.tsx` (NOT a registry component): any row count, arrow/Enter/Escape captured globally from the idle prompt box, serving codex `/model`, codex `/effort` and gemini `/model` through one shared `emitModelPicker`. → PLAN-ARCHIVE.md. Same sitting, all Kyle-directed: question component option cap **4 → 6** (fidelity note: Claude Code's own AskUserQuestion still maxes at 4, so real agent questions stay ≤4 — the wider cap is headroom); the fresh-tab **white flash killed** (inline pre-CSS canvas paint in `index.html`, cleared by `main.tsx`); `.sb-pair` joined the 34px control row; and the **Tier-2/3 harness now scrubs the paid-tier env** (`MIRAFOLD_APP_URL`, `MIRAFOLD_LICENSE_KEY`, `MIRAFOLD_ENTITLEMENT_TOKEN/URL`) like credentials — a dev shell live-testing the paid path had relay itests dialing the real billing backend (one hung 45+ min).
  - **Ops lesson, recorded:** two sessions sharing one checkout DO cross-contaminate commits — whichever commits first sweeps up the other's in-progress edits.

## Phase A — Accessibility (opened 2026-07-20; ✅ COMPLETE 2026-07-21)

> **Correction 2026-07-30 — A.4's page was NOT live for nine days**: the
> statement was committed to the site repo's `staged/` and never copied to
> `public/` at the blackout lift, while this plan recorded it done.
> Restored, footer-linked on every page, sitemapped 2026-07-30 — measured
> live: 200. The lesson is the umbrella's own: a page's existence is a fact
> about the world, not about a plan. Full note (incl. the refreshed
> known-limitations wording) → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

Kyle's directive, verbatim: *"i want mirafold to be friendly to all people
capable of using it and to be ada compliant."* The ADA names no technical
standard for software, so the operative target is **WCAG 2.1 Level AA**.
All five steps done 2026-07-21 (Tier-1 307 · Tier-3 35 at close); full step
bodies, the whole Orca-walk log and the axe-sweep detail → PLAN-ARCHIVE.md
("Moved 2026-07-24"). What shipped: two `.sr-only` live regions
(`Announcer.tsx` — polite `role=status`, assertive `role=alert`) announcing at
semantic boundaries with the transcript held at `role="log"` +
`aria-live="off"`; dialog semantics + `useFocusTrap` + `.behind-dialog`/`inert`
sibling-hiding on all three overlays; the FleetView stretched-link card;
`speechFromMarkdown()` so the turn-end announcement speaks prose, not raw
markdown; and the public statement (A.4).

**Standing rules that outlive the phase — do not re-open:**

- **Contrast is done.** V.1's terminal-grade floors (strong ≥12 · fg ≥11 ·
  body ≥10.5 · mid ≥8.5 · dim ≥7 · dimmer ≥5.5 · faint ≥4.5 · accents ≥4.5)
  clear AA by roughly double at the *faintest* tier, on all seven themes,
  Tier-1 enforced against every real text SURFACE (not just `--bg`). Nothing
  owed.
- **The permission prompt does NOT move focus — LOCKED (Kyle, 2026-07-22).**
  His words: *"it violates normal browser behavior - don't do it."* The final
  shape is assertive announcement + Tab-reachable Allow/Deny. Never
  re-propose focus moves here, including "safe" conditional variants
  (move-only-when-input-empty, jump-to-bar shortcuts) — those were presented
  and declined.
- **Kyle's standing a11y rule:** *"i'm down with EVERY standard pattern for
  accessibility we can add so long as it doesn't change the interface or
  functionality for non-disabled users, only then do i want to be
  consulted."* Also in assistant memory as [[a11y-standing-rule]].
- **The screen-reader walk is fully automatable on this box** — no human ear
  needed. Recipe (Orca `--debug-file` + CDP via the claude-in-chrome
  extension + AT-SPI `doDefault` foregrounding + filtering the CLI's
  terminal-title flood out of the log) is in [[orca-testing-mirafold]].
- **Other screen readers deferred post-launch, Kyle's call 2026-07-22.**
  NVDA/JAWS (Windows) and VoiceOver (Apple) were never walked — each needs
  hardware we don't run. Not a launch gate; A.4's statement already words the
  scope honestly ("most thorough with Orca on Chrome").
- The automated regression guard for all of it is **C.2** (axe-core, Tier 3).

- [x] **A.1 — Live regions: streaming agent output is announced** — done 2026-07-21. → PLAN-ARCHIVE.md.
- [x] **A.2 / A.2b — Every control is a real control (incl. Onboarding)** — done 2026-07-20. → PLAN-ARCHIVE.md.
- [x] **A.3 — Focus management + the manual keyboard pass** — done 2026-07-21. → PLAN-ARCHIVE.md.
- [x] **A.3b — FleetView rows: nested interactive controls** — done 2026-07-20 (stretched-link card pattern, resolved by the standing rule above). → PLAN-ARCHIVE.md.
- [x] **A.4 — Public accessibility statement** — drafted + wired 2026-07-21 in `mirafold-site`; claims **partially conformant, self-assessed**, with known limitations named. Footer-linked on every page + in `sitemap.xml`.
  - **⚠ Still open, Kyle's call (flagged 2026-07-21, NOT applied):** dogfooding
    the site through axe found **two real WCAG-AA contrast failures on the
    marketing site itself** — `footer > p` `--faint #58627a` on `--bg-2` =
    **3.12:1** (fix `#798195`) on *every* page including the accessibility
    page's own footer, and index's `.copy` button `--dim #7b8698` on
    `--surface-3` = **4.32:1** (fix `#838d9e`). Both are shared brand tokens,
    so recolouring them is a visible change to Kyle's site design — outside
    the standing rule, his sign-off. Tracked in `mirafold-site/PLAN.md`.
---

## Phase KB — Keyboard power-user layer (opened 2026-07-22; candidate pre-launch, the vim-user wedge)

Distinct from Phase A: that phase is the *accessibility floor* (WCAG 2.1 AA —
can you reach everything by Tab). This is the *ceiling* — never needing the
mouse OR the Tab-slog: fast, discoverable keys plus a prompt box that speaks
vim. It targets exactly Mirafold's terminal-native wedge, so it reads as
identity, not polish. Not yet sequenced against C/D/etc.; steps get written
(Goal/Build/Files/Done-when) when Kyle slots it. Full breakdown + the
post-launch depth live in **POST-RELEASE.md** ("Keyboard power-user layer");
this note is the pre-launch pointer.

The two governing constraints (both Kyle's, 2026-07-22) turn out to point at
the *cheapest* architecture, not a costlier one:

- **Nothing changes for non-vim users** — verbatim Kyle's standing A.3 rule.
  Satisfied structurally: prompt-box vim mode is an opt-in setting, **default
  off = today's exact `<textarea>`, element unswapped**; global shortcuts fire
  **only when focus is not in the prompt**, so a user who lives in the prompt
  never triggers one.
- **Mirror how vim users already work in a terminal** — so the decisions are
  easy. The same focus-state rule *is* the modal mapping: typing a prompt =
  insert mode, `Esc` out = normal mode where shortcuts wake. ~80% of "modality"
  falls out of focus state with no mode system invented.

Candidate pre-launch slice (the identity part, ~1.5–2 wks, mostly hung off
machinery that already exists — the overlay pattern, `useFocusTrap`,
`useEscapeKey`, and the bus actions `interrupt`/`create`/pin):

- **Focus-visibility fixes** (hours). Reveal-on-hover controls must also reveal
  on keyboard focus. Confirmed gap: `.pin-btn` is `opacity:0` (styles.css:187)
  revealed only by `:hover` (styles.css:191) — a keyboard user Tabs onto an
  invisible button (WCAG 2.4.7). Add a `:focus-within`/`:focus-visible` reveal;
  sweep for siblings. Invisible to mouse users → under Kyle's standing rule.
- **`?` shortcuts overlay** (~½ day) — static keymap list, reuses the overlay +
  focus-trap machinery.
- **Command palette + core bindings** (~2–4 days) — a shell-owned overlay
  (leader `:` or Space) calling the existing bus actions; gated to
  focus-not-in-prompt.
- **Prompt-box vim mode** (~4–6 days, the long pole and the only real
  integration risk) — mount CodeMirror-with-vim in place of the textarea *only*
  when the setting is on, preserving auto-grow, Enter-to-send, the `❯` glyph,
  and all seven themes.

The ~3 small picks the terminal doesn't answer for you: Enter-in-normal-mode
(→ always send from the prompt), leader key (`:` vs Space), and focus-gated
shortcuts (v1) vs a true app-wide normal mode (post-launch). None
controversial.

---

## Phase C — CI/CD (opened 2026-07-20; ✅ COMPLETE 2026-07-21)

Before this phase there was no CI in any repo — verification was Kyle running
the three suites by hand. Both steps done 2026-07-21 and **both PRs merged
2026-07-22** (`mirafold/mirafold#1`, `mirafold/mirafold-relay#1`); full step
bodies + dated history → PLAN-ARCHIVE.md ("Moved 2026-07-24").

- [x] **C.1 — Stand up CI** — GitHub Actions live on both code repos. Shell
  (Node 22/yarn): typecheck + Tier 1 on every push, a separate integration job
  (Tier 2 + Tier 3 headless Chrome) **on PRs only** (Kyle's call, `a771110`).
  Relay (Node 20/npm): typecheck + unit. Actions on v5 both repos.
- [x] **C.2 — axe-core in Tier 3** — `axe-core@4.10.2` scans 5 surfaces, fails
  the build on serious/critical; verified it catches a real regression, then
  reverted. Exceptions list empty. This is Phase A's regression guard.

**Standing rules and carried-forward items:**

- **No provider credential ever goes in repo secrets — absolute.** Tier 4 is
  excluded from CI for exactly this reason; the harness forces credentials
  empty → `MockSession`, so there is no API spend and no live-model flakiness.
  Both workflows run `permissions: contents: read`.
- **Deployment is manual-dispatch only — Kyle's standing directive**, and it
  governs all future CD work in every repo (his job's `on-prod.yml` pattern: a
  human clicks *Run workflow* and picks the ref; nothing deploys on
  push/merge/schedule). Scaffolded for the relay in
  `mirafold-relay/.github/workflows/deploy.yml` (`9162fa1`), with the R.5d
  staging/production environment dropdown on it.
- ~~**Owed at the public flip (carried in R.5b):** re-enable the cross-repo
  relay itest.~~ ✅ **DONE 2026-08-02.** Both exclusions are gone from `ci.yml`:
  its two jobs check this repo out to `mirafold/` and
  `mirafold/mirafold-relay` to `mirafold-relay/` — siblings under the workspace,
  the same shape as a dev machine — then `npm ci` the relay, typecheck the
  **full** `tsconfig.json`, and run Tier 2 as plain `yarn test:server`. The
  relay needs its own install because module resolution walks up from
  `mirafold-relay/src/` and never reaches this repo's `node_modules`. The relay is
  public since 2026-07-31, so the default `GITHUB_TOKEN` reads it with no added
  secret.
  - **The checkout tracks the relay's default branch on purpose.** Pinning a
    ref would blind the contract guard to exactly the drift it exists to catch.
    Accepted consequence: a contract-breaking push to `mirafold-relay` turns
    this repo's CI red. That is the alarm working.
  - **Audited 2026-08-02, sound.** `ci.yml` runs on `pull_request` (not
    `pull_request_target`), grants `permissions: contents: read`, and
    references **no secrets at all**, so a fork PR gets a read-only token and
    nothing to steal. `release.yml` — which holds `id-token: write`, the npm
    trusted-publishing credential — runs only on tag pushes and manual
    dispatch and deliberately kept the single-repo checkout, so the new
    cross-repo checkout can never run in the job that can publish. The relay's
    lockfile is v3 with integrity hashes on all 34 packages. Full dispositions:
    `mirafold-chat/SECURITY.md`, the 2026-08-02 entry.

- [ ] **Hardening: SHA-pin the GitHub Actions** *(from the 2026-08-02 audit —
  roadmapped, not urgent)*. All eight `uses:` across `ci.yml` and `release.yml`
  are tag-pinned (`actions/checkout@v5`, `actions/setup-node@v5`) rather than
  pinned to a commit SHA. A tag is mutable: if one were ever moved
  maliciously, CI would fetch and execute the new code — and `release.yml` is
  the workflow that can publish to npm. Pre-existing (the relay-itest change
  added two of the eight, it did not introduce the pattern). Fix is mechanical:
  replace each `@vN` with the full commit SHA plus a trailing `# vN` comment,
  and re-pin on deliberate upgrades. Do this before the repo starts taking
  outside PRs in volume.
  - **`release.yml` deliberately did NOT follow.** It stays a single-repo
    checkout using `tsconfig.ci.json`, so no other repo's branch can block a
    publish, and the one file that config excludes is a test that never ships
    in the package. `tsconfig.ci.json`'s comment was rewritten to state that
    new reason — its original one (the relay was private) expired at the flip.
  - Verified locally before and after: full `yarn typecheck` clean with the
    sibling present, `relay-service.itest.ts` **12/12**, and the whole of
    `yarn test:server` **142/142** in ~231s — 130 of which is what CI's
    `find … ! -name relay-service.itest.ts` used to run, so the change is
    strictly additive in coverage.
- **✅ Branch protection LIVE 2026-08-07** (the paywall block expired at the
  2026-07-31 public flip; landed via two rulesets, effective rules re-measured
  from the API after creation). `main`: required checks (Tier 1, Tier 2+3,
  DCO), no review requirement, repo-admin bypass for direct pushes, no
  force-push/delete — the exact shape recorded here on 07-22. `next` (created
  2026-08-07 at `main`'s head): PR-only entry (0 approvals), same required
  checks, NO bypass for anyone. Feature branches stay unprotected; convention
  is to cut them from `next`. Commits headed for PRs need `git commit -s`
  (DCO now blocks). Still unwritten: the `release/x.y.z` mechanics.
- **✅ CI flake fully resolved 2026-07-23** (PR `mirafold/mirafold#5`): six
  flaky tests, three root causes, each reproduced under CPU pinning before
  fixing — **no product code changed** (every fix was in test/harness code),
  proven by repeated green CI cycles on the real runner. Full four-cause
  breakdown → PLAN-ARCHIVE.md ("Moved 2026-07-27").
---

## Phase D — Decompose the Codex adapter (opened 2026-07-20)

At the 2026-08-11 refactor start, `server/adapters/codex.ts` was **1,004 lines**
and carried at least five separable concerns. Size alone did not justify the
step; two separate 2026-07-20 bugs both lived in the seams between those
concerns — the engine-default lookup did not know what provider binding had
decided, and a non-fatal engine item was classified beside the fatal ones.

The local split now isolates the event mapper before Phase F widens Codex's
event vocabulary further.

**This is a pure refactor — zero functional change.** It is well protected:
298 Tier-1 tests, the Tier-2 and Tier-3 suites, and the Tier-4 live tier, all
green as of 2026-07-20 (318 Tier-1 as of 2026-07-23).

**2026-07-23 — pre-launch refactor pass** (unplanned maintenance, whole
repo): a behavior-preserving sweep landed shared helpers server- and
web-side (`errText()`, `handleSystemMsg()`, `finishTool()`, `ModalCard`,
`useArmedConfirm`, `DiffLines`, static `OFFERABLE`) plus one real bug fix
(Onboarding's 3s re-probe poll was reset every render by an unstable inline
`onRefresh` — now `useCallback`-stable). The architecture's accepted-duplication
list honored; all tiers green (318/86/37). Full detail → PLAN-ARCHIVE.md
("Moved 2026-07-27").

- [ ] **Step D.1 — Split `codex.ts` along its existing seams**
  - Goal: no file over ~400 lines, each concern findable by name, and
    `CodexSession`'s public surface (the `AgentSession` contract) unchanged.
  - Build: extract along the seams already visible in the file —
    1. **Provider + model binding** — `providerBinding`, `firstPartyOpenAI`,
       `needsEngineDefaultModel`, `applyEngineDefaultModel`. This is the
       cluster that produced the 2026-07-20 model-binding bug; it deserves to
       be one named unit with its own tests.
    2. **The slash-command surface** — `runModelCommand`, `runEffortCommand`,
       `setThreadModel`, `setThreadEffort`, `restartThread`, plus the `EFFORTS`
       / `EFFORT_DESC` tables.
    3. **Event → WireMsg mapping** — `handleEvent` / `onItem`, the largest
       single block and the one Phase F will grow.
    4. **The rollout model lookup** — `resolveRolloutModel` + `rolloutDateDir`,
       already standalone exported functions with no `this`, so this one is a
       move rather than an extraction.
    5. **Prompt constants** — `CODEX_DEFERRED_TOOLS_ADDENDUM` and friends.
  - Keep `codex.ts` as the class + its lifecycle; the extracted units should be
    importable and testable without constructing a session where possible.
  - Files: `server/adapters/codex.ts` → new siblings (`codex-binding.ts`,
    `codex-commands.ts`, `codex-events.ts`, `codex-rollout.ts` or as the seams
    suggest); `server/adapters/codex.test.ts` imports follow.
  - Done when: `yarn typecheck` clean; `yarn test` still **318 pass / 0 fail**
    (count as of 2026-07-23)
    with no test rewritten to accommodate the move (import paths may change,
    assertions may not); `yarn test:server` and `yarn test:e2e` unchanged;
    `yarn test:live` still 2 pass / 1 skip; and one real subscription turn plus
    one real OpenRouter turn verified by hand, since those are the paths the
    binding cluster governs and no mock covers them.
  - **2026-08-11 integrated; live closure outstanding.**
    `codex.ts` is now 382 lines and retains `CodexSession`, its public
    `AgentSession` surface, test-observed thread state, and lifecycle. Named
    sibling modules now own provider/runtime binding, slash commands and prompt
    discovery, diagnostics, SDK-event normalization, prompt constants, and
    rollout lookup; none exceeds 250 lines. Existing public re-exports remain
    at `codex.ts`; D.1 changed no assertion or test file and added no
    dependency. PR #34 passed DCO, Cloudflare Pages, Tier 1, and the combined
    Tier 2/Tier 3 check before merging into `next` at `21b5f33`. Keep this step
    unchecked until its Tier 4 and manual subscription/OpenRouter done-when
    checks are actually completed.

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

- [x] **Step F.2 — System-notice line (the UI must not lie in degraded service)** — done 2026-07-12; one additive `notice` WireMsg (retry | compaction | rate_limit | refusal) mapped from five SDK events in the claude adapter, drawn as a dim persistent notice line in RenderZone (silent on plain rate-limit `allowed`, so no spam). → PLAN-ARCHIVE.md.

- [x] **Step F.3 — Honest model label in the status bar** — done 2026-07-08; the adapters read the engine-resolved model (`system/init`, gemini `result.stats.models`) into `usage.model` instead of "default"/"auto". → PLAN-ARCHIVE.md.

- [x] **Step F.4 — Gemini honesty pass** — done 2026-07-08; a stderr-only non-zero exit surfaces as an `error` WireMsg instead of a silent turn. → PLAN-ARCHIVE.md.

- [x] **Step F.9 — Gemini session-id self-heal (a session-bricking latent bug, found in the 2026-07-23 refactor recon)** — done 2026-07-23. The adapter set `started = true` before the child confirmed anything, so a first turn that failed before Gemini persisted the session file (bad auth, missing binary, an early kill) left every later turn spawning `gemini --resume <id>` against an id that was never saved — which the CLI treats as `FATAL_INPUT_ERROR` (exit 42, zero stdout events, verified in the installed v0.51.0 bundle's `resolveSessionId()` AND by a credential-less sandbox repro): the Mirafold session was permanently dead, erroring on every prompt. Fix: the close handler now flips the id mode when a turn exits 42 with no events — the failure itself proves the flip direction ("no such session" ⇒ create next turn; the mirror fatal, `--session-id` "already exists" ⇒ resume next turn) — so recovery costs one failed prompt instead of the session. No timing assumptions about when Gemini persists, no stderr string-matching (exit code + zero-events is the whole signature). Three Tier-1 tests through the real spawn path: the brick sequence heals, the mirror heals, and 42-with-events (a different input error) does NOT flip.

- [x] **Step F.7 — Codex resolved-model label (closes F.3's codex gap)** — done 2026-07-16; the adapter reads the engine-resolved model from Codex's own rollout record (keyed by thread id; bounded poll; failure-silent; a configured `CODEX_MODEL` wins). Side-finding folded into F.5's rationale: the SDK vendors an older codex binary than the user's terminal, so SDK sessions can default to an older model. → PLAN-ARCHIVE.md.

- [x] **Step F.8 — `!` terminal parity + hardening** — done 2026-07-17 (Kyle: "we must never hide ANYTHING"); bang `cd` persists inside the workspace (EXIT-trap cwd handoff; an escape resets with the terminal's own notice), silent success renders "(completed with no output)", and the transcript reaches the agent immediately as its own turn (the engine's internal shell can't follow a bang `cd` — the one disclosed divergence). Same-day hardening: 0700 handoff dir, FIFO-stall gate, closing-fence escaping, 400ms bang throttle. F.3 extended: `session_created` carries the model label (status bar + fleet show agent → model from attach). SECURITY.md disclosure note queued under R.7. Tests in all three tiers. → PLAN-ARCHIVE.md.

- [x] **Step F.10 — Codex runtime/version parity hotfix** — done 2026-08-08;
  Mirafold now points the SDK at the user's installed Codex when present,
  retains the current SDK binary as fallback, and asks that one engine for
  both model catalogs. A live subscription prompt with Kyle's unchanged
  `max` setting resolved GPT-5.6 Sol and replied `ok`; focused tests (53/53),
  Tier 1 (536/536), typecheck, build, package dry-run, and production audit
  (0 vulnerabilities) passed. → PLAN-ARCHIVE.md.

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
    (4, added 2026-07-16 via F.7) ~~**the SDK vendors its own codex binary**,
    so sessions can run an older default model than the user's terminal
    codex~~ — closed by F.10 on 2026-08-08: SDK turns and catalogs now use the
    installed Codex when present, with the current bundled binary retained
    only as fallback. F.5 still owns the first three app-server divergences.
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
  - Files: `server/adapters/mock.ts` (malformed hook),
    `server/testing/app.e2e.ts`.
  - Done when: malformed instructions visibly degrade instead of crashing in
    a real browser, the five-frame checklist paints one block not five, and a
    pinned widget stays live across an update and a reload.

- [x] **Step Q.2 — Freeze the wire protocol in executable form** — done 2026-07-12; mapped-type golden fixtures for every WireMsg/ClientMsg variant: a missing fixture fails typecheck, a reshaped frame fails loudly — both teeth verified by experiment. → PLAN-ARCHIVE.md.

- [x] **Step Q.3 — Ring-buffer eviction and the resume boundary** — done 2026-07-12; five Tier-1 tests pin the exact eviction window and the `canResume` edge, verified to bite by mutation. → PLAN-ARCHIVE.md.

- [x] **Step Q.4 — Hostile-client sweep of `connection.ts`** — done 2026-07-12; a real-daemon garbage sweep of every ClientMsg case found + fixed two real bugs (a null frame could crash the whole daemon on the local path; the bang-id guard coerced non-strings into launching bangs). → PLAN-ARCHIVE.md.

- [x] **Step Q.5 — Pin the `.env` guard's edges** — done 2026-07-12; traversal + cross-cwd denials pinned across all four guarded readers, non-vacuous by weakening the guard. (Symlink bypass stays the documented accepted residual.) → PLAN-ARCHIVE.md.

- [x] **WATCH ITEM (2026-07-24): the follow-tail re-arm race — closed
  2026-08-08 by N3.3.** A real product race (scroll events lag the scroll a
  frame, so landing at the bottom mid-stream could measure "not at
  bottom"); downward intent that reaches the bottom now re-arms
  synchronously against pre-input geometry. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

---

## Phase UI — Core browser UI contracts (opened + ✅ COMPLETE 2026-08-16)

- [x] **Phase UI complete.** Added three isolated real-Chrome contracts for
  desktop multiline submission, settings-modal focus containment/restoration,
  and the two-click end-session safeguard through its mission-control redirect.
  No production or dependency file changed. Targeted Tier 3 was **3/3**;
  typecheck passed; Tier 1 was **840/840**; the full freshly built Tier 3 was
  **103/103** with the new tests discovered as 101–103. A same-day refactor
  removed one vacuous selector and its dead session-id plumbing; post-refactor
  targeted Tier 3 remained **3/3**, typecheck passed, and full Tier 3 remained
  **103/103**. Full verified baseline, dependency decision, implementation
  boundary, and completion record →
  **PLAN-ARCHIVE.md, “Moved 2026-08-16 (Phase UI — core browser contracts).”**

---

## Phase UIX — Cross-engine and visual browser gates (opened + ✅ COMPLETE 2026-08-16)

- [x] **Phase UIX complete.** Added a bounded Chromium/Firefox/WebKit journey
  plus committed Ubuntu-24.04/managed-Chromium baselines for onboarding, a
  settled desktop turn, and phone settings. The new `yarn test:ui` gate passed
  **6/6** with zero skips in 34.82 seconds after its production build; a
  deliberate changed-image probe was rejected and emitted actual/diff PNGs.
  Typecheck passed, Tier 1 passed **840/840**, and the freshly built full
  system-Chrome Tier 3 remained **103/103**, zero skipped. No shipped server or
  React module, runtime dependency, lockfile, or release workflow changed.
  A same-day test-only refactor centralized the repeated daemon/context/page
  lifecycle and mock-session entry, hoisted the visual capture policy, and
  stopped encoding a diff PNG for passing comparisons. Assertions, thresholds,
  browser coverage, and baseline PNG bytes stayed unchanged; post-refactor UI
  remained **6/6**, targeted Chrome contracts **3/3**, Tier 1 **840/840**, and
  full Tier 3 **103/103**.
  Full starting state, dependency/CI cost, implementation boundary, temporary
  local WebKit setup, and verification record → **PLAN-ARCHIVE.md, “Moved
  2026-08-16 (Phase UIX — cross-engine and visual browser gates).”**
  Review follow-up 2026-08-17: page-error capture now attaches before the
  first navigation (owned by `withFreshMockPage`, which hands the list to
  the test and appends it to any failure); a light-theme desktop
  baseline joined the three (4 PNGs); the visual half skips off Linux instead
  of failing; the cwd normalization keeps the LRM sentinels the real render
  uses; CI caches the managed browsers per `playwright-core` version and runs
  `test:ui:built` against the `dist` Tier 3 already built. After installing
  WebKit's apt host libraries on the workstation, the shipped `yarn test:ui`
  passed **7/7** (Chromium + Firefox + WebKit + 4 visual); Chrome contracts
  **3/3**. Same-day audit + test-audit: the onboarding baseline depended on
  the host having a display (the daemon advertised its folder picker →
  "browse…" rendered; proven red with `DISPLAY=` unset), fixed by pinning
  the visual daemon to `DISPLAY=""`/`WAYLAND_DISPLAY=""` and regenerating;
  six mutations of product code (Shift+Enter submit, focus-trap wrap,
  one-click end, duplicate KPI card, boot-time throw, 2 px CSS shift) each
  failed exactly the test that names them, and the boot-time throw now
  fails by its own message. Final: 10/10 across the branch's suites.

---

## Phase S — Theme system: six themes at launch (✅ COMPLETE 2026-07-16)

Six themes ship in the launch build — Light, Dark, Solarized Light,
Solarized Dark, Gruvbox Dark, Dracula — on plumbing that makes every later
theme a **one-CSS-file + one-manifest-row addition** (loading is glob'd,
swatches parse the theme file, Tier-1 guards sweep the directory — proven
by construction in S.5/S.6). All six steps done 2026-07-16, final parity
178/74/24; full charter + step bodies → PLAN-ARCHIVE.md. The **standing
rules that outlive the phase**:

- **The light/dark pill does not change AT ALL — LOCKED (Kyle, stated
  multiple times; re-affirmed emphatically 2026-07-16 after an "Auto"
  third state was misrecorded into S.3's original text and struck).** Same
  look, same two positions, same behavior — no tri-state, no Auto, no
  `prefers-color-scheme` following, no visual tweak of any kind. Its two
  positions select the two theme slots (light/dark), which with default
  slots is indistinguishable from before. The settings gear (S.4) is the
  phase's ONE new chrome affordance. Any future change to the pill
  requires a new, explicit decision from Kyle — never infer one from
  adjacent work.
- **Semantic tokens stay the vocabulary; native CSS only; Base16 is only
  the porting recipe.** The 41-token contract, the 7 pinned
  `--code-*`/`--diff-*` tokens (code/diff surfaces stay dark universally),
  and the slot→token recipe live in `web/src/themes/manifest.ts`, guarded
  by `themes.test.ts`. Themes never come in pairs; every theme is
  standalone, labeled `light` or `dark` only to answer which side of the
  pill selects it.
- Adding a theme: one file in `web/src/themes/` + one manifest row via the
  recipe. Before accepting community theme PRs at the public flip, land
  R.7's token-VALUE guard hardening.

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
  - Note (2026-07-17): Phase N lands the detection substrate this step
    reuses (`server/local-models.ts` — the probe, dialect tagging, model
    catalogs) and the in-UI picker; what remains of L.2 is only the CLI
    flag ergonomics, still demand-gated.
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
  - Note (2026-07-17): **Phase N delivers most of this** — per-session
    backend choice at onboarding (N.5 is exactly the "registry passes
    per-session env/config" build). What remains of L.3 afterward is only
    whatever mixing ergonomics Phase N's shipped form still leaves wanting.

- [x] **Step L.4 — Diagnose intermittent Codex → Ollama real turns** — done
  2026-08-11; direct Ollama traces isolated cold prompt prefill plus Qwen's
  unbounded default reasoning (not an SDK event-delivery stall). Discovered
  local Codex sessions now offer explicit `/effort none`, retain inherited
  defaults until selected, end unfinished turns at an evidence-based eight
  minutes with actionable recovery, and fail unavailable endpoints clearly.
  Tier 4 pins an explicit 32K model so recency order or silent 4K truncation
  cannot false-green; valid full-context runs passed cold/warm/warm in
  385.9/90.3/90.3 seconds and a real unavailable endpoint failed in 4.9
  seconds. → PLAN-ARCHIVE.md.

---

## Phase E — Explorer (opened + ✅ COMPLETE 2026-07-24; Kyle-directed, promoted from POST-RELEASE.md)

The "Folder & file & diff view" intake entry, built: a shell-owned,
**read-only** browser of the session's working tree — file tree, file
contents, git diffs. All five steps shipped 2026-07-24 plus a
behavior-preserving refactor and a security audit; tiers **350/95/41**.
PRs #7 (E.1+E.2), #9 (E.3), #10 (E.4+E.5), #12 — all merged to main. Full
design charter, step bodies and dated status → PLAN-ARCHIVE.md ("Moved
2026-07-24").

The governing principles, which any later work here inherits:

- **Shell-owned and read-only.** The agent paints nothing here — same trust
  rule as the permission bar. No editing in v1; that persona belongs to the
  embedded-terminal-pane idea (POST-RELEASE.md).
- **Wire-native, per-viewport.** Additive protocol types over the existing
  WebSocket, never HTTP — remote/relay viewports have no HTTP path to the
  daemon, so wire-native means the phone gets this by construction. Replies
  carry a client-minted echoed `id`; never broadcast, never replay-buffered,
  no `seq`.
- **Jailed.** Every path resolves through `inside()`'s realpath containment
  against `entry.cwd` (the immutable session root, never `bangCwd`), with the
  `.env`/`.env.local` secret denial on top.
- **Diffs are `{before, after}`, diffed client-side** (`git show HEAD:path` vs
  the working tree, through the existing `diffLines` LCS differ) — hunk text
  never crosses the wire, no `@@` parsing anywhere.
- **Two presentations, one component set** (Kyle's calls): desktop = a
  collapsible LEFT side panel; phone (≤640px) = full-screen drill-in layers,
  explicitly NOT a bottom sheet. This claims the split-pane layout slot the
  embedded terminal pane will later share.

Accepted v1 limits, on purpose: ignored files are invisible in-repo
(`ls-files --exclude-standard` semantics); independently-capped diff sides can
overstate changes past the cap (truncation markers render prominently); full
`role="tree"` arrow-key grammar is deferred to Phase KB territory — buttons in
nested lists are tabbable and axe-clean.

**Security audit of the whole delta (2026-07-24): no exploitable
vulnerability.** One hardening landed same session (`FS_TREE_MAX_NODES` bounds
the non-git walk — a workspace of many empty directories could otherwise be
walked unbounded and synchronously), and one terminal-parity read-scope note
was recorded in SECURITY.md's known-trust-decisions (the Explorer's
`.env`-basename read scope matches the existing `Read` tool / `!cat`; the
daemon's own `.env` stays protected and the Explorer is narrower).
**Deferred, evidence-gated:** make the non-git walk asynchronous (yield to the
event loop) only IF the node cap ever proves too blunt — likely unnecessary.

**Security audit of the 2026-07-25 evening delta: one finding, fixed the
same session (`0ae994c`)** — the browser bundle inlined the ENTIRE
package.json (a default json import in `web/src/version.ts`); a named import
tree-shakes it, pinned by `bundle.e2e.ts` in Tier 3 and proved to bite.
**Kept deliberately, don't re-flag:** the pairing URL's `tabIndex={0}`
(Kyle's call — a keyboard landing spot on the URL; axe passes both ways).
**Considered and dismissed:** the full pairing code at 1.5× adds no exposure
(the QR above encodes the same secret). **Closed with evidence:** the
`@hono/node-server` advisory is unreachable (stdio MCP transport only; no
`serveStatic` in shipped bundles). Also verified clean: no raw-HTML sinks,
escaped agent labels, no `<a href>` pairing link, no secrets in commits, no
`.env`/source maps/install hooks in the tarball, reproducible builds. Full
narrative → PLAN-ARCHIVE.md ("Moved 2026-07-27").

**Desktop/phone frame — final shipped shape** (Kyle-directed polish pass
2026-07-24; Kyle-caught deviation restored 2026-07-25, `d8abc62`): desktop
gets a VS Code-style **activity bar** (files icon toggles the panel; the
tree leads with the checked-out root as its top node, path in tooltip;
fit-to-content panel width capped at 340px/42vw, 140px floor; refresh
floats bottom-left; back lives in the file view's path bar) — and the rail
is **desktop-only**: on phone (≤640px) it's hidden (shell + prompt box
full-width) and the toggle is `.sb-files` at the status bar's far LEFT,
boxed by its own separator one notch outside home — Kyle's chosen shape;
desktop DOM keeps home first (the locked 2026-07-16 order). Deployed to
app.mirafold.com. A same-session behavior-preserving refactor + delta audit
(no exploitable findings; hostile `<img onerror>` filename inert) rode
along. Round-by-round narrative + the measure-don't-eyeball lesson →
PLAN-ARCHIVE.md ("Moved 2026-07-27").

Post-v1 depth (editing, fs-watcher, syntax highlighting, changed-files
grouping) stays parked in POST-RELEASE.md.
---

## Phase M — Mission control (opened + ✅ COMPLETE 2026-07-24; Kyle-directed, promoted from POST-RELEASE.md)

The "Cockpit fleetview" intake entry, built: FleetView (4.6) grown into a true
cockpit — at-a-glance live state of every session, and acting on sessions from
the grid rather than only entering them. All five steps shipped 2026-07-24;
tiers **357/94/47**. **PR `mirafold/mirafold#8` merged to main** (CI Tier
1/2/3 + CodeQL green), follow-up passes via **PR #11**. Full design charter,
step bodies and dated status → PLAN-ARCHIVE.md ("Moved 2026-07-24").

What shipped: registry-derived live `SessionMeta` (activity + since, pending
permission queue, session usage, `createdAt`) on the existing per-viewport
`sessions` snapshot; three sessionId-addressed `ClientMsg` acts
(`answer_permission`, `interrupt_session`, `prompt_session`); enriched rows
with activity readout, compact usage, an in-place Allow/Deny line, an armed
two-click stop and a per-row quick prompt; phone-width folding; and the fleet
TAB as a signal (needs-you badge + counted title) plus the per-row viewport
count.

The governing principles, which any later fleet work inherits:

- **Shell-owned end to end.** Same trust rule as the permission bar: agent
  output never paints here, and every engine-derived string on a row renders
  as inert plain text — never markdown, never HTML.
- **Extends the watch_sessions path, additively.** Live state rides optional
  `SessionMeta` fields on the existing snapshot (never broadcast, never
  replay-buffered, no `seq`); grid acts are new sessionId-addressed
  `ClientMsg` types on the `end_session` precedent. No new stream, no new
  transport.
- **Agent-neutral by construction** — every field is derived in the registry
  from the WireMsg stream it already fans out. No adapter cooperation, no
  per-agent code.
- **Grid acts = viewport acts, same gates.** Acting from the grid grants
  nothing a local viewport couldn't do by attaching. The one carried gate: a
  REMOTE (relay) watcher may not drive a subscription-backed session (R.4i),
  so quick-prompt and permission-answer are refused when
  `remote && !allowedOverRelay(kind)`; interrupt stays ungated, like
  `end_session` (teardown, not model use).
- **Stable rows, needs-you first** (Kyle's ordering call): rows hold creation
  order so eyes can park on a session; sessions awaiting permission surface to
  a group at the top. The recency sort is retired on this page.
- **The archived-session fleetview stays unprecluded** — the `sessions`
  snapshot remains live-only; a future archived fleetview arrives as its own
  additive message + a second page section, never by reshaping this one.

Accepted v1 limits, on purpose: no live output preview on rows (Kyle's call);
no one-click default new-session (the picker stays the only create); usage
mirrors the status bar's exact rule (per-turn tokens summed, cost taken
cumulative); elapsed time ticks client-side from `since`. *(A third v1 limit —
permission-queue status stickiness hiding a second concurrently-pending
request — was hit in real use and FIXED in the 2026-07-24 evening pass below.)*

**Post-merge + evening passes (2026-07-24, PR #11 + `bb272da`) — the
standing outcomes:** the fleet.e2e ordering flake's real bug fixed
(`.fleet-activity` had no min-width — now `12ch`); the permission detail
rides the snapshot WHOLE (the 200-char cap removed — a grid approver could
miss a dangerous tail; pinned Tier 1+2), with the pending-permission mirror
capped at 25 entries (oldest evict — closest to auto-deny; evicted asks
stay answerable at the adapter; a flood can't grow snapshots unbounded);
the **concurrent-permission stickiness limit is FIXED** (queue entries live
until their OWN resolution via `registry.answerPermission`, aging out on
the adapter's own timeout clock; needs-you keys on pending asks OR status);
activity/usage moved off the row bar into a per-row caret-toggled sub-line
(centered-borderless tried and reverted — Kyle iterated live); viewport
counts drop immediately on navigation (`pagehide` closes the socket;
bfcache still reconnects); session idle timeout raised 60min → **4h**
(Kyle's call). Tiers at close 369/103/51. Full narrative → PLAN-ARCHIVE.md
("Moved 2026-07-27").
---

## The Explorer→panes→terminal arc (opened 2026-07-26; Kyle-directed, four phases, worked in stages)

One design conversation (2026-07-26) produced the next four phases. They are
deliberately **separate phases, implemented in stages, never as one push**
(Kyle's explicit instruction), in this **locked order**:

> **E2 (Explorer at scale) → W (live tree) → PN (panes) → TP (terminal pane)**

**2026-08-11 amendment (Kyle-directed):** the new Changes-review work below
now runs before the two remaining phases, PN → TP. This does not reorder or
combine those phases: CR.1 deliberately completes PN.1's reusable-file-view
seam, CR.2 uses one purpose-built review surface rather than PN's later tabbed
file panes, and PN.2/PN.3 remain the next general-pane work afterward.

E2/PN/TP is Kyle's stated feature order (lazy explorer first, then a pane to
view files, then vim in a pane); W slots second because its client half depends
on E2's lazy shape (the refetch unit becomes "expanded directories", not "the
one flat list"), and both PN and TP consume its change signal. None of these
gates Phase R — this is the dev-side track that continues alongside launch.

**Decisions from that conversation, recorded once here (the phases below
inherit them):**

- **The explorer stays read-only — no create/rename/delete in the panel,
  possibly forever** (Kyle). Editing arrives only through the terminal pane
  (TP), where vim owns its own buffers, swap files and conflict detection —
  Mirafold hosts an editor without ever being one. The Phase E "disk is the
  truth, refetch is always correct" property is therefore permanent.
- **No extension/plugin system, ever** (Kyle: doesn't think he'll ever want
  extensions needing special permissions). Consequence, and the reason the
  watcher stays simple: Mirafold-internal features are the ONLY subscribers
  to any file-change signal, so W can be doorbell-grade ("something changed →
  refetch") instead of VS Code's precise per-file event contract, which
  exists to serve third-party subscribers we will never have.
- **Native dependencies are acceptable** (Kyle) — ordinary for this class of
  package (esbuild, sharp, node-pty precedent). Each still passes the
  dependency test individually; costs named per phase.
- **The terminal pane is LOCAL-viewport-only, enforced daemon-side,
  fail-closed** (Kyle: desktop-only, never over the relay) — see TP.

## Phase E2 — Explorer at scale (lazy tree + multi-repo fidelity)

**Why.** Phase E's whole-tree bet (one flat capped listing, expand is
client-side) was right for its scope — one session rooted at one ordinary
repo — but Kyle's target use now includes **rooting a session at a
Projects-style folder holding several repos** (fleets of agents across
projects). That breaks the bet two ways: (1) when the root isn't itself a git
repo, the fallback walk reads no nested `.gitignore`, so every `dist/`/venv
counts against the 4,000-entry cap; (2) that mode has no git awareness at
all — zero status letters. The fix is VS Code's shape: **fetch lazily, one
directory per request**, and let git fidelity be per-nested-repo.

**Wire (additive, per the locked rule).** A new request/reply pair —
`fs_listdir { id, path }` → `fs_dir { id, path, entries }`, where entries are
one directory's children (name, dir/file/symlink kind, optional git status).
The legacy `fs_list`/`fs_tree` whole-tree pair **keeps working untouched** —
the app bundle (app.mirafold.com) and a user's daemon can be version-skewed,
so the old pair is the compatibility floor, never removed in this phase.

**Inherited from Phase E, unchanged:** shell-owned and read-only; per-viewport
correlated replies (never broadcast, never replayed); every path jailed
through `inside()` realpath containment + the secret-file denial; per-type
throttle. Caps become **per-directory** (entry count + path bytes per reply),
which is strictly tighter than the old whole-tree walk.

**Latency posture (relay/phone):** first expand of a folder is now a round
trip. Mitigations in-scope: cache fetched directories for the session,
prefetch root + first level on open. Phone drill-in maps naturally (each
layer = one directory = one fetch).

- [x] **E2.1–E2.4** — all done 2026-07-26, phase complete (additive
  `fs_listdir`/`fs_dir` jailed + per-dir-capped + token-bucket throttled
  (`FS_LISTDIR_MAX_PER_SEC` 32); lazy per-directory client store; per-repo
  git fidelity behind a TTL cache + one serialized git queue; `fs_diff`
  discovers the repo containing the file; the legacy `fs_list` old-client
  floor pinned as-is, never to be "fixed"). Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."
- [ ] **Open decision (recorded 2026-08-25, Kyle's call) — when the
  old-bundle floor retires.** Three code sites exist only for a browser
  bundle older than the daemon (the relay's app origin can serve a cached
  one): the whole-tree `fs_list`/`fs_tree` handler (`fs-handlers.ts`) and
  the two `LEGACY CLIENT` branches in `resolveChosenBackend`
  (`server/adapters/index.ts` — the by-URL endpoint choice and the
  by-kind configured-Claude choice). They share one support window and
  should retire together, in a release note, once no served bundle can
  predate the lazy tree and opaque backend ids. Nothing else in the repo
  depends on them; the client stopped sending `fs_list` in Phase E2.

### Deferred from the 2026-07-26 security audit — ✅ both landed with phase W

The E2 audit found **nothing exploitable**; two hardening items (neither
reachable at the measured 40 ms / <400-byte per-repo status cost) were
deferred into W and both shipped 2026-07-26, pinned + mutation-tested:
**W.H1** — a listing waits on its repo's status only up to
`FS_LISTDIR_STATUS_WAIT_MS` (300ms); on timeout the PLAIN listing ships and
one synthetic `fs_changed` decorates it when the slow status settles (one
owed bell per repo per connection; a degraded status rings nothing).
**W.H2** — the status cache stamps its TTL clock when the answer ARRIVES
(in-flight entries read as always-fresh, so every late caller coalesces).
Full bodies + original findings → PLAN-ARCHIVE.md ("Moved 2026-07-27").

### Step E.6 — the enlarge lightbox

- [x] **E.6 — ⤢ enlarge** — done 2026-07-28 (Kyle-directed; dimmed lightbox
  re-framing the SAME node so scroll survives; desktop-only; the lightbox-
  over-permission-bar layering is an accepted decision in SECURITY.md).
  Body → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."

## Phase E3 — Explorer visual polish

- [x] **E3.1–E3.2** — done 2026-08-11, visually approved by Kyle; merged
  through PR #34 at `21b5f33`. Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."

## Phase BC — Whole-codebase correctness closure

- [x] **BC.1 — the eight confirmed whole-codebase findings repaired** — done
  2026-08-11, each with a concrete regression; PR #35 merged to `next`
  2026-08-11 (`80911b4`). Body → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."

## Phase W — Live tree (the filesystem watcher; the refresh button goes vestigial)

**Why.** The tree self-refreshes only at agent turn-end (E.5), so anything
out-of-band — Kyle editing in another program, git in a terminal, and later
TP's vim edits, which happen with no agent turn at all — leaves it stale
behind a manual button. TP makes this load-bearing: without W, Mirafold's own
UI would cause disk changes its own tree doesn't show. Goal state: the button
**stays** (VS Code keeps one too — network mounts, missed events) but a user
should never *need* it.

**Design: doorbell, not precision.** One watcher per session on the daemon;
on any change, after a debounce (coalesce an agent's 40-file write into one
signal), push a small notification to attached viewports; the client
responds by refetching through the machinery it already has (E2's expanded
dirs; later PN's open file views). No per-file event contract — the
no-extensions decision above is what makes this sufficient, permanently.

**Dependency decision: `@parcel/watcher`** (VS Code's own choice). It passes
the take-the-dependency test on two grounds: native/platform code (a C++
addon over inotify/FSEvents/ReadDirectoryChangesW) and the load-bearing
capability Node's recursive `fs.watch` lacks — **exclusion patterns**, so
`node_modules`/`.git/objects` never consume inotify watches. Costs, named:
per-platform prebuilt binaries (~1 MB installed, no compile at install),
native supply-chain surface, a small transitive tree (micromatch-class glob
matching).

**Wire (additive):** one new server→client message, `fs_changed`, minted
from day one with an **optional best-effort `paths` hint** (capped list +
`truncated` flag; consumers must tolerate its absence — the doorbell
contract). The hint is nearly free now and is what lets PN/TP panes ignore
irrelevant bells later without ever reshaping the message.

**Robustness rules:** watch `.git`'s HEAD/index/refs (excluding `objects/`)
so commits and branch switches — which change statuses without touching
working files — still ring the bell (*true when the session root is the repo
root; a session scoped to a SUBDIRECTORY has its `.git` above the watched
root, so out-of-band commits ring nothing there and turn-end/the button stay
the floor — 2026-07-26*); watcher start/stop follows viewport
attach/detach per session; **failure degrades gracefully, fail-open to
today's behavior** — watch-limit exhaustion (ENOSPC) or any watcher error
surfaces one notice and leaves turn-end refresh + the button as the floor.
The E.5 turn-end refresh stays as belt-and-suspenders.

- [x] **W.1, W.B, W.A, W.2** — all done 2026-07-26, phase complete
  (`@parcel/watcher@2.6.0` + `server/sessions/fs-watch.ts`; paths hint capped
  by count AND bytes (`FS_WATCH_MAX_PATH_BYTES` 16,000); `git-trust.ts` +
  `trusted-repos.json` neutralize the three probe-proven git execute vectors
  unless the repo is user-trusted; per-viewport `fs_changed`, client
  coalesced via `bellRefreshDelay`; every daemon git read runs
  `--no-optional-locks`). Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."
  **Standing caution (W.A): the execute-vector list is tied to which git
  commands the daemon runs — adding a new one means re-running the probe.**

## Changes review workspace (opened 2026-08-11; Kyle-directed)

**Product call.** The target user prefers the real terminal coding agent but
wants a more visual and functional interface than its native terminal UI. The
next feature is therefore a first-class, read-only review surface for the code
changing in the session: the existing Files view remains the answer to "what
exists in this workspace?"; Changes becomes the answer to "what differs from
Git HEAD, and what do I need to inspect?" This reopens only the diff-review
half of BUSINESS.md's former editing/diff-review non-goal. Mirafold still does
not become a code editor, and it never writes, accepts, rejects, reverts, or
attributes a working-tree change on the user's behalf.

**Original verified starting state (before CR.1)** → archived verbatim in
**PLAN-ARCHIVE.md, "Moved 2026-08-12 (Changes polish + branch closure)."**

**Honesty boundary.** The surface is named **Workspace changes** in its own
chrome and means exactly "this Git working tree versus HEAD." It must never say
"changes made by Claude/Codex/Gemini" because pre-existing edits, another
session, a terminal, or an external editor can share that tree. A Projects-style
session root groups nested repositories explicitly. Agent adapters, native
permission behavior, and how each agent edits files remain behaviorally
unchanged.

**Responsive contract (applies to every CR phase).** Desktop (>640px) opens a
wider Changes workspace beside the still-visible conversation; Files and
Changes share one auxiliary-workspace slot and are mutually exclusive, so the
UI never becomes Explorer + Changes + transcript. Mobile (≤640px) opens the
same data as a full-screen layer, one file at a time, with a vertical unified
diff, persistent back/file/change navigation, safe-area padding, ≥40px touch
targets, and no page-level horizontal overflow. Desktop and phone behavior are
both acceptance requirements, not a later responsive cleanup.

- [x] **CR.1–CR.14** — all done 2026-08-11/12 (shared file-view foundation +
  bounded `fs_changes`→`fs_change_set` query; the Changes workspace, desktop
  split + phone full-screen; conversational diffs; resumable review progress
  keyed to server-minted revision identity; ten bughunt repairs; branch
  security + test audits; terminal hunk navigation; resizable panel; gutter
  glyph; docked toolbar; select-hunk toggles; post-audit delta bughunt and
  audits). Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."
  **Standing note (CR.14):** hunk navigation's deferred scroll is redundant
  protection since CR.10's layout removed the blur-cancellation trigger —
  kept deliberately.

**WATCH ITEM (live):** one unattributed intermittent
full-ordered Tier-3 failure — observed 1-in-6 runs on 2026-08-12, failing
test unnamed (the first run's log was summary-filtered); every later run
keeps the complete TAP log, so the next occurrence names itself.
**2026-08-14 — it named itself, in CI:** PR #48's first Tier-2+3 run
failed exactly one test, **E2.4 "the Projects-root proof"**, a 30 s
`page.waitForSelector('.files-panel[role=dialog]')` TimeoutError at the
phone drill-in step (app.e2e.ts:2839). Same day the full suite passed
3× locally (the CS runs) with E2.4 green each time, so the 1-in-6-ish
intermittent read stands — now with a name and a stuck selector to
instrument. Not diagnosed or fixed this sitting (Phase CS's scope);
next occurrence: read whether the Files panel button was clicked but
the dialog never mounted, or the click itself was swallowed.

## Stylesheet decomposition (2026-08-12, Kyle-directed)

- [x] **Split the 5,639-line styles.css into an import spine + 15 surface
  files** — done 2026-08-12; pure relocation, proven byte-identical at the
  source and in the built bundle. Standing decisions: NO dedup/consolidation
  (small savings, real visual-regression risk), and NO phone-override
  colocation yet — it would dismantle the one-phone-block convention and is
  a separately-verified decision for later. → **PLAN-ARCHIVE.md, "Moved
  2026-08-12 (Changes polish + branch closure)."**

## Needs-you notifications (opened 2026-08-12; Kyle-directed)

**Product call.** The remote/away story is the product's spine — fleet view,
relay viewport, desktop app all assume the user steps away — yet every surface
so far answers "what's happening when I look?" and nothing answers "tell me
when I need to look." The next feature is OS-level notifications when a
session needs the user: a permission prompt appears, or a turn finishes. Scope
is the local tiers only (any open Mirafold page: local tab, desktop app, relay
viewport open on a phone — all the same Notification API code path). True
closed-browser Web Push (service worker + push service + E2E payload story) is
deliberately parked in Post-release ideas until the habit loop proves out.

**Triggers — exactly two, by design.** (1) A session enters `permission`;
(2) a session's turn ends (`busy`/`working` → `idle`). NOT per-tool chatter,
and NOT socket disconnects: a phone backgrounding its tab drops the socket
routinely, so a "disconnected" toast would train users to disable the feature.
Session-death notification waits until the wire carries a distinct exit signal.

**The suppression rule (most of the design).** A notification fires only for
state the user cannot already see: nothing fires while the firing tab is
visible (`document.visibilityState`), and gaining visibility closes every
toast that tab created. One notification per session (`tag` = session id), a
newer event replacing the older; a toast whose cause resolves elsewhere
(answered on another device, agent prompted from the terminal) closes itself
the moment the state moves on. Accepted v1 sharp edge: a hidden fleet tab can
toast about a session visible in another tab — same tag keeps it to one toast,
and cross-tab suppression is noted in Post-release ideas, not built.

**Trust boundary.** Notifications are shell-owned chrome: titles/bodies are
composed by the shell, and every engine-derived string (tool name, permission
detail) is carried as inert plain text into an OS surface that never
interprets markup. The preference is off by default; flipping it on is the
only thing that triggers the browser's permission prompt (never page load).
No secret ever enters a notification body — tool + detail are already
user-visible PermBar strings.

- [x] **NF.1 (engine + wiring) and NF.2 (settings + e2e) — BOTH COMPLETE
  2026-08-12**; full bodies → **PLAN-ARCHIVE.md, "Moved 2026-08-14 (post-SA
  prune — completed bodies)."** Standing gotcha kept from NF.2: tsx's esbuild
  keepNames injects a module-scope `__name` helper that Playwright serializes
  WITHOUT — init scripts / evaluated functions containing compiled classes or
  const-assigned arrows die on a ReferenceError, so in-page stubs are plain-JS
  strings (bit again in SA.1's e2e, 2026-08-14).

## File drag-and-drop input (opened 2026-08-12; Kyle-directed)

**Product call.** Kyle: take files in by drag and drop, like the terminal.
In a terminal that feature is mostly the TERMINAL EMULATOR's: dropping a
file inserts its shell-quoted path at the cursor, and the agent reads the
path with its own tools. A browser cannot do that — a drop hands over the
file's NAME and BYTES, never its real filesystem path — so Mirafold's
faithful equivalent is: catch the drop on shell-owned chrome, ship the
bytes to the daemon over the existing WebSocket in bounded chunks, stage
them in a per-session directory OUTSIDE the working tree (no tree
pollution — the terminal never copies into the repo either), and insert
the staged file's absolute path into the prompt. The agent then reads it
exactly as a terminal drop's path — zero adapter changes, agent-neutral by
construction, and the same mechanism makes drops work from a phone through
the relay, which a terminal cannot do at all. (Promoted from
POST-RELEASE.md's "Input augment" entry; clipboard PASTE of files/images
stays parked there.)

**Bounds.** Staging is `<random per-daemon mkdtemp root>/<sessionId>/` (0700, never a fixed name in shared tmp — 2026-08-26 audit);
v1 cleanup relies on the OS's tmp reaping (recorded decision — per-session
delete-on-end can ride later). Caps: `FILE_UPLOAD_MAX_BYTES` (10 MB
default, env), 2 concurrent uploads per connection, chunks bounded well
under `MAX_WS_PAYLOAD`, a 30s no-chunk stall reaper, sanitized basenames
(never a path), collision-suffixed. Uploads follow the prompt's relay
gate: refused on a remote viewport when the session's backend kind is not
`allowedOverRelay` — an upload is model input staging. Replies are
correlated per-viewport (echoed client-minted id, `CLIENT_ID_RE` grammar),
never broadcast, never replay-buffered. The drop overlay, progress strip,
and path insertion are shell-owned end to end; a staged path enters the
prompt via the existing draft-merge path, which never discards composed
text.

- [x] **FD.1 (wire + staging) and FD.2 (drop experience) — BOTH COMPLETE
  2026-08-12**; full bodies → **PLAN-ARCHIVE.md, "Moved 2026-08-14 (post-SA
  prune — completed bodies)."** Standing gotcha kept from FD.2: the drag
  listeners attach only after the session attaches — an e2e dispatch racing
  the mount fires into the void, so drop e2es wait for the session UI first.

## Paintings polish batch (opened + ✅ COMPLETE 2026-08-13; Kyle-directed)

- [x] **Fix batch + adoption instrumentation — completed 2026-08-13** (all
  tiers green). Full bodies → **PLAN-ARCHIVE.md, "Moved 2026-08-14 (post-SA
  prune — completed bodies)."** Standing decisions: **diagrams follow the app
  theme** (a diagram is a picture, not a code surface — the pinned-dark
  convention stays for code/console/diff only); one LOCAL
  `paint <component> agent=<agent>` log line at `registry.deliver()` makes
  paintings adoption measurable (nothing leaves the machine).
- Audit findings deliberately NOT fixed here (recorded, not lost): the two
  hand-kept `TOOL_DESCRIPTIONS` maps (render-tools.ts / render-mcp.ts) have
  drifted in wording with no guard test; no test pins Claude's
  `mcpServers`/`systemPrompt.append` registration; the stdio
  `emit_artifact` description omits the `mirafold.prompt/tool` sandbox API
  that the in-process description documents (Codex/Gemini can't author
  interactive artifacts); registry CSS half-lives in `08-picker.css`
  (housekeeping); HBar tooltip parks at `left: 40%`. Each is a candidate
  for a follow-up surfacing-parity step.

## Phase OC — OpenCode adapter (opened + ✅ COMPLETE 2026-08-13; Kyle-directed)

**Product call.** Kyle, from a 2026-08-13 market check: OpenCode (~195k
GitHub stars) is now the dominant open-source terminal agent and becomes the
fourth adapter. The feasibility spike is **`server/adapters/opencode.spike.md`**
(verdict GREEN) — its live-probe appendices remain the shape record.

- [x] **OC.0–OC.5 — ALL COMPLETE 2026-08-13**, live-verified same day
  (Kyle: "heyyyy it works"). Full step bodies → **PLAN-ARCHIVE.md, "Moved
  2026-08-14 (post-SA prune — completed bodies)."** Standing outcomes that
  bind future work:
  - **Raw HTTP+SSE transport, no SDK** (decision recorded in the spike doc:
    live shapes beat drifting generated types).
  - **Permission replies never send `always`** — that would persist approval
    state into the user's own OpenCode config (docs/ADAPTERS.md matrix).
  - **Zen OPENED by Kyle 2026-08-13** under the disclosed-uncertainty rule:
    `gateway` CredentialKind, local-only, NEVER relay-eligible, uncertainty +
    training-data disclosure shown (canonical row in provider-policy.ts).
  - The ChatGPT gray runs locally under its TRUE classified kind
    (`onBackendKind` → registry; `kindPending` refuses remote actions until
    verified).

## Gemini CLI support (sunset decision reversed 2026-08-14; Kyle-directed)

**Correction.** The 2026-08-13 deprecation rested on an inaccurate starting
claim: Google ended free/AI Pro/AI Ultra individual-account requests, not the
Gemini CLI itself. Google explicitly kept API-key and enterprise access
supported and the Apache-2.0 CLI maintained. Mirafold's adapter was never
removed and its API-key route is one of those retained paths, so Gemini CLI
remains supported. Phase **RF.1** removes the deprecation field, picker suffix,
session notice, future-removal item, and current-facing retirement copy. The
superseded decision body remains labeled as such in **PLAN-ARCHIVE.md**.

## Phase RC — Remote CREATE of OpenCode sessions (opened + ✅ COMPLETE 2026-08-13; Kyle-directed)

- [x] **RC.1–RC.4 — ALL COMPLETE 2026-08-13** (classify-before-create:
  `verifyBackendKind` seam + `attachOrReapClassified`, bounded 30s, races
  closed, 9 tests; a relay viewport can now CREATE an OpenCode session, not
  just attach). Full bodies → **PLAN-ARCHIVE.md, "Moved 2026-08-14 (post-SA
  prune — completed bodies)."** The seam is documented in docs/ADAPTERS.md.

## Phase SA — Subagent view (opened + ✅ COMPLETE 2026-08-14; Kyle-directed; plan signed off by Kyle, executed same day)

- [x] **SA.0–SA.4 + post-phase refactor, two bughunt rounds, security audit,
  and test-audit — ALL COMPLETE 2026-08-14**, full bodies → **PLAN-ARCHIVE.md,
  "Moved 2026-08-14 (post-SA prune — completed bodies)."** Shipped: live
  **subagent decks** (calm summary → expandable calls + narration), the
  parented-delta narration lane (opaque `parentId` on deltas + permission
  asks), and the OpenCode child-session mapping proving the lane
  agent-neutral — plus an OpenCode defect fix (child permission asks used to
  drop and hang). PR #47. The lane's standing rules for future adapters live
  in **docs/ADAPTERS.md §3**; the rendering/trust posture in
  **docs/ARCHITECTURE.md** and
  SECURITY.md; the decided vocabulary in GLOSSARY (*subagent deck*).

**The hard line (standing):** Mirafold DISPLAYS the agent's own coordination —
it never spawns or directs subagents itself (the homegrown-orchestrator trap).
*Mirafold shows coordination; it never performs it.*

**Deferred findings (recorded here so they're not lost):**
- **LATENT (bughunt 2026-08-14):** a `background: true` OpenCode child
  streaming ONE text part ACROSS a turn boundary would re-emit that part's
  full text (the per-turn part tracker resets, so the snapshot's suffix
  restarts at 0) — duplicated prose in its deck. Deferred because
  reachability is unconfirmed (requires the engine to spawn background
  children in stock config, itself unverified) AND a proper fix reopens the
  2026-08-13 flood-cap design (the part trackers are per-turn precisely to
  stay bounded); revisit if background children are ever observed live.
- **Test-audit deliberate skip (2026-08-14):** the deck component's
  replayed→no-elapsed wiring is pinned at the pure-function level only
  (`deckElapsedSeconds`); the one-line component wiring has no e2e of its
  own — a decision, not an oversight.
- **Codex subagents:** the engine HAS first-class multi-agent (collab,
  default-on since ~2026-02) but child inner activity needs app-server
  per-thread subscriptions — mapping deferred to **Phase F Step F.5**; the
  researched posture is recorded in docs/ADAPTERS.md's capability matrix.

## Phase RF — Pre-release findings closure (opened + ✅ COMPLETE 2026-08-14; Kyle-directed)

- [x] **RF.1–RF.3 complete 2026-08-14**, full body → **PLAN-ARCHIVE.md,
  "Moved 2026-08-14 (Phase RF — completed body)."** Gemini CLI remains a
  supported API-key adapter: the false deprecation field, picker suffix,
  session notice, future-removal item, and current-facing retirement claims
  are gone without changing its adapter behavior. OpenCode interruption now
  starts its grace deadline independently of the abort request; a missed idle
  forks context to a new session identity before the queue advances, with a
  bounded, disclosed fresh-session fallback. Focused tests and all release
  gates are green: Tier 1 **840/840**, Tier 2 **152/152**, typecheck, and Tier 3
  **100/100**.

## Phase CS — Self-serve subscription cancel (opened + ✅ COMPLETE 2026-08-14; Kyle-directed; plan signed off by Kyle)

**Why.** A Mirafold Pro customer who wants to stop paying currently has two
paths: the billing link in their Paddle receipt email, or emailing support —
i.e. Kyle, manually. This phase adds the third, first-class path: cancel (or
undo a cancel) from inside the product. Last feature before the next release
off `next` (Kyle, 2026-08-14).

**Decisions (all Kyle-signed 2026-08-14):**
- **Direct in-product cancel**, not a Paddle customer-portal link: the daemon
  calls new billing-backend endpoints with the license key as the bearer
  credential — the exact trust model `/api/entitlement` already uses. A
  portal deep-link was rejected: it would turn a leaked key into an
  authenticated door to a Paddle billing page (email, card, invoices),
  where the direct path exposes nothing but schedule-cancel/undo/status.
- **The license key stays the identity** (no accounts). Anyone holding a key
  can cancel its subscription — accepted: damage is capped at "doesn't
  renew" (end-of-period only, never lost paid time), it's undoable, and a
  leaked key already gives the strictly bigger prize (relay access billed
  to the victim).
- **End-of-period only, always** (`effective_from: next_billing_period`).
  One code path serves trial and paid alike: a `trialing` sub's next
  billing date IS the trial end, so cancel-in-trial = never charged, and
  cancel-while-paid = access through the paid period. Matches /terms and
  /refunds verbatim. No "cancel immediately" ever offered (no pro-rating
  exists, so it would only destroy paid access).
- **Undo ships too**: a scheduled cancellation is a pending
  `scheduled_change` on the Paddle subscription until the period boundary;
  `PATCH /subscriptions/{id} {scheduled_change: null}` removes it. The UI
  shows "cancellation scheduled for <date> — undo" for the whole window.
- **Placement: nothing cancel-shaped is ever passively visible.** A neutral
  "manage subscription" link inside the Connect-a-device card (the one
  place Pro already manifests) opens a subscription view — status line
  ("trial — first charge <date>" / "renews <date>"), and cancel as an
  action there, behind its own confirm step. Local viewports only (the
  card already is); shown only when the daemon runs on a license key —
  self-host, token-override, and unentitled daemons see nothing.

**Revocation needs no new work:** on cancel, status stays `trialing`/`active`
until the period ends; Paddle's `subscription.canceled` webhook then flips KV,
`/api/entitlement` starts refusing, and the ≤48 h token window does the rest —
exactly the promised behavior.

- [x] **CS.1–CS.4** — all done 2026-08-14 (three Pages Functions under
  `functions/api/subscription/`; `server/relay/subscription.ts` + the three
  additive client messages, `subscription` reply and `billing` hello flag;
  the manage-subscription view in ConnectDevice; PR #48 merged at `fe8a3cc`;
  Kyle drove the live cancel → scheduled → undo arc on his own subscription).
  Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)."
  **Still owed elsewhere (from CS.4's live finding):** the production Paddle
  key gained Subscriptions Write that day; the site repo's historical setup
  and rotation notes still describe it as read-only/claim-only and need a
  truth-sync before release documentation is considered closed.

## Phone workspace drawer (opened + ✅ COMPLETE 2026-08-18; Kyle-directed)

- [x] **One workspace toggle + unified drawer exit — completed 2026-08-18**
  (PR #52 → `next`; shipped in **v0.4.0**, 2026-08-19). Kyle's two asks: the
  status bar's side-by-side Files/Changes icons crowded a phone bar, and the
  two views exited differently (Files: top-right ×; Changes: top-left ‹).
  Landed: ONE `.sb-workspace` toggle (new `WorkspaceGlyph`) opens the
  full-screen drawer on the last-used view (Files until Changes is chosen);
  a **Files | Changes** switch (`WorkspaceTabs`, 40px targets) sits at the
  head of both panels in the title's place — the pattern VS Code web / GitHub
  mobile use (one place with sections); both views exit via the same leading
  ‹ at one x/y. Desktop untouched. Standing decisions: **no swipe-to-dismiss**
  (browser on a phone — never take over native gestures, Kyle 2026-08-18);
  the toggle is unreachable while the drawer is open (fixed, focus-trapped)
  so "toggle closes" is not a phone path — Esc/‹ are.
- Same PR, from the refactor/bughunt/audit/test-audit passes: the Changes head
  moved its count pill to row two (row one assumed a shrinkable title; the
  fixed-width switch collided with the pill at 320px) with icon buttons on
  row one; e2e geometry is read after the slide-in settles (`settled()`; a
  mid-transform boundingBox read 39.9999px and flaked ~50%); new 320px
  non-overlap + on-screen oracle `assertApartOnScreen` (e2e-harness), run in
  phone.e2e and on changes.e2e's 5-file fixture. Security audit: no findings
  (all new chrome renders literals only). Cold-reviewed ×3.
- Housekeeping the same night: `provider-policy.ts` Anthropic citations
  corrected (#53, comment-only); site rotation runbook truth-synced (Paddle key
  needs Subscriptions: Write); every stale branch deleted — only `main`/`next`
  remain; **v0.4.0 released** (12 PRs since 0.3.7; flow-b, verified).

## Phase LD — Live Document View (opened + ✅ COMPLETE 2026-08-19; Kyle-directed)

**Product call.** Mirafold's agent response becomes a live technical document:
Markdown, registry renders, and artifacts compose in one responsive visual
rhythm while they are still streaming. The daring direction is the default;
there is **no classic-transcript toggle, fallback view, or second rendering
path**. The complete approved specification is
**`docs/LIVE-DOCUMENT-VIEW.md`** and is normative for this phase.

**Current seam (verified 2026-08-19).** `createTranscriptProjection()` owns
wire-to-view chronology and exposes stable `TranscriptSnapshot.rows`;
`RenderZone` owns DOM presentation, pin state, and mediated actions. LD derives
ephemeral display groups from those projected visible rows. It does not rescan
wire messages, persist nested responses, or move transcript meaning back into
the renderer. Assistant text/render/artifact rows are document-eligible; user
and bang rows are hard response boundaries; thinking, tools/folds, notices,
pickers, and subagent decks are soft interruptions that remain top-level shell
or provider-faithful UI. Visual unity does not require absorbing them into
agent prose.

**Behavior boundary.** No intended change to protocol, content semantics,
actions, replay, pin identity, registry schemas, production adapters, or shell
capabilities. Presentation and layout change intentionally. Stable React keys
alone are insufficient: later streaming may not change an already-mounted
painting's ancestry. The visual treatment comes from measure, typography,
rhythm, and alignment; prose is transparent by default, not one bordered card
per streaming chunk. Rich content gets a wider lane than prose. There is no new
dependency.

This is an oversized feature: the Phase spans four passes, and each Step below
is one complete single-pass `$next` chunk.

- [x] **Step LD.1 — Structural composition, visually neutral** — complete
  2026-08-19 on `feature/live-document-view`. Pure projected-row grouping,
  stable document ancestry, the transparent wrapper, deterministic streaming
  fixture, and direct DOM-identity proof are in place. No protocol or registry
  source changed; all four existing visual baselines are unchanged. Verified:
  Tier 1 **865/865**, typecheck, build, Tier 2 **152/152**, Tier 3 **105/105**,
  browser matrix **3/3**, visual suite **4/4**, and `git diff --check`. Full
  original Step body → **PLAN-ARCHIVE.md, “Moved 2026-08-19 (Phase LD —
  completed Step LD.1 body).”**

- [x] **Step LD.2 — Opinionated document treatment** — complete 2026-08-19
  on `feature/live-document-view`. Kyle approved the complete-screen result:
  a left-anchored 1160px rich lane, 76ch transparent prose lane, restrained
  technical-document typography, and a chevron-only user command strip whose
  neutral top/bottom outline fades toward the right. There is no `YOU` label,
  chat bubble, outer response card, theme fork, or second rendering path.
  Verified: Tier 1 **866/866**, typecheck, build, Tier 2 **152/152**, Tier 3
  **106/106**, browser matrix **3/3**, visual suite **6/6**, and
  `git diff --check`. Full original Step body → **PLAN-ARCHIVE.md, “Moved
  2026-08-19 (Phase LD — completed Step LD.2 body).”**

- [x] **Step LD.3 — Workspace and phone responsiveness** — complete
  2026-08-19 on `feature/live-document-view`. Existing `min-width: 0` and
  fluid-center contracts already handled center-only, Explorer, file view,
  pin dock, both sides, 980px three-pane, and 390px phone geometry without a
  container query. Complete-screen review found one real usability gap:
  contained charts scaled their 640-unit SVG until labels became unreadable.
  Charts now keep a 600px readable canvas and own keyboard-reachable local
  horizontal overflow across Chromium, Firefox, and WebKit.
  Deterministic browser coverage proves table/code/diff/chart/artifact
  containment, panel width restoration, manual scroll preservation,
  streaming tail-follow, phone full-width layout, shell/touch continuity, and
  response DOM identity through the full-screen phone Explorer. No protocol,
  registry schema, production adapter, dependency, alternate renderer, or
  phone breakpoint changed. Verified: Tier 1 **866/866**, typecheck, build,
  Tier 2 **152/152**, Tier 3 **108/108**, browser matrix **3/3**, visual suite
  **6/6**, and `git diff --check`. One earlier final-state Tier 3 attempt was
  **107/108** when the existing CR.2 phone test timed out waiting for a file
  view; it then passed **3/3** focused with no changes and the unchanged full
  rerun passed **108/108**. Full
  original Step body → **PLAN-ARCHIVE.md, “Moved 2026-08-19 (Phase LD —
  completed Step LD.3 body).”**

- [x] **Step LD.4 — Restraint and regression closure** — complete 2026-08-19
  on `feature/live-document-view`. Complete-screen dark/light review and a new
  deterministic giant, heading-free, text-only turn found no decoration or
  excess spacing worth removing from Kyle's approved treatment. Direct browser
  proof now covers render/artifact immediacy, long URL/filename/code
  containment, reduced motion, selection and prompt focus, capped
  announcements, unchanged DOM/geometry through all seven themes, and axe.
  Existing full-suite cases cover render/tool-heavy turns, pin/unpin,
  update-in-place, replay, errors, notices, pickers, subagents, keyboard/tail
  scrolling, and phone. No protocol, registry schema, production adapter,
  dependency, classic toggle, or second renderer changed. Verified: Tier 1
  **867/867**, typecheck, build, Tier 2 **152/152**, Tier 3 **109/109**, browser
  matrix **3/3**, visual suite **6/6**, and `git diff --check`; the two UI
  constituents remain the literal local gate instead of the known combined
  wrapper. Full original Step body → **PLAN-ARCHIVE.md, “Moved 2026-08-19
  (Phase LD — completed Step LD.4 body).”**

## Phase IH — Input history navigation (complete 2026-08-20)

- [x] **Steps IH.1–IH.3 — Submitted-input navigation** — complete on
  `feature/prompt-navigation`. Desktop command strips now carry direct,
  always-visible older/newer arrows; an empty prompt's ArrowUp enters at the
  newest input, selected strips own ArrowUp/ArrowDown/Escape, and live provider
  pickers retain priority. Phone hides strip arrows and discloses a temporary
  `⋯` card immediately above submit without adding layout height; permission,
  live shell-input, and upload strips temporarily own that shared space. Both
  paths preserve the unsent draft, never wrap, include ordinary prompts and
  `!` commands only, and detach explicit jumps from tail-following. No wire,
  server, adapter, response grouping, prompt-send rule, or dependency changed.
  The final refactor keeps pure chronology in `input-navigation.ts`, DOM
  selection/scroll mechanics in `use-input-navigation.ts`, and both responsive
  control surfaces in `components/InputNavigation.tsx`. Same-day correctness
  review closed every proven interaction defect across browser-clamped tail
  ownership, both no-motion End paths, repeated activation, desktop/phone
  replay focus, sequential phone focus, selected versus page-wide Escape,
  phone touch/hardware-keyboard ownership, live-turn endpoint focus, and live
  provider-picker key arbitration, plus phone modal/workspace focus layering.
  The regressions pin those sibling paths.
- [ ] **IH.F — a load-sensitive Tier-3 flake (test-audit 2026-08-30, open).**
  `input-navigation.e2e.ts` "phone discloses temporary navigation directly
  above the submit arrow" failed once in a full `yarn test:e2e` run at the
  assertion "endpoint premise did not leave phone focus on the body"
  (`document.activeElement === document.body` after the older-arrow reached
  its endpoint), then passed 3/3 in isolation (13 s each) with no code
  change between runs. Nothing in the run touched that surface (the run was
  the cockpit-panel feature + audit). Unfixed here because it is not the
  feature's test and the failure was not reproduced; the next owner should
  characterize it under load (`--test-concurrency=1` is already set, so the
  pressure is the machine, not parallel tests) before changing either the
  test or `use-input-navigation.ts`. A flake that stays teaches the team to
  ignore red — fix or root-cause it, don't retry it.
  The review also aligned the live-tail documentation and made the replay test
  remove its own temporary session directory.
  Verified before the final phone focus-layer correction: focused model/tail
  units **7/7**, typecheck, guarded client/server build, dotenv-safe Tier 1
  **818/818** across 87 files (three deliberate
  dotenv-fixture files excluded), dotenv-safe Tier 2 **139/139** (the deliberate
  dotenv-fixture integration file excluded), focused browser regressions
  **4/4**, full Tier 3 **114/114**, browser matrix **3/3**, visual suite
  **6/6**, inspected 900×600 desktop and 390×844 phone renders, and
  `git diff --check`. The settled correction then passed typecheck, builds,
  focused units **7/7**, and feature Chrome **4/4**. The final Tier 1 runner
  defect was diagnosed and closed 2026-08-20: the shared Codex/Gemini
  `jsonRpcOneShot` lifecycle handled child-process errors but not errors from
  the child's stdin pipe, so a child closing that pipe during the initial
  request emitted an unhandled `EPIPE` and terminated the whole test-file
  process with exit 1. A process-isolated regression proved the old crash; the
  stdin error now follows the existing settle-once rejection path. Final
  dotenv-opaque closure passed the focused JSON-RPC/model-list set **14/14**,
  Tier 1 **819/819** across 88 safe files, typecheck, both production builds,
  Tier 2 **139/139**, and freshly built Tier 3 **114/114**. A 2026-08-20
  security audit of the complete branch delta found no submitted-input-
  navigation finding and closed one hardening issue in the touched one-shot
  helper: Codex/Gemini catalog stdout now has a cumulative 1 MB ceiling instead
  of relying on time alone. The old source retained a 1,000,001-byte
  unterminated stream until timeout; post-fix one byte over is refused, an
  exactly-at-limit JSON reply succeeds, and the shared focused set passes
  **16/16**. Current registry advisories are zero across 467 locked packages;
  lock integrity, TypeScript, both builds, package allowlist, and focused
  navigation units also pass.

  The 2026-08-20 feature test audit repeated the unchanged dotenv-opaque
  baselines three times: Tier 1 **817/817**, Tier 2 **139/139**, and the full UI
  matrix plus visuals **9/9** each time. Tier 3 was **114/114**, **113/114**,
  then **114/114**; the sole failure was the untouched CR.2 phone file-review
  timeout. That is the same full-suite-only failure recorded 2026-08-19, so it
  is active recurrent Changes-suite debt, not a future-if-repeated concern; it
  passed **6/6** focused repetitions and the final full run without a proved
  cause or any CR.2 edit. Three credential-stripped Tier 4 repetitions passed
  the Codex local-model cases **3/3** with its one hosted-credential case
  skipped, and OpenCode **1/1**.

  Seventeen one-at-a-time mutations ultimately exposed seven real test gaps:
  later-row viewport equality; component-scale arrow visibility; `!`-row
  integration; live-shell and upload anchor suppression; real-DOM non-tail
  phone viewport selection; and single-arrow visibility in both dark and light
  themes. The cold review caught the final two classes after the first repairs.
  Tests now cover all seven: the phone fixture proves the coordinate path in
  response space, and two inspected 59×29 enabled-arrow crops compare 1,711
  pixels with zero allowed difference. Every repaired test failed against its
  matching mutation, including independent dark-older and light-newer arrow
  disappearance. No product source changed in the test audit. Final typecheck,
  safe Tier 1 **817/817**, feature Chrome **5/5**, targeted visuals **7/7**,
  freshly built Tier 3 **115/115**, and combined UI/visual **10/10** pass; the
  three unchanged Tier 2 **139/139** baselines remain applicable. One broad
  sanitized-mirror Tier 1 command accidentally included four synthetic
  dotenv-fixture test sources. No real dotenv file was present and no secret
  was exposed, but that run violated the opacity rule and is discarded; only
  the explicitly enumerated 87-file safe run counts. Full original Phase body
  → **PLAN-ARCHIVE.md, “Moved 2026-08-19 (Phase IH — completed body).”**

## Three phases from Kyle's 2026-08-25 usage notes (Kyle-directed; each opens ONLY on his express request naming it)

Kyle used Mirafold for a day and brought back nine findings. Investigated
2026-08-25 (three code sweeps, findings recorded per phase below); every
decision was settled with him the same day. Recommended order: **CX → TR →
CA** (smallest first; CX's paragraph also stops an agent misattributing
Codex's sandbox to "a Mirafold session policy"). Each phase is one branch
off fresh `next`, one PR, merged before the next is cut.

## Phase CX — Agent context + the silent bang (opened + ✅ COMPLETE 2026-08-25; Kyle-directed; PR `feature/agent-context-silent-bang` → `next`)

- [x] **Step CX.1 — Tell the agent where it is** — done 2026-08-25:
  `MIRAFOLD_CONTEXT` opens `RENDER_GUIDANCE` under "## Where you are"; Tier-1
  proves the paragraph reaches Claude's `systemPrompt.append` and the
  first-turn prepend of Codex, Gemini and OpenCode. Live check (the
  "what environment am I in?" turn) is Kyle's to run.
  - Finding: the only environment text any engine receives is one sentence
    in `RENDER_GUIDANCE` ("Your output renders in a web app…"). No name, no
    "not a terminal". Agents assume a terminal/desktop and say so.
  - Goal: every engine knows it is inside Mirafold, a browser app, without
    spending context on anything more (Kyle: ~40 words, nothing about the
    surfaces).
  - Build: append one paragraph to `RENDER_GUIDANCE` (agent-neutral — Claude
    gets it via `systemPrompt.append`, Codex/Gemini/OpenCode via the
    first-turn prepend, all already wired): *"You are running inside
    Mirafold, a browser app that re-skins this coding agent. The user reads
    your output in a web page (sometimes on a phone), not in a terminal, a
    desktop app, or an IDE — don't refer them to a terminal, Ctrl-C, or
    'open in your editor.'"*
  - Files: `server/render-tools.ts`; Tier-1 test that the paragraph reaches
    each adapter's injection point (`claude-code.test.ts` system prompt
    append, `RenderGuidanceOnce` carry for the other three).
  - Done when: Tier-1 proves all four adapters carry it; a live turn
    (Kyle-run) asking "what environment am I in?" names Mirafold and not a
    terminal.

- [x] **Step CX.2 — `!!` runs a command with no agent turn** — done 2026-08-25:
  additive `silent?: true` on `bang` and `bang_start`; the handler skips the
  context accumulator, `markModelTurnStarted` and `pushPrompt` for a silent
  bang (cwd handoff and the 400 ms gate unchanged); `!!` glyph on the row,
  tightened to the `!` column, with a hover title saying the agent never
  sees it. Proven: Tier-1 (projection row, bus frame), Tier-2
  (`bang.itest.ts`: flag on start + replay, output flows, no turn for 1.5 s
  while the mock answers every prompt, `cd` carries into a following `!`
  that DOES turn), Tier-3 (`app.e2e.ts`: `!!echo` strip + output, nothing
  follows the block, no activity line). Full suites green: Tier-1 924,
  Tier-2 153, Tier-3 116.
  - Finding: `!` (the bang line) runs in a PTY and then pushes the transcript
    to the agent as its own model turn (`bang-handlers.ts`) — faithful to
    Claude Code's terminal `!`. There is no way to just use the shell.
  - Decisions (Kyle, 2026-08-25): `!` stays exactly as it is (fidelity);
    `!!` = same PTY path, same broadcast/replay to every viewport (shell-
    owned, not secret), same `cd` persistence and jail, same 400 ms
    throttle, and **the agent never sees it — not even as later context.**
  - Build: additive only. `bang` client message gains `silent?: true`;
    `bang_start` gains `silent?: true` so every viewport and the replay ring
    draw the row right; `bang-handlers.ts` skips `markModelTurnStarted` and
    `pushPrompt` when silent (no false-busy window, no queued-follow-up slot
    consumed); `Shell.tsx`'s intercept becomes `^!(!?)\s*(.+)$`; the bang
    row shows a `!!` glyph. Prompt completions unchanged.
  - Files: `server/protocol.ts`, `server/sessions/bang-handlers.ts`,
    `web/src/components/Shell.tsx`, `OutputZone.tsx` (bang row),
    `transcript-projection.ts`, `styles/06-tools.css`; tests: Tier-2
    `bang.itest.ts` (silent → the session's `pushPrompt` is never called,
    output still broadcast + replayed, cwd persists across `!!` then `!`),
    Tier-1 projection, Tier-3 e2e (`!!echo hi` → `!!` row with output, the
    activity line never starts, the mock received no prompt).
  - Done when: the e2e proves a `!!` command runs, shows, replays, and the
    mock adapter's prompt log stays empty.

## Phase TR — Transcript readability (opened + ✅ COMPLETE 2026-08-25; Kyle-directed; PR `feature/transcript-readability` → `next`)

Findings (2026-08-25 sweep): per-call bodies are always collapsed except on
error (`ToolBlock.tsx`); the higher-level fold ("worked · N actions",
`tool-visibility.ts`) already exists but forms only after `turn_end`, only
for runs of ≥2 successful calls, and any prose between two calls splits the
run — so a narrating agent produces a one-by-one parade forever. A manual
expand is lost when a row reflows into the fold (remount). There is no
jump-to-bottom affordance (only the `End` key with the scroller focused).
Prose code fences render as a bare `<pre>` with no copy button while
`render_code` has a header strip + `CopyButton`. Folder rows carry a folder
glyph beside the chevron.

- [x] **Step TR.1 — The fold forms live, absorbs short narration, keeps
  the user's expands** — done 2026-08-25: `groupToolActivity` (was
  `groupSettledTools`) folds on *finished + successful* rather than settled,
  so the fold grows mid-turn ("working · N actions", gear pulsing) with the
  in-flight call as its own row beneath, and relabels "worked" at
  `turn_end`; short assistant remarks (≤ 2 lines, ≤ 160 chars —
  `isShortNarration`) are absorbed like interior thinking and replayed inside
  the fold as inert plain text; tool disclosure is lifted into `OutputZone`
  (`toolToggles`, the `expandedThinking` pattern) so a hand-expanded call
  stays expanded after it moves into the fold. Mock `tool-activity` gained a
  remark + a deliberately slow third call; `shell-effects.e2e.ts` asserts
  the live fold, the running row, the survive-the-move expand, and the
  absorbed remark. Tier-1 929, Tier-3 116 green.
  - Decisions (Kyle): fold **during** the turn — "working · N actions"
    growing, only the in-flight call shown beneath it as its own row;
    flips to "worked · N actions" at turn end. Narration of **≤ 2 lines**
    between calls is absorbed into the fold (shown inside, in order, like
    interior thinking); a longer paragraph stays visible and ends the run.
    Failed/interrupted calls stay outside and open, as today. A manual
    expand survives the reflow.
  - Build: `tool-visibility.ts` relaxes the `settled` requirement to
    "finished + successful" for live folding with the running call as the
    trailing boundary; short-text absorption beside thinking absorption;
    tool disclosure state lifted into `OutputZone` keyed by tool id (the
    `expandedThinking` pattern). Fold label by turn state.
  - Files: `web/src/tool-visibility.ts` (+test), `transcript-projection.ts`
    (+test), `components/OutputZone.tsx`, `ToolBlock.tsx`; mock scenario
    `tool-activity` gains a one-line narration between calls and a longer
    paragraph; `server/testing/shell-effects.e2e.ts`.
  - Done when: e2e shows, mid-turn, one growing `.tool-activity-group` with
    only the running call outside it; the short narration is inside the
    fold and the paragraph outside; a click-expanded call is still expanded
    after `turn_end`; the failing call still stands alone, open.

- [x] **Step TR.2 — Jump to latest** — done 2026-08-25: `useFollowTail`
  mirrors `following` into render state (`detached`) and gains
  `jumpToTail()`; the `↓` pill is a sibling of the scroller inside a new
  `.transcript-column` wrapper — deliberately OUTSIDE the scroll flow (a
  sticky child was scrolled "into view" by focus/automation, which re-armed
  following and hid it mid-tap) — bottom-right on desktop, bottom-center and
  40 px on the phone, fades in/out, hidden from the tab order and a11y tree
  while at the tail; click = arm + scroll + focus the prompt. New
  `follow-tail.e2e.ts` (desktop + phone: appears only in scrollback,
  placement, click/tap returns to the tail, sending a prompt hides it). The
  two live-document visual baselines were regenerated: that snapshot scrolls
  to the top, so the pill now legitimately shows in it.
  - Decision (Kyle): a small round pill with a single `↓`, bottom-right of
    the transcript scroller inside `.zone-row`, ~12 px above the scroller's
    bottom edge (above the activity line / prompt box, out of the 76ch
    reading column); bottom-center on the phone. Visible only while
    follow-tail is detached; fades out on reaching the bottom or sending a
    prompt. Click = what `End` does (`armFollow` + scroll). No count, no
    label; `aria-label="Jump to latest"`.
  - Build: `use-follow-tail.ts` surfaces `following` as render state;
    the pill component; CSS in `01-frame.css`.
  - Files: `web/src/use-follow-tail.ts` (+test), `components/OutputZone.tsx`,
    `styles/01-frame.css`; e2e in `document.e2e.ts` or a new
    `follow-tail.e2e.ts`.
  - Done when: e2e — scroll up during a streaming mock turn → pill visible;
    click → at bottom, following, pill gone; never visible while at bottom;
    phone viewport places it bottom-center.

- [x] **Step TR.3 — Prose code fences get `render_code`'s header strip** —
  done 2026-08-25: `CodeHead` extracted from `registry/Code.tsx` and shared;
  `mdOverrides.pre` (`FencedCode` in `Md.tsx`) wraps every fence in
  `.markdown-fence.rc-code` — the painting's box, the same head (language
  from the highlight class, else "code"; `CopyButton` with the verbatim
  text) over `pre.rc-code-body` — deliberately not `.rc`, so a fence never
  counts as a painting. Tier-1 (`Md.test.ts`: head + copy + body class, bare
  fence, inline code untouched, `fenceLanguage`/`nodeText`), Tier-3
  (`app.e2e.ts`: the live-document fence shows `ts`, highlighting intact,
  copy → "copied" and the clipboard holds the fence verbatim). Both
  live-document visual baselines regenerated again for the new look.
  - Decision (Kyle, "option 2"): a fenced code block the agent types in
    prose renders with the same header strip as the `render_code` painting
    — language on the left (when the fence names one), `copy` on the right
    — so the two ways of showing code are one object.
  - Build: a `pre` override in `registry/Md.tsx` (today it overrides only
    `a`/`code`/`table`/`li`) that wraps the highlighted `<code>` in the
    shared head from `registry/Code.tsx` (extract the head into a small
    shared component; `CopyButton` copies the raw fence text). Applies
    wherever `Md` renders — turn prose and card text alike.
  - Files: `web/src/registry/Md.tsx`, `registry/Code.tsx`,
    `registry/CopyButton.tsx`, `styles/05-transcript.css` /
    `07-registry.css`; a mock scenario turn containing a fence; e2e.
  - Done when: e2e — a fenced block in a mock turn shows the head with the
    language and a `copy` that flips to `copied`; `render_code` unchanged.

- [x] **Step TR.4 — No folder icon on folder rows** — done 2026-08-25:
  directory rows and the root row render `FolderTreeNodeSpacer` (the empty
  14 px icon column) in place of the folder glyph; the chevron is the folder.
  The `folder`/`folder-open` glyph kinds and the `open` prop are gone from
  `FolderTreeNodeGlyph` (leaves only). `app.e2e.ts` asserts chevron → spacer
  → name on the root both open and closed, zero folder glyphs, and that a
  dir name and a file name at the same depth share one x.
  - Decision (Kyle): drop the folder glyph from directory rows and the root
    row; keep the rotating chevron; files keep their icons; keep an empty
    spacer where the glyph was so names align in one column.
  - Files: `components/folder-tree/FolderTreeRows.tsx`,
    `FolderTreePanel.tsx` (root row), `styles/02-folder-tree.css`; e2e.
  - Done when: e2e — no `.folder-tree-node-icon-folder` /
    `-folder-open` in the tree; a dir name and a file name at the same
    depth share the same x.

## Phase CA — Codex on app-server: terminal-equal permissions (opened + ✅ COMPLETE 2026-08-25; Kyle-directed; PR `feature/codex-app-server` → `next`; hosted acceptance is Kyle-run)

**Finding (verified 2026-08-25).** Mirafold passes Codex **no** sandbox or
approval settings (`codex.ts` leaves `sandboxMode`/`approvalPolicy` unset
on purpose) and never writes `~/.codex/config.toml`; the `.git`-is-read-only
rule Kyle hit is Codex's own workspace-write sandbox, identical in the
terminal. The real mismatch: the adapter drives Codex through
`@openai/codex-sdk`, which spawns **`codex exec`** — Codex's
*non-interactive* mode. In the terminal, with `approval_policy =
"on-request"`, a sandbox block (writing `.git` on commit, network, a path
outside the workspace) makes Codex **ask** "retry outside the sandbox?";
under `exec` nobody can be asked (`resolvePermission` is a no-op, the SDK
has no approval callback), so the command fails and the model improvises —
which is why Kyle ended up hand-editing `config.toml`. Codex is the only
adapter without a working approval round-trip. **Target (Kyle): no
difference for the user between Codex in the terminal and Codex in
Mirafold.** The fix is Codex's `app-server` JSON-RPC protocol — what its
own TUI and the VS Code extension use — whose approval requests map onto
the existing `permission_request` / `permission_resolved` messages and the
permission bar. `app-server` is already spawned for the model and skills
catalogs (`codex-model-list.ts`, `codex-skills-list.ts`).

- [x] **Step CA.1 — The spike (throwaway, time-boxed)** — done 2026-08-25:
  findings in `server/adapters/codex.spike.md`, "CA.1 spike". Verdict GREEN:
  observed approval round trips for an out-of-workspace write (declined →
  denied) and a network call (accepted → re-ran outside the sandbox);
  `thread/resume`, `turn/interrupt`, and `developerInstructions` all work.
  The "read-only" Kyle hit is `codex exec`'s failure mode (a bare
  `read-only file system` error, nobody to ask); `.git` is not read-only in
  0.149.1 on either path. One trust finding for CA.3: headless Codex (exec
  AND app-server, even ephemeral) writes `trust_level = "trusted"` for the
  cwd into `~/.codex/config.toml` with no dialog — Mirafold must ask first.
  - Goal: watch the protocol do what the docs say before any product code.
  - Build: drive `codex app-server` by hand from a scratch folder against
    the installed `codex-cli` (0.149.1 today): initialize; new thread + one
    turn; the full event stream (item shapes vs the exec-JSON ones the
    mapper knows); an approval request when the sandbox blocks a `git
    commit`, a network call, and an out-of-workspace write — and what
    answering approve/deny does; thread resume; the first-open "trust this
    folder?" dialog (surfaced, or client-owned?); how the `-c` config
    overrides and `model_provider` binding ride along. Record all of it,
    including the no-go list, in `server/adapters/codex.spike.md`.
  - Done when: the spike doc records a real observed approval round trip
    (a sandboxed commit produced a request; approving it made it succeed)
    and names every place terminal-equal behavior is or isn't reachable.

- [x] **Step CA.2 — The transport** — done 2026-08-25: `codex-app-server.ts`
  (long-lived newline JSON-RPC client over stdio: our requests, the
  engine's notifications, and the engine's own requests to us, kept apart
  by shape) replaces `@openai/codex-sdk` (dependency REMOVED); `codex.ts`
  spawns lazily on the first turn, `initialize` → `thread/start` (with
  `developerInstructions` = RENDER_GUIDANCE + the deferred-tools addendum —
  a real instructions hook at last) or `thread/resume` by id, `turn/start`
  per prompt with `model`/`effort` as per-turn params (a `/model` or
  `/effort` pick no longer restarts anything), `turn/interrupt` for stop; a
  dead process is respawned and the thread resumed by id on the next
  prompt. `codex-events.ts` maps the v2 `item/*` stream: prose streams as
  deltas (held only from a code fence on, so a hand-written mermaid chart
  still becomes the chart component), reasoning deltas, `commandExecution`
  (declined → error row "(declined)"), `fileChange`, `mcpToolCall`
  (`structuredContent`), `webSearch`, `turn/plan/updated` → checklist,
  `thread/tokenUsage/updated` → one `usage` per turn (delta of totals),
  `error`(willRetry)/`warning` → badged notices. The rollout-file model
  lookup is gone — `thread/start` answers with the model. API-key picks pass
  `-c forced_login_method="api"` (CA.1: app-server otherwise prefers
  auth.json). Approvals are DECLINED fail-closed until CA.3. Fixed en route:
  `configArgs` wrote arrays as `args.0=` (rejected by the binary) — arrays
  now encode whole. `codex.test.ts` rewritten on an in-memory fake
  app-server (59 tests); live smoke against the real binary: streamed prose,
  model from thread/start, resume id, a declined out-of-workspace write.
  Tier-1 935, Tier-2 153 green.
  - **Fix 2026-08-25 (Kyle screenshot, still on this branch):** app-server
    marks ANY nonzero exit `status:"failed"` (the exec path said
    "completed"), so grep-no-match / `gh repo view` on a missing repo /
    a failing test each rendered as an EXPANDED red error that broke the
    fold. Faithful rule now matches the TUI: a command that RAN (has an exit
    code) is non-error and foldable, exit code annotated; only a no-exit-code
    failure or a decline is an error. Proven live + three unit tests
    (incl. the screenshot's exact shape). Tier-1 941.
  - Build: `codex-app-server.ts` — a JSON-RPC-over-stdio client (the
    `jsonrpc-oneshot.ts` patterns, made long-lived) replacing the SDK spawn
    in `codex-binding.ts` / `codex.ts`; same config overrides and provider
    binding; `codex-events.ts` adapted to the app-server item stream;
    resume preserved. Dependency call recorded: whether `@openai/codex-sdk`
    still earns its place or is removed.
  - Done when: Tier-2 `codex.test.ts` green on the new transport with a
    scripted app-server stub; interrupt, resume, `/model`, `/effort` intact.

- [x] **Step CA.3 — The approval round trip** — done 2026-08-25: a
  `PermissionLedger` (the shared one the other adapters use) turns each
  `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`
  / `item/permissions/requestApproval` into a `permission_request` on the
  shell's bar — the command stated plainly, the engine's own `reason` (the
  "retry outside the sandbox?" escalation) alongside it; the bar's answer
  maps to `{decision:"accept"|"decline"}` / the granted permission profile.
  Fail-closed on every path (timeout, close, dead process → decline). ALSO
  the folder-trust gate (assigned here by the CA.1 spike): the first turn in
  a folder Mirafold has no record of asks before anything spawns — `Codex`
  tool, wording that says a yes records the folder as trusted in
  `~/.codex/config.toml` — and only on a yes does `thread/start` run (so the
  config write is consented, or never happens); remembered in
  `workspace-trust.ts`, the same mechanism Gemini uses. Tier-2 (unit): the
  three-way approval round trip, a timeout decline, and the trust gate
  (asked/spawns-only-on-yes/records; denied → refusal notice, nothing
  spawned, config untouched; pre-trusted → no ask). Live smoke: approving a
  real out-of-workspace write made the command RUN (the file was written),
  where CA.2 fail-closed left it nonexistent. Tier-1 940, Tier-2 153 green.
  - Build: app-server approval requests → `permission_request` (tool +
    detail, with the "retry outside the sandbox" meaning stated in the
    shell's own words, engine words badged with `source`); the permission
    bar's answer → the protocol's approve/deny; a `PermissionLedger` like
    the other adapters; answers already sync across viewports.
  - Done when: Tier-2 proves request → bar → answer → command proceeds or
    is denied, and a denied request never runs.

- [x] **Step CA.4 — Fidelity acceptance** — automated live DONE 2026-08-25;
  hosted "feels like the terminal" judgment is Kyle's. `codex-live.ltest.ts`
  (Tier-4, real binary) updated to the app-server transport and green: a real
  Ollama turn streams text through the new stack with one turn_end and the
  `/effort none` control; the pinned first-party catalog still holds; an
  unreachable endpoint now surfaces Codex's own "Reconnecting… (willRetry)"
  as retry notices and the discovered-local watchdog ends it (app-server
  retries a connection failure forever, exactly as the TUI does — a hosted
  blip shows the same notices and interrupt is the out). Beyond the suite,
  three live smokes against the real binary during CA.2/CA.3 proved: streamed
  prose + model-from-thread/start + resume id; a DECLINED out-of-workspace
  write never ran; an APPROVED one did (the file was written). **Left for
  Kyle:** a hosted session (subscription/api-key) doing real sandboxed work —
  commit, a network call — and confirming the approve/deny prompts feel like
  Codex in the terminal. That can't be automated (Tier-4 forbids metered
  models).
  - `codex-live.ltest.ts`: in a workspace-write sandbox, the agent commits
    → Mirafold prompts → approve → the commit lands; deny → it doesn't;
    `~/.codex/config.toml` byte-identical before and after (never written);
    a relay viewport answers the same prompt. Kyle's verdict that it feels
    like the terminal is the bar.

---

## Phase PN — Panes (file views beside the transcript)

**ON HOLD — do not build file panes for now (Kyle, 2026-08-25).** This phase
is NOT a `/next` candidate: skip PN.2 and PN.3 when picking the next step, and
do not continue or merge `feature/file-panes` (that branch was started by
mistake). Phase TP below depends on this pane frame, so it is on hold too.
The phase stays written down only so the design is not lost; Kyle lifts the
hold explicitly when he wants it.

**Why.** Kyle (2026-07-26): open a file and see it in its own pane. Also the
structural prerequisite for TP — pane content must be a self-contained
component from day one so a terminal can slot into the same frame later.
Scope is deliberately modest: **one pane region beside the transcript on
desktop, tabs within it** — NOT a VS Code-style divisible split grid (can
grow later without rework if PN.1's seam is respected). Phone keeps the
existing drill-in unchanged — no panes at phone widths.

**Current seam:** CR.1 extracted the independent read/diff request lifecycle
and CR.2 proved it in both Files and Changes. PN.2 can therefore start at the
pane frame itself; multiple simultaneous panes still mean one controller
instance per viewer.

- [x] **Step PN.1 — FileView extraction (behavior-preserving)** — completed by
  CR.1 on 2026-08-11. `use-file-view.ts` owns independent selection,
  read/diff correlation, loading/stale state, and reset lifecycle; Files and
  Changes are its first two hosts. Full record → **PLAN-ARCHIVE.md, “Moved
  2026-08-11 (Changes review foundation — CR.1).”**

- [ ] **Step PN.2 — the pane frame**
  - Goal: "open in pane" from the explorer puts the file in a tabbed pane
    beside the transcript; open/close/switch/focus all keyboard-clean.
  - Build: a desktop pane region (claims the split-pane layout slot Phase E's
    charter reserved); explorer rows gain open-in-pane (default click
    behavior decided here — Kyle's call at build time); tabs with close;
    focus management per Phase A discipline (focus moves into the pane on
    open, returns sensibly on close; axe-clean).
  - Done when: in headless Chrome, opening two files yields two tabs; tab
    switch, close, and keyboard traversal all pass; phone width shows no
    pane affordance and drill-in is untouched.

- [ ] **Step PN.3 — live panes**
  - Goal: open file views stay honest under disk change — the read-only
    payoff (nothing to conflict, always safe to reload).
  - Build: on `fs_changed`, open views refetch — using the paths hint to
    skip irrelevant bells when present, refetching all open views when
    absent; diff views refetch both sides; scroll position preserved on
    identical-prefix content (best effort).
  - Done when: e2e — with a file open in a pane, the harness rewrites it on
    disk; the pane shows the new content within ~1 s, no clicks; an
    unrelated file's change (hint present) causes no refetch of that pane.

## Phase TP — Terminal pane (vim on the desktop; promoted from POST-RELEASE.md)

**ON HOLD with Phase PN (Kyle, 2026-08-25)** — TP slots into PN's pane
frame, so it is not a `/next` candidate until the PN hold is lifted.

The POST-RELEASE "Embedded terminal pane" intake entry (2026-07-22),
promoted 2026-07-26. Its settled scope carries over verbatim: a real
terminal box inside the session (tmux-style pane via PN's frame, not a
window) where curses programs run, so `!vim`/`!top` just works instead of
garbling through the ANSI-stripped Tier-1 stream; **viewport-local, not
session-shared** (the keystroke stream ties to the one viewport that opened
it — never fanned out, never in the replay ring; the first stream that opts
out of broadcast/replay, so it's designed deliberately); the *work* stays
session-bound (same cwd/files; the agent is handed the resulting **diff** on
exit, never keystrokes); auto-open on alternate-screen entry (`\x1b[?1049h`),
collapse on exit. The PTY substrate already exists (`server/pty/pty.ts`,
`xterm-256color`, stdin flows); the deltas are a raw un-stripped output path
beside `cleanPtyOutput`, `resize` on `BangProc`, additive wire messages
(raw bytes base64; resize; keystrokes), and an xterm.js pane.

**LOCKED harder than the intake entry (Kyle, 2026-07-26): LOCAL viewports
only, enforced in the daemon, fail-closed.** Not merely "the phone doesn't
show the button": the daemon **refuses terminal messages on any
relay-attached viewport** — same shape as the no-subscription-over-relay
absolute bound. This kills both remote-shell exposure and relay keystroke
latency by construction. Corollary security work is TP.1 and comes FIRST.

**New dependency at this phase:** xterm.js (the standard browser terminal
emulator — deep-spec surface, clear take-the-dependency verdict). Cost:
a few hundred KB of bundle, loaded only on desktop viewports (lazy-load with
the pane). `node-pty` is already a dependency — no new native code.

**Shared decision with Phase KB (standing note carried from the intake):**
once keystrokes can reach the prompt, an app shortcut, or the vim pane, the
modal key-routing (which context owns a key) is settled once, by whichever
of KB/TP ships first, and reused by the other.

*(Steps below are coarser than house standard — TP is furthest out; split
each into prompt-sized pieces when the phase actually opens.)*

- [ ] **Step TP.1 — the local-only gate + socket-auth verification**
  - Goal: the security substrate before any PTY byte flows: terminal
    messages hard-refused for relay viewports, and the local WebSocket's
    protection against drive-by browser connections re-verified (any webpage
    can open a WebSocket to localhost — the socket's origin/auth check is
    the only wall, and it must gate the connection BEFORE a terminal can
    exist).
  - Done when: hostile-client Tier-2 tests prove a relay-attached viewport's
    terminal messages are refused with a typed close/error, and a
    wrong-origin local dial can never reach a terminal path.
- [ ] **Step TP.2 — raw PTY path + wire messages** (base64 raw output beside
  `cleanPtyOutput`, `resize`, keystroke routing — add, never reshape).
- [ ] **Step TP.3 — the xterm.js pane in PN's frame** (auto-open on
  alternate-screen, collapse on exit, focus/modal routing per the KB-shared
  decision).
- [ ] **Step TP.4 — vim acceptance, end-to-end** — e2e: open vim in the
  pane, edit, `:wq`; W's bell fires; the tree and any open pane view update
  with no clicks; `top` renders and exits clean; a phone viewport never
  sees the affordance and a relay viewport's attempt is refused (TP.1 pin
  re-run in the full flow).

---

## Phase SG — The Mirafold signature, shell side (opened 2026-07-27; adopts what the consumer app defines)

Origin: an outside design critique (2026-07-27) Kyle brought in and agreed
with in substance — the current visual language is competent and clean but
not distinctive: crop the logo from a screenshot and nothing says Mirafold.
The fix is a **signature** — a small rule set for how Mirafold-authored UI
looks and assembles (motion grammar, geometry, construction). The consumer
app is the surface where it matters most (consumers judge on feel; shared
screenshots are that product's growth loop), so the signature is DEFINED
there — a design sitting with Kyle producing a written spec, `SIGNATURE.md`
(`../mirafold-chat/PLAN.md` Phase 6) — and ADOPTED here afterward. This
phase is that adoption. It gates nothing in Phase R and no launch step.

*Amendment (2026-07-27, later the same day): a second, independent review —
a true target consumer shown dev-product screenshots — judged the
cross-product identity ALREADY coherent and retracted the "lacks identity"
concern. This phase's role is unchanged (adopt the motion grammar at quiet
amplitude once the spec exists), but its urgency is lower than the origin
paragraph implies: the surviving critique is that the CONSUMER demos should
sell the transformation rather than the result, which lands in the consumer
repo and in demo/video selection, not here.*

Two bounds, both structural:

- **Mirafold-authored surfaces ONLY.** The signature applies to the
  registry components the render tools paint and to shell-owned chrome
  where Mirafold itself speaks. The terminal-parity surfaces are EXEMPT on
  principle: the faithful-skin rule (a core requirement) makes matching the
  real agent the spec there, and no brand language may compete with it.
- **Quiet amplitude here.** The spec carries an intensity dial: the
  consumer app runs it full; this repo runs the same grammar at the quiet
  setting — developers in a work loop read added motion as added latency.
  Same identity, lower volume.

What the signature is NOT: not a theme change (all seven themes and every
locked theme decision stand untouched — the signature is motion + geometry +
construction, orthogonal to palette), not new chrome, and never a
`prefers-reduced-motion` violation.

Consistency mechanism: the renderer here and the consumer app's renderer
are deliberate copies, not a shared package (that repo's copied-not-shared
rule, which stands). Consistency rides the SPEC — `SIGNATURE.md` is
authored in the consumer repo and a dated copy is hand-kept here, the same
convention as the relay contract mirror — and a signature change touches
both repos in the same sitting.

- [ ] **Step SG.1 — Adopt the spec** *(blocked until the consumer app's
  signature sitting produces it)*: bring the dated `SIGNATURE.md` copy in;
  apply the grammar to the registry components' entrances/assembly and
  construction at the spec's quiet-amplitude setting.
- [ ] **Step SG.2 — Verify nothing else moved:** terminal-parity surfaces
  provably untouched (existing fidelity e2e re-run), the reduced-motion
  kill still total, all seven themes unaffected, full Tier-1/2/3 green.
- Done when: a generated component here and the same component in the
  consumer app read as one family at a glance, the parity surfaces are
  demonstrably unchanged, and Kyle has looked at both and said so.

---

## Phase PF — Performance pass (opened + ✅ COMPLETE 2026-07-27)

One sitting, on `main` (commit `9626219`), from a streaming-hot-path map of
the whole daemon→browser pipeline. All Tier-1 + Tier-2 green (435 + 132),
typecheck clean; key guards mutation-tested (coalescer flush and
concatenation each broken → exact pinning tests failed → restored).

- [x] **PF.1–PF.3** — server-side delta coalescing (`DELTA_COALESCE_MS`
  33 ms, `0` = passthrough; wire untouched); client render batching +
  memoization; onboarding poll TTLs (`MIRAFOLD_LOCAL_PROBE_TTL_MS`).
  Bodies → PLAN-ARCHIVE.md, "Moved 2026-08-17 (prune — completed step bodies)." Standing choices: `Artifact` deliberately NOT
  memoized (per-render closure props touch the sandbox bridge);
  `bang_output` deliberately NOT coalesced (own id + wire-budget logic);
  eyes-open tradeoff — a just-started local model server takes up to ~8 s
  to appear in onboarding (was ~3 s).
- Deferred, not forgotten (contract-sensitive, own sitting, both suites):
  `permessage-deflate` on the sockets, slow-viewport backpressure
  (`bufferedAmount` is checked nowhere), and batching the attach-replay's
  per-message sealing on the relay path.

## Guidance tuning — the prose exit ramp (✅ 2026-07-27)

One `RENDER_GUIDANCE` bullet (`server/render-tools.ts`, `9330ded`):
markdown is connective tissue — find and render the answer's structured
core. Measured 0/2 → 2/3 renders on the recipe probe with no
over-rendering; ported to mirafold-chat the same day. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

## Closed from the 2026-07-27 security audit (three repos, checked against
## a "pre-launch checklist" post Kyle brought in)

**Shipped that day** (each landed with a break-the-guard-watch-it-fail
test): relay `new URL` crash guard · daemon exact-origin WebSocket check ·
credential scrubber on both log sinks · site cross-site guard, `no-store`
and `HEAD /api/health` · daemon `connect-src` narrowed · malformed
`MIRAFOLD_RELAY_URL` refused at boot. Deploy state 2026-07-28: the relay
guards went LIVE (Fly v9, verified against the live host); site fixes ship
on push; daemon fixes ride the next package release. **Standing gotcha:
the relay does NOT auto-deploy — `deploy.yml` is `workflow_dispatch`
only, so relay code sitting on `main` is not live until someone
dispatches it.** Full record → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

### ✅ RESOLVED 2026-07-28 — the `relay.e2e.ts` test 3 flake

A hardcoded frame-count threshold was load-sensitive under delta
coalescing (more merging under load → fewer frames → spurious fail);
replaced with growth-during-the-turn — ≥2 frames across the tap, which
coalescing can never merge away. Deterministic under single-core CPU
pinning; mutation-tested. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

### ✅ REDONE 2026-07-28 — per-session prompt gate, keyed on the turn grammar

All three model-driving paths enter one seam, `registry.dispatchPrompt`;
the gate clears on the same terminal events that flip status idle — no
timer. One mid-turn queued follow-up is allowed (terminal parity; the
agents queue typed-mid-turn input); anything past it is refused to the
offending viewport only, never broadcast. Pinned + mutation-tested in
`hostile-client.itest.ts`. History incl. the reverted first attempt →
PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

### ✅ The three ranked items — ALL RESOLVED 2026-07-28

Relay caps lowered to launch scale + send-side backpressure
(`RELAY_MAX_BUFFERED_BYTES`) + a byte-rate cap, pinned + mutation-tested
and deployed as Fly v10 the same day; the pairing id's exposure measured
honestly (a rendezvous id, not a bearer secret — decrypts nothing, and no
proxy logging on the happy path, verified live against Fly); stale
`mirafold-relay/dist/` deleted with a `prestart` build so a local run
can't execute months-old code. Full record → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."
The pairing-id standing policy survives here verbatim:

   **Standing policy (Kyle, 2026-07-28): opportunistic, never dedicated.**
   A from-scratch design would carry the id in `Sec-WebSocket-Protocol`
   (the one header-like channel a browser WebSocket can set — custom
   headers aren't available to page JS), and at design time that costs
   nothing. As a retrofit it buys nothing until the tail of old daemons
   and cached phone bundles dies off — the relay must keep accepting
   URL-borne ids through the whole transition window — so it must never
   be scheduled on its own. **Do it as a passenger on the next breaking
   change to the daemon↔relay dial-in contract** (a protocol version
   bump, compression negotiation, whatever breaks it first): fold the
   id-to-subprotocol move in and retire the URL form with that same
   compat window. Three things reopen it as urgent on its own: (1)
   evidence of ids reaching logs on the happy path — a platform change,
   or any hosting migration (the "error-lines-only" verdict is
   Fly-specific; re-measure on a new host); (2) pairing ids ever becoming
   longer-lived or reusable than per-launch; (3) slot-squatting observed
   as a real abuse pattern rather than a theoretical one. The deeper
   posture stands regardless: the system's robustness is that id
   exposure is harmless by construction (E2E keys derive from the code
   the relay never sees; ids die on daemon restart) — hiding the id
   better is defense-in-depth on a denial-only vector.

### ✅ 2026-07-28 — the refusal reason is VISIBLE on the phone (Kyle's call)

A relay refusal's why reached the phone only as a hover tooltip;
`.sb-conn-note` is now a visible warn-colored line beside the dot, shown
only when down WITH a known reason. E2e-pinned, mutation-tested, live on
the remote path same day. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

### ✅ 2026-07-28 — permission answers sync across viewports (Kyle's phone bug)

Nothing on the wire announced a permission's resolution, so a second
device kept showing a stale bar (and taps on it were silent no-ops). Fix:
additive **`permission_resolved { id, allow }`** broadcast from every
resolution path — adapters that emit `permission_request` MUST emit it
(protocol.ts) — with the registry holding `permission` status until
nothing is pending. Pinned in all three tiers, mutation-tested; replay
carries request→resolved so a reload can't repaint a stale bar. Full
diagnosis → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

## Closed from the 2026-08-26 security audit (the `main…next` delta, 58 commits)

Audited on the `polish` working tree; fixes landed there uncommitted, each
with a break-the-guard test, cold-reviewed in two batches. Three of the
findings were already closed by the `polish` work in progress (Codex Stop
inert during app-server startup; the `!!` `silent` flag missing from the
checkpoint decoder — one `!!` made a session unrecoverable after a restart;
the Gemini auth stub written before the trust ask). What the audit added:

- **A checkout's `.env` can no longer disable or pin the auth token** —
  `.env.example` shipped a bare `MIRAFOLD_TOKEN=` and `cp .env.example .env`
  turned auth off. `MIRAFOLD_TOKEN` left `PROJECT_ENV_KEYS`; the example
  documents it as parent-environment-only. (`project-env.test.ts`)
- **A connection whose session was evicted OR ended loses its handle**
  (`refused` / `session_ended`), and `!`, `bang_input`, plus an allowing
  `permission_response` now carry the drive-time relay gate that
  `prompt`/acts/uploads had — the 2026-08-13 fix had missed those paths and
  treated eviction as a stream detach only; a stale handle after `end()`
  could spawn an invisible PTY (cold review). (`fleet-acts.test.ts`)
- **Every Gemini project write opens `O_NOFOLLOW`** (the invalid-JSON backup
  exclusively) and `.gemini` must be a real directory — the first cut
  guarded two paths and the cold review routed the repo's own bytes through
  a symlink planted under the backup's name. `/model` sits behind the trust
  ask (it spawns Gemini in the folder). Ask text says "sets its auth type"
  honestly. (`gemini-cli.test.ts`)
- **The registry admits nothing the checkpoint decoder would refuse**
  (`admitForCheckpoint`, judged by the store's own schemas): an overlong id,
  a `NaN`/float/negative token count, an array `tool_use.input`, an
  over-long catalog, an undecodable prompt-catalog entry — each used to
  checkpoint fine and make the whole session unrestorable at the next start
  (two cold-review rounds widened this from "ids" to the class). Coerced
  where a legitimate reading exists, dropped otherwise; one round-trip test
  over the hostile shapes pins it. One render-id grammar
  (`RENDER_ID_GRAMMAR`) is enforced on the in-process server, the stdio
  stub's ack, and `renderIdFor`, and told to the model.
- Hardening, all pinned: Codex `item/permissions/requestApproval` states the
  grant (`describePermissionProfile`); the Codex trust ask says Codex "may"
  record trust (the config.toml write did not reproduce on codex-cli 0.149.1
  under a fresh `CODEX_HOME`); checkpoint `nextSeq` regained its
  bound with headroom (`MAX_NEXT_SEQ` = 2^48 — the safe-integer edge itself
  pinned the stream after one message); `IDLE_STATE` frozen; release
  workflow pins `npm@11.19.0`; `PermissionLedger`
  settles exactly once structurally; `permission_request` tool/detail capped
  (never scrubbed — the detail is what the user approves); `reduceTurn`
  returns `prev` on a no-op frame (one Shell re-render per frame, gone).

Nothing deferred. Left for Kyle: review + commit on `polish`.

## Closed from the 2026-08-26 whole-project security audit

Six reviewers over the full tree (network entry, filesystem/process paths,
adapters, relay/crypto, web/sandbox, repo/CI/supply chain), each finding
proven by probe; fixes landed uncommitted on `polish` in three batches, each
cold-reviewed and the reviews' own findings fixed. Exploitable-now:

- **Every engine now asks "trust this folder?" before its first spawn** —
  a hostile checkout's `.claude/settings.json` hook, `.mcp.json` server and
  `opencode.json` MCP command all ran at session start with no prompt
  (probed). Claude Code and OpenCode gained the gate Gemini/Codex had
  (`workspace-trust.ts` scopes; lazy engine start; slash commands ask too).
- **A checkout's `.env` configures the agent, never the daemon** — three
  lines redirected the license-key exchange and the relay to a hostile host
  and pinned the pairing code (probed). Relay/entitlement/app-URL/local-
  endpoint keys are operator-environment only.
- **The repo-program guard's three bypasses closed** (`=` in a filter name,
  submodule config, oversized config failing open): env-pair
  neutralization, `--ignore-submodules=dirty`, fail-closed scan, and `git`
  itself through the trusted-executable lookup. Pinned in
  `git-trust.itest.ts`.
- **An artifact can no longer seize keyboard focus** (probed: typed prompt
  landed in the artifact) — focus enters a frame only on the user's gesture;
  otherwise the artifact is blanked like a navigation. e2e-pinned.

Ship-time: uploads stage under a random owner-only root with exclusive
no-follow writes; the git-trust notice never echoes repo-chosen text; the
daemon's own credentials never enter an engine child (`DAEMON_ONLY_ENV`);
the release workflow verifies the tag's SSH signature against
`.github/allowed_signers` and publishes from a job that runs no install
scripts; app.mirafold.com gets the shell CSP via `web/public/_headers` +
a `<meta>` policy (it had none); permission asks render bidi/invisible
controls visibly; a `#code=` pairing is remembered only after its
handshake succeeds.

Hardening: log lines neutralized for control bytes and written 0600/0700;
trust record realpath-only and exclusive; image reads O_NOFOLLOW; a restored
"discovered" endpoint must be loopback; stdio render props validated
server-side with the strict schema; license key never in the log; handshake
nonce length checked; link-group href refine never throws; pin dock has a
boundary; frame ingress guard; ICE/preconnect side channel disclosed.

**Left for Kyle (GitHub settings, not code):** add a tag ruleset for `v*`
requiring signed tags, and drop the admin "always" bypass on `main` (or
require a PR) — see the session recap for the exact clicks. Review + commit
on `polish`; then a patch release (findings 2–4 of the delta audit and the
engine gate are live in 0.5.0).

## Test-audit pass (2026-08-26) — the whole suite

Baseline: Tier-1 998/998 ×3 (~22 s); Tier-2 156/156 ×3 idle, 155/154/156
under load (~4 min); Tier-3 120/121 then 121/121 (~7.3 min); UI gate 10/10
(68 s). 110 product mutations (three reviewers in worktrees + the
coordinator), 104 caught. Repaired, each re-falsified:

- **Proven worthless → repaired:** `file-upload.itest` "nothing staged from a
  dead upload" (computed the DAEMON's staging dir in the test process — a
  dir that never existed); `workspace-trust.test` duplicate-row claim asserted
  on a Set; `git.test` rename framing survived the exact bug it names (now
  pins the record count); `Console.test` hardcoded a private cap copy.
- **Wrong thing → repaired:** `Artifact.test` pinned one CSP directive (now
  the exact policy); `ws.test` "stored only after the handshake" tested the
  helper, not the wiring (now drives `finishOpen`); adoption test now checks
  `paired-at`; `codex.test` "config.toml never touched" now asserted with an
  isolated `CODEX_HOME`; `csp.test` "aligned with the daemon's" now compares
  against `server/index.ts`'s directives.
- **Fragile → repaired:** `session.itest` seq-monotonic (excludes the
  deliberately unsequenced `prompt_options`) and interrupt (no TURN content
  after `turn_end`, not an exact frame count); `codex.test` trust tests
  try/finally (a red run sat on the 5-min trust timer) + `CODEX_HOME`
  isolation in `capturedSpawn`; `fleet-acts` stale-handle tests kill a
  regressed PTY instead of hanging the run, and never `cat ~/.ssh/id_rsa`;
  `hostile-client.itest` pins `MAX_WS_PAYLOAD`; `session-store.test` clears
  both Anthropic credentials; `git-trust.itest` restores borrowed env.
- **Weak → tightened:** exact `DETAIL_CAP`; byte accounting via
  `Buffer.byteLength`; "idle clears" now leaves idle first; `session.itest`
  artifact pinned to the mock's known html; `codex.test` waits go through
  `wait-for.ts` (named, seen-list); the diagnosable `waitTurnIdle` moved
  into `e2e-harness.ts` for every e2e file.
- **Proven gaps → added, watched to fail under mutation:**
  `security/bind.itest.ts` (the daemon is unreachable on the LAN address —
  `0.0.0.0` passed every tier before); `auth.itest.ts` (the AUTH DISABLED
  boot warning); `log.test.ts` (log file 0600); `Md.test.ts` (raw HTML inert,
  hostile image sources get no src).
- Fixture hygiene: the one real handle in a fixture replaced.

**Follow-up the same day (Kyle: "do 2 through 5, and 1 if you recommend
it"):**
- *Real-clock coalescing test* → `t.mock.timers` (tick 4 holds, tick 1
  flushes); re-falsified. Doing it exposed that a RED assertion in
  `registry.test.ts` hung the whole Tier-1 run (the test's own `reg.end`
  never ran, the open mock session kept the process alive) — a file-level
  `after()` now ends every helper-made session.
- *`app.e2e.ts` shared-session design* → the 16 tests that depended on a
  neighbor's state (a spoken turn, a leftover artifact, `.fleet-row.first()`,
  "back into a session created earlier", "the previous turn must be over")
  run in `withFreshMockSession` with their own preconditions; `eventually`
  / `awaitIdle` take the page explicitly. Two shapes now, documented at the
  top of the file: shared page for "a session exists", fresh session for
  anything that depends on session STATE. 53/53, 157 s alone.
- *`diff-panel.e2e.ts:751` phone flake* → characterized, NOT reproduced:
  8/8 whole-file runs idle (46–51 s each), on top of 3/3 + 3/3 focused on
  record and two green full runs this session; the only two occurrences
  ever were inside full Tier-3 runs (08-19, 08-20). No cause named, so no
  fix; the wait now dumps a screenshot, the page's state (dialogs, file
  rows, panel/view HTML) and the daemon log tail to
  `MIRAFOLD_FLAKE_DUMP_DIR ?? os.tmpdir()` and names the path in the error,
  so the next occurrence carries its evidence.
- *The two wiring tests* → added: `PermissionBar.test.ts` (an ask's tool AND
  detail route through `visibleControls`; the modal-card branch needs state
  and is uncovered) and `PinDock.test.ts` (React server rendering rethrows
  through error boundaries — probed — so it walks the element tree: one
  `RenderBoundary` per pinned painting, the block its direct child, the
  dock's own fallback). Both re-falsified (five mutations).
- *Cold review of the batch* (fresh agent) → fixed the same sitting: the
  shared "agent picker → full mock turn" test now leaves its session IDLE
  (`awaitIdle`) — without it the next shared-page prompt was a coin flip
  between "sent idle" and "queued mid-turn", a new order dependency the
  conversion had created; the tool_use/permission announcer test renamed to
  what it asserts (it never set up the "assertive interrupts polite"
  scenario its title claimed); the dangling 2026-07-30 instrumentation
  comment removed and the shared daemon's `MIRAFOLD_DEBUG` rationale
  rewritten; `RenderBoundary`'s CATCH now pinned DOM-free in
  `RenderBlock.test.ts` (derived error state → fallback; clean → child;
  re-falsified twice); the CR.2 flake dump now also records the socket
  state, page errors, and — new debug-only lines in `fs-handlers.ts`
  (`fs_read` receipt / `fs_file` reply, console under `MIRAFOLD_DEBUG`,
  never the log file; probed) — whether the read reached the daemon, with
  the diff-panel daemon started in debug for that reason.
- *The `registry.test.ts` re-pins* → recommended AGAINST, so left alone:
  they carry provenance (M.1, the 2026-07-24/28 bugs) and most exercise
  registry-only paths (`answerPermission`, `summary()` copies, `askedAt`
  aging, `dispatchPrompt`); the three near-duplicates of `session-state.test`
  cost ~40 lines. "Never delete a regression fixture" applies.
**Suite health:** Tier-2's `session.itest` was the load-sensitive spot
(fixed above); Tier-3's one flake in two runs was `follow-tail` (hardened
twice before — on the proposed list).

## Phase PB — The pair button is always there (Kyle-directed, opened + ✅ COMPLETE 2026-08-26)

Before: a daemon with no relay configured rendered no pair button at all, so a
new user never learned remote access existed. Now every LOCAL viewport draws
`⧉ pair`; without a relay the card states why (additive hello field
`relayOff`: `unentitled` | `opt-out` | `malformed-url`) — a plain link to
`https://mirafold.com/pay` when nothing is configured (plus the
`MIRAFOLD_LICENSE_KEY` line for an existing subscriber), the setting to change
otherwise, never a sales pitch to someone who opted out. Remote viewports
still receive neither field (a paired phone is not upsold). The link is an
ordinary `<a target="_blank" rel="noopener noreferrer">`, nothing scripted.

- [x] **PB.1** — `relayOff` on the hello (local only), `ConnectDevice`
  always-present button + `RemoteAccessOff` card, CSS, README line. Tests:
  `ConnectDevice.test.ts` (Tier 1), `session.itest`/`relay-service.itest`
  hello assertions (Tier 2), "no relay: the pair button is still there…"
  in `app.e2e.ts` incl. axe (Tier 3); two visual baselines re-taken for the
  new status-bar button. Done 2026-08-26 on `feature/pair-upsell`.
- [x] **PB.2 — present on the key's validity.** The daemon already validates
  the key (the entitlement exchange: token = valid, 403 = refused); the read
  now reaches LOCAL viewports as an additive `entitlement` message (after each
  hello and on every change — boot, the 12-hourly refresh, a lapse): `valid`
  → the QR as before; `invalid` → no QR, the backend's refusal quoted, the
  `/pay` link, the manage link kept; `unreachable` → no claim either way: the
  QR stays only while a cached unexpired token still carries the relay (with
  a dim "couldn't re-check" line), otherwise "couldn't reach mirafold.com",
  no sales link; `checking` → the first second after launch. Remote
  viewports never receive it (`entitlement.itest`). Tests: `entitlement.test`
  (read + listeners + cap), `ConnectDevice.test` (gate + card), `entitlement.itest`
  (local gets it, phone doesn't, key never on the wire), `app.e2e` "PB.2: a
  refused license key…" incl. axe; the CS e2e stub now answers the exchange
  as a valid subscriber and asserts the QR. Done 2026-08-26.
- [x] **PB.R — cold review of the branch (`/code-review next high`, 2026-08-26).**
  Nine confirmed findings, all fixed with a test per class: a stale read
  surviving a hello from a relaunched daemon without a key (kept only while
  `billing: "license-key"`, and the daemon now re-sends the read after EVERY
  hello); a non-string 403 `reason` throwing a refusal into `unreachable`;
  the no-relay arm dropping a subscriber's only manage link (the link now
  rides every resting arm — `PairCardBody`, pure); the at-rest tooltip
  pitching Pro to an opted-out user (`pairTitle`); `unreachable.cached`
  never flipping at token expiry (an expiry timer); presenting on the
  exchange against an ungated self-hosted relay hid a working QR (reads sent
  only where the exchange IS the gate: hosted default or an explicit
  entitlement URL — `presentsOnEntitlement`); the backend's refusal quoted
  mid-sentence above a payment link without bidi isolation
  (`visibleControls` + `unicode-bidi: isolate`, the manage card's line too);
  listener dispatch inside the exchange's try/catch; the R.4h turn still
  pinning `turn[0]` while the grammar turn didn't (one helper, plus a
  per-turn re-emit guard). Cleanups folded in: one `MAX_REASON_CHARS`, one
  `EntitlementView`/`RelayOffReason` in protocol.ts, escaped regexes, stale
  comments. Left as noted, not fixed: the fake billing server is hand-rolled
  in four tests (a helper is a test-harness change, out of this pass); the
  residual gap that the card presents on the exchange, not the relay dial —
  a paired/refused relay state is a step of its own (PB.3, Kyle's call).
  **Second cold review of the fixes** found five more, all fixed: the
  stale-read keep-rule was keyed to `billing`, which the self-host rule had
  just decoupled from the read → the read now rides ON the hello (additive
  `agents.entitlement`) and nothing carries over between hellos; a 403 with
  a non-object body (`null`) still threw into `unreachable`; the expiry timer
  overflowed past ~24.8 days (chained hops, clock re-checked); the bidi rule
  sat on `<div>`s (already isolated) instead of the inline `<q>` — now
  `.pair-quote`, asserted by computed style in the e2e.

## Phase CP — In-session cockpit panel (opened + ✅ COMPLETE 2026-08-30; Kyle-directed)

**Goal.** Move between live sessions without detouring through `/`: a compact,
scrollable cockpit panel in the session workbench's left activity rail. It is
about 60% of Changes' 370px minimum width, stays open across session
navigation/reload until the user closes or replaces it, and leaves FleetView's
layout and metadata-only watcher traffic unchanged.

**Verified starting state (2026-08-30).** `Shell` has one auxiliary slot with
only Files and Changes; no cockpit panel component or activity-bar control
exists. `FleetView` already owns sessionId-addressed stop/end/prompt acts and
`watch_sessions` snapshots, but those snapshots carry metadata only — no
transcript tail. The requested preview is new additive wire work, not a fix to
an existing panel.

- [x] **CP.1 — opt-in transcript tails.** Add an optional request flag and
  optional bounded plain-text tail to the existing `watch_sessions` /
  `sessions` path. Derive it from the registry replay ring, update preview
  watchers as visible transcript text moves, omit empty tails, and never send
  a relay watcher text from a session whose credential cannot ride the paid
  relay. Existing FleetView watchers keep their current metadata-only traffic.
- [x] **CP.2 — compact persistent panel.** Add a third desktop activity-bar
  control and a roughly 222px panel containing only session name, id,
  two-click stop/end controls, a down-chevron transcript disclosure, and a
  right-chevron quick-prompt disclosure. The list scrolls; the current session
  is identified; session links navigate directly; the open preference survives
  the navigation and disappears only on an explicit close/replacement action.
  Files/Changes remain mutually exclusive in the same auxiliary slot and their
  phone drawer stays unchanged.
- [x] **CP.3 — prove the seam and the workflow.** Protocol/unit coverage pins
  the additive shapes, tail cap/derivation/copy behavior, watcher opt-in, live
  updates, and the relay omission. Tier 2 observes the real socket path. Tier 3
  opens the panel, expands a live tail, prompts/stops/ends through it, switches
  sessions with the panel still open, verifies explicit close persistence and
  compact geometry, and runs the accessibility/side-scroll gates.
- [x] **CP.H — post-feature bughunt (2026-08-30).** Four confirmed findings,
  all fixed with a regression and no deferrals: Stop now remains available
  during permission holds and a whole-session interrupt cancels both model and
  active PTY work (while the Bang bar's PTY-only stop keeps its existing
  handoff); transcript tails now retain bang completion (`done`, `killed`, or
  exit code) and tool-result source-elision counts; an absent optional tail is
  described as an unavailable preview rather than falsely claiming an empty
  transcript; and an independently refused supplemental Cockpit socket shows
  its relay refusal reason without disturbing the primary session socket. The
  browser regression's fake socket is an anonymous object/Proxy so
  Playwright's serialized init callback does not depend on esbuild's
  module-scoped `__name` helper.
- [x] **CP.A — post-feature security audit (2026-08-30).** One finding,
  fixed with regressions and two cold reviews, nothing deferred: a
  pending-kind session (OpenCode before its first turn) refused a remote
  cockpit its tail while active, but its idle-unloaded checkpoint recorded
  the hello-time guess as fact, so the dormant row sent the tail over the
  relay while a remote attach to the same record was still refused. Root
  cause: a dormant record of an adapter that classifies at engine start
  holds no CURRENT credential verdict — revival re-arms `kindPending` and
  re-classifies (the resumed engine may pick a subscription or the Zen
  gateway). Fix (final form after the PR #77 review, below):
  `dormantKindPending(backend)` in adapters/index.ts, consumed by the
  dormant row through the same `relayGateRefusal()` the active row and the
  attach path use — one verdict per record; the local cockpit is unaffected.
  Revival now goes through the registry's `makeSession` seam, so tests
  never construct a real engine session. `dormant-relay-verdict.test.ts`
  pins active/dormant/restored-from-disk through the real remote
  connection, the warm api-key (sends) vs subscription (refuses) siblings,
  and truthful-at-create records (claude-code api-key sends, subscription
  refuses, the API-free mock never gated). Checked and clean: tail content
  (plain text, inert labels for paintings, bidi controls made visible,
  surrogate-safe 1,200-unit cap, ring-bounded walk), watcher fan-out cost
  (≤10 snapshots/s, one serialization per watcher variant, remote
  connections under `MAX_REMOTE_VIEWPORTS`), Esc in the `!` bar (busy is
  never set by bang frames), no dependency/workflow/secret changes.
- [x] **CP.T — mutation-based test audit (2026-08-30).** 17 mutations across
  all three tiers (tail cap/truncation/surrogate, remote gate at two layers,
  watcher wake rules, PTY cancel vs. Bang-bar handoff in Tier 2, error-socket
  stack, storage clear, bidi escaper, two e2e mutations against rebuilt
  dist) — every one caught. Nothing repaired or deleted; one pre-existing
  Tier-3 flake recorded as IH.F.
- [x] **CP.R — PR #77 automated review (2026-08-30).** Three Codex findings,
  all verified real and fixed with a regression each, none dismissed:
  **P1** the first CP.A fix stored a `kindPending` flag in the checkpoint,
  which is stale by design for a classifying adapter (revival re-classifies)
  — flag removed, rule moved to `dormantKindPending()` (above); the same
  push fixed a machine-dependent test of mine that revived a live OpenCode
  record (fails on a runner without OpenCode installed). **P2** a `!` PTY
  running beside a model turn was read as idle the moment `turn_end`
  arrived (a quiet `sleep 30` emits nothing to re-assert `working`), hiding
  Stop in the cockpit and FleetView while shell work ran — the reducer now
  carries `bangActive` into the composite status (`session-state.test.ts`).
  The cold review of that fix caught it inert: `applyState` copied reducer
  fields by name and skipped the new one, so the reducer's unit test passed
  while the daemon still idled the row. `applyState` now adopts every
  reducer field through a `satisfies Record<keyof SessionActivityState,
  true>` key list (an unadopted field is a compile error) and
  `registry.test.ts` drives the same scenario through `broadcast()`.
  **P2** browser-error reports rode the NEWEST socket even while a refused
  or reconnecting cockpit socket could only queue them for its own
  `close()` to discard — the forwarder now picks the newest READY socket
  (`ws.test.ts`, first test, which owns the once-installed page listener).

**Files.** `server/protocol.ts`; `server/sessions/{registry,connection,
transcript-tail}.ts`; `web/src/components/{Shell,CockpitPanel,CockpitGlyph}.tsx`;
panel state, shared fleet ordering, structural CSS, and the supplemental-socket
error-forwarding lifecycle in `web/src/ws.ts`; focused tests in all three tiers
plus a committed visual baseline; README/architecture/backlog synced. No new
dependency was added — the panel composes the existing React, socket, action,
and two-click-confirm machinery.

**Completion evidence (2026-08-30).** `yarn typecheck`; Tier 1 **1,046/1,046**;
Tier 2 **161/161**; Tier 3 **127/127**; browser matrix + visual gate **11/11**.
The focused Chrome workflow measured a 228px dock at 1280px, proved live tail,
quick prompt, stop, end, direct navigation persistence, explicit-close
persistence, scrolling, no side-scroll, and an axe-clean expanded state. The
new `cockpit-panel` visual baseline was inspected at full resolution. During
integration review, closing the panel's second socket was found to clear the
page's browser-error reporter; the socket layer now restores the preceding
live client, with its own regression test. Existing FleetView traffic remains
metadata-only, its layout is unchanged, and the phone workspace
drawer remains unchanged.

---

## Phase TS — Render tools hidden by tool-search deferral (opened 2026-08-30; Kyle-directed)

**Origin.** Kyle, using Mirafold daily on Codex (ChatGPT login) for a week:
"95% of the time I don't see any cards or nice displays, just text." The
demos paint every turn because they are scripted; real sessions were not.

**Measured (2026-08-30, from the engines' own session logs — not from docs).**
- **Codex.** `~/.codex/sessions` rollouts driven by Mirafold (identified by the
  injected render guidance), August, Codex 0.147.0–0.151.0: **78 sessions,
  ~1,630 prompts, 171 paintings — 156 of them in one testing session on
  08-24; the other 77 sessions / ~1,400 prompts hold 15.** July (0.142.5):
  55 mostly-test sessions, 61 paintings. Mechanism: openai/codex#29486 put
  every MCP tool behind `tool_search` (opt-out removed); since 0.147 the
  tools are reachable only inside Codex's `exec` JavaScript runtime as
  `tools.mcp__mirafold__<name>(args)`, discovered by filtering `ALL_TOOLS`.
  The model does that when a prompt is an explicit visual ask and almost
  never mid-work. Custom/local providers still see the tools directly.
- **Claude Code.** No Mirafold-driven Claude sessions in Kyle's logs. Live
  probe through the real SDK path (Haiku, one turn, $0.06): the Agent SDK
  defers the `ui` server's tools behind `ToolSearch` by default; Claude
  searched (`select:mcp__ui__render_table`) and then painted. With
  `ENABLE_TOOL_SEARCH=false` it painted twice with no search.
- **OpenCode, Gemini CLI.** Tools listed directly; both painted on request
  in Kyle's August sessions (OpenCode: 2 real prompts, 2 cards; Gemini: 8
  paintings on 08-18). Not affected.
- A first pass of this measurement reported **zero** Codex paintings in
  August; it was an undercount (the counter missed the CamelCase
  `McpToolCall` rollout item). The corrected figures are the ones above.

- [x] **TS.1 — Claude Code: exempt the `ui` server from deferral** — done
  2026-08-30. `createSdkMcpServer({ alwaysLoad: true })` in
  `render-tools.ts` (the SDK's own per-server exemption, `_meta
  anthropic/alwaysLoad` per tool); only Mirafold's server — the user's other
  MCP servers keep the deferral their terminal applies (faithful skin).
  Unit test pins the flag on every registered tool
  (`claude-code.test.ts`). Live-verified on the default env: Claude went
  straight to `render_table`, no ToolSearch call ($0.06).
- [x] **TS.2 — Codex: teach the real mechanism, first** — done 2026-08-30.
  `codex-prompt.ts` rewritten: the where-are-the-tools note now LEADS the
  developer instructions and names all three paths (listed directly;
  deferred behind `tool_search`; inside the `exec` runtime via `ALL_TOOLS`
  and `tools.mcp__mirafold__…`) with exact call shapes, and makes loading
  the matching render tool the first step of any reply with a structured
  core. `codex.test.ts` pins order and content. No Codex config opt-out
  exists (verified against the sample config's full `mcp_servers` key list).
- [x] **TS.3 — Codex: measured live, honestly** — done 2026-08-30 (ChatGPT
  login, real adapter, `gpt-5.6-sol` at Kyle's `max` effort). Short probes
  were useless (single-turn asks and a three-turn read/compare/summarize
  script painted every turn under the OLD note too). The test that counts:
  a **16-turn replay of Kyle's own August prompts** (idea-listing, "analyze
  this project", a four-bug report, "fixed all those?", alignment fix, "how
  is this different?", "nothing left?", "what's next? ncja", the ctrl+ bug,
  a bed-time handoff) in a throwaway worktree, Codex project config
  `approval_policy = "never"` + `workspace-write`, ~55 min per condition,
  7 turns hand-marked as having a structured core (S), 6 plausible (P), 3
  prose (–); Codex's own `todo-list` checklists excluded. Result:
  **old note 3/16 turns painted (S 1/7, P 1/6, – 1/3); new note 4/16
  (S 2/7, P 2/6, – 0/3).** Both paint on the first three advisory turns
  (ideas → card+table+list; estimate → table) and then go prose for the
  rest of the session, including the quality analysis (turn 4, prose under
  both), the four-bug diagnosis (turn 5), and every short follow-up. The new
  note is not a lever: **one extra painting in 16 turns is noise.** What the
  replay shows instead: the model paints when the turn is advisory and
  fresh, and stops once the session has done real tool work; whether the
  tools are one search away or listed makes no visible difference. The
  remaining levers are per-turn (a paint reminder riding with each prompt —
  a product decision, it changes what the engine receives every turn) or
  TS.4. Measured facts, not a guess; re-run the replay before believing any
  future change.
- [x] **TS.5 — Codex: the per-turn paint reminder — built and measured NO-OP** — 2026-08-30
  (Kyle: "do it"). `CODEX_PAINT_REMINDER` (codex-prompt.ts, ~45 tokens)
  rides inside the engine input of every turn after the first, skipped
  right after a turn that painted (`todo-list` excluded; artifacts count);
  only engine-run turns inform it (a prompt refused before turn/start is
  not a prose turn); `/model` and `/effort` never carry it; engine-only —
  the transcript's `user_prompt` is the registry's copy of what was typed.
  Unit test pins all of that (`codex.test.ts`, TS.5). Cost: a 30-turn
  session accumulates ~37k reminder tokens against millions — under 1%.
  **Measured (condition C, same 16-turn replay): 5/16 turns painted (S 2/7,
  P 1/6, – 2/3) vs 3/16 old note and 4/16 new note.** The gain is not the
  reminder's: with the skip-after-a-painting rule it rode on ten turns
  (6–14 and 16) and **none of those ten painted**; C's paintings came from
  turns 1–4 (no reminder in play, the same early advisory cluster as A and
  B) and turn 15. Across all three runs (48 turns) paintings cluster on the
  first three or four advisory turns of a session and reappear only
  sporadically; every "work" turn (the bug diagnosis, `fix it.`, the ctrl+
  bug) stayed prose in all three. **Verdict: instructions — at thread start
  or per turn — do not move this model's mid-session choice to paint.** The
  reminder stays on the branch as its own commit so the experiment is in
  history; recommendation is to drop that commit rather than ship a
  measured no-op that costs tokens. What the replays do suggest: the model
  paints when it is *advising* and not when it is *reporting work* — for
  work turns Mirafold already shows the diffs, commands and results as the
  engine's own tool rows, so the missing piece is the prose summary, not
  the data. Any further lever is product design (what a work summary should
  look like), not prompting.
**Second half of the phase — event fidelity (Kyle, 2026-08-30: "let's do
these fixes to ensure we are painting as often as we should be for every
agent").** The deferral work above fixed the model's ACCESS to the render
tools; the replays showed the rest of "just text" is what Mirafold drops of
what the engine already did. Audit (`codex app-server
generate-json-schema`, 19 thread-item kinds; the adapter mapped 7 with no
default branch; Kyle's 86 August sessions): edits shown as
`[object Object] /abs/path` with the diff never drawn (2,171); commentary
vs. final answer indistinguishable (3,553 vs 513); subagent activity
invisible (568 collab + 456 activity items); image views dropped (233);
command output not streamed; a dozen notification kinds unhandled.

- [x] **TS.6 — Codex edits as real diffs** — done 2026-08-30; live-checked: rows read "Added/Updated/Deleted NOTES.md" with the patch attached. `normalizePatchChanges` reads
  the wire shape (`kind: { type, move_path }`, `diff`) and the rollout shape
  (map by path, `unified_diff`/`content`) alike; rows read "Updated
  server/x.ts" (workspace-relative, like the terminal); the row's input
  carries `{path, kind, diff}` and the browser draws hunks for updates and
  the whole file for adds/deletes with the same diff rows an Edit gets.
  Fixtures use the REAL captured shape. Live-checked against the engine.
- [x] **TS.7 — Never silent + schema conformance** — done 2026-08-30 (all four adapters report an unmapped kind once per session as a shell notice + log; `scripts/codex-protocol-digest.mjs` → vendored `codex-protocol.digest.json`; `codex-protocol.test.ts` holds handled ∪ ignored ∪ planned == the digest and pins the field shapes the adapter reads; the Tier-4 test regenerates the digest from the installed Codex and fails on drift; Claude's message ledger is compile-time exhaustive — the TS.12 Claude/OpenCode/Gemini never-silent halves landed here too). Every adapter's item
  dispatcher gets a default branch: log + one shell-voiced notice per
  session per kind ("Codex sent something Mirafold doesn't display yet:
  …"). Codex: a small protocol digest (variant names, notification methods,
  the fields the adapter reads) generated from `generate-json-schema` and
  vendored; Tier-1 asserts handled ∪ deliberately-ignored == digest; Tier-4
  regenerates the digest from the installed Codex and fails on drift with
  the diff. Live tests assert zero unknown-kind notices for their scripts.
- [x] **TS.8 — Commentary vs. final answer** — done 2026-08-30 (additive `text_delta.phase`; Codex tags every delta from `item/started`'s phase, verified live; commentary is narration — folds into the activity record when interior, dim when trailing — and the final answer is its own full-weight row; a phase change splits rows. Also mapped here: `plan` items + `item/plan/delta` as commentary, review-mode and reroute notices (new `info` notice kind), `deprecationNotice`/`configWarning`/`guardianWarning` as badged engine warnings; `thread/compacted` and `hookPrompt` classified as ignored with reasons). Additive `text_delta.phase`
  ("commentary" | "final"); the browser renders commentary as narration
  (dim, part of the turn's activity) and the final answer at full weight —
  the terminal's distinction, which 7 of 8 Codex messages currently lose.
- [x] **TS.9 — Codex subagent lane** — done 2026-08-31 (collab calls as engine-named rows with the prompt and child states; child activity narrates under its spawn via `parentId`, or as commentary when no call named the thread; `dynamicToolCall` and `sleep` rows too). `collabAgentToolCall` → tool rows
  (spawn/wait/send with the prompt and agent ids); `subAgentActivity`
  (started/interacted/interrupted/completed) → narration under the spawn
  row via `parentId`, the Phase SA deck. Inner child content still needs
  per-thread subscriptions — recorded, not attempted here.
- [x] **TS.10 — Image views** — done 2026-08-31 (`view_image`/`image_generation` rows, the picture painted inline through the image tool's own jail and byte cap; outside the workspace the row stands alone). `imageView` → a `view_image path` row plus
  the image itself painted inline (workspace-jailed, byte-capped, the
  existing render_image path) — faithful and better than the terminal.
- [x] **TS.11 — Streamed command output** — done 2026-08-31 (additive `tool_output_delta`; the running row's head carries the last line, its body the stream; capped like final output; `patchUpdated`/`turn/diff` classified ignored with reasons — the Codex ledger's unmapped lists are now empty). Additive wire
  `tool_output_delta { id, text, parentId? }` from
  `item/commandExecution/outputDelta`; the browser appends to the running
  row; `tool_result` still closes it. Same for `item/fileChange/outputDelta`.
- [x] **TS.12 — The other engines' guards** — done 2026-08-31, with one honest gap: Claude's ledger is compile-time exhaustive (`compact_boundary` was already surfaced; `tool_progress` and `task_*` stay unmapped → reported when they arrive); OpenCode: the adapter exports its handled/ignored ledgers and a Tier-4 test pulls the server's own OpenAPI document (`/doc`) and fails on any unclassified event/part kind — **not runnable on this machine: the global `opencode` install is broken (its postinstall never fetched the platform binary), so the test skips with that reason; Kyle's OpenCode sessions on 08-13/08-18 predate the break**; Gemini: the runtime guard only (sunset, no live tier). Claude: an exhaustive ledger
  `satisfies Record<SDKMessage["type"], "handled" | "ignored">` (compile
  error on an SDK bump that adds a kind) + `compact_boundary` surfaced as
  the compaction notice Codex already gets; OpenCode: Tier-4 pulls the
  server's API description and asserts event/part variants against the
  handled set; Gemini: the Tier-4 run fails on any unclassified kind.

- [ ] **TS.4 — Honest notice when tools are hidden** (parked idea): when a
  Codex session runs on a provider that defers MCP tools, say so where the
  user reads it instead of silently degrading. Not started.

**Files.** `server/render-tools.ts`, `server/adapters/codex-prompt.ts`,
`server/adapters/codex.ts`, tests in `claude-code.test.ts` and
`codex.test.ts`, `docs/ADAPTERS.md` §5.

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

- [x] **Step S.1 — `chart` kind: pie (donut)** ✅ 2026-07-27 —
  size-ordered slices, past 6 the tail folds into ONE "other", donut total
  + per-slice direct labels; the one-series rule enforced in the renderer
  → raw-props fallback. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

- [x] **Step S.2 — chart ergonomics: `stacked`, `horizontal`, histogram
  hint** ✅ 2026-07-27 — bar-only, quiet no-ops elsewhere, composable;
  old-client degradation pinned by a rebuilt "yesterday" tolerant schema.
  → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

- [x] **Security audit of the 2026-07-27 component work** ✅ same day —
  session replay buffer capped by BYTES (`SESSION_BUFFER_MAX_BYTES`,
  32 MB) beside the count cap; workspace dir a REQUIRED argument on the
  render seam (it jails the image read); `mermaid` moved to
  devDependencies (inlined at build — the zero-passengers rule applied).
  All pinned + mutation-tested; everything else probed clean. →
  PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

- [x] **Workflow-gap batch (Kyle-directed 2026-07-27): `console`,
  `image`, `diagram`** ✅ — each through the full seam: ANSI-parsed
  console output; daemon-inlined images (jailed, raster-only, 2 MB cap, NO
  svg); mermaid in the ARTIFACT-grade sandbox, postMessage-only.
  **Deliberately NOT built: structured input beyond `question`** —
  free-text input inside agent-authored UI collides with the trusted-shell
  rule that input surfaces are shell-owned; it needs a design conversation
  with Kyle first, never a batch add. → PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

- [x] **Step S.3 — `stat` registry component (KPI tile)** ✅ 2026-07-27 —
  plus `code` (display-only, copy button, clamped highlight ranges on the
  pinned-dark code surface) and `status-list` (verdict pills, glyph↔enum
  Tier-1-pinned) the same sitting, same seam, display-only. →
  PLAN-ARCHIVE.md, "Moved 2026-08-12 (prune — completed bodies)."

---

## Post-release ideas (parked — organize after R.7)

The unordered post-R.7 idea backlog lives in **POST-RELEASE.md** (moved out of
this file 2026-07-19 to keep the plan focused on active launch work). Nothing
in it gates any Phase R step.

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
