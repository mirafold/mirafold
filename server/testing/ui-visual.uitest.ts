import { after, before, test } from "node:test";
import { MOCK_PROMPTS } from "./mock-prompts";
import type { Browser, BrowserContextOptions, Page, ViewportSize } from "playwright-core";
import {
  enterMockSession,
  launchManagedBrowser,
  withFreshMockPage,
} from "./e2e-harness";
import { assertVisualSnapshot } from "./visual-snapshot";

let browser: Browser;

// The committed PNGs are Ubuntu-24.04/managed-Chromium renders. Elsewhere the
// suite skips (a red run on a Mac would prove nothing); the browser matrix
// next to it stays portable.
const LINUX_ONLY = process.platform === "linux" ? false : "visual baselines are Ubuntu-only";

before(async () => {
  if (LINUX_ONLY) return;
  browser = await launchManagedBrowser("chromium");
});

after(async () => {
  await browser?.close();
});

// The daemon advertises its native folder picker only when the host has a
// display and a picker binary, and agent picker renders "browse…" from that
// flag. Headless CI has neither, so pin the daemon to "no display" everywhere
// and the card renders identically on a desktop and on a runner.
const HEADLESS_DAEMON_ENV = { DISPLAY: "", WAYLAND_DISPLAY: "" };

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
    // The cwd button is direction:rtl (left-side ellipsis) and relies on LRM
    // sentinels to keep the path in reading order — replace it the same way.
    const replacements = [
      [".sb-session", "visual-session"],
      [".sb-version", "v0.0.0"],
      [".prompt-cwd", "\u200E~/workspace/mirafold\u200E"],
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

async function settleKpiTurn(page: Page, text: string): Promise<void> {
  const inputs = page.locator(".input-nav-stop");
  const stats = page.locator(".rc-stat-value", { hasText: "96.8%" });
  const replies = page.locator(".turn-assistant", {
    hasText: "Coverage is climbing as the new tests land.",
  });
  const inputsBefore = await inputs.count();
  const statsBefore = await stats.count();
  const repliesBefore = await replies.count();
  const prompt = page.locator(".prompt-box textarea");
  await prompt.fill(text);
  await prompt.press("Enter");
  await inputs.nth(inputsBefore).waitFor();
  await stats.nth(statsBefore).waitFor();
  await replies.nth(repliesBefore).waitFor();
  await page.locator(".stop-btn").waitFor({ state: "detached" });
}

async function settleLiveDocument(page: Page): Promise<void> {
  const prompt = page.locator(".prompt-box textarea");
  await prompt.fill(MOCK_PROMPTS["live-document"]);
  await prompt.press("Enter");
  await page
    .locator(".turn-assistant", { hasText: "response finished as one live composition" })
    .waitFor();
  await page.locator(".stop-btn").waitFor({ state: "detached" });
  await page.locator(".output-zone").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator(".jump-to-latest.is-visible").waitFor();
}

test("visual: agent-picker card", { skip: LINUX_ONLY }, async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-agent-picker",
      env: HEADLESS_DAEMON_ENV,
      context: visualContext({ width: 1280, height: 900 }),
    },
    async (page) => {
      const cwd = page.locator(".agent-picker-cwd");
      await cwd.waitFor();
      await cwd.fill("/workspace/mirafold");
      await cwd.evaluate((element) => (element as HTMLInputElement).blur());
      await assertVisualSnapshot(browser, page, "agent-picker", ".agent-picker-card");
    },
  );
});

test("visual: settled desktop session", { skip: LINUX_ONLY }, async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-desktop",
      env: HEADLESS_DAEMON_ENV,
      context: visualContext({ width: 1280, height: 900 }),
    },
    async (page) => {
      await enterMockSession(page);
      await settleKpiTurn(page, "kpi visual baseline");
      await normalizeSessionFacts(page);
      await assertVisualSnapshot(browser, page, "desktop-session");
    },
  );
});

test("visual: settled desktop session, light theme", { skip: LINUX_ONLY }, async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-desktop-light",
      env: HEADLESS_DAEMON_ENV,
      context: visualContext({ width: 1280, height: 900 }),
    },
    async (page) => {
      await enterMockSession(page);
      await page.locator('.sb-theme-opt[title="Light theme"]').click();
      await page.locator('.sb-theme-opt[title="Light theme"][aria-pressed="true"]').waitFor();
      await settleKpiTurn(page, "kpi visual baseline");
      await normalizeSessionFacts(page);
      await assertVisualSnapshot(browser, page, "desktop-session-light");
    },
  );
});

test("visual: in-session cockpit with transcript and prompt disclosures", { skip: LINUX_ONLY }, async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-cockpit",
      env: HEADLESS_DAEMON_ENV,
      context: visualContext({ width: 1280, height: 900 }),
    },
    async (page, base) => {
      await enterMockSession(page);
      const second = await page.context().newPage();
      await second.goto(`${base}/?token=ui-visual-cockpit&new=1`);
      await enterMockSession(second);
      await settleKpiTurn(second, "kpi cockpit preview");

      await page.locator(".ab-cockpit").click();
      await page.waitForFunction(() => document.querySelectorAll(".cockpit-item").length === 2);
      const secondRow = page.locator(".cockpit-item").nth(1);
      await secondRow.locator(".cockpit-transcript-toggle").click();
      await secondRow.locator(".cockpit-prompt-toggle").click();
      await secondRow.locator(".cockpit-transcript-text", { hasText: "kpi cockpit preview" }).waitFor();
      await normalizeSessionFacts(page);
      await page.evaluate(() => {
        document.querySelectorAll(".cockpit-session-name").forEach((element, index) => {
          element.textContent = index === 0 ? "current session" : "second session";
        });
        document.querySelectorAll(".cockpit-session-id").forEach((element, index) => {
          element.textContent = index === 0 ? "session-a" : "session-b";
        });
      });
      await assertVisualSnapshot(browser, page, "cockpit-panel");
      await second.close();
    },
  );
});

test("visual: enabled submitted-input navigation, both themes", { skip: LINUX_ONLY }, async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-input-navigation",
      env: HEADLESS_DAEMON_ENV,
      context: visualContext({ width: 1280, height: 900 }),
    },
    async (page) => {
      await enterMockSession(page);
      for (let index = 0; index < 3; index += 1) {
        await settleKpiTurn(page, "kpi visual baseline");
      }
      await normalizeSessionFacts(page);
      const middleNavigation = page.locator(".input-nav-stop").nth(1);
      await middleNavigation.evaluate((element) => element.setAttribute("data-visual-navigation", ""));
      await middleNavigation.locator(".input-nav-older:not(:disabled)").waitFor();
      await middleNavigation.locator(".input-nav-newer:not(:disabled)").waitFor();

      await page.locator('.sb-theme-opt[title="Dark theme"]').click();
      await page.locator('.sb-theme-opt[title="Dark theme"][aria-pressed="true"]').waitFor();
      await assertVisualSnapshot(
        browser,
        page,
        "submitted-input-navigation",
        "[data-visual-navigation] .input-nav-inline",
      );

      await page.locator('.sb-theme-opt[title="Light theme"]').click();
      await page.locator('.sb-theme-opt[title="Light theme"][aria-pressed="true"]').waitFor();
      await assertVisualSnapshot(
        browser,
        page,
        "submitted-input-navigation-light",
        "[data-visual-navigation] .input-nav-inline",
      );
    },
  );
});

test("visual: live document composition", { skip: LINUX_ONLY }, async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-live-document",
      env: HEADLESS_DAEMON_ENV,
      context: visualContext({ width: 1440, height: 1100 }),
    },
    async (page) => {
      await enterMockSession(page);
      await settleLiveDocument(page);
      await normalizeSessionFacts(page);
      await assertVisualSnapshot(browser, page, "live-document");
    },
  );
});

test("visual: live document composition, light theme", { skip: LINUX_ONLY }, async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-live-document-light",
      env: HEADLESS_DAEMON_ENV,
      context: visualContext({ width: 1440, height: 1100 }),
    },
    async (page) => {
      await enterMockSession(page);
      await page.locator('.sb-theme-opt[title="Light theme"]').click();
      await page.locator('.sb-theme-opt[title="Light theme"][aria-pressed="true"]').waitFor();
      await settleLiveDocument(page);
      await normalizeSessionFacts(page);
      await assertVisualSnapshot(browser, page, "live-document-light");
    },
  );
});

test("visual: phone settings over a session", { skip: LINUX_ONLY }, async () => {
  await withFreshMockPage(
    browser,
    {
      token: "ui-visual-phone-settings",
      env: HEADLESS_DAEMON_ENV,
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
