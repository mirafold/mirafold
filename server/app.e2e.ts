import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";

// L.2c: Tier-3 E2E, opt-in (`yarn test:e2e` — needs google-chrome and a fresh
// `yarn build`, which the script runs first: the daemon serves ./dist, and a
// stale build fails silently). Real browser, real typing, the daemon from the
// Tier-2 harness (credentials forced empty → MockSession).

const TOKEN = "e2e-token-9c2f";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

let d: Daemon;
let browser: Browser;
let page: Page; // carries the auth cookie across tests, like a real tab
let base: string;

before(async () => {
  d = await startDaemon({ GENUI_TOKEN: TOKEN });
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
  assert.ok(cookies.some((c) => c.name === "genui_token" && c.value === TOKEN));
  assert.equal(await page.locator(".fleet-title").textContent(), "genui-shell");
});

test("onboarding → a full mock turn renders in the DOM", async () => {
  // An empty registry opens straight into "choose your agent".
  // R.4b: every credential-less row carries its one-line fix on the picker
  // itself (the harness forces all three agents credential-less).
  await page.waitForSelector(".onb-agent-hint");
  assert.equal(await page.locator(".onb-agent-hint").count(), 3);
  const claudeRow = page.locator(".onb-agent", { hasText: "Claude Code" });
  assert.match(await claudeRow.innerText(), /ANTHROPIC_API_KEY|`claude`/);
  assert.match(
    await page.locator(".onb-agent", { hasText: "Codex" }).innerText(),
    /codex login/,
  );

  await claudeRow.click();
  await page.waitForURL(/\/s\/[\w-]+/);

  // R.4b: the shell-drawn demo banner is up before anything else paints — a
  // mock session is unmistakably labeled, with the concrete fix named.
  await page.waitForSelector(".demo-banner");
  const banner = await page.locator(".demo-banner").innerText();
  assert.match(banner, /demo/i);
  assert.match(banner, /no real agent/);
  assert.match(banner, /ANTHROPIC_API_KEY|`claude`/);

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

test("a demo turn shows tokens but never a fabricated dollar cost (R.4b)", async () => {
  // The checklist hook emits no usage — run a template turn, which does.
  await page.locator("textarea").click();
  await page.keyboard.type("hello there");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".sb-usage", { timeout: 30_000 });
  const bar = await page.locator(".status-bar").innerText();
  assert.ok(!bar.includes("$"), `status bar shows a dollar cost in a demo session: ${bar}`);
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
