import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type Page } from "playwright-core";
import { launchChrome, withFreshMockSession as freshSession } from "./e2e-harness";

let browser: Browser;

before(async () => {
  browser = await launchChrome();
});

after(async () => {
  await browser?.close();
});

const withFreshMockSession = (token: string, run: (page: Page, base: string) => Promise<void>) =>
  freshSession(browser, token, run);

test("desktop composer: Shift+Enter keeps a multiline draft; Enter sends it", async () => {
  await withFreshMockSession("ui-composer-e2e", async (page) => {
    const prompt = page.locator(".prompt-box textarea");
    await prompt.fill("kpi coverage");
    await prompt.press("Shift+Enter");
    await page.keyboard.type("include details");

    assert.equal(await prompt.inputValue(), "kpi coverage\ninclude details");
    assert.equal(
      await page.locator(".turn-user").count(),
      0,
      "Shift+Enter submitted instead of inserting a newline",
    );

    await prompt.press("Enter");
    const sent = page.locator(".turn-user").last();
    await sent.waitFor();
    assert.equal(await sent.locator(".turn-user-label").count(), 0);
    assert.equal(await sent.locator(".glyph").innerText(), "❯");
    const echoedPrompt = await sent.locator(".turn-user-text").innerText();
    assert.equal(echoedPrompt, "kpi coverage\ninclude details");
    assert.equal(await prompt.inputValue(), "", "sent text remained in the composer");
    await page.locator(".stop-btn").waitFor({ state: "detached", timeout: 30_000 });
  });
});

test("settings modal traps keyboard focus and returns it to the opener", async () => {
  await withFreshMockSession("ui-focus-e2e", async (page) => {
    const opener = page.locator(".sb-settings");
    await opener.click();
    await page.locator(".settings-card").waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains("settings-close"));

    const focusState = () =>
      page.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const active = document.activeElement as HTMLElement | null;
        return {
          inside: Boolean(dialog && active && dialog.contains(active)),
          onClose: active?.classList.contains("settings-close") ?? false,
        };
      });

    assert.deepEqual(await focusState(), { inside: true, onClose: true });
    await page.keyboard.press("Shift+Tab");
    assert.deepEqual(
      await focusState(),
      { inside: true, onClose: false },
      "Shift+Tab escaped the dialog instead of wrapping to its last control",
    );
    await page.keyboard.press("Tab");
    assert.deepEqual(
      await focusState(),
      { inside: true, onClose: true },
      "Tab from the last control did not wrap to the first control",
    );

    await page.keyboard.press("Escape");
    await page.locator(".settings-card").waitFor({ state: "detached" });
    assert.equal(
      await opener.evaluate((element) => document.activeElement === element),
      true,
      "closing settings did not restore focus to its opener",
    );
  });
});

test("status controls stay contained at intermediate and phone boundaries", async () => {
  await withFreshMockSession("ui-status-containment-e2e", async (page) => {
    const prompt = page.locator(".prompt-box textarea");
    await prompt.fill("kpi coverage");
    await prompt.press("Enter");
    await page.locator(".stop-btn").waitFor({ state: "detached", timeout: 30_000 });

    const compactFacts = [
      ".sb-session",
      ".sb-version",
      ".sb-usage",
      ".sb-model",
      ".sb-cwd",
      ".sb-theme",
    ];
    for (const width of [900, 800, 641, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );

      for (const selector of compactFacts) {
        assert.equal(
          await page.locator(selector).evaluateAll((elements) =>
            elements.every((element) => getComputedStyle(element).display === "none"),
          ),
          true,
          `${selector} is still visible at ${width}px`,
        );
      }

      const geometry = await page.locator(".status-bar").evaluate((bar) => {
        const barBox = bar.getBoundingClientRect();
        const controls = [...bar.querySelectorAll<HTMLElement>("a, button, .sb-item")]
          .map((element) => ({
            element,
            style: getComputedStyle(element),
            box: element.getBoundingClientRect(),
          }))
          .filter(
            ({ style, box }) =>
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              box.width >= 0.5 &&
              box.height >= 0.5,
          )
          .map(({ element, box }) => ({
            className: element.className,
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
          }));
        const outside = controls.filter(
          (control) => control.left < barBox.left - 1 || control.right > barBox.right + 1,
        );
        const overlaps: string[] = [];
        for (let i = 0; i < controls.length; i += 1) {
          for (let j = i + 1; j < controls.length; j += 1) {
            const a = controls[i];
            const b = controls[j];
            const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (horizontal > 0.5 && vertical > 0.5) {
              overlaps.push(`${a.className} / ${b.className}`);
            }
          }
        }
        return { outside, overlaps };
      });
      assert.deepEqual(geometry.outside, [], `${width}px status controls leave the bar`);
      assert.deepEqual(geometry.overlaps, [], `${width}px status controls overlap`);
    }
  });
});

test("the segmented theme control paints keyboard focus inside its clipped frame", async () => {
  await withFreshMockSession("ui-theme-focus-e2e", async (page) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.locator(".sb-settings").focus();
    const theme = page.locator(".sb-theme");
    const beforeFocus = await theme.screenshot();
    await page.keyboard.press("Tab");

    const lightTheme = page.locator('.sb-theme-opt[title="Light theme"]');
    const focus = await lightTheme.evaluate((element) => ({
      active: document.activeElement === element,
      focusVisible: element.matches(":focus-visible"),
    }));
    const withFocus = await theme.screenshot();
    assert.equal(focus.active, true, "Tab did not reach the light-theme option");
    assert.equal(focus.focusVisible, true, "keyboard focus did not match :focus-visible");
    assert.equal(
      beforeFocus.equals(withFocus),
      false,
      "keyboard focus makes no visible change inside the clipped theme control",
    );
  });
});

test("ending a session requires two clicks, then returns to an empty fleet", async () => {
  await withFreshMockSession("ui-end-session-e2e", async (page, base) => {
    const sessionUrl = page.url();
    const end = page.locator(".sb-end");

    await end.click();
    assert.equal((await end.innerText()).trim(), "end?");
    assert.equal(await end.getAttribute("title"), "Click again to end this session");
    assert.equal(page.url(), sessionUrl, "the arming click ended the session");
    assert.equal(await page.locator(".prompt-box textarea").isVisible(), true);

    await end.click();
    await page.waitForURL(`${base}/`);
    await page.locator(".agent-picker-agent").first().waitFor();
    assert.equal(
      await page.locator(".fleet-row").count(),
      0,
      "the ended session remained in the otherwise empty fleet",
    );
  });
});

test("ending one of multiple sessions returns to the fleet without opening agent picker", async () => {
  await withFreshMockSession("ui-end-session-with-survivor-e2e", async (page, base) => {
    const remaining = await page.context().newPage();
    await remaining.goto(`${base}/?new=1`);
    await remaining.locator(".agent-picker-agent", { hasText: "Claude Code" }).click();
    await remaining.waitForURL(/\/s\/[\w-]+/);
    const remainingId = new URL(remaining.url()).pathname.split("/").pop()!;

    const end = page.locator(".sb-end");
    await end.click();
    await end.click();
    await page.waitForURL(`${base}/`);
    await page.waitForFunction(
      (id) =>
        document.querySelectorAll(".fleet-row").length === 1 &&
        document.querySelector(".fleet-id")?.textContent === id,
      remainingId,
    );

    assert.equal(await page.locator(".agent-picker-card").count(), 0, "agent picker covered the surviving fleet");
    assert.equal(await page.locator(".fleet-id").innerText(), remainingId);
    await remaining.close();
  });
});
