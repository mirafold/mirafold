import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type Page } from "playwright-core";
import { enterMockSession, launchChrome, withFreshMockPage } from "./e2e-harness";

let browser: Browser;

before(async () => {
  browser = await launchChrome();
});

after(async () => {
  await browser?.close();
});

async function withFreshMockSession(
  token: string,
  run: (page: Page, base: string) => Promise<void>,
): Promise<void> {
  await withFreshMockPage(browser, { token }, async (page, base) => {
    await enterMockSession(page);
    await run(page, base);
  });
}

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
    const echoedPrompt = await sent.evaluate((element) =>
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim(),
    );
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
    await page.locator(".onb-agent").first().waitFor();
    assert.equal(
      await page.locator(".fleet-row").count(),
      0,
      "the ended session remained in the otherwise empty fleet",
    );
  });
});
