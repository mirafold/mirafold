import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ClientMsg } from "../protocol";
import { assertAxeClean, launchChrome, noSideScroll } from "./e2e-harness";
import { fixtureGit as git, startDaemon, TestClient, type Daemon } from "./itest-harness";

// CR.2–CR.4 in a real browser against a real daemon and real Git: responsive
// review, every honest state, line/hunk selection, editable prompt drafts,
// and revision-keyed viewport-local review progress.

const TOKEN = "changes-e2e-token";

let daemon: Daemon;
let browser: Browser;
let fixtureRoot: string;
let changedRepo: string;
let plainRoot: string;
let cleanRepo: string;
let unsafeRepo: string;
let lifecycleRepo: string;
let manualRepo: string;
let incompleteRepo: string;
let statusRepo: string;
let hunkRepo: string;
let changedSession: string;
let hunkSession: string;
let plainSession: string;
let cleanSession: string;
let unsafeSession: string;
let lifecycleSession: string;
let manualSession: string;
let incompleteSession: string;
let statusSession: string;
let desktop: Page;
let phoneContext: BrowserContext;
let phone: Page;

const modifiedSource = (primary: string, tail: string): string =>
  [
    "export function review(value: number) {",
    `  const modified = "${primary}";`,
    "  const line3 = value + 3;",
    "  const line4 = value + 4;",
    "  const line5 = value + 5;",
    "  const line6 = value + 6;",
    "  const line7 = value + 7;",
    "  const line8 = value + 8;",
    "  const line9 = value + 9;",
    "  const line10 = value + 10;",
    `  const tail = "${tail}";`,
    "  return `${modified}:${tail}:${value}`;",
    "}",
    "",
  ].join("\n");

// A file long enough that no two hunks share a 900px viewport, with the
// first hunk far below the fold — the geometry that exposed the terminal
// hunk-navigation and initial-position bugs (2026-08-12).
const walkSource = (tags: Record<number, string>): string =>
  Array.from({ length: 160 }, (_, k) => `const line${k + 1} = "${tags[k + 1] ?? "base"}";`).join("\n") +
  "\n";

const createSession = async (cwd: string): Promise<string> => {
  const client = new TestClient(daemon.port, { token: TOKEN });
  await client.opened();
  await client.type("agents");
  client.send({ type: "create", agent: "claude-code", cwd } as ClientMsg);
  const created = (await client.type("session_created")) as { sessionId: string };
  client.close();
  return created.sessionId;
};

const sessionUrl = (sessionId: string): string =>
  `http://127.0.0.1:${daemon.port}/s/${sessionId}?token=${TOKEN}`;

const selectDesktopFile = async (name: string): Promise<void> => {
  await desktop.locator(".changes-file", { hasText: name }).click();
  await desktop.waitForFunction(
    (suffix) => document.querySelector(".changes-current-path")?.textContent?.endsWith(String(suffix)),
    name,
  );
  await desktop.waitForTimeout(300);
};

const desktopDiffText = async (kind: "add" | "del"): Promise<string> =>
  (await desktop.locator(`.changes-view .diff-${kind}`).allInnerTexts()).join("\n");

before(async () => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "mirafold-changes-e2e-"));
  changedRepo = path.join(fixtureRoot, "changed-repo");
  plainRoot = path.join(fixtureRoot, "plain-workspace");
  cleanRepo = path.join(fixtureRoot, "clean-repo");
  unsafeRepo = path.join(fixtureRoot, "unscannable-repo");
  lifecycleRepo = path.join(fixtureRoot, "lifecycle-repo");
  manualRepo = path.join(fixtureRoot, "manual-repo");
  incompleteRepo = path.join(fixtureRoot, "incomplete-repo");
  statusRepo = path.join(fixtureRoot, "status-repo");
  hunkRepo = path.join(fixtureRoot, "hunk-repo");
  for (const root of [
    changedRepo,
    plainRoot,
    cleanRepo,
    unsafeRepo,
    lifecycleRepo,
    manualRepo,
    incompleteRepo,
    statusRepo,
    hunkRepo,
  ]) mkdirSync(root);

  git(changedRepo, "init", "--quiet");
  writeFileSync(path.join(changedRepo, "d-deleted.ts"), "deleted before\n");
  writeFileSync(path.join(changedRepo, "m-modified.ts"), modifiedSource("modified before", "tail before"));
  writeFileSync(path.join(changedRepo, "z-binary.bin"), Buffer.from([0, 1, 2, 3]));
  git(changedRepo, "add", "--all");
  git(changedRepo, "commit", "--quiet", "-m", "baseline");
  writeFileSync(path.join(changedRepo, "a-added.ts"), "added after\n");
  git(changedRepo, "add", "a-added.ts");
  unlinkSync(path.join(changedRepo, "d-deleted.ts"));
  writeFileSync(path.join(changedRepo, "m-modified.ts"), modifiedSource("modified after", "tail after"));
  writeFileSync(path.join(changedRepo, "u-untracked.ts"), "untracked after\n");
  writeFileSync(path.join(changedRepo, "z-binary.bin"), Buffer.from([0, 1, 9, 3]));
  // Sixth path exceeds the daemon cap below, proving the visible-count and
  // incomplete-list language while the first five still cover A/D/M/U/binary.
  writeFileSync(path.join(changedRepo, "zz-omitted.ts"), "omitted\n");

  git(cleanRepo, "init", "--quiet");
  writeFileSync(path.join(cleanRepo, "clean.ts"), "clean\n");
  git(cleanRepo, "add", "--all");
  git(cleanRepo, "commit", "--quiet", "-m", "clean");

  git(unsafeRepo, "init", "--quiet");
  writeFileSync(path.join(unsafeRepo, "change.ts"), "changed\n");
  // The trust layer's bounded config scan refuses more than 64 content
  // drivers. Nothing here runs; the fixture only exercises the honest UI
  // state for a repository Mirafold declines to inspect automatically.
  for (let i = 0; i < 65; i++) {
    git(unsafeRepo, "config", `filter.fixture${i}.clean`, "not-a-real-program");
  }

  git(lifecycleRepo, "init", "--quiet");
  writeFileSync(path.join(lifecycleRepo, "tracked.ts"), "before\n");
  git(lifecycleRepo, "add", "--all");
  git(lifecycleRepo, "commit", "--quiet", "-m", "baseline");
  writeFileSync(path.join(lifecycleRepo, "tracked.ts"), "after first connection\n");

  git(manualRepo, "init", "--quiet");
  mkdirSync(path.join(manualRepo, "scope"));
  writeFileSync(path.join(manualRepo, "scope", "a.ts"), "a: baseline\n");
  writeFileSync(path.join(manualRepo, "scope", "b.ts"), "b: baseline\n");
  git(manualRepo, "add", "--all");
  git(manualRepo, "commit", "--quiet", "-m", "baseline");
  writeFileSync(path.join(manualRepo, "scope", "a.ts"), "a: second commit\n");
  writeFileSync(path.join(manualRepo, "scope", "b.ts"), "b: second commit\n");
  git(manualRepo, "add", "--all");
  git(manualRepo, "commit", "--quiet", "-m", "second");
  writeFileSync(path.join(manualRepo, "scope", "a.ts"), "a: working tree\n");
  writeFileSync(path.join(manualRepo, "scope", "b.ts"), "b: working tree\n");

  git(incompleteRepo, "init", "--quiet");
  writeFileSync(path.join(incompleteRepo, "tracked.txt"), "clean\n");
  git(incompleteRepo, "add", "--all");
  git(incompleteRepo, "commit", "--quiet", "-m", "baseline");
  const embedded = path.join(incompleteRepo, "embedded");
  mkdirSync(embedded);
  git(embedded, "init", "--quiet");
  writeFileSync(path.join(embedded, "only-inside.txt"), "nested\n");

  git(statusRepo, "init", "--quiet");
  writeFileSync(path.join(statusRepo, "tracked.ts"), "before\n");
  git(statusRepo, "add", "--all");
  git(statusRepo, "commit", "--quiet", "-m", "baseline");
  writeFileSync(path.join(statusRepo, "tracked.ts"), "after\n");

  git(hunkRepo, "init", "--quiet");
  writeFileSync(path.join(hunkRepo, "walk.ts"), walkSource({}));
  git(hunkRepo, "add", "--all");
  git(hunkRepo, "commit", "--quiet", "-m", "baseline");
  writeFileSync(path.join(hunkRepo, "walk.ts"), walkSource({ 60: "edit", 130: "edit" }));

  daemon = await startDaemon({
    MIRAFOLD_TOKEN: TOKEN,
    FS_CHANGES_MAX_ENTRIES: "5",
    FS_LISTDIR_STATUS_WAIT_MS: "0",
  });
  changedSession = await createSession(changedRepo);
  plainSession = await createSession(plainRoot);
  cleanSession = await createSession(cleanRepo);
  unsafeSession = await createSession(unsafeRepo);
  lifecycleSession = await createSession(lifecycleRepo);
  manualSession = await createSession(path.join(manualRepo, "scope"));
  incompleteSession = await createSession(incompleteRepo);
  statusSession = await createSession(statusRepo);
  hunkSession = await createSession(hunkRepo);
  browser = await launchChrome();
});

after(async () => {
  await phoneContext?.close();
  await browser?.close();
  await daemon?.stop();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("CR.2 desktop: Changes is a live split review workspace, mutually exclusive with Files", async () => {
  desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desktop.goto(sessionUrl(changedSession));
  await desktop.waitForSelector(".status-bar");

  // The one auxiliary slot: Files opens, then Changes replaces it rather than
  // stacking a third column beside the conversation.
  await desktop.locator(".ab-files").click();
  await desktop.waitForSelector(".files-panel");
  await desktop.locator(".ab-changes").click();
  await desktop.waitForSelector(".changes-panel");
  assert.equal(await desktop.locator(".files-panel").count(), 0);
  assert.match((await desktop.locator(".ab-changes").getAttribute("class")) ?? "", /is-active/);

  await desktop.waitForSelector(".changes-file");
  assert.equal(await desktop.locator(".changes-file").count(), 5);
  assert.equal(await desktop.locator(".changes-count").innerText(), "5 visible");
  assert.match(await desktop.locator(".changes-warning").innerText(), /incomplete/i);
  assert.match(await desktop.locator(".changes-repo h3").innerText(), /changed-repo/i);
  const widths = await desktop.evaluate(() => ({
    changes: document.querySelector(".changes-panel")!.getBoundingClientRect().width,
    transcript: document.querySelector(".render-zone")!.getBoundingClientRect().width,
  }));
  assert.ok(widths.changes >= 500, `desktop Changes surface is only ${widths.changes}px wide`);
  assert.ok(widths.transcript >= 300, `conversation was hidden/squeezed to ${widths.transcript}px`);

  // At one pixel above the phone breakpoint it is still a split workspace,
  // not a surprise modal; both review and conversation retain useful width.
  await desktop.setViewportSize({ width: 641, height: 780 });
  const narrow = await desktop.evaluate(() => ({
    panelPosition: getComputedStyle(document.querySelector(".changes-panel")!).position,
    review: document.querySelector(".changes-review")!.getBoundingClientRect().width,
    transcript: document.querySelector(".render-zone")!.getBoundingClientRect().width,
  }));
  assert.notEqual(narrow.panelPosition, "fixed", "641px was reframed as the phone modal");
  assert.ok(narrow.review >= 155, `narrow-desktop review is only ${narrow.review}px wide`);
  assert.ok(narrow.transcript >= 200, `narrow-desktop conversation is only ${narrow.transcript}px wide`);
  await noSideScroll(desktop);
  await desktop.setViewportSize({ width: 1280, height: 900 });

  await selectDesktopFile("a-added.ts");
  await desktop
    .waitForSelector(".changes-view .diff-add", { timeout: 5_000 })
    .catch(async () =>
      assert.fail(`added diff did not render; view says: ${await desktop.locator(".changes-view").innerText()}`),
    );
  assert.match(await desktopDiffText("add"), /added after/);
  await selectDesktopFile("d-deleted.ts");
  assert.match(await desktopDiffText("del"), /deleted before/);
  await selectDesktopFile("m-modified.ts");
  assert.match(await desktopDiffText("del"), /modified before/);
  assert.match(await desktopDiffText("add"), /modified after/);
  await selectDesktopFile("u-untracked.ts");
  assert.match(await desktopDiffText("add"), /untracked after/);
  await selectDesktopFile("z-binary.bin");
  assert.match(await desktop.locator(".changes-view").innerText(), /Binary file.*not shown/i);

  // Select the modified file, mutate it outside Mirafold, and observe the
  // watcher refresh both the complete set and the open diff without a click.
  await selectDesktopFile("m-modified.ts");
  writeFileSync(
    path.join(changedRepo, "m-modified.ts"),
    modifiedSource("modified after live refresh", "tail after"),
  );
  await desktop.waitForFunction(
    () => document.querySelector(".changes-view .diff-add")?.textContent?.includes("live refresh"),
    undefined,
    { timeout: 15_000 },
  );
  assert.ok((await desktop.locator(".changes-current-path").innerText()).endsWith("m-modified.ts"));

  await desktop.screenshot({ path: path.join(os.tmpdir(), "mirafold-changes-desktop-dark.png") });
  await assertAxeClean(desktop, "desktop workspace changes (dark)");
  await desktop.locator('.sb-theme-opt[title="Light theme"]').click();
  assert.match(await desktopDiffText("add"), /live refresh/, "theme switch lost the open diff");
  await desktop.screenshot({ path: path.join(os.tmpdir(), "mirafold-changes-desktop-light.png") });
  await assertAxeClean(desktop, "desktop workspace changes (light)");

  // Files still follows its original tree → file drill-in after CR.2's shell
  // state refactor, and switching back closes Changes by construction.
  await desktop.locator(".ab-files").click();
  await desktop.waitForSelector(".files-panel");
  assert.equal(await desktop.locator(".changes-panel").count(), 0);
  await desktop.locator(".files-file-row", { hasText: "a-added.ts" }).click();
  await desktop.waitForSelector(".files-view .fv-content");
  assert.match(await desktop.locator(".files-view .fv-content").innerText(), /added after/);
  await desktop.locator(".ab-files").click();
});

test("CR.3 desktop: pointer and keyboard ranges create editable prompt drafts and invalidate live", async () => {
  desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desktop.goto(sessionUrl(changedSession));
  await desktop.waitForSelector(".ab-changes");
  await desktop.locator(".ab-changes").click();
  await desktop.waitForSelector(".changes-review-line");
  await selectDesktopFile("m-modified.ts");

  const deleted = desktop.locator('.changes-review-line.is-del[data-old-line="2"]');
  const added = desktop.locator('.changes-review-line.is-add[data-new-line="2"]');
  await deleted.waitFor({ timeout: 5_000 }).catch(async () =>
    assert.fail(
      `modified review lines did not render; selected=${await desktop.locator(".changes-current-path").innerText()} ` +
        `view=${JSON.stringify(await desktop.locator(".changes-view").innerText())}`,
    ),
  );
  assert.equal(await deleted.locator(".changes-line-old").innerText(), "2");
  assert.equal(await added.locator(".changes-line-new").innerText(), "2");
  assert.equal(await added.locator(".changes-line-old").innerText(), "");
  assert.ok(await added.locator(".hljs-keyword", { hasText: "const" }).count(), "TypeScript was not highlighted");
  assert.equal(await desktop.locator(".changes-hunk-nav > span").innerText(), "Hunk 1 of 2");
  await desktop.locator('[aria-label="Next changed hunk"]').click();
  assert.equal(await desktop.locator(".changes-hunk-nav > span").innerText(), "Hunk 2 of 2");
  await desktop.locator('[aria-label="Previous changed hunk"]').click();

  // Pointer drag selects the exact replacement pair.
  await deleted.hover();
  await desktop.mouse.down();
  await added.hover();
  await desktop.mouse.up();
  await desktop.waitForFunction(
    () => document.querySelector(".changes-selection-count")?.textContent === "2 selected",
  );
  const turnsBeforeDraft = await desktop.locator(".turn-user").count();
  await desktop.locator(".changes-draft-actions button", { hasText: "Explain" }).click();
  const prompt = desktop.locator(".prompt-box textarea");
  await desktop.waitForFunction(
    () => (document.querySelector(".prompt-box textarea") as HTMLTextAreaElement)?.value.includes("Explain the selected"),
  );
  assert.equal(
    await desktop.evaluate(() => document.activeElement?.matches(".prompt-box textarea")),
    true,
    "desktop review action did not focus the editable draft",
  );
  assert.equal(await desktop.locator(".turn-user").count(), turnsBeforeDraft, "Explain sent without user approval");
  assert.ok(await desktop.locator(".changes-panel").isVisible(), "creating a draft hid the diff context");
  assert.match(await prompt.inputValue(), /File: "m-modified\.ts"/);
  assert.match(await prompt.inputValue(), /Range: HEAD line 2; working tree line 2/);
  assert.match(await prompt.inputValue(), /-   const modified = "modified before";/);
  assert.match(await prompt.inputValue(), /\+   const modified = "modified after(?: live refresh)?";/);

  // Keyboard selection replaces the UI selection, while the review action
  // preserves text the user already placed in the prompt.
  await prompt.fill("Keep this user-authored note.");
  await deleted.focus();
  await desktop.keyboard.press("Space");
  await desktop.keyboard.press("Shift+ArrowDown");
  assert.equal(await desktop.locator(".changes-selection-count").innerText(), "2 selected");
  await desktop.locator(".changes-draft-actions button", { hasText: "Request change" }).click();
  await desktop.waitForFunction(
    () => (document.querySelector(".prompt-box textarea") as HTMLTextAreaElement)?.value.includes("Please revise"),
  );
  assert.match(await prompt.inputValue(), /^Keep this user-authored note\.\n\nPlease revise/);
  await prompt.fill(`${await prompt.inputValue()}\nUse clearer naming.`);
  await desktop.screenshot({ path: path.join(os.tmpdir(), "mirafold-changes-cr3-desktop.png") });
  await assertAxeClean(desktop, "desktop conversational change review");
  await prompt.press("Enter");
  await desktop.locator(".turn-user", { hasText: "Use clearer naming." }).waitFor();
  await desktop.locator(".activity-line").waitFor({ state: "detached", timeout: 30_000 });
  const highlightedMarkdown = desktop.locator(".turn-assistant code.hljs");
  assert.equal(
    await highlightedMarkdown.count(),
    2,
    "the deterministic CR.3 response did not exercise both highlighted markdown scrollers",
  );
  assert.deepEqual(
    await highlightedMarkdown.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("tabindex"))),
    ["0", "0"],
    "highlighted markdown scrollers are not keyboard-reachable",
  );
  assert.equal(
    await desktop.locator(".changes-selection-count").innerText(),
    "2 selected",
    `selection changed before the disk rewrite; notice=${JSON.stringify(await desktop.locator(".changes-review-notice").allInnerTexts())}`,
  );

  // A genuine disk revision invalidates the old coordinates; an identical
  // turn-end refresh does not manufacture invalidation.
  writeFileSync(
    path.join(changedRepo, "m-modified.ts"),
    modifiedSource("modified after CR.3 disk refresh", "tail after"),
  );
  await desktop
    .locator(".changes-review-notice", { hasText: "Selection cleared because this file changed." })
    .waitFor({ timeout: 15_000 })
    .catch(async () =>
      assert.fail(
        `live invalidation was not announced; selected=${await desktop.locator(".changes-current-path").innerText()} ` +
          `count=${JSON.stringify(await desktop.locator(".changes-selection-count").allInnerTexts())} ` +
          `notice=${JSON.stringify(await desktop.locator(".changes-review-notice").allInnerTexts())} ` +
          `view=${JSON.stringify((await desktop.locator(".changes-view").innerText()).slice(0, 800))}`,
      ),
  );
  assert.equal(await desktop.locator(".changes-selection-count").innerText(), "Select lines to respond");

  // The selection owner is the persistent panel, not the textual renderer:
  // changing to a non-text file still clears and explains the old range.
  await desktop.locator('.changes-review-line.is-add[data-new-line="2"]').focus();
  await desktop.keyboard.press("Space");
  assert.equal(await desktop.locator(".changes-selection-count").innerText(), "1 selected");
  await selectDesktopFile("z-binary.bin");
  assert.match(await desktop.locator(".changes-view").innerText(), /Binary file.*not shown/i);
  assert.equal(
    await desktop.locator(".changes-review-notice").innerText(),
    "Selection cleared because another file was opened.",
  );
  await noSideScroll(desktop);
});

test("CR.3 hunk navigation reaches terminal hunks, opens on the first hunk, and survives live refresh", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // The label alone is not the oracle — it updated correctly while the
  // viewport stayed behind (2026-08-12). Every jump asserts the hunk's rows
  // are inside the review scroller's visible box.
  const hunkVisible = (oldLine: number) =>
    page.waitForFunction(
      (line) => {
        const row = document.querySelector(`.changes-review-line.is-del[data-old-line="${line}"]`);
        const view = document.querySelector(".changes-view");
        if (!row || !view) return false;
        const r = row.getBoundingClientRect();
        const v = view.getBoundingClientRect();
        return r.bottom > v.top && r.top < v.bottom;
      },
      oldLine,
      { timeout: 5_000 },
    );
  const hunkLabel = () => page.locator(".changes-hunk-nav > span").innerText();

  await page.goto(sessionUrl(hunkSession));
  await page.waitForSelector(".ab-changes");
  await page.locator(".ab-changes").click();
  await page.waitForSelector(".changes-review-line");

  // Opening a file lands on its first hunk, not the top of the file, so
  // "Hunk 1 of N" is what the viewport actually shows.
  assert.equal(await hunkLabel(), "Hunk 1 of 2");
  await hunkVisible(60).catch(() => assert.fail("opening the diff did not position on the first hunk"));

  // The terminal jump is the one that disables the button being clicked;
  // the smooth scroll must survive that (blur-on-disable cancellation).
  await page.locator('[aria-label="Next changed hunk"]').click();
  assert.equal(await hunkLabel(), "Hunk 2 of 2");
  await hunkVisible(130).catch(() => assert.fail("next-hunk never brought the last hunk into view"));
  assert.ok(await page.locator('[aria-label="Next changed hunk"]').isDisabled());

  // Mirror image: previous-to-first disables Previous on arrival.
  await page.locator('[aria-label="Previous changed hunk"]').click();
  assert.equal(await hunkLabel(), "Hunk 1 of 2");
  await hunkVisible(60).catch(() => assert.fail("previous-hunk never brought the first hunk into view"));
  assert.ok(await page.locator('[aria-label="Previous changed hunk"]').isDisabled());

  // A live rewrite must refresh the diff in place: no loading flicker that
  // unmounts the renderer, and no repositioning onto the first hunk.
  await page.evaluate(() => {
    const view = document.querySelector(".changes-view");
    if (view) view.scrollTop = 0;
  });
  writeFileSync(path.join(hunkRepo, "walk.ts"), walkSource({ 60: "edit refreshed", 130: "edit" }));
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".changes-review-line .changes-line-code")).some((node) =>
        (node.textContent ?? "").includes("edit refreshed"),
      ),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(() => document.querySelector(".changes-view")?.scrollTop ?? -1),
    0,
    "live refresh yanked the review viewport away from the reader's position",
  );
  await page.close();
});

test("CR.2 phone: full-screen one-file review has persistent navigation and preserves conversation scroll", async () => {
  phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  phone = await phoneContext.newPage();
  await phone.goto(sessionUrl(changedSession));
  await phone.waitForSelector(".status-bar");
  await noSideScroll(phone);

  // Give the mounted transcript a real scroll offset. The fixed review layer
  // must not remount or reset it when the user returns to chat.
  await phone.addStyleTag({
    content: '.render-zone::before { content: ""; display: block; flex: 0 0 1600px; }',
  });
  await phone.locator(".render-zone").evaluate((element) => (element.scrollTop = 320));
  const transcriptScroll = await phone.locator(".render-zone").evaluate((element) => element.scrollTop);
  assert.ok(transcriptScroll > 0, "phone transcript fixture did not become scrollable");

  await phone.locator(".sb-changes").tap();
  await phone.waitForSelector(".changes-panel[role=dialog]");
  await phone.waitForSelector(".changes-current-path");
  assert.equal(await phone.locator(".changes-count").innerText(), "5 visible");
  assert.equal(await phone.locator(".changes-rail").count(), 0, "the desktop changed-file rail rendered on phone");
  assert.ok((await phone.locator(".changes-current-path").innerText()).endsWith("a-added.ts"));

  const targets = await phone.evaluate(() =>
    [
      ".changes-close",
      ".changes-refresh",
      '[aria-label="Previous changed file"]',
      '[aria-label="Next changed file"]',
    ].map((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { selector, width: rect.width, height: rect.height };
    }),
  );
  for (const target of targets) {
    assert.ok(target.width >= 40 && target.height >= 40, `${target.selector} is ${target.width}×${target.height}`);
  }

  const expected = ["d-deleted.ts", "m-modified.ts", "u-untracked.ts", "z-binary.bin"];
  for (const name of expected) {
    await phone.locator('[aria-label="Next changed file"]').tap();
    await phone.waitForFunction(
      (suffix) => document.querySelector(".changes-current-path")?.textContent?.endsWith(String(suffix)),
      name,
    );
    await phone.waitForTimeout(300);
  }
  assert.match(await phone.locator(".changes-view").innerText(), /Binary file.*not shown/i);
  assert.equal(await phone.locator('[aria-label="Next changed file"]').isDisabled(), true);
  await noSideScroll(phone);
  await phone.screenshot({ path: path.join(os.tmpdir(), "mirafold-changes-phone-dark.png") });
  await assertAxeClean(phone, "phone workspace changes (dark)");

  await phone.locator(".changes-close").tap();
  await phone.waitForSelector(".changes-panel", { state: "detached" });
  assert.equal(
    await phone.locator(".render-zone").evaluate((element) => element.scrollTop),
    transcriptScroll,
    "returning to chat changed the transcript scroll position",
  );

  // Switch through the real phone settings path, reopen, and capture the
  // light surface too; the selected file remains valid across the close.
  await phone.locator(".sb-settings").tap();
  const lightGroup = phone.locator('.theme-group[aria-label="Light themes"]');
  await lightGroup.locator(".theme-row", { hasText: "Standard" }).tap();
  await phone.locator(".settings-close").tap();
  await phone.locator(".sb-changes").tap();
  await phone.waitForSelector(".changes-panel[role=dialog]");
  assert.ok((await phone.locator(".changes-current-path").innerText()).endsWith("z-binary.bin"));
  await phone.screenshot({ path: path.join(os.tmpdir(), "mirafold-changes-phone-light.png") });
  await assertAxeClean(phone, "phone workspace changes (light)");
  await noSideScroll(phone);

  await phone.locator(".changes-close").tap();
  await phone.locator(".sb-files").tap();
  await phone.waitForSelector(".files-panel[role=dialog]");
  await phone.locator(".files-file-row", { hasText: "a-added.ts" }).tap();
  await phone.waitForSelector(".files-view .fv-content");
  await noSideScroll(phone);
  await phone.keyboard.press("Escape");
  await phone.keyboard.press("Escape");
});

test("CR.3 phone: tap and whole-hunk selection keep context beside the editable prompt", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(sessionUrl(changedSession));
    await page.waitForSelector(".sb-changes");
    await page.locator(".sb-changes").tap();
    await page.waitForSelector(".changes-current-path");
    for (const name of ["d-deleted.ts", "m-modified.ts"]) {
      await page.locator('[aria-label="Next changed file"]').tap();
      await page.waitForFunction(
        (suffix) => document.querySelector(".changes-current-path")?.textContent?.endsWith(String(suffix)),
        name,
      );
      await page.waitForTimeout(300);
    }

    const added = page.locator('.changes-review-line.is-add[data-new-line="2"]');
    await added.tap();
    assert.equal(await page.locator(".changes-selection-count").innerText(), "1 selected");
    await page.locator(".changes-select-hunk").tap();
    assert.equal(await page.locator(".changes-selection-count").innerText(), "2 selected");

    const turnsBeforeDraft = await page.locator(".turn-user").count();
    await page.locator(".changes-draft-actions button", { hasText: "Request change" }).tap();
    const prompt = page.locator(".prompt-box textarea");
    await page.waitForFunction(
      () => (document.querySelector(".prompt-box textarea") as HTMLTextAreaElement)?.value.includes("Please revise"),
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".prompt-box textarea")),
      true,
      "phone review action did not focus the editable draft",
    );
    assert.equal(await page.locator(".turn-user").count(), turnsBeforeDraft, "phone action sent without approval");
    assert.ok(await page.locator(".changes-panel").isVisible(), "phone action closed the review context");
    assert.ok(await page.locator(".prompt-box").isVisible(), "phone draft stayed hidden behind the review layer");
    assert.match(await prompt.inputValue(), /File: "m-modified\.ts"/);

    const geometry = await page.evaluate(() => {
      const selected = document.querySelector(".changes-review-line.is-selected")!.getBoundingClientRect();
      const promptBox = document.querySelector(".prompt-box")!.getBoundingClientRect();
      return {
        selectedAbovePrompt: selected.bottom <= promptBox.top,
        promptInsideViewport: promptBox.top >= 0 && promptBox.bottom <= window.innerHeight,
      };
    });
    assert.ok(geometry.selectedAbovePrompt, "the floating draft covered the selected context");
    assert.ok(geometry.promptInsideViewport, "the floating draft left the phone viewport");

    const targets = await page.evaluate(() =>
      [
        ".changes-select-hunk",
        ".changes-draft-actions button:first-of-type",
        ".changes-draft-actions button:last-of-type",
        ".changes-review-line.is-selected",
        ".prompt-send",
      ].map((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { selector, width: rect.width, height: rect.height };
      }),
    );
    for (const target of targets) {
      assert.ok(target.width >= 40 && target.height >= 40, `${target.selector} is ${target.width}×${target.height}`);
    }
    await noSideScroll(page);
    await page.screenshot({ path: path.join(os.tmpdir(), "mirafold-changes-cr3-phone.png") });
    await assertAxeClean(page, "phone conversational change review");

    // Moving to a different file clears the no-longer-valid coordinates but
    // preserves the already-visible draft about the original exact path.
    await page.locator('[aria-label="Next changed file"]').tap();
    await page.waitForFunction(
      () => document.querySelector(".changes-current-path")?.textContent?.endsWith("u-untracked.ts"),
    );
    await page.locator(".changes-review-notice", { hasText: "Selection cleared because another file was opened." }).waitFor();
    assert.match(await prompt.inputValue(), /File: "m-modified\.ts"/);
    await prompt.fill(`${await prompt.inputValue()}\nUse the safer name.`);
    await page.locator(".prompt-send").tap();
    await page.locator(".turn-user", { hasText: "Use the safer name." }).waitFor();
    await page.locator(".activity-line").waitFor({ state: "detached", timeout: 30_000 });
    await noSideScroll(page);
  } finally {
    await context.close();
  }
});

test("CR.4: review progress resumes and only the changed revision reopens on desktop and phone", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await context.newPage();
  const waitForRevision = async (target: Page) => {
    await target.waitForFunction(() => {
      const button = document.querySelector(".changes-review-toggle") as HTMLButtonElement | null;
      return Boolean(button && !button.disabled);
    });
  };
  const progressText = (target: Page) => target.locator(".changes-progress").innerText();
  try {
    await page.goto(sessionUrl(changedSession));
    await page.waitForSelector(".ab-changes");
    await page.locator(".ab-changes").click();
    await page.waitForSelector(".changes-current-path");

    // Review three exact revisions, then inspect a different file while one
    // of those revisions changes behind the UI.
    for (const name of ["a-added.ts", "d-deleted.ts", "m-modified.ts"]) {
      await page.locator(".changes-file", { hasText: name }).click();
      await page.waitForFunction(
        (suffix) => document.querySelector(".changes-current-path")?.textContent?.endsWith(String(suffix)),
        name,
      );
      await waitForRevision(page);
      await page.locator(".changes-review-toggle").click();
      assert.equal(await page.locator(".changes-review-toggle").getAttribute("aria-pressed"), "true");
    }
    assert.equal(await progressText(page), "3 / 5 reviewed");
    await page.locator(".changes-file", { hasText: "a-added.ts" }).click();
    await page.waitForFunction(
      () => document.querySelector(".changes-current-path")?.textContent?.endsWith("a-added.ts"),
    );
    writeFileSync(
      path.join(changedRepo, "m-modified.ts"),
      modifiedSource("modified after CR.4 desktop refresh", "tail after"),
    );
    await page.locator(".changes-review-notice", { hasText: "m-modified.ts changed and is unreviewed again." }).waitFor({ timeout: 15_000 });
    assert.equal(await progressText(page), "2 / 5 reviewed");
    assert.match((await page.locator(".changes-file", { hasText: "a-added.ts" }).getAttribute("class")) ?? "", /is-reviewed/);
    assert.match((await page.locator(".changes-file", { hasText: "d-deleted.ts" }).getAttribute("class")) ?? "", /is-reviewed/);
    assert.doesNotMatch((await page.locator(".changes-file", { hasText: "m-modified.ts" }).getAttribute("class")) ?? "", /is-reviewed/);

    // Next-unreviewed lands on the invalidated file. Reduced-motion preference
    // reaches the hunk jump itself, not only the CSS animation kill switch.
    await page.locator(".changes-next-unreviewed").click();
    await page.waitForFunction(
      () => document.querySelector(".changes-current-path")?.textContent?.endsWith("m-modified.ts"),
    );
    await waitForRevision(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
        document.documentElement.dataset.reviewScrollBehavior =
          typeof options === "object" ? String(options.behavior) : "missing";
        Element.prototype.scrollIntoView = original;
      };
    });
    await page.locator('[aria-label="Next changed hunk"]').click();
    assert.equal(
      await page.locator("html").getAttribute("data-review-scroll-behavior"),
      "auto",
      "reduced-motion hunk navigation still requested smooth scrolling",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // R/N are review shortcuts only outside editable controls. In the prompt,
    // the same keys remain ordinary authored text.
    await page.locator(".changes-view").focus();
    await page.keyboard.press("r");
    assert.equal(await progressText(page), "3 / 5 reviewed");
    await page.keyboard.press("n");
    await page.waitForFunction(
      () => document.querySelector(".changes-current-path")?.textContent?.endsWith("u-untracked.ts"),
    );
    const prompt = page.locator(".prompt-box textarea");
    await prompt.fill("");
    await prompt.press("r");
    assert.equal(await prompt.inputValue(), "r");
    assert.equal(await progressText(page), "3 / 5 reviewed", "typing in the prompt marked a file reviewed");
    await prompt.fill("Keep this unsent draft.");
    await page.locator(".prompt-caret").focus();
    await page.keyboard.press("r");
    assert.equal(
      await progressText(page),
      "3 / 5 reviewed",
      "focus elsewhere inside the prompt activated a review shortcut",
    );
    await prompt.fill("");
    await page.locator(".changes-view").dispatchEvent("keydown", { key: "r", repeat: true });
    assert.equal(await progressText(page), "3 / 5 reviewed", "a held shortcut toggled progress repeatedly");
    await page.locator(".changes-view").focus();
    await page.keyboard.press("r");
    assert.equal(await progressText(page), "4 / 5 reviewed");
    await page.keyboard.press("n");
    await page.waitForFunction(
      () => document.querySelector(".changes-current-path")?.textContent?.endsWith("z-binary.bin"),
    );
    await waitForRevision(page);
    await page.locator(".changes-review-toggle").click();
    assert.equal(await progressText(page), "5 / 5 reviewed");
    assert.equal(await page.locator(".changes-next-unreviewed").isDisabled(), true);

    // Closing the surface does not stop its viewport-local watcher bookkeeping:
    // a revision changed while hidden must be reopened honestly on return.
    await page.locator(".ab-changes").click();
    await page.waitForSelector(".changes-panel", { state: "detached" });
    writeFileSync(path.join(changedRepo, "d-deleted.ts"), "deleted path restored during closed review\n");
    await page.waitForTimeout(1_500);
    await page.locator(".ab-changes").click();
    await page.waitForSelector(".changes-current-path");
    assert.equal(await progressText(page), "4 / 5 reviewed");
    await page.locator(".changes-review-notice", { hasText: "d-deleted.ts changed and is unreviewed again." }).waitFor();
    assert.ok((await page.locator(".changes-current-path").innerText()).endsWith("z-binary.bin"));
    await page.locator(".changes-next-unreviewed").click();
    await page.waitForFunction(
      () => document.querySelector(".changes-current-path")?.textContent?.endsWith("d-deleted.ts"),
    );
    await waitForRevision(page);
    await page.locator(".changes-review-toggle").click();
    assert.equal(await progressText(page), "5 / 5 reviewed");

    // At the narrowest desktop width, the added controls introduce no overflow.
    await page.setViewportSize({ width: 641, height: 780 });
    const desktopOverflow = await page.locator(".changes-panel").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    assert.ok(
      desktopOverflow.scrollWidth <= desktopOverflow.clientWidth,
      `641px Changes surface overflows ${desktopOverflow.clientWidth}→${desktopOverflow.scrollWidth}`,
    );
    await noSideScroll(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await assertAxeClean(page, "desktop resumable change review");

    // A second viewport starts with no borrowed checkmarks. Review every file
    // on phone, change one behind it, then wrap directly to that sole reopened
    // revision and resume after closing/reopening the full-screen layer.
    await mobile.goto(sessionUrl(changedSession));
    await mobile.waitForSelector(".sb-changes");
    await mobile.locator(".sb-changes").tap();
    await mobile.waitForSelector(".changes-current-path");
    assert.equal(await progressText(mobile), "0 / 5 reviewed", "review progress leaked between viewports");
    for (let index = 0; index < 5; index += 1) {
      await waitForRevision(mobile);
      await mobile.locator(".changes-review-toggle").tap();
      if (index < 4) {
        await mobile.locator('[aria-label="Next changed file"]').tap();
        await mobile.waitForFunction(
          (position) => document.querySelector(".changes-position")?.textContent?.includes(`${position} / 5`),
          index + 2,
        );
      }
    }
    assert.equal(await progressText(mobile), "5 / 5 reviewed");
    writeFileSync(path.join(changedRepo, "a-added.ts"), "added after CR.4 phone refresh\n");
    await mobile.locator(".changes-review-notice", { hasText: "a-added.ts changed and is unreviewed again." }).waitFor({ timeout: 15_000 });
    assert.equal(await progressText(mobile), "4 / 5 reviewed");
    await mobile.locator(".changes-next-unreviewed").tap();
    await mobile.waitForFunction(
      () => document.querySelector(".changes-current-path")?.textContent?.endsWith("a-added.ts"),
    );
    await waitForRevision(mobile);
    assert.match(await mobile.locator(".changes-view").innerText(), /CR\.4 phone refresh/);
    await mobile.locator(".changes-review-toggle").tap();
    assert.equal(await progressText(mobile), "5 / 5 reviewed");

    const phoneTargets = await mobile.evaluate(() =>
      [".changes-review-toggle", ".changes-next-unreviewed"].map((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { selector, width: rect.width, height: rect.height };
      }),
    );
    for (const target of phoneTargets) {
      assert.ok(target.width >= 40 && target.height >= 40, `${target.selector} is ${target.width}×${target.height}`);
    }
    await noSideScroll(mobile);
    await assertAxeClean(mobile, "phone resumable change review");
    await mobile.locator(".changes-close").tap();
    await mobile.waitForSelector(".changes-panel", { state: "detached" });
    await mobile.locator(".sb-changes").tap();
    await mobile.waitForSelector(".changes-current-path");
    assert.equal(await progressText(mobile), "5 / 5 reviewed");
    assert.ok((await mobile.locator(".changes-current-path").innerText()).endsWith("a-added.ts"));
  } finally {
    await page.close();
    await context.close();
  }
});

test("CR.5: reconnect abandons lost requests, refreshes bytes, and clears unverifiable review progress", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await page.addInitScript(() => {
    const controlled = window as typeof window & {
      __changesSocket?: WebSocket;
      __dropNextChanges?: boolean;
    };
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;
    NativeWebSocket.prototype.send = function (
      this: WebSocket,
      data: Parameters<WebSocket["send"]>[0],
    ) {
      if (controlled.__dropNextChanges && typeof data === "string") {
        try {
          if (JSON.parse(data).type === "fs_changes") {
            controlled.__dropNextChanges = false;
            this.close();
            return;
          }
        } catch {
          // Non-JSON transport frames use the native path.
        }
      }
      nativeSend.call(this, data);
    };
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args, NewTarget) {
        const socket = Reflect.construct(Target, args, NewTarget) as WebSocket;
        controlled.__changesSocket = socket;
        return socket;
      },
    }) as typeof WebSocket;
  });
  try {
    await page.goto(sessionUrl(lifecycleSession));
    await page.waitForSelector(".ab-changes");
    await page.locator(".ab-changes").click();
    await page.waitForSelector(".changes-current-path");
    await page.waitForFunction(
      () => !(document.querySelector(".changes-review-toggle") as HTMLButtonElement)?.disabled,
    );
    await page.locator(".changes-review-toggle").click();
    assert.equal(await page.locator(".changes-progress").innerText(), "1 / 1 reviewed");

    await page.evaluate(() => {
      (window as typeof window & { __changesSocket?: WebSocket }).__changesSocket?.close();
    });
    await page.waitForFunction(
      () => document.querySelector(".sb-dot")?.getAttribute("title") !== "connected",
    );
    writeFileSync(path.join(lifecycleRepo, "tracked.ts"), "after reconnect\n");
    await page.waitForFunction(
      () =>
        document.querySelector(".sb-dot")?.getAttribute("title") === "connected" &&
        document.querySelector(".changes-view")?.textContent?.includes("after reconnect"),
      undefined,
      { timeout: 15_000 },
    );
    assert.equal(await page.locator(".changes-progress").innerText(), "0 / 1 reviewed");

    // Lose an fs_changes reply itself. The reattach must release the pending
    // gate, enable Refresh again, and show the mutation made while offline.
    await page.evaluate(() => {
      (window as typeof window & { __dropNextChanges?: boolean }).__dropNextChanges = true;
    });
    await page.locator(".changes-refresh").click();
    await page.waitForFunction(
      () => document.querySelector(".sb-dot")?.getAttribute("title") !== "connected",
    );
    writeFileSync(path.join(lifecycleRepo, "tracked.ts"), "after lost request\n");
    await page.waitForFunction(
      () =>
        document.querySelector(".sb-dot")?.getAttribute("title") === "connected" &&
        document.querySelector(".changes-view")?.textContent?.includes("after lost request"),
      undefined,
      { timeout: 15_000 },
    );
    assert.equal(await page.locator(".changes-refresh").isDisabled(), false);
    assert.doesNotMatch(await page.locator(".changes-review").innerText(), /Loading workspace changes/);
  } finally {
    await page.close();
  }
});

test("CR.5: manual refresh invalidates every review claim before an unwatched HEAD change", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  try {
    await page.goto(sessionUrl(manualSession));
    await page.waitForSelector(".ab-changes");
    await page.locator(".ab-changes").click();
    await page.waitForSelector(".changes-current-path");
    for (const name of ["a.ts", "b.ts"]) {
      await page.locator(".changes-file", { hasText: name }).click();
      await page.waitForFunction(
        (suffix) => document.querySelector(".changes-current-path")?.textContent?.endsWith(String(suffix)),
        name,
      );
      await page.waitForFunction(
        () => !(document.querySelector(".changes-review-toggle") as HTMLButtonElement)?.disabled,
      );
      await page.locator(".changes-review-toggle").click();
    }
    assert.equal(await page.locator(".changes-progress").innerText(), "2 / 2 reviewed");

    git(manualRepo, "reset", "--soft", "HEAD^");
    await page.locator(".changes-refresh").click();
    assert.equal(await page.locator(".changes-progress").innerText(), "0 / 2 reviewed");
    await page.waitForFunction(
      () => document.querySelector(".changes-view .diff-del")?.textContent?.includes("baseline"),
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(await page.locator(".changes-refresh").isDisabled(), false);
  } finally {
    await page.close();
  }
});

test("CR.5: late Git decoration refreshes Files without invalidating Changes review", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  try {
    await page.goto(sessionUrl(statusSession));
    await page.waitForSelector(".ab-changes");
    await page.locator(".ab-changes").click();
    await page.waitForSelector(".changes-current-path");
    await page.waitForFunction(
      () => !(document.querySelector(".changes-review-toggle") as HTMLButtonElement)?.disabled,
    );
    await page.locator(".changes-review-toggle").click();
    assert.equal(await page.locator(".changes-progress").innerText(), "1 / 1 reviewed");

    await page.locator(".ab-files").click();
    await page.waitForSelector(".files-file-row");
    await page.waitForTimeout(1_500);
    await page.locator(".ab-changes").click();
    await page.waitForSelector(".changes-current-path");
    assert.equal(await page.locator(".changes-progress").innerText(), "1 / 1 reviewed");
  } finally {
    await page.close();
  }
});

test("CR.5: zero visible entries in an incomplete result never claim the tree is clean", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  try {
    await page.goto(sessionUrl(incompleteSession));
    await page.waitForSelector(".ab-changes");
    await page.locator(".ab-changes").click();
    await page.locator(".changes-state strong", { hasText: "Change list is incomplete" }).waitFor();
    assert.equal(await page.locator(".changes-count").innerText(), "0 visible");
    assert.match(await page.locator(".changes-warning").innerText(), /incomplete/i);
    assert.doesNotMatch(await page.locator(".changes-state").innerText(), /working tree is clean/i);
  } finally {
    await page.close();
  }
});

test("CR.2 honest states: no repository, clean tree, and safely refused Git configuration", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  try {
    const cases = [
      [plainSession, "No Git repositories found"],
      [cleanSession, "Working tree is clean"],
      [unsafeSession, "Changes could not be loaded"],
    ] as const;
    for (const [sessionId, expected] of cases) {
      await page.goto(sessionUrl(sessionId));
      await page.waitForSelector(".ab-changes");
      await page.locator(".ab-changes").click();
      await page.locator(".changes-state strong", { hasText: expected }).waitFor();
      assert.equal(await page.locator(".changes-state strong").innerText(), expected);
    }
  } finally {
    await page.close();
  }
});
