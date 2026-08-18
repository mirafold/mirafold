// Shared real-browser helpers. Deliberately NOT named with a test suffix:
// importing one suite file from another would re-register its tests, so the
// shared pieces live in this plain module instead.

import assert from "node:assert/strict";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "playwright-core";
import axe from "axe-core";
import { startDaemon } from "./itest-harness";

export const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

export const launchChrome = (): Promise<Browser> =>
  chromium.launch({ executablePath: CHROME });

/** The compatibility/visual suites use Playwright's revision-matched browser
 * binaries. The full Tier-3 suite deliberately keeps using the system Chrome
 * path above: this matrix adds engines without multiplying all 103 cases. */
export const MANAGED_BROWSER_NAMES = ["chromium", "firefox", "webkit"] as const;
export type ManagedBrowserName = (typeof MANAGED_BROWSER_NAMES)[number];

const MANAGED_BROWSERS = { chromium, firefox, webkit };

export const launchManagedBrowser = (name: ManagedBrowserName): Promise<Browser> =>
  MANAGED_BROWSERS[name].launch();

/** One credential-scrubbed daemon and isolated browser context, always closed
 * in context-before-daemon order even when setup or an assertion fails.
 * Uncaught page errors are collected from before the first navigation, so an
 * engine that throws while loading the bundle is on record; `run` receives
 * the list to assert on, and if `run` throws for any reason the captured
 * errors are appended to the failure — a boot-time throw reads as itself,
 * not as an anonymous timeout on the first locator. `env` is layered onto
 * the scrubbed daemon environment. */
export async function withFreshMockPage(
  browser: Browser,
  options: {
    token: string;
    context?: BrowserContextOptions;
    env?: Record<string, string>;
  },
  run: (page: Page, base: string, pageErrors: Error[]) => Promise<void>,
): Promise<void> {
  const daemon = await startDaemon({ ...options.env, MIRAFOLD_TOKEN: options.token });
  try {
    const context = await browser.newContext(options.context);
    try {
      const page = await context.newPage();
      const pageErrors: Error[] = [];
      page.on("pageerror", (error) => pageErrors.push(error));
      const base = `http://127.0.0.1:${daemon.port}`;
      try {
        await page.goto(`${base}/?token=${options.token}`);
        await run(page, base, pageErrors);
      } catch (error) {
        if (pageErrors.length === 0 || !(error instanceof Error)) throw error;
        error.message +=
          `\nuncaught page errors before this failure:\n` +
          pageErrors.map((e) => `  - ${e.message}`).join("\n");
        throw error;
      }
    } finally {
      await context.close();
    }
  } finally {
    await daemon.stop();
  }
}

export async function enterMockSession(page: Page): Promise<void> {
  await page.locator(".onb-agent", { hasText: "Claude Code" }).click();
  await page.waitForURL(/\/s\/[\w-]+/);
  await page.locator(".prompt-box textarea").waitFor();
}

/** Phone-width oracle: the page must never pan sideways. */
export const noSideScroll = async (p: Page) => {
  const over = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(over <= 1, `page scrolls sideways by ${over}px`);
};

// C.2 — the automated regression guard for Phase A. axe-core (4.10.2, injected
// into the live page, not a jsdom stand-in) scans each surface for the
// machine-checkable third of WCAG. Honest scope: this does NOT replace A.3's
// manual/screen-reader pass — it catches the silent decays (a <button> becoming
// a styled <div>, a dropped aria-label) that look identical to a sighted mouse
// user. We fail on `serious` + `critical` only; `moderate`/`minor` are noisier
// and less clearly real, and holding the line on the two impactful tiers is
// what keeps the Phase A work from rotting. Any accepted exception lives in
// AXE_EXCEPTIONS below, each with a reason.
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
// Rule IDs to disable, each justified. Empty today — the manual axe sweep
// (2026-07-21) already fixed every real finding, so the app scans clean.
export const AXE_EXCEPTIONS: { rule: string; why: string }[] = [];

// axe-core's window global and the slice of its run() result we read. Named
// here so the page-side call below stays legible; types are erased before the
// evaluate callback is serialized to the browser, so this is compile-time only.
export type AxeViolation = {
  id: string;
  impact: string;
  nodes: { target: unknown[]; html: string; failureSummary?: string }[];
  help: string;
};
export type AxePage = { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: AxeViolation[] }> } };

export async function assertAxeClean(p: Page, label: string): Promise<void> {
  // Settle every animation/transition to its END state before auditing:
  // fleet rows enter with `rise` (opacity 0→1), and on a loaded CI runner
  // axe could sample a row mid-rise and read the partial-opacity text as a
  // color-contrast violation (the C.2 fleet-view flake, root-caused
  // 2026-07-23). Zeroing durations jumps each animation to its resting
  // frame — the exact state we mean to audit — without changing any final
  // style value. Infinite animations (the live-state pulse dot) jump to
  // their end frame too, harmless for contrast.
  await p.addStyleTag({
    content:
      "*, *::before, *::after { animation-duration: 0s !important; " +
      "animation-delay: 0s !important; transition-duration: 0s !important; }",
  });
  await p.addScriptTag({ content: axe.source }); // defines window.axe in the page
  const violations = await p.evaluate(
    async ([tags, exceptions]) => {
      const rules: Record<string, { enabled: boolean }> = {};
      for (const r of exceptions as string[]) rules[r] = { enabled: false };
      const res = await (window as unknown as AxePage).axe.run(document, {
        resultTypes: ["violations"],
        runOnly: { type: "tag", values: tags },
        rules,
      });
      return res.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          count: v.nodes.length,
          nodes: v.nodes.map((node) => {
            const selector = node.target.find((part): part is string => typeof part === "string");
            const element = selector ? document.querySelector(selector) : null;
            const focusableSelector =
              'a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]';
            const elementStyle = element ? getComputedStyle(element) : null;
            const elementRect = element?.getBoundingClientRect();
            const elementMetrics =
              element && elementStyle && elementRect
                ? {
                    tag: element.tagName.toLowerCase(),
                    id: element.id || undefined,
                    classes: typeof element.className === "string" ? element.className || undefined : undefined,
                    clientWidth: element.clientWidth,
                    clientHeight: element.clientHeight,
                    scrollWidth: element.scrollWidth,
                    scrollHeight: element.scrollHeight,
                    rect: {
                      x: elementRect.x,
                      y: elementRect.y,
                      width: elementRect.width,
                      height: elementRect.height,
                    },
                    overflow: elementStyle.overflow,
                    overflowX: elementStyle.overflowX,
                    overflowY: elementStyle.overflowY,
                    display: elementStyle.display,
                    position: elementStyle.position,
                    tabIndex: (element as HTMLElement).tabIndex,
                    tabindexAttribute: element.getAttribute("tabindex"),
                    matchesFocusableSelector: element.matches(focusableSelector),
                    focusableDescendants: element.querySelectorAll(focusableSelector).length,
                  }
                : null;
            const scrollAncestors: unknown[] = [];
            for (let ancestor = element?.parentElement; ancestor; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor);
              const rect = ancestor.getBoundingClientRect();
              const detail = {
                tag: ancestor.tagName.toLowerCase(),
                id: ancestor.id || undefined,
                classes: typeof ancestor.className === "string" ? ancestor.className || undefined : undefined,
                clientWidth: ancestor.clientWidth,
                clientHeight: ancestor.clientHeight,
                scrollWidth: ancestor.scrollWidth,
                scrollHeight: ancestor.scrollHeight,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                overflow: style.overflow,
                overflowX: style.overflowX,
                overflowY: style.overflowY,
                display: style.display,
                position: style.position,
                tabIndex: ancestor.tabIndex,
                tabindexAttribute: ancestor.getAttribute("tabindex"),
                matchesFocusableSelector: ancestor.matches(focusableSelector),
                focusableDescendants: ancestor.querySelectorAll(focusableSelector).length,
              };
              if (
                detail.scrollHeight > detail.clientHeight + 1 ||
                detail.scrollWidth > detail.clientWidth + 1 ||
                /(auto|scroll)/.test(`${detail.overflow} ${detail.overflowX} ${detail.overflowY}`)
              ) {
                scrollAncestors.push(detail);
              }
            }
            return {
              target: node.target,
              html: node.html,
              failureSummary: node.failureSummary,
              element: elementMetrics,
              scrollAncestors,
            };
          }),
        }));
    },
    [AXE_TAGS, AXE_EXCEPTIONS.map((e) => e.rule)] as const,
  );
  assert.deepEqual(
    violations,
    [],
    `axe serious/critical violations on ${label}: ${JSON.stringify(violations, null, 2)}`,
  );
}
