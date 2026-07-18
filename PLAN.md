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
  mono-in / rich-out, no bubbles ever, and the **visibility superset +
  collapse-on-finalize** rule (never show less than the terminal; noisy
  streams render live, then fold to a dim expandable line).
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

Phases 0, T, 1, 2, 3, T2, P, G, H, H2, and S are **done** — their steps and full dated
status notes now live in **PLAN-ARCHIVE.md** (moved out to keep this document
focused). Phases G (relay dedup — the sibling repo became the single source)
and H (human legibility) completed 2026-07-15 and were archived the same day.
Phase H2 (legibility follow-ups: `web/src/components/` + the root-doc tidy +
H2.3's removal of the `relay-service/` pointer directory) completed and was
archived 2026-07-15 as well.
Phase 4's completed steps (4.1–4.6, 4.8–4.10) joined them 2026-07-08; its
header stays below with the 4.7 → Phase R pointer. **2026-07-10:** the
fully-complete steps of Phases R, F, and L (R.1, R.3, R.4b–R.4k, F.1, F.3, F.4,
L.1) were archived the same way to lean this file out — each keeps a one-line
`[x]` pointer inline; the full Goal/Build/Files/Status is in PLAN-ARCHIVE.md
("Phase R / F / L — completed steps"). **2026-07-15 (second pass):** the done
steps of Phases K, F, and Q (K.1, K.3, K.8, K.9, K.11, K.12, F.2, Q.2–Q.5)
were archived the same way ("Phase K / Q — completed steps" + the R/F/L
section for F.2). **2026-07-17 (third pass):** Phase S whole (its
standing rules keep a summary block below), the done steps 4.11 / K.5 /
K.7 / F.7 / F.8, and the full bodies + status histories of the
still-open K.4 / R.2 / R.4 (each keeps a compact stub inline) — all under
"Moved 2026-07-17" in PLAN-ARCHIVE.md. Only OPEN steps carry their full
body here. Everything below marked `[ ]` is the remaining work.

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
    and the site; validation-window personal liability is accepted, shielded by
    K.5's ToS liability cap + consequential-damages exclusion. **When the
    trigger fires:** form the CA single-member LLC (~$70 + $800/yr franchise
    tax), EIN (free), business bank account, **convert the Paddle account from
    individual to business** (supported flow via `sellers@paddle.com` — a
    re-verification cycle, not a rebuild), swap the entity name into ToS / site
    footer / both LICENSE lines, and file the trademark (K.10) under the LLC.

- [x] **Step K.3 — Provider-terms re-verification** — done 2026-07-15 (+ same-day amendment); every row pinned to a dated primary source: the Anthropic ban verbatim, Gemini individual-account service ended 2026-06-18 (API keys continue; Antigravity succession check → R.6), and the codex row first flipped to blocked (no written permission exists), then re-flipped by Kyle to allowed-locally as a disclosed gray area — locking the standing **disclosed-uncertainty rule** (canonical statement in `server/provider-policy.ts`). All four tiers green, twice. → PLAN-ARCHIVE.md.

- [ ] **Step K.4 — Merchant-of-record billing** — 🟡 vendor locked: **PADDLE**
  (investigation 2026-07-15; every hard requirement from BUSINESS §7 + R.5
  verified native against Paddle's docs: card-required 7-day trial,
  cancel-at-period-end, $12/mo · $99/yr, signed `trialing`/`active`
  lifecycle webhooks that map verbatim onto the Ed25519 minting rule,
  hosted checkout from a static page, MoR tax; fees 5% + 50¢, accepted.
  Field comparison — Lemon Squeezy / Stripe Managed Payments / Polar /
  Creem — and the FTC-rule→ROSCA citation correction: → PLAN-ARCHIVE.md).
  Account created 2026-07-16 as **individual/sole trader** (no entity
  required — the finding that deferred K.2). **2026-07-17: both Paddle
  reviews submitted and pending** — domain approval (`mirafold.com`,
  Pending at `/request-domain-approval`) and account verification (the
  KYC form, completed + in review; sole prop, trading name Mirafold,
  business start 2026-07-11, pricing URL `mirafold.com/#pricing`).
  Payout/bank details: an anytime-before-revenue dashboard item. Full
  status history → PLAN-ARCHIVE.md.
  - Done when: both reviews pass and R.5's checkout → webhook →
    entitlement-minting build runs against the account.

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
  entity-name swap. Small chore owed: swap the contact page's temporary
  personal phone for Google Voice once its ID check clears. Full build
  spec + amendments + status history → PLAN-ARCHIVE.md.

- [ ] **Step K.6 — Claim accuracy + third-party trademark hygiene**
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

- [x] **Step K.7 — SECURITY.md + vulnerability-disclosure contact (both repos)** — done 2026-07-16; SECURITY.md in both repos (7-day acknowledgment, no bounty, latest-release support, each pointing at its repo's real attack surface), and `security@` + `support@mirafold.com` live via Cloudflare Email Routing → verified inbox, end-to-end tested (leftover Namecheap MX removed; Gmail never-spam filters set). → PLAN-ARCHIVE.md.

- [x] **Step K.8 — Dependency license scan** — done 2026-07-15; no copyleft in either production tree (shell: MIT/ISC/Apache/BSD + the proprietary Anthropic Agent SDK, stated plainly in README §12; relay: just `ws`, MIT — stale lockfile metadata resynced). Copyright-line swap to the entity stays owed to K.2. → PLAN-ARCHIVE.md.

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

- [x] **Step K.12 — Compliance closure notes** — done 2026-07-15; dated closures, each with its basis: EU AI Act (neither provider nor deployer; faithful-skin rule avoids Art. 25 requalification), EAA (microenterprise exemption; checkout UI is Paddle's), ePrivacy (no cookies/telemetry anywhere — verified in code and live), plus ECPA/OFAC/money-transmission one-liners. → PLAN-ARCHIVE.md.

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

- [ ] **Step R.2 — The relay service, deployed**
  - Goal: the dumb forwarder, running in the world.
  - Status: **DEPLOYED and verified in production.** The standalone
    `genui-relay` repo (single source of truth since G.1) is a
    dependency-light (`ws` only) portable Node process — a PURE forwarder:
    parses no frames, stores nothing, serves NO app bundle (the phone app
    loads from the separate static origin, then opens the encrypted
    socket — the documented trust decision). Hardening: global + per-pair
    + per-IP connection caps, frame rate limit, heartbeat reaper, max
    payload, `/health` + 404-everything. Live at `genui-relay.fly.dev`,
    under our name at **`wss://relay.mirafold.sh`** (cert issued; smoke
    passes; a real daemon streamed a full turn while `fly logs` showed
    only connection metadata — the "learned nothing" Done-when, observed
    in production). Full build/deploy/rename history (incl. the GENUI® →
    Mirafold naming story) → PLAN-ARCHIVE.md ("Step R.2 — status history"
    + the 2026-07-17 move).
  - Open to close the box: (1) the **cellular-phone pass** — same flow on
    LTE with wifi off, plus the wifi→LTE mid-turn flip (also R.6's
    real-hardware check; needs only Kyle + signal). (2) **Bake the default
    `MIRAFOLD_RELAY_URL`** (`wss://relay.mirafold.sh`) — today the relay is
    OFF when the env var is unset; baking the default turns it on for
    everyone, so it lands WITH R.5's entitlement gate, never before (R.5's
    explicit launch blocker). (3) The codebase/npm/GitHub **rename**
    genui-shell → mirafold rides this step (domains bought 2026-07-11;
    the Fly app name stays `genui-relay`, internal rename optional).
  - Done when: a phone on cellular (not the home wifi) drives a home
    session through the deployed relay, and the relay's logs show it
    learned nothing but connection metadata.

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
  - Open: the cellular pass (R.2/R.6's LTE check) closes this box; the
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
       Claude/Gemini subscriptions are prohibited in writing (never a
       choice), while Codex subscription is live locally only as a
       disclosed gray area (the K.3 disclosed-uncertainty rule — its
       caveat must ride the option), and no subscription ever rides the
       relay; the flow has to present that honestly per agent rather
       than offering a symmetric subscription-vs-keys fork. Also
       new vs. today: a model-selection step (today model comes from
       DEFAULT_MODEL/agent config, not the onboarding UI). Next action:
       a dedicated design discussion with Kyle BEFORE any build.
       **Status (2026-07-17): the design discussion HAPPENED and the build
       is scheduled — this item's outcome is Phase N** (the two-step
       agent → backing picker with probed local-server discovery; the four
       hard requirements carried into Phase N's charter verbatim). This
       item closes when Phase N ships; items 1–3 remain open intake.
  - Done when: each item above is enumerated concretely with Kyle,
    triaged (fix now / R.6 pre-release blocker / post-launch), and either
    fixed or explicitly scheduled — and the permissions fidelity item has
    a written terminal-vs-shell comparison behind whatever triage it gets.

- [ ] **Step R.5 — Entitlement + billing** *(needs Kyle: Stripe account +
  price confirmation — BUSINESS.md §7 says $12/mo · $99/yr, held over
  $10/$79.99 on 2026-07-11)*
  - Goal: paying unlocks the relay, on launch day, with almost nothing
    standing between "want" and "paid."
  - **Phase K reshapes this step (2026-07-15; K.4 investigation done same
    day):** K.2 (the entity) is a hard prerequisite for any live payment
    configuration, and the billing vendor is now a **merchant of record —
    Paddle recommended** (K.4's verified checklist; Kyle confirms at account
    creation). The Ed25519 entitlement-token design and the relay-side check
    are vendor-agnostic and stand as built — Paddle's subscription statuses
    (`trialing`/`active`) map verbatim onto the "admit when trialing OR
    active" rule. Read the Stripe-specific text below through that mapping
    (Stripe Checkout → Paddle hosted checkout/overlay; `trial_period_days=7`
    → Paddle card-required free trial; `cancel_at_period_end` → Paddle
    scheduled cancel; Stripe webhook → Paddle signed subscription webhooks
    feeding the same minting backend). Tax, FTC negative-option mechanics,
    and EU withdrawal disclosures ride with the MoR. Sequencing: K.2 →
    K.5's ToS/privacy pages live (Paddle site verification needs them) →
    Paddle account (sandbox first) → build here.
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
    **Still owed (needs Kyle; vendor now Paddle per K.4):** (1) the Paddle
    **sandbox account + API/webhook credentials** (sandbox needs no site
    verification — start any time; the LIVE account needs the K.2 entity and
    K.5's pages for Paddle's site review) to build the checkout + minting
    half; (2) the **decision — where the minting backend lives**
    (recommended: a Cloudflare Pages Function on mirafold.com — $0, no new
    infra — which on Paddle's `subscription.trialing`/`.activated`/
    `.canceled` webhooks mints/expires the signed token; alt: a small Fly
    service). (3) Then: the daemon side (dial-out sends the header;
    genui-shell app code — hold until the other session frees it), and the
    R.5 open refinements (token→account binding vs. sharing,
    revocation-before-expiry window, and — 2026-07-12 audit, B2 — a
    relay-side **max token lifetime** backstop that rejects an implausibly
    long-lived `exp` even from a buggy or compromised minter). Pricing
    $12/$99 · 7-day card-required trial · cancel-at-period-end stands per
    BUSINESS §7 unless recut — all three verified native in Paddle (K.4).
    **Launch blocker (2026-07-12 audit, B2):** flipping the relay ON for everyone
    (baking the default `MIRAFOLD_RELAY_URL`, see R.2) must land **with**
    `RELAY_ENTITLEMENT_PUBLIC_KEY` set — never before. An open relay with the gate
    off lets anyone squat the pair/connection caps and lock real daemons out, so
    "entitlement gate ON at deploy" is an explicit gate on R.7, not just an owed item.
  - Done when: a sandbox-mode purchase (Paddle test checkout, per K.4)
    unlocks pairing end-to-end, and expiry re-locks it without breaking the
    local product in any way.

- [ ] **Step R.5b — Release strategy, locked (all three repos)** *(a
  decision to make + write down, not a build; do before R.6's final week)*
  - Goal: one agreed, written release sequence so R.6/R.7 execute a plan
    instead of improvising how each piece ships.
  - Decide and record: (a) **shape of the release** — private beta / staged
    rollout vs. the single M1+M2+M3 public splash R.7 currently assumes;
    (b) **per-repo mechanics + order** — `genui-shell` (repo public + `npm
    publish` + versioning/cadence), `genui-relay` (deploy pipeline, **when
    the repo flips public — owed to K.1, which relicensed it MIT**, when the
    entitlement gate flips ON, when the default `MIRAFOLD_RELAY_URL` bake
    lands — see R.2), `mirafold-site` (checkout button flip, demo swap); (c)
    **rollback / kill-switch** for each (the relay gate and per-daemon relay
    URL are the levers); (d) how the codebase/npm/GitHub rename (R.2) is
    sequenced into all of the above; (e) *already decided 2026-07-15
    (K.9): contributor policy is **DCO**, not CLA* — `Signed-off-by` per
    commit, CONTRIBUTING.md landed in both repos that day; what remains
    for this step is only the mechanics: enable the GitHub DCO status
    check on both repos as part of the public flip.
  - **Gate on the relay flip (2026-07-15 audit):** before `genui-relay` goes
    public in (b), run a dedicated security-audit pass over that repo — the
    shell got its own on 2026-07-15; public security-marketed code gets
    adversarial readers on day one, so the relay flips only after its pass.
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
  - **Gemini CLI succession check (from K.3's re-verification, 2026-07-15):**
    Google stopped serving Gemini CLI requests for individual accounts on
    2026-06-18 and announced **Antigravity CLI** as the successor terminal
    agent (API-key/enterprise users continue on the legacy CLI for now).
    Verify our `gemini-cli` adapter still drives a real turn with an API key
    on current bits, and write down the Antigravity question (new adapter?
    rename? drop?) as a post-launch decision — the faithful-skin seam means
    it's one adapter either way, not a rewrite.
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
    - [ ] Cap the model-label length where it enters the wire (2026-07-16
      audit, hardening tier — no live risk): the label comes from
      engine-controlled sources (Claude `system/init`, the Codex rollout
      file, Gemini stats) with no length bound, so a corrupt source could
      bloat every `sessions` broadcast and the status bar. One `slice()` at
      the registry/usage emission covers all adapters at once — same
      philosophy as R.4d's `!`-output cap. React escaping already makes a
      hostile string inert (verified); this is bloat insurance only.
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
  - **Launch-week provider-terms re-check (K.3's standing item):** within
    the launch week, re-verify all three rows of `server/provider-policy.ts`
    against current provider documents and re-date the file — all three
    providers moved within H1 2026, and launching on a stale row is exactly
    the exposure K.3 exists to close. Includes re-checking the codex
    disclosed-gray-area row both ways: a written OpenAI allowance would let
    its caveat drop; signs of enforcement (the Anthropic pattern:
    server-side blocks first, docs later) mean flipping it to blocked —
    one line, the copy sits ready.
  - **Tracked-docs & history disclosure review (2026-07-15 audit):** before
    "repo public", read what actually goes public — the full git history plus
    tracked candor docs (`BUSINESS.md`, `PLAN.md`/archive: pricing strategy,
    provider-policy legal reasoning, negotiation-sensitive detail). Decide
    keep / trim / move-private for each; no secrets exist in history
    (verified 2026-07-15), this is a business-disclosure call, not a leak hunt.
  - **Theme guards: constrain token VALUES before accepting community theme
    PRs (2026-07-16 audit):** the Tier-1 guards pin token names exactly but
    not values — a contributed theme file could carry a working-but-weird
    value (e.g. `url(...)` in a color slot). The shell CSP already blocks
    the fetch at runtime and a reviewer sees the diff, so this is
    belt-and-suspenders: add a guard asserting values parse as
    colors/alpha-colors/shadow lists, so `yarn test` rejects it
    mechanically. Matters only once the repo is public and taking PRs —
    land it with (or before) the public flip.
  - **SECURITY.md: name the `!`-output → model path (2026-07-17 audit):**
    before the repo goes public, add one short note: a finished `!`
    command's transcript is fed to the agent as its own turn (terminal
    parity), so untrusted text a command fetches (e.g. a curl'd page) can
    try to steer the agent — the permission prompts are the backstop, and
    the fence escaping in `server/sessions/connection.ts` keeps output from
    faking its way out of its transcript block. Public-repo readers should
    find this stated, not discover it.
  - Build, same day, in order: repo public → `npm publish` over the 0.0.1
    placeholder → verify `npx mirafold` against the real registry (the
    one check that's unverifiable until publish) → post (X + Show HN +
    r/ClaudeAI + r/LocalLLaMA with the "BYOK or fully local" line) with
    Pro purchasable from minute one.
  - Done when: a stranger can watch the GIF, install cold, run their own
    agent, pay, and drive it from their phone — all within the launch
    hour. Signals per BUSINESS.md §9 read concurrently from here.

---

## Phase N — Onboarding backend picker (opened 2026-07-17; the R.4l item-4 redesign, executed)

Origin: the dedicated design discussion R.4l item 4 called for happened
2026-07-17 (Kyle + assistant), triggered by a real confusion on Kyle's own
machine: with BOTH an OpenAI API key and a ChatGPT subscription configured,
clicking Codex gives no indication of which credential the session will use
(today: the API key silently wins — hardcoded precedence in
`credentialKind()`), and pointing Claude Code at a local model is possible
only via pre-launch env config (`ANTHROPIC_BASE_URL`), outside the flow.
Kyle's bar, verbatim in spirit: "this should be obvious and easy from this
flow in the ui, i shouldn't have to go anywhere else or do anything else
provided i have the setup for these already handled."

**The locked design (Kyle, 2026-07-17):** a **two-step selection**. Step one
is the existing agent picker. Step two — shown only when an agent has more
than one way to run — lists **how it's backed**, built from what's already
configured on the machine: detected credentials (API key, subscription where
policy allows) plus **every compatible local model server currently
running**, discovered by probing. R.4l item 4's four hard requirements carry
over unchanged: (a) simple af; (b) surface what the user ALREADY HAS; (c)
unavailable options stay VISIBLE but clearly unavailable (gray, never
hidden); (d) each unavailable option carries how-to-get-it inline.

Design decisions settled in the 2026-07-17 discussion:

- **Local discovery is HTTP probing, never filesystem scanning.** Probe the
  well-known localhost ports (Ollama 11434, LM Studio 1234, vLLM 8000,
  llama.cpp 8080) with `GET /v1/models` — the de facto standard every local
  runtime serves; a server that answers hands back its downloaded-model
  catalog (no model need be loaded in memory). Model files on disk with no
  server running are deliberately invisible: per-tool storage layouts are
  unstable, and an unserved model is unusable anyway. Nonstandard ports get
  an env escape hatch, not a flow.
- **Dialect filtering per agent.** What determines compatibility is the API
  dialect the server speaks, not the model: Ollama speaks both the
  Anthropic-shaped and OpenAI-shaped APIs → its models list under Claude
  Code AND Codex; LM Studio/vLLM/llama.cpp are OpenAI-shaped only → Codex
  only; Gemini CLI has no BYO-endpoint path → never shows local options. No
  agent's list ever contains an option it can't actually drive.
- **The "it will show here" promise is live.** Under each local-capable
  agent, a hint line: start your local server and it appears here (worded so
  Ollama users — whose server idles perpetually as a background service —
  aren't told to do a step they don't have). The daemon re-probes while the
  picker is open and pushes updates, so the promise is literal — no reload.
- **Provider policy governs choosability, verbatim.** The second step
  re-stages `provider-policy.ts` per option, and improves its presentation: a
  blocked Claude/Gemini subscription becomes one grayed row with the why +
  API-key fix (instead of tainting the whole agent tile), and the Codex
  subscription option carries the disclosed-uncertainty caveat
  (uncertainty stated, never permission — the K.3 rule). The server NEVER
  trusts the client's choice: every `create` re-validates against detection
  + policy server-side.
- **Explicit choice replaces silent precedence.** Once this phase lands, a
  user with multiple credentials picks; the daemon never again silently
  prefers one. Single-option agents skip step two entirely (simple af).

Out of scope, unchanged: the relay bound (NO subscription ever rides the
paid relay — R.5's gate is untouched); L.2's `--local` CLI easy-mode (this
phase lands the detection substrate L.2 will reuse; the one-command CLI
flow stays demand-gated); model *download* management (we list what a
server offers, we never pull models).

Sequencing: prioritized by Kyle 2026-07-17 as the next build work. Not
formally an R.7 gate, but land it before R.5c's user-testing round so
testers meet the real flow. Wire rule throughout: additive only (new
optional fields / message types), per the locked protocol contract.

- [x] **Step N.1 — Enumerate configured backends (server-side truth)**
  — done 2026-07-17: `backendOptions(agent)` + exported `BackendOption`
  beside `credentialKind()` (which keeps its single-answer precedence as
  the default until N.5); five Tier-1 tests pin codex key+login → two
  usable options, claude endpoint+key+login → three with the subscription
  blocked-but-visible, empty menus, gemini's single option, and the model
  detail. Tier-1 189/189, Tier-2 77/77.
  - Goal: the daemon knows EVERY way each agent could run on this machine,
    instead of collapsing to one credential via hardcoded precedence.
  - Build: beside `credentialKind()` in `server/adapters/index.ts`, a
    `backendOptions(agent)` that returns ALL detected options, each
    `{ kind, usable, detail?, blocked? }`: codex with both `OPENAI_API_KEY`
    and `~/.codex/auth.json` present → two options (api-key AND
    subscription); claude-code with `ANTHROPIC_BASE_URL` and/or
    `ANTHROPIC_API_KEY` and/or `~/.claude/.credentials.json` → each present
    one listed (subscription marked blocked-but-visible per policy);
    gemini-cli → api-key only. `usable` comes from `allowedLocally()` —
    policy consumed, never re-encoded. Existing `credentialKind()` /
    `availableAgents()` behavior and the wire stay untouched this step.
  - Files: `server/adapters/index.ts` (+ `index.test.ts`).
  - Done when: Tier-1 tests pin the both-present cases (codex key+login →
    two options; claude endpoint+key+login → three, subscription blocked)
    and every existing suite stays green.

- [x] **Step N.2 — Local model server discovery (the probe)**
  — done 2026-07-17: `server/local-models.ts` (probeTargets / probeLocalServers /
  cachedLocalServers; 500ms per-probe budget, parallel, failure-silent,
  fire-and-forget cache; /api/tags answering = the Ollama fingerprint →
  anthropic+openai dialects, /v1/models alone → openai; model-count/name
  caps as bloat insurance). Six Tier-1 fixture tests: ollama shape,
  openai-only shape, dead port, malformed/empty catalogs, hung-socket
  bound, env escape-hatch parsing (pure — real ports never probed in
  tests). Tier-1 195/195; Tier-2 untouched by design (no callers yet —
  N.3 wires it).
  - Goal: a running Ollama / LM Studio / vLLM / llama.cpp shows up with its
    model catalog, automatically, without config.
  - Build: new `server/local-models.ts`: probe the four default localhost
    ports with a short per-probe timeout; parse `GET /v1/models` (all
    runtimes) and Ollama's richer native `/api/tags`; tag each found server
    with the dialects it speaks (Ollama: anthropic+openai; others: openai).
    `MIRAFOLD_LOCAL_ENDPOINTS` (comma-separated URLs) adds nonstandard
    ports. Async and failure-silent — a probe must never delay daemon
    startup or error a session; results cached with an on-demand re-probe
    function (N.3 drives it). Localhost + env-listed endpoints only —
    nothing else is ever probed.
  - Files: `server/local-models.ts` (+ test against fixture HTTP servers on
    ephemeral ports — found / absent / malformed / slow).
  - Done when: Tier-1 fixture tests prove discovery, dialect tagging, the
    env escape hatch, and the never-blocks property; suites green.

- [x] **Step N.3 — Advertise backends on the wire (additive) + live re-probe**
  — done 2026-07-17: additive `backends?: AgentBackend[]` per agents-hello
  row (credential options + dialect-filtered discovered servers, merged in
  `mergeBackends()` — an env ANTHROPIC_BASE_URL naming a discovered server
  dedupes to the richer discovered row, localhost≡127.0.0.1) + additive
  `refresh_agents` ClientMsg (per-connection probe throttle,
  `REFRESH_MIN_INTERVAL_MS`, throttled hits answer from cache; async resend
  guards a closed socket). Startup fire-and-forget probe in index.ts.
  `MIRAFOLD_LOCAL_DISCOVERY=off` skips the well-known ports (privacy
  opt-out + what keeps itests hermetic — forced in the harness so a dev
  machine's real Ollama can't leak into assertions). Q.2 fixtures updated;
  `web/src/ws.ts` needed NO change (types flow via @protocol; unknown
  fields pass through). New Tier-2 `agents-refresh.itest.ts`: fixture
  ollama appears dialect-filtered (claude+codex yes, gemini no) and
  disappears on refresh after the server stops. Tier-1 201/201, Tier-2
  78/78.
  - Goal: the browser learns each agent's full option list, and the list
    stays current while the picker is open.
  - Build: an additive optional `backends` field on the agents hello — per
    agent, the N.1 credential options plus N.2's local servers filtered to
    that agent's dialect (endpoint host + model names; never a secret —
    the secrets-stay-server-side rule). A re-probe path: an additive
    `refresh_agents` ClientMsg the picker sends periodically while open
    (server re-probes, re-sends the hello). Update Q.2's golden fixtures
    for the new field; the R.4h tolerant client schemas make old clients
    strip it silently.
  - Files: `server/protocol.ts`, `server/sessions/connection.ts`,
    `server/adapters/index.ts`, protocol fixtures, `web/src/ws.ts`.
  - Done when: Tier-2 (real daemon) shows a fixture local server appearing
    in the hello and appearing/disappearing across a `refresh_agents`
    round-trip; protocol-freeze and compat tests green.

- [x] **Step N.4 — The second-step picker UI**
  — done 2026-07-17: Onboarding grows the second panel (both mounts —
  Shell and FleetView — get it, with a 3s refresh_agents poll while the
  card is open); rows per the charter: usable credentials as buttons, the
  codex subscription with the K.3 caveat inline, blocked subscriptions
  visible-but-gray (disabled) with the why, discovered servers as
  runtime·host headers whose model catalog is the buttons, the live hint
  when no server; Esc/backdrop steps BACK from the panel before
  dismissing the card. Second step appears only for a genuine choice
  (>1 usable, or a model to pick); single-usable/demo keep one-click.
  Deviations, both deliberate: (1) create's `backend` field pulled
  forward from N.5 (additive; the client sends the choice now, the
  server validates + honors it in N.5); (2) the e2e drives the panel
  display-only — clicking a live-credential row would spawn a real
  engine, so create-through-choice is proven in N.5's Tier-2 and N.6's
  live pass. New e2e: two-cred codex panel + caveat, fixture ollama
  appearing LIVE mid-open via the poll, dialect row under claude, gray
  disabled blocked row, env-endpoint row kept distinct, gemini
  one-click demo create. Tier-1 201/201, Tier-3 28/28 (Tier-2
  untouched since N.3's 78/78 — type-only protocol additions).
  - Goal: click an agent → see how it can be backed; obvious and easy, no
    docs detour, per Kyle's (a)–(d).
  - Build: `Onboarding.tsx` grows the second panel, shown only when the
    clicked agent has >1 option (otherwise straight through, exactly
    today's behavior). Rows: usable options first (API key · detail,
    subscription with the codex caveat inline, each local server with its
    models — picking a model picks the backend); unavailable options
    grayed but VISIBLE with the existing how-to-get-it copy re-staged
    (`agents-meta.ts` hints become per-option, not per-agent); the live
    "start it and it appears here" line under local-capable agents (its
    arrival animates in via N.3's refresh — replaces the current
    `onb-local-note` footnote and its docs pointer); back/Esc returns to
    the agent list; `onPick` carries the chosen backend.
  - Files: `web/src/components/Onboarding.tsx`, `web/src/agents-meta.ts`,
    `web/src/styles.css`.
  - Done when: Tier-3 headless-Chrome e2e drives agent-click → backend
    list → pick against fixture data, including a grayed blocked row
    (visible, unclickable-to-create, hint shown) and a local server
    appearing live mid-open; single-option agents still create in one
    click.

- [x] **Step N.5 — Session creation honors the choice**
  — done 2026-07-17: `resolveChosenBackend()` (adapters/index.ts) is the
  never-trust-the-client gate — validates kind against live detection +
  provider policy, a discovered endpoint against the probe cache (dialect
  + model-in-catalog; stale/gone refuses with a re-pick message), runs in
  connection.ts's create case (registry only ever sees a pre-validated
  Backend). Adapters enforce per-session through each SDK's own env/config,
  never a process.env mutation: claude — discovered endpoint gets the
  docs/local-models.md recipe (BASE_URL + dummy AUTH_TOKEN, real key
  WITHHELD), api-key choice strips a global BASE_URL, no choice inherits
  (pre-N byte-identical); codex — subscription choice withholds the env
  key (explicit pick beats env precedence), api-key passes it, discovered
  endpoint injects the documented custom-provider config
  (`mirafold_local`, wire_api "responses") merged with the MCP config.
  Proofs: 12 new Tier-1 (engine-options capture via claude's `engine` +
  a new codex `makeCodex` seam; resolve validation matrix) + 4 new Tier-2
  (opposite codex choices logged as resolved; forged prohibited refuses
  with no session; a discovered-server pick's model label arrives on
  session_created — wire-observable; stale pick refuses). Tier-1 213/213,
  Tier-2 82/82, Tier-3 fail 0.
  - Goal: the picked backend is what the session actually runs on — silent
    precedence is gone for good.
  - Build: the `create` ClientMsg gains an optional backend choice
    `{ kind, endpoint?, model? }` (additive). The server RE-VALIDATES it
    against current detection + `provider-policy.ts` — a forged, stale, or
    prohibited choice is refused down the existing error path (the client
    is never trusted). `createSession`/adapters configure per-session:
    codex passes `apiKey` only when api-key was chosen and withholds the
    env var from the engine when subscription was chosen; claude-code sets
    the base URL per-session (SDK env/options, NOT global `process.env`
    mutation); local picks pass the chosen model. Fleet + status bar show
    the backing via the existing model-label machinery.
  - Files: `server/protocol.ts`, `server/adapters/index.ts`, the three
    adapters as touched, `server/sessions/connection.ts`, fixtures + tests
    in Tiers 1–2.
  - Done when: Tier-2, with both codex credentials present in a fixture
    env, two sessions created with opposite choices provably configure the
    engine differently; a forged prohibited choice is refused; all tiers
    green.

- [x] **Step N.6 — Live verification + docs reconciliation**
  — done 2026-07-17, on Kyle's real machine (real .env key, real codex
  login, real claude login, real running Ollama). **Verified live:** the
  hello shows exactly the expected menu (claude: api-key +
  blocked-subscription + ollama·qwen3-1.7b-32k; codex: subscription +
  ollama; gemini: api-key only); **codex on the ChatGPT subscription drove
  a real turn (5.1s, "ok")** and **claude on the API key drove a real turn
  (5.0s, "ok")**, each with its resolved-backend log line. **Honest
  finding on the local paths:** the pick is demonstrably honored — the
  codex pick delivered its 8,035-token agent prompt INTO Ollama (observed
  in the runner's slot state: our injected provider config end-to-end) and
  the claude pick spawned the runner with the per-session env — but a
  1.7B thinking model on CPU cannot PREFILL an agent-sized prompt before
  the SDK's own request timeout, so the turn retries forever (tried up to
  25 min; 4 honest retry notices — the F.2 machinery working as designed).
  Not a code defect: the docs' own model table calls sub-8B models below
  the agent-work floor. Local turn COMPLETION re-verify with a realistic
  model/hardware added to R.6's real-hardware checks. **Docs:**
  local-models.md now leads with the zero-config discovery path (dummy-key
  wart scoped to config-file-only setups), .env.example documents
  MIRAFOLD_LOCAL_ENDPOINTS / MIRAFOLD_LOCAL_DISCOVERY, README component
  map + env-knob list updated.

**Phase N security audit (2026-07-17, same day) — clean, three hardenings
landed immediately** (Kyle's standing rule, recorded here: a theoretical
finding whose fix is minimal with no downside gets fixed NOW, not
roadmapped): (1) the probe caps response SIZE (1 MB, chunked read) not just
time — a hostile local listener can no longer memory-spike the daemon;
(2) the codex local-endpoint branch withholds OPENAI_API_KEY from the
engine env (symmetry with claude's local branch — no key near a local
server); (3) SECURITY.md gained a "Known trust decisions" section
disclosing that local servers can't be authenticated (spoofing on shared
machines) with the guards + the discovery off-switch named. Verified: the
client can never steer an agent at an arbitrary URL (endpoint validated
against the daemon's own probe cache), no secrets ride the new wire
fields, and the relay's no-subscription gate carries through chosen
backends. No-action findings (recorded): backends list reaches paired
remote viewports (paired-device trust); per-connection probe throttle
amplification (gated + negligible). The R.7 `!`-output SECURITY.md note
still rides R.7 as planned.

**Phase N is COMPLETE (2026-07-17)** — all six steps shipped in one day;
final suite state Tier-1 213/213, Tier-2 82/82, Tier-3 28/28. One
residual rides R.6 (local-turn completion on realistic hardware). One
cosmetic note for a polish pass (R.4l intake): a credential-less agent
with a discovered local server still shows "no credentials · demo" on its
AGENT row while its second step correctly offers the usable local pick —
the row label could acknowledge the discovered backing.
  - Goal: the flow proven against real backends (the test suite never
    reaches a real model — this is the manual pass), and the docs tell the
    same story the UI now shows.
  - Build: on Kyle's real setup (OpenAI key + ChatGPT login + a local
    model server), verify every path end-to-end: each Codex choice drives
    a real turn on the right credential, a discovered local model drives
    Claude Code and/or Codex, the live-appear hint works with a real
    server start. Reconcile `docs/local-models.md` (auto-discovery
    exists; env config becomes the fallback), README's onboarding blurb,
    and `.env.example`.
  - Done when: Kyle's actual machine shows every expected option, each
    picked backend demonstrably runs on what was picked, and no doc
    describes the old single-credential behavior as current.

---

## Phase V — Visual + fidelity gaps flagged by Kyle (opened 2026-07-17)

Origin: two deficiencies Kyle flagged directly from using the shipped
product. Ordered here in the **reverse** of how he raised them (his
explicit instruction) — contrast first, Codex/Gemini fidelity second —
because the contrast problem cuts at the project's core justification.
Sequencing: opened as the next work after Phase N. Not yet graded against
R.5c/R.6/R.7 as launch-blocking; that call is Kyle's once each step below
is scoped further.

- [ ] **Step V.1 — Theme contrast pass (all six themes)** — *engineering
  landed 2026-07-18 in TWO rounds; open only on Kyle's side-by-side
  confirmation.* Round 1 confirmed the diagnosis (only --fg/--bg had a
  floor; the read-for-content dim tiers — --fg-dim
  timestamps/footers/notice line, --fg-dimmer thinking block/status
  bar/tool detail — shipped at 3.0–3.4:1; Solarized Dark's PRIMARY --fg was
  4.4:1 worst-case; Gruvbox --fg-faint 1.7:1) but its WCAG-shaped floors
  (fg ≥7, dim ≥4.5) still strained Kyle's eyes. Round 2 rebenchmarked on
  what Kyle actually named — a stock terminal, near-white on near-black at
  15:1+ for everything: floors are now terminal-grade
  (worst-case-surface: strong ≥12, fg ≥11, body ≥10.5, mid ≥8.5, dim ≥7,
  dimmer ≥5.5, faint ≥4.5 — the faintest tier now clears the old
  body-text minimum; accents ≥4.5 on --bg; pinned code-fg ≥11, diffs ≥6),
  dark themes' surface stacks are regenerated as tight envelopes of --bg
  so no backdrop eats the ratio, Gruvbox adopts its canonical HARD
  background (#1d2021), and Dracula's canvas darkens a step (same hue) —
  white text physically couldn't clear 12:1 on the canonical #282a36.
  Hue/saturation preserved everywhere; deviations noted per file header.
  Verified by screenshot walk of a real mock session in all six themes
  (real build, headless Chrome), not just the guard test. All tiers green
  219/82/28. Side-finding, flagged to Kyle: the picker showing two ✓ at
  once is the S.3 two-slot design (one pick per pill side), not a V.1
  regression. Watch item: one Tier-3 flake in ~4 runs (name uncaptured,
  green on all reruns) — same profile as the 2026-07-17 Tier-2 flake.
  Same-day follow-up (Kyle: round 2 "is better"): a SEVENTH theme,
  **Standard** (`standard.css`) — the plain-terminal theme, pure black
  canvas, neutral white/gray text ramp (no hue), the classic bright ANSI
  accent four (green/cyan/yellow/red); not a Base16 port, the reference
  is the stock terminal itself. Guards pass unchanged (the contract +
  floors machinery is exactly what made a 7th theme a one-file add);
  screenshot-verified; all tiers green 219/82/28.
  - Goal: Kyle, 2026-07-17: "every single style doesn't have enough
    contrast and strains the eyes to look at... this is something that
    regular terminals DO NOT have a problem with and it almost completely
    removes the entire justification for this project." A terminal
    successor that's harder to read than the terminal it replaces defeats
    Mirafold's stated identity (README §7: more pleasing to look at, not
    just better-formatted).
  - Diagnosis so far: `themes.test.ts` enforces a 4.5:1 WCAG-AA floor, but
    only on the single `--fg`/`--bg` pair — every other text tier
    (`--fg-mid`, `--fg-dim`, `--fg-dimmer`, `--fg-faint`, muted labels, the
    F.2 dim notice line, secondary/timestamp text) ships with **no**
    contrast floor at all, and 4.5:1 itself is the legal minimum for body
    text, not a comfortable target for a screen someone reads for a full
    session — most terminal color schemes aim well above it.
  - Build: audit real contrast ratios for every semantic token actually
    used as text, against its actual backdrop, in all six shipped themes;
    widen the floor test to cover every `--fg-*` tier (not just `--fg`),
    and re-tune token values where a theme fails a more honest bar. Sanity
    check against Kyle's own terminal color scheme as the comparison point
    he named.
  - Files: `web/src/themes/*.css`, `web/src/themes/manifest.ts`,
    `web/src/themes/themes.test.ts`.
  - Done when: Kyle confirms, side-by-side with his regular terminal, that
    reading a real session in each of the six themes no longer strains his
    eyes, and the widened contrast-floor test is green for every theme.

- [ ] **Step V.2 — Codex (and Gemini, untested) rendering/command fidelity
  gaps**
  - Goal: Kyle, 2026-07-17: Codex's `/model` in Mirafold does not show the
    full list the same command shows in a real terminal, and a requested
    chart/graph sometimes renders as a plain table instead — both are
    faithful-skin violations (CLAUDE.md non-negotiable: a Codex user gets
    Codex, nothing degraded). Kyle suspects Gemini has the same class of
    problem but has not yet tested it. Kyle's read: Claude was prioritized
    early in the project and Codex (and likely Gemini) fidelity lagged.
  - Diagnosis so far: no dedicated `/model` handling exists in
    `server/adapters/codex.ts` — slash commands ride the general F.1
    buffered-text path, so an interactive terminal picker likely degrades
    to whatever static text the SDK's headless `exec` surface emits, which
    may not carry Codex's full profile/model list. This is plausibly the
    same root cause F.5 already named (the Codex SDK drives a headless
    `exec` surface with no interactive round-trip) rather than a distinct
    bug — F.5's app-server migration may be the real fix, not a patch
    bolted onto `exec`. The chart-degrades-to-table symptom needs its own
    trace: whether the model itself is choosing `table` under Codex (a
    prompting/tool-description gap) or the adapter/registry is mis-mapping
    a `chart` instruction.
  - Build: live-probe terminal Codex's `/model` output vs. Mirafold's,
    side-by-side, and trace exactly where the list gets truncated;
    live-probe a chart-triggering prompt in terminal Codex vs. Mirafold and
    trace whether the model or the render path is responsible; run the
    same two probes against Gemini CLI once Codex is diagnosed, since Kyle
    flagged it as an open question, not a confirmed second bug. Fold
    findings into F.5 (Codex) / F.6 (Gemini) if root-caused there, or open
    new steps if not.
  - Files: `server/adapters/codex.ts`, `server/adapters/gemini.ts`,
    `server/render-tools.ts`, `server/render-mcp.ts` (chart tool
    description), PLAN.md F.5/F.6.
  - Done when: Codex's `/model` in Mirafold shows the same list terminal
    Codex shows, a chart prompt renders a chart (not a table) in Codex, and
    Gemini has been live-probed for both classes of gap with the result
    recorded here (confirmed-affected, or cleared).

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

- [x] **Step F.7 — Codex resolved-model label (closes F.3's codex gap)** — done 2026-07-16; the adapter reads the engine-resolved model from Codex's own rollout record (keyed by thread id; bounded poll; failure-silent; a configured `CODEX_MODEL` wins). Side-finding folded into F.5's rationale: the SDK vendors an older codex binary than the user's terminal, so SDK sessions can default to an older model. → PLAN-ARCHIVE.md.

- [x] **Step F.8 — `!` terminal parity + hardening** — done 2026-07-17 (Kyle: "we must never hide ANYTHING"); bang `cd` persists inside the workspace (EXIT-trap cwd handoff; an escape resets with the terminal's own notice), silent success renders "(completed with no output)", and the transcript reaches the agent immediately as its own turn (the engine's internal shell can't follow a bang `cd` — the one disclosed divergence). Same-day hardening: 0700 handoff dir, FIFO-stall gate, closing-fence escaping, 400ms bang throttle. F.3 extended: `session_created` carries the model label (status bar + fleet show agent → model from attach). SECURITY.md disclosure note queued under R.7. Tests in all three tiers. → PLAN-ARCHIVE.md.

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
    (4, added 2026-07-16 via F.7) **the SDK vendors its own codex binary**, so
    sessions can run an older default model than the user's terminal codex —
    observed: vendored 0.142.5 → gpt-5.5 vs terminal 0.144.5 → gpt-5.6-sol;
    the app-server surface drives the system codex and closes this too.
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

## Post-release ideas (intake opened 2026-07-15 — unordered; organize after R.7)

Feature ideas parked for after launch. This is deliberately an unordered
intake — the reordering/organizing pass happens when we get there,
post-R.7 — and none of these gates a Phase R step. Where an idea already
has a home in this plan, the entry points there instead of duplicating it.

- [ ] **Desktop app** — the first follower after release. An Electron shell
  so running Mirafold needs no terminal/Node/npm: a thin, separate repo that
  consumes the published `mirafold` package (which ships daemon + built
  client together, so there's no UI or server duplication) and opens the
  daemon's URL in its window. Shell-side seam to cut first: export a
  programmatic entry (`startDaemon(opts) → { url, close }`) beside the CLI.
  Known lifts beyond packaging: a folder picker replaces "run in the current
  directory," macOS launched-from-Finder PATH resolution, and
  signing/notarization + auto-update CI per platform.

- [ ] **Phone apps** — distant followers, behind the desktop app. The phone
  is a viewport, never the daemon host — the relay path (R.2–R.4) already
  *is* the phone architecture. Two stages: **(1) PWA** — manifest + service
  worker + mobile polish on the deployed app-origin bundle; near-free, no
  store, no new repo. **(2) Native store wrapper** (Capacitor-class, its own
  thin repo) only when push notifications / store presence earn the review
  and revenue-cut bureaucracy; push must stay content-free pings so the
  relay's E2E-blind story survives.

- [ ] **Subscriptions + metered model access (paid tier #2)** — sell
  Mirafold-provisioned, metered access to open models, so a subscriber gets
  a working model with zero key management. **Launch ships with the relay as
  the only paid product (locked 2026-07-15); this comes after.** Shape
  (from the 2026-07-15 design discussion): provision a scoped, spend-limited
  per-user key on an existing metered inference provider (OpenRouter-class)
  and bill from the provider's usage reports — the daemon talks to the
  provider **directly**, so Mirafold is never in the inference path and
  never sees a prompt (the no-proxy and E2E trust stories survive intact).
  Rides the agents' own custom-endpoint support (Anthropic-compatible
  endpoints, Codex custom providers) — no homegrown loop. Grows R.5's
  checkout + token-minting backend (the private billing service) with key
  provisioning, usage reconciliation, and a quota endpoint — **no new
  repo**. Enforcement is server-side only: open client code may *display*
  quota, never enforce it. Clean under the provider credential policy — this
  is the API-key path, no subscription-ToS exposure. Store-distribution
  caveat when it reaches phones: in-app purchase rules (15–30% cut, no true
  metered billing — credit packs/tiers instead); the PWA path avoids them.

- [ ] **Cockpit fleetview** — grow FleetView (4.6) into a true cockpit:
  at-a-glance live state of every session, and acting on sessions from the
  grid rather than only entering them.

- [ ] **Folder & file & diff view** — shell-owned project browsing: the
  working tree, file contents, and diffs of what the agent changed.

- [ ] **Multiuser chat** — multiple people in one session's conversation;
  rides Phase 4's multi-user seam (Locked decisions: "architected so
  multi-user is additive later").

- [ ] **Input augment** — drag & drop and paste (files, images) into the
  prompt box; eventually voice input. All shell-owned — the trusted-shell
  boundary is untouched.

- [ ] **Skills as buttons** — surface the agent's skills / slash commands as
  clickable shell affordances instead of typed invocations.

- [ ] **Action-button transparency** (2026-07-15 audit #5, optional
  hardening) — a question/card button's visible label can differ from the
  text it sends as the user's turn (both model-authored). Backstops exist
  (the sent text echoes visibly; consequential tools still ask), so this is
  comfort, not a hole: show the exact to-be-sent text on hover (title
  attribute) so a user can inspect before clicking.

- [ ] **Archived-session fleetview** — a fleetview over ended sessions, to
  find and resume old ones.

- [ ] **Visibility** — usage and metrics surfaced in the shell (tokens,
  cost, per-session and fleet-level), and more over time.

- [ ] **Live preview** — display the project while the agent builds it
  (e.g. the project's dev server rendered beside the session).

- [ ] **Grok agent** — a fourth adapter behind the `AgentSession` seam, same
  rules as Phase P (faithful skin, no agent privileged); demand-gated on
  xAI's agent tooling maturing.

- [ ] **More protocol components** — already started: the Stretch goals
  above (S.1 pie, S.2 stacked/horizontal, S.3 stat tile) are the first
  concrete batch; keep extending the registry additively (add message
  types/kinds, never reshape) as session needs surface.
  - ✅ 2026-07-15 — first batch landed: four new registry components
    (`key-value`, `progress`, `timeline`, `file-tree` — flat paths on the
    wire, nested client-side) plus an additive `kind` callout tint on `card`
    (info/success/warning/error). Each rides the full seam: registry-spec
    schema, render tool in BOTH servers (render-tools.ts + render-mcp.ts),
    RENDER_TOOL_COMPONENT entry, React component + registry entry, guidance
    line, mock payloads. All three test tiers green; observed rendering
    against the mock in headless Chrome.
  - ✅ 2026-07-15 — `question` registry component (`render_question`): a
    structured 2–4-option fork; clicking an option sends its text as the
    user's next turn over the existing Phase-2 prompt-action path, and the
    clicked copy locks (chosen marked, buttons disabled). Same full seam as
    the batch above, plus a deterministic mock hook (`playQuestion`,
    /question|choose|decide/) and a Tier-3 e2e driving the real click →
    user-turn round trip. All three tiers green (e2e 21/21).
  - ✅ 2026-07-15 — `diff` registry component (`render_diff`): red/green
    line diff of a made/proposed change, one entry per file. Schema takes
    BEFORE/AFTER SNIPPETS, never unified-patch text (models botch @@ line
    math; snippets need no bookkeeping) — the client diffs them via
    `web/src/diff.ts`, the LCS differ hoisted out of ToolBlock so
    agent-painted diffs and Edit/Write tool diffs render identically.
    Empty before = new file (pure +), empty after = deletion (pure −).
    Same full seam; all three tiers green.

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
