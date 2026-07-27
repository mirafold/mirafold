import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
import { fixtureGit as git, startDaemon, TestClient, type Daemon } from "./itest-harness";
import type { ClientMsg } from "../protocol";
import { startOllamaFixture } from "./ollama-fixture";
import { startRelayStub } from "../relay/relay-stub";
import { THEMES } from "../../web/src/themes/manifest";

// Tier-3 E2E, opt-in (`yarn test:e2e` — needs google-chrome and a fresh
// `yarn build`, which the script runs first: the daemon serves ./dist, and a
// stale build fails silently). Real browser, real typing, the daemon from the
// Tier-2 harness (credentials forced empty → MockSession) (L.2c).

const TOKEN = "e2e-token-9c2f";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

let d: Daemon;
let browser: Browser;
let page: Page; // carries the auth cookie across tests, like a real tab
let base: string;

// The in-page wire recorder (E2.2/E2.4): log every outgoing fs_* frame by
// patching the WebSocket prototype — ws.ts resolves send() through the
// prototype on every call, so the app's EXISTING socket is caught too. Each
// install resets the log; the patch itself lands once per window (a fresh
// navigation gets a fresh window, so re-installing after goto is correct).
const installFsRecorder = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as { __fsSent: { type: string; path?: string }[]; __fsPatched?: boolean };
    w.__fsSent = [];
    if (!w.__fsPatched) {
      w.__fsPatched = true;
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
        try {
          const m = JSON.parse(String(data));
          if (String(m.type).startsWith("fs_")) {
            (window as unknown as { __fsSent: unknown[] }).__fsSent.push({ type: m.type, path: m.path });
          }
        } catch {
          /* binary or non-JSON frame — not ours */
        }
        return orig.call(this, data);
      };
    }
  });
const fsSent = (p: Page) =>
  p.evaluate(() => (window as unknown as { __fsSent: { type: string; path?: string }[] }).__fsSent);

before(async () => {
  d = await startDaemon({ MIRAFOLD_TOKEN: TOKEN });
  base = `http://127.0.0.1:${d.port}`;
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  await browser?.close();
  await d?.stop();
});

test("no token → 403, nothing served", async () => {
  const lockedOut = await browser.newPage();
  const res = await lockedOut.goto(`${base}/`);
  assert.equal(res?.status(), 403);
  await lockedOut.close();
});

test("?token= mints the cookie, cleans the URL, boots the shell", async () => {
  page = await browser.newPage();
  await page.goto(`${base}/?token=${TOKEN}`);
  assert.equal(page.url(), `${base}/`); // token traded for the cookie, gone from the bar
  const cookies = await page.context().cookies(base);
  assert.ok(cookies.some((c) => c.name === "mirafold_token" && c.value === TOKEN));
  assert.equal(await page.locator(".fleet-title").textContent(), "Mirafold");
});

test("the agent picker flexes to the window — no internal scrollbar through the squeeze ramp", async () => {
  // The card's vertical chrome compresses with the window (--onb-squeeze in
  // styles.css) so its overflow-y:auto scrollbar is a last resort, not a
  // routine sight. The guarantee is calibrated to the credentialed picker
  // (short per-row detail lines — the state a set-up user sees); the fresh
  // credential-less picker carries paragraph-length hints, and hiding those
  // behind a scrollbar is correct, not a regression. So: a daemon whose rows
  // are mostly ready (same recipe as the R.4k test below), swept through the
  // squeeze ramp's lower band, where pre-fix EVERY height here scrolled.
  const token = "e2e-squeeze-9c2f";
  // All three rows ready (one-line details, no paragraph hints) — display
  // only, nothing is clicked, so no engine ever spawns.
  const d2 = await startDaemon({
    MIRAFOLD_TOKEN: token,
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    OPENAI_API_KEY: "e2e-not-a-real-key",
    GEMINI_API_KEY: "e2e-not-a-real-key",
  });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
    await page2.waitForSelector(".onb-card");
    await page2.setViewportSize({ width: 1100, height: 1400 });
    await page2.waitForTimeout(60);
    const fullGlyph = await page2.evaluate(
      () => document.querySelector(".onb-glyph")!.getBoundingClientRect().height,
    );
    for (const h of [760, 745, 730]) {
      await page2.setViewportSize({ width: 1100, height: h });
      await page2.waitForTimeout(60);
      const m = await page2.evaluate(() => {
        const c = document.querySelector(".onb-card")!;
        return {
          overflow: c.scrollHeight - c.clientHeight,
          glyph: document.querySelector(".onb-glyph")!.getBoundingClientRect().height,
        };
      });
      assert.ok(m.overflow <= 2, `picker scrolls ${m.overflow}px internally at ${h}px window height`);
      // The fit must come from the squeeze compressing chrome, not from a
      // floor that quietly grew the full-size card.
      assert.ok(m.glyph < fullGlyph - 4, `glyph did not compress at ${h}px (${fullGlyph}px → ${m.glyph}px)`);
    }
  } finally {
    await page2.close();
    await d2.stop();
  }
});

test("onboarding → a full mock turn renders in the DOM", async () => {
  // An empty registry opens straight into "choose your agent".
  // Every credential-less row carries its one-line fix on the picker
  // itself (the harness forces all three agents credential-less) (R.4b).
  await page.waitForSelector(".onb-agent-hint");
  assert.equal(await page.locator(".onb-agent-hint").count(), 3);
  const claudeRow = page.locator(".onb-agent", { hasText: "Claude Code" });
  assert.match(await claudeRow.innerText(), /ANTHROPIC_API_KEY|`claude`/);
  // Disclosed-uncertainty rule (K.3 amendment, 2026-07-15): the Codex row
  // offers `codex login` WITH the uncertainty caveat, plus the API-key path.
  const codexRowText = await page
    .locator(".onb-agent", { hasText: "Codex" })
    .innerText();
  assert.match(codexRowText, /codex login/);
  assert.match(codexRowText, /not clearly permitted/);
  assert.match(codexRowText, /OPENAI_API_KEY/);
  // The local/open-model path is named on the picker screen itself (R.4k).
  assert.match(await page.locator(".onb-local-note").innerText(), /local\/open model/i);

  await claudeRow.click();
  await page.waitForURL(/\/s\/[\w-]+/);

  // The shell-drawn demo banner is up before anything else paints — a
  // mock session is unmistakably labeled, with the concrete fix named (R.4b).
  await page.waitForSelector(".demo-banner");
  const banner = await page.locator(".demo-banner").innerText();
  assert.match(banner, /demo/i);
  assert.match(banner, /no real agent/);
  assert.match(banner, /ANTHROPIC_API_KEY|`claude`/);

  // Status bar: agent then model, and the model is there from the FIRST
  // paint (session_created carries it) — no turn has run yet (2026-07-17).
  await page.waitForSelector(".sb-model");
  assert.equal(await page.locator(".sb-agent").innerText(), "claude-code");
  assert.equal(await page.locator(".sb-model").innerText(), "mock-sonnet");

  // Real typing into the real prompt box; the checklist hook is deterministic.
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");

  // The typed prompt echoes back as the command strip (server broadcast).
  await page.waitForSelector("text=plan it step by step", { timeout: 15_000 });
  // The live checklist paints…
  await page.waitForSelector("text=Read the current implementation", { timeout: 15_000 });
  // …and the turn runs to its streamed conclusion.
  await page.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
});

test("A.1: announcer regions exist, spoke the turn, and the transcript is silent", async () => {
  // The two shell-owned announcer regions (Announcer.tsx): polite for turn
  // progress, assertive reserved for errors/permissions. `.sr-only` hides
  // them with clip-path, NOT display:none — the latter would drop them from
  // the accessibility tree and silence every announcement.
  const polite = page.locator('[role="status"][aria-live="polite"]');
  const alert = page.locator('[role="alert"][aria-live="assertive"]');
  assert.equal(await polite.count(), 1);
  assert.equal(await alert.count(), 1);
  // The finished mock turn was announced once, whole: its banked prose lands
  // in the polite region at turn_end (may trail the transcript paint the
  // previous test waited on, hence the poll).
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="status"]')
        ?.textContent?.includes("Plan complete — all four steps done."),
    undefined,
    { timeout: 15_000 },
  );
  // The transcript is navigable but silent: role="log" with aria-live
  // explicitly OFF — log's implicit "polite" would re-read every token.
  const log = page.locator('[role="log"]');
  assert.equal(await log.count(), 1);
  assert.equal(await log.getAttribute("aria-live"), "off");
});

test("A.1: tool_use and permission_request announce (assertive interrupts polite)", async () => {
  const alert = page.locator('[role="alert"][aria-live="assertive"]');
  await page.locator("textarea").click();
  await page.keyboard.type("run something dangerous");
  await page.keyboard.press("Enter");
  // The mock pauses the turn on a permission_request (Bash, a fake
  // rm -rf) — assertive, so it must land in the alert region, not status.
  await page.waitForFunction(
    () => document.querySelector('[role="alert"]')?.textContent?.includes("Permission needed"),
    undefined,
    { timeout: 15_000 },
  );
  const alertText = await alert.innerText();
  assert.match(alertText, /Permission needed: Bash\./);
  assert.match(alertText, /rm -rf \/var\/cache\/app/);
  // The permission bar itself is on-screen with the same detail.
  assert.equal(await page.locator(".perm-tool").innerText(), "Bash");
  await page.locator(".perm-allow").click();
  // Allowed → the mock "runs" the command: a tool_use announces at the
  // polite region ("Running Bash."), then the turn concludes.
  await page.waitForFunction(
    () => document.querySelector('[role="status"]')?.textContent?.includes("Running Bash."),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="status"]')
        ?.textContent?.includes("Cache cleared and the service restarted cleanly"),
    undefined,
    { timeout: 15_000 },
  );
  // The permission bar clears once answered.
  assert.equal(await page.locator(".perm-bar").count(), 0);
});

test("question component: clicking an option sends it as the user's next turn", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("question: canary or fleet?");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".rc-question", { timeout: 15_000 });
  const opts = page.locator(".rc-question-opt");
  assert.equal(await opts.count(), 2);
  await opts.first().click();
  // The option's full text (not its label) echoes back as a real user turn…
  await page.waitForSelector("text=Do a canary rollout first.", { timeout: 15_000 });
  // …the clicked copy locks: the choice is marked, both buttons disabled.
  assert.equal(await page.locator(".rc-question-chosen").count(), 1);
  assert.equal(await opts.first().isDisabled(), true);
  assert.equal(await opts.nth(1).isDisabled(), true);
  // …and the follow-up template turn runs to completion (usage lands at its
  // end — first usage of the session, so this is a real end-of-turn signal).
  await page.waitForSelector(".sb-usage", { timeout: 30_000 });
});

test("shell picker: arrow keys + Enter select a row, terminal-style", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("picker demo");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".picker-block", { timeout: 15_000 });
  const rows = page.locator(".picker-row");
  // Six rows — past the question component's option cap, one shell picker.
  assert.equal(await rows.count(), 6);
  // The highlight starts on the current row (index 1, per the mock)…
  assert.ok((await rows.nth(1).getAttribute("class"))!.includes("picker-highlight"));
  // …and arrow keys drive it from the idle prompt box, no click first.
  await page.keyboard.press("ArrowDown");
  assert.ok((await rows.nth(2).getAttribute("class"))!.includes("picker-highlight"));
  await page.keyboard.press("Enter");
  // The picked row's full text echoes back as a real user turn…
  await page.waitForSelector("text=Switch to mock-9-luna.", { timeout: 15_000 });
  // …and the copy locks: the choice is marked, every row disabled.
  assert.equal(await page.locator(".picker-chosen").count(), 1);
  assert.equal(await rows.first().isDisabled(), true);
});

test("stat component (S.3): the KPI tile updates in place and pins to the dock", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("kpi demo");
  await page.keyboard.press("Enter");
  // Scoped by the deterministic hook's label — a random template turn
  // elsewhere in this session may paint its own (differently-labeled) tile.
  const tile = page.locator(".rc-stat", { hasText: "Coverage" });
  await tile.waitFor({ timeout: 15_000 });
  // Update-in-place: the re-send on the same wire id moves THIS tile's
  // number — still one tile, never a stack.
  await page.waitForSelector(".rc-stat-value:text('96.8%')", { timeout: 15_000 });
  assert.equal(await tile.count(), 1);
  // The delta carries its arrow (direction never rides on color alone).
  assert.match((await tile.locator(".rc-stat-delta").innerText()).trim(), /^↑ \+3\.7%$/);
  // The natural pin-dock resident: pin it, it moves to the dock, a stub
  // holds its transcript place; unpin restores (leaves the page clean too).
  await page.locator(".turn-render", { has: tile }).locator(".pin-btn").click();
  await page.waitForSelector(".pin-dock .rc-stat");
  assert.ok(await page.locator(".pin-stub").count());
  await page.locator(".pin-dock .pin-btn").click();
  await page.waitForSelector(".pin-dock", { state: "detached" });
});

test("code component: header, client-tokenized lines, emphasized range, copy affordance", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("snippet demo");
  await page.keyboard.press("Enter");
  const block = page.locator(".rc-code", { hasText: "loadConfig" });
  await block.waitFor({ timeout: 15_000 });
  assert.equal(await block.locator(".rc-code-name").innerText(), "src/config/load.ts");
  assert.equal(await block.locator(".rc-code-lang").innerText(), "ts");
  // Six source lines, lines 4–5 emphasized per the highlight ranges.
  assert.equal(await block.locator(".rc-code-line").count(), 6);
  assert.equal(await block.locator(".rc-code-line-hl").count(), 2);
  assert.match(await block.locator(".rc-code-line-hl").first().innerText(), /readFile\(path/);
  // Tokenized client-side from plain text — hljs token spans exist, and no
  // markdown fence characters leaked into the rendered body.
  assert.ok((await block.locator(".hljs-keyword").count()) > 0, "no syntax tokens");
  assert.ok(!(await block.locator(".rc-code-body").innerText()).includes("```"));
  assert.equal(await block.locator(".rc-code-copy").innerText(), "copy");
});

test("status-list component: one verdict pill per row, glyph + word, all five states", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("health checks demo");
  await page.keyboard.press("Enter");
  const block = page.locator(".rc-statuslist", { hasText: "Health checks" });
  await block.waitFor({ timeout: 15_000 });
  assert.equal(await block.locator(".rc-status-row").count(), 5);
  // Every status in the vocabulary renders its own pill class, and the pill
  // text carries the status WORD — state never rides on color alone.
  for (const status of ["pass", "fail", "warn", "pending", "skip"]) {
    const pill = block.locator(`.rc-status-${status}`);
    assert.equal(await pill.count(), 1, `missing pill for ${status}`);
    assert.ok((await pill.innerText()).includes(status));
  }
  assert.match(await block.locator(".rc-status-row", { hasText: "relay probe" }).innerText(), /4007/);
});

test("diagram component: mermaid renders as SVG inside the sandbox; broken source shows itself", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("diagram demo");
  await page.keyboard.press("Enter");
  const block = page.locator(".rc-diagram", { hasText: "Relay pairing flow" });
  await block.waitFor({ timeout: 20_000 });
  // The runtime is a lazy ~3.6 MB chunk — give the first render room.
  const frame = block.locator("iframe.rc-diagram-frame");
  await frame.waitFor({ timeout: 20_000 });
  const svg = page
    .frameLocator(".rc-diagram:has-text('Relay pairing flow') iframe")
    .locator("#host svg");
  await svg.waitFor({ timeout: 20_000 });
  // The frame reported its measured height back — the host sized to fit.
  const h = await frame.evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(h > 130, `frame did not grow to the diagram (h=${h})`);
  // The shell-drawn chrome badges the sandbox, outside the frame.
  assert.match(await block.locator(".rc-diagram-badge").innerText(), /sandboxed/);

  // Broken source: the failure state carries the message AND the source text.
  const failed = page.locator(".rc-diagram-failed", { hasText: "broken diagram" });
  await failed.waitFor({ timeout: 20_000 });
  assert.match(await failed.innerText(), /diagram didn't render/);
  assert.ok((await failed.locator(".rc-diagram-source").innerText()).includes("nope"));
});

test("image component: a resolved shot renders as a real <img>; a refused one says why", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("screenshot demo");
  await page.keyboard.press("Enter");
  const fig = page.locator(".rc-image", { hasText: "welcome screen, dark theme" });
  await fig.waitFor({ timeout: 15_000 });
  const img = fig.locator("img.rc-image-img");
  assert.equal(await img.getAttribute("alt"), "the welcome screen after the fix");
  assert.match((await img.getAttribute("src"))!, /^data:image\/png;base64,/);
  // The pixels actually decoded — a broken data URI reports naturalWidth 0.
  assert.equal(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth), 1);
  // The refused shot explains itself instead of a broken-image glyph.
  const missing = page.locator(".rc-image-missing", { hasText: "shots/huge.png" });
  await missing.waitFor({ timeout: 15_000 });
  assert.match(await missing.innerText(), /image unavailable — too large/);
  assert.equal(await missing.locator("img").count(), 0);
});

test("console component: command header, ANSI colors as spans, junk escapes stripped, exit badge", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("console demo");
  await page.keyboard.press("Enter");
  const block = page.locator(".rc-console", { hasText: "yarn test" });
  await block.waitFor({ timeout: 15_000 });
  assert.match(await block.locator(".rc-console-exit").innerText(), /exit 1/);
  assert.ok((await block.locator(".rc-console-exit-err").count()) === 1, "failing exit not badged");
  // Colors became class spans, not leaked escape bytes…
  assert.ok((await block.locator(".ansi-red").count()) >= 1, "no red span");
  assert.ok((await block.locator(".ansi-green").count()) >= 1, "no green span");
  const body = await block.locator(".rc-console-body").innerText();
  assert.ok(!body.includes("\x1b"), "escape bytes leaked into the rendered body");
  assert.ok(!body.includes("window title junk"), "OSC sequence not stripped");
  assert.ok(body.includes("1 failing, 411 passing"));
});

test("chart stretch (S.1/S.2): pie folds to 'other', stacked and horizontal bars, malformed pie degrades", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("chart demo");
  await page.keyboard.press("Enter");

  // S.1 — the 8-category pie renders 6 slices: top 5 + "other", never a 7th hue.
  const pie = page.locator(".rc-chart", { hasText: "Language mix" });
  await pie.waitFor({ timeout: 15_000 });
  assert.equal(await pie.locator(".rc-chart-slice").count(), 6);
  const pieText = await pie.innerText();
  assert.ok(pieText.includes("other"), "folded slice missing");
  assert.ok(pieText.includes("total"), "donut-hole total missing");

  // S.2 — stacked: every positive segment drawn (3 series × 4 columns).
  const stacked = page.locator(".rc-chart", { hasText: "Tokens by model" });
  await stacked.waitFor({ timeout: 15_000 });
  assert.equal(await stacked.locator(".rc-chart-seg").count(), 12);
  assert.equal(await stacked.locator(".rc-chart-key").count(), 3, "stacked keeps its legend");

  // S.2 — horizontal: the category labels render WHOLE (the vertical axis
  // would clip these at 12 chars).
  const hbar = page.locator(".rc-chart", { hasText: "Slowest e2e tests" });
  await hbar.waitFor({ timeout: 15_000 });
  assert.equal(await hbar.locator(".rc-chart-hbar").count(), 5);
  assert.ok((await hbar.innerText()).includes("explorer drill-in (phone)"), "label truncated");

  // S.1's rule enforced: the two-series pie lands in the legible raw-props
  // fallback (error boundary → fallback), and the rest of the zone survived.
  const fallback = page.locator(".rc-fallback", { hasText: "broken pie" });
  await fallback.waitFor({ timeout: 15_000 });
  assert.match(await fallback.innerText(), /couldn't render/);
  assert.equal(await pie.locator(".rc-chart-slice").count(), 6, "good pie died with the bad one");
});

test("prompt cwd collapses to the caret, expands back, and the choice survives reload (4.8)", async () => {
  await page.waitForSelector(".prompt-cwd");
  // Clicking the path hides it; the caret is all that's left of the prompt.
  await page.locator(".prompt-cwd").click();
  assert.equal(await page.locator(".prompt-cwd").count(), 0);
  // The caret brings it back…
  await page.locator(".prompt-caret").click();
  assert.equal(await page.locator(".prompt-cwd").count(), 1);
  // …and toggles it off again; collapsed persists across a reload.
  await page.locator(".prompt-caret").click();
  assert.equal(await page.locator(".prompt-cwd").count(), 0);
  await page.reload();
  await page.waitForSelector(".prompt-caret");
  assert.equal(await page.locator(".prompt-cwd").count(), 0);
  // Restore the default (shown) for the tests that follow.
  await page.locator(".prompt-caret").click();
  assert.equal(await page.locator(".prompt-cwd").count(), 1);
});

test("R.4i: a subscription-only Claude shows a BLOCKED row with the API-key fix, not a demo", async () => {
  // A daemon whose only Claude credential is a subscription login (a
  // .credentials.json, no API key) — Anthropic's terms don't allow that in a
  // third-party app, so the picker must say so and name the fix, distinct from
  // the plain "no credentials · demo" state the other two agents show here.
  const claudeDir = mkdtempSync(path.join(os.tmpdir(), "genui-sub-e2e-"));
  writeFileSync(path.join(claudeDir, ".credentials.json"), "{}");
  const token = "e2e-blocked-9c2f";
  const d2 = await startDaemon({ MIRAFOLD_TOKEN: token, CLAUDE_CONFIG_DIR: claudeDir });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
    const claudeRow = page2.locator(".onb-agent", { hasText: "Claude Code" });
    await claudeRow.waitFor();
    // Warn-toned "subscription not supported", not the neutral demo status.
    assert.equal(await claudeRow.locator(".onb-blocked").count(), 1);
    assert.match(
      await claudeRow.locator(".onb-agent-status").innerText(),
      /subscription not supported/,
    );
    // The honest hint: WHY (terms) plus the concrete fix (an API key).
    const rowText = await claudeRow.innerText();
    assert.match(rowText, /third-party apps/);
    assert.match(rowText, /ANTHROPIC_API_KEY/);
    // Codex/Gemini are credential-less here → their ordinary demo hints, no block.
    assert.equal(
      await page2.locator(".onb-agent", { hasText: "Codex" }).locator(".onb-blocked").count(),
      0,
    );
  } finally {
    await page2.close();
    await d2.stop();
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("R.4k: a live picker row names its backing — the endpoint, or the credential", async () => {
  // Point Claude Code at a local endpoint (ANTHROPIC_BASE_URL) → kind `local`,
  // live, and the picker must show the endpoint so the local-model user sees
  // their setup was picked up (not a bare "ready"). The URL need not resolve —
  // we only read onboarding, never drive a turn.
  const token = "e2e-local-9c2f";
  const d2 = await startDaemon({
    MIRAFOLD_TOKEN: token,
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    // Gemini is the one-click case: an API key is its ONLY backing, so the
    // second step never opens and the row itself must name the credential
    // (2026-07-20). Display only — no create is clicked, so no engine spawns.
    GEMINI_API_KEY: "e2e-not-a-real-key",
  });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
    const claudeRow = page2.locator(".onb-agent", { hasText: "Claude Code" });
    await claudeRow.waitFor();
    assert.match(await claudeRow.locator(".onb-agent-status").innerText(), /ready/);
    const detail = await claudeRow.locator(".onb-agent-detail").innerText();
    assert.match(detail, /local endpoint/);
    assert.match(detail, /localhost:11434/);
    const geminiRow = page2.locator(".onb-agent", { hasText: "Gemini CLI" });
    assert.match(await geminiRow.locator(".onb-agent-status").innerText(), /ready/);
    assert.match(await geminiRow.locator(".onb-agent-detail").innerText(), /Gemini API key/);
  } finally {
    await page2.close();
    await d2.stop();
  }
});

test("N.4: a genuine choice opens the second step; a local server appears LIVE; blocked stays visible-but-gray", async () => {
  // A machine with real choices: codex has BOTH an API key and a ChatGPT
  // login; claude has an API key, a local endpoint, AND a prohibited
  // subscription login. A fixture "ollama" starts DOWN and comes up while
  // the picker is open — the live-appear promise. Display-only: no create is
  // ever clicked here (live credentials would spawn a real engine).
  const fixture = await startOllamaFixture(["llama3.2:3b"]);
  fixture.setUp(false);
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "genui-n4-codex-"));
  writeFileSync(path.join(codexDir, "auth.json"), "{}");
  const claudeDir = mkdtempSync(path.join(os.tmpdir(), "genui-n4-claude-"));
  writeFileSync(path.join(claudeDir, ".credentials.json"), "{}");
  const token = "e2e-n4-9c2f";
  const d2 = await startDaemon({
    MIRAFOLD_TOKEN: token,
    OPENAI_API_KEY: "dummy",
    CODEX_MODEL: "gpt-5.6-sol", // never spawned here — only read for the row's model line
    CODEX_HOME: codexDir,
    ANTHROPIC_API_KEY: "dummy",
    ANTHROPIC_BASE_URL: "http://localhost:9999", // an env endpoint the probe won't find
    CLAUDE_CONFIG_DIR: claudeDir,
    MIRAFOLD_LOCAL_ENDPOINTS: fixture.origin,
    REFRESH_MIN_INTERVAL_MS: "50",
  });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);

    // Codex: two usable credentials → the second step, not an instant create.
    await page2.locator(".onb-agent", { hasText: "Codex" }).click();
    await page2.waitForSelector(".onb-backends");
    assert.equal(await page2.locator(".onb-backend").count(), 2);
    const subRow = page2.locator(".onb-backend", { hasText: "ChatGPT subscription" });
    // The disclosed-uncertainty caveat rides the OPTION (K.3: uncertainty,
    // never permission), and the row is a live choice, not blocked.
    assert.match(await subRow.innerText(), /not clearly permitted/);
    assert.match(await subRow.innerText(), /your account, your call/);
    assert.equal(await page2.locator(".onb-backend-blocked").count(), 0);
    // Every row names the model it runs — the line that makes rows comparable
    // (2026-07-20). The api-key row's is the env override.
    assert.equal(
      await page2.locator(".onb-backend", { hasText: "OpenAI API key" })
        .locator(".onb-backend-model")
        .innerText(),
      "gpt-5.6-sol",
    );
    // No server discovered yet → the live hint, and no catalog anywhere.
    assert.match(await page2.locator(".onb-live-hint").innerText(), /shows up here/);
    assert.equal(await page2.locator(".onb-model").count(), 0);

    // Start the fixture "ollama" NOW, picker open — it must appear without a
    // reload (the refresh_agents poll re-probes every ~3s).
    fixture.setUp(true);
    const ollamaRow = page2.locator(".onb-backend", { hasText: "ollama" });
    await ollamaRow.waitFor({ timeout: 15_000 });
    // It's ONE row like every other, promising a catalog rather than splaying
    // it inline — and the hint that told you to go configure one is gone.
    assert.equal(await page2.locator(".onb-backend").count(), 3);
    assert.match(await ollamaRow.innerText(), /1 model — choose/);
    assert.equal(await page2.locator(".onb-model").count(), 0);
    assert.equal(await page2.locator(".onb-live-hint").count(), 0);
    // "runs on your machine" is a per-row tag, and ONLY the discovered
    // loopback server carries it — never the paid remote credential rows.
    assert.equal(await page2.locator(".onb-backend-tag").count(), 1);
    assert.equal(await ollamaRow.locator(".onb-backend-tag").innerText(), "local");

    // The third step: the catalog, one click deeper.
    await ollamaRow.click();
    await page2.waitForSelector(".onb-server-name");
    assert.match(await page2.locator(".onb-server-name").innerText(), /ollama/);
    assert.equal(await page2.locator(".onb-model").innerText(), "llama3.2:3b");

    // Esc walks back one step at a time: catalog → backends → agents.
    await page2.keyboard.press("Escape");
    await page2.waitForSelector(".onb-backend");
    await page2.locator(".onb-back").click();
    await page2.waitForSelector(".onb-list");

    // Claude: two usable (env endpoint + API key) + ollama speaks anthropic
    // too, and the prohibited subscription is VISIBLE but gray with the why.
    await page2.locator(".onb-agent", { hasText: "Claude Code" }).click();
    await page2.waitForSelector(".onb-backends");
    assert.equal(await page2.locator(".onb-backend", { hasText: "ollama" }).count(), 1); // dialect-filtered in
    const blocked = page2.locator(".onb-backend-blocked");
    assert.equal(await blocked.count(), 1);
    assert.ok(await blocked.isDisabled(), "a prohibited subscription must not be clickable");
    assert.match(await blocked.innerText(), /Claude subscription/);
    assert.match(await blocked.innerText(), /third-party apps/);
    // The env endpoint the probe never found keeps its own row.
    assert.match(
      await page2.locator(".onb-backend", { hasText: "local endpoint" }).innerText(),
      /localhost:9999/,
    );

    // Gemini: no credentials, no dialect → no second step; the click-through
    // demo create still works one-click (and proves the panel isn't sticky).
    await page2.locator(".onb-back").click();
    await page2.locator(".onb-agent", { hasText: "Gemini" }).click();
    await page2.waitForURL(/\/s\/[\w-]+/, { timeout: 15_000 });
  } finally {
    await page2.close();
    await d2.stop();
    fixture.close();
    rmSync(codexDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("a demo turn shows tokens but never a fabricated dollar cost (R.4b)", async () => {
  // The checklist hook emits no usage — run a template turn, which does.
  await page.locator("textarea").click();
  await page.keyboard.type("hello there");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".sb-usage", { timeout: 30_000 });
  const bar = await page.locator(".status-bar").innerText();
  assert.ok(!bar.includes("$"), `status bar shows a dollar cost in a demo session: ${bar}`);
  // The daemon version is visible in the status bar (R.4g).
  assert.match(bar, /v\d+\.\d+\.\d+/);
});

test("theme is a segmented sun|moon switch; home is the far-left control", async () => {
  const lightOpt = page.locator(".sb-theme-opt", { hasText: "☀" });
  const darkOpt = page.locator(".sb-theme-opt", { hasText: "☾" });
  // Both modes visible at once; dark (the default identity) is lit.
  assert.equal(await lightOpt.count(), 1);
  assert.equal(await darkOpt.count(), 1);
  assert.match((await darkOpt.getAttribute("class")) ?? "", /is-active/);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  // Clicking the sun side switches to light; re-clicking it is a no-op.
  await lightOpt.click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.match((await lightOpt.getAttribute("class")) ?? "", /is-active/);
  await lightOpt.click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await darkOpt.click(); // restore the default for later tests
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  // Home (⌂ → mission control) is the status bar's outermost far-left
  // control; the connection-dot toggle sits between it and the agent text.
  assert.match(
    (await page.locator(".status-bar > *:first-child").getAttribute("class")) ?? "",
    /sb-home/,
  );
});

// Shared theme-test helpers (S.3–S.5): the active theme id, and the reset
// that leaves later tests on default slots + dark mode.
const dataTheme = () => page.locator("html").getAttribute("data-theme");
const resetThemeState = async () => {
  await page.evaluate(() => {
    localStorage.removeItem("mirafold-theme-dark");
    localStorage.removeItem("mirafold-theme-light");
    localStorage.setItem("mirafold-theme", "dark");
  });
  await page.reload();
  await page.waitForSelector(".sb-theme");
};

test("two-slot model: each pill side paints its slot's theme; choices survive reload (S.3)", async () => {
  const darkOpt = page.locator(".sb-theme-opt", { hasText: "☾" });
  const lightOpt = page.locator(".sb-theme-opt", { hasText: "☀" });
  try {
    // Seed the dark slot with the only other manifest id ("light" — the
    // picker enforces appearance fit at write time; resolution is by id).
    await page.evaluate(() => localStorage.setItem("mirafold-theme-dark", "light"));
    await page.reload();
    await page.waitForSelector(".sb-theme");
    // Mode survived the reload as dark — the pill shows the MODE, unchanged
    // in rendering — while the paint followed the dark slot's theme.
    assert.match((await darkOpt.getAttribute("class")) ?? "", /is-active/);
    assert.equal(await lightOpt.count(), 1); // pill rendering: both sides, as ever
    assert.equal(await dataTheme(), "light");
    // Still true on a second reload: both keys persist.
    await page.reload();
    await page.waitForSelector(".sb-theme");
    assert.equal(await dataTheme(), "light");
    // Flipping the pill switches slots: light side = the light slot's
    // default, dark side = the seeded slot theme.
    await lightOpt.click();
    assert.equal(await dataTheme(), "light");
    await darkOpt.click();
    assert.equal(await dataTheme(), "light"); // dark MODE, slot-resolved theme
    // A stale/unknown slot id falls back to the side's built-in default.
    await page.evaluate(() => localStorage.setItem("mirafold-theme-dark", "no-such-theme"));
    await page.reload();
    await page.waitForSelector(".sb-theme");
    assert.equal(await dataTheme(), "dark");
  } finally {
    await resetThemeState();
  }
  assert.equal(await dataTheme(), "dark");
});

// A picker row by its exact display name (anchored), optionally scoped to a
// group — "Standard" appears in BOTH groups (one concept, both pill sides),
// so Standard picks must say which side they mean.
const themeRow = (name: string, group?: "Light themes" | "Dark themes") => {
  const scope = group
    ? page
        .locator(".theme-group")
        .filter({ has: page.locator(".theme-group-label", { hasText: group }) })
    : page;
  return scope
    .locator(".theme-row")
    .filter({ has: page.locator(".theme-row-name", { hasText: new RegExp(`^${name}$`) }) });
};

test("settings card: gear opens it, picking applies live and writes the slot (S.4)", async () => {
  // The gear sits in the bar; home keeps its outermost far-left slot
  // (pill's world is undisturbed — its own test above still pins its
  // rendering).
  assert.equal(await page.locator(".sb-settings").count(), 1);
  assert.match(
    (await page.locator(".status-bar > *:first-child").getAttribute("class")) ?? "",
    /sb-home/,
  );
  await page.locator(".sb-settings").click();
  await page.waitForSelector(".settings-card");
  // Both groups render from the manifest — every manifest theme has a row.
  assert.equal(await page.locator(".theme-group").count(), 2);
  assert.equal(await page.locator(".theme-row").count(), THEMES.length);
  // Swatch chips carry real colors parsed from the theme files (raw-CSS
  // import path) — a broken glob would leave them transparent.
  const chipBg = await page
    .locator(".theme-row .theme-chip")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(chipBg, "rgba(0, 0, 0, 0)");
  // Current slots are checked: the dark row (we're in default dark mode).
  assert.match(
    (await themeRow("Mirafold").getAttribute("class")) ?? "",
    /is-slotted/,
  );
  // Picking the light-labeled row applies immediately — picking is seeing:
  // mode flips to its appearance side, data-theme paints, slot is written,
  // the card stays open (live preview), and the pill's light side is lit.
  await themeRow("Standard", "Light themes").click();
  assert.equal(await dataTheme(), "light");
  assert.equal(await page.locator(".settings-card").count(), 1);
  assert.match(
    (await page.locator(".sb-theme-opt", { hasText: "☀" }).getAttribute("class")) ?? "",
    /is-active/,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("mirafold-theme-light")),
    "light",
  );
  // Picking the dark-labeled row: paints immediately, dark slot now means
  // that theme, and the light slot is untouched.
  await themeRow("Mirafold").click();
  assert.equal(await dataTheme(), "dark");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("mirafold-theme-dark")),
    "dark",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("mirafold-theme-light")),
    "light",
  );
  // Esc closes; scrim click closes too.
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".settings-card").count(), 0);
  await page.locator(".sb-settings").click();
  await page.waitForSelector(".settings-card");
  await page.locator(".settings-backdrop").click({ position: { x: 8, y: 8 } });
  assert.equal(await page.locator(".settings-card").count(), 0);
  assert.equal(await dataTheme(), "dark"); // ends where the suite expects
});

test("a borrowed theme is selectable, actually painted, and persistent (S.5)", async () => {
  const bodyBg = () =>
    page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
  const defaultDarkBg = await bodyBg();
  try {
    await page.locator(".sb-settings").click();
    await page.waitForSelector(".settings-card");
    await themeRow("Solarized Dark").click();
    assert.equal(await dataTheme(), "solarized-dark");
    // The theme's CSS is really LOADED and painting — not just stamped and
    // silently falling back to bare :root (the S.5 QA walk caught exactly
    // that: theme files must ride main.tsx's glob into the bundle). Theme
    // flips animate (body rides the 0.22s background transition), so wait
    // for the paint to settle rather than racing it.
    await page.waitForFunction(
      () => getComputedStyle(document.body).backgroundColor === "rgb(0, 43, 54)", // solarized base00
      { timeout: 3000 },
    );
    assert.notEqual(await bodyBg(), defaultDarkBg);
    // The pick landed in the dark slot; the light slot is untouched.
    assert.equal(
      await page.evaluate(() => localStorage.getItem("mirafold-theme-dark")),
      "solarized-dark",
    );
    // Survives a reload end-to-end.
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForSelector(".sb-theme");
    assert.equal(await dataTheme(), "solarized-dark");
    assert.equal(await bodyBg(), "rgb(0, 43, 54)"); // fresh load: no animation
  } finally {
    await resetThemeState();
  }
  assert.equal(await dataTheme(), "dark");
});

test("sandboxed artifact: scripts run inside the iframe under the shell CSP", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("show me an artifact");
  await page.keyboard.press("Enter");

  // Anchored to the artifact's own frame class — the transcript can hold
  // other sandboxed iframes by now (diagram components).
  const iframe = await page.waitForSelector("iframe.artifact-frame", { timeout: 30_000 });
  const frame = await iframe.contentFrame();
  assert.ok(frame, "artifact iframe has an accessible content frame");

  // The counter button proves the srcDoc document parsed AND its script
  // executes under sandbox="allow-scripts" + the strict artifact CSP.
  await frame!.waitForSelector("#b", { timeout: 15_000 });
  assert.equal(await frame!.textContent("#n"), "0");
  await frame!.click("#b");
  assert.equal(await frame!.textContent("#n"), "1");
});

test("an artifact pins to the dock via its chrome control, and unpins back", async () => {
  // The pin rides the shell-drawn chrome bar (outside the iframe). One
  // artifact is in the transcript from the previous test.
  await page.locator(".artifact-pin").click();
  await page.waitForSelector(".pin-dock");
  // The dock holds the live iframe; a stub holds its place in the flow.
  assert.equal(await page.locator(".pin-dock iframe").count(), 1);
  assert.match(await page.locator(".pin-stub").innerText(), /pinned/);
  // Unpin from the dock chrome → dock closes, the artifact returns inline.
  // (Anchored to the artifact's frame class: the transcript can hold other
  // sandboxed iframes by now — diagram components.)
  await page.locator(".pin-dock .artifact-pin").click();
  await page.waitForSelector(".pin-dock", { state: "detached" });
  assert.equal(await page.locator(".pin-stub").count(), 0);
  assert.equal(await page.locator(".render-zone iframe.artifact-frame").count(), 1);
});

test("hostile artifact is contained: escapes fail, sandbox is exactly allow-scripts (R.4e)", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("show me a hostile artifact");
  await page.keyboard.press("Enter");

  // The transcript accumulates across tests, so target the NEWEST iframe (an
  // earlier test's bridge-demo artifact is still in the scrollback).
  const lastFrame = page.locator("iframe").last();
  await lastFrame.waitFor({ timeout: 30_000 });
  // The sandbox attribute is EXACTLY allow-scripts — one added token
  // (allow-same-origin) would hand the artifact the shell's origin.
  assert.equal(await lastFrame.getAttribute("sandbox"), "allow-scripts");

  // The artifact's own CSP blocks Playwright's script injection into the frame
  // (evaluate/waitForFunction/textContent all inject) — a real containment
  // property. So read the frame's serialized HTML, which needs no injection,
  // and poll until every escape attempt has recorded its outcome. Re-query the
  // frame each pass: a bridge action triggers a new turn whose re-render can
  // detach an earlier frame handle.
  const div = (html: string, id: string) =>
    html.match(new RegExp(`<div id="${id}">([^<]*)</div>`))?.[1] ?? "";
  let frameHtml = "";
  for (let i = 0; i < 60; i++) {
    const fr = await (await page.locator("iframe").last().elementHandle())?.contentFrame();
    frameHtml = fr ? await fr.content() : "";
    if (div(frameHtml, "sent") === "attacks-sent") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(div(frameHtml, "sent"), "attacks-sent", "hostile script never finished");

  // Opaque origin: the shell's DOM and app-origin cookie are unreachable.
  assert.equal(div(frameHtml, "dom"), "parent-dom-blocked");
  assert.equal(div(frameHtml, "cookie"), "cookie-blocked");
  // Injected CSP: fetch tripped a policy violation, it did not succeed.
  assert.match(div(frameHtml, "csp"), /^csp-violation/);

  // The bridge: an unstamped/forged prompt never lands, a state op never
  // lands, and the 400ms rate limit drops the second of a burst — so of
  // everything the artifact tried to send, only "burst-alpha" reaches the
  // transcript as a command strip.
  await page.waitForSelector("text=burst-alpha", { timeout: 15_000 });
  const body = await page.locator(".shell").innerText();
  assert.ok(!body.includes("burst-beta"), "rate limit failed: second burst action landed");
  assert.ok(
    !body.includes("forged-unstamped-prompt"),
    "nonce check failed: a forged bridge message landed",
  );
});

test("navigating artifact is blanked into the navigation-blocked fallback (R.4e)", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("show me a navigating artifact");
  await page.keyboard.press("Enter");
  // The liveness kill (no nonce-stamped artifactReady) unmounts the frame
  // and shows the fallback with the source.
  await page.waitForSelector("text=navigation blocked", { timeout: 30_000 });
  await page.waitForSelector("text=tried to navigate away", { timeout: 5_000 });
});

test("fleet: the cwd is the row's hover tooltip; clicking outside the new-session card dismisses it", async () => {
  await page.goto(`${base}/`);
  await page.waitForSelector(".fleet-row");
  // The cwd left the row proper (clutter) — it survives as the row's
  // native-delay hover tooltip.
  assert.match(
    (await page.locator(".fleet-row").first().getAttribute("title")) ?? "",
    /\//,
  );
  // Row order matches the status bar: agent, then model (2026-07-17).
  const rowText = await page.locator(".fleet-row").first().innerText();
  assert.ok(
    rowText.indexOf("claude-code") < rowText.indexOf("mock-sonnet"),
    `agent should precede model in: ${rowText}`,
  );
  // "+ new session" opens the picker; a backdrop click (outside the card)
  // changes your mind — possible only because a fleet exists behind it.
  await page.locator(".fleet-new").click();
  await page.waitForSelector(".onb-card");
  await page.locator(".onb-overlay").click({ position: { x: 5, y: 5 } });
  assert.equal(await page.locator(".onb-overlay").count(), 0);
  // A click INSIDE the card must not dismiss it…
  await page.locator(".fleet-new").click();
  await page.waitForSelector(".onb-card");
  await page.locator(".onb-title").click();
  assert.equal(await page.locator(".onb-overlay").count(), 1);
  // …and Esc closes it, same idiom as the settings card.
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".onb-overlay").count(), 0);
});

test("A.3b: the session name is the row's one link; buttons ride above the stretched overlay", async () => {
  await page.goto(`${base}/`);
  await page.waitForSelector(".fleet-row");
  const row = page.locator(".fleet-row").first();
  // The row is a container, not an anchor — buttons inside a link are
  // invalid HTML, and a screen reader read every column of the row (id,
  // status, the word "end") as one enormous link label.
  assert.equal(await row.evaluate((el) => el.tagName), "DIV");
  // Exactly one link per row — the session name.
  assert.equal(await row.locator("a").count(), 1);
  assert.ok(((await row.locator(".fleet-link").innerText()) ?? "").length > 0);
  // The real controls sit ABOVE the click-anywhere overlay (z-index — if the
  // layering breaks, the overlay intercepts these clicks and they navigate):
  // "end" arms in place (end → end?)…
  await row.locator(".fleet-end").click();
  assert.equal(await row.locator(".fleet-end").innerText(), "end?");
  assert.equal(page.url(), `${base}/`);
  // …and ✎ opens the rename input in place; Escape cancels it.
  await row.locator(".fleet-edit").click();
  assert.equal(page.url(), `${base}/`);
  await page.waitForSelector(".fleet-rename");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".fleet-rename").count(), 0);
  // (Click-anywhere-on-the-row still opening the session is proven by the
  // next two tests, which click the row body, and by the phone tap.)
});

test("! cd .. — silent success says so, the escape is announced, and the agent answers unprompted (terminal parity)", async () => {
  // Back into a session created earlier in this file.
  await page.locator(".fleet-row").first().click();
  await page.waitForURL(/\/s\/[\w-]+/);
  await page.waitForSelector("textarea");

  await page.locator("textarea").click();
  await page.keyboard.type("! cd ..");
  await page.keyboard.press("Enter");

  // The strip echoes the command; a no-output success is SAID, not blank…
  await page.waitForSelector(".bang-block");
  assert.match(await page.locator(".bang-block").last().innerText(), /cd \.\./);
  await page.waitForSelector(".bang-no-output");
  assert.equal(
    await page.locator(".bang-no-output").last().innerText(),
    "(completed with no output)",
  );
  // …the cwd-guard reset is announced, like the terminal harness…
  await page
    .locator(".notice-line", { hasText: "Shell cwd was reset to" })
    .last()
    .waitFor({ timeout: 15_000 });
  // …and the agent answers the transcript with NO typed prompt: an assistant
  // turn lands AFTER the bang block (sibling order = transcript order, so
  // replayed turns from earlier tests can't satisfy this).
  await page.waitForSelector(".bang-block ~ .turn-assistant", { timeout: 30_000 });
});

test("entering a session puts the caret in the prompt box — no click first", async () => {
  await page.goto(`${base}/`);
  await page.waitForSelector(".fleet-row");
  await page.locator(".fleet-row").first().click();
  await page.waitForURL(/\/s\/[\w-]+/);
  await page.waitForSelector("textarea");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
  // The real proof: typing with nothing clicked lands in the box.
  await page.keyboard.type("straight in");
  assert.equal(await page.locator("textarea").inputValue(), "straight in");
  await page.locator("textarea").fill("");
  // Same on a reload of the session URL.
  await page.reload();
  await page.waitForSelector("textarea");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
});

test("status bar: new sits beside home, end is the far-right control, ?new opens the picker", async () => {
  const cls = async (sel: string) => (await page.locator(sel).getAttribute("class")) ?? "";
  assert.match(await cls(".status-bar > *:first-child"), /sb-home/);
  assert.match(await cls(".status-bar > *:nth-child(2)"), /sb-new/);
  assert.match(await cls(".status-bar > *:last-child"), /sb-end/);
  // It opens a NEW tab on the startup screen — the whole point of the button.
  assert.equal(await page.locator(".sb-new").getAttribute("target"), "_blank");
  const href = (await page.locator(".sb-new").getAttribute("href")) ?? "";
  assert.match(href, /^\/\?new/);
  // …and that URL lands on the agent picker even though a fleet exists.
  const fresh = await browser.newPage();
  await fresh.context().addCookies([{ name: "mirafold_token", value: TOKEN, url: base }]);
  await fresh.goto(`${base}${href}`);
  await fresh.waitForSelector(".onb-card");
  await fresh.close();
});

test("streaming holds a scrolled-up reader in place, and re-follows once back at the bottom", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Read the current implementation", { timeout: 15_000 });

  const zone = page.locator(".render-zone");
  const geom = () =>
    zone.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, view: el.clientHeight }));

  // A real wheel, up, over the transcript — the reader going back to look at
  // something while the agent is still talking. Several notches: landing
  // within the follow slack of the bottom would prove nothing, since that
  // position is *supposed* to keep following.
  await zone.hover();
  const atWheel = await geom();
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
  const before = await geom();
  // The wheel must actually have moved the reader UP. Without this the test
  // can pass vacuously in the exact state that motivated it: a permanently
  // in-flight smooth scroll owning scrollTop, wheel deltas overwritten before
  // they become scroll events, the reader carried along the whole time
  // (2026-07-20 — the trace that produced this assertion).
  assert.ok(
    before.top < atWheel.top - 100,
    `the wheel did not scroll the reader up: ${atWheel.top} → ${before.top}`,
  );
  assert.ok(
    before.h - before.top - before.view > 200,
    "the wheel must land well clear of the bottom for this test to mean anything",
  );

  // Position holds for as long as output keeps landing below.
  let grew = false;
  for (let i = 0; i < 20 && !grew; i++) {
    await page.waitForTimeout(500);
    const now = await geom();
    assert.ok(
      Math.abs(now.top - before.top) <= 1,
      `streaming moved a scrolled-up reader: ${before.top} → ${now.top}`,
    );
    grew = now.h > before.h;
  }
  assert.ok(grew, "no output painted during the hold window — the assertion proved nothing");

  // Back to the bottom re-arms follow, with no toggle to press.
  await zone.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
  await page.waitForTimeout(1200);
  const end = await geom();
  const gap = end.h - end.top - end.view;
  assert.ok(gap <= 60, `expected to be following the tail again, sat ${gap}px above it`);
});

/** Asserts a DOM condition that lands a tick or two AFTER the click that
 *  causes it. A one-shot count()/isVisible() right after a click is a coin
 *  flip once the machine is busy — E.3/E.5 lost that flip on 2026-07-25.
 *  Keeps the descriptive message a bare waitForFunction timeout would lose.
 *  Pass the check INLINE (never via a const): tsx's keepNames wraps a named
 *  function expression in a helper that doesn't exist inside the page. */
const eventually = async (check: () => boolean, message: string, timeout = 10_000) => {
  await page.waitForFunction(check, undefined, { timeout }).catch(() => assert.fail(message));
};

test("E.3: the files panel lists the working tree, opens a file beside the transcript, drills back", async () => {
  // The e2e daemon runs in the genui-shell repo itself — a real git repo — so
  // the tree is live git data. package.json is always tracked and top-level.
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-panel");
  const pkg = page.locator(".files-file-row", { hasText: "package.json" }).first();
  await pkg.waitFor({ timeout: 15_000 });

  // The tree leads with the checked-out ROOT as its top node — the folder's
  // NAME (no path header above the tree); collapsing it folds the whole tree.
  const root = page.locator(".files-root-row");
  assert.match(await root.innerText(), /genui-shell/);
  assert.equal(await page.locator(".files-title").count(), 0, "the old path header is gone");
  await root.click();
  await eventually(
    () => document.querySelectorAll(".files-file-row").length === 0,
    "collapsed root still lists files",
  );
  await root.click();
  await pkg.waitFor({ timeout: 15_000 });

  // The transcript and the prompt box both stay usable beside the open panel
  // (the squeeze risk — the panel and transcript are separate flex columns).
  assert.ok(await page.locator(".render-zone").isVisible());
  assert.ok(await page.locator(".prompt-box textarea, textarea").first().isVisible());

  // Open the file → its content shows in the panel's file view.
  await pkg.click();
  await page.waitForSelector(".files-view .fv-content");
  assert.match(await page.locator(".files-view .fv-content").innerText(), /"name"/);

  // Back returns to the tree; the toggle closes the panel entirely.
  await page.locator(".files-back").click();
  await page.waitForSelector(".files-tree");
  await page.locator(".ab-files").click();
  await eventually(() => !document.querySelector(".files-panel"), "the toggle left the panel open");
});

test("E.5: expanded dirs survive a close/reopen, and a turn's auto-refresh keeps tree state", async () => {
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-panel");

  // Expand a known top-level directory (the repo has server/). Exact-match
  // the name span: since E2.2 the lazy lister is git-blind until the git
  // layer lands, so ignored siblings like dist-server/ are listed too — a
  // substring match would hit dist-server first.
  const serverDir = page.locator('.files-dir:has(.files-name:text-is("server"))').first();
  await serverDir.waitFor({ timeout: 15_000 });
  await serverDir.click();
  // A child appears — protocol.ts is a tracked file directly under server/.
  await page.waitForSelector(".files-file-row:has-text('protocol.ts')");

  // Close and reopen within the same session — the expansion is remembered
  // (E.5: reset is keyed on session switch, not on open).
  await page.locator(".ab-files").click();
  await eventually(() => !document.querySelector(".files-panel"), "the toggle left the panel open");
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-tree");
  await eventually(
    () =>
      [...document.querySelectorAll(".files-file-row")].some((el) =>
        el.textContent?.includes("protocol.ts"),
      ),
    "expanded dir was collapsed on reopen",
  );

  // A turn auto-refreshes the tree (E.5) without collapsing what's open or
  // closing the panel: run a full mock turn, then the expansion still holds.
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
  await page.waitForTimeout(400); // let the turn_end refresh land…
  // …then let it FINISH: the refetch swaps the rows, so a slow one under load
  // must not read as a collapse.
  await eventually(() => !!document.querySelector(".files-panel"), "auto-refresh closed the panel");
  await eventually(
    () =>
      [...document.querySelectorAll(".files-file-row")].some((el) =>
        el.textContent?.includes("protocol.ts"),
      ),
    "auto-refresh collapsed the expanded dir",
  );

  await page.locator(".ab-files").click(); // tidy up for later tests
});

test("E2.2: the tree is LAZY — open fetches root + first level only; expand fetches exactly that dir; cache re-expands with no request; turn-end refetches only expanded dirs", async () => {
  await installFsRecorder(page);
  const sent = () => fsSent(page);
  const mark = async () => (await sent()).length;

  // Open: the root and (prefetched) first level arrive — every listing
  // request is depth ≤ 1, and the whole-tree fs_list is never sent.
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-file-row:has-text('package.json')");
  await page.waitForTimeout(300); // let the prefetch fan-out finish
  const onOpen = await sent();
  assert.ok(onOpen.every((m) => m.type !== "fs_list"), "the whole-tree request is retired from the client");
  const listdirs = onOpen.filter((m) => m.type === "fs_listdir");
  assert.ok(listdirs.some((m) => m.path === ""), "the root is fetched");
  assert.ok(
    listdirs.every((m) => !String(m.path).includes("/")),
    `open fetches only root + first level, got: ${listdirs.map((m) => m.path).join(", ")}`,
  );

  // Expanding a PREFETCHED first-level dir renders from cache — no request.
  // (web/ was fetched by the open prefetch above.)
  let m0 = await mark();
  const webDir = page.locator('.files-dir:has(.files-name:text-is("web"))').first();
  await webDir.click();
  await page.waitForSelector('.files-dir:has(.files-name:text-is("src"))');
  assert.equal((await sent()).length, m0, "a prefetched dir expands with no request");

  // Expanding a DEEP dir fetches exactly that dir and nothing else.
  m0 = await mark();
  await page.locator('.files-dir:has(.files-name:text-is("src"))').first().click();
  await page.waitForSelector(".files-file-row:has-text('main.tsx')");
  const deep = (await sent()).slice(m0);
  assert.deepEqual(
    deep.map((m) => `${m.type}:${m.path}`),
    ["fs_listdir:web/src"],
    "expand fetched exactly the expanded dir",
  );

  // Collapse and re-expand: served from cache, zero requests.
  m0 = await mark();
  await webDir.click(); // collapse web (web/src stays expanded underneath)
  await eventually(
    () => ![...document.querySelectorAll(".files-file-row")].some((el) => el.textContent?.includes("main.tsx")),
    "collapse left the subtree visible",
  );
  await webDir.click(); // re-expand
  await page.waitForSelector(".files-file-row:has-text('main.tsx')");
  assert.equal((await sent()).length, m0, "collapse/re-expand made requests despite the cache");

  // A turn's auto-refresh (E.5, lazy since E2.2) refetches ONLY the root and
  // the expanded dirs — never a whole-tree request, no first-level prefetch.
  m0 = await mark();
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");
  // Wait on the refetch TRAFFIC itself, not on transcript text — the E.5
  // test above ran this same prompt, so its completion line already matches
  // a text selector instantly, racing the real turn_end. The refetch batch
  // is sent synchronously in one handler, so one new frame means all of them.
  await page
    .waitForFunction(
      (n) => (window as unknown as { __fsSent: unknown[] }).__fsSent.length > n,
      m0,
      { timeout: 30_000 },
    )
    .catch(() => assert.fail("turn-end sent no refresh at all"));
  const onTurn = (await sent()).slice(m0);
  const expected = new Set(["", "server", "web", "web/src"]); // server/ expanded by the E.5 test above
  assert.ok(
    onTurn.every((m) => m.type === "fs_listdir" && expected.has(String(m.path))),
    `turn-end refetched beyond root + expanded dirs: ${onTurn.map((m) => `${m.type}:${m.path}`).join(", ")}`,
  );

  await page.locator(".ab-files").click(); // tidy up for later tests
});

test("E2.4: the Projects-root proof — lazy expands into two repos with per-repo statuses, ignore rules, and a nested-repo diff; never a whole-tree request; phone drills the same fixture", async () => {
  // The headline E2 use case, end to end: a session rooted at a folder that
  // is NOT a repo, holding two repos with different ignore rules (one dirty)
  // and a plain dir.
  const mr = mkdtempSync(path.join(os.tmpdir(), "e2e-mr-"));
  const repoA = path.join(mr, "repoA");
  const repoB = path.join(mr, "repoB");
  mkdirSync(repoA);
  mkdirSync(repoB);
  mkdirSync(path.join(mr, "plain"));
  writeFileSync(path.join(mr, "plain", "note.txt"), "just a note\n");
  git(repoA, "init", "-q");
  writeFileSync(path.join(repoA, ".gitignore"), "dist/\n");
  writeFileSync(path.join(repoA, "kept.txt"), "kept content\n");
  writeFileSync(path.join(repoA, "changed.txt"), "the before line\n");
  git(repoA, "add", "-A");
  git(repoA, "commit", "-qm", "init");
  writeFileSync(path.join(repoA, "changed.txt"), "the after line\n");
  mkdirSync(path.join(repoA, "dist"));
  writeFileSync(path.join(repoA, "dist", "bundle.js"), "never listed\n");
  git(repoB, "init", "-q");
  writeFileSync(path.join(repoB, ".gitignore"), "secret.log\n");
  writeFileSync(path.join(repoB, "app.ts"), "export const b = 1;\n");
  git(repoB, "add", "-A");
  git(repoB, "commit", "-qm", "init");
  writeFileSync(path.join(repoB, "secret.log"), "s\n");
  writeFileSync(path.join(repoB, "notes.md"), "untracked here\n");

  // Seed the session AT the fixture over the wire (the UI has no cwd
  // picker), then join it from the browser like any viewport would.
  const seed = new TestClient(d.port, { token: TOKEN });
  await seed.opened();
  await seed.type("agents");
  seed.send({ type: "create", agent: "claude-code", cwd: mr } as ClientMsg);
  const created = (await seed.type("session_created")) as { sessionId: string } & Record<string, unknown>;
  const backUrl = page.url(); // later tests continue the original session
  try {
    await page.goto(`${base}/s/${created.sessionId}`);

    // The recorder goes in BEFORE the panel opens — the claim under proof is
    // that NO frame in the whole flow is a whole-tree fs_list, so every
    // frame must be caught. (Fresh window after goto: re-install.)
    await installFsRecorder(page);

    await page.locator(".ab-files").click();
    // The root: three dirs, no statuses anywhere — the root is no repo.
    await page.waitForSelector('.files-dir:has(.files-name:text-is("repoA"))');
    assert.equal(await page.locator(".files-status").count(), 0, "statuses at a non-repo root");

    // Into the dirty repo: its own gitignore hides dist/, its statuses ride
    // the rows — the modified file badged M, the clean file unbadged.
    await page.locator('.files-dir:has(.files-name:text-is("repoA"))').click();
    await page.waitForSelector(".files-file-row:has-text('changed.txt')");
    assert.equal(
      await page.locator('.files-dir:has(.files-name:text-is("dist"))').count(),
      0,
      "repoA's ignored dist/ must not be listed",
    );
    assert.equal(
      await page.locator(".files-file-row:has-text('changed.txt') .files-status").innerText(),
      "M",
    );
    assert.equal(
      await page.locator(".files-file-row:has-text('kept.txt') .files-status").count(),
      0,
      "a clean tracked file carries no badge",
    );

    // Open the modified file: a status click leads with the DIFF, and the
    // diff resolves through repoA — the nested repo — not the session root.
    await page.locator(".files-file-row:has-text('changed.txt')").click();
    await page.waitForSelector(".files-view .tool-diff");
    const diffText = await page.locator(".files-view .tool-diff").innerText();
    assert.match(diffText, /the before line/);
    assert.match(diffText, /the after line/);
    await page.locator(".files-back").click();
    await page.waitForSelector(".files-tree");

    // Into the second repo: ITS rules now — secret.log hidden here (and only
    // here), its untracked file badged U. Open a file in this repo too: the
    // clean one arrives as plain content.
    await page.locator('.files-dir:has(.files-name:text-is("repoB"))').click();
    await page.waitForSelector(".files-file-row:has-text('app.ts')");
    assert.equal(
      await page.locator(".files-file-row:has-text('secret.log')").count(),
      0,
      "repoB's ignored secret.log must not be listed",
    );
    assert.equal(
      await page.locator(".files-file-row:has-text('notes.md') .files-status").innerText(),
      "U",
    );
    await page.locator(".files-file-row:has-text('app.ts')").click();
    await page.waitForSelector(".files-view .fv-content");
    assert.match(await page.locator(".files-view .fv-content").innerText(), /export const b/);
    await page.locator(".files-back").click();
    await page.waitForSelector(".files-tree");
    await page.locator(".ab-files").click(); // close the panel

    // The pinned claim: the entire flow — open, prefetch, expands, refreshes
    // — rode the lazy pair. Not one whole-tree request anywhere.
    const frames = await fsSent(page);
    assert.ok(frames.length > 0, "the recorder saw no fs traffic at all");
    assert.ok(
      frames.every((m) => m.type !== "fs_list"),
      "a whole-tree fs_list rode the lazy flow",
    );

    // Phone drill-in over the SAME fixture: full-screen panel, expand the
    // dirty repo, the badge is there, a file opens, Esc walks back out.
    const phoneCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    try {
      const phone = await phoneCtx.newPage();
      await phone.goto(`${base}/?token=${TOKEN}`);
      await phone.goto(`${base}/s/${created.sessionId}`);
      await phone.locator(".sb-files").focus();
      await phone.keyboard.press("Enter");
      await phone.waitForSelector(".files-panel[role=dialog]");
      await phone.locator('.files-dir:has(.files-name:text-is("repoA"))').tap();
      await phone.waitForSelector(".files-file-row:has-text('changed.txt')");
      assert.equal(
        await phone.locator(".files-file-row:has-text('changed.txt') .files-status").innerText(),
        "M",
        "the per-repo badge rides the phone drill-in too",
      );
      await phone.locator(".files-file-row:has-text('kept.txt')").tap();
      await phone.waitForSelector(".files-view .fv-content");
      assert.match(await phone.locator(".files-view .fv-content").innerText(), /kept content/);
      await phone.keyboard.press("Escape");
      await phone.waitForSelector(".files-tree");
      await phone.keyboard.press("Escape");
      assert.equal(await phone.locator(".files-panel").count(), 0, "Esc from the tree closes the panel");
    } finally {
      await phoneCtx.close();
    }
  } finally {
    seed.close();
    await page.goto(backUrl); // hand the original session back to later tests
    await page.waitForSelector("textarea");
    rmSync(mr, { recursive: true, force: true });
  }
});

test("W.2: the live tree — a write behind the UI's back appears with zero clicks; a collapsed dir's new file causes no fetch; the refresh button still works", async () => {
  // A workspace the UI never touches directly: the test writes to disk and
  // the tree must notice on its own (the doorbell → fs_changed → refetch).
  const ws = mkdtempSync(path.join(os.tmpdir(), "e2e-live-"));
  writeFileSync(path.join(ws, "top.txt"), "top\n");
  mkdirSync(path.join(ws, "colly", "sub"), { recursive: true });
  writeFileSync(path.join(ws, "colly", "sub", "inner.txt"), "inner\n");

  const seed = new TestClient(d.port, { token: TOKEN });
  await seed.opened();
  await seed.type("agents");
  seed.send({ type: "create", agent: "claude-code", cwd: ws } as ClientMsg);
  const created = (await seed.type("session_created")) as { sessionId: string } & Record<string, unknown>;
  const backUrl = page.url();
  try {
    await page.goto(`${base}/s/${created.sessionId}`);
    await installFsRecorder(page);
    await page.locator(".ab-files").click();
    await page.waitForSelector(".files-file-row:has-text('top.txt')");

    // The headline: a file written with NO interaction — no clicks, no agent
    // turn — appears by itself (server debounce 400ms + one refetch ≪ this
    // timeout; the claim is "you never need the button").
    writeFileSync(path.join(ws, "fresh.txt"), "surprise\n");
    await page.waitForSelector(".files-file-row:has-text('fresh.txt')", { timeout: 3_000 });

    // A new file inside a collapsed, never-fetched dir: the bell rings, the
    // refetch unit is root + EXPANDED dirs — so colly/sub is rightly never
    // fetched and the file rightly not shown (it'd appear on expand).
    writeFileSync(path.join(ws, "colly", "sub", "hidden.txt"), "quiet\n");
    await page.waitForTimeout(2_200); // server debounce + client coalescing gap, settled
    const frames = await fsSent(page);
    assert.ok(
      frames.every((m) => !(m.type === "fs_listdir" && m.path === "colly/sub")),
      "a bell must not fetch a collapsed, unfetched dir",
    );
    assert.equal(
      await page.locator(".files-file-row:has-text('hidden.txt')").count(),
      0,
      "nothing expanded shows the hidden file — correct",
    );

    // The refresh button is unchanged beside the bell: a click still
    // refetches (fresh root request on the wire) and the tree stays whole.
    const rootFetches = () =>
      page.evaluate(
        () =>
          (window as unknown as { __fsSent: { type: string; path?: string }[] }).__fsSent.filter(
            (m) => m.type === "fs_listdir" && m.path === "",
          ).length,
      );
    const beforeClick = await rootFetches();
    await page.locator(".files-refresh").click();
    await page.waitForFunction(
      (n) =>
        (window as unknown as { __fsSent: { type: string; path?: string }[] }).__fsSent.filter(
          (m) => m.type === "fs_listdir" && m.path === "",
        ).length > n,
      beforeClick,
      { timeout: 5_000 },
    );
    await page.waitForSelector(".files-file-row:has-text('fresh.txt')");

    // The lazy invariant survives the live tree: not one whole-tree request.
    assert.ok(
      (await fsSent(page)).every((m) => m.type !== "fs_list"),
      "a whole-tree fs_list rode the live-tree flow",
    );
    await page.locator(".ab-files").click(); // close the panel for later tests
  } finally {
    seed.close();
    await page.goto(backUrl);
    await page.waitForSelector("textarea");
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a notice in the engine's own words is badged; the shell's own words aren't", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("show me a notice");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".notice-line[data-source]", { timeout: 15_000 });

  // The engine's line carries its name and no shell glyph…
  const engine = page.locator(".notice-line[data-source]").last();
  assert.equal(await engine.getAttribute("data-source"), "mock-engine");
  assert.equal(await engine.locator(".notice-source").innerText(), "mock-engine");
  assert.equal(await engine.locator(".notice-glyph").count(), 0);
  assert.match(await engine.innerText(), /re-enter your API key/);

  // …and Mirafold's own line carries the glyph and no badge, so the two can't
  // be confused: an engine string can't render as the shell speaking (2026-07-20).
  const shell = page
    .locator(".notice-line:not([data-source])")
    .filter({ hasText: "context compacted" })
    .last();
  assert.equal(await shell.locator(".notice-source").count(), 0);
  assert.equal(await shell.locator(".notice-glyph").count(), 1);
  // The difference is visible, not just structural.
  assert.equal(
    await engine.evaluate((el) => getComputedStyle(el).borderLeftStyle),
    "dashed",
  );
  assert.equal(
    await shell.evaluate((el) => getComputedStyle(el).borderLeftStyle),
    "solid",
  );
});

// C.2 — the automated regression guard for Phase A. axe-core (4.10.2, injected
// into the live page, not a jsdom stand-in) scans each surface for the
// machine-checkable third of WCAG. Honest scope: this does NOT replace A.3's
// manual/screen-reader pass — it catches the silent decays (a <button> becoming
// a styled <div>, a dropped aria-label) that look identical to a sighted mouse
// user. We fail on `serious` + `critical` only; `moderate`/`minor` are noisier
// and less clearly real, and holding the line on the two impactful tiers is
// what keeps the Phase A work from rotting. Any accepted exception lives in
// AXE_EXCEPTIONS below, each with a reason.
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
// Rule IDs to disable, each justified. Empty today — the manual axe sweep
// (2026-07-21) already fixed every real finding, so the app scans clean.
const AXE_EXCEPTIONS: { rule: string; why: string }[] = [];

// axe-core's window global and the slice of its run() result we read. Named
// here so the page-side call below stays legible; types are erased before the
// evaluate callback is serialized to the browser, so this is compile-time only.
type AxeViolation = { id: string; impact: string; nodes: unknown[]; help: string };
type AxePage = { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: AxeViolation[] }> } };

async function assertAxeClean(p: Page, label: string): Promise<void> {
  // Settle every animation/transition to its END state before auditing:
  // fleet rows enter with `rise` (opacity 0→1), and on a loaded CI runner
  // axe could sample a row mid-rise and read the partial-opacity text as a
  // color-contrast violation (the C.2 fleet-view flake, root-caused
  // 2026-07-23). Zeroing durations jumps each animation to its resting
  // frame — the exact state we mean to audit — without changing any final
  // style value. Infinite animations (the live-state pulse dot) jump to
  // their end frame too, harmless for contrast.
  await p.addStyleTag({
    content:
      "*, *::before, *::after { animation-duration: 0s !important; " +
      "animation-delay: 0s !important; transition-duration: 0s !important; }",
  });
  await p.addScriptTag({ content: axe.source }); // defines window.axe in the page
  const violations = await p.evaluate(
    async ([tags, exceptions]) => {
      const rules: Record<string, { enabled: boolean }> = {};
      for (const r of exceptions as string[]) rules[r] = { enabled: false };
      const res = await (window as unknown as AxePage).axe.run(document, {
        resultTypes: ["violations"],
        runOnly: { type: "tag", values: tags },
        rules,
      });
      return res.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length }));
    },
    [AXE_TAGS, AXE_EXCEPTIONS.map((e) => e.rule)] as const,
  );
  assert.deepEqual(
    violations,
    [],
    `axe serious/critical violations on ${label}: ${JSON.stringify(violations, null, 2)}`,
  );
}

test("C.2: axe-core finds no serious/critical WCAG violations across the app", async () => {
  // Own daemon + relay stub so every surface (including connect-device, which
  // renders only with a relay) is reachable and the state is controlled.
  const relay = await startRelayStub({});
  const token = "e2e-axe-9c2f";
  const dax = await startDaemon({
    MIRAFOLD_TOKEN: token,
    MIRAFOLD_RELAY_URL: relay.url,
    MIRAFOLD_RELAY_CODE: "e2e-axe-pairing-code-1a2b",
  });
  const p = await browser.newPage();
  try {
    const baseAx = `http://127.0.0.1:${dax.port}`;
    await p.goto(`${baseAx}/?token=${token}`);

    // 1) Onboarding ("choose your agent") — empty registry opens here.
    await p.waitForSelector(".onb-agent");
    await assertAxeClean(p, "onboarding");

    // 2) A live session with a rendered transcript + checklist.
    await p.locator(".onb-agent", { hasText: "Claude Code" }).click();
    await p.waitForURL(/\/s\/[\w-]+/);
    await p.waitForSelector(".demo-banner");
    await p.locator("textarea").click();
    await p.keyboard.type("plan it step by step");
    await p.keyboard.press("Enter");
    await p.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
    await assertAxeClean(p, "session transcript");

    // 2b) Explorer files panel open, tree listed (E.3).
    await p.locator(".ab-files").click();
    await p.waitForSelector(".files-panel .files-row");
    await assertAxeClean(p, "files panel");
    await p.locator(".ab-files").click(); // close before the next surface

    // 3) Settings / theme card (a dialog).
    await p.locator(".sb-settings").click();
    await p.waitForSelector("[role=dialog]");
    await assertAxeClean(p, "settings dialog");
    await p.keyboard.press("Escape");

    // 4) Connect-device (a dialog; needs the relay above).
    await p.locator(".sb-pair").click();
    await p.waitForSelector(".pair-card");
    await assertAxeClean(p, "connect-device dialog");
    await p.keyboard.press("Escape");

    // 5) Mission control (fleet) — now has one session in the list.
    await p.goto(`${baseAx}/`);
    await p.waitForSelector(".fleet-title");
    await p.waitForSelector(".fleet-link");
    await assertAxeClean(p, "fleet view");
  } finally {
    await p.close();
    await dax.stop();
    await relay.stop();
  }
});

test("an uncaught front-end error lands in the daemon's log (client_error path)", async () => {
  // The shared page still holds a live socket (fleet or session — both run
  // one). A deferred throw escapes the evaluate call itself and surfaces as
  // window "error", which ws.ts forwards over the wire.
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("e2e-client-error-probe");
    }, 0);
  });
  for (let i = 0; i < 50 && !d.logs().includes("e2e-client-error-probe"); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(d.logs(), /error: client error: Error: e2e-client-error-probe/);
});
