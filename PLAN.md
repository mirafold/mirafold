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
"Moved 2026-07-17" in PLAN-ARCHIVE.md. **2026-07-19 (fourth pass):** the
whole of the completed **Phase N** (N.1–N.6, onboarding backend picker) and
**Phase V** (V.1–V.3, visual + fidelity gaps) — their full bodies + status
histories under "Moved 2026-07-19" in PLAN-ARCHIVE.md; each phase keeps a
short summary + per-step one-line pointers inline. Only OPEN steps carry
their full body here. Everything below marked `[ ]` is the remaining work.

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
    and the site, with K.5's ToS liability cap + consequential-damages
    exclusion applying in the interim. **When the
    trigger fires:** form the CA single-member LLC (~$70 + $800/yr franchise
    tax), EIN (free), business bank account, **convert the Paddle account from
    individual to business** (supported flow via `sellers@paddle.com` — a
    re-verification cycle, not a rebuild), swap the entity name into ToS / site
    footer / both LICENSE lines, and file the trademark (K.10) under the LLC.

- [x] **Step K.3 — Provider-terms re-verification** — done 2026-07-15; every row pinned to a dated primary source: the Anthropic ban verbatim, Gemini individual-account service ended 2026-06-18 (API keys continue; Antigravity succession check → R.6), and the codex row settled as allowed-locally under the standing **disclosed-uncertainty rule** (no written permission exists, posture visibly permissive; canonical statement in `server/provider-policy.ts`). All four tiers green, twice. → PLAN-ARCHIVE.md.

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
  entity-name swap. Small chore owed: swap the contact page's phone for a
  dedicated Google Voice number once its ID check clears. Full build
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

- [x] **Step K.7 — SECURITY.md + vulnerability-disclosure contact (both repos)** — done 2026-07-16; SECURITY.md in both repos (7-day acknowledgment, no bounty, latest-release support, each pointing at its repo's real attack surface), and `security@` + `support@mirafold.com` live via Cloudflare Email Routing → verified inbox, end-to-end tested (leftover Namecheap MX removed; deliverability verified). → PLAN-ARCHIVE.md.

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
       *2026-07-22: phone-viewport pass landed (Kyle: page drifted
       sideways under a swipe; bottom buttons "clustered and haphazardly
       placed"). Fixes: the app frame is pinned (100dvh + `overflow-x:
       clip` + no overscroll — only the render zone scrolls); all
       focusable inputs ≥16px on phone (sub-16px made iOS zoom on focus
       and LEAVE the page zoomed = the sideways drift); viewport meta
       gains `viewport-fit=cover` + `interactive-widget=resizes-content`
       (keyboard shrinks the layout instead of covering the prompt); the
       status bar becomes two deliberate rows — one even strip of 40px
       controls (⌂ new ● · pair ⚙ ☀|☾ end, verified single-row at 390px),
       then a dim facts line (agent · model · cwd · Σ · $) — with phone-
       irrelevant plumbing hidden (session id, version, per-turn tokens);
       fleet header wraps as two deliberate lines; long unbroken tokens
       wrap in command strips; hover-only pin affordance hidden (its dock
       already was). New Tier-3 assertions in `phone.e2e.ts` pin the
       single-row control strip, ≥40px targets, and ≥16px prompt font;
       Tier-1 (315) + typecheck green. Committed (`7560383`) + pushed
       same day; the git-integrated Pages project rebuilt and the new
       bundle was VERIFIED LIVE at app.mirafold.com (served CSS carries
       the fixes) — Kyle's first phone look that day predated the deploy
       and saw the stale 07-13 bundle. (The pair-QR desktop test's stale
       URL expectation noted that day was fixed elsewhere — the suite is
       4/4 again.)*
       *2026-07-22 round 2 (Kyle's real-phone feedback on the deployed
       round 1 — frame holds; two follow-ups, both his design after
       conferring):* the phone status bar is ONE row — the agent name
       sits beside the dot (one green connected-to-what unit,
       ellipsizes rather than pushing controls) and the facts row is
       REMOVED on phone: model+folder are now visible on the FLEET rows
       instead (`.fleet-cwd`, both platforms — the folder had been
       tooltip-only since 2026-07-17), usage is dropped on phone as an
       accepted loss (revisit if testers ask), and the theme pill is
       hidden on phone with the settings gear's picker carrying theme
       (the Phase S pill lock is desktop-scoped — Kyle confirmed).
       Submit gesture: on phone Enter NEVER submits — newline only,
       now deliberate in PromptBox (it had regressed to newline on iOS
       anyway; root cause unconfirmed, handler was unchanged) — and the
       ↑ send button INSIDE the prompt box (bottom-right, swaps with
       ■ esc while busy, adds no height, text cannot run under it) is
       the one way to send. Desktop Enter-to-send unchanged. Pinned in
       `phone.e2e.ts`: Enter-inserts-newline with zero submits, the
       send-button-driven turn, the one-row bar with the agent aboard,
       facts/pill hidden. 4/4 e2e, Tier-1 315, typecheck green.
       Remaining before this item closes: Kyle's look at round 2 on his
       phone.*
       *2026-07-22 round 3 (Kyle: the on-row fleet folder reads as
       clutter on BOTH platforms — the round-2 column was a miss):*
       details-on-demand instead of persistent chrome. The settings card
       gained a **Session section** (agent, model, folder, usage — which
       thereby gets its phone home back — session id, daemon version);
       on phone it's THE home for these facts, on desktop harmless
       redundancy. Two zero-chrome paths in: the settings gear, and the
       **agent chip beside the dot is now a button** opening the same
       card ("what is this session?" → tap the identity element). The
       fleet folder column is REMOVED (desktop hover tooltip restored);
       the prompt cwd crumb is now DESKTOP-ONLY (on phone it ate a third
       of the typing width and its collapse-to-caret toggle isn't
       touch-discoverable) — phone prompt is bare `❯ Message ↑`. Pinned
       in phone.e2e.ts: no crumb at phone width, agent-chip tap → card
       with the folder fact, Esc closes. 4/4 phone + 28/28 desktop e2e,
       Tier-1 315, typecheck green.*
       *2026-07-22 (late): Kyle's real-phone look at round 3 came back
       emphatically positive ("flabbergasted… looks incredible") — the
       styling core of item 1 is validated on the device that opened it.
       Whether this constitutes the phone-UI pass that un-gates R.5b
       tester invites is Kyle's call, not assumed here.*
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
    maintainer doc. And (internal price sanity, 2026-07-08): before creating
    the Stripe products, a price/packaging pass against the observed market
    range (bare remote-access offerings run free to ~$7–9/mo — internal
    anchor only, NEVER surfaced in copy per the no-competitor-mentions lock,
    2026-07-23) — the tier is sold as **the Mirafold experience from any
    device**, never as bare phone access; $12 stands per BUSINESS §7 + the
    §2 first target unless Kyle recuts it here, eyes open.
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
  - **2026-07-22 — the BUILD is code-complete across all three repos**
    (Kyle's directive: this is the private-beta gate; the shape decision is
    recorded under R.5b). The two open decisions were made by Kyle: minting
    backend = **Cloudflare Pages Functions on mirafold.com** (the
    recommendation above; state in a Workers KV namespace, secrets in the
    Pages project) and token model = **permanent license key +
    auto-refresh** (checkout yields one `mf_…` key set once as
    `MIRAFOLD_LICENSE_KEY`; the daemon exchanges it at `/api/entitlement`
    for 48h Ed25519 tokens — refreshed at boot, every 12h, and force-refreshed
    once after a 4007 — so cancellation cuts access within ≤48h, which is the
    accepted answer to the "revocation-before-expiry" refinement). Landed:
    - **genui-relay**: the B2 **max-token-lifetime backstop**
      (`RELAY_ENTITLEMENT_MAX_TTL_SECONDS`, default 7d, 0 disables) inside
      `entitlementValid`; `ENTITLEMENT_HEADER` joined `SHARED_CONTRACT`;
      new `scripts/entitlement.mjs` (keygen printing both env halves;
      `mint --ttl` for comped beta testers — key read from env, never argv;
      `verify`). Standalone suite 20/20 green.
    - **THIS repo**: new `server/relay/entitlement.ts` (the token source:
      `MIRAFOLD_ENTITLEMENT_TOKEN` override wins outright; the license-key
      exchange NEVER throws or blocks the local product — no token just
      means the gated relay refuses and relay-client prints the existing
      actionable line); relay-client resolves the token per dial and sends
      the header (`ws` client headers), force-refresh after
      CLOSE_UNENTITLED; index.ts boot line names the entitlement mode;
      relay-stub gained an exact-match `entitlementToken` knob so the send
      path stays CI-covered (the sibling itest is CI-excluded per C.1).
      Tests: Tier 1 300→**308**, Tier 2 83→**86**, incl. the POSITIVE gated
      pairing (real relay, real daemon, minted token → paired + viewport
      turn), the full license-exchange path against a throwaway local
      billing server, and the lapsed-key path (refusal line; local viewport
      proven still answering).
    - **mirafold-site**: the whole minting backend — `functions/api/`
      (claim / entitlement / paddle-webhook / health), `lib/`, 7 `node
      --test` tests (incl. a cross-format guard that verifies a minted token
      with this relay's exact node:crypto calls), the `/welcome` checkout
      landing (verified 1280w+390w), CSP `connect-src 'self'`. KV shapes are
      webhook-order-proof. Detail + **Kyle's setup runbook** (Cloudflare
      KV/secrets/rate-limit rule, keygen, Paddle sandbox):
      `mirafold-site/PLAN.md` "R.5 billing backend".
    **Still open on this step:** Kyle's runbook execution
    (`mirafold-site/PLAN.md`), the live end-to-end below, the payment-link →
    Pro-button swap, and token→account binding (deliberately deferred — the
    license key IS the binding for now; sharing a key shares one
    subscription's access, and a lapsed-then-returning customer gets a NEW
    key, since a re-subscribe is a new Paddle subscription id).
    *2026-07-22 (later, Kyle): NO sandbox and NO comped tokens — Paddle is
    wired straight on the live approved account, and Kyle's own real-card
    purchase is the end-to-end (the 7-day card-required trial charges $0;
    cancel-inside-trial keeps it $0, which is also the published-policy-
    sanctioned path — no refunds). Beta testers then use the identical
    full-real flow; past-day-7 charges are paid back personally. The mint
    script is ops/emergency tooling only.*
  - Done when: a REAL purchase on the live Paddle account (Kyle's own,
    riding the trial) unlocks pairing end-to-end, and expiry/cancellation
    re-locks it without breaking the local product in any way. *(Was
    "sandbox-mode purchase" — superseded by the 2026-07-22 no-sandbox
    decision above.)*

- [ ] **Step R.5b — Release strategy, locked (all three repos)** *(a
  decision to make + write down, not a build; do before R.6's final week)*
  - Goal: one agreed, written release sequence so R.6/R.7 execute a plan
    instead of improvising how each piece ships.
  - Decide and record: (a) **shape of the release** — *first half DECIDED
    (Kyle, 2026-07-22, in commissioning the R.5 build; sharpened the same
    day): a **private beta precedes the public splash**, and it runs the
    **full real billing flow** — NO sandbox, NO comped tokens. The beta
    starts when the relay's entitlement gate flips ON (the `fly secrets set
    RELAY_ENTITLEMENT_PUBLIC_KEY` moment) with live Paddle wired; Kyle's own
    real-card purchase is the first end-to-end, then testers buy real
    subscriptions riding the 7-day card-required trial ($0 if they cancel
    in-window; Kyle personally reimburses anyone charged past day 7). The
    mint script is ops/emergency tooling, not a beta access path.
    **2026-07-22 (night): the gate is ON and the whole path is proven** —
    Kyle's real purchase → license key → daemon token exchange → paired
    through the closed gate; unentitled dials probed refusing 4007. **But
    tester invites are explicitly gated on a phone-view UI pass first**
    (Kyle: obvious flaws remain — see R.4l's phone-styling items; the
    billing machinery being done does not make the product show-ready).
    Still to decide here: beta size/who, its duration/exit criteria, and
    how R.5c's user-testing round folds in;* remainder of (a) — staged
    rollout vs. one splash for the PUBLIC release — still open;
    (b) **per-repo mechanics + order** — `genui-shell` (repo public + `npm
    publish` + versioning/cadence), `genui-relay` (deploy pipeline, **when
    the repo flips public — owed to K.1, which relicensed it MIT**, when the
    entitlement gate flips ON, when the default `MIRAFOLD_RELAY_URL` bake
    lands — see R.2), `mirafold-site` (checkout button flip, demo swap); (c)
    **rollback / kill-switch** for each (the relay gate and per-daemon relay
    URL are the levers) — *for the npm package the rollback move is
    re-pointing the `latest` dist-tag at the previous good version
    (+ `npm deprecate` on the bad one), never an unpublish (npm barely
    permits it and installed users aren't affected either way); for the
    relay it's `fly deploy --image <prev>` (already in
    `genui-relay/DEPLOY.md`); for the site it's the Pages one-click
    deployment rollback (KV does NOT roll back with it — see R.6's KV note)*; (d) how the codebase/npm/GitHub rename (R.2) is
    sequenced into all of the above; (e) *already decided 2026-07-15
    (K.9): contributor policy is **DCO**, not CLA* — `Signed-off-by` per
    commit, CONTRIBUTING.md landed in both repos that day; what remains
    for this step is only the mechanics: enable the GitHub DCO status
    check on both repos as part of the public flip.
  - **CI hardening at the flip (from the 2026-07-21 audit of the C.1 work):**
    once a repo is public, any fork PR's test suite runs on the CI runner, so
    the CI's trust posture matters. Already in place from C.1: the token is
    `permissions: contents: read` (read-only — a malicious dependency install
    script can't push to the repo) and no secrets are used (Tier 4 excluded,
    credentials forced empty). Do AT the flip: (i) re-enable the cross-repo
    relay itest now that `genui-relay` is public and checkout-able — drop the
    `tsconfig.ci.json` exclusion + the Tier-2 `find` filter and add a sibling
    checkout (see C.1's note + `tsconfig.ci.json`); (ii) optionally SHA-pin the
    `actions/checkout` / `actions/setup-node` steps (they're pinned to `@v4`
    tags today — fine for GitHub's own official actions, stricter as a full
    commit SHA). No secret was ever added, and none should be — the "no
    provider credential in repo secrets" bound (C.1) is absolute.
  - **Dependency-alert sweep at the flip (2026-07-22 audit):** before EACH
    repo goes public, clear its open Dependabot alerts — open alerts on the
    default branch become publicly visible the moment the repo does, and
    they're a stranger's first impression of the project's hygiene. The
    site repo already carries this in its pre-public hardening trio; this
    line extends the same sweep to **this repo and `genui-relay`**. (Shell
    repo swept 2026-07-22: `shell-quote` ≥1.9 + `@hono/node-server` ≥2.0.5
    forced via yarn resolutions — the MCP SDK still pins hono 1.x upstream,
    so the resolution stays until the SDK moves; all tiers green on 2.0.11.)
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
  - Finding #3 (Kyle, 2026-07-24, real phone — SERIOUS): starting a NEW
    session on mobile hung on "connecting…" forever, picker never showed;
    desktop fine. Root cause: the in-session "new" button opens a fresh tab
    (`target="_blank" rel="noopener"`), and a noopener new tab inherits
    neither the URL fragment nor sessionStorage — so on the relay path the
    new tab had no pairing code, fell back to a daemon-less local ws://, and
    hung. Desktop's local fallback IS the daemon (worked); mobile resume
    worked (fleet links stay in-tab). Diagnosed from the daemon
    flight-recorder + relay structured logs. Fixed: `newSessionHref()`
    re-encodes the relay target into the new tab's fragment (PR #6, merged
    to main; unit 322 + round-trip invariant test). DEPLOYED: the
    git-integrated Cloudflare Pages project auto-rebuilt on merge —
    app.mirafold.com now serves the fixed bundle (index-D2UVf2h9.js,
    confirmed live). Awaiting Kyle's real-phone confirmation.
  - Finding #2 (Kyle, 2026-07-23, his MacBook): the onboarding picker sat
    flush against the browser window's top/bottom on a short viewport (a
    ~600px un-maximized Mac Chrome window) instead of floating as a nested
    modal. Root cause: `.onb-card` had `max-width` but no `max-height`, so
    it overflowed the centered overlay. Fixed same day: `max-height: 100%`
    + internal scroll as the hard floor (the overlay's 24px gutter is now
    always visible), plus an `@media (max-height: 700px)` compact layout
    (44px glyph, tighter paddings) so typical content FITS at ~600px.
    Verified by computed-style probe at 607px and 769px viewports + all
    tiers green; worst-case content (3 credential-less agents, longest
    hints) scrolls internally with the gutter intact at any height.
  - Finding #3 (proactive sweep after #2, same day): the settings and pair
    dialogs share the exact defect #2 found in the onboarding card — the
    S.4 card idiom had `max-width` but no `max-height`. Measured live at a
    560px viewport: settings (583px natural — the theme list) overflowed
    the window by 11px top AND bottom; pair (430px) fit but was one short
    window from the same. Fixed with the same two-line cap on the shared
    idiom (`max-height: 100%` + internal scroll — inert until a card would
    overflow). Sweep completeness: these were the ONLY three
    fixed-position overlay surfaces in the shell (onboarding, settings,
    pair); the in-session model picker, question component, permission
    bar, and demo banner are all in-flow and immune. Probed at 560/769,
    e2e + unit green. NOT done (deliberately): a compact-styles pass for
    the settings card at short heights — it would touch the theme picker's
    layout, which is Kyle-locked territory; internal scroll is the
    accepted behavior there.
  - **Opened 2026-07-23.** Mechanics locked with Kyle: distribution is a
    hand-sent `npm pack` tarball (v0.1.0, shell @ 50950a7 / relay @ 3f92992
    deployed) — NOT npm; testers subscribe FOR REAL via the direct `/pay`
    link (never comped — Kyle's standing rule; 7-day refund is the out);
    feedback arrives ad hoc in any form — Kyle collects and forwards it in
    clusters, so intake here means triaging those clusters as they land,
    not policing a channel. Welcome note drafted (install incl. the
    node-pty/npm-scripts fix, credentials, phone-over-cellular ask, the
    never-paste-boot-output rule, log-file-is-safe-to-attach). That gate CLEARED
    same day: Kyle lifted the blackout entirely — the full site is public
    again, all pages verified 200, and the welcome note now lives on-brand
    at mirafold.com/beta (noindex, unlinked; testers get the direct link).
    The tarball was also rebuilt on the @lydell/node-pty swap, so install
    is two commands with no workaround. NOTHING blocks the first invite.
  - **First finding, fixed same day (2026-07-23):** Kyle, running Codex via
    OpenRouter, saw the literal stand-in "codex" in the status bar's model
    slot (Claude showed "default", Gemini "gemini" — same pattern). Kyle's
    call: a temporary model name that isn't true is dishonest — show
    NOTHING until the real one is known. Landed as shell @ 003388c:
    `modelName` is undefined until configured/engine-reported, the wire's
    usage + fleet-row `model` fields went optional, and the status bar +
    fleet row render the slot only when known. Gemini's "auto" stays (a
    genuine configured router-mode value, still refined per turn). All
    three tiers verified; tarball rebuilt at that commit.

- [x] **Step R.5d — Relay staging (nonprod) environment** — **DONE
  2026-07-23** (the day the private release went live, per the sequencing).
  `genui-relay-staging` on Fly from the same Dockerfile via
  `fly.staging.toml` (auto-stop, idles at zero, ungated); the Deploy
  workflow gained the environment dropdown (default staging) with
  per-environment app-scoped FLY_API_TOKENs (staging's token cannot touch
  production); first staging deploy dispatched through the new path and
  the full smoke PASSED against `wss://genui-relay-staging.fly.dev`
  (pairing + byte-identical round-trip + refusals). Runbook: DEPLOY.md §6.
  *(original step spec follows)*
  - Goal: a legitimate place to test relay changes before production, once
    real users depend on production. The relay is the only component that
    needs this — the shell's "production" is the user's own machine (its
    nonprod is the release-channel decision, R.5b) and the site already has
    Cloudflare Pages previews. Staging exercises what local runs can't:
    real TLS, the `fly-client-ip` header the rate limiter trusts, real
    network behavior, Fly machine lifecycle.
  - Build: a second Fly app (e.g. `genui-relay-staging`) from the same
    Dockerfile/`fly.toml` with a different app name, smallest machine —
    auto-stop is acceptable in staging (a dropped pairing costs nothing
    there), so it idles at near-zero cost. The `*.fly.dev` URL is fine:
    the own-domain rule exists so installed daemons never depend on the
    platform's name, and nothing installed ever points at staging. The
    `Deploy` workflow (`genui-relay/.github/workflows/deploy.yml`) grows an
    environment input on the dispatch form — staging or production, each a
    GitHub Environment with its own Fly deploy token — same manual-click
    pattern, one more dropdown. Fly-side one-time steps (app create, token)
    are Kyle's.
  - Flow it buys: deploy a ref to staging → point a local shell at it
    (`MIRAFOLD_RELAY_URL=wss://<staging>.fly.dev`) → smoke + phone pairing
    check → dispatch the same ref to production.
  - Done when: deploying any ref to staging is one workflow dispatch, a
    smoke run (`npm run smoke`) against the staging URL passes, and the
    staging half is documented in `genui-relay/DEPLOY.md` alongside the
    production runbook.

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
      `genui-relay/DEPLOY.md` §8: the accepted-risk position (stateless,
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
    entitlement-keypair cutover) are in `genui-relay/DEPLOY.md` §7. Key
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
    - ~~Relay cap sanity under real load~~ **✅ done 2026-07-19 (evening).**
      Per-IP cap (64) verified on the LIVE relay behind Fly — holds at exactly
      64, logs `per-IP cap reached (64) — refusing one source`, which also
      **confirms `fly-client-ip` reaches the process** (fired on the real
      client IP, not Fly's proxy IP). Global cap verified locally (holds at
      cap, reclaims on close). All read SERVER-SIDE (relay logs +
      `connections()`); a client-side harness was unreliable for the
      refuse-after-handshake pattern (relay `close(4004)`s just after the WS
      `open`, so the client briefly sees "open"). Side effect: the live relay
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
    land it with (or before) the public flip.
  - ~~**SECURITY.md: name the `!`-output → model path (2026-07-17
    audit)**~~ — **done early, 2026-07-23**: landed in SECURITY.md's
    "Known trust decisions" section, together with the Q.5 symlink
    residual of the `.env` guard (also now disclosed there).
  - Build, same day, in order: repo public → `npm publish` over the 0.0.1
    placeholder → verify `npx mirafold` against the real registry (the
    one check that's unverifiable until publish) → post (X + Show HN +
    r/ClaudeAI + r/LocalLLaMA with the "BYOK or fully local" line) with
    Pro purchasable from minute one.
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

## Phase V — Visual + fidelity gaps flagged by Kyle (opened 2026-07-17; ✅ COMPLETE)

Full bodies + dated status in PLAN-ARCHIVE.md ("Moved 2026-07-19").

- [x] **V.1 — Theme contrast pass (all six themes)** — done 2026-07-18; terminal-grade worst-case-surface contrast floors in the Tier-1 guard, hues preserved; seven-theme lineup settled (Mirafold house default; Standard dark + light; Solarized Light/Dark; Gruvbox Dark; Dracula); brand mark beside the empty-session greeting. → PLAN-ARCHIVE.md.
- [x] **V.2 — Codex (and Gemini) rendering + command fidelity** — done 2026-07-19; Codex chart-degradation root-caused (Codex hides MCP tools behind tool-search) and fixed (deferred-tools addendum + a deterministic mermaid backstop); `/model` re-skinned for BOTH Codex and Gemini from each binary's own catalog (Codex app-server JSON-RPC / Gemini ACP); Codex-on-OpenRouter probed. **Follow-up:** the `/effort` reasoning-effort scaffold landed 2026-07-19 (mock-built; TWO fidelity questions — per-model effort availability, and fold-into-`/model`-vs-standalone — pending a live Codex pass). → PLAN-ARCHIVE.md.
- [x] **V.3 — Truthful full-optionality Codex backend picker** — done 2026-07-19; every way codex can run is a picker row from config.toml ground truth (all `[model_providers]`), key-gated, provider carried on the wire, per-session enforced. → PLAN-ARCHIVE.md.
- [x] **V.4 — In-session ergonomics: a "new" button, prompt focus, terminal scrollback** — done 2026-07-20 (Kyle-directed, same day). A `new` button beside home opens the startup screen in a fresh tab (`/?new=1` lands on the picker); `end` moved to the far right past the theme pill. The caret starts in the prompt box on entering any session and is re-taken when a turn ends having dropped focus to the body — never from an open overlay or over a live selection. Transcript scrolling became **conditional**, terminal-scrollback style: streamed output scrolls you down only while you're already at the bottom; scroll up and the view holds.
  - **Follow-up, the only thing still open:** the phone half of the scroll work is unverified by hand. Follow-the-tail detaches on a finger drag downward with **no minimum distance**, so a tap whose thumb wobbles a pixel downward (expanding a tool block, a pin button, a question option) silently stops auto-scrolling, and the agent then looks stalled mid-response with nothing on screen explaining why. Kyle's call 2026-07-20 was to ship it and find out by hand rather than pre-emptively guard it. If it bites: require ~8px of travel before a drag counts as steering, in `onTouchMove` (`web/src/use-follow-tail.ts`) — a real swipe is hundreds of px, thumb noise is 1–2. The touch handlers are also **not proven necessary at all**: touch held correctly without them (a finger drag isn't suppressed by a programmatic scroll the way the wheel was), and they are kept only as a guard for iOS Safari, which cannot be tested on this machine.
  - Note for anyone touching `use-follow-tail.ts`: following scrolls **instantly, never smoothly**, and the reader's **input** is what detaches, not a position delta. Both were bought with a bug — a permanently in-flight smooth animation owned `scrollTop` and made the wheel inert during streaming. The trace and the evidence are in commit `00288c6`; re-read it before reintroducing either.

- [x] **V.5 — The one-click picker row names its backing** — done 2026-07-20 (Kyle-directed, same day). Choosing Gemini started a session without ever saying an API key was what it ran on: Gemini's only backing is a key, so `needsSecondStep()` correctly skipped the backend menu — which is the one place the credential was ever named — and `agentDetail()` had nothing to fall back on (it returned the model override, and there was none). The fix keeps the one-click path exactly as it was and states the decision instead: `AgentInfo` gained an additive optional `kind` (set only when `live`), and the row renders `backingLine()` — "Gemini API key", or "Claude API key · claude-sonnet-5" when a model override exists. The wire carries the *kind* as a fact and the client owns the wording (`agents-meta.ts`), so the one-click row and the second step say the same words about the same backing. **The principle**, worth keeping: a single usable backend isn't "no choice to show," it's *a choice made on the user's behalf* — a menu you don't need can be skipped, but a decision made for the user must still be stated.
  - **Credential labels now match each vendor's own name for what you buy** (same day, Kyle's call): "Google API key" → **"Gemini API key"** (Google sells the Gemini Developer API; "Google API key" is the generic Cloud term, and we only ever said it because `GOOGLE_API_KEY` is an accepted env var — that one is the Vertex path, a different product), and "Anthropic API key" → **"Claude API key"** (the API was rebranded from Anthropic API to Claude API). "OpenAI API key" was already right. The resulting asymmetry — "ChatGPT subscription" beside "OpenAI API key" — is deliberate and documented at `backendLabel`: OpenAI keeps its consumer and API brands apart, and matching what *they* call things means inheriting that, not smoothing it.
  - Considered and **rejected** for now: making the backend menu reachable from a one-click row (a second click target on the row opening the full menu, so "why is there only one option?" has an answer). It costs a real restructure — the row is a single `<button>`, and a nested button is invalid HTML, so it becomes a div with two siblings plus a hand-written focus/keyboard story — to answer a question the row's own label mostly pre-empts. Revisit only if a real user asks it.
- [x] **V.6 — The /model picker becomes real shell chrome (+ session polish batch)** — done 2026-07-22 (Kyle-directed, same day). Kyle hit V.2's fallback live: a Codex catalog past 4 rows degraded `/model` to a non-interactive list + "type to switch," where terminal Codex gives arrow-key selection at any size. Root cause named and fixed **structurally**: the re-skin had borrowed the agent-facing `question` component, whose option cap is discipline on generated UI and must never bind a shell re-skin of terminal chrome. Now an additive `picker` wire message + shell-owned `PickerBlock.tsx` (NOT a registry component): any row count, ❯ highlight starting on the current row, ArrowUp/Down/Enter/Escape captured globally while the newest copy is unanswered — including from the idle empty prompt box, so `/model` ⏎ arrows works exactly like the terminal — retired by a pick or a later user turn; replayed copies click-only. Serves codex `/model`, codex `/effort`, and gemini `/model` through the one shared `emitModelPicker`. Verified Tier 1/2/3 including a real-arrow-key e2e. Same sitting, all Kyle-directed:
  - **question component option cap 4 → 6** ("why not?"). Fidelity note, not a caveat: Claude Code's own AskUserQuestion still maxes at 4, so real agent questions stay ≤4; the wider cap is headroom for agents that choose it.
  - **White-flash kill on fresh tabs**: the pre-paint script in `index.html` now paints the canvas inline (mode's base `--bg` + `color-scheme`) before any stylesheet exists; `main.tsx` clears the inline values once real CSS owns the pixels (both routes). Proven with an all-subresources-blocked first-frame screenshot: solid dark where it was white. Worst in dev (Vite injects CSS via JS); fixed there and in the build.
  - **`.sb-pair` joined the status bar's 34px control row** (was leftover tiny pre-unification styling; the fleet-header variant pinned unchanged). Pre-existing, unfixed, noted: the fleet-header pair button renders ~5px taller than `.fleet-new` because the ⧉ glyph's fallback-font metrics stretch the line box.
  - **Tier-2/Tier-3 harness now scrubs the paid-tier env** (`MIRAFOLD_APP_URL`, `MIRAFOLD_LICENSE_KEY`, `MIRAFOLD_ENTITLEMENT_TOKEN/URL`) like credentials — a dev shell live-testing the paid path was making relay itests dial the real billing backend (one hung 45+ min) and pointing pairing-QR tests at the hosted app. Tests that exercise entitlement pass their own values, which override the blanks.

## Phase A — Accessibility (opened 2026-07-20; Kyle-directed, pre-launch)

Kyle's directive, verbatim: *"i want mirafold to be friendly to all people
capable of using it and to be ada compliant."* The ADA itself specifies no
technical standard for software, so the operative target — the one the DOJ
and effectively every settlement agreement point to — is **WCAG 2.1 Level
AA**. That is this phase's bar.

Starting position, from a 2026-07-20 read of `web/src/`:

- **Contrast (1.4.3 / 1.4.11) is already the strongest thing here** — V.1's
  terminal-grade floors (strong ≥12 · fg ≥11 · body ≥10.5 · mid ≥8.5 ·
  dim ≥7 · dimmer ≥5.5 · faint ≥4.5 · accents ≥4.5) clear AA's 4.5:1 by
  roughly double at the *faintest* tier, on all seven themes, enforced by a
  Tier-1 guard. Nothing owed. Do not re-open it.
- Also already present: `prefers-reduced-motion` (2.3.3) at
  `web/src/styles.css:2041`, a global `:focus-visible` rule (2.4.7) at
  `styles.css:2027`, `lang="en"` (3.1.1) in `web/index.html`.
- The gap is **programmatic semantics**: the whole app carries 4
  `aria-hidden`, 3 `role=`, 3 `aria-label`, 2 `aria-pressed` — and zero
  `aria-live`.

Primary users served: screen-reader users (Orca / NVDA / JAWS / VoiceOver)
and keyboard-only users (motor impairment — tremor, RSI, paralysis, limb
difference). Sequence A.1 → A.2 → A.3; A.4 is written last, after the others,
because it is a public conformance claim and must describe the real state.

The automated regression guard for all of this is **Step C.2**, deliberately
placed in the CI/CD phase below.

**⚑ The screen-reader walk — RESOLVED 2026-07-21: it is fully automatable
on this box after all.** This note originally read "one item in this phase
cannot be done by the assistant at all: actually *listening* to Mirafold
with a screen reader." That turned out to be wrong. The assistant now runs
the whole walk end to end without a human ear: Orca with `--debug-file`
gives its speech as readable text; the claude-in-chrome extension drives the
page over CDP (the only input path that reaches native-Wayland Chrome);
foregrounding the extension's tab via its AT-SPI `doDefault` action makes it
simultaneously CDP-drivable and Orca's focus locus; and the CLI terminal-title
flood is filtered out of the log rather than fought. The full recipe lives in
[[orca-testing-mirafold]] (memory). Both A.1 and A.3 were closed this way on
2026-07-21 — onboarding → a full prompt→response turn → tool calls → a
permission prompt → an error → settings/theme → connect-a-device → fleet
view, each heard live. What was checked, in the walk's own terms: the
response read once and whole (not per-token); nothing read twice or flooded;
every control announced with a real name + role (never a bare "button");
focus never landed on an invisible element; every overlay trapped focus and
restored it on close. One human-judgment residue remains only if desired: a
person confirming the TTS *sounds* right subjectively — but comprehensibility,
naming, ordering, and no-flood are all now proven from the assistant side.

**Other screen readers — deferred post-launch, Kyle's call 2026-07-22.**
Every walk above was Orca + Chrome on Linux; NVDA, JAWS (Windows), and
VoiceOver (macOS/iOS) have not been walked — each needs hardware or a VM we
don't have running (NVDA is free, a Windows VM is the realistic route; JAWS
has a 40-minute demo mode; VoiceOver needs Apple hardware). They consume the
same ARIA semantics the Orca walk verified, so the standard-patterns bet is
that the results carry — but that's an expectation, not a verification.
Kyle's call: **save those walks for post-launch polishing** — not a launch
gate, not owed by A.4 (whose statement already words the scope honestly:
"most thorough with Orca on Chrome"). When picked up, it's the same
by-ear pass documented in the walk note above, per reader, on its own OS.

- [x] **Step A.1 — Live regions: streaming agent output is announced** —
  done 2026-07-21 (full live Orca walk, run autonomously; see closing note)
  - Goal: the fatal gap. A screen-reader user sends a prompt and hears
    *nothing back* — text that appears without focus moving to it is never
    announced. WCAG 4.1.3 (Status Messages). This one step is worth more
    than the rest of the phase combined.
  - Build: the design decision first — **announcement granularity**.
    Token-by-token `aria-live="polite"` on the transcript is unusable
    (a screen reader restarts or floods on every mutation); the shape that
    works is announcing at semantic boundaries — turn start, each completed
    assistant message/tool block, turn end — with the streaming text itself
    in a non-live container the user reads on demand by navigating to it.
    Then: a polite live region for turn/tool status, an assertive one
    reserved for errors and permission prompts (shell-owned, so the
    trusted-shell boundary is unaffected), and `role="log"` on the
    transcript. Status-bar state changes (busy, connection, agent) announce
    politely. Verify with a real screen reader, not by inspection.
  - Files: `web/src/components/RenderZone.tsx`,
    `web/src/components/Shell.tsx`, `web/src/components/StatusBar.tsx`,
    `web/src/components/ToolBlock.tsx`.
  - Done when: with a screen reader running, a full prompt→response turn is
    comprehensible start to finish without sighted assistance — turn start,
    tool activity, and completion each announce once, and no announcement
    floods or interrupts mid-sentence.
  - Status 2026-07-20: **code landed, box stays open on the screen-reader
    pass.** New `web/src/components/Announcer.tsx` — two visually-hidden
    regions (polite `role="status"`, assertive `role="alert"`) plus a
    two-slot alternation so a repeated message still counts as a DOM change
    and re-announces. Granularity as designed: the transcript is
    `role="log"` + **`aria-live="off"`** (log's implicit "polite" would
    re-read on every token), and Shell announces at boundaries off frames it
    already subscribes to — `user_prompt` → "Sent. Working…", `tool_use` →
    "Running {name}." (name only, never the arguments), `turn_end` → the
    turn's prose banked from `text_delta`, capped by `turnResponse()` at
    4000 chars with a pointer to the transcript, falling back to "Turn
    complete." for a tool-only turn. Assertive: `permission_request`,
    `error`, `refused`, and a real disconnect transition (guarded so the
    mount-time `connected=true` doesn't announce "Reconnected"). StatusBar's
    dot is now `aria-hidden` (a coloured circle reads as nothing) with its
    state moved onto the toggle buttons' `aria-label`. `.sr-only` added to
    styles.css using `clip-path`, NOT `display:none` — the latter drops the
    element from the accessibility tree and would silence the regions. +4
    Tier-1 on `turnResponse` (**290 green**, typecheck clean). Tier 3 NOT
    run: `server/testing/app.e2e.ts` had another session's uncommitted
    edits, and `test:e2e` rebuilds shared `dist/`. Owed before checking the
    box: the Orca walk, and a Tier-3 assertion that the regions exist and
    the transcript is `aria-live="off"`.
  - Status update 2026-07-20 (later session): **the Tier-3 half is paid.**
    The blocking uncommitted work landed (`2274d23`), so `test:e2e` could
    run: new assertion test in `server/testing/app.e2e.ts` — both announcer
    regions present (one polite `role="status"`, one assertive
    `role="alert"`), the polite region actually *spoke* the finished mock
    turn (polls for the turn's closing prose in its text — announcement
    trails the transcript paint, hence the poll, not a snapshot), and the
    transcript is `role="log"` + `aria-live="off"`. Full suite **33 e2e
    green**; Tier-1 **300 green**. The box now waits on exactly one thing:
    the Orca walk (⚑ KYLE'S HANDS above).
  - Status update 2026-07-20 (Orca walk, first slice): a real prompt→response
    turn was watched live with Orca — "Sent. Working…" announced once at
    send, the finished reply spoken once and whole (no per-token flooding).
    That's the fatal-gap case this step exists for, confirmed working. Not
    yet watched: a tool-call announcement, a permission prompt, or an error —
    box stays open until those are seen too (see A.3's status update for the
    rest of tonight's walk and why the box isn't closing yet).
  - Status update 2026-07-21: the tool-call and permission-prompt case is now
    covered a different way than planned. Kyle's live walk of it went wrong
    twice in the same sitting — once because the dev server still had a real
    `ANTHROPIC_API_KEY` in `.env`, so the deterministic mock trigger
    ("dangerous") silently no-opped against the live agent instead of firing
    the canned permission prompt; and once because this same Claude Code CLI
    terminal's animated title was flooding Orca's AT-SPI event queue while
    background tool calls ran, degrading the audio into something
    unintelligible. Kyle, reasonably, declined to retrigger the scenario
    again in any form — the first mixup meant he'd approved a real
    `rm -rf /var/cache/app && systemctl restart app` believing it was fake.
    (It was fake; the mock never shells out. But the trust cost of that
    mixup is the point.) In place of the live listen: a new Tier-3 test
    (`server/testing/app.e2e.ts`, "A.1: tool_use and permission_request
    announce") drives the exact same flow headlessly against the
    itest-harness daemon (credentials always forced empty — no real key can
    reach it) and asserts the assertive region's actual text —
    `"Permission needed: Bash. rm -rf /var/cache/app && systemctl restart
    app"` — plus the polite `"Running Bash."` on allow and the turn's
    conclusion text, then that the bar clears. **35/35 e2e green,
    typecheck clean.** This proves the announcement wiring is mechanically
    correct; it does not prove Orca's TTS renders it comprehensibly, which
    still needs a human ear — but for this specific case, headless proof is
    the standing substitute going forward, not another live trigger.
    Settings/theme card and the fleet session list's keyboard behavior WERE
    confirmed live later the same session — see A.3's 2026-07-21 status
    notes below. The one piece of A.1 still genuinely open: an actual error
    announcement (attempted the same night via the `!` bang-concurrency
    error, but drowned out by the same terminal-noise problem — see A.3's
    closing note).
  - **Box CLOSED 2026-07-21 (later, autonomous walk).** The environment
    fight that blocked the live listens was solved from the assistant side,
    end to end, so every A.1 announcement was finally heard live — no human
    ear needed. The method (recorded in full in [[orca-testing-mirafold]]):
    Chrome is native-Wayland, so synthetic keys (XTEST/AT-SPI
    `generate_keyboard_event`) never reach it — only CDP does, which the
    claude-in-chrome extension speaks. The extension's tab is a background
    tab in a real window; activating it via its AT-SPI `doDefault` page-tab
    action foregrounds it (visible + focused), and then it is *both*
    CDP-drivable *and* Orca's focus locus at once. Orca runs with
    `--debug-file`; the terminal-title flood is not fought but *filtered* —
    a parser keeps only `SPEECH OUTPUT` lines emitted while Google Chrome is
    the active app and drops the CDP-attach infobar. Every announcement type
    was then confirmed live, spoken once, in order:
    - `user_prompt` → **"Sent. Working…"** (polite, once).
    - `tool_use` → **"Running Write." / "Running Grep." / "Running Bash."**
      (polite, name only — no arguments), one per tool.
    - `turn_end` → the whole response, once (polite).
    - `permission_request` (mock `dangerous` trigger) → **"Permission
      needed: Bash. rm -rf /var/cache/app && systemctl restart app"**
      (assertive) — and the `allow`/`deny` buttons are real, Tab-reachable
      controls.
    - `error` (the `!sleep 5` then `!echo hi` concurrency guard) → **"a !
      command is already running (stop it first)"** (assertive) — the last
      genuinely-open A.1 item, now heard clean.
    Independently cross-checked with a DOM `MutationObserver` on the live
    regions: the polite `role=status` fired exactly once per boundary, and
    the transcript `role=log` stayed `aria-live="off"` (zero per-token
    announcements) — the no-flood design, proven from both ends.
  - **One real finding from the walk, fixed the same sitting.** The
    `turn_end` announcement spoke the response's **raw markdown** — a
    screen reader voiced "pound pound Code review", "bar bar", "backtick",
    every list dash, every `- [x]`. The rendered transcript is clean, but
    the announcement used the banked `text_delta` source verbatim
    (`turnResponse` returned it untouched). Fix: new `speechFromMarkdown()`
    in `Announcer.tsx` strips markdown syntax to the prose it wraps
    (headings, emphasis, inline code, code fences, blockquotes, list/task
    markers, tables → comma-joined cells, links/images → their text, rules
    dropped) *before* the 4000-char cap, so the cap counts spoken length.
    The region is `.sr-only`, so this is invisible to sighted users and
    strictly better for screen-reader users — a standard pattern,
    pre-approved under [[a11y-standing-rule]], and it fulfils this step's
    own stated intent ("the turn's **prose**"). +7 Tier-1 on
    `speechFromMarkdown`/`turnResponse` (**307 green**), typecheck clean.
    Verified live: the same markdown-heavy mock reply now narrates as clean
    prose — no `##`, backticks, `|`, or `>`.
  - **One observation left for Kyle (not changed — a real UX trade-off).**
    When a `permission_request` appears, focus stays on the prompt box; it
    does not move to the permission bar. The assertive announcement tells a
    screen-reader user what's being asked, and `allow`/`deny` are reachable
    by Tab, so nothing is unreachable — but auto-moving focus to the bar
    would change keyboard behavior for sighted users too (focus would jump
    on every permission prompt). Per [[a11y-standing-rule]] that makes it
    Kyle's call, not a silent fix. Flagged, not acted on.
  - **RESOLVED 2026-07-22, Kyle's call: focus does NOT move. LOCKED.** His
    words: *"it violates normal browser behavior - don't do it."* In a
    browser, focus moves only when the user moves it; an unrequested jump
    also widens the accident window (an Enter typed in flight would land on
    a permission control — the one place a stray keystroke is most costly).
    The current shape — assertive announcement + Tab-reachable
    `allow`/`deny` — is the final design, not an interim. Don't re-propose
    focus moves here, including "safe" conditional variants (move-only-when-
    input-empty, jump-to-bar shortcuts); those were presented and declined.

- [x] **Step A.2 — Every control is a real control** — done 2026-07-20
  (third file closed by A.2b below, same day)
  - Goal: six `onClick` handlers sit on `div`/`span` elements — unreachable
    by Tab, unannounced as controls. WCAG 2.1.1 (Keyboard) and 4.1.2 (Name,
    Role, Value).
  - Build: convert each to a real `<button>` (or give it `role` + `tabIndex`
    + key handling where the styling genuinely can't survive the swap —
    prefer the swap). Audit accessible *names* while in each file: an
    icon-only control needs an `aria-label` that says what it does, and
    decorative glyphs need `aria-hidden="true"` so they aren't read aloud.
    Theme pill markup is LOCKED — semantics/labels only, no visual or
    behavioral change.
  - Files: `web/src/components/ConnectDevice.tsx`,
    `web/src/components/Onboarding.tsx`,
    `web/src/components/ThemePicker.tsx`.
  - Done when: every interactive element in those three files is reachable
    and operable by Tab + Enter/Space, announces a meaningful name and role,
    and nothing about the rendered appearance changed.
  - Status 2026-07-20: **two of three files done** (`ThemePicker.tsx`,
    `ConnectDevice.tsx`); `Onboarding.tsx` deferred — another session had it
    open with ~183 uncommitted lines. **The step's framing was wrong and is
    corrected here:** the six `div`/`span` `onClick` handlers are NOT
    disguised buttons. Four are the backdrop-click-to-dismiss + card
    `stopPropagation` pair in the two overlays, and one more of each in
    Onboarding. A backdrop already has keyboard equivalents (Escape via
    `useEscapeKey`, plus an explicit ✕), so 2.1.1 is satisfied and promoting
    it to a control would park a page-sized meaningless stop in the tab
    order — left as plain divs, each with a comment saying why. The real gap
    in those files was **dialog semantics and names**: neither overlay had
    `role="dialog"`, `aria-modal`, or an accessible name, so a screen-reader
    user got no signal a modal had opened. Both cards now carry all three
    (`aria-labelledby` → the existing title span). Also: `❯` glyphs and the
    slotted-row `✓` marked `aria-hidden` (decorative), both ✕ buttons given
    real `aria-label`s instead of relying on `title` alone, theme groups
    wrapped in `role="group"` + `aria-label`, and each theme row given
    `aria-pressed` — the `✓` was previously the *only* thing marking the
    slotted row. Visual output unchanged; the LOCKED status-bar pill was not
    touched. Typecheck clean, Tier-1 **290 green**.

- [x] **Step A.2b — Onboarding's share of A.2** — done 2026-07-20
  - Goal: the same treatment for `Onboarding.tsx` — dialog/step semantics,
    accessible names on icon-only controls, decorative glyphs hidden, and
    its two backdrop/stopPropagation divs commented like the others.
  - Was blocked on another session's in-flight onboarding work; that landed
    as `2274d23` and this went in the same day. The card now carries
    `role="dialog"` + `aria-modal` + `aria-labelledby` → the existing
    `<h1>` (which already renames itself per step — "pick its backing" /
    "pick a model" — so the dialog's accessible name tracks the step for
    free). The logo `<img>` is decorative beside that heading and went
    `alt=""` + `aria-hidden` (the brand is still spoken — the subtitle
    says "Mirafold re-skins…"); the two `←` back-button glyphs are
    `aria-hidden` spans so a reader says "all backends", not "leftwards
    arrow all backends". Backdrop div commented with the ThemePicker
    rationale (Escape already walks the steps back). No other unnamed
    controls existed — every row was already a real `<button>`. Onboarding's
    focus trap went in under A.3 the same sitting. Visual output unchanged.
    Typecheck clean, Tier-1 300 green, Tier-3 33 green.

- [x] **Step A.3 — Focus management + the manual keyboard pass** — done
  2026-07-21 (whole app walked keyboard-only + screen reader, autonomously;
  see closing note)
  - Goal: Escape is already handled uniformly — `useEscapeKey`
    (`web/src/use-escape.ts`) is used by all three overlays
    (`ThemePicker.tsx:45`, `ConnectDevice.tsx:52`, `Onboarding.tsx:217`), so
    2.1.2 (No Keyboard Trap) is likely already satisfied. What is missing is
    *focus*: an opening overlay leaves focus behind it, Tab then walks the
    page underneath, and closing loses focus entirely. The app's only
    `.focus()` call is the prompt autofocus at `Shell.tsx:396`. WCAG 2.4.3
    (Focus Order).
  - Build: one `useFocusTrap` hook mirroring `useEscapeKey`'s shape — on
    open, record `document.activeElement` and move focus into the container;
    cycle Tab within it; on close, restore focus to the opener. Apply to the
    same three overlays. Assess `FleetView.tsx:145` (it already has its own
    `onKeyDown`) for whether the session list should become a roving-tabindex
    widget, and give `PinDock.tsx` (66 lines) the same look. Then the part no
    grep substitutes for: **a manual pass through the whole app** with
    keyboard only, then again with a real screen reader (Orca locally;
    VoiceOver if a Mac is available) — onboarding, a full session, the
    picker, connect-device, fleet view.
  - Files: new `web/src/use-focus-trap.ts`;
    `web/src/components/{ThemePicker,ConnectDevice,Onboarding,FleetView,PinDock}.tsx`.
  - Done when: every overlay takes focus on open and returns it on close, the
    entire app is operable mouse-free end to end, and the manual
    screen-reader walk is recorded here with what it found.
  - Status 2026-07-20: **hook built and wired to the two free overlays.**
    New `web/src/use-focus-trap.ts` — `useFocusTrap(ref, active)`, the same
    shape as `useEscapeKey` (inactive ⇒ no listener) and deliberately
    separate from it so an overlay can take one without the other. Does the
    three things the browser won't: focus in on open, Tab cycles inside,
    focus restored to the opener on close. One non-obvious bit worth keeping:
    visibility is tested with `getClientRects().length`, not `offsetParent`,
    which is null for `position: fixed` — and these cards are fixed, so the
    usual check would have matched nothing. Listener is capture-phase so the
    trap wins before anything inside reacts to Tab. Wired into
    `ThemePicker` (always active — mounted only while open) and
    `ConnectDevice` (tracks `open`; returns focus to the ⧉ pair button).
    `PinDock` had no trap to add (not a modal) but did have unnamed
    controls: the `<aside>` landmark is now labelled and both icon-only
    buttons carry `aria-label`. Typecheck clean, Tier-1 **291 green**.
    Still owed: `Onboarding.tsx` (see A.2b — same blocker), the FleetView
    decision below, and the Orca walk.
  - Status update 2026-07-20 (later session): **Onboarding wired** — the
    third overlay took the trap once `2274d23` landed (always-active, same
    as ThemePicker: Shell mounts it only while shown). All three overlays
    now trap. Remaining before the box closes: the A.3b FleetView decision
    (below), and the Orca walk.
  - Status update 2026-07-20 (Orca walk, first slice — laptop died mid-walk
    last session, resumed here): walked onboarding and a chat turn with Orca
    for real, after fixing an environment gap first — GNOME's
    `screen-reader-enabled` gsettings key was off (launching the bare `orca`
    binary, unlike the Settings toggle, doesn't set it), so Chrome's
    accessibility bridge never activated; nothing was reachable until that
    was flipped. **Real bug found and fixed:** `useFocusTrap` correctly traps
    Tab, but nothing hid the rest of the page from the accessibility tree, so
    Orca's Browse-mode cursor (not just Tab) could still read straight into
    the session sidebar behind the "Choose your agent" dialog — confirmed by
    landing on `genui-shell visited link` / `Rename session` mid-walk with
    the dialog still open. `aria-modal="true"` alone doesn't stop this on
    Chrome+Orca; the APG's documented fallback is hiding siblings from the
    tree outright. Fix: new `.behind-dialog { display: contents }` in
    `styles.css` (transparent to flex/grid layout) wraps everything except
    the dialog in both mount points (`FleetView.tsx`, `Shell.tsx`) with
    `inert={<dialog open>}`. Verified three ways: `yarn typecheck` clean;
    DOM-level (`.focus()` called directly on a background button while the
    dialog was open did not move focus); and a second live Orca pass — Tab
    now cycles only the dialog's own four elements and wraps, zero sidebar
    leakage. Tier-1 **300 green**, Tier-3 **34 green**. One earlier finding
    from this same walk ("streaming status text updates too fast to be
    usable") was investigated and retracted — it was Claude Code CLI's own
    terminal status animation bleeding into the same Orca debug log, not
    anything Mirafold renders; grepped the whole repo to confirm no such
    title/live-region logic exists.
  - **Box stays open.** KYLE'S HANDS above lists the full walk: onboarding →
    a full turn → a tool call → a permission prompt → settings → connect-a-
    device → fleet view. Tonight only covered the first two and the
    onboarding dialog's focus containment. Still unwalked: a tool call, a
    permission prompt, the settings/theme card, connect-device, and the
    fleet session list/sidebar's own keyboard behavior (ironically the same
    surface the dialog was just leaking focus into). Pick up there next
    session.
  - Status update 2026-07-21: **settings/theme card and fleet session list
    both confirmed live, cleanly, with real audio** (Orca restarted mid-
    session with `--debug-file` after discovering Chrome's own
    `chrome://accessibility` showed "Screen reader: disabled" for the tab —
    Chrome had cached "no AT present" from before Orca registered on the
    AT-SPI bus, and only a full Chrome relaunch, not a page reload, forced
    it to re-detect; noted for next time). Theme card: "settings dialog" on
    open, "theme panel." / "Light themes panel." / "Dark themes panel." as
    group labels, "Light theme." / "Dark theme." per row — clean, single-
    utterance, no repeats. Fleet session list: Tab reaches "Rename session
    {name} push button." and "End session {name} push button." distinctly
    (the A.3b fix — each button's name, not just "end"/✎ alone) — confirmed
    twice across two separate walks. Tool call + permission prompt did NOT
    get a clean live confirmation — see A.1's 2026-07-21 status note for
    what happened there and why a headless Tier-3 test stands in for it
    going forward instead of a repeat live trigger.
  - Closing status, 2026-07-21 (end of session): **two items remain
    genuinely open, both needing a live walk, neither attempted
    successfully tonight.**
    - **An actual error announcement.** Attempted via the `!` passthrough's
      concurrency guard (`!sleep 5` then a second bang command before it
      finishes → "a ! command is already running (stop it first)", a real
      `type: "error"` broadcast — see `server/sessions/connection.ts:427`,
      adapter-agnostic, no scary content, safe to repeat). Never got a
      clean listen: by the time it was tried, Orca's speech had been
      silently toggled off for ~18 minutes (found by grepping the debug
      log — "Speech disabled." at 05:40:39 — nobody had noticed), and after
      restarting Orca to fix that, the terminal-title-flooding problem
      (this session's own recurring finding, see below) was still bad
      enough that all that came through was the terminal repeating its own
      status text.
    - **Connect-device.** The relay stub (`server/relay/relay-stub.ts`) is
      wired into a dev session via `MIRAFOLD_RELAY_URL=ws://127.0.0.1:9100`,
      so the `⧉ pair` button exists to walk. It IS verified correct at the
      DOM/axe level — dialog semantics, focus trap, and a real bug (the
      pairing-URL scroll box wasn't keyboard-focusable) found and fixed via
      the axe-core sweep below — but the live audio walk itself never
      happened; the session went into the contrast-token work instead.
    - **Root cause behind both misses, worth fixing before trying again**:
      this Claude Code CLI terminal's own title animates continuously
      (spinner + elapsed time), even seemingly while idle, and each change
      fires an AT-SPI event Orca has to process — badly degrading its
      speech for whatever else has real focus (Chrome, here). Checked for a
      Claude Code setting to suppress it: none exists. The one documented
      workaround is running the CLI inside `tmux` with
      `set -g allow-passthrough off`, which blocks the title-setting escape
      sequences from ever reaching the terminal — untried this session
      (means restarting the terminal session, Kyle's call on when). Kyle's
      2026-07-21 call on the wasted time chasing this: stop fighting the
      environment, lean on headless/DOM verification for anything
      mechanically checkable (done — see the axe-core sweep below), and
      save actual ears for one clean pass with the CLI fully closed, not
      just idle, whenever that's convenient — not urgent, since no real
      user will ever have this terminal open.
  - **Box CLOSED 2026-07-21 (later, autonomous walk).** The "one clean
    pass" above turned out not to need the CLI closed at all — the terminal
    flood is filtered out of the debug log instead of silenced (method in
    [[orca-testing-mirafold]] and A.1's closing note). Every overlay's focus
    behavior was verified live, mouse-free, with real Orca audio:
    - **Onboarding** — Tab cycles cwd entry → Claude Code / Codex / Gemini
      cards and wraps; each announced with a real name + "push button" /
      "entry" role; the trap holds (confirmed via DOM `activeElement` on
      each Tab + Orca speech on each).
    - **Connect-device** (the item that never got its live walk before) —
      open moves focus into the dialog ("Close connect a device push
      button"); Tab cycles Close → the pairing-URL scroll box (announced
      with the full URL + "clickable" — the axe-sweep `tabIndex={0}` fix,
      confirmed reachable live) → "copy push button" → wraps; **Escape
      closes it and restores focus to the `⧉ pair` opener** (`sb-pair`) —
      the `useFocusTrap` restore-on-close, proven live.
    - **Settings / theme card** — "Close settings push button", then theme
      rows as "Standard toggle button pressed." / "Solarized Light toggle
      button not pressed." (name + `aria-pressed` state) — re-confirmed.
    - **Fleet session list** — re-confirmed from the 2026-07-21 earlier
      note (each row's Rename/End buttons named per session, the A.3b
      stretched-link fix).
    No focus ever landed on an invisible element, nothing read twice or
    flooded, no control announced as a bare "button". The remaining
    live-audio gaps this step and A.1 had both been carried on
    ("the CLI must be closed", "Kyle's real keypresses") are retired: the
    walk is fully automatable on this box. `.behind-dialog`/`inert`
    sibling-hiding from the earlier session held throughout — no Browse-mode
    leakage into any dialog.

- [x] **Step A.3b — FleetView rows: nested interactive controls** — done
  2026-07-20 (resolved by Kyle's standing rule, same day)
  - Finding (2026-07-20): the plan guessed FleetView needed a roving
    tabindex. It doesn't — `FleetView.tsx:145` is just the rename input's
    Enter/Escape handling, which is fine. The real problem is structural:
    each session row is an `<a href="/s/…">` with **two `<button>`s nested
    inside it** (`fleet-edit` ✎ at :153, `fleet-end` at :174). Interactive
    content inside an anchor is invalid HTML, handled inconsistently across
    screen readers, and it makes the link's accessible name swallow the
    entire row — name, agent, model, session id, status, relative time, and
    the word "end" all read as one enormous link label.
  - This was flagged as Kyle's call because the obvious fix (name becomes
    the link) loses click-anywhere-to-open. **Kyle's answer became a
    standing rule**, verbatim: *"i'm down with EVERY standard pattern for
    accessibility we can add so long as it doesn't change the interface or
    functionality for non-disabled users, only then do i want to be
    consulted."* The **stretched-link card pattern** satisfies exactly that
    bar, so consultation dissolved: the row is now a plain `div`, the
    session *name* is the row's one `<a>` (`.fleet-link`), and its `::after`
    overlay stretches the link's hit area over the whole row — a mouse
    still opens the session from anywhere, a screen reader hears
    "*name*, link" instead of the whole row. The ✎/end buttons (and the
    rename input) ride above the overlay via `position:relative; z-index:1`,
    and both buttons gained `aria-label`s that name their session ("End
    session *name*") — the visible "end"/"✎" alone doesn't say which. The
    buttons' `preventDefault()` calls (there only to stop the old anchor
    navigating) are gone. One knowingly-accepted micro-change: mid-rename
    the name link is unmounted, so clicking row background during a rename
    commits the rename (blur) but no longer ALSO navigates — the old
    behavior was closer to a bug.
  - Files: `web/src/components/FleetView.tsx`, `web/src/styles.css`
    (overlay + z-index), `server/testing/app.e2e.ts`.
  - Verified: new Tier-3 test — row is a `div`, exactly one link per row,
    and the buttons genuinely sit above the overlay (Playwright's hit-target
    check fails the click if the overlay intercepts): "end" arms in place,
    ✎ opens the rename in place, neither navigates; click-anywhere is
    proven by the two pre-existing row-body clicks and the phone tap.
    Typecheck clean, Tier-1 **300 green**, Tier-3 **34 green**.

- [x] **Step A.4 — Public accessibility statement** *(write LAST)* — drafted
  and wired 2026-07-21; goes live with the site when the blackout lifts
  - Goal: a dated, public, specific conformance claim, plus a way to report
    problems. Not a WCAG requirement — a launch artifact, and the honest
    counterpart to the work above. Same precedent as K.5: the document is
    planned here, the page ships in the `mirafold-site` repo alongside
    `terms.html` / `privacy.html` / `refunds.html` (same stylesheet, no
    build step).
  - Build: the standard four parts — the standard targeted (WCAG 2.1 AA),
    the real current conformance status, known limitations stated plainly,
    and a contact path (reuse `support@mirafold.com`, live since K.7). Then
    a footer link and a `sitemap.xml` entry. **Specific and honest beats
    broad**: "conforms except X and Y" is defensible and useful; a blanket
    "fully accessible" claim contradicted by one axe run is worse than
    publishing nothing. Must not be written before A.1–A.3 land.
  - Files: `mirafold-site/public/accessibility.html`, plus that repo's
    footer partial (shared CSS already covers all pages) and `sitemap.xml`.
  - Done when: the page is live, linked from the footer of every site page,
    in the sitemap, and every claim on it is one someone could verify.
  - Status 2026-07-21: **written and wired in the site repo's `staged/`**
    (the real pages all live there during the pre-launch blackout; `public/`
    is a holding page). New `mirafold-site/staged/accessibility.html` — same
    stylesheet, no build step, mirroring `refunds.html`'s structure. The four
    standard parts, kept specific and honest per this step's own rule: the
    target (WCAG 2.1 AA, and why — the DOJ/ADA reference); the real status
    (**partially conformant**, self-assessed, not third-party audited — the
    honest label, not "fully accessible"); what's actually done (keyboard
    operation, focus management, the A.1 live-region announcements, the
    double-AA contrast floor, reduced-motion, focus indicator, `lang`); and
    known limitations stated plainly (no independent audit; Orca/Chrome is
    the most-tested combo; the pairing QR is visual but has a focusable
    text-URL + copy alternative; agent-rendered UI readability depends partly
    on the connected agent; automated scanning is only ~⅓ of WCAG). Contact:
    `support@mirafold.com`, five-business-day aim, degrade-gracefully promise.
    Footer `accessibility` link added to all five pages (terms, privacy,
    refunds, contact, index) and a `/accessibility` entry added to
    `sitemap.xml`. Rendered at 1280 and 390 widths — clean, on-brand.
  - **Not "live" yet, and one finding it surfaced is Kyle's call.** The page
    only goes public when the site blackout lifts (same gate as terms/privacy/
    refunds, which are also staged-only) — so the "live" half of Done-when is
    pending the restore, not this step. Dogfooding the whole site through
    axe-core (the C.2 tooling, pointed at `staged/`) turned up **two real
    WCAG-AA colour-contrast failures on the marketing site itself** — and one
    of them is on the accessibility page's own footer, so it matters for the
    claim:
    - `footer > p` tagline (**every page**): `--faint #58627a` on `--bg-2
      #0c1017` = **3.12:1** (needs 4.5). Hue-preserving fix: `--faint` →
      `#798195` (clears 4.9:1 on the darkest surface it lands on).
    - the `.copy` button (**index**): `--dim #7b8698` on `--surface-3
      #1b2230` = **4.32:1**. Fix: `--dim` → `#838d9e` (clears 4.76:1).
    Both are shared brand tokens on the marketing site, so bumping them is a
    visible palette change to Kyle's site design — his call, not a silent
    edit (the standing a11y approval is for changes invisible to sighted
    users; a token recolour isn't that, and the site's visual design is
    explicitly Kyle's domain). **Not applied — flagged for his sign-off.**
    Tracked in `mirafold-site/PLAN.md`. The statement's own text is scoped to
    "the Mirafold web application" (the product, which scans axe-clean at
    serious/critical — see C.2), so its claims stand; the site-footer contrast
    is a separate surface and should be fixed before the site goes live so the
    page isn't served with a contrast failure on its own footer.

**2026-07-21 — manual axe-core sweep, run ahead of C.2.** Tonight's Orca walk
kept getting derailed by environment problems, not app bugs (see A.1/A.3's
notes above): a stray real `ANTHROPIC_API_KEY` in `.env` silently defeated the
mock's deterministic triggers, and this same Claude Code CLI terminal's own
title animation flooded Orca's AT-SPI event queue badly enough to make its
speech unintelligible, even seemingly while idle — cause not fully isolated;
no Claude Code CLI setting exists to suppress it (checked), only an
untried external `tmux allow-passthrough off` workaround. Kyle's call
(2026-07-21): stop burning time on that environment fight tonight — it's
self-inflicted and irrelevant to real users, who'll never have this terminal
open. Split the work instead: everything mechanically checkable, do headlessly
now; the genuinely human-judgment "does it sound right" pieces, save for one
clean pass with the CLI fully closed (not just idle), on Kyle's own time.
In that spirit, axe-core 4.10.2 (CDN, not installed as a dependency — a
one-off gut-check, not yet wired into Tier 3) was run by hand against the
live dev session across four states: the fleet/landing view, connect-device
open, onboarding open, and a live session transcript with a rendered
checklist. Three real, previously-unknown findings, two fixed on the spot as
standard invisible-to-sighted-users patterns (pre-approved, [[a11y-standing-
rule]] in memory):
  - **Fixed:** `.pair-url` (`ConnectDevice.tsx`) — the pairing URL's
    `overflow-x: auto` scroll box had no `tabindex`, so a keyboard user could
    never focus it to scroll and read the full URL. Added `tabIndex={0}`.
    Zero visual change.
  - **Fixed:** GFM task-list checkboxes (`- [x] thing` in any rendered
    markdown — the plan-it-step-by-step checklist, any future checklist
    render) had NO accessible name — axe flagged it `critical`. The label
    text is a sibling of the `<input>` inside the `<li>`, not a child of it,
    so the fix lives in a new shared `li` override in
    `web/src/registry/Md.tsx`'s `safeAnchor` (consumed by both `Md`/
    `MdDetail` and `RenderZone`'s turn-text rendering): pulls the checkbox
    out of the item, reads the rest of the `<li>` as its `aria-label`. Zero
    visual change — the checkboxes are already `disabled` (decorative
    reflection of markdown state, never real form controls).
  - **Fixed, Kyle signed off (2026-07-21, "minor changes like that are
    okay"):** `--warn-fg` in the **light** theme (`#737300` → `#6e6e00`) and
    `--accent` in **light** (`#008000` → `#007c00`) and **solarized-light**
    (`#677600` → `#606d00`), plus solarized-light's `--info` and `--error`
    (both ~7% darker). All were passing the Tier-1 guard's 4.5:1 floor
    against `--bg` (the only surface it checked) but fell short — as low as
    3.57:1 — against the actual card/badge surfaces they render on in
    practice (`.onb-blocked`, `.onb-agent-detail`, `.demo-banner-badge`).
    Separately, `.onb-agent-detail`'s deliberate `opacity: 0.85` dim
    (`styles.css`, "reads as confirmation, not a warning") was dropped
    entirely — full-strength `--accent` lands exactly on this codebase's own
    stated accent floor (`accents ≥4.5`, this section's intro), no dimming
    needed. **The guard itself is fixed too**: `themes.test.ts`'s accent
    contrast test now checks the same `TEXT_SURFACES` list the tier-floor
    test already used, not just `--bg` — this is what surfaced all of the
    above, plus more.
  - **Also fixed, same sign-off, after a caught mistake:** the same guard
    extension caught six more real gaps — **solarized-dark's entire accent
    set** (worst case 3.9:1) and **`--error` alone in dracula/gruvbox-dark**
    (4.0–4.3:1). First pass here got the fix direction wrong: a script
    computed "darken by ~60%" for all of these without checking that dark
    themes put LIGHT text on a DARK background, so darkening further would
    have *reduced* contrast, not fixed it — caught before anything was
    applied by checking each theme's actual `--bg` value, and corrected to
    brightening (7–14%, not 60%) for all six. `dark`'s `--error` was
    misreported as failing in an earlier note here — it was never actually
    below the floor (4.94:1); no change needed there. Final values: solarized-
    dark `--accent` `#859900`→`#94a61f`, `--info` `#3496da`→`#4ea4df`,
    `--warn-fg` `#b58900`→`#be981f`, `--error` `#e56865`→`#e97d7a`; dracula
    `--error` `#ff5555`→`#ff6e6e`; gruvbox-dark `--error` `#fb5844`→`#fb6552`.
    Every fix (all 7 themes now) uses the same method: scale RGB channels by
    a uniform percentage toward white or black as appropriate, which
    preserves hue exactly — nothing shifted color family, only how far it
    sits from its background. No debt left; the temporary
    `ACCENT_SURFACE_CONTRAST_DEBT` allowlist was added then removed the same
    session once every entry was resolved.
  - Typecheck clean, Tier-1 **300 green**, Tier-3 **35 green** (includes the
    new A.1 tool_use/permission_request test from tonight, see A.1's status
    note above) after all fixes, all 7 themes.

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

## Phase C — CI/CD (opened 2026-07-20; pre-launch)

Kyle is standing up CI/CD shortly. As of 2026-07-20 there is **none** in any
of the three repos: `genui-shell/.github/` holds only an issue template, there
are no workflows and no git hooks, and neither `genui-relay` nor
`mirafold-site` has a `.github/` at all. Verification today is Kyle running
`yarn test` / `test:server` / `test:e2e` by hand — a good habit, but a habit.

Sizing note from the 2026-07-20 read: **Tier 3 is unusually CI-ready.** The
browser path is already an env override (`process.env.CHROME_BIN ??
"/usr/bin/google-chrome"`, e.g. `server/testing/app.e2e.ts:17`), Playwright
launches headless by default (no virtual display needed), and the harness
forces credentials empty → `MockSession`, so there are **no secrets to
provision, no API spend, and no live-model flakiness**. Both previously-named
flakes were root-caused and fixed 2026-07-19 (`9de5bc1` Tier-2 handshake
listener, `60b8307` Tier-3 settle); the only residual is a single
uncharacterized sighting of the Tier-2 per-pair viewport-cap test.

- [x] **Step C.1 — Stand up CI** *(Kyle's call on scope)* — done 2026-07-21
  (both CI pipelines green on open PRs, awaiting Kyle's merge)
  - Goal: the test suite runs itself on every push, so nothing load-bearing
    depends on remembering.
  - Build: GitHub Actions. Decide the tier schedule — Tier 1 on every push
    is seconds; Tier 2 and Tier 3 are minutes (`test:e2e` runs `yarn build`
    first), so the normal split is those on pull requests and on the default
    branch. Node 22 + yarn; confirm whether `ubuntu-latest`'s preinstalled
    Chrome sits at the default path or `CHROME_BIN` needs setting. Turn on
    the DCO check at the same time (owed from K.9, gated on the public flip).
    **Tier 4 (`test:live`) never runs in CI, and no provider credential is
    ever added to repo secrets** (2026-07-20 audit): it drives real binaries,
    and one of its tests deliberately uses a real `OPENROUTER_API_KEY` against
    openrouter.ai. In CI that means real spend on every run, third-party
    requests attributed to the key from GitHub's runners, and — once the repo
    is public at R.7 — a secret reachable by anyone who can get a workflow to
    run. It stays a local, hand-run tier.
    CD (deploy) is a separate question — the relay's deploy path and the
    site's Cloudflare Pages build are already their own mechanisms.
  - Files: `.github/workflows/` in each repo as scoped.
  - Done when: a pushed commit gets a pass/fail mark automatically, a
    deliberately broken test turns it red, and a green run means the same
    thing a local full-suite run means.
  - Status 2026-07-21: **done — GitHub Actions live on both code repos, both
    green, each on an open PR for Kyle to merge** (`mirafold/mirafold#1`,
    `mirafold/mirafold-relay#1` — not self-merged; merging to `main` is
    Kyle's call). Scope taken (the "Kyle's call" flag, exercised with
    sensible defaults):
    - **genui-shell** (`.github/workflows/ci.yml`): two jobs on push-to-main
      + every PR — `unit` (typecheck + `yarn test`, Tier 1, ~2m) and
      `integration` (Tier 2 real daemon/sockets + Tier 3 headless Chrome,
      ~5m). Node 22 + yarn. Chrome is resolved on the runner and passed via
      `CHROME_BIN` (ubuntu-latest ships google-chrome-stable; the "Locate
      Chrome" step is future-proofed against image changes). **Tier 4
      excluded** — no provider credential in secrets. Green: unit 2m15s,
      integration 4m42s.
    - **genui-relay** (`.github/workflows/ci.yml`): one job (npm, Node 20) —
      `npm ci` + typecheck + `npm test`. Green in 19s. No browser, no
      secrets.
    - **mirafold-site**: no CI added — it has no test suite (static HTML/CSS,
      no package.json); Cloudflare Pages is already its build/deploy
      mechanism. Noted, not a gap.
    - **DCO check**: deferred (K.9, gated on the public flip — repos private
      today).
  - **The one thing CI surfaced (a real cross-repo finding):** the shell's
    first run went red because `server/relay/relay-service.itest.ts` imports
    the relay under test from the **sibling `../genui-relay` checkout**, which
    a single-repo CI job doesn't have — and the relay repo is private
    pre-launch, so cloning it in CI would need a secret (contradicting this
    phase's no-secrets sizing). This tripped BOTH typecheck (tsconfig includes
    `server`) and `test:server`. Resolved without a secret: a CI-only
    `tsconfig.ci.json` (== `tsconfig.json` minus that one file) for typecheck,
    and a `find … ! -name relay-service.itest.ts` filter for Tier 2. Every
    other itest is self-contained (`relay.itest.ts` uses the in-repo
    relay-stub), so coverage loss is exactly that one cross-repo proof, which
    still runs locally. **Clean upgrade path documented in `tsconfig.ci.json`
    and the workflow header:** when the relay goes public (K.1/R.7), CI can
    check it out as a sibling unauthenticated — drop both exclusions and add
    the checkout, and the cross-repo proof runs in CI too. (Alternative if
    Kyle wants it in CI sooner: a read-only fine-grained PAT for the relay
    repo as a secret — a repo-scoped token, not a provider credential, so it
    doesn't touch the absolute no-subscription bound; his call, not taken.)
  - Cosmetic: GitHub warns `actions/checkout@v4`/`setup-node@v4` use the
    deprecated Node-20 action runtime (auto-forced to Node 24) — harmless,
    bump to `@v5` whenever convenient.
  - **Security hardening applied 2026-07-21 (from the audit of this C.1 work).**
    Both workflows now set `permissions: contents: read` — the auto-provisioned
    `GITHUB_TOKEN` is read-only, so once a repo is public a fork PR's test run
    (or a malicious dependency install-script) can't use the token to push to
    the repo. No secrets are used and none should be (the "no provider
    credential in repo secrets" bound is absolute). Remaining audit items are
    ship-time and parked on **R.5b** (SHA-pin the official actions at the flip;
    re-enable the cross-repo relay itest when `genui-relay` is public). The
    audit found nothing exploitable today; `speechFromMarkdown` was tested
    against hostile agent output (no XSS — React escapes; no ReDoS — <44 ms on
    300 k adversarial chars), and axe-core is a devDependency that never ships.
  - **⚑ OPEN — the Tier-2 integration suite is flaky in CI (Kyle to address
    next session, 2026-07-21).** Standing up C.1 exposed it: the shell's
    `integration` job (Tier 2 real daemon/sockets/PTYs) fails a *different*
    timing-sensitive test on most runs while ~72/73 pass. Observed across
    reruns of `mirafold/mirafold#1`: `bang.itest.ts` "bang_kill ends it with a
    null exit code", then `backend-choice.itest.ts` N.5 "discovered-server pick
    rides to the engine", then N.5 "opposite codex choices are honored" — each
    a one-off, never the same twice. **It is NOT the security change and NOT
    any of this session's code:** the branch's FIRST CI run (before the
    `permissions` commit) was fully green, the exact filtered Tier-2 command
    passes **73/73 locally**, and a `contents: read` token cannot touch
    socket/PTY timing. It's pre-launch runner flakiness the plan already half-
    knew about (the Phase C sizing note's "single uncharacterized sighting of
    the Tier-2 per-pair viewport-cap test" — it's broader). **Why it matters:**
    an `integration` job that reds ~1-in-3 on random tests trains everyone to
    ignore red, defeating C.1. **So the shell PR #1 currently shows a red
    `integration` check purely from this flake** — the `unit` job and the whole
    relay PR are green; don't read the red as the CI setup being wrong. Options
    for Kyle (I did NOT touch the tests): (1) bounded retry on the Tier-2 CI job
    — cheapest, restores trust, hides root cause; (2) quarantine + fix the
    specific races (bang-kill timing, N.5 backend-choice concurrency) — the
    real fix; (3) generous CI-only timeouts (concurrency is already 1);
    (4) leave it advisory until launch (green locally). Both CI PRs are still
    open awaiting Kyle's merge regardless.
  - **Kyle's calls, 2026-07-22 (all executed same day except the flake fix):**
    - **Both CI PRs merged** — CI is live on both mains.
    - **Flake: option (2), fix the races — DONE 2026-07-23** (no quarantine
      needed; every race was root-caused and fixed at source). The surface
      was WIDER than the 3 named "so far": **six** flaky tests, three root
      causes, all reproduced under `taskset -c 0` + CPU stress before fixing
      (PR `mirafold/mirafold#5`):
      1. **Log-vs-socket race (4 tests):** backend-choice ×2, bang R.4f,
         session.itest bad-cwd/skew/client_error asserted `daemon.logs()`
         immediately after a wire event — but the log rides the child's
         stdout PIPE while the event rides the socket, independent channels,
         so under load the event wins. New `Daemon.waitForLog(re)` helper;
         swept the whole itest suite and converted every instance (the two
         survivors — auth EADDRINUSE, relay weak-code — read settled startup
         logs / already gate on waitForLog, verified not racy).
      2. **bang-kill pre-attach race:** killed `sleep 30` right after
         bang_start, but a kill before the PTY child attaches can surface as
         a clean exit not signal death → now `echo up && sleep 30` and waits
         for output (proof of a live process) before killing.
      3. **axe animation sampling:** fleet rows enter with `rise` (opacity
         0→1); on a loaded runner axe sampled mid-animation and read the
         faded text as a color-contrast violation. `assertAxeClean` now
         injects a zero-duration style so animations jump to their resting
         frame (the state we mean to audit) before running.
      4. **RemoteClient unhandled rejection (the 6th, subtlest):** the
         wrong-code `assert.rejects` connect opens then is closed immediately
         by the relay, and under load the close rejects `hsDone` DURING the
         `await sealHandshake` — before `await hsDone` is reached — so the
         rejection is unhandled and CRASHES the whole test process (reported
         as the file failing, though the assert.rejects itself passed).
         Proven with instrumentation: daemon drop paths logged 0, 22/40
         unhandled under stress. Fix: `hsDone.catch(()=>{})` the instant it
         exists. After: 60/60 clean under the same stress.
      Proven by repeated green CI cycles on the actual runner (the branch was
      re-run multiple times), not a single pass. NO product code changed —
      every fix was in test code or test harness; the "flake" was never a
      real product bug.
    - **Integration job runs on PRs only** (`a771110`) — pushes to main run
      Tier 1 only; the slow tiers ran on the PR that merged them. Actions
      bumped to v5 in both repos (deprecation cleared).
    - **Branch protection: blocked by GitHub's paywall** — classic protection
      AND rulesets both 403 ("Upgrade to GitHub Pro or make this repository
      public") on free-plan private repos. Intended solo-dev shape when
      available: required checks (unit now; integration once the flake is
      fixed), no review requirement, admin bypass for direct pushes, no
      force-push/delete. Pay (org → Team) or wait for the public flip
      (K.1/R.7) — deferred, revisit at R.5b.
    - **Deployment is manual-dispatch only — standing directive for all CD
      work in every repo** (his job's `on-prod.yml` pattern: a human clicks
      Run workflow and picks the ref; nothing ever deploys on push, merge,
      or schedule). Scaffolded for the relay same day:
      `genui-relay/.github/workflows/deploy.yml` (`9162fa1`), inert until a
      `FLY_API_TOKEN` secret exists; the one-time deploy-day steps stay
      manual per that repo's `DEPLOY.md`.

- [x] **Step C.2 — Automated accessibility check (axe-core) in Tier 3** —
  done 2026-07-21
  - Goal: the regression guard for Phase A. Accessibility decays silently —
    a refactor swapping a `<button>` for a styled `<div>`, or dropping an
    `aria-label`, looks and behaves identically to a sighted mouse user and
    is a wall to a screen-reader user. The theme contrast floors are the
    proof the pattern works: they hold across two new themes and multiple
    rounds of edits because a test remembers them. Nothing else in the UI has
    that memory. Note the scope honestly: automated scanning catches roughly
    a third of WCAG issues — the machine-checkable subset. It does not
    replace A.3's manual pass.
  - Build: **Tier 3, not Tier 1.** Web unit tests render no React at all
    (`node:test` over pure functions — see `web/src/components/ToolBlock.test.ts`);
    there is no jsdom, happy-dom, or Testing Library anywhere, and the
    zero-test-deps rule says keep it that way. Tier 3 already drives real
    Chromium against the real app. So: add `axe-core` as a dependency, inject
    its source into the page, run it via `page.evaluate`, and assert zero
    violations at `serious` and `critical`. The real cost is **triage of the
    first run** — every codebase's first scan reports findings; each becomes
    a fix or a documented exception. This step does **not** depend on C.1 —
    the check is just a test, so it can (and should) land first and be
    triaged to green locally; CI then picks it up for free.
  - Files: `server/testing/app.e2e.ts`, `package.json`.
  - Done when: `yarn test:e2e` fails on an introduced accessibility
    regression (verified by deliberately breaking one), passes clean
    otherwise, and every accepted exception is written down with its reason.
  - Status 2026-07-21: **done, and the "fails on a regression" clause was
    actually exercised.** `axe-core@4.10.2` added as a devDependency (the
    same version the 2026-07-21 manual sweep used), injected into the live
    Playwright page via `addScriptTag({ content: axe.source })` and run with
    `axe.run` — no jsdom, honoring the zero-web-test-deps rule (the scan runs
    in real Chromium, not a DOM stand-in). New test "C.2: axe-core finds no
    serious/critical WCAG violations across the app" (`app.e2e.ts`) stands up
    its own daemon + relay stub and scans **five surfaces**: onboarding, a
    live session transcript (with the rendered checklist), the settings/theme
    dialog, the connect-device dialog (the relay stub is why it's reachable —
    the pair button renders only with a relay), and mission control/fleet.
    Fails on `serious` + `critical` only (WCAG 2.0/2.1 A + AA tags);
    `moderate`/`minor` are left out as noisier and less clearly real.
    **First run passed clean** — the manual sweep had already fixed every
    real finding, so there were zero to triage and `AXE_EXCEPTIONS` is empty.
    Guard proven live: temporarily stripped the settings button's accessible
    name (gear glyph `aria-hidden`, no title/label) → the scan flagged
    `button-name` (critical) on the session + fleet states and the suite went
    red; reverted → green again. Full Tier-3 **36 green**, typecheck clean.
    Honest scope unchanged: this is the machine-checkable ~third of WCAG; it
    does not replace A.3's screen-reader pass (now itself automatable — see
    [[orca-testing-mirafold]]). Note for C.1: `test:e2e` already runs Chrome
    headless with credentials forced empty, so this needs no secrets in CI —
    it rides the normal Tier-3 job.

---

## Phase D — Decompose the Codex adapter (opened 2026-07-20)

`server/adapters/codex.ts` is **824 lines** and carries at least five separable
concerns. For scale, the other two real adapters are 499 (`claude-code.ts`) and
382 (`gemini-cli.ts`) — it isn't merely the biggest, it's nearly the other two
combined, and it grew again on 2026-07-20 (provider binding + the notice fix).
Size alone wouldn't justify a step; the reason it's worth doing **now** is that
two separate 2026-07-20 bugs both lived in the seams between those concerns —
the engine-default lookup didn't know what the provider binding had decided,
and a non-fatal engine item was classified where the fatal ones are handled.
Concerns that can't see each other's decisions are exactly what splitting makes
visible.

Do it now, before Phase F widens the adapter's event vocabulary further: every
type added to `handleEvent`/`onItem` afterwards makes the split more expensive.

**This is a pure refactor — zero functional change.** It is well protected:
298 Tier-1 tests, the Tier-2 and Tier-3 suites, and the Tier-4 live tier, all
green as of 2026-07-20 (318 Tier-1 as of 2026-07-23).

**2026-07-23 — pre-launch refactor pass (unplanned maintenance, whole repo)**
landed a behavior-preserving sweep that overlaps this phase's spirit without
executing it: server-side, an `errText()` helper in `adapters/types.ts`
replaced the 9 copy-pasted unknown-error idioms, `claude-code.ts`'s `pump()`
had its 50-line `system` case extracted to `handleSystemMsg()`, `codex.ts`
gained `finishTool()` (the 4× announced-delete + tool_result emit), and
`connection.ts`'s module-load `OFFERABLE` now reads the static
`ADAPTER_AGENTS` list instead of running full credential detection at import.
Web-side: `ModalCard.tsx` absorbed the modal scaffold shared by
ConnectDevice/ThemePicker/Onboarding, `useArmedConfirm` the two-click
end-session state (StatusBar + FleetView), `DiffLines` the duplicated diff-line
JSX (ToolBlock + registry Diff), plus one real bug fixed: both Onboarding
callers passed a fresh inline `onRefresh` arrow, so the picker's 3s re-probe
poll was reset on every parent render and effectively never fired — both now
pass a `useCallback`-stable function. README §11's accepted-duplication list
was honored throughout (worker() loops, listener/emit boilerplate, RenderZone
upsert twins all untouched). All tiers green after (318 / 86 / 37).

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

- **WATCH ITEM (2026-07-24): the follow-tail re-arm race** — seen once on the
  CI runner (app.e2e.ts "re-follows once back at the bottom", sat 188px above
  the tail), green on rerun and on every local run; ROOT-CAUSED same day, fix
  deferred. Mechanism: re-arming depends on `use-follow-tail.ts`'s `onScroll`
  measuring within `BOTTOM_SLACK_PX` (24) of the bottom, but scroll events
  fire a frame after the scroll — under load the stream can paint >24px in
  that gap, so a reader (or the test's single programmatic jump) landing at
  the bottom mid-stream measures as "not at bottom" and follow never re-arms.
  A REAL product race, not only test fragility — narrow, and a human recovers
  by scrolling again, which is why it's a watch item not a blocker. Proposed
  fix shape when picked up: arm on INTENT like detach already does (a
  downward wheel/touch ending near the bottom re-arms), so re-arming stops
  depending on winning a paint race; the hook's two locked decisions
  (2026-07-20 trace) must be re-read first. The test's single jump + single
  sample then stops being timing-sensitive on its own.

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

## Phase E — Explorer (opened 2026-07-24; Kyle-directed — the folder & file & diff view, promoted from POST-RELEASE.md; **next up**)

The "Folder & file & diff view" intake entry, promoted to active work: a
shell-owned, **read-only** browser of the session's working tree — the file
tree, any file's contents, and git diffs of what changed. Design settled with
Kyle 2026-07-24. The governing principles:

- **Shell-owned and read-only.** The agent paints nothing here — same trust
  rule as the permission bar. No editing in v1; that persona belongs to the
  embedded-terminal-pane idea (POST-RELEASE.md).
- **Wire-native, per-viewport.** New ADDITIVE protocol types over the existing
  WebSocket (never HTTP — remote/relay viewports have no HTTP path to the
  daemon, so wire-native means the phone gets this by construction). Replies
  are per-viewport with a client-minted echoed `id` — the
  `refresh_agents`→`agents` shape plus the bang-id precedent — never
  broadcast, never replay-buffered, no `seq`.
- **Jailed.** Every path resolves through `inside()`'s realpath containment
  against `entry.cwd` (the immutable session root, never `bangCwd`), with the
  `.env`/`.env.local` secret denial on top — the file viewer must not become a
  bypass of the permissions guard.
- **Diffs are `{before, after}`, diffed client-side.** `before` is
  `git show HEAD:path`, `after` is the working tree; the client runs the
  existing `diffLines` LCS differ so Explorer diffs render identically to
  ToolBlock's Edit/Write diffs and the registry `diff` component. Hunk text
  never crosses the wire — no `@@` parsing anywhere.
- **Two presentations, one component set** (Kyle's calls): desktop = a
  VS Code-style collapsible LEFT side panel; phone (≤640px) = full-screen
  drill-in layers (GitHub-mobile style: StatusBar affordance → tree → file/diff
  → back), explicitly NOT a bottom sheet. This claims the split-pane layout
  slot the embedded terminal pane will later share.

Accepted v1 limits, on purpose: ignored files are invisible in-repo
(`ls-files --exclude-standard` semantics — they still appear in non-repo
dirs); independently-capped diff sides can overstate changes past the cap
(the truncation markers render prominently above the diff); full
`role="tree"` arrow-key grammar is deferred to Phase KB territory — buttons
in nested lists are tabbable and axe-clean.

- [x] **Step E.1 — Wire contract + server fs module (no git yet)**
  - Goal: a viewport can request the working tree's file list and any file's
    content over the existing WS — per-viewport, jailed, secret-safe, capped —
    against any directory, repo or not.
  - Build: `protocol.ts` additive types — ClientMsg `fs_list {id}` and
    `fs_read {id, path}`; WireMsg
    `fs_tree {id, root, entries, git, truncated?, error?}` and
    `fs_file {id, path, content?, truncatedBytes?, binary?, size?, error?}`.
    Wire paths are always root-relative and `/`-normalized (the `buildTree`
    contract); every request gets exactly one reply — errors ride the reply,
    never silence. New `server/sessions/fs-explorer.ts`: capped recursive walk
    (`lstat`, symlinks listed as leaves and never followed as dirs, skip
    `.git`/`node_modules`, ~4,000-entry AND byte caps with an honest
    `truncated: true`), file read through `inside()` (exported from
    `actions.ts`) plus a secret-path predicate exported from `permissions.ts`
    (deny `.env`/`.env.local` basenames — the tree still LISTS them, only
    content is refused: honesty over hiding), NUL-sniff binary detection (no
    content for binaries), `capOutput` reuse for the 64 KB cap +
    `truncatedBytes`, lossy UTF-8 decode for non-UTF-8 text. `connection.ts`:
    new switch cases — `entry` guard (fs is session-scoped), input validation
    (bang-id regex; length-capped path), a per-connection throttle
    (`FS_MIN_INTERVAL_MS`, throttled requests still answered with an error
    reply), the `closed` guard on async completions, and every handler
    throw-wrapped (a sync throw on the local WS path kills the daemon).
  - Files: `server/protocol.ts`, `server/sessions/fs-explorer.ts` (new),
    `server/sessions/connection.ts`, `server/sessions/actions.ts` (export
    `inside`), `server/security/permissions.ts` (export the predicate).
  - Done when: Tier 1 covers walk caps, symlink-leaf behavior, binary sniff,
    secret denial, and the UTF-8 fallback; Tier 2 (new `fs-explorer.itest.ts`
    plus `hostile-client.itest.ts` additions) proves over a real socket:
    `fs_list`→`fs_tree` round-trips in a temp dir; `../`, absolute-path,
    planted-symlink-escape, and `.env` reads all come back as error replies
    with the daemon still alive; a request burst is throttled but answered; a
    request with no session attached errors cleanly; a deleted session root
    errors, never crashes. `yarn typecheck` clean; all existing tests green
    (Tier 1 ≥318 / Tier 2 ≥86 / Tier 3 37, counts as of 2026-07-23).
  - *2026-07-24: DONE, on `feat/explorer-e1`. Shipped as specced with one
    Build deviation: the read cap is applied via bounded fd reads (own
    `FS_FILE_CAP_BYTES` knob, same 64 KB default and honesty contract as
    `capOutput`) instead of calling `capOutput` — that function needs the
    whole string in memory, so a multi-GB file would have been loaded just to
    be truncated; the fd path reads at most sniff + cap bytes. Every "Done
    when" case observed: Tier-1 fs-explorer suite (walk shape/caps, symlink
    leaf, jail incl. symlink-out, secret basenames, binary sniff, cap math,
    lossy UTF-8, empty file) + `isSecretFile` pin + the Q.2 protocol fixtures;
    Tier-2 `fs-explorer.itest.ts` (round-trip, secret/jail refusals as error
    replies with the daemon proven alive after, throttle answers then
    recovers, no-session, deleted-root) + 6 hostile Explorer frames in the
    Q.4 sweep (bad ids dropped whole and leak-checked against viewport B).
    All tiers green **336 / 91 / 38**.*

- [x] **Step E.2 — Git layer: tracked tree, change status, per-file diff**
  - Goal: in a repo, the tree is git's view (tracked + untracked-unignored)
    with per-file change status, and any file answers "what changed" as
    `{before, after}` — degrading to E.1 behavior when there's no repo, no git
    binary, or an unborn HEAD, never crashing.
  - Build: new `server/sessions/git.ts` — promisified
    `execFile("git", args, { cwd, timeout ~5s, maxBuffer })`, settle-once
    (jsonrpc-oneshot.ts is the lifecycle model; execFile's built-in
    timeout/maxBuffer does the work), a typed not-a-repo result instead of a
    throw, at most one git child in flight per connection (a second request
    while busy gets an error reply, like the bang already-running refusal).
    Tree source: `git ls-files --cached --others --exclude-standard -z`
    (cwd-relative output). Status: `git status --porcelain=v1 -z` — porcelain
    paths are repo-ROOT-relative, so strip `git rev-parse --show-prefix` (the
    subdirectory-session trap), and parse `-z` rename records as their TWO
    NUL-separated fields (a naive split misaligns every later entry; collapse
    renames to D(old)+A(new) for v1). Deleted files stay listed (status `D`)
    though absent on disk. Protocol additive: ClientMsg `fs_diff {id, path}` →
    WireMsg `fs_file_diff {id, path, before?, after?, beforeTruncatedBytes?,
    afterTruncatedBytes?, binary?, error?}`; `before` = `git show HEAD:./<rel>`
    (the `./` form is cwd-relative), absent-in-HEAD or unborn HEAD → `""` (the
    empty-side case the client's `diffSnippet` already handles); both sides
    independently `capOutput`'d; binary on either side → `binary: true`, no
    text; submodules degrade to "no diff available".
  - Files: `server/sessions/git.ts` (new), `server/sessions/fs-explorer.ts`,
    `server/sessions/connection.ts`, `server/protocol.ts`.
  - Done when: Tier 1 pins the porcelain parser (rename records, status
    collapse); Tier 2 in a scripted temp repo (`git init` + commits inside the
    test): tracked + untracked listed, ignored excluded; modified, added,
    deleted, and renamed files all diff correctly; a session rooted in a repo
    SUBDIRECTORY labels statuses correctly; a non-repo dir and an unborn-HEAD
    repo degrade instead of erroring; all tiers green.
  - *2026-07-24: DONE, on `feat/explorer-e1` (same PR as E.1). As specced,
    with two additions beyond the Build text: (1) `cleanRelPath` — a pure
    TEXTUAL containment check applied to `fs_diff` paths before git ever sees
    them, because `git show HEAD:./<rel>` resolves against the REPO, not the
    filesystem, so the realpath jail can't cover it and a `../` could read
    repo files above a subdirectory session's root; (2) porcelain COPY
    records keep their source unmarked (only a rename's source is D — a
    copy's source still exists unchanged). One deviation carried from E.1:
    before-side capping via `capBuffer` (same 64 KB + honesty contract as
    capOutput, applied to the in-memory git blob). One E.1 test taught a
    lesson worth keeping: the throttle error is sync while the served reply
    is now async, so replies are correlated by echoed id, never arrival
    order — the itest pins that. Observed: Tier-1 parser pins (rename
    two-field alignment, copy source, collapse chars, cleanRelPath); Tier-2
    `fs-git.itest.ts` against a scripted repo — git's-view tree (ignored
    excluded, staged delete + rename source visible), modified/added/
    deleted/renamed diffs, the SUBDIRECTORY prefix-strip session, unborn
    HEAD, `.env`-diff refusal, `../` refusal. All tiers green **342/95/38**.*

- [ ] **Step E.3 — Desktop: the Files side panel** (~1.5–2 days)
  - Goal: a collapsible left column beside the transcript — tree → click a
    file → content or diff — VS Code-shaped, shell-owned, refresh-on-demand.
  - Build: `session-bus.ts` gains `requestFsList()/requestFsRead(path)/
    requestFsDiff(path)` — mint and return the id (the `sendBang` shape); the
    new `fs_*` messages flow to subscribers automatically and RenderZone
    ignores them (the R.4h ignore-unknown contract). Layout: inside
    `.behind-dialog`, wrap the existing column in a new flex row with
    `FilesPanel` as the left child (PinDock's side-by-side styling is the
    precedent); fixed ~280–320px width, `min-width: 0` on the transcript and a
    panel `max-width` clamp so panel + PinDock + prompt coexist; collapsed by
    default (nothing changes for users who don't open it). StatusBar files
    toggle via the `sb-settings`/`onOpenSettings` prop-threading pattern, with
    `aria-expanded` and a real `aria-label`. New shell-owned components under
    `web/src/components/files/` — `FilesPanel.tsx` (request/response state
    keyed by echoed id; stale replies dropped) and `FileView.tsx` (content:
    plain `<pre>` with the tool-code styling + `formatBytes(truncatedBytes)`
    elided marker; diff mode: `diffLines` + `DiffLines`, identical rendering
    to ToolBlock; binary → a "binary file (N bytes)" stub; denied → the
    refusal line) — plus `web/src/files-tree.ts`, a shell-owned copy of
    `buildTree`'s flat→nested approach (never import the registry component —
    that's agent surface). Guard the O(n·m) LCS client-side: past ~4M cells,
    skip the diff and show the after side with a "diff too large" note. The
    diff affordance shows only when the entry has a status char AND
    `fs_tree.git`. Freshness: a refresh button in the panel header re-sends
    `fs_list` (and re-requests the open file); opening the panel fires the
    first `fs_list`; session switch / non-resumed `session_created` clears all
    panel state and refetches if open.
  - Files: `web/src/session-bus.ts`, `web/src/components/Shell.tsx`,
    `web/src/components/StatusBar.tsx`, `web/src/components/files/` (new),
    `web/src/files-tree.ts` (new), `web/src/styles.css`.
  - Done when: Tier 1 pins the tree builder, stale-id filtering, and the
    diff-size guard; Tier 3 (`app.e2e.ts`): the toggle opens the panel, a file
    created by the mock session appears after refresh, clicking it shows
    content, the transcript still renders beside it, the prompt box stays
    visible with the panel AND PinDock both open, and the C.2 axe scan runs
    with the panel open (a new scanned surface) with no serious/critical hits.

- [ ] **Step E.4 — Phone: full-screen drill-in** (~0.5–1 day)
  - Goal: at ≤640px the same data presents as stacked full-screen layers —
    StatusBar affordance → tree → file/diff → back — never a squeezed panel.
  - Build: branch on the 640px breakpoint with a LIVE matchMedia check (not
    the module-load constant); each layer is a `ModalCard` (dialog semantics,
    focus trap, Esc = back — the Phase A discipline for free) with a back
    button top-left; the tree stays mounted under the file layer so back
    returns with scroll position intact; reuse E.3's components — only the
    container differs.
  - Files: `web/src/components/files/`, `web/src/components/StatusBar.tsx`,
    `web/src/styles.css`, `server/testing/phone.e2e.ts`.
  - Done when: `phone.e2e.ts` at phone width: the affordance opens a
    full-screen tree; tapping a file opens the full-screen view; back returns
    to the tree; Esc closes the top layer only; `noSideScroll` passes on every
    layer; focus returns to the opener on final close; the axe scan of the
    layers is clean.

- [ ] **Step E.5 — Polish (optional; the cut line)** (~0.5 day)
  - Auto-refresh the open panel on `turn_end` (the server throttle already
    protects the daemon); changed-files-first grouping in the tree;
    panel-collapsed/expanded-dirs persistence (localStorage, the theme-key
    precedent); revisit syntax highlighting (plain v1 is deliberate —
    consistent with tool-code; highlight.js is already bundled if wanted
    later). Everything here is safe to drop.

---

## Phase M — Mission control (opened 2026-07-24; Kyle-directed — the cockpit fleetview, promoted from POST-RELEASE.md)

The "Cockpit fleetview" intake entry, promoted to active work: grow FleetView
(4.6) into a true cockpit — at-a-glance live state of every session, and acting
on sessions from the grid rather than only entering them. Design settled with
Kyle 2026-07-24. The governing principles:

- **Shell-owned end to end.** Same trust rule as the permission bar: agent
  output never paints here, and every engine-derived string on a row (activity
  label, permission detail) renders as inert plain text — never markdown, never
  HTML.
- **Extends the watch_sessions path, additively.** All live state rides
  optional `SessionMeta` fields in the existing per-viewport `sessions`
  snapshot (never broadcast, never replay-buffered, no `seq`); all grid acts
  are new sessionId-addressed `ClientMsg` types on the `end_session`
  precedent. No new stream, no new transport.
- **Agent-neutral by construction.** Every new field is derived in the
  registry from the WireMsg stream it already fans out (status / bang /
  permission_request / usage) — no adapter cooperation, no per-agent code.
- **Grid acts = viewport acts, same gates.** Acting from the grid grants
  nothing a local viewport couldn't do by attaching. The one real gate carries
  over: a REMOTE (relay) watcher may not drive a subscription-backed session
  (R.4i), so quick-prompt and permission-answer are refused when
  `remote && !allowedOverRelay(kind)` — interrupt stays ungated, like
  `end_session` (teardown, not model use).
- **Stable rows, needs-you first** (Kyle's ordering call): rows hold creation
  order so eyes can park on a session; the one exception is sessions awaiting
  permission, which surface to a group at the top — the "act here" zone. The
  recency sort is retired on this page.
- **The archived-session fleetview stays unprecluded.** The `sessions`
  snapshot remains live-only; the future archived fleetview (POST-RELEASE.md)
  arrives as its own additive message + a second page section, never by
  reshaping this one.

Accepted v1 limits, on purpose: no live output preview on rows (Kyle's call —
activity + permission + usage are the glance set); no one-click default
new-session (the picker stays the only create); the pending-permission display
mirrors the 4.6 status stickiness (the queue clears when the stream moves, so a
second concurrently-pending request can be invisible on the fleet until its own
timeout — same honesty as the status dot today); usage mirrors the status bar's
exact rule (per-turn tokens summed, cost taken cumulative — the same numbers
the in-session bar shows); elapsed time ticks client-side from `since`, the
server sends no timers.

- [ ] **Step M.1 — Live cockpit state on the wire (registry-derived, additive SessionMeta)**
  - Goal: a fleet watcher's snapshot says what each session is DOING — current
    activity + since-when, the pending-permission queue, session usage totals,
    and creation time — derived entirely in the registry.
  - Build: `protocol.ts` additive optional `SessionMeta` fields:
    `createdAt?: number`, `activity?: { label: string; since: number }`,
    `permissions?: { id: string; tool: string; detail: string }[]`,
    `usage?: { inputTokens: number; outputTokens: number; costUsd?: number }`.
    `registry.ts`: `SessionEntry` gains the backing fields; the existing status
    derivation in `broadcast()` grows the capture — a `status` msg sets
    activity (`thinking` → "thinking", `tool` → its label), `bang_start` sets
    `! <command>`, terminal messages (turn_end/error/bang_end) clear it;
    `permission_request` appends `{id, tool, detail}` to the queue; any message
    that flips status off "permission" clears the queue (the 4.6 stickiness
    rule, mirrored); a `usage` msg adds per-turn tokens and TAKES `costUsd`
    (session-cumulative per T2.6 — never summed; Shell.tsx's exact rule).
    `notifyWatchers()` fires on metadata change (activity label change, queue
    change, usage turn) through the existing 100 ms coalescer — text_delta
    storms change nothing and stay silent. `summary()` carries the new fields;
    all absent when empty, so old clients strip them (R.4h).
  - Files: `server/protocol.ts` (additive), `server/sessions/registry.ts`.
  - Done when: Tier 2 (new `fleet-cockpit.itest.ts`, real daemon + real
    sockets, mock-forced): a watcher sees activity appear during a working turn
    and clear at turn_end; a `dangerous` mock prompt puts `{tool, detail}` on
    the session's meta and an in-session answer clears it; usage totals
    accumulate across two turns with cost taken-not-summed; `createdAt` is
    stable across snapshots. `yarn typecheck` clean; all existing tests green.

- [ ] **Step M.2 — Acting from the grid, server side (sessionId-addressed ClientMsg)**
  - Goal: a fleet watcher can answer a permission, interrupt a turn, and
    dispatch a prompt on any session by id — validated, throw-wrapped,
    relay-gated where it drives the model — without attaching.
  - Build: `protocol.ts` additive `ClientMsg` types:
    `{ type: "answer_permission"; sessionId: string; id: string; allow: boolean }`,
    `{ type: "interrupt_session"; sessionId: string }`,
    `{ type: "prompt_session"; sessionId: string; text: string }`.
    `connection.ts`: own NEW switch cases only (nothing existing is touched):
    validate inputs first (typeof checks; prompt text trimmed non-empty with a
    sane length cap); unknown sessionId → error reply, never a crash; then
    `answer_permission` → the session's `resolvePermission` plus dropping the
    id from the entry's pending queue (+ notify); `interrupt_session` →
    `session.interrupt()`; `prompt_session` → the `prompt` case's exact
    semantics addressed by id (broadcast `user_prompt` + `pushPrompt`). The
    relay gate: on a `remote` connection, `prompt_session` and
    `answer_permission` against `!allowedOverRelay(entry.kind)` get the attach
    gate's refusal wording as an error reply.
  - Files: `server/protocol.ts` (additive), `server/sessions/connection.ts`
    (new cases only), `server/sessions/registry.ts` (queue-drop helper).
  - Done when: Tier 2 `fleet-cockpit.itest.ts` over a real socket: a watcher's
    allow resolves a mock `dangerous` permission (the session's own viewport
    sees the tool run) and deny refuses it; `interrupt_session` halts a working
    mock turn and the session still answers the next prompt;
    `prompt_session` round-trips (user_prompt broadcast + turn runs); unknown
    sessionId, malformed fields, and empty text each get an error reply with
    the daemon still alive; the remote gate refuses prompt/answer on a
    subscription-kind session for a remote-flagged connection. All tiers green.

- [ ] **Step M.3 — The cockpit rows (front end)**
  - Goal: the fleet page shows each session's live state and carries the three
    acts — needs-you rows answerable in place — in the enriched-row shape,
    stable-ordered with needs-you first.
  - Build: `FleetView.tsx`: client-side sort — needs-you group first (oldest
    pending first), then creation order (`createdAt`, wire order as the
    old-daemon fallback); the row gains the activity readout ("⚙ Bash · 14s" —
    label from meta, elapsed ticked client-side ~1 s while any row is active)
    and compact usage ("12.3k tok · $0.42" — own small formatter; never import
    from StatusBar). A needs-you row grows a second line: `tool · detail`
    (inert plain text, ellipsized, `+N more` when the queue is deeper) with
    Allow / Deny buttons sending `answer_permission` (disabled once clicked
    until the next snapshot). A working row gets an armed two-click stop
    (`useArmedConfirm`, the end-button precedent) sending
    `interrupt_session`. A per-row quick-prompt affordance (❯) expands an
    inline one-line input — Enter sends `prompt_session` and collapses, Escape
    collapses, autofocus on open. Fleet-action error replies render as a
    dismissible line in the fleet header region (only picker-open errors keep
    routing to the onboarding card). An `sr-only` polite live region announces
    the needs-you count change. All controls carry real aria-labels naming the
    session. New CSS blocks only, appended (`.fleet-activity`, `.fleet-usage`,
    `.fleet-perm…`, `.fleet-stop`, `.fleet-prompt…`).
  - Files: `web/src/components/FleetView.tsx`, `web/src/styles.css` (additive
    blocks only).
  - Done when: Tier 3 (new `server/testing/fleet.e2e.ts`, its own suite,
    desktop width): a mock turn shows the activity label live and clears to
    idle; a `dangerous` prompt surfaces the needs-you second line with the
    tool detail and the row moves to the top group; Allow from the grid runs
    the tool (observed in the session tab) and the line clears; Deny refuses
    it; the armed stop interrupts a working turn; a quick prompt from the row
    lands as a user_prompt strip in the session tab; an idle session's row
    holds its place while another works (no jumping); the axe scan of the
    cockpit with a permission row visible has no serious/critical hits.

- [ ] **Step M.4 — Phone width**
  - Goal: at ≤640 px the cockpit rows fold without side-scroll — the glance
    set survives, targets stay ≥40 px, the second-line controls remain usable.
  - Build: additive media-query CSS for the new row elements (the existing
    fleet phone folding is the precedent); tests ride `fleet.e2e.ts` with a
    phone-sized context, reusing the existing `noSideScroll`/target-size
    helpers.
  - Files: `web/src/styles.css` (additive), `server/testing/fleet.e2e.ts`.
  - Done when: `fleet.e2e.ts` at phone width: Allow/Deny tap targets ≥40 px,
    `noSideScroll` passes with activity + permission + usage visible, the
    quick prompt opens and sends, the axe scan is clean.

- [ ] **Step M.5 — Polish (optional; the cut line)**
  - A needs-you signal on the fleet page's TAB: title count ("Mirafold — 1
    needs you") + the corner-badge favicon via `tab-status.ts` (the session
    page's existing mechanism, reused); the row's viewport count (meta already
    carries it); quick-prompt remembering its open state per row. Everything
    here is safe to drop.

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
