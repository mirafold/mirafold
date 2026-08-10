import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { launchChrome } from "./e2e-harness";

// The two "the app lies quietly" behaviors, exercised for real — a daemon
// killed mid-turn must not leave the ■ esc working state up, and a restarted
// daemon must reopen the saved session at the same URL, preserving the prompt
// while saying that the interrupted turn itself did not finish.

let d: Daemon;
let browser: Browser;
let page: Page;
const sessionDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-resilience-e2e-"));

before(async () => {
  d = await startDaemon({ MIRAFOLD_TOKEN: "", MIRAFOLD_SESSION_DIR: sessionDir });
  browser = await launchChrome();
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
  await d?.stop();
});

test("mid-turn daemon death clears working state; restart reopens the saved session", async () => {
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

  // Restart on the same port and durable store. The client reconnects to the
  // old id; the URL and prompt remain, and Mirafold closes the interrupted
  // browser turn explicitly before the provider conversation continues.
  d = await startDaemon({
    MIRAFOLD_TOKEN: "",
    MIRAFOLD_SESSION_DIR: sessionDir,
    PORT: String(port),
  });
  assert.equal(d.port, port, "restart re-bound a different port; test cannot proceed");
  const interrupted = page.locator(".notice-line", { hasText: "turn was interrupted" });
  await interrupted.waitFor({ timeout: 30_000 });
  assert.equal(page.url(), oldUrl);
  assert.equal(await page.locator(".turn-user", { hasText: "hello resilience" }).count(), 1);
  assert.equal(await page.locator(".session-notice").count(), 0, "fell back to a blank session");
});
