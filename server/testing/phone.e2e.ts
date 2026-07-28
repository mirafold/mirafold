import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { launchChrome, noSideScroll } from "./e2e-harness";
import { startRelayStub, type RelayStub } from "../relay/relay-stub";

// R.4, the locally-verifiable slice: a phone-sized browser pairs through the
// relay stub, drives a full session comfortably (prompt → stream → rendered
// component, a permission answered by thumb), never scrolls sideways, and
// survives a network flip mid-turn without losing the transcript (the 4.4
// seq-resume machinery over the relay path). The QR affordance is verified on
// the local page — the phone-scans-it half is the real-device launch check.

const CODE = "e2e-phone-pairing-3c9df2";

let stub: RelayStub;
let d: Daemon;
let browser: Browser;
let desktop: Page;
let phoneCtx: BrowserContext;
let phone: Page;
/** The desktop's session id, captured by the QR test — the phone pairs into it. */
let sessionId: string;

// The phone's one submit gesture (Enter is a newline there — see below).
const sendPrompt = async (p: Page, text: string) => {
  await p.locator("textarea").tap();
  await p.keyboard.type(text);
  await p.locator(".prompt-send").tap();
};

before(async () => {
  stub = await startRelayStub();
  d = await startDaemon({ MIRAFOLD_TOKEN: "", MIRAFOLD_RELAY_URL: stub.url, MIRAFOLD_RELAY_CODE: CODE });
  browser = await launchChrome();
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
  sessionId = new URL(desktop.url()).pathname.match(/^\/s\/([\w-]+)/)![1];
  await desktop.locator(".status-bar .sb-pair").click();
  await desktop.waitForSelector(".pair-card");
  assert.ok(await desktop.locator(".pair-qr path").count(), "QR modules rendered");
  // In-session pairing encodes the session beside the code (`&s=<id>`) so the
  // scanned phone lands IN this session, not on the fleet list.
  const url = await desktop.locator(".pair-url").textContent();
  assert.equal(url, `http://127.0.0.1:${stub.port}/#code=${CODE}&s=${sessionId}`);
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
  // The paired link (the QR's URL, session hint and all) lands straight IN the
  // session it was made from — the transcript view, never the fleet list.
  await phone.goto(`http://127.0.0.1:${stub.port}/#code=${CODE}&s=${sessionId}`);
  await phone.waitForURL(new RegExp(`/s/${sessionId}$`));
  assert.equal(await phone.locator(".fleet-row").count(), 0, "landed on the fleet list");
  await phone.waitForSelector(".prompt-box textarea");
  await noSideScroll(phone);

  // R.4l (Kyle 2026-07-22, "nail this down for sure"): on phone, Enter
  // NEVER submits — it inserts a newline; the ↑ button is the one way to
  // send. This assertion exists so a future regression to desktop
  // Enter-to-send behavior on phone fails loudly here.
  await phone.locator("textarea").tap();
  await phone.keyboard.type("line one");
  await phone.keyboard.press("Enter");
  await phone.keyboard.type("line two");
  assert.equal(
    await phone.locator("textarea").inputValue(),
    "line one\nline two",
    "Enter on phone must insert a newline, never submit",
  );
  assert.equal(
    await phone.locator(".turn-user").count(),
    0,
    "Enter on phone submitted a prompt — it must never",
  );

  await phone.locator("textarea").fill("");
  await sendPrompt(phone, "plan it step by step");
  await phone.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
  // The live checklist is a rendered registry component — generative UI on
  // the phone, through the encrypted relay path.
  assert.ok(await phone.locator("text=Verify end to end").count());
  await noSideScroll(phone);

  // R.4l: the status bar is ONE row of thumb-sized targets — a wrapped
  // stray control is the "haphazard" look this pass removed. (No .sb-pair
  // here: pairing info rides to local viewports only. No .sb-theme: the
  // pill is desktop-only; the settings gear carries theme on phone.)
  const controls = await phone.evaluate(() =>
    [".sb-home", ".sb-new", ".sb-settings", ".sb-end"]
      .map((s) => document.querySelector(`.status-bar ${s}`))
      .filter((el): el is Element => el !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), height: Math.round(r.height) };
      }),
  );
  assert.ok(controls.length >= 4, "status-bar controls missing");
  assert.equal(
    new Set(controls.map((c) => c.top)).size,
    1,
    `controls wrapped across rows: ${JSON.stringify(controls)}`,
  );
  for (const c of controls) assert.ok(c.height >= 40, `control is ${c.height}px — too small to tap`);

  // The agent name rides the same single row, beside the dot; the facts
  // row is gone on phone (model/folder live on the fleet rows instead).
  // (no inner `const fn = …` here — tsx's keepNames wraps those in a __name
  // helper that doesn't exist inside page.evaluate)
  const rowCheck = await phone.evaluate(() => {
    const agent = document.querySelector(".status-bar .sb-agent")?.getBoundingClientRect();
    const home = document.querySelector(".status-bar .sb-home")?.getBoundingClientRect();
    return {
      agentOffset:
        agent && home
          ? Math.abs(agent.top + agent.height / 2 - (home.top + home.height / 2))
          : NaN,
      factsHidden: [".sb-model", ".sb-cwd", ".sb-usage", ".sb-theme"].every((s) => {
        const el = document.querySelector(`.status-bar ${s}`);
        return !el || getComputedStyle(el).display === "none";
      }),
    };
  });
  assert.ok(rowCheck.agentOffset < 12, "agent name is not on the control row");
  assert.ok(rowCheck.factsHidden, "facts/pill still visible on phone");

  // R.4l: the prompt crumb is desktop-only — on phone the folder (and the
  // rest of the session's facts) lives in the settings card's Session
  // section, opened by tapping the agent chip.
  assert.equal(await phone.locator(".prompt-cwd").count(), 0, "cwd crumb rendered on phone");
  await phone.locator(".sb-agent").tap();
  await phone.waitForSelector(".settings-card");
  const folderRow = await phone
    .locator(".settings-kv-row", { hasText: "folder" })
    .locator("dd")
    .textContent();
  assert.ok(folderRow && folderRow.includes("/"), `folder fact missing from card: ${folderRow}`);
  await phone.keyboard.press("Escape");
  assert.equal(await phone.locator(".settings-card").count(), 0, "Esc closes the card");

  // R.4l: every focusable input is ≥16px — below that iOS zooms the page on
  // focus and leaves it zoomed, which reads as "the page pans sideways".
  const promptFont = await phone.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector(".prompt-box textarea")!).fontSize),
  );
  assert.ok(promptFont >= 16, `prompt textarea is ${promptFont}px — iOS will zoom on focus`);
});

test("phone (E.4): the files panel is a full-screen drill-in — tree → file → back → Esc, no side-scroll", async () => {
  // On phone the rail is gone entirely (a permanent strip is too much of a
  // 390px screen, 2026-07-25) — the toggle lives in the status bar instead,
  // boxed off at its far left.
  assert.equal(
    await phone.locator(".activity-bar").evaluate((el) => getComputedStyle(el).display),
    "none",
    "the activity bar must be hidden on phone",
  );
  // Open from the status-bar affordance — a full-screen dialog layer, not the
  // desktop docked column. Activated by keyboard (focus + Enter) rather than
  // tap: focus-return-on-close is an A.3 KEYBOARD contract, and a touch tap
  // doesn't move DOM focus to the button, so only the keyboard path has a
  // meaningful opener to return to.
  await phone.locator(".sb-files").focus();
  await phone.keyboard.press("Enter");
  await phone.waitForSelector(".files-panel[role=dialog]");
  await noSideScroll(phone);
  const width = await phone.evaluate(() => {
    const el = document.querySelector(".files-panel");
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  assert.ok(width >= 380, `panel is ${width}px wide — not full-screen`);

  // The tree is live git data (the daemon runs in the repo) — drill into a file.
  const pkg = phone.locator(".files-file-row", { hasText: "package.json" }).first();
  await pkg.waitFor({ timeout: 15_000 });
  await pkg.tap();
  await phone.waitForSelector(".files-view .fv-content");
  await noSideScroll(phone);

  // Esc drills BACK one layer (to the tree), never straight out — the
  // stacked-layer contract; the panel stays open.
  await phone.keyboard.press("Escape");
  await phone.waitForSelector(".files-tree");
  assert.equal(
    await phone.locator(".files-file").count(),
    0,
    "Esc from a file must return to the tree, not close the panel",
  );
  assert.equal(await phone.locator(".files-panel").count(), 1, "the panel is still open");

  // Esc from the tree closes the panel, and focus returns to the opener.
  await phone.keyboard.press("Escape");
  assert.equal(await phone.locator(".files-panel").count(), 0, "Esc from the tree closes the panel");
  await noSideScroll(phone);
  const focusedFiles = await phone.evaluate(
    () => document.activeElement?.classList.contains("sb-files") ?? false,
  );
  assert.ok(focusedFiles, "focus returned to the files toggle on close");
});

test("phone: a permission request is answerable by thumb", async () => {
  await sendPrompt(phone, "do something dangerous");
  await phone.waitForSelector(".perm-bar", { timeout: 15_000 });
  await noSideScroll(phone);
  const allow = phone.locator(".perm-allow");
  const box = (await allow.boundingBox())!;
  assert.ok(box.height >= 36, `allow button is ${box.height}px tall — too small to tap`);
  await allow.tap();
  await phone.waitForSelector("text=restarted cleanly", { timeout: 15_000 });
});

// The 2026-07-28 sync bug: an ask answered on one device left the other
// device's bar up until turn_end — and a tap on that stale bar was a silent
// no-op at the adapter (the phone "hangs"). The fix broadcasts
// permission_resolved the moment the ask resolves, so here the DESKTOP
// answers and the phone's bar must drop while the turn is still running —
// i.e. BEFORE this turn's "restarted cleanly" streams in (the count pins it
// to this turn; earlier tests already put one in the transcript).
test("phone: a permission answered on the desktop clears the phone's bar mid-turn", async () => {
  await desktop.goto(`http://127.0.0.1:${d.port}/s/${sessionId}`);
  await desktop.waitForSelector(".prompt-box textarea");
  const before = await phone.evaluate(
    () => document.body.innerText.split("restarted cleanly").length,
  );

  await sendPrompt(phone, "do something dangerous");
  await phone.waitForSelector(".perm-bar", { timeout: 15_000 });
  await desktop.waitForSelector(".perm-bar", { timeout: 15_000 });
  await desktop.locator(".perm-allow").click();

  await phone.waitForFunction(
    (n) =>
      !document.querySelector(".perm-bar") &&
      document.body.innerText.split("restarted cleanly").length === n,
    before,
    { timeout: 15_000 },
  );
  // …and the allowed turn then completes normally on the phone.
  await phone.waitForFunction(
    (n) => document.body.innerText.split("restarted cleanly").length > n,
    before,
    { timeout: 15_000 },
  );
});

test("phone: a network flip mid-turn resumes the stream without losing the transcript", async () => {
  // A marker node from BEFORE the blip: if resume repainted the zone, this
  // handle would be detached afterwards.
  const marker = await phone.waitForSelector(".turn-user");

  await sendPrompt(phone, "plan it step by step");
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

// The backgrounded-phone bug (2026-07-25, Kyle's phone): leave the browser for
// a few minutes, come back, and the session was dead — no transcript, Explorer
// disabled, no end button, prompts going nowhere — while the same session was
// fine on the desktop. Cause: the pairing code lived in per-tab sessionStorage,
// which a browser is free to drop when it discards a backgrounded tab; the
// rebuilt tab had no way to reach the daemon and no way to say so. Wiping
// sessionStorage and reloading is that discard, exactly.
test("phone: a discarded tab comes back paired — the session survives, transcript and all", async () => {
  const turnsBefore = await phone.locator(".turn-user").count();
  assert.ok(turnsBefore > 0, "no transcript to lose — earlier tests should have left turns");

  await phone.evaluate(() => sessionStorage.clear());
  await phone.reload();

  // Attached again: the end button only renders with a live session, and the
  // Explorer toggle is disabled without one.
  await phone.waitForSelector(".sb-end", { timeout: 20_000 });
  assert.equal(
    await phone.locator(".sb-files").isDisabled(),
    false,
    "Explorer still disabled — the viewport never attached",
  );
  await phone.waitForFunction(
    (n) => document.querySelectorAll(".turn-user").length >= n,
    turnsBefore,
    { timeout: 20_000 },
  );
  assert.match(phone.url(), /\/s\/[\w-]+/, "should still be in the session it was in");
});
