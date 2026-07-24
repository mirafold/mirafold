import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";
import { startDaemon, type Daemon } from "./itest-harness";

// Phase M (M.3), Tier-3: the cockpit — mission control's enriched rows and
// grid acts, driven in a real browser against the real daemon (mock-forced).
// Two tabs throughout: a session tab (the acted-on session's transcript is
// the proof an act really landed) and the fleet tab (the cockpit under test).

const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

let d: Daemon;
let browser: Browser;
let session: Page; // the first session's transcript tab
let fleet: Page; // mission control
let sessionId: string;
let base: string;

before(async () => {
  d = await startDaemon({ SESSION_IDLE_TIMEOUT_MS: "300000" });
  base = `http://127.0.0.1:${d.port}`;
  browser = await chromium.launch({ executablePath: CHROME });

  // First run: "/" opens straight into the picker; picking creates session 1.
  session = await browser.newPage();
  await session.goto(`${base}/`);
  await session.locator(".onb-agent", { hasText: "Claude Code" }).click();
  await session.waitForURL(/\/s\/[\w-]+/);
  sessionId = new URL(session.url()).pathname.split("/").pop()!;

  fleet = await browser.newPage();
  await fleet.goto(`${base}/`);
  await fleet.waitForSelector(".fleet-row");
});
after(async () => {
  await browser?.close();
  await d?.stop();
});

/** Type a prompt into a session tab's real prompt box. */
async function say(p: Page, text: string) {
  await p.locator("textarea").click();
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
}

/** The fleet-wide idle oracle: every row idle, nothing mid-turn. */
async function allIdle(rows: number) {
  await fleet.waitForFunction(
    (n) => document.querySelectorAll(".fleet-status-idle").length === n,
    rows,
    { timeout: 30_000 },
  );
}

test("the row shows live activity while a turn works, then clears to idle", async () => {
  await say(session, "give me a quick overview");
  const activity = await fleet.waitForSelector(".fleet-activity", { timeout: 15_000 });
  assert.match((await activity.innerText()) ?? "", /[✳⚙!] ?.* · \d+[smh]/u);
  // Activity clears when the turn ends — the row is honest at idle.
  await fleet.waitForSelector(".fleet-activity", { state: "detached", timeout: 30_000 });
  await allIdle(1);
});

test("session usage lands on the row after the turn (tokens, no invented cost)", async () => {
  const usage = await fleet.waitForSelector(".fleet-usage", { timeout: 15_000 });
  const text = (await usage.innerText()) ?? "";
  assert.match(text, /tok/, "token total on the row");
  assert.ok(!text.includes("$"), "the mock reports no cost — none shown");
});

test("needs-you: the row names WHAT it wants; allow from the grid runs the tool; axe-clean", async () => {
  await say(session, "do something dangerous");
  await fleet.waitForSelector(".fleet-perm", { timeout: 15_000 });
  const detail = await fleet.locator(".fleet-perm-detail").innerText();
  assert.match(detail, /Bash/);
  assert.match(detail, /rm -rf/);
  assert.equal(await fleet.locator(".fleet-status-permission").innerText(), "needs you");

  // The C.2 discipline: the cockpit's new surface scans clean WITH the
  // permission line (its most content-rich state) on screen.
  await assertAxeClean(fleet, "cockpit with a pending permission");

  await fleet.locator(".fleet-perm-allow").click();
  // The allowed tool really ran — observed in the session tab's transcript.
  await session.waitForSelector("text=Cache cleared and the service restarted", {
    timeout: 30_000,
  });
  await fleet.waitForSelector(".fleet-perm", { state: "detached", timeout: 15_000 });
  await allIdle(1);
});

test("deny from the grid: the command does not run", async () => {
  await say(session, "do something dangerous");
  await fleet.waitForSelector(".fleet-perm", { timeout: 15_000 });
  await fleet.locator(".fleet-perm-deny").click();
  await session.waitForSelector("text=I won't run that command", { timeout: 30_000 });
  await fleet.waitForSelector(".fleet-perm", { state: "detached", timeout: 15_000 });
  await allIdle(1);
});

test("the armed stop interrupts a working turn from the grid", async () => {
  await say(session, "tell me about this project");
  const stop = await fleet.waitForSelector(".fleet-stop", { timeout: 15_000 });
  await stop.click();
  assert.equal(await fleet.locator(".fleet-stop").innerText(), "stop?", "first click arms");
  await fleet.locator(".fleet-stop").click();
  // Interrupt = turn over, session warm: the stop control unmounts with the
  // working state, well before the mock turn's natural several-second run.
  await fleet.waitForSelector(".fleet-stop", { state: "detached", timeout: 10_000 });
  await allIdle(1);
});

test("quick prompt: a turn dispatched from the grid lands in the session", async () => {
  await fleet.locator(".fleet-prompt-toggle").click();
  await fleet.locator(".fleet-prompt-input").fill("quick hello from the cockpit");
  await fleet.keyboard.press("Enter");
  // The dispatched turn echoes as the session's command strip (server
  // broadcast — the same user_prompt every viewport paints).
  await session.waitForSelector("text=quick hello from the cockpit", { timeout: 15_000 });
  await fleet.waitForSelector(".fleet-prompt-input", { state: "detached" });
  await allIdle(1);
});

test("ordering: rows hold creation order while working; needs-you surfaces to the top", async () => {
  // Session 2 via the fleet's own picker path.
  const second = await browser.newPage();
  await second.goto(`${base}/?new=1`);
  await second.locator(".onb-agent", { hasText: "Claude Code" }).click();
  await second.waitForURL(/\/s\/[\w-]+/);
  const secondId = new URL(second.url()).pathname.split("/").pop()!;
  assert.notEqual(secondId, sessionId);

  const firstRowId = () => fleet.locator(".fleet-item").first().locator(".fleet-id").innerText();
  await fleet.waitForFunction(() => document.querySelectorAll(".fleet-item").length === 2);
  assert.equal(await firstRowId(), sessionId, "creation order: the older session leads");

  // A working turn must NOT reorder the grid (the recency sort is retired).
  await say(second, "summarize the repo");
  await fleet.waitForSelector(".fleet-activity", { timeout: 15_000 });
  assert.equal(await firstRowId(), sessionId, "rows hold their place while one works");
  await allIdle(2);

  // A permission hold DOES surface — the top group is the act-here zone.
  await say(second, "do something dangerous");
  await fleet.waitForSelector(".fleet-perm", { timeout: 15_000 });
  assert.equal(await firstRowId(), secondId, "needs-you jumps to the top group");

  await fleet.locator(".fleet-perm-deny").click();
  await fleet.waitForSelector(".fleet-perm", { state: "detached", timeout: 15_000 });
  await allIdle(2);
  assert.equal(await firstRowId(), sessionId, "answered → back to creation order");
  await second.close();
});

// ---- M.4: phone width — the same cockpit, folded clean and thumb-sized ----

const noSideScroll = async (p: Page) => {
  const over = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(over <= 1, `page scrolls sideways by ${over}px`);
};

test("phone: glance set visible with no side-scroll; permission and prompt act by thumb", async () => {
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const phone = await phoneCtx.newPage();
  await phone.goto(`${base}/`);
  await phone.waitForSelector(".fleet-row");

  // Park a permission hold on session 1 — with its usage from the earlier
  // turns, the row is at its richest: activity + permission + usage at once.
  await say(session, "do something dangerous");
  await phone.waitForSelector(".fleet-perm", { timeout: 15_000 });
  await phone.waitForSelector(".fleet-activity", { timeout: 15_000 });
  assert.ok(await phone.locator(".fleet-usage").count(), "usage stays visible on phone");
  await noSideScroll(phone);

  // Thumb targets: the answer pair is ≥40px tall (the R.4l standard).
  for (const sel of [".fleet-perm-allow", ".fleet-perm-deny"]) {
    const box = await phone.locator(sel).boundingBox();
    assert.ok(box && box.height >= 40, `${sel} is ${box?.height ?? 0}px tall — needs ≥40`);
  }
  await assertAxeClean(phone, "phone cockpit with a pending permission");

  // Deny by thumb; the hold clears everywhere.
  await phone.locator(".fleet-perm-deny").tap();
  await session.waitForSelector("text=I won't run that command", { timeout: 30_000 });
  await phone.waitForSelector(".fleet-perm", { state: "detached", timeout: 15_000 });
  await allIdle(2);

  // Quick prompt by thumb: the first row (creation order → session 1, the
  // tab we're watching) takes a dispatched turn; still no side pan.
  await phone.locator(".fleet-prompt-toggle").first().tap();
  await phone.locator(".fleet-prompt-input").fill("phone cockpit prompt");
  await phone.keyboard.press("Enter");
  await session.waitForSelector("text=phone cockpit prompt", { timeout: 15_000 });
  await noSideScroll(phone);
  await allIdle(2);
  await phoneCtx.close();
});

// ---- axe (copy of app.e2e.ts's assertAxeClean — a shared testing helper
// would force importing that whole suite, which would re-register its tests;
// dedupe when the helpers move to their own module) ------------------------

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const AXE_EXCEPTIONS: { rule: string; why: string }[] = [];

type AxeViolation = { id: string; impact: string; nodes: unknown[]; help: string };
type AxePage = { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: AxeViolation[] }> } };

async function assertAxeClean(p: Page, label: string): Promise<void> {
  // Settle animations to their end state first (the C.2 fleet-rise flake).
  await p.addStyleTag({
    content:
      "*, *::before, *::after { animation-duration: 0s !important; " +
      "animation-delay: 0s !important; transition-duration: 0s !important; }",
  });
  await p.addScriptTag({ content: axe.source });
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
