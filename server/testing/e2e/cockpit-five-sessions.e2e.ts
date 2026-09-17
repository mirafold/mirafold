import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startDaemon, type Daemon } from "../itest-harness";
import { MOCK_PROMPTS } from "../fixtures/mock-prompts";
import { enterMockSession, launchChrome, typePrompt, waitTurnIdle } from "./e2e-harness";

// Phase CPERF, Tier 3: the user-visible shape of the checkpoint bottleneck —
// five sessions all producing output, one user switching through them from
// the in-session cockpit and typing into each destination — against the
// real daemon and real Chrome. Every session keeps its own tab open (an
// attached viewport, like a user with five tabs), so all five stay
// streaming to a browser while the driver tab moves. The measurements are
// printed for the before/after record; the assertions are functional (the
// switch completes, the destination answers, every checkpoint lands) —
// no timing SLA lives here.

const SESSIONS = 5;
let daemon: Daemon;
let browser: Browser;
let context: BrowserContext;
let pages: Page[];
let ids: string[];
let base: string;
let sessionDir: string;

const sessionId = (page: Page) => new URL(page.url()).pathname.split("/").pop()!;
const row = (page: Page, id: string) => page.locator(`.cockpit-item[data-session-id="${id}"]`);

before(async () => {
  sessionDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-five-sessions-"));
  daemon = await startDaemon({ SESSION_IDLE_TIMEOUT_MS: "300000", MIRAFOLD_SESSION_DIR: sessionDir });
  base = `http://127.0.0.1:${daemon.port}`;
  browser = await launchChrome();
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  pages = [];
  ids = [];
  for (let i = 0; i < SESSIONS; i++) {
    const page = await context.newPage();
    await page.goto(`${base}/${i === 0 ? "" : "?new=1"}`);
    await enterMockSession(page);
    pages.push(page);
    ids.push(sessionId(page));
  }
  assert.equal(new Set(ids).size, SESSIONS);
});

after(async () => {
  await context?.close();
  await browser?.close();
  await daemon?.stop();
});

test("CPERF.5: switching through five streaming sessions from the cockpit, typing into each destination", async () => {
  // Every session starts a long scripted turn (~10 s of subagent activity)
  // with a per-session marker in its own prompt echo.
  for (let i = 0; i < SESSIONS; i++) {
    await typePrompt(pages[i], `${MOCK_PROMPTS["slow-subagent"]} #${i + 1}`);
  }

  const driver = pages[0];
  await driver.locator(".ab-cockpit").click();
  await driver.locator(".cockpit-panel").waitFor();
  await driver.waitForFunction((n) => document.querySelectorAll(".cockpit-item").length === n, SESSIONS);

  const timings: { to: string; readyMs: number; replyMs: number }[] = [];
  // Through every other session and back to the first: five switches.
  const route = [...ids.slice(1), ids[0]];
  for (const [step, id] of route.entries()) {
    const marker = `#${ids.indexOf(id) + 1}`;
    const clickedAt = Date.now();
    await row(driver, id).locator(".cockpit-session-name").click();
    // "Ready" is the destination's own transcript (its prompt echo) on
    // screen with a usable prompt box — not the URL flip.
    await driver.waitForURL(`${base}/s/${id}`);
    await driver.locator(".turn-user", { hasText: marker }).first().waitFor({ timeout: 15_000 });
    await driver.locator(".prompt-box textarea:not([disabled])").waitFor({ timeout: 15_000 });
    const readyMs = Date.now() - clickedAt;

    const note = `note from the cockpit switch ${step + 1}`;
    const repliesBefore = await driver.locator(".turn-assistant").count();
    const typedAt = Date.now();
    await typePrompt(driver, note);
    await driver.waitForFunction((n) => document.querySelectorAll(".turn-assistant").length > n, repliesBefore, {
      timeout: 30_000,
    });
    timings.push({ to: id, readyMs, replyMs: Date.now() - typedAt });
    await driver.locator(".cockpit-panel").waitFor();
  }
  console.log(
    `cockpit switches under five streaming sessions:\n` +
      timings.map((t) => `  → ${t.to}  ready ${t.readyMs} ms  reply ${t.replyMs} ms`).join("\n"),
  );

  // Every session finished its work in its own tab, and every session
  // checkpointed: five records, no temp file left behind.
  for (const [i, page] of pages.entries()) {
    if (page === driver) continue;
    await waitTurnIdle(page, `session ${ids[i]} settles`, 40_000, daemon.logs);
  }
  await waitTurnIdle(driver, "the driver's final destination settles", 40_000, daemon.logs);
  await driver.waitForFunction(
    (n) => document.querySelectorAll(".turn-user").length >= n,
    2,
    { timeout: 5_000 },
  );
  const files = readdirSync(sessionDir);
  assert.deepEqual(
    ids.filter((id) => !files.includes(`${id}.json`)),
    [],
    `every session has a checkpoint; found ${files.join(", ")}`,
  );
  assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "no incomplete temp file remains");
});
