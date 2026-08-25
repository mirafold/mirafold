import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { assertAxeClean, launchChrome, noSideScroll } from "./e2e-harness";

// Phase M (M.3), Tier-3: the cockpit — mission control's enriched rows and
// grid acts, driven in a real browser against the real daemon (mock-forced).
// Two tabs throughout: a session tab (the acted-on session's transcript is
// the proof an act really landed) and the fleet tab (the cockpit under test).

let d: Daemon;
let browser: Browser;
let session: Page; // the first session's transcript tab
let fleet: Page; // mission control
let sessionId: string;
let base: string;

before(async () => {
  d = await startDaemon({ SESSION_IDLE_TIMEOUT_MS: "300000" });
  base = `http://127.0.0.1:${d.port}`;
  browser = await launchChrome();

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

/** The fleet-wide idle oracle: every row idle, nothing mid-turn. The dot is
 *  the row's one status surface (the status word came off, 2026-07-25). */
async function allIdle(rows: number) {
  await fleet.waitForFunction(
    (n) => document.querySelectorAll(".fleet-dot-idle").length === n,
    rows,
    { timeout: 30_000 },
  );
}

test("the ▾ details line shows live activity while a turn works, then honest idle text", async () => {
  // Activity lives behind the per-row disclosure now (2026-07-24, Kyle) —
  // the bar itself stays a stable glance set.
  await fleet.locator(".fleet-details-toggle").first().click();
  await say(session, "give me a quick overview");
  await fleet.waitForFunction(
    // The tool gear is a drawing now, not a character, so the label may carry
    // no glyph in textContent at all — assert the line's shape instead.
    () => /\S.* · \d+[smh]/u.test(document.querySelector(".fleet-details-activity")?.textContent ?? ""),
    undefined,
    { timeout: 15_000 },
  );
  // Activity clears when the turn ends — the open line stays honest at idle.
  await fleet.waitForFunction(
    () => document.querySelector(".fleet-details-activity")?.textContent === "nothing running",
    undefined,
    { timeout: 30_000 },
  );
  await allIdle(1);
});

test("session usage lands on the details line after the turn (tokens, no invented cost)", async () => {
  // The details line is still open from the previous test — live-updating.
  const usage = await fleet.waitForSelector(".fleet-details-usage", { timeout: 15_000 });
  const text = (await usage.innerText()) ?? "";
  assert.match(text, /tok/, "token total on the line");
  assert.ok(!text.includes("$"), "the mock reports no cost — none shown");
  // Close it: the toggle is one-at-a-time state the later tests shouldn't inherit.
  await fleet.locator(".fleet-details-toggle").first().click();
  await fleet.waitForSelector(".fleet-details", { state: "detached", timeout: 5_000 });
});

test("needs-you: the row names WHAT it wants; allow from the grid runs the tool; axe-clean", async () => {
  await say(session, "do something dangerous");
  await fleet.waitForSelector(".fleet-perm", { timeout: 15_000 });
  const detail = await fleet.locator(".fleet-permission-detail").innerText();
  assert.match(detail, /Bash/);
  assert.match(detail, /rm -rf/);
  // The dot carries the state (title for sighted hover, sr-only text for
  // screen readers — the visible status word is gone, 2026-07-25).
  assert.equal(await fleet.locator(".fleet-dot-permission").count(), 1);
  assert.equal(
    await fleet.locator(".fleet-row .sr-only").first().innerText(),
    "needs you",
  );

  // The C.2 discipline: the cockpit's new surface scans clean WITH the
  // permission line (its most content-rich state) on screen.
  await assertAxeClean(fleet, "cockpit with a pending permission");

  await fleet.locator(".fleet-permission-allow").click();
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
  await fleet.locator(".fleet-permission-deny").click();
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
  await fleet.waitForSelector(".fleet-dot-working", { timeout: 15_000 });
  assert.equal(await firstRowId(), sessionId, "rows hold their place while one works");
  await allIdle(2);

  // A permission hold DOES surface — the top group is the act-here zone.
  await say(second, "do something dangerous");
  await fleet.waitForSelector(".fleet-perm", { timeout: 15_000 });
  assert.equal(await firstRowId(), secondId, "needs-you jumps to the top group");

  await fleet.locator(".fleet-permission-deny").click();
  await fleet.waitForSelector(".fleet-perm", { state: "detached", timeout: 15_000 });
  await allIdle(2);
  assert.equal(await firstRowId(), sessionId, "answered → back to creation order");
  await second.close();
});

test("M.5: the fleet tab itself signals needs-you (title count), and rows show viewport counts", async () => {
  // Viewport counts: session 1 has its transcript tab open → ⧉ 1.
  assert.match(
    await fleet.locator(".fleet-item").first().locator(".fleet-viewports").innerText(),
    /⧉ \d+/,
  );
  assert.equal(await fleet.title(), "Mirafold — sessions");

  await say(session, "do something dangerous");
  await fleet.waitForSelector(".fleet-perm", { timeout: 15_000 });
  // The title rides a React effect (post-paint) — poll, don't sample.
  await fleet.waitForFunction(() => document.title === "⚠ 1 needs you — Mirafold", undefined, {
    timeout: 5_000,
  });

  await fleet.locator(".fleet-permission-deny").click();
  await fleet.waitForSelector(".fleet-perm", { state: "detached", timeout: 15_000 });
  await allIdle(2);
  await fleet.waitForFunction(() => document.title === "Mirafold — sessions", undefined, {
    timeout: 5_000,
  });
});

// ---- M.4: phone width — the same cockpit, folded clean and thumb-sized ----

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
  // Details by thumb: the ▾ disclosure works on phone, and the opened line
  // (activity + usage at their richest) doesn't introduce side-scroll.
  await phone.locator(".fleet-details-toggle").first().tap();
  await phone.waitForSelector(".fleet-details", { timeout: 5_000 });
  assert.ok(await phone.locator(".fleet-details-usage").count(), "usage reachable on phone");
  await noSideScroll(phone);

  // Thumb targets: the answer pair is ≥40px tall (the R.4l standard).
  for (const sel of [".fleet-permission-allow", ".fleet-permission-deny"]) {
    const box = await phone.locator(sel).boundingBox();
    assert.ok(box && box.height >= 40, `${sel} is ${box?.height ?? 0}px tall — needs ≥40`);
  }
  await assertAxeClean(phone, "phone cockpit with a pending permission");

  // Deny by thumb; the hold clears everywhere.
  await phone.locator(".fleet-permission-deny").tap();
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

// The lingering-count fix (2026-07-24): leaving a session by real navigation
// (the ⌂ home link) must detach its viewport at once — the client's pagehide
// clean close — not 30–60s later when the server heartbeat finally reaps a
// half-open socket. Runs LAST: it navigates the shared session tab away.
test("home navigation drops the row's viewport count immediately", async () => {
  const row = fleet.locator(".fleet-item", { hasText: sessionId });
  assert.equal((await row.locator(".fleet-viewports").innerText()).trim(), "⧉ 1");

  await session.locator(".sb-home").click();
  await session.waitForURL(`${base}/`);
  // Far under the 30s heartbeat: reaching 0 this fast proves the clean close.
  await fleet.waitForFunction(
    (id) =>
      [...document.querySelectorAll(".fleet-item")]
        .find((r) => r.textContent?.includes(id))
        ?.querySelector(".fleet-viewports")
        ?.textContent?.trim() === "⧉ 0",
    sessionId,
    { timeout: 5_000 },
  );
});
