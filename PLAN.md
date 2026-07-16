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

Phases 0, T, 1, 2, 3, T2, P, G, H, and H2 are **done** — their steps and full dated
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
section for F.2). Only OPEN steps carry their full body
here. Everything below marked `[ ]` is the remaining work.

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

- [x] **Step K.3 — Provider-terms re-verification** — done 2026-07-15 (+ same-day amendment); every row pinned to a dated primary source: the Anthropic ban verbatim, Gemini individual-account service ended 2026-06-18 (API keys continue; Antigravity succession check → R.6), and the codex row first flipped to blocked (no written permission exists), then re-flipped by Kyle to allowed-locally as a disclosed gray area — locking the standing **disclosed-uncertainty rule** (canonical statement in `server/provider-policy.ts`). All four tiers green, twice. → PLAN-ARCHIVE.md.

- [ ] **Step K.4 — Merchant-of-record billing** *(decision 2026-07-15:
  outsource tax/compliance)* — 🟡 investigation done 2026-07-15, **Paddle
  recommended** (checklist in the status note); box open only on Kyle's
  account creation (under the K.2 entity) + his confirm of the pick
  - Goal: US state sales tax, EU VAT (which applies from the **first** B2C
    euro for a non-EU seller — no threshold), the FTC Negative-Option
    ("click-to-cancel") disclosure/consent/reminder mechanics, and the EU
    14-day withdrawal-right waiver all become the vendor's problem, traded
    for a bigger per-transaction fee.
  - Investigate: Paddle vs. Lemon Squeezy (Stripe + Stripe Tax stays the
    fallback if no MoR meets requirements). Hard requirements from BUSINESS
    §7 + R.5, each verified in writing against the vendor's current docs:
    card-required 7-day trial; cancel-at-period-end with no refund path;
    $12/mo · $99/yr pricing; a subscription-lifecycle webhook the minting
    backend can consume to mint/expire the Ed25519 entitlement token;
    checkout linkable from a static page; trial-conversion reminder and
    easy-as-signup cancellation handled by the vendor.
  - Then: rework R.5's build half (checkout → webhook → minting) for the
    chosen vendor — the relay-side entitlement check is untouched — and
    re-point the site PLAN's checkout-button blocker.
  - Done when: vendor chosen with the requirement checklist recorded, R.5's
    body rewritten for it, and the account exists under the K.2 entity.
  - **Status (2026-07-15): INVESTIGATION DONE — recommendation: PADDLE.**
    Only the account creation remains (Kyle, under the K.2 entity — the box
    stays open on that alone). The requirement checklist, verified against
    Paddle's current docs:
    - card-required 7-day free trial: ✅ native (Paddle's "card-required
      free" trial type; their help center explicitly covers trial
      compliance — the FTC negative-option disclosure/consent/reminder
      mechanics are the MoR's job);
    - cancel-at-period-end, no refund: ✅ native (a scheduled change; the
      Paddle-sent emails carry a cancellation link and access holds through
      the paid period — exactly BUSINESS §7's design);
    - $12/mo · $99/yr: ✅ arbitrary monthly + annual prices;
    - lifecycle webhooks for entitlement minting: ✅ signed webhooks
      (`subscription.trialing` / `.activated` / `.updated` / `.canceled`),
      and Paddle's subscription statuses are literally `trialing`/`active` —
      the R.5 entitlement rule ("admit when trialing OR active") maps
      verbatim;
    - checkout from a static page: ✅ hosted checkout links + a Paddle.js
      overlay (works on the no-build mirafold.com);
    - tax: ✅ merchant of record — global VAT/sales-tax collection and
      remittance are Paddle's, which is the entire point (K.4's premise:
      EU VAT applies from the first B2C sale).
    Fees: 5% + 50¢ — the "small fee for convenience" trade, accepted.
    The rest of the 2026 field, and why not them: **Lemon Squeezy** is in
    migration limbo (Stripe acquired it; users being funneled to Stripe
    Managed Payments) — excluded. **Stripe Managed Payments** (Stripe's own
    MoR) is still beta/invite-only in mid-2026 and effectively ~6.4% + 30¢
    all-in — can't launch on a beta; noted as a possible future migration
    since its transaction-level MoR is attractive and the entitlement design
    is vendor-agnostic. **Polar** is the runner-up (developer-first, open
    source, card-captured trials with auto-conversion + reminders, clean
    signed webhooks) but repriced to ~5% + 50¢ in 2026 — fee parity with
    Paddle — and is a much younger company with reported EU DPA gaps;
    for the revenue-critical path, Paddle's decade of MoR track record wins
    at the same price. **Creem** (3.9% + 40¢ sticker) is the youngest —
    excluded for the same reason.
    **Sequencing note (important):** Paddle verifies the merchant's website
    before allowing live sales, and that review expects ToS/privacy/pricing
    pages — so the order is K.2 (entity) → K.5 pages live on mirafold.com →
    Paddle account + site verification (sandbox account can start any
    time) → R.5 build. Start the Paddle signup early; verification takes
    days, not minutes.
  - **Amendment (2026-07-15, compliance sweep):** the FTC Negative-Option
    ("click-to-cancel") Rule this step's goal cites was **vacated in its
    entirety by the Eighth Circuit 2025-07-08** (the FTC restarted the
    rulemaking with a 2026-03 ANPRM). Conclusion unchanged, citation
    corrected: the same disclosure/consent/easy-cancel mechanics remain
    required by **ROSCA** (the underlying federal statute, still enforced)
    and state auto-renewal laws (California's ARL et al.), and they remain
    the MoR's job — Paddle's trial-compliance handling covers the statutes
    that survive, not just the vacated rule.

- [ ] **Step K.5 — Terms of Service + Privacy Policy (from a written data
  inventory)**
  - Goal: the two user-facing legal documents exist, are published, and are
    *true* — which for this product is a strength: the honest answer is
    "almost nothing," so write it down and lean into it.
  - Build, in order: (1) a **data inventory** — exactly what the relay, the
    site, and the billing vendor see and retain, and for how long (relay:
    IPs, pairing ids, connection timing, byte counts — never plaintext
    content; site: Cloudflare logs; billing: vendor-held card/name data).
    Deliberately minimize relay/site logging and write the retention down —
    what isn't retained can't be breached or subpoenaed. The inventory feeds
    both documents AND K.6's marketing wording. (2) **ToS**: warranty
    disclaimer; liability cap at fees paid + exclusion of consequential
    damages (the primary shield for the remote-execution liability);
    acceptable use; a user-responsibility-for-provider-terms clause (pairs
    with K.3 — Mirafold enforces known restrictions but doesn't warrant the
    user's standing with any provider, and where terms are uncertain the
    disclosed-uncertainty rule applies: the product disclosed it, the user
    chose it); age line (18+, or 13+ with capacity
    to contract); governing law; the K.4 trial/cancellation mechanics.
    (3) **Privacy policy**: the inventory verbatim, subprocessors named
    (Fly.io, Cloudflare, the billing vendor), GDPR-shaped rights handling
    (an IP address alone is personal data — one EU customer makes us a
    controller; minimal data keeps the document short, not optional).
    Publish both as pages on mirafold.com (site PLAN S.6), linked from the
    footer and the checkout flow. Kyle's call: 1–2 hours of a real lawyer's
    review before launch (recommended — this step and K.2 are the one place
    it's worth buying); a quality startup-standard template is the floor.
  - Done when: both pages are live (or staged into the R.5b release order),
    every sentence in them traces to the inventory, and the K.2 entity is
    the named party.
  - **Amendment (2026-07-15, compliance sweep — four additions):** (a) the
    ToS acceptable-use clause states explicitly: **pair with and control
    only systems you own or are authorized to access** — the CFAA-adjacent
    line; the pairing architecture already enforces it, the words make it
    contractual. (b) Naming subprocessors in the policy is not the GDPR
    Art. 28 instrument — **execute the self-serve DPAs** with Fly.io
    (pre-signed, fly.io/documents) and Cloudflare
    (cloudflare.com/cloudflare-customer-dpa) under the entity's accounts
    (Kyle's hands, minutes, free; both vendors are Data Privacy Framework
    certified, which settles EU→US transfers). (c) **Paddle is named as an
    independent controller**, not a subprocessor — as merchant of record
    the buyer contracts with Paddle, and its standard Data Sharing Addendum
    governs the controller-to-controller leg; no processor DPA exists or is
    needed there. (d) A one-page **breach-notification plan** drafted from
    the inventory (GDPR's 72-hour authority clock + US state statutes;
    realistic breach surface = relay/hosting metadata or Paddle-side data —
    plaintext content cannot breach server-side because it never exists
    there). Note: the dated inventory doubles as the GDPR Art. 30 record of
    processing — keep it current and one artifact serves both. Code-verified
    same day for the inventory's benefit: the relay process holds client IPs
    in memory only (per-IP caps) and writes none to its logs — IP retention
    exists only at the Fly.io proxy layer; no telemetry/analytics anywhere
    in shell, site, or relay; mirafold.com sets no cookies (strict CSP,
    self-hosted assets only), so no ePrivacy consent banner is owed.

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

- [ ] **Step K.7 — SECURITY.md + vulnerability-disclosure contact (both
  repos)**
  - Goal: researchers have a private channel that isn't a public issue —
    expected for this product category, cheap, and part of the
    reasonable-care record.
  - Build: `SECURITY.md` in genui-shell and genui-relay — supported
    versions, a private contact address on the entity's domain, a response
    promise Kyle can actually keep, no bounty implied. Keep the existing
    dated audits + fixes in PLAN-ARCHIVE.md intact: they are the
    reasonable-care evidence if a claim ever lands.
  - Done when: both files exist and the contact address routes to Kyle.
  - Status (2026-07-15): 🟡 files written — `SECURITY.md` in both repos
    (contact `security@mirafold.com`; 7-day acknowledgment promise; no
    bounty; latest-release-only support; each file points researchers at
    its repo's real attack surface — trusted-shell boundary for the shell,
    E2E blindness + metadata for the relay). **Box stays open on exactly
    one thing: Kyle creating the address** (Cloudflare Email Routing,
    `security@mirafold.com` → his inbox — Step 5 of the Phase-K brief) and
    confirming a test email lands.

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

- [ ] **Step R.2 — The relay service, deployed** *(needs Kyle: Fly.io
  account + a domain — start both signups now; the code half is buildable
  before either exists)*
  - Goal: the dumb forwarder, running in the world.
  - Build: per the locked relay-architecture decision (2026-07-07, above) —
    a portable Node.js + `ws` service in a new **private repo**
    (`genui-relay`, closed source per the settled MIT open-core call —
    *2026-07-15: superseded by Phase K.1, the relay is MIT and flips public
    at launch; the repo separation itself stands*):
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
       Claude/Gemini subscriptions are prohibited in writing (never a
       choice), while Codex subscription is live locally only as a
       disclosed gray area (the K.3 disclosed-uncertainty rule — its
       caveat must ride the option), and no subscription ever rides the
       relay; the flow has to present that honestly per agent rather
       than offering a symmetric subscription-vs-keys fork. Also
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

- [x] **Step F.2 — System-notice line (the UI must not lie in degraded service)** — done 2026-07-12; one additive `notice` WireMsg (retry | compaction | rate_limit | refusal) mapped from five SDK events in the claude adapter, drawn as a dim persistent notice line in RenderZone (silent on plain rate-limit `allowed`, so no spam). → PLAN-ARCHIVE.md.

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

## Phase S — Theme system: six themes at launch (opened 2026-07-15; next up — pre-launch polish, ships in the launch build before R.7)

Goal of the phase: grow from the two hand-built themes (Light, Dark) to **six**
— adding Solarized Light, Solarized Dark, Gruvbox Dark, and Dracula — on
plumbing that makes every later theme a one-file, one-manifest-row,
one-eyeball-pass addition. The real deliverable is the plumbing; the four
borrowed themes prove it.

**Decisions locked 2026-07-15 (this phase's charter):**

- **Native CSS only.** No CSS framework, library, or preprocessor — CSS custom
  properties are the purpose-built runtime theming mechanism, and the repo's
  zero-dependency posture holds.
- **Semantic tokens stay the vocabulary.** The existing ~45 purpose-named
  custom properties (`--surface-2`, `--fg-dim`, `--warn-border`, …) remain
  what structural CSS consumes. We do NOT adopt Base16 slot names
  (`--base0A`) — too coarse (16 slots can't express our 7 text tiers / 6
  border weights) and illegible to a human maintainer.
- **Base16 is the porting recipe, not the vocabulary.** Each borrowed theme is
  transcribed from its canonical published Base16 scheme through a
  documented slot→token mapping written once in S.2. Palettes aren't
  copyrightable and the source projects are MIT; each theme file carries a
  source-attribution comment anyway.
- **Every theme is standalone, labeled `light` or `dark` behind the scenes.**
  Themes never come in pairs and never have variants; the label only answers
  "which side of the toggle selects this." Families (Solarized) ship as two
  unrelated sibling entries. The user's settings hold two slots — a chosen
  light theme and a chosen dark theme (defaults: Light, Dark) — and the
  existing toggle picks the active slot, so it stays meaningful after
  someone adopts a fancy theme. Picking a theme from the list applies it
  immediately and fills its side's slot; users never manage slots explicitly.
- **The light/dark pill does not change AT ALL — LOCKED (Kyle, stated
  multiple times; re-affirmed emphatically 2026-07-16 after an "Auto" third
  state was misrecorded into S.3's original text).** Same look, same two
  positions, same behavior — no tri-state, no Auto, no `prefers-color-scheme`
  following, no visual tweak of any kind. Its two positions simply select the
  two slots, which with default slots is indistinguishable from today. The
  ONE new affordance this phase adds to the chrome is a **settings button**
  (S.4) that opens the theme picker. Any future change to the pill requires a
  new, explicit decision from Kyle — never infer one from adjacent work.
- **Code/diff surfaces stay pinned dark universally** (the standing
  USER-TESTING-FEEDBACK.md #8-adjacent decision: `--code-*`/`--diff-*` don't
  swap per theme). The contract records them as pinned; a per-theme override
  door stays open in the design but is NOT exercised in this phase.

- [x] **Step S.1 — Token audit + file split (zero visual change)** — done
  2026-07-16. Palettes now live in `web/src/themes/`: `base.css` (the pinned
  `--code-*`/`--diff-*` tokens, the charter's shared base block), `dark.css`
  (bare `:root` — dark stays the fallback identity), `light.css`
  (`:root[data-theme="light"]`, now token-complete: `--overlay` + the shadows
  are stated explicitly with the dark values rather than inherited silently);
  import order set in `main.tsx` (base → themes → structure). The audit found
  only three literals in structural CSS — three `box-shadow`s — hoisted as
  `--shadow-pop` (chart tooltip) and `--shadow-card` (onboarding/pair cards),
  same values both themes. `styles.css` is grep-clean of color literals.
  Deliberate non-CSS exceptions, each noted in-file: the QR's black-on-white
  (scanner contrast, `ConnectDevice.tsx`), the canvas favicon (can't consume
  CSS vars, `Shell.tsx`), the artifact iframe's dark base (opaque origin
  can't read shell vars, `Artifact.tsx`), and Chart's fixed CVD-safe series
  palette (data-viz, not theme). Verified: typecheck + all three tiers green
  untouched (168 unit / 74 itest / 21 e2e).
  - Goal: complete the tokens-vs-structure separation that `styles.css`
    already has in embryo (lines 1–112 are palette; ~2,400 lines are
    structure), so a theme is one self-contained file.
  - Build: sweep the structural rules for literal colors (hex/rgb/hsl) and
    hoist each into a semantic token; move the palettes out to
    `web/src/themes/dark.css` and `web/src/themes/light.css` (pinned
    `--code-*`/`--diff-*` tokens live in a shared base block — exact layout
    decided in-step); `styles.css` keeps only structural rules referencing
    `var(...)`. Import order via `web/src/main.tsx`.
  - Files: `web/src/styles.css`, `web/src/themes/` (new), `web/src/main.tsx`.
  - Done when: no color literal remains outside `web/src/themes/` (grep-clean,
    modulo deliberate exceptions noted in-file), and the app is visually
    unchanged in both themes — `yarn test:e2e` passes untouched.

- [x] **Step S.2 — Theme contract, manifest, and Tier-1 guards** — done
  2026-07-16. `web/src/themes/manifest.ts` is the single source: `THEMES`
  (`{ id, displayName, appearance }` — ids stamp `data-theme`, nothing else
  in the app names a theme), the 41-token `THEME_TOKENS` contract, the
  7-token `PINNED_TOKENS` set (base.css only), and the Base16 slot→token
  porting recipe as the closing doc comment (S.5/S.6 transcribe from it;
  syntax slots beyond the four semantic accents deliberately unused — code
  is pinned + hljs-owned). `themes.test.ts` adds 8 Tier-1 guards: manifest
  sanity, ids↔files bijection, per-theme selector scoping (dark owns bare
  `:root`, every other theme scopes to its own `data-theme`), exact contract
  token set (missing AND strays), base.css = exactly the pinned set,
  contract/pinned disjoint, fg/bg contrast ≥ 4.5:1, and appearance label ↔
  actual `--bg` lightness. Done-when proven live: each of the four failure
  modes (missing token, stray token, manifest/file mismatch, unreadable
  fg/bg) was broken once and failed exactly its guard, then restored.
  Verified: typecheck + all tiers green (176 unit / 74 itest / 21 e2e).
  - Goal: the fixed token contract every theme must satisfy, the single
    source the picker renders from, and the tests that keep 6 (then 16)
    themes from silently drifting.
  - Build: `web/src/themes/manifest.ts` — the canonical token-name list plus
    a `{ id, displayName, appearance: "light" | "dark" }` entry per theme
    (ids stamp `data-theme` and persist in settings; nothing else in the app
    ever names a theme). Write the Base16 slot→token mapping recipe as a
    comment/doc alongside. Tier-1 tests: every theme file defines exactly
    the contract's tokens (no missing, no strays); manifest ids ↔ theme
    files are a bijection; contrast floor — `--fg` vs `--bg` computes ≥
    4.5:1 per theme, so a mangled palette fails before a human looks.
  - Files: `web/src/themes/manifest.ts` (new), `web/src/themes/themes.test.ts`
    (new).
  - Done when: `yarn test` fails loudly on a theme file missing a token, a
    stray token, a manifest/file mismatch, or an unreadable fg/bg pair —
    verified by deliberately breaking each once.

- [x] **Step S.3 — Two-slot switching (the pill itself does NOT change)** —
  done 2026-07-16. `manifest.ts` gained the storage vocabulary
  (`MODE_STORAGE_KEY` = the pre-existing `mirafold-theme`, unchanged
  meaning; `slotStorageKey(appearance)` = `mirafold-theme-light/-dark`) and
  `resolveSlot()` (stored id wins if it names a manifest theme, else the
  side's default — existence check, not appearance: fit is enforced where
  slots are written, S.4's picker). Shell.tsx stamps
  `resolveSlot(mode, slot)` instead of the mode; the pill, its props, and
  StatusBar are untouched. index.html's pre-paint script mirrors the
  resolution by value (unknown id stamps harmlessly → bare `:root` dark
  until Shell re-stamps). Migration: no migration — the mode key keeps its
  exact meaning, absent slot keys mean defaults, which is byte-identical
  behavior. Proven in Tier-3 (`app.e2e.ts`): seeded dark slot paints its
  theme while the pill shows dark mode with unchanged rendering, both keys
  survive two reloads, each side follows its own slot on pill flips,
  unknown slot id falls back, and the pre-existing pill test passes
  untouched (default-slot identity). Tiers 178/74/22 green.
  - Goal: generalize the backing state of today's binary toggle
    (`Shell.tsx`, localStorage key `mirafold-theme`) to the two-slot model
    with **zero change to the pill** — per the charter's locked decision:
    same look, same two positions, same behavior; the original text of this
    step added an "Auto" third state, which misrecorded Kyle's decision and
    was struck 2026-07-16. Do not reintroduce it.
  - Build: persist `lightTheme` / `darkTheme` slot choices (defaults `light`
    / `dark`) alongside the existing mode; the pill's two positions select
    the active slot — with default slots this is behavior-identical to
    today. Active theme id stamps `:root[data-theme]`. Migration: existing
    stored `mirafold-theme` values keep meaning what they meant (the
    index.html pre-paint script included).
  - Files: `web/src/components/Shell.tsx`, `web/src/themes/manifest.ts`.
  - Done when: Tier-3 proves the pill flips between the two slot themes,
    choices survive reload, and with default slots the pill's rendered UI
    and behavior are exactly today's.

- [x] **Step S.4 — Settings button + theme picker UI (shell-owned)** — done
  2026-07-16, built exactly to the locked design. New `ThemePicker.tsx` =
  the centered settings card (pair-card idiom: shared backdrop rule,
  `--shadow-card`, ❯-glyph head, Esc/scrim/✕ close); gear button
  (`.sb-settings`) rides StatusBar as a plain optional-prop button placed
  before the pill (home ⌂ keeps far right; the pill and its test are
  untouched). Shell owns the state: slots lifted into React state so a pick
  repaints live; `pickTheme` enforces appearance fit at the one write site
  and flips mode to the picked side (picking is seeing). Swatch chips read
  each theme's real colors by importing `themes/*.css` as raw text
  (`import.meta.glob` — Vite-only, so the card mounts from Shell and must
  never be imported from Tier-1-tested modules; noted in-file) through the
  now-shared `parseThemeTokens` in manifest.ts — a new theme's swatch costs
  zero wiring. Tier-3 proves: gear→card, groups+rows from the manifest,
  chips carry non-transparent computed colors in the built bundle, current
  slots checked, live apply on pick (data-theme + pill side + slot key,
  card stays open), other slot untouched, Esc and scrim-click close.
  Tiers 178/74/23 green.
  - Goal: a **new settings button** in the shell chrome — the one new
    affordance this phase adds (the pill is locked, see charter) — opening
    the settings card with the theme picker.
  - **Design locked (Kyle approved 2026-07-16):** a small **gear button
    beside the pill** opens a **centered modal card** over the translucent
    `--overlay` scrim — the same idiom as the pairing/onboarding cards
    (`--shadow-card`, same border/radius language), NOT a popover or drawer.
    The card is titled "Settings" with an × close; one section today,
    **Theme**: two labeled groups, "Light themes" / "Dark themes", each row
    = theme displayName + a short strip of color chips (bg, surface, accent,
    fg) rendered from the manifest, with a check on the row occupying each
    slot. Clicking a row repaints the app instantly behind the scrim (live
    preview — the translucent scrim is the point), moves the check, writes
    the slot; no confirm/apply. Clicking a theme of the other appearance
    also flips the active mode to show it (picking is seeing). Esc, scrim
    click, or × closes. Built to grow more sections later (R.4l's settings
    surface); works identically on desktop and the phone viewport.
  - Build: picker renders purely from the manifest; clicking a row applies
    the theme immediately and writes it into its appearance side's slot.
    Shell-owned affordances (button + card) — agent output can never
    render, wrap, or intercept them (trusted-shell boundary). The pill is
    not touched, restyled, or repositioned by this step.
  - Files: `web/src/components/Shell.tsx` (or a new `ThemePicker.tsx`),
    `web/src/styles.css`.
  - Done when: Tier-3 drives a real click on the settings button → card
    opens; a real click on a dark-labeled theme → it paints immediately,
    `data-theme` updates, the pill's dark side now means that theme, and
    the light side is untouched — with the pill's own rendering unchanged.

- [ ] **Step S.5 — Themes 3 + 4: Solarized Light, Solarized Dark**
  - Goal: the first borrowed pair — the canonical light theme and its
    famous sibling — shipped as two standalone manifest entries.
  - Build: transcribe each from its canonical Base16 scheme via the S.2
    recipe into one theme file each (+ attribution comment), then the
    eyeball QA walk per theme: terminal output, tool blocks, diffs (pinned
    dark — confirm they still sit right), permission bar, onboarding,
    generative-UI components; hand-tune derived tiers where the recipe's
    output misses.
  - Files: `web/src/themes/solarized-light.css`,
    `web/src/themes/solarized-dark.css`, `web/src/themes/manifest.ts`.
  - Done when: both pass the S.2 guards, both survive the QA walk with
    notes resolved, and each is selectable + persistent end-to-end.

- [ ] **Step S.6 — Themes 5 + 6: Gruvbox Dark, Dracula**
  - Goal: two dark singletons with huge terminal followings — same recipe,
    same bar.
  - Build: identical to S.5 for `gruvbox-dark` and `dracula`.
  - Files: `web/src/themes/gruvbox-dark.css`, `web/src/themes/dracula.css`,
    `web/src/themes/manifest.ts`.
  - Done when: same bar as S.5; with these landed the picker shows six
    themes (2 light, 4 dark) and adding a seventh is demonstrably one new
    file + one manifest row + the QA walk.

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
