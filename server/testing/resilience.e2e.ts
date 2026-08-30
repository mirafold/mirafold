import { test, before, after } from "node:test";
import { MOCK_PROMPTS } from "./mock-prompts";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** True once any checkpointed session buffer holds a parented text_delta. */
async function waitForStoredNarration(dir: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const stored = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .some((f) => {
        try {
          const session = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
            buffer?: { type?: string; parentId?: string }[];
          };
          return (session.buffer ?? []).some((m) => m.type === "text_delta" && m.parentId);
        } catch {
          return false; // a checkpoint write raced the read — poll again
        }
      });
    if (stored) return;
    if (Date.now() > deadline) throw new Error("narration never reached the checkpoint store");
    await new Promise((r) => setTimeout(r, 100));
  }
}
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
  await page.locator(".agent-picker-agent", { hasText: "Claude Code" }).click();
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

test("subagent narration survives a mid-turn reconnect replay (bughunt 2026-08-14 r2)", async () => {
  // A fresh session in the same durable store (?new=1 — the registry is not
  // empty, so bare / would reopen the first test's session); the slow hook
  // opens a subagent prose run and then idles for seconds — the
  // deterministic window in which the transcript is reset mid-turn.
  await page.goto(`http://127.0.0.1:${d.port}/?new=1`);
  await page.locator(".agent-picker-agent", { hasText: "Claude Code" }).click();
  await page.waitForURL(/\/s\/[\w-]+/);
  await page.locator("textarea").click();
  await page.keyboard.type(MOCK_PROMPTS["slow-subagent"]);
  await page.keyboard.press("Enter");
  // The deck is up and its narration has streamed (spawn at 300ms, prose at
  // 700ms, first tool not until 9s) — the subtext run is open NOW.
  await page.waitForSelector(".subagent-deck", { timeout: 15_000 });
  await page.locator(".subagent-deck-head").click();
  await page.waitForSelector("text=Surveying the workspace layout", { timeout: 10_000 });

  // The narration must be DURABLE before the kill: interior frames ride a
  // 250ms checkpoint debounce, and killing inside it loses the tail server-
  // side (an honest, pre-existing bound — the turn is marked interrupted).
  // Poll the store until the parented delta is on disk, so this test always
  // exercises the CLIENT's replay path, never the debounce race.
  await waitForStoredNarration(sessionDir);

  // Kill and restart the daemon inside the window: the client reattaches to
  // the same page (no reload), gets zone_reset, and replays the checkpoint.
  // A stale open-subtext key would swallow the replayed narration into an
  // entry id that no longer exists — the deck would come back empty-handed.
  const port = d.port;
  await d.stop();
  d = await startDaemon({
    MIRAFOLD_TOKEN: "",
    MIRAFOLD_SESSION_DIR: sessionDir,
    PORT: String(port),
  });
  assert.equal(d.port, port, "restart re-bound a different port; test cannot proceed");
  await page.locator(".notice-line", { hasText: "turn was interrupted" }).waitFor({ timeout: 30_000 });

  // The replayed deck still holds the subagent's words.
  await page.waitForSelector(".subagent-deck", { timeout: 10_000 });
  await page.locator(".subagent-deck-head").click();
  await page.waitForSelector("text=Surveying the workspace layout", { timeout: 10_000 });
});
