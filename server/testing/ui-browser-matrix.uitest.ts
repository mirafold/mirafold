import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enterMockSession,
  launchManagedBrowser,
  MANAGED_BROWSER_NAMES,
  noSideScroll,
  withFreshMockPage,
} from "./e2e-harness";

// One representative shell journey per engine, not the 103-case Chrome suite
// multiplied three ways. This catches engine-specific JavaScript, WebSocket,
// keyboard, modal, and layout failures while keeping the PR gate bounded.
for (const browserName of MANAGED_BROWSER_NAMES) {
  test(
    `${browserName}: onboarding, a rendered turn, settings, and containment work`,
    { timeout: 45_000 },
    async () => {
      const token = `ui-matrix-${browserName}`;
      const browser = await launchManagedBrowser(browserName);
      try {
        await withFreshMockPage(
          browser,
          {
            token,
            context: {
              viewport: { width: 1180, height: 800 },
              colorScheme: "light",
              reducedMotion: "reduce",
            },
          },
          async (page, _base, pageErrors) => {
            assert.equal(
              (await page.locator(".onb-title").innerText()).trim(),
              "Choose your agent",
            );
            await noSideScroll(page);

            await enterMockSession(page);
            const prompt = page.locator(".prompt-box textarea");
            await prompt.fill("kpi browser compatibility");
            await prompt.press("Enter");

            await page.locator(".rc-stat-value", { hasText: "96.8%" }).waitFor();
            await page
              .locator(".turn-assistant", {
                hasText: "Coverage is climbing as the new tests land.",
              })
              .waitFor();
            await page.locator(".stop-btn").waitFor({ state: "detached" });
            assert.equal(
              await page.locator(".rc-stat").count(),
              1,
              "the KPI update duplicated its card",
            );

            await page.locator(".sb-settings").click();
            const settings = page.locator(".settings-card");
            await settings.waitFor();
            assert.equal(
              (await settings.locator(".settings-title").innerText()).trim(),
              "settings",
            );
            await page.keyboard.press("Escape");
            await settings.waitFor({ state: "detached" });
            await noSideScroll(page);
            assert.deepEqual(
              pageErrors.map((error) => error.message),
              [],
              `${browserName} raised an uncaught page error`,
            );
          },
        );
      } finally {
        await browser.close();
      }
    },
  );
}
