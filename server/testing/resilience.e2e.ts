import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { launchChrome } from "./e2e-harness";

// The two "the app lies quietly" behaviors, exercised for real — a
// daemon killed mid-turn must not leave the ■ esc working state up, and a
// restarted daemon must SAY it swapped the gone session for a fresh one
// instead of silently rewriting the URL over a blank transcript (R.4c).

let d: Daemon;
let browser: Browser;
let page: Page;

before(async () => {
  d = await startDaemon({ MIRAFOLD_TOKEN: "" });
  browser = await launchChrome();
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
  await d?.stop();
});

test("mid-turn daemon death clears the working state; restart shows the notice", async () => {
  await page.goto(`http://127.0.0.1:${d.port}/`);
  await page.locator(".onb-agent", { hasText: "Claude Code" }).click();
  await page.waitForURL(/\/s\/[\w-]+/);
  const oldUrl = page.url();

  // Start a turn; the ■ esc stop affordance appears with the working state.
  await page.locator("textarea").click();
  await page.keyboard.type("hello resilience");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".stop-btn", { timeout: 15_000 });

  // Kill the daemon mid-turn: the stop affordance must clear — a dead daemon
  // must not look like an agent still thinking.
  const port = d.port;
  await d.stop();
  await page.waitForSelector(".stop-btn", { state: "detached", timeout: 10_000 });

  // Restart on the same port. The client reconnects, asks for the old id,
  // and must be TOLD it got a fresh session: notice up, URL moved on.
  d = await startDaemon({ MIRAFOLD_TOKEN: "", PORT: String(port) });
  assert.equal(d.port, port, "restart re-bound a different port; test cannot proceed");
  await page.waitForSelector(".session-notice", { timeout: 30_000 });
  const notice = await page.locator(".session-notice").innerText();
  assert.match(notice, /session ended/);
  assert.match(notice, /new one/);
  assert.notEqual(page.url(), oldUrl);

  // Dismiss clears it (a first prompt into the new session would too).
  await page.locator(".session-notice-dismiss").click();
  await page.waitForSelector(".session-notice", { state: "detached", timeout: 5_000 });
});
