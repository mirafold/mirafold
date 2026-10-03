import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { type Browser, type Page } from "playwright-core";
import { startDaemon, createSession } from "../itest-harness";
import { SessionCheckpointStore } from "../../sessions/persistence/session-store";
import { componentUsageMessages } from "../fixtures/component-usage";
import { invalidCharts } from "../fixtures/chart-cases";
import { launchChrome, noSideScroll, assertAxeClean, PHONE_CONTEXT } from "./e2e-harness";

let browser: Browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); });

async function assertFaithfulWritesAndReplacements(page: Page) {
  const written = page.locator(".tool-block", { hasText: "written.ts" });
  for (const expanded of [false, true]) {
    if (expanded) await written.getByRole("button", { name: "Show full details" }).click();
    const rows = await written.locator(".tool-patch .tool-code > div").evaluateAll((elements) => elements.map((element) => ({ text: element.textContent, height: element.getBoundingClientRect().height })));
    assert.deepEqual(rows.map((row) => row.text), ["", "written content", "", "last line", ""]);
    assert.ok(rows.every((row) => row.height > 0), `blank written rows occupy a line in ${expanded ? "expanded" : "compact"} mode`);
    assert.equal(await written.locator(".tool-change, .diff-add").count(), 0, "a write has no known before/after count");
  }
  await written.locator(".tool-head").click();
  const multiple = page.locator(".tool-block", { has: page.locator(".tool-detail", { hasText: /^multiple\.ts$/ }) });
  assert.equal(await multiple.locator(".tool-name").innerText(), "replace");
  assert.equal(await multiple.locator(".tool-change, .tool-edit-preview").count(), 0, "one snippet cannot count multiple replacements");
  await multiple.locator(".tool-head").click();
  assert.deepEqual(JSON.parse(await multiple.locator(".tool-input .tool-code").innerText()), { file_path: "multiple.ts", old_string: "before\n", new_string: "after\n", allow_multiple: true });
  await multiple.locator(".tool-head").click();
  for (const [file, extra] of [["retained-multiple.ts", { allow_multiple: true }], ["retained-count.ts", { expected_replacements: 2 }]] as const) {
    const retained = page.locator(".tool-block", { has: page.locator(".tool-detail", { hasText: file }) });
    assert.equal(await retained.locator(".tool-change, .tool-diff").count(), 0);
    assert.match(await retained.innerText(), /Preview unavailable for this replacement count/);
    await retained.getByRole("button", { name: "Show full details" }).click();
    assert.deepEqual(JSON.parse(await retained.locator(".tool-input .tool-code").innerText()), { file_path: file, old_string: "before\n", new_string: "after\n", ...extra });
    await retained.locator(".tool-head").click();
  }
}

test("CU compiled MCP through Codex and browser: rejected update preserves a chart, correction replaces it, replay stays singular", async () => {
  const dir = mkdtempSync("/tmp/cu-chart-browser-");
  const executable = path.join(dir, "codex-fixture");
  const fixture = path.resolve("server/testing/fixtures/component-chart-engine.mjs");
  // Node and the fixture are trusted test-owned paths, shell-quoted literally.
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
  writeFileSync(path.join(dir, "trust.json"), JSON.stringify({ scopes: { codex: [dir] } }));
  const daemon = await startDaemon({ MIRAFOLD_CODEX_BIN: executable, OPENAI_API_KEY: "model-free-fixture", MIRAFOLD_WORKSPACE_TRUST_FILE: path.join(dir, "trust.json"), CU_CHART_RESULTS: path.join(dir, "results.jsonl") }, { built: true });
  const context = await browser.newContext();
  let client: Awaited<ReturnType<typeof createSession>>["client"] | undefined;
  try {
    const session = await createSession(daemon.port, "codex", { cwd: dir });
    client = session.client;
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${daemon.port}/s/${session.sessionId}`);
    await page.locator(".prompt-box textarea").waitFor();
    for (const stage of ["valid", "invalid", "corrected"]) {
      const mark = client.mark();
      client.send({ type: "prompt", text: stage });
      await client.type("turn_end");
      const events = client.received.slice(mark);
      assert.equal(events.filter((message) => message.type === "render").length, stage === "invalid" ? 0 : 1);
      await page.locator(".turn-user-text", { hasText: new RegExp(`^${stage}$`) }).waitFor();
      await page.locator(".activity-line").waitFor({ state: "detached" });
      await page.locator(".rc-chart .rc-title", { hasText: stage === "corrected" ? "Corrected totals" : "Original totals" }).waitFor();
      assert.equal(await page.locator(".rc-chart").count(), 1);
      assert.equal(await page.locator(".rc-fallback").count(), 0);
    }
    const results = (await readFile(path.join(dir, "results.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(results[1].result.isError, true);
    assert.equal(results[1].result.structuredContent, undefined);
    assert.doesNotMatch(JSON.stringify(results[1].result), /Rendered chart/);
    assert.equal(results[2].result.structuredContent.renderId, "retained-chart");
    await page.reload();
    await page.locator(".rc-chart .rc-title", { hasText: "Corrected totals" }).waitFor();
    assert.equal(await page.locator(".rc-chart").count(), 1);
    assert.equal(await page.locator(".rc-fallback").count(), 0);
  } finally { client?.close(); await context.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const phone of [false, true]) test(`CU native preview: ${phone ? "phone light" : "desktop dark"}, normalized edits and disclosure survive replay`, async () => {
  const dir = mkdtempSync("/tmp/cu-browser-");
  const store = new SessionCheckpointStore(dir);
  const buffer = componentUsageMessages();
  for (const id of ["cu-one", "cu-two"]) store.write({ version: 1, id, cwd: dir, bangCwd: dir, backend: { agent: "codex", kind: "none", live: false }, promptOptions: [], buffer, nextSeq: buffer.length + 1, name: id, status: "idle", lastActivity: 1, createdAt: 1 });
  const daemon = await startDaemon({ MIRAFOLD_TOKEN: "cu-browser", MIRAFOLD_SESSION_DIR: dir }, { built: true });
  const context = await browser.newContext(phone ? { ...PHONE_CONTEXT, colorScheme: "light" } : { viewport: { width: 1280, height: 850 }, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    // Old tabs may retain this preference after upgrading. It must not
    // expand every row or suppress the normal native edit previews.
    await page.addInitScript(() => {
      for (const id of ["cu-one", "cu-two"]) sessionStorage.setItem(`mirafold-details-${id}`, "1");
    });
    await page.goto(`http://127.0.0.1:${daemon.port}/s/cu-one?token=cu-browser`);
    if (phone) {
      await page.locator(".sb-settings").tap();
      await page.locator('.theme-group[aria-label="Light themes"]').locator(".theme-row", { hasText: "Standard" }).tap();
      await page.locator(".settings-close").tap();
    }
    await page.locator(`html[data-theme="${phone ? "light" : "dark"}"]`).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), phone ? "light" : "dark");
    const patch = page.locator(".tool-block", { has: page.locator(".tool-name", { hasText: "apply_patch" }) });
    await patch.locator(".tool-edit-preview").waitFor();
    assert.equal(await page.getByRole("button", { name: /^(show|hide) details$/i }).count(), 0);
    assert.equal(await patch.locator(".tool-body").count(), 0, "the obsolete mode preference has no effect");
    assert.match(await patch.locator(".tool-edit-preview").innerText(), /- const retries = 2;[\s\S]*\+ const retries = 4;/);
    assert.ok(await patch.locator(".tool-edit-preview .tool-patch").count() <= 3);
    assert.ok(await patch.locator(".tool-edit-preview .tool-diff > div").count() <= 12);
    assert.match(await patch.innerText(), /Preview shortened/);
    const gemini = page.locator(".tool-block", { hasText: "gemini.ts" });
    assert.match(await gemini.locator(".tool-edit-preview").innerText(), /- before[\s\S]*\+ after/);
    assert.match(await page.locator(".tool-block", { hasText: "written.ts" }).innerText(), /Written content/);
    await assertFaithfulWritesAndReplacements(page);
    const failed = page.locator(".tool-block", { hasText: "failed.ts" });
    assert.equal(await failed.locator(".tool-edit-preview").count(), 0);
    assert.match(await failed.innerText(), /replacement not found/);
    assert.equal(await page.locator(".tool-block", { hasText: "pending.ts" }).locator(".tool-edit-preview").count(), 0);
    assert.equal(await page.locator(".subagent-deck .tool-edit-preview").count(), 0);
    await page.locator(".subagent-deck-head").click();
    assert.match(await page.locator(".subagent-deck .tool-edit-preview").innerText(), /child old[\s\S]*child new/);
    await noSideScroll(page);
    await assertAxeClean(page, "CU preview");
    mkdirSync("/tmp/cu-evidence", { recursive: true });
    await patch.screenshot({ path: `/tmp/cu-evidence/native-${phone ? "phone" : "desktop"}.png` });
    await patch.getByRole("button", { name: "Show full details" }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await patch.locator(".tool-input .tool-patch").count(), 4);
    assert.match(await patch.innerText(), /Moved old.txt → moved.txt/);
    await page.reload();
    await patch.locator(".tool-input").waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), phone ? "light" : "dark");
    await patch.locator(".tool-head").click();
    assert.equal(await patch.locator(".tool-edit-preview").count(), 0);
    await page.reload();
    await patch.waitFor();
    assert.equal(await patch.locator(".tool-edit-preview, .tool-body").count(), 0);
    await page.goto(`http://127.0.0.1:${daemon.port}/s/cu-two`);
    await patch.locator(".tool-edit-preview").waitFor();
    assert.equal(await page.getByRole("button", { name: /^(show|hide) details$/i }).count(), 0);
    await patch.getByRole("button", { name: "Show full details" }).click();
    await patch.locator(".tool-input").waitFor();
    await page.goto(`http://127.0.0.1:${daemon.port}/s/cu-one`);
    await patch.waitFor();
    assert.equal(await patch.locator(".tool-edit-preview, .tool-body").count(), 0);
    assert.equal(await page.getByRole("button", { name: /^(show|hide) details$/i }).count(), 0);
    await noSideScroll(page);
  } finally { await context.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("CU recovery: thrown inner/outer boundaries and invalid historical charts recover under the same ID", async () => {
  const bundle = await build({ entryPoints: ["server/testing/fixtures/component-recovery.tsx"], bundle: true, write: false, format: "iife", platform: "browser", define: { "process.env.NODE_ENV": '"production"' } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route("http://cu.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("http://cu.test");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction("window.cu?.ready()");
    const emit = async (message: unknown) => { await page.evaluate((m) => (window as any).cu.emit(m), message); await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))); };
    const paint = (id: string, label: string, percent: number) => emit({ type: "render", id, component: "progress", props: { label, percent } });
    await paint("healthy", "healthy", 5);
    const healthy = page.getByRole("textbox", { name: "healthy" });
    await healthy.fill("reader state");
    await healthy.focus();
    await paint("broken", "throw", 1);
    assert.match(await page.locator(".rc-fallback").innerText(), /component crashed/);
    const attempts = await page.evaluate(() => (window as any).cu.attempts.inner);
    await paint("broken", "throw", 1);
    assert.equal(await page.evaluate(() => (window as any).cu.attempts.inner), attempts, "unchanged failing content does not retry");
    await paint("broken", "corrected", 2);
    await page.getByRole("textbox", { name: "corrected" }).waitFor();
    assert.equal(await healthy.inputValue(), "reader state");
    assert.equal(await healthy.evaluate((e) => e === document.activeElement), true);
    await paint("schema", "schema", 200);
    assert.match(await page.locator(".rc-fallback").innerText(), /invalid props/);
    await paint("schema", "schema", 30);
    await page.getByRole("textbox", { name: "schema" }).waitFor();
    await page.evaluate(() => (window as any).cu.setOuter(true));
    await paint("outer", "outer", 1);
    await page.locator(".rc-fallback", { hasText: "couldn't draw" }).waitFor();
    await page.evaluate(() => (window as any).cu.setOuter(false));
    await paint("outer", "outer recovered", 2);
    await page.getByRole("textbox", { name: "outer recovered" }).waitFor();
    await page.locator(".turn-render", { has: healthy }).locator(".pin-btn").click();
    const pinned = page.locator(".pin-dock").getByRole("textbox", { name: "healthy" });
    await pinned.fill("pinned state");
    await pinned.focus();
    await paint("healthy", "healthy", 6);
    assert.equal(await pinned.inputValue(), "pinned state");
    assert.equal(await pinned.evaluate((e) => e === document.activeElement), true);
    await paint("healthy", "throw", 7);
    await page.locator(".pin-dock .rc-fallback").waitFor();
    await paint("healthy", "healthy", 8);
    await pinned.waitFor();
    assert.equal(await page.locator(".pin-stub").count(), 1, "the painting stayed pinned through correction");
    for (const props of invalidCharts) {
      await emit({ type: "render", id: "legacy", component: "chart", props });
      assert.match(await page.locator(".rc-fallback").innerText(), /invalid props/);
      assert.equal(await page.locator(".rc-chart").count(), 0);
    }
    await emit({ type: "render", id: "legacy", component: "chart", props: { kind: "pie", x: ["A"], series: [{ name: "s", values: [1] }] } });
    await page.locator(".rc-chart").waitFor();
    assert.equal(await page.locator(".rc-fallback").count(), 0);
  } finally { await context.close(); }
});

// A mounted-source proof can still exercise presentation without a localhost
// daemon. The built-daemon replay tests above remain separate acceptance gates.
for (const phone of [false, true]) test(`CU mounted native preview: ${phone ? "phone light" : "desktop dark"}`, async () => {
  const bundle = await build({ entryPoints: ["server/testing/fixtures/component-recovery.tsx"], bundle: true, write: false, format: "iife", platform: "browser", define: { "process.env.NODE_ENV": '"production"' } });
  const context = await browser.newContext(phone ? { ...PHONE_CONTEXT, colorScheme: "light" } : { viewport: { width: 1280, height: 850 }, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    await page.route("http://cu.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><title>Component usage fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="root"></main></body></html>' }));
    await page.goto("http://cu.test");
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, phone ? "light" : "dark");
    assert.equal(await page.evaluate(() => innerWidth), phone ? 390 : 1280);
    const index = await readFile("dist/index.html", "utf8");
    const css = index.match(/href="(\/assets\/[^" ]+\.css)"/)![1];
    await page.addStyleTag({ content: await readFile(`dist${css}`, "utf8") });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction("window.cu?.ready()");
    const messages = componentUsageMessages();
    const replay = async () => {
      await page.evaluate((records) => { (window as any).cu.emit({ type: "zone_reset" }); for (const message of records) (window as any).cu.emit({ ...message, replay: true }); (window as any).cu.emit({ type: "replay_complete" }); }, messages);
    };
    await replay();
    const patch = page.locator(".tool-block", { has: page.locator(".tool-name", { hasText: "apply_patch" }) });
    await patch.locator(".tool-edit-preview").waitFor();
    assert.match(await patch.locator(".tool-edit-preview").innerText(), /- const retries = 2;[\s\S]*\+ const retries = 4;/);
    assert.ok(await patch.locator(".tool-edit-preview .tool-diff > div").count() <= 12);
    assert.equal(await patch.locator(".tool-edit-preview .tool-patch").count(), 3, "trailing context does not consume the entire preview");
    assert.match(await page.locator(".tool-block", { hasText: "gemini.ts" }).locator(".tool-edit-preview").innerText(), /- before[\s\S]*\+ after/);
    assert.equal(await page.locator(".tool-block", { hasText: "written.ts" }).locator(".diff-add").count(), 0);
    assert.equal(await page.locator(".tool-block", { hasText: "written.ts" }).locator(".tool-change").count(), 0);
    await assertFaithfulWritesAndReplacements(page);
    assert.equal(await page.locator(".tool-block", { hasText: "pending.ts" }).locator(".tool-edit-preview").count(), 0);
    assert.equal(await page.locator(".tool-block", { hasText: "failed.ts" }).locator(".tool-edit-preview").count(), 0);
    await page.locator(".subagent-deck-head").click();
    await page.locator(".subagent-deck .tool-edit-preview").waitFor();
    await noSideScroll(page);
    await assertAxeClean(page, "CU mounted preview");
    mkdirSync("/tmp/cu-evidence", { recursive: true });
    await patch.screenshot({ path: `/tmp/cu-evidence/mounted-native-${phone ? "phone" : "desktop"}.png` });
    await patch.getByRole("button", { name: "Show full details" }).focus();
    await page.keyboard.press("Enter");
    await patch.locator(".tool-body").waitFor();
    assert.equal(await patch.locator(".tool-input .tool-patch").count(), 4);
    assert.match(await patch.innerText(), /Moved old.txt → moved.txt/);
    await replay();
    await patch.locator(".tool-body").waitFor();
    await patch.locator(".tool-head").click();
    await replay();
    await patch.waitFor();
    assert.equal(await patch.locator(".tool-edit-preview, .tool-body").count(), 0);
    await page.evaluate(() => (window as any).cu.show("another-session"));
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await replay();
    await patch.locator(".tool-edit-preview").waitFor();
    await patch.getByRole("button", { name: "Show full details" }).click();
    await patch.locator(".tool-body").waitFor();
    await page.evaluate(() => (window as any).cu.show("recovery-fixture"));
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await replay();
    await patch.waitFor();
    assert.equal(await patch.locator(".tool-edit-preview, .tool-body").count(), 0);
  } finally { await context.close(); }
});
