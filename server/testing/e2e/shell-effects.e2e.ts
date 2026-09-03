// Tier-3: shell-owned effects around the prompt — provider completions, the
// needs-you toasts, file drop staging, the mermaid sandbox, and the badged
// notice. Every test owns a fresh daemon and page.

import { test, before, after } from "node:test";
import { MOCK_PROMPTS } from "../fixtures/mock-prompts";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { type Browser, type Page } from "playwright-core";
import { launchChrome, withFreshMockSession, assertAxeClean } from "./e2e-harness";

let browser: Browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

test("provider completions open before submit, transcript click focuses, and settled activity compacts", async () => {
  const token = "e2e-native-prompt-9c2f";
  await withFreshMockSession(
    browser,
    token,
    async (page2) => {
      const prompt = page2.locator(".prompt-box textarea");
      const transcript = page2.locator(".output-zone");

      // A trigger typed into page chrome is moved into the prompt and paints
      // the provider catalog without sending a turn.
      // Constrain the real listbox to force overflow with the mock catalog;
      // this exercises the same keyboard scroll path as a long live catalog.
      await page2.addStyleTag({
        content: ".prompt-options { max-height: 48px !important; }",
      });
      await transcript.focus();
      await page2.keyboard.press("/");
      await page2.locator(".prompt-options").waitFor();
      assert.equal(await prompt.inputValue(), "/");
      // The Codex catalog: exactly the commands the adapter intercepts itself.
      assert.equal(await page2.locator(".prompt-options [role=option]").count(), 2);
      assert.equal(await page2.locator(".prompt-option-value", { hasText: "/model" }).count(), 1);
      assert.equal(await page2.locator(".prompt-option-value", { hasText: "/effort" }).count(), 1);
      assert.equal(await page2.locator(".turn-user").count(), 0, "opening a catalog submitted a turn");

      await page2.keyboard.press("Escape");
      await page2.locator(".prompt-options").waitFor({ state: "detached" });
      await prompt.fill("");
      await transcript.focus();
      await page2.keyboard.press("$");
      await page2.locator(".prompt-options").waitFor();
      assert.equal(await page2.locator(".prompt-options [role=option]").count(), 2);
      await page2.keyboard.press("ArrowDown");
      const menuVisibility = await page2
        .locator('.prompt-options [role="option"][aria-selected="true"]')
        .evaluate((active) => {
          const menu = active.parentElement!;
          const activeRect = active.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          return {
            scrollTop: menu.scrollTop,
            fullyVisible:
              activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1,
          };
        });
      assert.ok(menuVisibility.scrollTop > 0, "keyboard selection did not scroll the listbox");
      assert.equal(menuVisibility.fullyVisible, true, "active completion stayed offscreen");
      await page2.keyboard.type("n");
      assert.equal(await page2.locator(".prompt-options [role=option]").count(), 1);
      assert.equal(await page2.locator(".prompt-option-value").textContent(), "$next");
      assert.equal(
        await page2.locator(".prompt-option-source").textContent(),
        "Mirafold demo",
        "catalog metadata must be visibly attributed inside trusted prompt chrome",
      );
      await page2.keyboard.press("Tab");
      assert.equal(await prompt.inputValue(), "$next ");
      assert.equal(await page2.locator(".turn-user").count(), 0, "Tab completion submitted a turn");

      // Moving focus away and typing another trigger must preserve the draft,
      // not replace it while routing the keystroke back to the composer.
      await transcript.focus();
      await page2.keyboard.press("$");
      assert.equal(await prompt.inputValue(), "$next $");

      // Shift+Escape was provisional and is deliberately gone. A plain
      // desktop click on inert transcript chrome is the accepted return path.
      await transcript.focus();
      await page2.keyboard.press("Shift+Escape");
      assert.equal(await transcript.evaluate((el) => document.activeElement === el), true);
      await transcript.click({ position: { x: 2, y: 2 } });
      assert.equal(
        await page2.evaluate(() => document.activeElement?.matches(".prompt-box textarea")),
        true,
      );

      // Successful provider activity becomes one terminal-sized record LIVE,
      // while the turn still runs: the finished calls fold as "working", the
      // call in flight stays its own pulsing row beneath. A failure remains
      // visible at top level, and narration between commands (Codex's
      // cadence — thinking, or a short spoken remark) rides inside the fold
      // instead of shattering it into singletons.
      await prompt.fill("show transcript compact tool activity");
      await prompt.press("Enter");
      await page2.locator(".stop-btn").waitFor();
      // Mid-turn, during the scenario's deliberately slow third call.
      const runningRow = page2.locator(".tool-group .tool-block.is-running");
      await runningRow.waitFor({ timeout: 10_000 });
      await page2.locator(".tool-activity-group.tool-activity-live").waitFor();
      assert.match(
        await page2.locator(".tool-activity-label").innerText(),
        /working · 2 actions/,
        "the finished calls fold while the turn is still running",
      );
      assert.match(await runningRow.innerText(), /yarn lint/, "the running call is the visible row");
      // Expand the running call by hand; that choice must survive its move
      // into the fold once it finishes.
      await runningRow.locator(".tool-head").click();
      assert.equal(await runningRow.locator(".tool-body").count(), 1);

      await page2.locator(".stop-btn").waitFor({ state: "detached" });
      assert.equal(await page2.locator(".tool-activity-group").count(), 1);
      assert.equal(await page2.locator(".tool-activity-live").count(), 0, "a settled fold is no longer live");
      // The fold's count speaks of ACTIONS only — absorbed narration
      // (thinking and remarks riding inside the fold) must never inflate it.
      assert.match(
        await page2.locator(".tool-activity-label").innerText(),
        /worked · 3 actions/,
        "the fold label must count tool calls only, not absorbed narration",
      );
      assert.equal(await page2.locator(".tool-group").count(), 1);
      assert.match(await page2.locator(".tool-group").textContent() ?? "", /No matching test file/);
      assert.equal(
        await page2.locator(".thinking-block", { hasText: "Weighing which check" }).count(),
        0,
        "interleaved narration leaked outside the settled fold",
      );
      assert.equal(
        await page2.locator(".turn-assistant", { hasText: "running lint next" }).count(),
        0,
        "a short remark between commands leaked outside the fold as prose",
      );
      await page2.locator(".tool-activity-head").click();
      assert.equal(
        await page2.evaluate(() => document.activeElement?.classList.contains("tool-activity-head")),
        true,
        "a transcript control click was redirected to the prompt",
      );
      assert.equal(await page2.locator(".tool-activity-calls .tool-block").count(), 3);
      assert.equal(
        await page2.locator(".tool-activity-calls .thinking-block", { hasText: "Weighing which check" }).count(),
        1,
        "the fold's expansion must replay the interleaved narration in place",
      );
      assert.equal(
        await page2.locator(".tool-activity-calls .tool-activity-narration", { hasText: "running lint next" }).count(),
        1,
        "the fold's expansion must replay the absorbed remark in place, as plain text",
      );
      const lintInFold = page2.locator(".tool-activity-calls .tool-block", { hasText: "yarn lint" });
      assert.equal(
        await lintInFold.locator(".tool-body").count(),
        1,
        "the user's expand must survive the call's move into the fold",
      );
      assert.equal(
        await page2.locator(".tool-activity-calls .tool-block", { hasText: "yarn typecheck" }).locator(".tool-body").count(),
        0,
        "an untouched call stays collapsed",
      );

      // Event delegation must treat ordinary transcript links as controls too.
      // The real click path (pointerdown → pointerup → click) must leave focus
      // on the link instead of redirecting it into the prompt.
      const transcriptLink = page2.locator(".turn-assistant").last().locator("a").last();
      await page2.locator(".turn-assistant").last().evaluate((el) => {
        const link = document.createElement("a");
        link.id = "transcript-control-fixture";
        link.href = "#transcript-control-fixture";
        link.textContent = "transcript link";
        el.append(" ", link);
      });
      await prompt.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        const nativeFocus = textarea.focus.bind(textarea);
        textarea.focus = (options?: FocusOptions) => {
          textarea.dataset.transcriptLinkFocusCalls = String(
            Number(textarea.dataset.transcriptLinkFocusCalls ?? "0") + 1,
          );
          nativeFocus(options);
        };
      });
      await transcriptLink.click();
      assert.equal(
        await prompt.getAttribute("data-transcript-link-focus-calls"),
        null,
        "a transcript link click invoked prompt focus before restoring link focus",
      );
      assert.equal(
        await transcriptLink.evaluate((el) => document.activeElement === el),
        true,
        "a transcript link click was redirected to the prompt",
      );

      // A text-selection gesture ends with the same pointerup event as a
      // click. A live selection must win so copying transcript text remains
      // possible and prompt focus does not collapse it.
      const selected = await page2.locator(".turn-assistant").last().evaluate((el) => {
        const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        if (!text || !text.textContent) return { text: "", promptFocused: false };
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, Math.min(12, text.textContent.length));
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        el.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerType: "mouse",
            button: 0,
            isPrimary: true,
          }),
        );
        return {
          text: selection.toString(),
          promptFocused: document.activeElement?.matches(".prompt-box textarea") ?? false,
        };
      });
      assert.ok(selected.text.length > 0, "selection fixture did not select transcript text");
      assert.equal(selected.promptFocused, false, "text selection was collapsed into prompt focus");
      await page2.evaluate(() => window.getSelection()?.removeAllRanges());

      // Touch must never summon the phone keyboard by focusing the prompt.
      await transcript.focus();
      await transcript.dispatchEvent("pointerup", {
        pointerType: "touch",
        button: 0,
        isPrimary: true,
      });
      assert.equal(await transcript.evaluate((el) => document.activeElement === el), true);
      await assertAxeClean(page2, "transcript click-to-focus");
    },
    { agent: "Codex" },
  );
});

test("a rejected second bang leaves the first PTY's controls usable", async () => {
  await withFreshMockSession(browser, "e2e-bang-reject-9c2f", async (page) => {
    const prompt = page.locator(".prompt-box textarea");
    const bar = page.locator(".bang-bar");
    const firstCommand = `node -e "console.log('first-pty-ready'); setInterval(() => {}, 1000)"`;

    // Start with `!!` and reject a later `!`: both spellings share the same
    // one-PTY guard, and the first command stays shell-only after it is killed.
    await prompt.fill(`!! ${firstCommand}`);
    await prompt.press("Enter");
    await bar.waitFor();
    await page.locator(".bang-output", { hasText: "first-pty-ready" }).waitFor();

    await prompt.fill("! echo second-pty-must-not-run");
    await prompt.press("Enter");
    await page
      .locator(".turn-assistant", { hasText: "a ! command is already running" })
      .waitFor();

    assert.equal(
      await bar.locator(".bang-bar-cmd").getAttribute("title"),
      firstCommand,
      "the rejected command replaced the running PTY's controls",
    );
    await bar.locator(".bang-bar-kill").click();
    await bar.waitFor({ state: "detached" });
    assert.equal(
      await page.locator(".bang-output", { hasText: "second-pty-must-not-run" }).count(),
      0,
      "the rejected second command ran",
    );
  });
});

test("an accepted second bang replaces controls after the first PTY exits", async () => {
  await withFreshMockSession(browser, "e2e-bang-replace-9c2f", async (page) => {
    const prompt = page.locator(".prompt-box textarea");
    const bar = page.locator(".bang-bar");
    const firstCommand = `node -e "console.log('first-pty-ready'); setInterval(() => {}, 1000)"`;
    const secondCommand = `node -e "console.log('replacement-pty-ready'); setInterval(() => {}, 1000)"`;

    await prompt.fill(`!! ${firstCommand}`);
    await prompt.press("Enter");
    await bar.waitFor();
    await page.locator(".bang-output", { hasText: "first-pty-ready" }).waitFor();

    // Kill the first process, but hold the browser's event loop so its inbound
    // bang_end stays queued. The daemon has time to finish the kill and accepts
    // the command submitted at the end of the same browser task.
    await prompt.fill(`!! ${secondCommand}`);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>(".bang-bar-kill")?.click();
      const until = performance.now() + 1_400;
      while (performance.now() < until) {
        // Deliberately keep inbound WebSocket messages queued.
      }
      document.querySelector<HTMLTextAreaElement>(".prompt-box textarea")?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    await page.locator(".bang-output", { hasText: "replacement-pty-ready" }).waitFor();
    await bar.waitFor();
    assert.equal(
      await bar.locator(".bang-bar-cmd").getAttribute("title"),
      secondCommand,
      "the accepted replacement PTY lost its controls",
    );
    await bar.locator(".bang-bar-kill").click();
    await bar.waitFor({ state: "detached" });
  });
});

test("NF: hidden viewport toasts a permission then the turn end; visibility closes both", async () => {
  const token = "e2e-notify-7b31";
  type ToastRec = { title: string; body?: string; tag?: string; closed: boolean };
  const toasts = (p: Page) =>
    p.evaluate(() => (window as unknown as { __TOASTS__: ToastRec[] }).__TOASTS__);
  // A JS string, not a function — the accessor property would otherwise
  // compile with the module-scope __name wrapper (same keepNames trap as the
  // stub below) and die serialized.
  const setVisibility = (p: Page, state: "hidden" | "visible") =>
    p.evaluate(
      `Object.defineProperty(document, "visibilityState", {
         configurable: true, get: function () { return "${state}"; },
       });
       document.dispatchEvent(new Event("visibilitychange"));`,
    );
  await withFreshMockSession(
    browser,
    token,
    async (page2) => {
      // The toggle lives in the settings card and defaults off; flipping it
      // writes the preference (the stub's grant is already "granted", so no
      // permission dance here — that branch is Tier-1 logic).
      await page2.locator(".sb-settings").click();
      await page2.waitForSelector(".settings-card");
      const row = page2.locator(".notify-row");
      assert.equal(await row.getAttribute("aria-checked"), "false");
      await row.click();
      assert.equal(await row.getAttribute("aria-checked"), "true");
      assert.equal(
        await page2.evaluate(() => localStorage.getItem("mirafold-notify")),
        "1",
      );
      await assertAxeClean(page2, "settings notifications section");
      await page2.keyboard.press("Escape");
      await page2.waitForSelector(".settings-card", { state: "detached" });

      // Background the tab — the notifier reads visibilityState live, and
      // only a hidden tab may toast.
      await setVisibility(page2, "hidden");

      // A permission lands while hidden → exactly one toast, session-tagged,
      // shell-composed title with the engine's ask as inert text.
      await page2.locator("textarea").click();
      await page2.keyboard.type(MOCK_PROMPTS["permission-ask"]);
      await page2.keyboard.press("Enter");
      await page2.waitForSelector(".permission-bar");
      await page2.waitForFunction(
        () => (window as unknown as { __TOASTS__?: unknown[] }).__TOASTS__?.length === 1,
        undefined,
        { timeout: 15_000 },
      );
      const [first] = await toasts(page2);
      assert.match(first.title, /^⚠ permission — /);
      assert.match(first.body ?? "", /Claude Agent wants Bash: rm -rf/);
      assert.ok(first.tag?.startsWith("mirafold-"), `tag was ${first.tag}`);

      // Answering retires the permission toast (the state moved on); the
      // finishing turn then toasts once more under the same tag.
      await page2.locator(".permission-allow").click();
      await page2.waitForFunction(
        () => {
          const t = (window as unknown as { __TOASTS__: { closed: boolean }[] }).__TOASTS__;
          return t.length === 2 && t[0].closed;
        },
        undefined,
        { timeout: 15_000 },
      );
      const [, second] = await toasts(page2);
      assert.match(second.title, /^✓ turn finished — /);
      assert.equal(second.tag, first.tag);

      // Coming back closes everything this tab created — the page itself is
      // now the notification.
      await setVisibility(page2, "visible");
      await page2.waitForFunction(() =>
        (window as unknown as { __TOASTS__: { closed: boolean }[] }).__TOASTS__.every(
          (t) => t.closed,
        ),
      );
    },
    {
      agent: "Claude Agent",
      prepare: async (p) => {
      // Notification stubbed before boot: headless Chrome auto-denies the
      // real API and an OS toast is invisible to the DOM anyway — the
      // recorder IS the observable surface. A plain-JS STRING, not a
      // function: tsx compiles this file with esbuild keepNames, which
      // injects a module-scope `__name` helper into compiled classes —
      // Playwright then serializes the function without the helper and the
      // init script dies on a ReferenceError before installing the stub
      // (diagnosed 2026-08-12 via pageerror probe).
      await p.addInitScript(`
        const spawned = [];
        window.__TOASTS__ = spawned;
        window.Notification = class {
          constructor(title, opts) {
            this.rec = { title, body: opts && opts.body, tag: opts && opts.tag, closed: false };
            this.onclick = null;
            spawned.push(this.rec);
          }
          close() { this.rec.closed = true; }
          static get permission() { return "granted"; }
          static requestPermission() { return Promise.resolve("granted"); }
        };
      `);
      },
    },
  );
});

test("FD: a dropped file uploads, stages on disk, and its quoted path lands in the prompt", async () => {
  const token = "e2e-filedrop-4a19";
  await withFreshMockSession(browser, token, async (page2) => {
    // The drag listeners attach only once the session is attached
    // (meta.sessionId) — a dispatch racing the mount fires into the void,
    // so wait for the session UI first (diagnosed 2026-08-12 by probe).
    await page2.waitForSelector(".prompt-box textarea");
    // Synthesize a real file drag: DataTransfer + File are native in
    // Chromium. A JS string, not a function — the keepNames __name trap
    // (see the NF test above) breaks serialized closures.
    await page2.evaluate(`
      window.__DT__ = (() => {
        const dt = new DataTransfer();
        dt.items.add(new File(["drag and drop payload snowman"], "dropped notes.txt", { type: "text/plain" }));
        return dt;
      })();
      document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: window.__DT__ }));
    `);
    // Mid-drag, the shell-owned overlay invites the drop.
    await page2.waitForSelector(".drop-overlay");
    await page2.evaluate(`
      document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__DT__ }));
    `);
    // The staged path lands in the prompt, quoted (the name carries a space).
    await page2.waitForFunction(
      () => {
        const el = document.querySelector(".prompt-box textarea") as HTMLTextAreaElement | null;
        return el?.value.includes("mirafold-uploads") ?? false;
      },
      undefined,
      { timeout: 15_000 },
    );
    assert.equal(await page2.locator(".drop-overlay").count(), 0, "overlay clears on drop");
    const value = await page2.locator(".prompt-box textarea").inputValue();
    const m = value.match(/'([^']*mirafold-uploads[^']*)'/);
    assert.ok(m, `expected a quoted staged path in the prompt, got: ${value}`);
    const staged = m![1];
    assert.match(staged, /dropped notes\.txt$/);
    // The path is honest: the exact dropped bytes sit at it on disk.
    assert.equal(readFileSync(staged, "utf8"), "drag and drop payload snowman");
    // The attach announced politely (the screen-reader path).
    const status = await page2.locator('[role="status"]').innerText();
    assert.match(status, /Attached dropped notes\.txt/);
    rmSync(path.dirname(staged), { recursive: true, force: true });
  });
});

test("diagram component: mermaid renders as SVG inside the sandbox; broken source shows itself", async () => {
  // This test used to borrow the suite's long-lived session. Its failure was
  // misattributed to Mermaid's lazy chunk, but the outer .rc-diagram never
  // arrived: an earlier test could finish its DOM assertions just before its
  // turn_end and leave this prompt contending with the one-follow-up gate.
  // Own a session so this test reaches the renderer or fails for a renderer
  // reason; the actual lazy chunk, iframe, CSP, postMessage, and parse error
  // paths below remain production-real.
  await withFreshMockSession(browser, "e2e-diagram-9c2f", async (page2) => {
    await page2.waitForSelector("textarea");
    await page2.locator("textarea").fill("diagram demo");
    await page2.keyboard.press("Enter");

    const block = page2.locator(".rc-diagram", { hasText: "Relay pairing flow" });
    await block.waitFor({ timeout: 20_000 });
    // The runtime is a lazy ~3.6 MB chunk — give the first render room.
    const frame = block.locator("iframe.rc-diagram-frame");
    await frame.waitFor({ timeout: 20_000 });
    const svg = page2
      .frameLocator(".rc-diagram:has-text('Relay pairing flow') iframe")
      .locator("#host svg");
    await svg.waitFor({ timeout: 20_000 });
    // The frame reported its measured height back — the host sized to fit.
    const h = await frame.evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(h > 130, `frame did not grow to the diagram (h=${h})`);
    // The shell-drawn chrome badges the sandbox, outside the frame.
    assert.match(await block.locator(".rc-diagram-badge").innerText(), /sandboxed/);

    // Broken source: the failure state carries the message AND the source text.
    const failed = page2.locator(".rc-diagram-failed", { hasText: "broken diagram" });
    await failed.waitFor({ timeout: 20_000 });
    assert.match(await failed.innerText(), /diagram didn't render/);
    assert.ok((await failed.locator(".rc-diagram-source").innerText()).includes("nope"));
  });
});

test("a notice in the engine's own words is badged; the shell's own words aren't", async () => {
  // Own the session whose output is under test. The shared page has just
  // navigated through two folder tree fixtures; under runner load its attach /
  // replay can still be settling when this prompt is typed, so a timeout can
  // happen before the notice path runs and say nothing about attribution.
  await withFreshMockSession(browser, "e2e-notice-attribution-9c2f", async (page2) => {
    await page2.waitForSelector("textarea");
    await page2.locator("textarea").fill("show me a notice");
    await page2.keyboard.press("Enter");
    await page2.waitForSelector(".notice-line[data-source]", { timeout: 15_000 });

    // The engine's line carries its name and no shell glyph…
    const engine = page2.locator(".notice-line[data-source]").last();
    assert.equal(await engine.getAttribute("data-source"), "mock-engine");
    assert.equal(await engine.locator(".notice-source").innerText(), "mock-engine");
    assert.equal(await engine.locator(".notice-glyph").count(), 0);
    assert.match(await engine.innerText(), /re-enter your API key/);

    // …and Mirafold's own line carries the glyph and no badge, so the two can't
    // be confused: an engine string can't render as the shell speaking (2026-07-20).
    const shell = page2
      .locator(".notice-line:not([data-source])")
      .filter({ hasText: "context compacted" })
      .last();
    assert.equal(await shell.locator(".notice-source").count(), 0);
    assert.equal(await shell.locator(".notice-glyph").count(), 1);
    // The difference is visible, not just structural.
    assert.equal(
      await engine.evaluate((el) => getComputedStyle(el).borderLeftStyle),
      "dashed",
    );
    assert.equal(
      await shell.evaluate((el) => getComputedStyle(el).borderLeftStyle),
      "solid",
    );
  });
});
