// Shared Tier-3 (headless-Chrome) helpers. Deliberately NOT named *.e2e.ts:
// importing one suite file from another would re-register its tests, so the
// shared pieces live in this plain module instead.

import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import axe from "axe-core";

export const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

export const launchChrome = (): Promise<Browser> =>
  chromium.launch({ executablePath: CHROME });

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
export type AxeViolation = { id: string; impact: string; nodes: unknown[]; help: string };
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
        .map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length }));
    },
    [AXE_TAGS, AXE_EXCEPTIONS.map((e) => e.rule)] as const,
  );
  assert.deepEqual(
    violations,
    [],
    `axe serious/critical violations on ${label}: ${JSON.stringify(violations, null, 2)}`,
  );
}
