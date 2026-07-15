import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";

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
  assert.match(
    await page.locator(".onb-agent", { hasText: "Codex" }).innerText(),
    /codex login/,
  );
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

test("R.4k: a local-endpoint daemon shows the endpoint on the picker row", async () => {
  // Point Claude Code at a local endpoint (ANTHROPIC_BASE_URL) → kind `local`,
  // live, and the picker must show the endpoint so the local-model user sees
  // their setup was picked up (not a bare "ready"). The URL need not resolve —
  // we only read onboarding, never drive a turn.
  const token = "e2e-local-9c2f";
  const d2 = await startDaemon({ MIRAFOLD_TOKEN: token, ANTHROPIC_BASE_URL: "http://localhost:11434" });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
    const claudeRow = page2.locator(".onb-agent", { hasText: "Claude Code" });
    await claudeRow.waitFor();
    assert.match(await claudeRow.locator(".onb-agent-status").innerText(), /ready/);
    const detail = await claudeRow.locator(".onb-agent-detail").innerText();
    assert.match(detail, /local endpoint/);
    assert.match(detail, /localhost:11434/);
  } finally {
    await page2.close();
    await d2.stop();
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

test("theme is a segmented sun|moon switch; home is the far-right control", async () => {
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
  // Home (⌂ → mission control) sits at the status bar's far right.
  assert.match(
    (await page.locator(".status-bar > *:last-child").getAttribute("class")) ?? "",
    /sb-home/,
  );
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
