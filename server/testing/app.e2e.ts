import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { startOllamaFixture } from "./ollama-fixture";
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

  const iframe = await page.waitForSelector("iframe", { timeout: 30_000 });
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
  await page.locator(".pin-dock .artifact-pin").click();
  await page.waitForSelector(".pin-dock", { state: "detached" });
  assert.equal(await page.locator(".pin-stub").count(), 0);
  assert.equal(await page.locator(".render-zone iframe").count(), 1);
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
