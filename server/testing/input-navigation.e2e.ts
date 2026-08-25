import assert from "node:assert/strict";
import { MOCK_PROMPTS } from "./mock-prompts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  assertAxeClean,
  enterMockSession,
  launchChrome,
  noSideScroll,
  withFreshMockPage,
} from "./e2e-harness";
import { startDaemon, type Daemon } from "./itest-harness";

let browser: Browser;
const SHORT_REPLY = "The workspace is ready for the next decision.";

before(async () => {
  browser = await launchChrome();
});

after(async () => {
  await browser?.close();
});

async function sendShortTurn(
  page: Page,
  label: string,
  submission: "desktop" | "phone" = "desktop",
): Promise<void> {
  const inputsBefore = await page.locator(".input-nav-stop").count();
  const replies = page.locator(".turn-assistant", { hasText: SHORT_REPLY });
  const repliesBefore = await replies.count();
  const prompt = page.locator(".prompt-box textarea");
  await prompt.fill(`one sentence document ${label}`);
  if (submission === "phone") await page.locator(".prompt-send").tap();
  else await prompt.press("Enter");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".input-nav-stop").length > count,
    inputsBefore,
  );
  await page.waitForFunction(
    ({ text, count }) =>
      [...document.querySelectorAll(".turn-assistant")].filter((element) =>
        element.textContent?.includes(text),
      ).length > count,
    { text: SHORT_REPLY, count: repliesBefore },
    { timeout: 15_000 },
  );
  await page.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });
}

async function sendPlanTurn(page: Page): Promise<void> {
  const inputsBefore = await page.locator(".input-nav-stop").count();
  const prompt = page.locator(".prompt-box textarea");
  await prompt.fill(MOCK_PROMPTS["checklist"]);
  await prompt.press("Enter");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".input-nav-stop").length > count,
    inputsBefore,
  );
}

test("desktop command strips expose direct chronological arrows and keyboard navigation", async () => {
  await withFreshMockPage(
    browser,
    {
      token: "input-navigation-desktop-4f2a",
      context: { reducedMotion: "reduce" },
    },
    async (page) => {
      await page.setViewportSize({ width: 900, height: 440 });
      await enterMockSession(page);

      for (let index = 0; index < 6; index += 1) {
        await sendShortTurn(page, `desktop-${index}`);
      }

      const inputs = page.locator(".input-nav-stop");
      assert.equal(await inputs.count(), 6);
      assert.equal(await page.locator(".input-nav-phone-toggle").count(), 0);
      for (let index = 0; index < 6; index += 1) {
        const arrows = inputs.nth(index).locator(".input-nav-arrow");
        assert.equal(await arrows.count(), 2, `input ${index + 1} lost an arrow`);
        assert.notEqual(await arrows.first().evaluate((element) => getComputedStyle(element).display), "none");
      }
      assert.equal(await inputs.first().locator(".input-nav-older").isDisabled(), true);
      assert.equal(await inputs.last().locator(".input-nav-newer").isDisabled(), true);

      const third = inputs.nth(2);
      const stripBox = await third.boundingBox();
      const arrowsBox = await third.locator(".input-nav-inline").boundingBox();
      assert.ok(stripBox && arrowsBox);
      assert.ok(
        arrowsBox.x + arrowsBox.width <= stripBox.x + stripBox.width + 1,
        "desktop arrows escaped their submitted-input strip",
      );

      const prompt = page.locator(".prompt-box textarea");
      await prompt.fill("unfinished draft");
      await third.locator(".input-nav-older").click();
      assert.equal(await prompt.inputValue(), "unfinished draft", "navigation replaced the draft");
      assert.match((await inputs.nth(1).getAttribute("class")) ?? "", /is-input-nav-current/);
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(".input-nav-stop")),
        true,
        "the destination input did not receive keyboard focus",
      );
      const aligned = await page.evaluate(() => {
        const zone = document.querySelector(".render-zone")!.getBoundingClientRect();
        const current = document.querySelector(".is-input-nav-current")!.getBoundingClientRect();
        return Math.round(current.top - zone.top);
      });
      assert.ok(aligned >= 6 && aligned <= 12, `destination aligned ${aligned}px from the reading edge`);

      // A direct control remains actionable when its destination is already
      // selected: activation also owns scroll/focus, not just the selected id.
      await third.locator(".input-nav-older").click();
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(".is-input-nav-current")),
        true,
        "repeating a direct arrow left focus on the source control",
      );
      await page.keyboard.press("ArrowUp");
      assert.match((await inputs.first().getAttribute("class")) ?? "", /is-input-nav-current/);
      await page.keyboard.press("ArrowDown");
      assert.match((await inputs.nth(1).getAttribute("class")) ?? "", /is-input-nav-current/);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".is-input-nav-current").count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement?.matches(".prompt-box textarea")), true);
      assert.equal(await prompt.inputValue(), "unfinished draft");

      // A non-empty draft keeps ordinary textarea ownership. Once empty, Up
      // enters history at the newest input.
      await prompt.press("ArrowUp");
      assert.equal(await page.locator(".is-input-nav-current").count(), 0);
      await prompt.fill("");
      await prompt.press("ArrowUp");
      assert.match((await inputs.last().getAttribute("class")) ?? "", /is-input-nav-current/);
      await prompt.click();
      assert.equal(await page.locator(".is-input-nav-current").count(), 0);
      await prompt.press("ArrowUp");
      assert.match((await inputs.last().getAttribute("class")) ?? "", /is-input-nav-current/);
      await page.keyboard.press("Escape");

      // Merely focusing a direct arrow does not enter navigation. Its Escape
      // must continue to the shell's page-wide interrupt while a turn works.
      await prompt.fill("do something dangerous");
      await prompt.press("Enter");
      await page.locator(".perm-bar").waitFor({ timeout: 15_000 });
      await inputs.nth(2).locator(".input-nav-older").focus();
      assert.equal(await page.locator(".is-input-nav-current").count(), 0);
      await page.keyboard.press("Escape");
      await page.locator(".stop-btn").waitFor({ state: "detached", timeout: 15_000 });
      await page.locator(".perm-bar").waitFor({ state: "detached", timeout: 15_000 });

      // The existing terminal-style provider picker captures the same key in
      // the capture phase and therefore remains authoritative.
      await prompt.fill("picker demo");
      await prompt.press("Enter");
      await page.locator(".picker-block").waitFor({ timeout: 15_000 });
      const highlightedBefore = await page.locator(".picker-row").evaluateAll((rows) =>
        rows.findIndex((row) => row.classList.contains("picker-highlight")),
      );
      await prompt.press("ArrowUp");
      const highlightedAfter = await page.locator(".picker-row").evaluateAll((rows) =>
        rows.findIndex((row) => row.classList.contains("picker-highlight")),
      );
      assert.notEqual(highlightedAfter, highlightedBefore, "input history stole the provider picker key");
      assert.equal(await page.locator(".is-input-nav-current").count(), 0);
      const pickerInputsBefore = await inputs.count();
      await inputs.nth(2).locator(".input-nav-older").focus();
      await page.keyboard.press("Enter");
      assert.equal(
        await page.locator(".picker-chosen").count(),
        0,
        "Enter on a desktop navigation arrow selected the provider picker",
      );
      assert.equal(await inputs.count(), pickerInputsBefore, "picker submitted a new input");
      assert.match((await inputs.nth(1).getAttribute("class")) ?? "", /is-input-nav-current/);
      await inputs.nth(2).locator(".input-nav-older").focus();
      await page.keyboard.press("Escape");
      assert.match(
        (await page.locator(".picker-block").getAttribute("class")) ?? "",
        /picker-dismissed/,
        "an unselected desktop arrow blocked the provider picker's Escape",
      );

      await assertAxeClean(page, "desktop submitted-input navigation");
      await noSideScroll(page);
    },
  );
});

test("explicit input jumps stay detached until End returns to the live tail", async () => {
  await withFreshMockPage(
    browser,
    {
      token: "input-navigation-tail-4f2a",
      context: { reducedMotion: "reduce" },
    },
    async (page) => {
      await page.setViewportSize({ width: 900, height: 520 });
      await enterMockSession(page);

      for (let index = 0; index < 3; index += 1) {
        const completedBefore = await page
          .locator(".turn-assistant", { hasText: "Plan complete — all four steps done." })
          .count();
        await sendPlanTurn(page);
        await page.waitForFunction(
          (count) =>
            [...document.querySelectorAll(".turn-assistant")].filter((element) =>
              element.textContent?.includes("Plan complete — all four steps done."),
            ).length > count,
          completedBefore,
          { timeout: 30_000 },
        );
        await page.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });
      }

      const todosBefore = await page.locator(".rc-todos").count();
      await sendPlanTurn(page);
      await page.waitForFunction(
        (count) => document.querySelectorAll(".rc-todos").length > count,
        todosBefore,
        { timeout: 15_000 },
      );

      const inputs = page.locator(".input-nav-stop");
      await inputs.last().locator(".input-nav-older").click();
      await page.keyboard.press("ArrowDown");

      const atJump = await page.locator(".render-zone").evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
      }));
      assert.ok(
        atJump.bottom <= 24,
        `newest jump did not exercise the bottom boundary: ${JSON.stringify(atJump)}`,
      );

      await page.waitForFunction(
        (height) => document.querySelector(".render-zone")!.scrollHeight > height + 30,
        atJump.height,
        { timeout: 5_000 },
      );
      const afterGrowth = await page.locator(".render-zone").evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
      }));
      assert.ok(
        Math.abs(afterGrowth.top - atJump.top) <= 1,
        `live output moved the explicitly detached viewport: ${JSON.stringify({ atJump, afterGrowth })}`,
      );

      // End is the established keyboard return-to-tail gesture. Exercise the
      // no-movement edge: navigation itself lands at the current bottom, so
      // End must arm synchronously rather than wait for a scroll event that
      // the browser has no reason to emit.
      await page.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });
      const nextTodosBefore = await page.locator(".rc-todos").count();
      await sendPlanTurn(page);
      await page.waitForFunction(
        (count) => document.querySelectorAll(".rc-todos").length > count,
        nextTodosBefore,
        { timeout: 15_000 },
      );
      await inputs.last().locator(".input-nav-older").click();
      await page.keyboard.press("ArrowDown");
      const beforeEnd = await page.locator(".render-zone").evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
      }));
      assert.ok(beforeEnd.bottom <= 24, `End premise was not at bottom: ${JSON.stringify(beforeEnd)}`);

      await page.keyboard.press("End");
      await page.waitForFunction(
        (height) => document.querySelector(".render-zone")!.scrollHeight > height + 30,
        beforeEnd.height,
        { timeout: 5_000 },
      );
      const afterEnd = await page.locator(".render-zone").evaluate((element) => ({
        top: element.scrollTop,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
      }));
      assert.ok(
        afterEnd.top > beforeEnd.top && afterEnd.bottom <= 24,
        `End did not resume following: ${JSON.stringify({ beforeEnd, afterEnd })}`,
      );

      // The transcript scroller is also a documented keyboard PageUp/End
      // stop. Its no-motion End must carry the same explicit return intent.
      await page.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });
      const scrollerTodosBefore = await page.locator(".rc-todos").count();
      await sendPlanTurn(page);
      await page.waitForFunction(
        (count) => document.querySelectorAll(".rc-todos").length > count,
        scrollerTodosBefore,
        { timeout: 15_000 },
      );
      await inputs.last().locator(".input-nav-older").click();
      await page.keyboard.press("ArrowDown");
      const beforeScrollerEnd = await page.locator(".render-zone").evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
      }));
      assert.ok(
        beforeScrollerEnd.bottom <= 24,
        `scroller End premise was not at bottom: ${JSON.stringify(beforeScrollerEnd)}`,
      );
      await page.locator(".render-zone").focus();
      await page.keyboard.press("End");
      await page.waitForFunction(
        (height) => document.querySelector(".render-zone")!.scrollHeight > height + 30,
        beforeScrollerEnd.height,
        { timeout: 5_000 },
      );
      const afterScrollerEnd = await page.locator(".render-zone").evaluate((element) => ({
        top: element.scrollTop,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
      }));
      assert.ok(
        afterScrollerEnd.top > beforeScrollerEnd.top && afterScrollerEnd.bottom <= 24,
        `scroller End did not resume following: ${JSON.stringify({ beforeScrollerEnd, afterScrollerEnd })}`,
      );
    },
  );
});

test("phone disclosure selects the input governing a non-tail response", async () => {
  await withFreshMockPage(
    browser,
    {
      token: "input-navigation-phone-viewport-4f2a",
      context: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    async (page) => {
      await enterMockSession(page);
      for (let index = 0; index < 6; index += 1) {
        await sendShortTurn(page, `phone-viewport-${index}`, "phone");
      }

      // Put the reading edge inside an earlier response, not on an input row
      // and not within the tail's 24px bottom slack. The expected row comes
      // from the real rendered coordinates, independently of the hook.
      const expectedIndex = await page.evaluate(() => {
        const scroller = document.querySelector(".render-zone") as HTMLElement;
        const inputs = [...document.querySelectorAll(".input-nav-stop")];
        const readingEdge = scroller.getBoundingClientRect().top + 1;
        const maximumScrollTop = scroller.scrollHeight - scroller.clientHeight;
        for (let index = 0; index < inputs.length - 1; index += 1) {
          const current = inputs[index].getBoundingClientRect();
          const next = inputs[index + 1].getBoundingClientRect();
          const responseMidpoint = (current.bottom + next.top) / 2;
          const desiredScrollTop = scroller.scrollTop + responseMidpoint - readingEdge;
          if (desiredScrollTop > 0 && desiredScrollTop < maximumScrollTop - 24) {
            scroller.scrollTop = desiredScrollTop;
            return index;
          }
        }
        return -1;
      });
      assert.notEqual(expectedIndex, -1, "fixture could not expose an earlier response at the reading edge");
      await page.waitForFunction(() => {
        const scroller = document.querySelector(".render-zone") as HTMLElement;
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 24;
      });
      const premise = await page.evaluate((index) => {
        const scroller = document.querySelector(".render-zone") as HTMLElement;
        const inputs = [...document.querySelectorAll(".input-nav-stop")];
        const readingEdge = scroller.getBoundingClientRect().top + 1;
        const current = inputs[index].getBoundingClientRect();
        const next = inputs[index + 1].getBoundingClientRect();
        return {
          insideResponse: current.bottom < readingEdge && readingEdge < next.top,
          bottomGap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        };
      }, expectedIndex);
      assert.equal(premise.insideResponse, true, "reading edge did not land inside response space");
      assert.ok(premise.bottomGap > 24, `fixture remained within ${premise.bottomGap}px of the tail`);

      await page.locator(".input-nav-phone-toggle").tap();
      const card = page.locator(".input-nav-phone-card");
      await card.waitFor();
      assert.match(await card.innerText(), new RegExp(`input ${expectedIndex + 1} of 6`, "i"));
      assert.match(
        (await page.locator(".input-nav-stop").nth(expectedIndex).getAttribute("class")) ?? "",
        /is-input-nav-current/,
      );
      assert.notEqual(expectedIndex, 5, "fixture accidentally selected the newest input");
    },
  );
});

test("full transcript replay recovers navigation focus without summoning the phone prompt", async () => {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-input-nav-replay-"));
  let daemon: Daemon | undefined;
  let page: Page | undefined;
  let phoneContext: BrowserContext | undefined;
  try {
    daemon = await startDaemon({ MIRAFOLD_TOKEN: "", MIRAFOLD_SESSION_DIR: sessionDir });
    page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 520 });
    await page.goto(`http://127.0.0.1:${daemon.port}/`);
    await enterMockSession(page);
    await sendShortTurn(page, "replay-one");
    await sendShortTurn(page, "replay-two");

    await page.locator(".input-nav-stop").last().locator(".input-nav-older").click();
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".input-nav-stop")),
      true,
    );
    const oldDestination = await page.locator(".is-input-nav-current").elementHandle();
    assert.ok(oldDestination);

    const port = daemon.port;
    await daemon.stop();
    daemon = undefined;
    daemon = await startDaemon({
      MIRAFOLD_TOKEN: "",
      MIRAFOLD_SESSION_DIR: sessionDir,
      PORT: String(port),
    });
    assert.equal(daemon.port, port, "restart re-bound a different port");
    await page.waitForFunction((element) => !element.isConnected, oldDestination, {
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".input-nav-stop").length >= 2,
      undefined,
      { timeout: 30_000 },
    );

    assert.equal(await page.locator(".is-input-nav-current").count(), 0);
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".prompt-box textarea")),
      true,
      "replay removed the keyboard-owned destination without recovering prompt focus",
    );

    const sessionUrl = page.url();
    await page.close();
    phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    page = await phoneContext.newPage();
    await page.goto(sessionUrl);
    await page.waitForFunction(
      () => document.querySelectorAll(".input-nav-stop").length >= 2,
      undefined,
      { timeout: 30_000 },
    );
    await page.locator(".input-nav-phone-toggle").tap();
    const older = page.getByRole("button", { name: "Go to older input" });
    await older.tap();
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".prompt-box textarea")),
      false,
      "phone navigation focused the prompt before replay",
    );
    // A hardware-keyboard move can focus the destination strip on phone, but
    // it must not reclassify the phone-owned selection as desktop ownership.
    await page.locator(".is-input-nav-current").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".is-input-nav-current")),
      true,
    );
    const oldPhoneDestination = await page.locator(".is-input-nav-current").elementHandle();
    assert.ok(oldPhoneDestination);

    await daemon.stop();
    daemon = undefined;
    daemon = await startDaemon({
      MIRAFOLD_TOKEN: "",
      MIRAFOLD_SESSION_DIR: sessionDir,
      PORT: String(port),
    });
    assert.equal(daemon.port, port, "phone replay restart re-bound a different port");
    await page.waitForFunction((element) => !element.isConnected, oldPhoneDestination, {
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".input-nav-stop").length >= 2,
      undefined,
      { timeout: 30_000 },
    );

    assert.equal(await page.locator(".is-input-nav-current").count(), 0);
    assert.equal(await page.locator(".input-nav-phone-card").count(), 0);
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".render-zone")),
      true,
      "phone replay summoned the prompt instead of recovering to the transcript",
    );
  } finally {
    await page?.close();
    await phoneContext?.close();
    await daemon?.stop();
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("phone discloses temporary navigation directly above the submit arrow", async () => {
  await withFreshMockPage(
    browser,
    {
      token: "input-navigation-phone-4f2a",
      context: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    async (page) => {
      await enterMockSession(page);
      await sendShortTurn(page, "phone-one", "phone");
      const chromeWithoutNavigation = await page.evaluate(() => {
        const prompt = document.querySelector(".prompt-box")!.getBoundingClientRect();
        const status = document.querySelector(".status-bar")!.getBoundingClientRect();
        return { promptTop: prompt.top, promptHeight: prompt.height, statusTop: status.top };
      });
      assert.equal(
        await page.locator(".input-nav-phone-toggle").count(),
        0,
        "one input should not surface navigation",
      );
      await sendShortTurn(page, "phone-two", "phone");

      const toggle = page.locator(".input-nav-phone-toggle");
      await toggle.waitFor();
      assert.equal(
        await page.locator(".input-nav-inline").first().evaluate((element) => getComputedStyle(element).display),
        "none",
        "desktop arrows consumed phone input width",
      );
      const geometry = await page.evaluate(() => {
        const prompt = document.querySelector(".prompt-box")!.getBoundingClientRect();
        const send = document.querySelector(".prompt-send")!.getBoundingClientRect();
        const dots = document.querySelector(".input-nav-phone-toggle")!.getBoundingClientRect();
        const status = document.querySelector(".status-bar")!.getBoundingClientRect();
        return {
          promptTop: prompt.top,
          statusTop: status.top,
          sendCenter: send.left + send.width / 2,
          dotsCenter: dots.left + dots.width / 2,
          dotsBottom: dots.bottom,
          dotsHeight: dots.height,
          promptHeight: prompt.height,
        };
      });
      assert.equal(geometry.promptTop, chromeWithoutNavigation.promptTop, "⋯ added prompt-area height");
      assert.equal(geometry.promptHeight, chromeWithoutNavigation.promptHeight, "⋯ resized the prompt box");
      assert.equal(geometry.statusTop, chromeWithoutNavigation.statusTop, "⋯ moved the status bar");
      assert.ok(Math.abs(geometry.sendCenter - geometry.dotsCenter) <= 1, "⋯ is not above submit");
      assert.ok(geometry.dotsBottom <= geometry.promptTop, "⋯ overlaps the prompt box");
      assert.ok(geometry.dotsHeight >= 40, `⋯ touch target is ${geometry.dotsHeight}px`);

      const prompt = page.locator(".prompt-box textarea");
      await prompt.fill("phone draft stays here");
      await toggle.tap();
      const card = page.locator(".input-nav-phone-card");
      await card.waitFor();
      assert.match(await card.innerText(), /input 2 of 2/i);
      assert.equal(await card.getByRole("button", { name: "Go to newer input" }).isDisabled(), true);
      assert.equal(await prompt.inputValue(), "phone draft stays here");

      // Disclosure follows its trigger in DOM order: a keyboard user opening
      // it can continue forward into the newly revealed actions.
      await toggle.focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "Go to older input",
      );
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(".input-nav-phone-toggle")),
        true,
      );
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Escape");
      assert.equal(await card.isVisible(), true, "modified Escape closed phone navigation");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "Go to older input",
      );
      await page.keyboard.press("Escape");
      await card.waitFor({ state: "detached" });
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(".input-nav-phone-toggle")),
        true,
        "Escape closed the phone actions without returning focus to their trigger",
      );
      await page.keyboard.press("Enter");
      await card.waitFor();

      const expandedGeometry = await page.evaluate(() => {
        const prompt = document.querySelector(".prompt-box")!.getBoundingClientRect();
        const card = document.querySelector(".input-nav-phone-card")!.getBoundingClientRect();
        const status = document.querySelector(".status-bar")!.getBoundingClientRect();
        return { promptTop: prompt.top, statusTop: status.top, cardRight: card.right, cardTop: card.top };
      });
      assert.equal(expandedGeometry.promptTop, geometry.promptTop, "opening navigation moved the prompt");
      assert.equal(expandedGeometry.statusTop, geometry.statusTop, "opening navigation moved the status bar");
      assert.ok(expandedGeometry.cardRight <= 390 && expandedGeometry.cardTop >= 0);

      // Keyboard focus leaving this temporary disclosure closes it before the
      // destination control can open a modal. Otherwise phone navigation and
      // Settings both own capture-phase Escape, so the hidden disclosure can
      // steal the first keypress and move focus outside the modal.
      const settingsButton = page.locator(".sb-settings");
      await settingsButton.focus();
      await card.waitFor({ state: "detached" });
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await page.keyboard.press("Enter");
      const settings = page.locator(".settings-card");
      await settings.waitFor();
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "detached" });
      assert.equal(await card.count(), 0, "closing Settings exposed stale phone navigation");
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(".sb-settings")),
        true,
        "Settings did not return focus to its keyboard opener",
      );
      await toggle.focus();
      await page.keyboard.press("Enter");
      await card.waitFor();

      await card.getByRole("button", { name: "Go to older input" }).tap();
      await page.waitForFunction(() =>
        document.querySelector(".input-nav-phone-count")?.textContent?.includes("1 of 2"),
      );
      assert.match(
        (await page.locator(".input-nav-stop").first().getAttribute("class")) ?? "",
        /is-input-nav-current/,
      );
      assert.equal(await card.isVisible(), true, "navigation closed after one move");
      assert.equal(await card.getByRole("button", { name: "Go to older input" }).isDisabled(), true);
      assert.equal(await card.getByRole("button", { name: "Go to newer input" }).isDisabled(), false);
      assert.equal(await prompt.inputValue(), "phone draft stays here");

      for (const button of await card.getByRole("button").all()) {
        const box = await button.boundingBox();
        assert.ok(box && box.height >= 40, `phone navigation target is ${box?.height}px`);
      }
      await assertAxeClean(page, "phone submitted-input navigation");
      await noSideScroll(page);

      await page.locator(".render-zone").tap({ position: { x: 4, y: 4 } });
      await card.waitFor({ state: "detached" });
      assert.equal(await prompt.inputValue(), "phone draft stays here");
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(".prompt-box textarea") ?? false),
        false,
        "closing phone navigation summoned the keyboard",
      );

      // Phone navigation gets one Escape action even while the transcript's
      // provider picker is live; a second Escape can then dismiss the picker.
      await prompt.fill("picker demo");
      await page.locator(".prompt-send").tap();
      const picker = page.locator(".picker-block");
      await picker.waitFor({ timeout: 15_000 });
      await toggle.tap();
      await card.waitFor();
      await card.getByRole("button", { name: "Go to older input" }).focus();
      await page.keyboard.press("Shift+Escape");
      assert.equal(await card.isVisible(), true, "modified Escape closed phone navigation");
      assert.doesNotMatch(
        (await picker.getAttribute("class")) ?? "",
        /picker-dismissed/,
        "modified Escape dismissed the provider picker beneath phone navigation",
      );
      const pickerPositionBefore = await card.locator(".input-nav-phone-count").textContent();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (before) => document.querySelector(".input-nav-phone-count")?.textContent !== before,
        pickerPositionBefore,
      );
      assert.equal(
        await picker.locator(".picker-chosen").count(),
        0,
        "Enter on phone navigation selected the provider picker",
      );
      await page.keyboard.press("Escape");
      await card.waitFor({ state: "detached" });
      assert.doesNotMatch(
        (await picker.getAttribute("class")) ?? "",
        /picker-dismissed/,
        "one Escape closed both phone navigation and the provider picker",
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(() =>
        document.querySelector(".picker-block")?.classList.contains("picker-dismissed"),
      );

      // The anchor occupies the strip immediately above the prompt. A
      // permission request owns that space and its answer buttons take
      // priority; navigation returns as soon as the request resolves.
      await prompt.fill("do something dangerous");
      await page.locator(".prompt-send").tap();
      await page.locator(".perm-bar").waitFor({ timeout: 15_000 });
      assert.equal(await page.locator(".input-nav-phone-toggle").count(), 0);
      await page.locator(".perm-deny").tap();
      await page.locator(".perm-bar").waitFor({ state: "detached", timeout: 15_000 });
      await page.locator(".input-nav-phone-toggle").waitFor();

      // Reaching an endpoint during a live turn can leave BODY focused when
      // the tapped button disables itself. Turn completion must not treat that
      // as permission to focus the phone prompt and close navigation.
      await prompt.fill(MOCK_PROMPTS["checklist"]);
      await page.locator(".prompt-send").tap();
      await page.locator(".activity-line").waitFor({ timeout: 15_000 });
      await toggle.tap();
      await card.waitFor();
      const liveOlder = card.getByRole("button", { name: "Go to older input" });
      const liveInputCount = await page.locator(".input-nav-stop").count();
      for (let step = 1; step < liveInputCount; step += 1) {
        if (await liveOlder.isDisabled()) break;
        const positionBeforeMove = await card.locator(".input-nav-phone-count").textContent();
        await liveOlder.tap();
        await page.waitForFunction(
          (before) => document.querySelector(".input-nav-phone-count")?.textContent !== before,
          positionBeforeMove,
          { timeout: 3_000 },
        );
      }
      assert.equal(
        await liveOlder.isDisabled(),
        true,
        "older movement never reached its endpoint",
      );
      assert.equal(
        await page.evaluate(() => document.activeElement === document.body),
        true,
        "endpoint premise did not leave phone focus on the body",
      );
      await page.locator(".activity-line").waitFor({ state: "detached", timeout: 30_000 });
      assert.equal(await card.isVisible(), true, "turn completion closed phone navigation");
      assert.equal(await page.locator(".is-input-nav-current").count(), 1);
      assert.equal(
        await page.evaluate(() => document.activeElement?.matches(".prompt-box textarea") ?? false),
        false,
        "turn completion summoned the phone prompt",
      );

      // An upload strip owns the same prompt-adjacent space. Use the local
      // oversize refusal so the fixture is deterministic and never reads or
      // sends the file bytes; dismissal must hand the anchor back.
      await toggle.tap();
      await card.waitFor({ state: "detached" });
      await page.evaluate(`
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(10_000_001)], "history-too-large.bin"));
        document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
        document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      `);
      const uploadError = page.locator(".drop-chip.is-error");
      await uploadError.waitFor();
      assert.equal(
        await page.locator(".input-nav-phone-toggle").count(),
        0,
        "submitted-input navigation competed with the upload strip",
      );
      await uploadError.locator(".drop-chip-dismiss").tap();
      await uploadError.waitFor({ state: "detached" });
      await toggle.waitFor();

      // A live ! command both becomes a submitted-input stop and temporarily
      // yields the phone anchor to its stdin bar. Killing it returns the
      // anchor, whose viewport selection must include the new bang row.
      const inputsBeforeBang = await page.locator(".input-nav-stop").count();
      await prompt.fill("!sleep 20");
      await page.locator(".prompt-send").tap();
      const bangInput = page.locator(".bang-bar-input");
      await bangInput.waitFor({ timeout: 15_000 });
      assert.equal(
        await page.locator(".input-nav-phone-toggle").count(),
        0,
        "submitted-input navigation competed with live shell input",
      );
      const bangStop = page.locator(".turn-bang.input-nav-stop").last();
      await bangStop.waitFor();
      assert.equal(await bangStop.locator(".input-nav-arrow").count(), 2);
      assert.equal(await page.locator(".input-nav-stop").count(), inputsBeforeBang + 1);
      await bangInput.focus();
      await page.keyboard.press("Escape");
      await bangInput.waitFor({ state: "detached", timeout: 15_000 });
      await toggle.waitFor();
      await toggle.tap();
      await card.waitFor();
      const bangNewer = card.getByRole("button", { name: "Go to newer input" });
      for (let step = 1; step < inputsBeforeBang + 1; step += 1) {
        if (await bangNewer.isDisabled()) break;
        const positionBeforeMove = await card.locator(".input-nav-phone-count").innerText();
        await bangNewer.tap();
        await page.waitForFunction(
          (before) => document.querySelector(".input-nav-phone-count")?.textContent !== before,
          positionBeforeMove,
          { timeout: 3_000 },
        );
      }
      assert.equal(await bangNewer.isDisabled(), true, "newer movement never reached the bang row");
      assert.match(
        await card.locator(".input-nav-phone-count").innerText(),
        new RegExp(`input ${inputsBeforeBang + 1} of ${inputsBeforeBang + 1}`, "i"),
      );
      assert.match((await bangStop.getAttribute("class")) ?? "", /is-input-nav-current/);
    },
  );
});
