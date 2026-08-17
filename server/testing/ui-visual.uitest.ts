import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Browser, BrowserContextOptions, Page, ViewportSize } from "playwright-core";
import {
  enterMockSession,
  launchManagedBrowser,
  withFreshMockPage,
} from "./e2e-harness";
import { assertVisualSnapshot } from "./visual-snapshot";

let browser: Browser;

before(async () => {
  assert.equal(
    process.platform,
    "linux",
    "visual baselines are intentionally Ubuntu-only; the browser matrix is portable",
  );
  browser = await launchManagedBrowser("chromium");
});

after(async () => {
  await browser?.close();
});

const visualContext = (viewport: ViewportSize): BrowserContextOptions => ({
  viewport,
  colorScheme: "light",
  reducedMotion: "reduce",
  deviceScaleFactor: 1,
  locale: "en-US",
  timezoneId: "UTC",
});

async function normalizeSessionFacts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const replacements = [
      [".sb-session", "visual-session"],
      [".sb-version", "v0.0.0"],
      [".prompt-cwd", "~/workspace/mirafold"],
    ] as const;
    for (const [selector, text] of replacements) {
      const element = document.querySelector(selector);
      if (element) element.textContent = text;
    }
    for (const row of document.querySelectorAll(".settings-kv-row")) {
      const label = row.querySelector("dt")?.textContent?.trim();
      const value = row.querySelector("dd");
      if (!value) continue;
      if (label === "folder") value.textContent = "~/workspace/mirafold";
      if (label === "session") value.textContent = "visual-session";
      if (label === "daemon") value.textContent = "v0.0.0";
    }
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

test("visual: onboarding card", async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-onboarding",
      context: visualContext({ width: 1280, height: 900 }),
    },
    async (page) => {
      const cwd = page.locator(".onb-cwd");
      await cwd.waitFor();
      await cwd.fill("/workspace/mirafold");
      await cwd.evaluate((element) => (element as HTMLInputElement).blur());
      await assertVisualSnapshot(browser, page, "onboarding", ".onb-card");
    },
  );
});

test("visual: settled desktop session", async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-desktop",
      context: visualContext({ width: 1280, height: 900 }),
    },
    async (page) => {
      await enterMockSession(page);
      const prompt = page.locator(".prompt-box textarea");
      await prompt.fill("kpi visual baseline");
      await prompt.press("Enter");
      await page.locator(".rc-stat-value", { hasText: "96.8%" }).waitFor();
      await page
        .locator(".turn-assistant", { hasText: "Coverage is climbing as the new tests land." })
        .waitFor();
      await page.locator(".stop-btn").waitFor({ state: "detached" });
      await normalizeSessionFacts(page);
      await assertVisualSnapshot(browser, page, "desktop-session");
    },
  );
});

test("visual: phone settings over a session", async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-phone-settings",
      context: visualContext({ width: 390, height: 844 }),
    },
    async (page) => {
      await enterMockSession(page);
      await page.locator(".sb-settings").click();
      await page.locator(".settings-card").waitFor();
      await normalizeSessionFacts(page);
      await assertVisualSnapshot(browser, page, "phone-settings");
    },
  );
});
