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

## Design identity · security model · wire protocol (locked — live in README)

These three load-bearing references were seeded here in Phase 0 and grew
richer, maintained copies in README; the duplicates were retired 2026-07-15
to end the drift risk of two copies. The locked content, and where it lives:

- **Design identity** → README §7 — terminal successor, not a chat app:
  mono-in / rich-out, no bubbles ever, and **provider-native transcript
  fidelity + collapse-on-finalize**: show the same user-visible activity the
  selected terminal agent shows, neither raw adapter internals nor less useful
  state; noisy live activity folds to one expandable record when it settles.
- **The core security model** → README §3 — trusted shell vs. sandboxed
  output zone; the boundary is inviolable, and the API key never reaches
  the browser.
- **The wire protocol** → README §2.1 — `server/protocol.ts` is the one
  shared contract, and **later phases ADD message types (or optional
  fields), never reshape existing ones** — every step below relies on that
  rule.

## How to use this plan

Each step below is sized to be completed reliably in a single prompt. Work them
in order. Each has **Goal / Build / Files / Done when**. Do not start a step
until the previous step's "Done when" is satisfied. Check items off as you go.

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
durable provider recovery, and branch test-audit closure), plus the finished
steps of the still-open Phases **K, R, F, Q, L**.

Archive passes, each a section header in PLAN-ARCHIVE.md you can navigate to:
2026-07-08 · 2026-07-10 · 2026-07-15 · "Moved 2026-07-17" · "Moved 2026-07-19"
· "Moved 2026-07-24" (Phases A/C/E/M + V.4–V.6, and the completed material
lifted out of the still-open Phase R steps) · "Moved 2026-07-27" (Phases
E2/W step bodies, the Phase E/M narrative passes, the R.4l item-5
investigation, the CI-flake breakdown, and finished stretch-goal specs) ·
"Moved 2026-08-09" (Phase UX) · "Moved 2026-08-12 (prune — completed
bodies)" (a sweep of finished bodies across Phases 4/R/A/Q, the 2026-07-27
audit section, and the stretch goals).

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
- [x] **Step UX.6 — Settle prompt return behavior, then refactor Phase UX** —
  done 2026-08-10; accepted desktop transcript-click behavior replaced the
  provisional binding, and the full Phase UX diff received a verified
  behavior-preserving refactor. → **PLAN-ARCHIVE.md**.
- [x] **Step UX.7 — Close the eight Phase UX correctness findings** — done
  2026-08-10; backend identity, faithful catalogs, dormant idle unload,
  completion visibility, chronology-safe compaction, defensive decoding, and
  delete-failure recovery are fixed and regression-pinned. →
  **PLAN-ARCHIVE.md**.

- [x] **Step UX.8 — Close the Phase UX security audit findings** — done
  2026-08-10; credential/destination binding, fully opaque configured endpoint
  identity and diagnostics, exact loopback classification, prompt-catalog
  provenance/control safety, and strict checkpoint decoding are regression-pinned.
  → **PLAN-ARCHIVE.md**.

- [x] **Step UX.9 — Audit and repair the Phase UX branch tests** — done
  2026-08-10; repeated all safe test tiers, mutation-proved and closed six
  regression gaps, and made the live Codex/Ollama timeout clean up immediately.
  The real-turn instability it exposed was kept visible and is now diagnosed
  and closed in Step L.4. → **PLAN-ARCHIVE.md**.

- [x] **Step UX.10 — Make collapse-on-finalize survive narrating engines** —
  done 2026-08-12; the "worked · N actions" fold now absorbs interior
  thinking in true transcript order, and Codex completed-with-nonzero-exit
  is annotated, not branded an error. Pinned in Tier-1 + e2e. →
  **PLAN-ARCHIVE.md, "Moved 2026-08-12 (Changes polish + branch closure)."**

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

- [x] **Step K.8 — Dependency license scan** — done 2026-07-15; no copyleft in either production tree (shell: MIT/ISC/Apache/BSD + the proprietary Anthropic Agent SDK, stated plainly in README §12; relay: just `ws`, MIT — stale lockfile metadata resynced). Copyright-line swap to the entity stays owed to K.2. → PLAN-ARCHIVE.md.
  *2026-07-27 amendment (external legal review):* the scan's
  `--production` method structurally misses the browser bundle — the
  web-side libraries are devDependencies but `vite build` compiles them
  into the shipped `dist/` (react, react-markdown, mermaid + its embedded
  dompurify, …). Closed the same day: `THIRD-PARTY-NOTICES.md` (212
  packages, full license texts, ships in the npm package via `files`),
  generated by `scripts/third-party-notices.mjs` — regenerate on any
  web-side dependency change. dompurify is dual `MPL-2.0 OR Apache-2.0`;
  the notices file elects Apache-2.0, so the no-copyleft claim holds for
  the bundle too. README §12 updated.

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
    hand-sent tarball distribution, the testers-subscribe-FOR-REAL rule,
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

- [x] **N2.1 — Host-native picker service + local-only wire** — done
  2026-08-08; shell-free macOS, Windows, and Linux recipes; correlated
  non-replayed wire pair; validation, cancellation, concurrency, abort, and
  relay refusal pinned. → PLAN-ARCHIVE.md.
- [x] **N2.2 — Onboarding browse control** — done 2026-08-08; compact
  `browse…` beside the editable path in both startup routes, capability-gated
  with manual entry retained as the universal fallback. → PLAN-ARCHIVE.md.
- [x] **N2.3 — Regression proof + documentation** — done 2026-08-08; focused
  tests, real-daemon browser proof, accessibility/phone checks, typecheck,
  build/package, production audit, README, and protected CI complete.
  → PLAN-ARCHIVE.md.
- [x] **N2.4 — Post-refactor executable-trust remediation** — done 2026-08-08;
  browser and native-dialog identity now comes only from fixed system paths,
  agent discovery rejects project/npm-controlled candidates, helper processes
  use a neutral cwd/scrubbed environment and confirm exit after cancellation or
  output overflow, and the `npx` trust boundary is explicit. Local proof:
  Tier 1 561/561, Tier 2 143/143, Tier 3 82/82, typecheck, build, 19-file
  package dry-run, secret scan, and production audit (0 vulnerabilities).
  → PLAN-ARCHIVE.md.
- [x] **N2.5 — Keep the chosen folder leaf visible in long paths** — done
  2026-08-08; programmatic picks and blurred edits reveal the rightmost folder,
  focused editing retains ordinary caret control, and the complete path still
  creates the session. Local proof: Tier 1 561/561, focused Tier 3 1/1,
  typecheck, and production build. → PLAN-ARCHIVE.md.
- [x] **N2.6 — Close the post-audit environment and Windows-opener execution
  paths** — done 2026-08-08; checkout `.env` loading is data-only and
  provenance-aware, startup tokens are percent-encoded, Windows opens URLs
  directly through fixed-system `explorer.exe`, and the trust guidance names
  the remaining `.env` boundary honestly. Local proof: Tier 1 563/563, Tier 2
  143/143, Tier 3 82/82, typecheck, production build, 19-file package dry-run,
  secret/diff scans, and production audit (0 vulnerabilities). →
  PLAN-ARCHIVE.md.

## Phase N3 — Stable Tier-3 browser gates (✅ COMPLETE 2026-08-08)

- [x] **N3.1 — Controlled busy-state proof** — own session + permission latch;
  no transient-locator race. → PLAN-ARCHIVE.md.
- [x] **N3.2 — Isolated Mermaid renderer proof** — own session, production
  lazy chunk/sandbox/CSP/postMessage paths retained. → PLAN-ARCHIVE.md.
- [x] **N3.3 — Deterministic follow-tail re-arm** — wheel/touch intent arms
  synchronously against pre-input geometry; pure boundaries + real-wheel e2e.
  → PLAN-ARCHIVE.md.
- [x] **N3.4 — Repetition + protected proof** — focused activity 6/6,
  Mermaid 5/5, follow-tail 6/6; Tier 1 554/554; two unchanged full Tier-3
  runs 78/78; PR #22's DCO, Cloudflare, Tier 1, and combined Tier 2/3 checks
  passed on implementation head `a091ba1`. → PLAN-ARCHIVE.md.

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
`onRefresh` — now `useCallback`-stable). README §11's accepted-duplication
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

- [x] **Step E2.1 — per-directory listing: wire + server** — done
  2026-07-26; additive `fs_listdir`/`fs_dir` pair, jailed + per-dir-capped,
  token-bucket throttled (`FS_LISTDIR_MAX_PER_SEC` 32 — prefetch bursts are
  legitimate), hostile paths refused, legacy `fs_list` untouched.
  → PLAN-ARCHIVE.md.
- [x] **Step E2.2 — the lazy client: incremental tree store** — done
  2026-07-26; per-directory node store (fetch on first expand, cached
  re-expands, per-dir correlation ids + stale-reply drop, loading rows),
  open = root + first-level prefetch, refresh/turn-end refetch expanded dirs
  and PRUNE cached-but-collapsed ones; whole-tree `fs_list` retired from the
  client (daemon still answers it). → PLAN-ARCHIVE.md.
- [x] **Step E2.3 — multi-repo git fidelity** — done 2026-07-26; per-repo
  statuses + ignore rules on the lazy listings (`findRepoRoot()` walks to
  the FILESYSTEM root — git's own discovery rule; `repoStatus()` behind a
  TTL cache + ONE global serialized git queue; `decorateGitDir()` pure;
  deleted files stay visible); git trouble degrades to the plain listing,
  never an error; zero wire or client changes. → PLAN-ARCHIVE.md.
- [x] **Step E2.4 — the Projects-root proof + compatibility pin** — done
  2026-07-26, **phase E2 complete**; `fs_diff` discovers the repo CONTAINING
  the file (nested-repo diffs work; jail first, session-root fallback), the
  legacy `fs_list` old-client floor pinned as-is (never to be "fixed"), the
  Tier-3 multi-repo proof shows zero whole-tree requests, phone drill-in
  passes. All tiers 388/110/56. → PLAN-ARCHIVE.md.

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

### Step E.6 — the enlarge lightbox (desktop reads big on demand)

- [x] **Step E.6 — ⤢ enlarge** — done 2026-07-28 (Kyle-directed; splits,
  docks, and a full takeover were weighed and the dimmed lightbox chosen —
  the transcript never reflows, and the user trades it away only by
  deliberate click). The docked file view stays compact (wrapped,
  tool-output look); ⤢ lifts the SAME node — class re-frame, no remount, so
  scroll survives — into a fixed frame over a 55% dim (Esc / backdrop / ⤡
  restore in place; focus-trapped dialog; title centered on the bar's true
  center; content 1em, box sat 1.5vh above center). Found en route and
  fixed: the file view had been inheriting `.tool-code`'s transcript-only
  360px height cap in every frame. Desktop-only — the phone E.4 frame is
  already full-screen, pinned by a phone-suite assertion. Commits c01d846 +
  b9589b2 (the day's new busy-turn sanity guard recalibrated `>10` → `>0`
  samples). Tiers 458/139/54 green. Same-day audit: nothing exploitable;
  the lightbox-over-permission-bar layering recorded as an accepted
  decision in SECURITY.md.

## Phase E3 — Explorer visual polish

- [x] **Step E3.1 — Refine the tree surface and add node-type glyphs** — done
  2026-08-11; the existing read-only tree now uses Mirafold's inset surface,
  compact row/guide treatment, SVG chevrons, and decorative open/closed-folder,
  symlink, and broad file-family glyphs immediately after names. No dependency,
  server/wire, lazy-fetch, sort, Git-status, drill-in, refresh, or phone-flow
  behavior changed. Desktop, phone, dark/light, overflow, and axe proofs pass.
  → PLAN-ARCHIVE.md.
- [x] **Step E3.2 — Integrate the Explorer visually with the workbench** —
  visually approved by Kyle 2026-08-11. The dock now has a stable responsive
  width, compact Files title/action bar, separate sticky workspace-root strip,
  inset tree-row rhythm, quieter unboxed Git markers, and conventional
  `chevron → type glyph → name → status` ordering. Refresh and the phone close
  action moved into the title bar without changing their behavior; the stacked
  phone file drill-in remains intact. The accepted revision and the D.1 Codex
  refactor merged through PR #34 at `21b5f33` after DCO, Cloudflare Pages,
  Tier 1, and combined Tier 2/Tier 3 passed.

## Phase BC — Whole-codebase correctness closure

- [x] **Step BC.1 — Repair the eight confirmed whole-codebase findings** —
  done 2026-08-11. Gemini turn preparation and Codex default-model resolution
  now recover from transient failures; the relay and cookie boundaries reject
  malformed-but-valid inputs safely; model-turn state no longer collapses at a
  neighboring bang lifecycle boundary; active rename failure rolls back instead
  of claiming durability; filesystem/Git caps count UTF-8 bytes; and Explorer
  path presentation accepts Windows shapes without changing POSIX filename
  semantics. Each finding has a concrete regression. No dependency, provider
  protocol, stored-session schema, or filesystem write feature was added.
  Published as open PR #35 into `next`; deliberately unmerged pending Kyle's
  review. → PLAN-ARCHIVE.md.

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

- [x] **Step W.1 — the watcher module, server-side** — done 2026-07-26;
  `@parcel/watcher@2.6.0` + `server/sessions/fs-watch.ts`: one bell per
  fixed window from the FIRST event (a continuously-writing agent can't
  starve it), honest capped paths hint, exclusion globs, error→stop→notice
  exactly once; lifecycle follows viewport attach/detach. Two inotify
  backend truths handled: fast-created subtrees go permanently silent →
  healed by unsubscribe-THEN-resubscribe + one synthetic bell; every
  subscribe needs a fresh closure. → PLAN-ARCHIVE.md.
- [x] **Step W.B — the bell's paths hint capped by BYTES too** — done
  2026-07-26 (audit finding; not attacker-reachable — bandwidth hygiene
  under the cheap-theoretical-finding rule); `FS_WATCH_MAX_PATH_BYTES`
  (16,000) beside the count cap, `truncated` honest, pinned +
  mutation-tested. → PLAN-ARCHIVE.md.
- [x] **Step W.A — a browsed repo cannot run programs** — done 2026-07-26
  (audit finding); `server/sessions/git-trust.ts` + the `trusted-repos.json`
  allow list neutralize the three probe-proven execute vectors
  (`core.fsmonitor`, `filter.*.clean`, `filter.*.process`) unless the repo
  is user-trusted; reads git's EFFECTIVE config (an `include.path`-hidden
  setting still executes otherwise); one notice per repo per connection;
  pinned by `git-trust.itest.ts` with real planted programs +
  mutation-tested. Detail + probe method in `SECURITY.md`. **Standing
  caution: the vector list is tied to which git commands the daemon runs —
  adding a new one means re-running the probe.** → PLAN-ARCHIVE.md.
- [x] **Step W.2 — `fs_changed` on the wire + the live client** — done
  2026-07-26, **phase W complete**; per-viewport bell (never broadcast,
  never replayed), the per-repo status cache invalidated BEFORE fanning,
  client coalesces via `bellRefreshDelay` (min gap 1s) so bells can't drain
  the token bucket, and the watcher-failure notice ships. Field find fixed
  at the source: every daemon git read runs `--no-optional-locks`, so the
  daemon's own status calls can't write `.git` churn the watcher hears (a
  feedback loop) — itest-pinned + mutation-tested. Proven end-to-end: a
  file written behind the UI's back appears with zero clicks. All tiers
  389/123/57. → PLAN-ARCHIVE.md.

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

### Phase CR.1 — Reusable file view + complete change-set query

- [x] **Step CR.1 — Cut the shared foundation without changing the shipped UI**
  — completed 2026-08-11. The reusable correlated file-view controller and
  bounded `fs_changes` → `fs_change_set` multi-repository query are implemented;
  focused unit/integration, malformed-client, desktop Explorer, 390px phone,
  production client build, and typecheck proofs pass. No user-facing control or
  surface was added. Full specification and implementation record →
  **PLAN-ARCHIVE.md, “Moved 2026-08-11 (Changes review foundation — CR.1).”**

### Phase CR.2 — The useful Changes view, desktop and mobile

- [x] **Step CR.2 — Ship the complete changed-set review surface** — completed
  2026-08-11. The trusted shell now opens one live, repository-grouped Changes
  workspace: a wide transcript-preserving split on desktop and a safe-area,
  one-file full-screen review on phone. Deterministic selection, honest counts
  and incomplete/error/empty states, live disk/turn refresh, and Files/Changes
  mutual exclusion are implemented. Real-daemon Chromium proves the complete
  behavior at 641px desktop and 390px phone, including dark/light screenshots
  and axe. Full specification and implementation record → **PLAN-ARCHIVE.md,
  “Moved 2026-08-11 (Useful Changes view — CR.2).”**

### Phase CR.3 — Code-context navigation + transparent agent feedback

- [x] **Step CR.3 — Make a diff directly conversational** — completed
  2026-08-12. Stable HEAD/working-tree line coordinates, hunk navigation,
  syntax-aware desktop/phone selection, visible editable `Explain` / `Request
  change` drafts, honest selection invalidation, and normal prompt submission
  are shipped. The intermittent phone axe result was diagnosed as a shuffled
  mock response exposing two unfocusable Highlight.js scrollers; highlighted
  fenced code is now keyboard-reachable and the regression fixture is
  deterministic. Full specification, diagnosis, implementation boundary, and
  proof → **PLAN-ARCHIVE.md, “Moved 2026-08-12 (Conversational Changes review —
  CR.3).”**

### Phase CR.4 — Review progress, live invalidation, and closure

- [x] **Step CR.4 — Make large reviews resumable and trustworthy** — completed
  2026-08-12. Review decisions are viewport-local and keyed to an opaque,
  server-minted identity of the exact bounded HEAD + working-tree bytes;
  unverifiable revisions cannot be marked. The desktop rail and phone review
  show progress, mark/unmark, and next-unreviewed navigation, with `R` / `N`
  disabled throughout the prompt and other editable controls. Watcher hints
  invalidate only affected reviewed files (including while the surface is
  closed), HEAD/incomplete hints invalidate all, and a subsequently loaded
  revision is reconciled before it can remain reviewed. Reduced-motion hunk
  navigation, 641px/390px overflow, and the large-diff render path are closed;
  one shared syntax pipeline replaces per-row highlighting and an honest
  1,000-line interactive cap bounds the surface. Focused correctness,
  security, and mutation-backed test-quality audits have no unresolved
  finding. Full starting state, implementation boundary, audit record, and
  proof → **PLAN-ARCHIVE.md, “Moved 2026-08-12 (Trustworthy review progress —
  CR.4).”**

### Phase CR.5 — Correctness remediation

- [x] **Step CR.5 — Close the whole-feature bughunt findings** — completed
  2026-08-12. All ten reproduced failures are repaired and regression-pinned:
  Git/index edge states, malformed and nested repository resolution, deleted/
  symlink/unreadable diffs, reconnect and manual-refresh trust, status-only
  refreshes, zero-visible incomplete results, and terminal-newline modeling.
  The complete Changes browser suite and dotenv-safe aggregate tiers pass.
  Full verified baseline, executable/test/documentation boundary, and proof →
  **PLAN-ARCHIVE.md, “Moved 2026-08-12 (Changes correctness remediation —
  CR.5).”**

- [x] **Step CR.6 — Whole-branch security + test audits** — done 2026-08-12;
  no exploitable vulnerability, one untested guard found and pinned. →
  **PLAN-ARCHIVE.md, "Moved 2026-08-12 (Changes polish + branch closure)."**

- [x] **Step CR.7 — Terminal hunk navigation + first-hunk positioning** —
  done 2026-08-12; blur-on-disable was killing the terminal smooth scroll
  (probed); scrolling now runs post-commit, diffs open on their first hunk,
  and same-path refreshes keep the view mounted. Geometry-asserting e2e. →
  **PLAN-ARCHIVE.md, "Moved 2026-08-12 (Changes polish + branch closure)."**

- [x] **Step CR.8 — Resizable desktop review panel** — done 2026-08-12; drag
  handle with floor = default width, ceiling = 100% − 380px conversation
  reserve, persisted per browser; keyboard separator with live aria
  geometry. e2e-pinned. → PLAN-ARCHIVE.md (same section).

- [x] **Step CR.9 — Diff-gutter Changes glyph, size-matched to Files** —
  done 2026-08-12; unified-diff fragment on FilesGlyph's 14×20 artwork box,
  rail gap 4→28px. → PLAN-ARCHIVE.md (same section).

- [x] **Step CR.10 — Dock the hunk toolbar; align the progress buttons** —
  done 2026-08-12; the diff's one scroller is the bordered code card
  itself, the toolbar docks outside it, and the wrapper + progress bar
  share symmetric 9px insets (7px phone). → PLAN-ARCHIVE.md (same section).

- [x] **Step CR.11 — "Select hunk" toggles** — done 2026-08-12; clicking
  the exact (clamped) selected range unselects, with aria-pressed and a
  label swap. e2e-pinned. → PLAN-ARCHIVE.md (same section).

- [x] **Step CR.12 — Branch bughunt (post-audit delta)** — done 2026-08-12;
  two confirmed resize-handle bugs fixed with born-failing pins (stale
  separator aria after drags; a bare click freezing the responsive width),
  one candidate disproven by forced reproduction. → PLAN-ARCHIVE.md (same
  section). **WATCH ITEM (live):** one unattributed intermittent
  full-ordered Tier-3 failure — observed 1-in-6 runs on 2026-08-12, failing
  test unnamed (the first run's log was summary-filtered); every later run
  keeps the complete TAP log, so the next occurrence names itself.

- [x] **Step CR.13 — Security audit of the post-CR.6 delta** — done
  2026-08-12; every new input path traced with concrete values, ZERO
  findings in every class, nothing deferred. → PLAN-ARCHIVE.md (same
  section).

- [x] **Step CR.14 — Test audit of the post-CR.6 delta** — done 2026-08-12;
  five falsifications each fail exactly the right tests; one proven gap
  closed (the fold label is now pinned to count actions only). Standing
  note: hunk navigation's deferred scroll is redundant protection since
  CR.10's layout removed the blur-cancellation trigger — kept deliberately.
  → PLAN-ARCHIVE.md (same section).

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

### Phase NF.1 — The notify engine + both surfaces wired

- [x] **Step NF.1 — Pure decision core, DOM binder, Shell + fleet wiring** —
  completed 2026-08-12: `web/src/notify.ts` (reducer + binder + DOM wiring)
  landed with 23 Tier-1 tests covering the full matrix below; both routes
  wired exactly as specified, `yarn test` 695 green, typecheck clean. —
  **Goal:** notifications actually fire from both routes, correctly
  suppressed, coalesced, and self-closing, behind a preference that defaults
  off. **Build:** `web/src/notify.ts`: (a) a pure transition reducer — given
  the previous per-session state map, fresh session snapshots
  (`{id, state: idle|busy|permission, title, agent?, detail?}`), and flags
  `{enabled, granted, visible}`, return show/close actions plus the next map —
  every rule above lives here; (b) `createNotifier(deps)` binding the reducer
  to injected `{isVisible, permission, spawn, onVisibilityChange}` with a
  `reset()` that reseeds state without emitting (used across socket
  drop/reconnect so a forced `busy→idle` never fakes a turn-end). Wire Shell
  (its `asks`/`busy` tri-state, title from the cwd basename, detail from
  `asks[0]`) and FleetView (per-session from the `sessions` snapshot,
  `wantsAnswer` for the permission side, close toasts for sessions that leave
  the list). Clicking focuses the firing tab. **Files:** `web/src/notify.ts`,
  `web/src/notify.test.ts`, `web/src/components/Shell.tsx`,
  `web/src/components/FleetView.tsx`. **Done when:** Tier-1 tests prove the
  reducer's full matrix (permission shown once; answered-elsewhere closes;
  turn-end shown on `busy→idle` and `permission→idle`; visible suppresses
  shows but still advances state; disabled/ungranted emit nothing; per-session
  independence; vanished session closes; reset never emits) and the binder's
  lifecycle against fakes; `yarn typecheck` passes.

### Phase NF.2 — The settings affordance + end-to-end proof

- [x] **Step NF.2 — Toggle in the settings card, e2e, docs** — completed
  2026-08-12: Notifications section shipped in the settings card (switch row
  + blocked hint), Shell owns preference/permission logic, e2e proves the
  full hidden-tab loop (toggle → permission toast → answered → turn-end
  toast → visibility closes all). One diagnosed trap recorded for future e2e
  work: tsx's esbuild keepNames injects a module-scope `__name` helper into
  compiled classes/accessor properties, which Playwright then serializes
  WITHOUT the helper — init scripts and evaluates containing them die on a
  ReferenceError, so the Notification stub and the visibility override are
  plain-JS strings. — **Goal:** a
  user can find and flip the feature, and headless Chrome proves the visible
  behavior. **Build:** a Notifications section in the settings card
  (`ThemePicker.tsx`, prop-driven — the card stays Vite-only and dumb): one
  toggle row ("Notify me when a session needs me"), `aria-pressed`, a plain
  hint line when the browser has the permission hard-denied ("blocked in
  browser settings") or the API is absent. Shell owns the logic: preference in
  `localStorage["mirafold-notify"]`, enabling requests browser permission when
  still undecided. Fleet honors the same stored preference with no UI of its
  own. Settings-card CSS additions in `web/src/styles/12-dialogs.css`.
  **Files:** `web/src/components/ThemePicker.tsx`,
  `web/src/components/Shell.tsx`, `web/src/notify.ts` (preference helpers),
  `web/src/styles/12-dialogs.css`, `server/testing/app.e2e.ts`, README.
  **Done when:** the e2e opens settings, sees the section, flips the toggle
  (Notification API stubbed via init script), asserts the stored preference
  and `aria-pressed`, and a stubbed-notification assertion proves a hidden-tab
  permission event spawns exactly one tagged toast; axe stays clean;
  `yarn test` + `yarn test:e2e` + `yarn typecheck` pass; README's shell-UI
  section gains the tab-status-adjacent paragraph.

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

**Bounds.** Staging is `os.tmpdir()/mirafold-uploads/<sessionId>/` (0700);
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

### Phase FD.1 — Wire + daemon staging

- [x] **Step FD.1 — Chunked upload messages + the staging writer** —
  completed 2026-08-12: five additive message types + Q.2 fixtures,
  `upload-handlers.ts` with 12 Tier-1 tests covering the full refusal
  matrix, and 2 Tier-2 itests proving byte-exact staging + typed refusals
  over a real socket. — **Goal:** a client can stream a bounded file to the daemon and get back
  a staged absolute path, with every abuse path refused loudly. **Build:**
  additive protocol types (`file_upload_begin {id,name,size}` /
  `file_upload_chunk {id,data}` / `file_upload_abort {id}` client-side;
  `file_upload_done {id,path,name}` / `file_upload_error {id,message}`
  replies) + Q.2 fixtures; `server/sessions/upload-handlers.ts` on the
  fs-handlers template (per-connection state, never throws, every
  well-formed request gets exactly one reply); connection.ts delegation +
  dispose on close. **Files:** `server/protocol.ts`,
  `server/protocol.test.ts`, `server/sessions/upload-handlers.ts` (+
  `.test.ts`), `server/sessions/connection.ts`,
  `server/sessions/file-upload.itest.ts`. **Done when:** Tier-1 covers
  sanitization (path-stripped names, control chars, dot-names, length
  cap, collision suffixing), size/concurrency/stall caps, chunk-overflow
  and chunk-before-begin refusals, and the remote relay gate; a Tier-2
  itest streams real bytes over a real socket and reads back the exact
  file from staging; `yarn typecheck` green.

### Phase FD.2 — The drop experience in the shell

- [x] **Step FD.2 — Dropzone, progress, path insertion, e2e, docs** —
  completed 2026-08-12: window-level drop targets + overlay + upload strip
  shipped, staged paths quoted into the prompt via the draft merge with a
  polite announcement, 10 Tier-1 tests on the client core, and the e2e
  proves the whole loop (synthesized `DataTransfer` drop → overlay →
  staged-path in textarea → byte-exact file on disk → announcement). One
  diagnosed trap recorded: the drag listeners attach only after the
  session attaches, so a dispatch racing the mount fires into the void —
  the e2e waits for the session UI first. — **Goal:** dragging files onto a session viewport uploads them and puts
  their staged paths in the prompt, visibly and accessibly. **Build:**
  `web/src/file-drop.ts` — pure chunking/state core + a
  folder-picker-style reply router, Tier-1-tested; session-bus gains the
  three send methods; Shell wires window-level drag listeners (gated off
  onboarding), a shell-owned drop overlay + a compact upload strip above
  the prompt (name + progress + dismissible error), quoted-path insertion
  through the PromptDraft merge, and a polite announcement per attached
  file; CSS in the prompt-area stylesheet. **Files:**
  `web/src/file-drop.ts` (+ `.test.ts`), `web/src/session-bus.ts`,
  `web/src/components/Shell.tsx`, styles, `server/testing/app.e2e.ts`,
  README, POST-RELEASE.md (annotate the Input augment entry). **Done
  when:** the e2e drops a real `File` via `DataTransfer` on the live page,
  watches the strip, reads the staged path out of the textarea, verifies
  the staged file's exact bytes on disk, and axe stays clean; all three
  tiers green.

## Paintings polish batch (opened + ✅ COMPLETE 2026-08-13; Kyle-directed)

**Origin.** A paintings audit (this session) asked three questions: are the
existing paintings at the delightful bar, does the agent actually reach for
them, and are there coverage gaps. Verdict: the registry is strong (fallback
architecture, CVD-safe charts, never-color-alone) with a short list of
concrete defects; adoption is UNMEASURABLE (no instrumentation anywhere);
coverage needs nothing new now (the 2026-07-10 survey already filled the real
gaps, POST-RELEASE.md's 2026-08-02 growth analysis still governs). So: polish
first, measurement second, new paintings demand-gated.

- [x] **Fix batch** — completed 2026-08-13, all three tiers green
  (724/152/97):
  - `.rc` gains `overflow-wrap: anywhere` — an unbroken token (URL, SHA,
    long path) in any painting's prose no longer pushes the transcript
    sideways; inert on the monospace bodies (`white-space: pre` has no wrap
    points), so code/console/diff keep their horizontal scroll.
  - Chart: line charts fit the y domain to the DATA (`chartDomain`) — a
    200–210 ms latency trend is no longer a flat stripe under a forced zero
    baseline (bars still anchor to zero: a bar's length IS its value);
    ≤2-point line charts draw always-on dots (a 1-point polyline painted
    nothing); the forced last x label suppresses a stride label it would
    collide with (`showXLabel`); grouped bars can no longer bleed past
    their band at high category×series counts (`groupedBarLayout`). All
    four pure + Tier-1-pinned.
  - Table: every row renders exactly `columns.length` cells (surplus
    truncated, missing padded — misaligned rows used to escape the header
    silently); number cells right-align with `tabular-nums`
    (`.rc-table-num`); empty `rows` shows a muted "no rows" instead of a
    bare header. Tier-1-pinned (`Table.test.ts`, new).
  - Code + Console bodies: vertical clamp (`max-height: 360px`, scroll) —
    the diff body's existing treatment; a dumped whole file / 200k-char log
    scrolls in its panel instead of consuming the transcript.
  - **Diagram follows the app theme now (decision).** Pinned-dark is the
    CODE-surface convention (`--code-bg` + ANSI/hljs palettes, manifest
    PINNED_TOKENS); a diagram is a picture, not a code surface, and on the
    light themes it rendered as a jarring dark slab. The frame body is
    transparent (the panel surface is the canvas), mermaid re-initializes
    per message with the shell-computed dark flag + `--surface` color, and
    a `data-theme` MutationObserver re-posts on theme switch so baked-in
    SVG colors follow. Sandbox posture unchanged (strict, no-network CSP,
    postMessage-only source) — Tier-1 pins the transparent body +
    per-message init.
- [x] **Paintings-adoption instrumentation** — completed 2026-08-13: one
  LOCAL log line per paint (`paint <component> agent=<agent>`) at
  `registry.deliver()`, the choke point every adapter's stream crosses.
  Local daemon log only, nothing leaves the machine; cheap enough to keep,
  one `if` to delete if treated as temporary. Purpose: make "does this
  engine actually reach for the render tools" answerable from logs — the
  audit found the Codex/Gemini guidance asymmetry (one-shot first-turn
  prepend vs. Claude's every-request system-prompt append) impossible to
  evaluate without it.
- Audit findings deliberately NOT fixed here (recorded, not lost): the two
  hand-kept `TOOL_DESCRIPTIONS` maps (render-tools.ts / render-mcp.ts) have
  drifted in wording with no guard test; no test pins Claude's
  `mcpServers`/`systemPrompt.append` registration; the stdio
  `emit_artifact` description omits the `mirafold.prompt/tool` sandbox API
  that the in-process description documents (Codex/Gemini can't author
  interactive artifacts); registry CSS half-lives in `08-picker.css`
  (housekeeping); HBar tooltip parks at `left: 40%`. Each is a candidate
  for a follow-up surfacing-parity step.

## Phase OC — OpenCode adapter (opened 2026-08-13; Kyle-directed)

**Product call.** Kyle, from a 2026-08-13 market check: OpenCode (~195k
GitHub stars) is now the dominant open-source terminal agent — the largest
user population Mirafold doesn't cover — and becomes the fourth adapter.
(Same check surfaced that Gemini CLI was retired upstream 2026-06-18,
replaced by the closed-source Antigravity CLI; Gemini-adapter sunset is
agreed but explicitly deferred — NOT part of this phase.) The feasibility
spike is **`server/adapters/opencode.spike.md`** (verdict GREEN): the
event→`WireMsg` table, the `OPENCODE_CONFIG_CONTENT` MCP-injection path,
the permission reply round-trip, and the provider-keyed credential-policy
design all live there — the steps below execute that doc, and its two live
gates come first.

- [x] **Step OC.0 — Live gates + shape capture** — completed 2026-08-13,
  same day, $0 and credential-free: scratchpad-local `opencode-ai@1.18.18`
  with HOME jailed; Gate 1 PASSED (`OPENCODE_CONFIG_CONTENT` alone
  connected the render MCP; tools advertise as `mirafold_render_*`), Gate 2
  PASSED via a fake OpenAI-compatible provider (ask event is
  **`permission.asked`** — published SDK types drift — reply `once` ran the
  tool through to `session.idle`). Streaming is a true delta channel
  (`message.part.delta`), usage + `modelID` ride each assistant message.
  Bonuses: 1.18.18 offers no Anthropic/Google OAuth at all, and a fresh
  install ships the free "OpenCode Zen" provider (needs its own OC.3
  policy row). One residual folded into OC.3: confirm a stored
  credential's oauth-vs-api kind is server-readable (needs a real
  connected credential). Full appendix in the spike doc. — **Goal:** de-risk the
  two spike gates and lock real shapes before adapter code exists.
  **Build:** run `opencode serve` (scratchpad-local install is fine; no
  global mutation) and confirm: (1) `OPENCODE_CONFIG_CONTENT` loads the
  mirafold render MCP and its tools appear (exact tool-name prefix
  captured); (2) a permission ask surfaces as `permission.updated` headless
  and the reply endpoint resolves it; plus capture the provider catalog's
  auth exposure (oauth-vs-api visible without reading `auth.json`?), the
  streaming part-update granularity, and usage field names. A $0 provider
  (Ollama or an existing API key) is needed for gate 2 only. **Done when:**
  the spike doc's "confirm live" flags are each resolved GREEN/RED with
  captured payloads appended to the doc.
- [x] **Step OC.1 — Core adapter + Tier-1** — completed 2026-08-13:
  `opencode.ts` (session: lazy spawn-with-retry latch, serial queue,
  first-turn guidance flipped only after prompt acceptance, permission
  bridge with deny-by-default timeout + external-reply handling +
  interrupt grace fallback) + `opencode-events.ts` (mapper: delta/snapshot
  text accrual, tool lifecycle, mirafold `render_*` recognition with
  honest fallback, todo checklist, per-turn usage summing) +
  `opencode-client.ts` (raw HTTP+SSE transport — the spike's SDK
  recommendation REVERSED with the reason recorded there: live shapes
  beat drifting generated types). 22 Tier-1 tests on captured shapes;
  full Tier-1 suite 746/746; typecheck green. `AgentName` grew additively
  (policy row fails closed, agent not in ADAPTER_AGENTS, so nothing is
  offered before OC.3/OC.4). — **Goal:** an OpenCode session
  behind the `AgentSession` seam, mock-verified. **Build:**
  `server/adapters/opencode.ts` — spawn `opencode serve` on a free port
  with a per-session `OPENCODE_SERVER_PASSWORD`, create the session, prompt
  via `prompt_async` with the pinned `model`, normalize the SSE stream per
  the spike table (text/reasoning accrual → deltas, tool parts →
  `tool_use`/`tool_result` with `capOutput`, `todo.updated` → checklist,
  `session.idle` → `turn_end`, `session.error` → sourced notice),
  `interrupt()` → abort, `resumeId` = session id. SDK-vs-raw call finalized
  at install per the spike. **Files:** `server/adapters/opencode.ts`
  (+ `.test.ts` with a fake SSE feed), `server/protocol.ts` (`AgentName` +
  fixtures — additive only). **Done when:** Tier-1 drives the full table
  through a fake event feed; `yarn typecheck` green.
- [x] **Step OC.2 — Render MCP + permission bridge** — completed
  2026-08-13. The Tier-1 half had landed inside OC.1; this step ran the
  live leg, $0 and credential-free (real `OpenCodeSession` → real spawned
  engine → fake provider): **a card painted end-to-end** through the real
  render-mcp stub, and **a permission ask round-tripped live** (ask → bar
  shape → `once` → bash ran). It caught and fixed two adapter bugs
  (health-poll wedge on pre-ready connections — per-attempt abort is
  load-bearing; user-message parts echoing as text_delta — roles now
  tracked, +1 test) and characterized one upstream engine behavior,
  documented not gated: a cold server's first model call carries zero
  tools; the engine self-recovers same-turn (spike appendix has the full
  probe evidence). Suite 747/747, typecheck green. — **Goal:** generative
  UI and the permission bar, faithfully. **Build:** inject
  `renderMcpCommand()` under `MIRAFOLD_MCP` via `OPENCODE_CONFIG_CONTENT`
  (additive merge; user config untouched); recognize mirafold tool parts by
  the OC.0-confirmed prefix → `generativeUIMsg` (skip the raw tool block);
  `permission.updated` → `permission_request`, `resolvePermission` → reply
  `once`/`reject` (**never `always`** — that writes the user's own approval
  state), `PERMISSION_TIMEOUT_MS` deny-by-default. **Done when:** Tier-1
  proves render-call recognition + both permission outcomes + timeout; a
  live render paints end-to-end.
- [x] **Step OC.3 — Credential policy + registry wiring** — completed
  2026-08-13, including the "needs a real credential" residual — resolved
  with auth.json FIXTURES in the jailed probe home (no real credential
  needed): the engine's own catalog distinguishes every kind (`source`
  api/env/config/custom + the `opencode-oauth-dummy-key` OAuth marker), it
  leaks raw stored secrets (stripped at the transport seam, never past
  it), and 1.18.18 ignores a stored anthropic OAuth wholesale. Landed:
  `classifyOpenCodeProvider` matrix in provider-policy.ts (fail-closed:
  unknown OAuth, Zen-pending-terms, unrecognized shapes all refuse with
  human copy), session-start enforcement in opencode.ts (pin resolved
  from OPENCODE_MODEL or the user's config `model`; refusals precede any
  engine session), shallow hello detection in index.ts (binary +
  auth.json existence — contents unread), `Backend.provider` from the
  pin. ChatGPT gray: policy-allowed, session-refused until OC.4 flows
  classified kind into Backend (relay-gate truth). 8 policy tests + 3
  session tests; suite 752/752; typecheck green. — **Goal:** the
  policy matrix applied provider-aware, fail-closed. **Build:**
  `provider-policy.ts` gains the OpenCode provider classification
  (anthropic/google oauth → blocked; openai oauth → disclosed gray area;
  api-key/env → `api-key`; local → `local`; **unclassified oauth →
  blocked**), detection per the OC.0-confirmed path (server catalog
  preferred; `auth.json` only with explicit consent); model pinned
  per-prompt so the session provider is the one Mirafold set; registry:
  `createSession` case, `agentHasCredentials("opencode")`, `Backend.provider`
  carries the pick. Relay gate unchanged (already refuses `subscription`).
  **Done when:** Tier-1 covers every matrix row incl. the fail-closed
  default; blocked/gray states render their correct copy.
- [x] **Step OC.4 — In-session fidelity surface** — completed 2026-08-13
  (the original OC.4 split in two; the onboarding half is OC.4b below):
  `opencode-commands.ts` on the codex picker pattern — `/model` paints the
  cross-provider catalog (policy-filtered: only providers a pick can
  actually run; a typed blocked pick refuses with its reason and keeps the
  pin), `/agent` paints user-facing primaries only (`hidden` internals and
  subagents excluded; pick rides every subsequent prompt), the engine's
  own command catalog routes `/name` inputs to `POST /session/:id/command`
  (the engine's real dispatcher, with pin + agent) and feeds
  `emitPromptOptions` behind our two re-skins (engine rows badged
  `source: "opencode"`). 6 new Tier-1 tests; suite 757/757; typecheck
  green. — **Goal:** what an OpenCode user expects in-session.
- [x] **Step OC.4b — Offerable + Zen terms citation** — completed
  2026-08-13 (the kind-into-Backend half split to OC.4c; live onboarding
  proof folds into OC.5): `opencode` joined ADAPTER_AGENTS +
  `defaultAgent`; one shallow `backendOptions` api-key row (existence
  probe; the provider-resolved truth stays enforced at session start);
  real agents-meta copy (connect hint names install + `opencode auth
  login` + OPENCODE_MODEL and says plainly that subscriptions and Zen
  aren't usable yet), `backendLabel` "API key (via opencode)", PromptBox
  source badge. **Zen terms read and cited** in provider-policy.ts
  (2026-08-13: no third-party-harness prohibition — the server API is
  opencode's own documented programmatic surface; "own internal use"
  clause; free-period training-data caveat): the disclosed-uncertainty
  rule's exact shape, but opening a NEW provider under it is Kyle's call
  (codex precedent), so the row stays CLOSED pending his decision — if
  opened, local-only + caveat shown. Also fixed en route: the fourth
  agent row overflowed the onboarding squeeze ramp by 14px — the
  squeeze intercept moved 66→70 and the per-row floor metrics shaved
  (full-chrome values untouched); the squeeze e2e passes with four READY
  rows. Verification status, honestly: Tier-1 757/757 + Tier-2 152/152
  green; e2e ran 96/97 before the CSS fix (the squeeze test its only
  failure, after the hint-count assertion gained the fourth card) and
  the fixed squeeze test passes in isolation — but two attempts at the
  full post-fix e2e run were stopped externally mid-run (6/6 ok at each
  stop), so ONE clean full-suite pass is still owed; folded into OC.5's
  tier sweep.
- [x] **Step OC.4c — Classified kind into Backend + ZEN OPENED** —
  completed 2026-08-13, same day Kyle said "open Zen" (the decision the
  OC.4b citation was waiting on). Built exactly per the design below:
  `onBackendKind` seam + registry adoption at `activate()` (truthful kind
  checkpointed), `kindPending` refusing remote actions pre-verification,
  and the three relay-gate sites (attach, cockpit acts, uploads) unified
  on one `relayGateRefusal` verdict in provider-policy.ts. The ChatGPT
  gray now RUNS locally with its uncertainty disclosure (once per
  provider, Mirafold-composed, no badge). **Zen**: new `gateway`
  CredentialKind (additive on every wire union) — allowed locally for
  opencode with the uncertainty + training-data disclosure, NEVER
  relay-eligible (the allow-list refuses it by design); fresh
  binary-only installs now detect live out of the box, and the /model
  picker offers Zen rows. 761/761 + 152/152 green; the full-e2e sweep
  remains owed to OC.5 (two prior runs externally stopped). — original
  goal + design: **Goal:** the gray path runs under its TRUE kind. **Build:**
  an optional `AgentSession.onBackendKind` seam (like `onResumeId`): the
  OpenCode session publishes the OC.3-classified kind + provider at start;
  the registry updates its `Backend` so the relay gate judges truth.
  **The race that shapes the design:** hello-kind is optimistic
  ("api-key"), so a relay viewport's FIRST prompt could slip the gate
  before classification lands — closed by a `kindVerified` flag on
  opencode Backends (server-side only): relay prompts refuse with an
  honest "still verifying" message until the session publishes, local
  viewports unaffected. Then the OC.3 session-level gray refusal lifts,
  replaced by a Mirafold-composed disclosure notice at session start
  (uncertainty stated, never permission — the codex CONNECT_HINT contract,
  session-time edition). **Done when:** Tier-1 covers publish→registry
  update, the pre-verification relay refusal, and the gray disclosure;
  the relay itest proves a subscription-classified session never runs a
  turn from a relay viewport.
- [x] **Step OC.5 — Tier sweep + live end-to-end** — completed 2026-08-13
  (one residual below): **`opencode-live.ltest.ts`** joins Tier 4 on the
  codex pattern (real binary, never a hosted model; the scripted
  OpenAI-compatible provider from the OC.2 probe; HOME/XDG jailed via a
  new transport `env` seam so a real engine run never touches the
  developer's own opencode state; skips cleanly when opencode isn't
  installed). One 17s test drives the WHOLE loop through shipped code:
  render through the real MCP stub, headless permission ask answered via
  the bridge, usage, kind publish (config→local), and **resume across a
  full engine restart**. All tiers green same-sitting: Tier-1 761/761,
  Tier-2 152/152, Tier-3 97/97 (the sweep owed since OC.4b — paid),
  Tier-4 1/1 live + verified clean skip. **Residual CONFIRMED by Kyle
  2026-08-13**: real global install (`npm i -g opencode-ai` — his npm's
  install-scripts blocking required the manual postinstall, the exact
  failure the transport's stderr surfacing named; the session's
  start-latch retry then worked as designed, no restarts) and a live
  browser session on Zen: "heyyyy it works". Phase OC complete.
  README/ADAPTERS.md refresh rides the wrapup.

## Gemini sunset (opened + ✅ COMPLETE 2026-08-13; Kyle-directed)

**Product call.** From the 2026-08-13 market check: Google retired Gemini
CLI upstream on 2026-06-18 (closed-source Antigravity replaced it; the
dated citation lives in provider-policy.ts's R.6 note). Kyle's calls, in
order: sunset rather than migrate (same day, morning), hold while other
work was in flight, then "do the gemini sunset" (same day, after Phase OC
merged). Shape: **gentle** — the API-key path still functions under the
Gemini API ToS, so nothing is removed or hidden; the adapter is deprecated
honestly. Removal is parked in POST-RELEASE.md, gated on evidence of
actual breakage, never on a calendar.

- [x] **Deprecation surface** — completed 2026-08-13: additive
  `AgentInfo.deprecated` (daemon-composed reason; the picker renders it as
  a suffix on the existing status line — no new element, the squeeze
  ramp's height budget holds), connect-hint copy updated with the dated
  retirement, a once-per-session dated notice in the Gemini adapter
  (Mirafold-composed, lands before the first turn completes), the
  provider-policy row annotated (policy itself unchanged), and the
  POST-RELEASE removal entry with its evidence gate. Tier-1 tests: the
  notice rides once and unbadged; `deprecated` rides the hello for gemini
  only.

## Phase RC — Remote CREATE of OpenCode sessions (opened + ✅ COMPLETE 2026-08-13; Kyle-directed)

**Why.** OC.4c's fail-closed design verifies an OpenCode session's credential
kind at its first turn: until the engine classifies the pinned provider, the
registry entry is `kindPending` and the relay gate refuses every remote
action. Consequence (recorded in POST-RELEASE.md 2026-08-13, promoted here
the same day at Kyle's direction): a remote viewport can ATTACH to an
OpenCode session only after a first local turn — it can never CREATE one.
Supporting remote creation means classifying BEFORE admitting the creator:
spawn the engine, read the provider catalog, judge the pin, and only then
attach the remote viewport. The gate itself does not change; only WHEN the
truth arrives does.

- [x] **RC.1 — the adapter seam.** — completed 2026-08-13. `AgentSession` gains optional
  `verifyBackendKind?(): Promise<void>`: resolve once the truthful kind has
  been published via `onBackendKind`, reject with the honest reason when it
  cannot be (no binary, no pin, provider not connected, policy refusal).
  OpenCode implements it as `ensureStarted()` — the full lazy-start path
  (engine + policy + engine session), whose failure already resets the outer
  latch so a later local prompt retries. No other adapter implements it:
  their hello-time kind is already truthful.
- [x] **RC.2 — the create path awaits truth.** — completed 2026-08-13
  (`attachOrReapClassified`; timeout env `VERIFY_KIND_TIMEOUT_MS`, 30s
  default). In `connection.ts`, a REMOTE
  create (and the attach-path fallback create) of an entry that is
  `kindPending` with a `verifyBackendKind` seam awaits classification —
  bounded (30s) — BEFORE `attachTo` judges the relay gate. Local creates are
  untouched: still synchronous, still lazy. On success the existing gate
  judges the now-truthful kind (an ineligible provider still refuses with
  the existing honest copy). On failure/timeout: the error goes to the
  viewport and the minted session is REAPED (`registry.end`) — the
  no-viewport leak rule from the 2026-07-29 bughunt applies unchanged. The
  async detour catches its own errors (index.ts has no try/catch around
  `handleMessage`).
- [x] **RC.3 — the races.** — completed 2026-08-13 (d landed as a comment
  correction only: the user-facing copy was already honest for the attach
  path, and remote creates no longer surface it). (a) Viewport disconnects mid-classify → on
  settle, a closed connection with a viewport-less entry reaps it. (b) A
  second create/attach on the same connection while one classification is in
  flight → refused honestly ("still verifying the previous create"); one
  pending create per connection. (c) Entry torn down mid-classify → the
  settle path checks `entries.get(id) === entry` before acting, like every
  onBackendKind consumer. (d) `relayGateRefusal`'s `kindPending` copy stays
  honest for BOTH paths now that remote creates verify inline: the
  "run its first turn from its own machine" sentence describes only the
  attach-to-existing case.
- [x] **RC.4 — tests** — completed 2026-08-13: 7 connection-grain tests in
  `server/sessions/remote-create.test.ts` (own process so the verify
  timeout pins via env before module load; a registry session-factory test
  seam injects the fake classifying session) + 2 adapter-grain in
  `opencode.test.ts` (`verifyBackendKind` resolves after publish / rejects
  honestly and stays retryable). Tiers 803/152/97 green. Original scope
  (Tier 2 grain, `makeTransport` seam; no real engine):
  Remote create allowed (kind publishes api-key → viewport attaches); remote
  create policy-refused (subscription pin → refusal + entry reaped, no
  MAX_SESSIONS leak); classify failure (engine start throws → honest error +
  reap); timeout (kind never publishes → bounded refusal + reap); disconnect
  mid-classify (no leak); local create unaffected (no await, still lazy).
  The existing remote-attach regressions stay green.

**Done when.** A relay viewport can create a fresh OpenCode session pinned to
an allowed provider and drive it immediately; a subscription/Zen pin is
refused at create with the honest reason and leaks nothing; all tiers green.

## Phase PN — Panes (file views beside the transcript)

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

- [x] **PF.1 — Server-side delta coalescing.** `broadcast()`
  (`server/sessions/registry.ts`) merges consecutive same-type
  `text_delta`/`thinking_delta` into one WireMsg (text = concatenation) on a
  33 ms window (`DELTA_COALESCE_MS`, env-overridable; constructor-injectable;
  `0` = passthrough). Any other message — or a delta of the other type —
  flushes first; attach (before ring replay), detach and session end all
  flush. The replay ring, seq, byte accounting, local sockets and relay
  sealing all see only merged frames (~3× fewer for text). Wire protocol
  untouched — a merged delta is an ordinary delta. Demo mode measured: 18
  flushes ~36 ms apart, ~3 mock chunks each — still visibly streaming.
- [x] **PF.2 — Client render batching + memoization.** RenderZone applies
  queued deltas one animation frame at a time (50 ms hidden-tab fallback;
  pure merge helper in `web/src/delta-queue.ts`, Tier-1-tested); non-delta
  messages flush first so order is exact. Transcript entry renderers,
  ToolBlock and RenderBlock are memoized; RenderBlock's zod `safeParse` runs
  per props change, not per render; the three per-render full-transcript
  scans (`pinnedItems`, `activePickerId`, `childrenByParent`) are
  `useMemo`'d. Follow-tail untouched (its docstring's instant-scroll
  rationale stands; it now fires per flush). `Artifact` deliberately NOT
  memoized (per-render closure props; restructuring touches the sandbox
  bridge). `bang_output` deliberately NOT coalesced (own id + wire-budget
  logic in `connection.ts`; PTY output is already chunky).
- [x] **PF.3 — Onboarding poll cost.** The 3 s `refresh_agents` poll no
  longer re-reads `~/.codex/config.toml` (2 s TTL, missing file never
  cached), re-probes credential files (2 s TTL) or re-fires the 8 localhost
  model probes (default sweep TTL 5 s, `MIRAFOLD_LOCAL_PROBE_TTL_MS`,
  in-flight callers coalesce; itest harness pins it to 0). Tradeoff, eyes
  open: a just-started local model server takes up to ~8 s to appear
  (was ~3 s).
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
