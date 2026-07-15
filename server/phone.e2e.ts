import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { startRelayStub, type RelayStub } from "./relay/relay-stub";

// R.4, the locally-verifiable slice: a phone-sized browser pairs through the
// relay stub, drives a full session comfortably (prompt → stream → rendered
// component, a permission answered by thumb), never scrolls sideways, and
// survives a network flip mid-turn without losing the transcript (the 4.4
// seq-resume machinery over the relay path). The QR affordance is verified on
// the local page — the phone-scans-it half is the real-device launch check.

const CODE = "e2e-phone-pairing-3c9df2";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

let stub: RelayStub;
let d: Daemon;
let browser: Browser;
let desktop: Page;
let phoneCtx: BrowserContext;
let phone: Page;

const noSideScroll = async (p: Page) => {
  const over = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(over <= 1, `page scrolls sideways by ${over}px`);
};

before(async () => {
  stub = await startRelayStub();
  d = await startDaemon({ MIRAFOLD_TOKEN: "", MIRAFOLD_RELAY_URL: stub.url, MIRAFOLD_RELAY_CODE: CODE });
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  await browser?.close();
  await d?.stop();
  await stub?.stop();
});

test("desktop: the shell-owned pair affordance shows the QR of the pairing URL", async () => {
  desktop = await browser.newPage();
  await desktop.goto(`http://127.0.0.1:${d.port}/`);
  // An empty fleet auto-opens onboarding — seed the session first, then the
  // pair affordance is testable in the session's status bar…
  await desktop.locator(".onb-agent", { hasText: "Claude Code" }).click();
  await desktop.waitForURL(/\/s\/[\w-]+/);
  await desktop.locator(".status-bar .sb-pair").click();
  await desktop.waitForSelector(".pair-card");
  assert.ok(await desktop.locator(".pair-qr path").count(), "QR modules rendered");
  const url = await desktop.locator(".pair-url").textContent();
  assert.equal(url, `http://127.0.0.1:${stub.port}/#code=${CODE}`);
  await desktop.keyboard.press("Escape");
  assert.equal(await desktop.locator(".pair-card").count(), 0, "Esc closes the overlay");

  // …and in the fleet header on the way back.
  await desktop.goto(`http://127.0.0.1:${d.port}/`);
  assert.ok(await desktop.locator(".fleet-head .sb-pair").count(), "pair button on the fleet page");
});

test("phone: pairs by URL, opens the session, drives a turn with a rendered component", async () => {
  phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  phone = await phoneCtx.newPage();
  await phone.goto(`http://127.0.0.1:${stub.port}/#code=${CODE}`);
  await noSideScroll(phone);
  await phone.locator(".fleet-row").first().tap();
  await phone.waitForURL(/\/s\/[\w-]+/);

  await phone.locator("textarea").tap();
  await phone.keyboard.type("plan it step by step");
  await phone.keyboard.press("Enter");
  await phone.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
  // The live checklist is a rendered registry component — generative UI on
  // the phone, through the encrypted relay path.
  assert.ok(await phone.locator("text=Verify end to end").count());
  await noSideScroll(phone);
});

test("phone: a permission request is answerable by thumb", async () => {
  await phone.locator("textarea").tap();
  await phone.keyboard.type("do something dangerous");
  await phone.keyboard.press("Enter");
  await phone.waitForSelector(".perm-bar", { timeout: 15_000 });
  await noSideScroll(phone);
  const allow = phone.locator(".perm-allow");
  const box = (await allow.boundingBox())!;
  assert.ok(box.height >= 36, `allow button is ${box.height}px tall — too small to tap`);
  await allow.tap();
  await phone.waitForSelector("text=restarted cleanly", { timeout: 15_000 });
});

test("phone: a network flip mid-turn resumes the stream without losing the transcript", async () => {
  // A marker node from BEFORE the blip: if resume repainted the zone, this
  // handle would be detached afterwards.
  const marker = await phone.waitForSelector(".turn-user");

  await phone.locator("textarea").tap();
  await phone.keyboard.type("plan it step by step");
  await phone.keyboard.press("Enter");
  await phone.waitForSelector("text=Read the current implementation", { timeout: 15_000 });

  await phoneCtx.setOffline(true); // wifi drops mid-turn…
  await new Promise((r) => setTimeout(r, 1_500));
  await phoneCtx.setOffline(false); // …LTE picks up

  // The turn (which kept running server-side) completes on screen, twice
  // over now in the transcript, and the pre-blip node survived — a tail
  // resume, not a repaint.
  await phone.waitForFunction(
    () => document.body.innerText.split("Plan complete — all four steps done.").length >= 3,
    { timeout: 30_000 },
  );
  assert.ok(await marker.evaluate((el) => el.isConnected), "pre-blip DOM node was repainted");
  await noSideScroll(phone);
});
