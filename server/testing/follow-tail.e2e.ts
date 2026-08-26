// Tier-3: the way back down. Scrolling up into scrollback shows the
// jump-to-latest pill; clicking it (or sending a prompt) returns the reader
// to the tail and hides it; at the bottom it is never shown. Desktop places
// it bottom-right of the transcript column, the phone bottom-center.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type Page } from "playwright-core";
import { launchChrome, withFreshMockSession, waitTurnIdle, PHONE_CONTEXT, assertAxeClean } from "./e2e-harness";

let browser: Browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

const bottomGap = (page: Page) =>
  page.locator(".output-zone").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Enough transcript to overflow the viewport (template turns paint a
 *  component each, so three is plenty at either geometry). */
const fillTranscript = async (page: Page, send: (text: string) => Promise<void>) => {
  for (const n of [1, 2, 3]) {
    await send(`tell me about the fold, take ${n}`);
    await waitTurnIdle(page);
  }
  const overflow = await page
    .locator(".output-zone")
    .evaluate((el) => el.scrollHeight - el.clientHeight);
  assert.ok(overflow > 300, `the transcript must overflow for this proof (overflow=${overflow})`);
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
    assert.ok((await bottomGap(page)) <= 24, "sending a prompt should return the reader to the tail");
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
