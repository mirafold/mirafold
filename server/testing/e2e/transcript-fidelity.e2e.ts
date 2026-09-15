// Tier-3: Phase TF — the compact transcript against the spec's scenario
// matrix, driven through the real built daemon and headless Chrome. Every
// test owns a fresh daemon and page. Scenarios: exploration flood, failure
// and recovery, parallel work, a noisy process, inspection during movement,
// recovery past evicted history, painting + permission, and a Gemini-shaped
// provider limitation.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright-core";
import { MOCK_PROMPTS } from "../fixtures/mock-prompts";
import { startDaemon } from "../itest-harness";
import { assertAxeClean, launchChrome, noSideScroll, typePrompt, withFreshMockSession } from "./e2e-harness";

let browser: Browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

/** The scripted turn has ended: the stop button came up (the prompt was
 *  accepted) and went away again — never "was never there yet". */
const turnDone = async (page: Page, timeout = 30_000) => {
  await page.locator(".stop-btn").waitFor({ timeout: 10_000 });
  await page.locator(".stop-btn").waitFor({ state: "detached", timeout });
};

/** The transcript's rows in DOM order, classified by their own text. */
const rowOrder = (page: Page, classify: (className: string, text: string) => string | undefined) =>
  page.evaluate(
    (src) => {
      const fn = new Function("className", "text", `return (${src})(className, text)`) as (c: string, t: string) => string | undefined;
      return [...document.querySelectorAll(".output-zone .tool-group .tool-block, .output-zone .turn-assistant")]
        .map((el) => fn(el.className, (el.textContent ?? "").replace(/\s+/g, " ")))
        .filter((x): x is string => typeof x === "string");
    },
    classify.toString(),
  );

test("TF5.1 exploration flood: fifty routine calls group per interval, thinking stays quiet, both messages read", async () => {
  await withFreshMockSession(browser, "tf-flood-1a2b", async (page) => {
    await typePrompt(page, MOCK_PROMPTS["exploration-flood"]);
    // Reasoning is one collapsed control from its first delta — it never
    // grows a paragraph in the default view.
    const thinking = page.locator(".thinking-block").first();
    await thinking.waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".thinking-block.thinking-folded").count(), 1);
    assert.equal(await page.locator(".thinking-text").count(), 0);
    await turnDone(page, 60_000);
    // Two groups — the root message between them is a boundary — and every
    // read/search is inside one of them, none as a loose row.
    const groups = page.locator(".tool-activity-group");
    assert.equal(await groups.count(), 2);
    assert.match(await groups.nth(0).locator(".tool-activity-summary").innerText(), /Read \d+ files · \d+ searches/);
    assert.equal(await page.locator(".tool-group .tool-block").count(), 0, "no routine call leaked out as its own row");
    const actionCounts = await groups.locator(".tool-activity-label").allInnerTexts();
    assert.deepEqual(actionCounts.map((t) => t.match(/(\d+) actions/)?.[1]), ["25", "25"]);
    for (const text of ["Halfway: the auth path", "Exploration complete"]) {
      assert.equal(await page.locator(".turn-assistant", { hasText: text }).count(), 1, `${text} is readable`);
    }
    // Details on demand: the group expands to every retained call in order,
    // by keyboard, and the thinking opens to its full text.
    await groups.nth(0).locator(".tool-activity-head").focus();
    await page.keyboard.press("Enter");
    assert.equal(await groups.nth(0).locator(".tool-activity-calls .tool-block").count(), 25);
    const firstDetail = await groups.nth(0).locator(".tool-activity-calls .tool-block .tool-name").first().innerText();
    assert.equal(firstDetail, "Read");
    await thinking.locator(".thinking-head").click();
    assert.match(await thinking.locator(".thinking-text").innerText(), /Mapping the module graph/);
    assert.equal(await thinking.locator(".thinking-head").getAttribute("aria-expanded"), "true");
    await assertAxeClean(page, "exploration flood");
    await noSideScroll(page);
  });
});

test("TF5.1 failure and recovery: both outcomes survive in order with the explanation between; a bare exit 1 is neutral", async () => {
  await withFreshMockSession(browser, "tf-recover-3c4d", async (page) => {
    await typePrompt(page, MOCK_PROMPTS["failure-recovery"]);
    await turnDone(page, 30_000);
    const order = await rowOrder(page, (_c, t) =>
      t.includes("yarn test") ? (t.includes("exit 1") ? "fail" : "pass") : t.includes("rg nope") ? "probe" : t.includes("replay-ring.ts") ? "edit" : t.includes("resume test fails") ? "explain" : undefined,
    );
    assert.deepEqual(order, ["fail", "explain", "edit", "pass", "probe"]);
    const failed = page.locator(".tool-block", { hasText: "yarn test" }).first();
    assert.match(await failed.locator(".tool-exit").innerText(), /exit 1/);
    assert.match(await failed.locator(".tool-preview").innerText(), /FAIL: 1 test failed/, "the verdict is on the row");
    assert.equal(await failed.evaluate((el) => el.classList.contains("is-error")), false, "a nonzero exit is a fact, not a red panel");
    const edit = page.locator(".tool-block", { hasText: "replay-ring.ts" });
    assert.match(await edit.locator(".tool-change").innerText(), /\+1/);
    const probe = page.locator(".tool-block", { hasText: "rg nope" });
    assert.match(await probe.locator(".tool-exit").innerText(), /exit 1/);
    assert.equal(await probe.locator(".tool-preview").count(), 0, "no output, no preview, no invented verdict");
    // The failure never gets rewritten by the later green run.
    assert.equal(await page.locator(".tool-block", { hasText: "yarn test" }).locator(".tool-exit").count(), 1);
    await assertAxeClean(page, "failure and recovery");
  });
});

test("TF5.1 parallel work: the parent finishes first; one child fails, one reports at length, the process keeps running", async () => {
  await withFreshMockSession(browser, "tf-parallel-5e6f", async (page) => {
    await typePrompt(page, MOCK_PROMPTS["parallel-work"]);
    await turnDone(page, 15_000);
    // Turn over, three tasks still running — none marked done or interrupted.
    assert.equal(await page.locator(".subagent-deck-running").count(), 3);
    const audit = page.locator(".subagent-deck", { hasText: "audit the watcher" });
    const trace = page.locator(".subagent-deck", { hasText: "trace the token path" });
    const build = page.locator(".subagent-deck", { hasText: "make watch" });
    await audit.locator(".subagent-live", { hasText: "failed" }).waitFor({ timeout: 10_000 });
    await trace.locator(".subagent-live", { hasText: "done" }).waitFor({ timeout: 10_000 });
    assert.equal(await build.evaluate((el) => el.classList.contains("subagent-deck-running")), true);
    assert.match(await build.locator(".subagent-live").innerText(), /compiled \d+ files/);
    // The completion note lands in the current-activity area, compactly.
    assert.match(await page.locator(".activity-note").innerText(), /trace the token path finished|audit the watcher failed/);
    // Open the completed task: the FULL report first, then the activity.
    await trace.locator(".subagent-deck-head").click();
    const report = trace.locator(".subagent-report");
    assert.match(await report.innerText(), /FINAL: the token never leaves the machine/);
    const order = await trace.locator(".subagent-report, .subagent-calls").evaluateAll((nodes) => nodes.map((n) => n.className));
    assert.ok(order[0].includes("subagent-report"), "the report precedes the child activity");
    assert.equal(await trace.locator(".subagent-calls .tool-block").count(), 1);
    // The failed child says why.
    await audit.locator(".subagent-deck-head").click();
    assert.match(await audit.locator(".subagent-report").innerText(), /Missing: \.\/inotify-shim/);
    assert.match(await audit.locator(".subagent-result").innerText(), /Audit aborted/);
    await assertAxeClean(page, "parallel work");
  });
});

test("TF5.1 noisy process: the tail advances past the cap, silence stays 'running', the bound holds, omission is labeled", async () => {
  await withFreshMockSession(browser, "tf-noisy-7a8b", async (page) => {
    await typePrompt(page, MOCK_PROMPTS["noisy-process"]);
    const row = page.locator(".tool-block", { hasText: "./build.sh" });
    await row.waitFor({ timeout: 10_000 });
    await row.locator(".tool-preview", { hasText: "módulo 30" }).waitFor({ timeout: 10_000 });
    // Expand the running row: head, omission, tail — and the tail keeps
    // advancing while the head stays put.
    await row.locator(".tool-head").click();
    const body = row.locator(".tool-output-live");
    await body.locator(".tool-elided", { hasText: "omitted between head and tail" }).waitFor({ timeout: 10_000 });
    assert.match(await body.innerText(), /^build: starting — configuración ✓/);
    await row.locator(".tool-preview, .tool-output-live", { hasText: "ERROR: link failed" }).waitFor({ timeout: 10_000 });
    // Silence: still running, no invented hang or progress.
    await new Promise((r) => setTimeout(r, 1_200));
    assert.match(await row.locator(".tool-state").innerText(), /running/);
    assert.equal(await row.locator(".tool-exit").count(), 0);
    await turnDone(page, 30_000);
    assert.match(await row.locator(".tool-exit").innerText(), /exit 2/);
    const settled = await row.locator(".tool-output").innerText();
    assert.match(settled, /configuración ✓[\s\S]*omitted between head and tail[\s\S]*ERROR: link failed/);
    assert.ok(!settled.includes("�"), "UTF-8 intact at both seams");
    assert.ok(settled.length < 4_000, "the retained evidence is bounded");
    await assertAxeClean(page, "noisy process");
  });
});

test("TF5.1 inspection during movement: an open call stays open as neighbours group; details and choices survive a session switch", async () => {
  await withFreshMockSession(browser, "tf-inspect-9c0d", async (page) => {
    await page.setViewportSize({ width: 900, height: 520 });
    await typePrompt(page, MOCK_PROMPTS["tool-activity"]);
    const running = page.locator(".tool-group .tool-block.is-running", { hasText: "yarn lint" });
    await running.waitFor({ timeout: 10_000 });
    await running.locator(".tool-head").click();
    assert.equal(await running.locator(".tool-body").count(), 1);
    // Scroll up while it runs: following pauses, the row stays open.
    await page.locator(".output-zone").evaluate((el) => { el.scrollTop = 0; });
    await page.mouse.wheel(0, -50);
    await turnDone(page, 20_000);
    const lint = page.locator(".tool-block", { hasText: "yarn lint" });
    assert.equal(await lint.locator(".tool-body").count(), 1, "the reader's expand survived settlement");
    // The routine group formed beside it, with the reasoning inside it.
    assert.equal(await page.locator(".tool-activity-group").count(), 1);
    assert.match(await page.locator(".tool-activity-summary").innerText(), /Read 2 files · 1 search/);
    assert.equal(await page.locator(".thinking-block").count(), 0, "interior reasoning rides inside the group");
    // Details mode: everything opens; explicit choices still win.
    await page.locator(".sb-details").click();
    assert.equal(await page.locator(".sb-details").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".tool-activity-calls .tool-block").count(), 3);
    assert.equal(await page.locator(".tool-activity-calls .thinking-text").count(), 1);
    const typecheck = page.locator(".tool-block", { hasText: "yarn typecheck" });
    assert.equal(await typecheck.locator(".tool-body").count(), 1);
    await typecheck.locator(".tool-head").click();
    assert.equal(await typecheck.locator(".tool-body").count(), 0, "an explicit close wins over the mode");
    // Away and back in the same tab: the mode and the choice persist.
    const url = page.url();
    await page.goto(url.replace(/\/s\/.*$/, "/"));
    await page.locator(".fleet, .agent-picker-card, .cockpit").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await page.goto(url);
    await page.locator(".prompt-box textarea").waitFor();
    await page.locator(".tool-activity-group").waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".sb-details").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".tool-block", { hasText: "yarn typecheck" }).locator(".tool-body").count(), 0);
    assert.equal(await page.locator(".tool-block", { hasText: "yarn lint" }).locator(".tool-body").count(), 1);
    await page.locator(".sb-details").click();
    assert.equal(await page.locator(".tool-activity-calls .tool-block").count(), 0, "compact again — the group closes");
    await assertAxeClean(page, "inspection during movement");
  });
});

test("TF5.1 recovery: an outcome whose opening was evicted is still shown, and missing history is said", async () => {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), "mirafold-tf-recovery-"));
  // A ring that holds the capped result (65,243 UTF-8 bytes as JSON) and
  // the 167 bytes of rows after it, but not the 111-byte opening tool_use
  // before it: the prompt, statuses, and the opening evict (oldest first)
  // while the outcome — the newest large message — stays. Measured against
  // the huge-output scenario's exact frame sizes (TF5 probe, 2026-09-15);
  // any cap in [65,410, 65,520] produces this shape, a smaller one evicts
  // the result too, a larger one evicts nothing.
  const daemon = await startDaemon({ MIRAFOLD_TOKEN: "tf-evict-1e2f", MIRAFOLD_SESSION_DIR: sessionDir, SESSION_BUFFER_MAX_BYTES: "65450" });
  try {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${daemon.port}/?token=tf-evict-1e2f`);
      await page.locator(".agent-picker-agent", { hasText: "Claude Agent" }).click();
      await page.waitForURL(/\/s\/[\w-]+/);
      await typePrompt(page, MOCK_PROMPTS["huge-output"]);
      await turnDone(page, 30_000);
      await page.reload();
      await page.locator(".prompt-box textarea").waitFor();
      await page.locator(".notice-line", { hasText: "no longer retained" }).waitFor({ timeout: 10_000 });
      const orphan = page.locator(".tool-block.is-orphaned");
      await orphan.waitFor({ timeout: 10_000 });
      assert.match(await orphan.locator(".tool-name").innerText(), /earlier call/);
      await orphan.locator(".tool-head").click();
      assert.match(await orphan.locator(".tool-output").innerText(), /request served in 42ms[\s\S]*omitted between head and tail/);
    } finally {
      await page.close();
    }
  } finally {
    await daemon.stop();
  }
});

test("TF5.1 painting and permission: a plan completes above the reader, a failed render stays visible, a child's ask resolves once", async () => {
  await withFreshMockSession(browser, "tf-paint-3a4b", async (page) => {
    await page.setViewportSize({ width: 900, height: 520 });
    await typePrompt(page, MOCK_PROMPTS["painting-permission"]);
    await page.locator(".permission-bar").first().waitFor({ timeout: 20_000 });
    // The plan completed above; the current-activity area says so.
    assert.match(await page.locator(".activity-note").innerText(), /plan complete/);
    const failed = page.locator(".tool-block.is-error", { hasText: "render_chart" });
    assert.equal(await failed.count(), 1, "a failed render call keeps its evidence");
    assert.match(await failed.locator(".tool-output").innerText(), /must have at least one entry/);
    // The child's ask rides the trusted bar and resolves exactly once.
    const allow = page.locator(".permission-allow", { hasText: /allow/i }).first();
    await allow.click();
    await turnDone(page, 20_000);
    assert.equal(await page.locator(".permission-bar").count(), 0);
    const child = page.locator(".subagent-deck", { hasText: "verify the shim" });
    assert.match(await child.locator(".subagent-live").innerText(), /done/);
    await assertAxeClean(page, "painting and permission");
  });
});

test("TF5.1 provider limitation: a Gemini-shaped turn stays honest during silence and invents nothing", async () => {
  await withFreshMockSession(
    browser,
    "tf-gemini-5c6d",
    async (page) => {
      await typePrompt(page, MOCK_PROMPTS["gemini-shaped"]);
      const row = page.locator(".tool-block", { hasText: "slow-probe" });
      await row.waitFor({ timeout: 10_000 });
      await row.locator(".tool-head").click();
      assert.match(await row.locator(".tool-silent").innerText(), /live output unavailable for this agent/);
      assert.equal(await page.locator(".thinking-block").count(), 0);
      assert.equal(await page.locator(".subagent-deck").count(), 0);
      assert.match(await row.locator(".tool-state").innerText(), /running/);
      await turnDone(page, 20_000);
      assert.match(await row.locator(".tool-output").innerText(), /probe: ok/);
      assert.equal(await row.locator(".tool-exit").count(), 0, "no exit code exists on this stream, so none is shown");
    },
    { agent: "Gemini CLI" },
  );
});
