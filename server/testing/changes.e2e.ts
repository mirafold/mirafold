import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ClientMsg } from "../protocol";
import { assertAxeClean, launchChrome, noSideScroll } from "./e2e-harness";
import { fixtureGit as git, startDaemon, TestClient, type Daemon } from "./itest-harness";

// CR.2/CR.3 in a real browser against a real daemon and real Git: responsive
// review, every honest state, line/hunk selection, and editable prompt drafts.

const TOKEN = "changes-e2e-token";

let daemon: Daemon;
let browser: Browser;
let fixtureRoot: string;
let changedRepo: string;
let plainRoot: string;
let cleanRepo: string;
let unsafeRepo: string;
let changedSession: string;
let plainSession: string;
let cleanSession: string;
let unsafeSession: string;
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
  for (const root of [changedRepo, plainRoot, cleanRepo, unsafeRepo]) mkdirSync(root);

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

  daemon = await startDaemon({
    MIRAFOLD_TOKEN: TOKEN,
    FS_CHANGES_MAX_ENTRIES: "5",
  });
  changedSession = await createSession(changedRepo);
  plainSession = await createSession(plainRoot);
  cleanSession = await createSession(cleanRepo);
  unsafeSession = await createSession(unsafeRepo);
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
