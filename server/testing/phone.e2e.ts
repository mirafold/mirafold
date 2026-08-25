import { test, before, after } from "node:test";
import { MOCK_PROMPTS } from "./mock-prompts";
import assert from "node:assert/strict";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { assertApartOnScreen, launchChrome, noSideScroll } from "./e2e-harness";
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

// Geometry is asserted at REST: the drawers slide in (02-explorer.css
// files-in, 03-changes.css changes-in) and a mid-transform boundingBox reads
// a sub-pixel short (39.9999 for a 40px button) — the 2026-08-18 flake.
const settled = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

// Esc walks the drawer out one layer at a time (file → tree → closed).
const closeDrawer = async (page: Page) => {
  for (let i = 0; i < 3 && (await page.locator(".files-panel, .changes-panel").count()) > 0; i += 1) {
    const layers = await page.locator(".files-panel [role=region], .files-panel, .changes-panel").count();
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (before) => document.querySelectorAll(".files-panel [role=region], .files-panel, .changes-panel").length < before,
      layers,
    );
  }
  await page.waitForSelector(".files-panel, .changes-panel", { state: "detached" });
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
  await sendPrompt(phone, MOCK_PROMPTS["checklist"]);
  // Mid-turn the phone shows the activity indicator too — the busy signal
  // rides the same bundle over the relay, not a desktop-only affordance
  // (2026-07-28).
  await phone.waitForSelector(".activity-line", { timeout: 15_000 });
  await phone.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
  // The live checklist is a rendered registry component — generative UI on
  // the phone, through the encrypted relay path.
  assert.ok(await phone.locator("text=Verify end to end").count());
  await noSideScroll(phone);

  // Desktop transcript clicks focus the prompt; a touch on the same inert
  // surface must not summon the phone keyboard.
  const transcript = phone.locator(".output-zone");
  await transcript.tap({ position: { x: 2, y: 2 } });
  assert.equal(
    await phone.evaluate(() => document.activeElement?.matches(".prompt-box textarea") ?? false),
    false,
    "touching the transcript focused the phone prompt",
  );

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

test("phone LD.3: the live document fills the canvas and survives the full-screen Explorer", async () => {
  const documentsBefore = await phone.locator(".response-document").count();
  await sendPrompt(phone, MOCK_PROMPTS["live-document"]);
  const firstDocument = phone.locator(".response-document").nth(documentsBefore);
  const secondDocument = phone.locator(".response-document").nth(documentsBefore + 1);
  await firstDocument.locator("h1", { hasText: "Live response" }).waitFor({ timeout: 15_000 });
  await secondDocument
    .locator(".turn-assistant", { hasText: "response finished as one live composition" })
    .waitFor({ timeout: 30_000 });
  await phone.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });

  const metrics = await phone.evaluate((start) => {
    const zone = document.querySelector(".output-zone") as HTMLElement | null;
    const documents = document.querySelectorAll(".response-document");
    const first = documents[start] as HTMLElement | undefined;
    const second = documents[start + 1] as HTMLElement | undefined;
    const prose = first?.querySelector(".turn-assistant") as HTMLElement | null;
    const h1 = first?.querySelector("h1") as HTMLElement | null;
    const code = second?.querySelector(".markdown pre") as HTMLElement | null;
    const markdownTable = second?.querySelector(
      ".markdown-table-scroll",
    ) as HTMLElement | null;
    const richTable = second?.querySelector(".rc-table") as HTMLElement | null;
    const prompt = document.querySelector(".prompt-box") as HTMLElement | null;
    const status = document.querySelector(".status-bar") as HTMLElement | null;
    if (
      !zone ||
      !first ||
      !second ||
      !prose ||
      !h1 ||
      !code ||
      !markdownTable ||
      !richTable ||
      !prompt ||
      !status
    ) {
      return null;
    }
    const zoneRect = zone.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const proseRect = prose.getBoundingClientRect();
    const codeRect = code.getBoundingClientRect();
    const markdownTableRect = markdownTable.getBoundingClientRect();
    const richTableRect = richTable.getBoundingClientRect();
    const promptRect = prompt.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    const zoneStyle = getComputedStyle(zone);
    const available =
      zoneRect.width -
      Number.parseFloat(zoneStyle.paddingLeft) -
      Number.parseFloat(zoneStyle.paddingRight);
    return {
      available,
      firstWidth: firstRect.width,
      secondWidth: secondRect.width,
      proseWidth: proseRect.width,
      gap: Number.parseFloat(getComputedStyle(first).rowGap),
      h1Size: Number.parseFloat(getComputedStyle(h1).fontSize),
      codeContained: codeRect.left >= secondRect.left - 1 && codeRect.right <= secondRect.right + 1,
      codeOverflowMode: getComputedStyle(code).overflowX,
      markdownTableContained:
        markdownTableRect.left >= secondRect.left - 1 &&
        markdownTableRect.right <= secondRect.right + 1,
      markdownTableOverflowMode: getComputedStyle(markdownTable).overflowX,
      markdownTableTabIndex: markdownTable.tabIndex,
      richTableContained:
        richTableRect.left >= secondRect.left - 1 && richTableRect.right <= secondRect.right + 1,
      pageOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bottomDistance: zone.scrollHeight - zone.clientHeight - zone.scrollTop,
      promptVisible:
        promptRect.top >= 0 &&
        promptRect.bottom <= window.innerHeight + 1 &&
        promptRect.width > 0 &&
        promptRect.height > 0,
      statusVisible:
        statusRect.top >= 0 &&
        statusRect.bottom <= window.innerHeight + 1 &&
        statusRect.width > 0 &&
        statusRect.height > 0,
      pinButtonsHidden: [...document.querySelectorAll(".pin-btn")].every(
        (element) => getComputedStyle(element).display === "none",
      ),
    };
  }, documentsBefore);

  assert.ok(metrics, "phone document fixture did not fully render");
  assert.ok(Math.abs(metrics.firstWidth - metrics.available) <= 1);
  assert.ok(Math.abs(metrics.secondWidth - metrics.available) <= 1);
  assert.ok(Math.abs(metrics.proseWidth - metrics.available) <= 1);
  assert.ok(metrics.gap <= 12.5, `phone document gap is ${metrics.gap}px`);
  assert.ok(metrics.h1Size >= 20 && metrics.h1Size <= 26);
  assert.equal(metrics.codeContained, true);
  assert.equal(metrics.codeOverflowMode, "auto");
  assert.equal(metrics.markdownTableContained, true);
  assert.equal(metrics.markdownTableOverflowMode, "auto");
  assert.equal(metrics.markdownTableTabIndex, 0);
  assert.equal(metrics.richTableContained, true);
  assert.ok(metrics.pageOverflow <= 1);
  assert.ok(metrics.bottomDistance <= 2);
  assert.equal(metrics.promptVisible, true);
  assert.equal(metrics.statusVisible, true);
  assert.equal(metrics.pinButtonsHidden, true);
  assert.equal(await phone.locator(".pin-dock").count(), 0);
  await noSideScroll(phone);

  await firstDocument.evaluate((element) => {
    element.setAttribute("data-ld3-phone-identity", "before-explorer");
  });
  await phone.locator(".sb-workspace").focus();
  await phone.keyboard.press("Enter");
  await phone.waitForSelector(".files-panel[role=dialog]");
  await settled(phone, ".files-panel");
  assert.equal(
    await firstDocument.getAttribute("data-ld3-phone-identity"),
    "before-explorer",
    "opening the phone Explorer remounted the response document",
  );
  await noSideScroll(phone);

  await phone.keyboard.press("Escape");
  await phone.waitForSelector(".files-panel", { state: "detached" });
  assert.equal(
    await firstDocument.getAttribute("data-ld3-phone-identity"),
    "before-explorer",
    "closing the phone Explorer remounted the response document",
  );
  assert.ok(
    Math.abs((await firstDocument.evaluate((element) => element.getBoundingClientRect().width)) - metrics.firstWidth) <= 1,
    "the document did not restore its phone width after Explorer closed",
  );
  await noSideScroll(phone);
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
  // ONE workspace toggle on phone (2026-08-18): a fresh page opens Files.
  assert.equal(await phone.locator(".sb-files, .sb-changes").count(), 0, "the two-icon pair must be gone on phone");
  await phone.locator(".sb-workspace").focus();
  await phone.keyboard.press("Enter");
  await phone.waitForSelector(".files-panel[role=dialog]");
  // The toggle reports the drawer's state (it stays in the DOM under the
  // full-screen drawer; while open it is covered and focus-trapped away, so
  // "toggle closes" is not a reachable phone path — Esc/‹ are).
  assert.equal(await phone.locator(".sb-workspace").getAttribute("aria-expanded"), "true");
  await noSideScroll(phone);
  const width = await phone.evaluate(() => {
    const el = document.querySelector(".files-panel");
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  assert.ok(width >= 380, `panel is ${width}px wide — not full-screen`);

  // Both drawer views exit the same way — a leading ‹ at the top-left (the
  // Files × at the top-right was the odd one out) — and the drawer's own
  // head switches between them; switching keeps the exit where it was.
  assert.equal(await phone.locator(".files-panel-head .files-panel-back").getAttribute("aria-label"), "Back to conversation");
  await settled(phone, ".files-panel");
  const filesBack = (await phone.locator(".files-panel-back").boundingBox())!;
  assert.ok(filesBack.x < 60 && filesBack.y < 120, `files back is at ${filesBack.x},${filesBack.y} — not top-left`);
  assert.ok(
    filesBack.width >= 40 && filesBack.height >= 40,
    `files back is under the 40px thumb rule (${JSON.stringify(filesBack)})`,
  );
  // The switch is the phone's ONLY way between the views, so it obeys the
  // ≥40px thumb rule itself (the pill's buttons, not the pill).
  const filesTabs = (await phone.locator(".files-panel-head .workspace-tabs").boundingBox())!;
  for (const tab of await phone.locator(".files-panel-head .workspace-tab").all()) {
    const box = (await tab.boundingBox())!;
    assert.ok(box.height >= 40 && box.width >= 40, `workspace tab is ${box.width}×${box.height} — under the 40px thumb rule`);
  }
  await phone.locator('.files-panel-head .workspace-tab:has-text("Changes")').tap();
  await phone.waitForSelector(".changes-panel[role=dialog]");
  assert.equal(await phone.locator(".files-panel").count(), 0, "one drawer view at a time");
  await settled(phone, ".changes-panel");
  const changesBack = (await phone.locator(".changes-head .changes-close").boundingBox())!;
  assert.equal(await phone.locator(".changes-head .changes-close").getAttribute("aria-label"), "Back to conversation");
  // "One control in two places": the exit and the switch sit at the SAME
  // spot in both heads (both axes; 1px = sub-pixel rounding, nothing more),
  // so switching views never moves either under the thumb.
  const samePlace = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
  assert.ok(
    samePlace(changesBack, filesBack),
    `exits drift between heads: files ${filesBack.x},${filesBack.y} vs changes ${changesBack.x},${changesBack.y}`,
  );
  const changesTabs = (await phone.locator(".changes-head .workspace-tabs").boundingBox())!;
  assert.ok(
    samePlace(changesTabs, filesTabs),
    `switch jumps between heads: files ${filesTabs.x},${filesTabs.y} vs changes ${changesTabs.x},${changesTabs.y}`,
  );
  await phone.locator('.changes-head .workspace-tab:has-text("Files")').tap();
  await phone.waitForSelector(".files-panel[role=dialog]");
  await noSideScroll(phone);

  // The tree is live git data (the daemon runs in the repo) — drill into a file.
  const pkg = phone.locator(".files-file-row", { hasText: "package.json" }).first();
  await pkg.waitFor({ timeout: 15_000 });
  assert.equal(
    await pkg.locator(".files-caret + .files-node-icon-config[aria-hidden=true] + .files-name").count(),
    1,
    "phone tree keeps the decorative configuration glyph before the name",
  );
  await pkg.tap();
  await phone.waitForSelector(".files-view .fv-content");
  await noSideScroll(phone);
  // The enlarge button is a desktop affordance — the phone frame is already
  // full-screen, so it must not render here (E.6).
  assert.equal(await phone.locator(".files-enlarge").count(), 0, "enlarge button on phone");

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
  assert.equal(await phone.locator(".sb-workspace").getAttribute("aria-expanded"), "false");
  await noSideScroll(phone);
  const focusedFiles = await phone.evaluate(
    () => document.activeElement?.classList.contains("sb-workspace") ?? false,
  );
  assert.ok(focusedFiles, "focus returned to the workspace toggle on close");
});

// The drawer heads hold fixed-width controls (‹, the Files | Changes switch,
// refresh, the count pill) — none may shrink, so on the narrowest phones
// they must not land on each other. 320px is the iPhone-SE-class floor; the
// 2026-08-18 bughunt caught the count pill sitting on the switch there.
test("phone (320px): both drawer heads keep their controls apart", async () => {
  // Self-contained: an earlier failure may have left the drawer open (a file
  // view needs two Escapes: back to the tree, then out), and a covered toggle
  // would turn that one failure into a second, unrelated one.
  await closeDrawer(phone);
  await phone.setViewportSize({ width: 320, height: 568 });
  try {
    await phone.locator(".sb-workspace").tap();
    // Whichever view was used last: land on Files explicitly.
    await phone.waitForSelector(".files-panel[role=dialog], .changes-panel[role=dialog]");
    await phone.locator('.workspace-tab:has-text("Files")').tap();
    await phone.waitForSelector(".files-panel[role=dialog]");
    await settled(phone, ".files-panel");
    await assertApartOnScreen(phone, 320, [".files-panel-back", ".files-panel-head .workspace-tabs", ".files-refresh"]);
    await noSideScroll(phone);
    await phone.locator('.files-panel-head .workspace-tab:has-text("Changes")').tap();
    await phone.waitForSelector(".changes-panel[role=dialog]");
    await phone.waitForSelector(".changes-count");
    await settled(phone, ".changes-panel");
    // Row two: the review progress renders only with ≥1 change (this daemon
    // runs in the checkout, clean in CI); changes.e2e pins the pair on its
    // 5-file fixture unconditionally.
    const progress = (await phone.locator(".changes-progress").count()) > 0 ? [".changes-progress"] : [];
    await assertApartOnScreen(phone, 320, [
      ".changes-head .changes-close",
      ".changes-head .workspace-tabs",
      ".changes-count",
      ...progress,
      ".changes-refresh",
    ]);
    await noSideScroll(phone);
    await phone.locator(".changes-head .changes-close").tap();
    await phone.waitForSelector(".changes-panel", { state: "detached" });
  } finally {
    // A failed assertion must not leave the drawer over the later tests.
    await closeDrawer(phone);
    await phone.setViewportSize({ width: 390, height: 844 });
  }
});

test("phone: a permission request is answerable by thumb", async () => {
  await sendPrompt(phone, "do something dangerous");
  await phone.waitForSelector(".permission-bar", { timeout: 15_000 });
  assert.equal(
    await phone.locator(".input-nav-phone-toggle").count(),
    0,
    "submitted-input navigation competes with the permission actions",
  );
  await noSideScroll(phone);
  const allow = phone.locator(".permission-allow");
  const box = (await allow.boundingBox())!;
  assert.ok(box.height >= 36, `allow button is ${box.height}px tall — too small to tap`);
  await allow.tap();
  await phone.waitForSelector("text=restarted cleanly", { timeout: 15_000 });
});

// The 2026-07-28 readability bug: at phone width the strip's one-line
// preview truncates, so the user couldn't SEE what they were allowing.
// Tapping the strip's body — the thing a thumb tries unprompted — opens the
// full command in a card; a tap anywhere else dismisses it unanswered.
test("phone: the truncated command expands to a card on tap; a tap away dismisses, unanswered", async () => {
  await sendPrompt(phone, "do something dangerous");
  await phone.waitForSelector(".permission-bar", { timeout: 15_000 });
  const clipped = await phone.evaluate(() => {
    const el = document.querySelector(".permission-detail")!;
    return el.scrollWidth > el.clientWidth;
  });
  assert.ok(clipped, "the preview is not truncated at phone width — this test proves nothing");
  await phone.locator(".permission-body").tap();
  await phone.waitForSelector(".permission-modal-card");
  assert.match(
    await phone.locator(".permission-modal-detail").innerText(),
    /rm -rf \/var\/cache\/app && systemctl restart app/,
  );
  await noSideScroll(phone);
  await phone.touchscreen.tap(8, 8);
  await phone.waitForFunction(() => !document.querySelector(".permission-modal-card"));
  assert.equal(await phone.locator(".permission-bar").count(), 1, "the tap away answered the ask");
  await phone.locator(".permission-deny").tap();
  await phone.waitForFunction(() => !document.querySelector(".permission-bar"), undefined, {
    timeout: 15_000,
  });
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
  await phone.waitForSelector(".permission-bar", { timeout: 15_000 });
  await desktop.waitForSelector(".permission-bar", { timeout: 15_000 });
  await desktop.locator(".permission-allow").click();

  await phone.waitForFunction(
    (n) =>
      !document.querySelector(".permission-bar") &&
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

  await sendPrompt(phone, MOCK_PROMPTS["checklist"]);
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
    await phone.locator(".sb-workspace").isDisabled(),
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
