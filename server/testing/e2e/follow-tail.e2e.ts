// Tier-3: the way back down. Scrolling up into scrollback shows the
// jump-to-latest pill; clicking it (or sending a prompt) returns the reader
// to the tail and hides it; at the bottom it is never shown. Desktop places
// it bottom-right of the transcript column, the phone bottom-center.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type Page } from "playwright-core";
import { launchChrome, withFreshMockSession, waitTurnIdle, typePrompt, PHONE_CONTEXT, assertAxeClean } from "./e2e-harness";

let browser: Browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

const bottomGap = (page: Page) =>
  page.locator(".output-zone").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Enough transcript to overflow the viewport. The mock deals replies from a
 *  shuffled deck with randomized details, so a fixed three turns can come up
 *  short (it did, 2026-08-29: overflow=0 on a compact draw); send until the
 *  overflow is really there, bounded by one full deck. */
const fillTranscript = async (
  page: Page,
  send: (text: string) => Promise<void> = async (text) => void (await typePrompt(page, text)),
) => {
  const overflow = () =>
    page.locator(".output-zone").evaluate((el) => el.scrollHeight - el.clientHeight);
  let n = 0;
  while (n < 6 && (n < 3 || (await overflow()) <= 300)) {
    n += 1;
    await send(`tell me about the fold, take ${n}`);
    await waitTurnIdle(page);
  }
  const got = await overflow();
  assert.ok(got > 300, `the transcript must overflow for this proof (overflow=${got} after ${n} turns)`);
};

const wheelUpOverTranscript = async (page: Page, dy: number) => {
  const box = (await page.locator(".output-zone").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -dy);
};

test("desktop: the pill appears only in scrollback, sits bottom-right of the transcript, and jumps back to the tail", async () => {
  await withFreshMockSession(browser, "e2e-follow-tail-desk-41ab", async (page) => {
    const pill = page.locator(".jump-to-latest");
    const send = async (text: string) => {
      const prompt = page.locator(".prompt-box textarea");
      await prompt.fill(text);
      await prompt.press("Enter");
    };
    await fillTranscript(page, send);

    // At the tail after streaming: nothing to jump to, so nothing shown.
    assert.ok((await bottomGap(page)) <= 24, "following should have left the reader at the bottom");
    assert.equal(await pill.isVisible(), false);

    // Steer up: the pill appears, inside the transcript column near its
    // bottom-right corner.
    await wheelUpOverTranscript(page, 400);
    await pill.waitFor({ state: "visible" });
    const zone = (await page.locator(".output-zone").boundingBox())!;
    const box = (await pill.boundingBox())!;
    assert.ok(box.x + box.width <= zone.x + zone.width - 8, "pill is inset from the right edge");
    assert.ok(box.x > zone.x + zone.width / 2, "pill sits on the right");
    assert.ok(box.y + box.height <= zone.y + zone.height - 4, "pill sits above the scroller's bottom edge");
    assert.ok(box.y + box.height > zone.y + zone.height - 60, "pill hugs the bottom");
    await assertAxeClean(page, "jump-to-latest pill");

    // Click: back at the tail, following again, pill gone, caret in the prompt.
    await pill.click();
    await pill.waitFor({ state: "hidden" });
    assert.ok((await bottomGap(page)) <= 24, "the click did not reach the bottom");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");

    // Steer up again, then send a prompt: sending re-arms following, so the
    // pill hides without a click and the new turn streams into view.
    await wheelUpOverTranscript(page, 400);
    await pill.waitFor({ state: "visible" });
    await send("one more");
    await pill.waitFor({ state: "hidden" });
    await waitTurnIdle(page);
    // Poll the tail: a final render can paint just after the turn settles,
    // growing the scroll height so the follow catches up a frame later
    // (a one-shot read flaked on the loaded CI runner, 2026-08-25).
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".output-zone") as HTMLElement | null;
        return el ? el.scrollHeight - el.scrollTop - el.clientHeight <= 24 : false;
      },
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(await pill.isVisible(), false);
  });
});

test("phone: the pill is centered for the thumb and still jumps to the tail", async () => {
  await withFreshMockSession(
    browser,
    "e2e-follow-tail-phone-7c02",
    async (page) => {
      const pill = page.locator(".jump-to-latest");
      // Enter is a newline on the phone; the send button is the gesture.
      const send = async (text: string) => {
        await page.locator("textarea").tap();
        await page.keyboard.type(text);
        await page.locator(".prompt-send").tap();
      };
      await fillTranscript(page, send);
      assert.equal(await pill.isVisible(), false);

      await wheelUpOverTranscript(page, 400);
      await pill.waitFor({ state: "visible" });
      const zone = (await page.locator(".output-zone").boundingBox())!;
      const box = (await pill.boundingBox())!;
      const zoneCenter = zone.x + zone.width / 2;
      const pillCenter = box.x + box.width / 2;
      assert.ok(Math.abs(pillCenter - zoneCenter) <= 4, `pill centered (zone ${zoneCenter}, pill ${pillCenter})`);
      assert.ok(box.width >= 40 && box.height >= 40, "a 40px thumb target");

      await pill.tap();
      await pill.waitFor({ state: "hidden" });
      assert.ok((await bottomGap(page)) <= 24, "the tap did not reach the bottom");
    },
    { context: PHONE_CONTEXT },
  );
});

// 2026-09-15 (Kyle: the "lightning fast scroll from way up to down low" on a
// cockpit switch): the switched-to page DID land at the tail, but paintings
// that size themselves after mount — a diagram rendering in its frame, an
// image loading, an artifact — grew the transcript afterwards with no
// transcript change to re-follow, so the reader sat hundreds of pixels
// above the bottom until the next message jumped them down. The content
// box's resize is followed now. Sampled per animation frame (a
// ResizeObserver re-pins inside the frame, so no painted frame may sit
// away from the tail once it has been reached).
test("switching to a session whose paintings size themselves after mount stays at the tail", async () => {
  await withFreshMockSession(browser, "e2e-follow-tail-grow-4c8e", async (page) => {
    for (const text of ["draw a diagram", "take a screenshot", "chart demo", "show an artifact"]) {
      await typePrompt(page, text);
      await waitTurnIdle(page);
    }
    await fillTranscript(page);
    // The LAST turn is a painting that sizes itself after mount, so its
    // growth lands INSIDE the viewport: growth above the viewport is
    // absorbed by the browser's own scroll anchoring and would let this
    // proof pass without the observer (cold review).
    await typePrompt(page, "draw a diagram");
    await waitTurnIdle(page);
    // Plain JS: tsx's esbuild keepNames helper is not serialized into the
    // page (see NF.2 / SA.1 in PLAN.md).
    await page.addInitScript(`
      (function () {
        var frames = []; window.__mfRafFrames = frames;
        function tick() {
          var el = document.querySelector(".output-zone");
          if (el && frames.length < 5000) frames.push({ top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight, rows: el.querySelectorAll(".turn-user").length });
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      })();
    `);
    await page.reload();
    await page.locator(".output-zone .turn-user").first().waitFor({ timeout: 15_000 });
    // Everything that sizes itself has done so: no diagram still rendering,
    // every image complete, and the geometry quiet for a moment.
    await page.waitForFunction(() => document.querySelectorAll(".rc-diagram-loading").length === 0, undefined, { timeout: 20_000 });
    await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete), undefined, { timeout: 20_000 });
    await page.waitForTimeout(600);
    const gap = await bottomGap(page);
    assert.ok(gap <= 24, `after the paintings settled the reader is still at the tail (gap=${gap})`);
    const frames = await page.evaluate(
      () => (window as unknown as { __mfRafFrames: { top: number; h: number; c: number; rows: number }[] }).__mfRafFrames,
    );
    const painted = frames.filter((f) => f.rows > 0 && f.h - f.c > 200);
    assert.ok(painted.length > 0, "the sampler saw the painted, overflowing transcript");
    const firstAtTail = painted.findIndex((f) => f.h - f.top - f.c <= 24);
    assert.ok(firstAtTail >= 0, "the transcript reached the tail");
    const grew = painted[painted.length - 1]!.h - painted[firstAtTail]!.h;
    assert.ok(grew > 100, `the proof needs post-mount growth to follow (grew ${grew}px after first reaching the tail)`);
    // A rAF callback runs BEFORE the frame's layout and ResizeObserver
    // step, so the frame in which a painting grows reads as away (the read
    // forces layout on the grown content; the re-pin follows in the same
    // frame) — and several paintings can finish sizing on adjacent frames.
    // A stranded reader is the other shape entirely: away on EVERY frame
    // until the next message, hundreds here across the settle wait. So: no
    // run of ten consecutive away frames (~170 ms) is allowed.
    const after = painted.slice(firstAtTail);
    let run = 0;
    let longest = 0;
    for (const f of after) {
      run = f.h - f.top - f.c > 100 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    assert.ok(longest < 10, `the reader sat away from the tail for ${longest} consecutive frames after growth`);
  });
});

test("switching to a session with a transcript lands at the tail with no top-to-bottom flash", async () => {
  await withFreshMockSession(browser, "e2e-follow-tail-switch-9d21", async (page) => {
    await fillTranscript(page);

    // A cockpit-panel switch is a plain link: full navigation, fresh mount,
    // whole-buffer replay. Reload takes the identical path. Sample the
    // scroller's geometry from a MutationObserver microtask after every DOM
    // change: a scroll correction that runs inside the commit (layout
    // effect) is already applied when the microtask looks, while one
    // deferred to a later task (passive effect) leaves the frame visibly
    // anchored away from the tail — the reader's top-to-bottom flash,
    // observable without real rendering (headless produces no animation
    // frames unless forced). Observed on the Document node: at
    // document-start, documentElement is still null.
    await page.addInitScript(() => {
      const frames: { top: number; h: number; c: number }[] = [];
      (window as unknown as { __mfFrames: typeof frames }).__mfFrames = frames;
      new MutationObserver(() => {
        const el = document.querySelector(".output-zone");
        if (el && frames.length < 5_000) {
          frames.push({ top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight });
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.reload();
    await page.locator(".output-zone .turn-user").first().waitFor({ timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".output-zone") as HTMLElement | null;
        return el ? el.scrollHeight - el.scrollTop - el.clientHeight <= 24 : false;
      },
      undefined,
      { timeout: 10_000 },
    );

    const frames = await page.evaluate(
      () => (window as unknown as { __mfFrames: { top: number; h: number; c: number }[] }).__mfFrames,
    );
    assert.ok(frames.length > 0, "the sampler observed the zone on the reloaded page");
    // Overflowing content painted with the viewport in the top half of the
    // scroll range is exactly the flash the reader sees.
    const awayFromTail = frames.filter((f) => f.h - f.c > 200 && f.top < (f.h - f.c) * 0.5);
    assert.equal(
      awayFromTail.length,
      0,
      `replay painted ${awayFromTail.length} of ${frames.length} frames away from the tail: ${JSON.stringify(awayFromTail.slice(0, 3))}`,
    );
  });
});

// A guard the 2026-09-16 CI stranding of the growth case (gap=510 after
// settle, not reproduced locally) prompted: a painting ABOVE the viewport
// shrinking makes Chrome's scroll anchoring lower scrollTop with no input
// behind it, and the backstop must not read that as the reader steering up.
// It held (the content observer re-pins and updates the backstop's last
// position before the scroll event runs), so this pins that ordering rather
// than explaining the CI failure.
test("a layout shift above the viewport does not detach a following reader", async () => {
  await withFreshMockSession(browser, "e2e-follow-tail-anchor-7a1c", async (page) => {
    await fillTranscript(page);
    await page.waitForFunction(() => { const el = document.querySelector(".output-zone") as HTMLElement; return el.scrollHeight - el.scrollTop - el.clientHeight <= 24; });
    // Shrink the first (out-of-view) turn by 400 px: scroll anchoring keeps
    // the visible content still by lowering scrollTop.
    await page.evaluate(() => {
      const first = document.querySelector(".output-zone .zone-content > *") as HTMLElement;
      first.style.height = "8px";
      first.style.overflow = "hidden";
    });
    await page.waitForTimeout(200);
    // Now the tail grows: a following reader must still be brought down.
    await page.evaluate(() => {
      const content = document.querySelector(".output-zone .zone-content") as HTMLElement;
      const filler = document.createElement("div");
      filler.style.height = "600px";
      filler.textContent = "late growth";
      content.appendChild(filler);
    });
    await page.waitForTimeout(300);
    const gap = await bottomGap(page);
    assert.ok(gap <= 24, `still following after a layout shift above the viewport (gap=${gap})`);
  });
});
