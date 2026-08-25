// Tier-3: the activity indicator and follow-the-tail scrolling, measured from
// a turn's START — which is why each test owns a fresh daemon and page.

import { test, before, after } from "node:test";
import { MOCK_PROMPTS } from "./mock-prompts";
import assert from "node:assert/strict";
import path from "node:path";
import { type Browser } from "playwright-core";
import { launchChrome, withFreshMockSession, assertAxeClean } from "./e2e-harness";

let browser: Browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

type BusyWatch = {
  __busyFrames: number;
  __blankFrames: number;
  __glyphFlips: number;
  __lastGlyph: string;
  __watch: number;
};

test("streaming holds a scrolled-up reader in place, and re-follows once back at the bottom", async () => {
  // Own the transcript and make it scrollable at a fixed viewport. The old
  // version borrowed 40 prior tests' worth of content, then jumped to the
  // bottom programmatically and sampled once; neither is a user's re-arm
  // path, and the delayed scroll event raced the next streamed paint.
  await withFreshMockSession(browser, "e2e-follow-tail-9c2f", async (page2) => {
    await page2.setViewportSize({ width: 900, height: 520 });
    await page2.waitForSelector("textarea");

    const zone = page2.locator(".output-zone");
    const geom = () =>
      zone.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, view: el.clientHeight }));
    const sendPlan = async () => {
      const before = await page2.locator(".turn-user", { hasText: "plan it step by step" }).count();
      await page2.locator("textarea").fill(MOCK_PROMPTS["checklist"]);
      await page2.keyboard.press("Enter");
      await page2.waitForFunction(
        (n) =>
          [...document.querySelectorAll(".turn-user")].filter((el) =>
            el.textContent?.includes("plan it step by step"),
          ).length > n,
        before,
        { timeout: 15_000 },
      );
    };

    // Three completed turns supply deterministic scrollback; the next is the
    // live stream under test. The document view's denser paragraph rhythm
    // leaves two turns only 277px taller than this fixed viewport, too little
    // for a meaningful 100px upward-wheel proof with 200px left below it.
    for (let i = 0; i < 3; i++) {
      const completeBefore = await page2
        .locator(".turn-assistant", { hasText: "Plan complete — all four steps done." })
        .count();
      await sendPlan();
      await page2.waitForFunction(
        (n) =>
          [...document.querySelectorAll(".turn-assistant")].filter((el) =>
            el.textContent?.includes("Plan complete — all four steps done."),
          ).length > n,
        completeBefore,
        { timeout: 30_000 },
      );
      await page2.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
        timeout: 15_000,
      });
    }
    const seeded = await geom();
    assert.ok(
      seeded.h - seeded.view > 300,
      `seed turn did not make scrollback (content ${seeded.h}px, viewport ${seeded.view}px)`,
    );

    const todoBefore = await page2.locator(".rc-todos").count();
    const finalBefore = await page2
      .locator(".turn-assistant", { hasText: "Plan complete — all four steps done." })
      .count();
    await sendPlan();
    await page2.waitForFunction(
      (n) => document.querySelectorAll(".rc-todos").length > n,
      todoBefore,
      { timeout: 15_000 },
    );

    // A real wheel up over the transcript: the reader is steering into
    // scrollback while the agent is still producing output.
    await zone.hover();
    const atWheel = await geom();
    await page2.mouse.wheel(0, -1_000);
    await page2.waitForFunction(
      ({ top }) => {
        const el = document.querySelector(".output-zone");
        return Boolean(
          el &&
            el.scrollTop < top - 100 &&
            el.scrollHeight - el.scrollTop - el.clientHeight > 200,
        );
      },
      atWheel,
      { timeout: 5_000 },
    );
    const before = await geom();

    // Clicking back into the session focuses the prompt without moving the
    // reader even one pixel or re-arming follow-tail. The subsequent growth
    // assertion proves output still lands below the detached viewport.
    await page2.locator("textarea").evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      const nativeFocus = textarea.focus.bind(textarea);
      textarea.focus = (options?: FocusOptions) => {
        textarea.dataset.focusPreventScroll = String(options?.preventScroll === true);
        nativeFocus(options);
      };
    });
    await zone.click({ position: { x: 2, y: 2 } });
    assert.equal(
      await page2.evaluate(() => document.activeElement?.matches(".prompt-box textarea")),
      true,
    );
    assert.equal(
      await page2.locator("textarea").getAttribute("data-focus-prevent-scroll"),
      "true",
      "transcript focus did not request the browser's no-scroll focus mode",
    );
    assert.equal((await geom()).top, before.top, "focusing the prompt moved transcript scrollTop");

    // New output must grow below without moving the scrolled-up reader.
    await page2.waitForFunction(
      ({ top, h }) => {
        const el = document.querySelector(".output-zone");
        return Boolean(el && el.scrollHeight > h && Math.abs(el.scrollTop - top) <= 1);
      },
      before,
      { timeout: 5_000 },
    );

    // Let that timed turn finish, then use a permission request as a latch
    // for the re-arm half. Sending the request legitimately returns to the
    // tail; scroll up once more while the engine is guaranteed to remain
    // busy until this test answers.
    await page2.waitForFunction(
      (n) =>
        [...document.querySelectorAll(".turn-assistant")].filter((el) =>
          el.textContent?.includes("Plan complete — all four steps done."),
        ).length > n,
      finalBefore,
      { timeout: 30_000 },
    );
    await page2.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
      timeout: 15_000,
    });
    await page2.locator("textarea").fill(MOCK_PROMPTS["permission-ask"]);
    await page2.keyboard.press("Enter");
    await page2.waitForSelector(".perm-bar", { timeout: 15_000 });

    await zone.hover();
    const latchedAtWheel = await geom();
    await page2.mouse.wheel(0, -1_000);
    await page2.waitForFunction(
      ({ top }) => {
        const el = document.querySelector(".output-zone");
        return Boolean(
          el &&
            el.scrollTop < top - 100 &&
            el.scrollHeight - el.scrollTop - el.clientHeight > 200,
        );
      },
      latchedAtWheel,
      { timeout: 5_000 },
    );

    // A real downward gesture that reaches the current tail arms from its
    // pre-input geometry. The unanswered permission keeps the premise
    // stable; no timer can end the turn between the gesture and assertion.
    const beforeReturn = await geom();
    await page2.mouse.wheel(0, beforeReturn.h + beforeReturn.view);
    await page2.waitForFunction(
      () => {
        const el = document.querySelector(".output-zone");
        return Boolean(
          el &&
            document.querySelector(".stop-btn") &&
            document.querySelector(".perm-bar") &&
            el.scrollHeight - el.scrollTop - el.clientHeight <= 60,
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    const rearmed = await geom();

    // Allowing resolves the latch and starts tool/output frames without a
    // new user prompt (which would arm following independently). Do not
    // merely prove one scroll landed: that later content must carry the
    // viewport with it.
    await page2.locator(".perm-allow").click();
    await page2.waitForFunction(
      (h) => {
        const el = document.querySelector(".output-zone");
        return Boolean(
          el &&
            el.scrollHeight > h &&
            el.scrollHeight - el.scrollTop - el.clientHeight <= 60,
        );
      },
      rearmed.h,
      { timeout: 5_000 },
    );
    await page2.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
      timeout: 15_000,
    });
    await page2.waitForFunction(() => {
      const el = document.querySelector(".output-zone");
      return Boolean(el && el.scrollHeight - el.scrollTop - el.clientHeight <= 60);
    });
  });
});

test("an overflowing prose transcript supports keyboard scrolling and End re-arms following", async () => {
  await withFreshMockSession(browser, "e2e-transcript-keyboard-9c2f", async (page2) => {
    await page2.setViewportSize({ width: 900, height: 520 });
    await page2.waitForSelector("textarea");
    const zone = page2.locator(".output-zone");
    const geom = () =>
      zone.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, view: el.clientHeight }));

    // Make deterministic overflow out of inert response prose. Submitted
    // inputs now intentionally carry the Phase-IH arrow pairs; beyond those,
    // the scroller itself remains the keyboard PageUp/End access path.
    for (let i = 0; i < 8; i++) {
      const before = await page2.locator(".notice-line[data-source]").count();
      await page2.locator("textarea").fill(`notice attribution ${i}`);
      await page2.keyboard.press("Enter");
      await page2.waitForFunction(
        (n) => document.querySelectorAll(".notice-line[data-source]").length > n,
        before,
        { timeout: 15_000 },
      );
      await page2.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
        timeout: 15_000,
      });
    }
    const seeded = await geom();
    assert.ok(
      seeded.h - seeded.view > 300,
      `notice turns did not make scrollback (content ${seeded.h}px, viewport ${seeded.view}px)`,
    );
    assert.equal(await zone.getAttribute("tabindex"), "0");
    const descendantControls = await zone
      .locator("a, button, input, select, textarea, [tabindex]")
      .count();
    const navigationControls = await zone.locator(".input-nav-arrow").count();
    assert.equal(navigationControls, 16, "each of eight submitted inputs needs both arrows");
    assert.equal(
      descendantControls,
      navigationControls,
      "fixture gained a transcript control outside submitted-input navigation",
    );
    await assertAxeClean(page2, "overflowing prose-only transcript");

    // Hold a turn open so output after End can prove follow-tail was re-armed,
    // not just that the browser performed one isolated scroll.
    await page2.locator("textarea").fill(MOCK_PROMPTS["permission-ask"]);
    await page2.keyboard.press("Enter");
    await page2.waitForSelector(".perm-bar", { timeout: 15_000 });

    await zone.focus();
    const focus = await zone.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        active: document.activeElement === el,
        visible: el.matches(":focus-visible"),
        outline: style.outlineStyle,
      };
    });
    assert.ok(focus.active, "transcript did not accept focus");
    assert.ok(focus.visible, "transcript focus ring was not keyboard-visible");
    assert.notEqual(focus.outline, "none", "transcript has no visible focus outline");

    const atBottom = await geom();
    await page2.keyboard.press("PageUp");
    await page2.waitForFunction(
      ({ top }) => {
        const el = document.querySelector(".output-zone");
        return Boolean(
          el &&
            el.scrollTop < top - 100 &&
            el.scrollHeight - el.scrollTop - el.clientHeight > 200,
        );
      },
      atBottom,
      { timeout: 5_000 },
    );

    await page2.keyboard.press("End");
    await page2.waitForFunction(
      () => {
        const el = document.querySelector(".output-zone");
        return Boolean(el && el.scrollHeight - el.scrollTop - el.clientHeight <= 60);
      },
      undefined,
      { timeout: 5_000 },
    );
    const rearmed = await geom();

    await page2.locator(".perm-allow").click();
    await page2.waitForFunction(
      (h) => {
        const el = document.querySelector(".output-zone");
        return Boolean(
          el &&
            el.scrollHeight > h &&
            el.scrollHeight - el.scrollTop - el.clientHeight <= 60,
        );
      },
      rearmed.h,
      { timeout: 5_000 },
    );
    await page2.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
      timeout: 15_000,
    });
  });
});

test("a busy turn never looks idle: the indicator is up, moving, and on screen whenever the stop button is", async () => {
  // Own the state under test. The old shared-page/checklist version waited
  // for a transient line, then made another Playwright round-trip to read it;
  // a loaded runner could deliver the scripted turn_end between those calls,
  // correctly remove the line, and make textContent() wait 30 seconds for an
  // element that was supposed to stay gone. A permission request is the
  // mock's deterministic latch: the turn cannot end until this test answers.
  await withFreshMockSession(browser, "e2e-busy-indicator-9c2f", async (page2) => {
    await page2.waitForSelector("textarea");

    // Frame-by-frame watcher, armed BEFORE the prompt goes out: any frame
    // where the turn is in flight (stop button present) but no activity line
    // is painted is the 2026-07-28 bug — work happening with nothing showing.
    // It also counts glyph frame CHANGES: a present-but-frozen line is the
    // 2026-07-29 bug. The callback stays anonymous because tsx's keepNames
    // wrapper does not exist inside the page.
    await page2.evaluate(() => {
      const w = window as unknown as BusyWatch;
      w.__busyFrames = 0;
      w.__blankFrames = 0;
      w.__glyphFlips = 0;
      w.__lastGlyph = "";
      w.__watch = window.setInterval(() => {
        if (document.querySelector(".stop-btn")) {
          w.__busyFrames++;
          const glyph = document.querySelector(".activity-glyph")?.textContent;
          if (glyph === undefined) w.__blankFrames++;
          else if (glyph !== w.__lastGlyph) {
            if (w.__lastGlyph !== "") w.__glyphFlips++;
            w.__lastGlyph = glyph;
          }
        }
      }, 16);
    });

    await page2.locator("textarea").fill(MOCK_PROMPTS["permission-ask"]);
    await page2.keyboard.press("Enter");
    await page2.waitForSelector(".perm-bar", { timeout: 15_000 });
    // The permission bar holds the busy state open, so this waits for real
    // movement rather than betting that a timed mock reply stays alive long
    // enough for two browser round-trips.
    await page2.waitForFunction(
      () => (window as unknown as BusyWatch).__glyphFlips >= 3,
      undefined,
      { timeout: 5_000 },
    );

    // Scroll and snapshot in one page task while the latch is still held.
    // The elapsed text and viewport placement cannot disappear between two
    // Playwright calls now.
    const held = await page2.evaluate(() => {
      document.querySelector(".output-zone")!.scrollTop = 0;
      const line = document.querySelector(".activity-line");
      const r = line?.getBoundingClientRect();
      return {
        text: line?.textContent ?? "",
        visible: Boolean(r && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight),
      };
    });
    assert.match(held.text, /\(\d+s\)/, "no elapsed counter in the activity line");
    assert.ok(held.visible, "indicator off screen while the transcript is scrolled up");

    await page2.locator(".perm-deny").click();
    await page2.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
      timeout: 15_000,
    });
    await page2.waitForSelector(".activity-line", { state: "detached", timeout: 5_000 });
    const frames = await page2.evaluate(() => {
      const w = window as unknown as BusyWatch;
      window.clearInterval(w.__watch);
      return { busy: w.__busyFrames, blank: w.__blankFrames, flips: w.__glyphFlips };
    });
    assert.ok(frames.busy > 0, "the sampler never saw the turn in flight");
    assert.equal(
      frames.blank,
      0,
      `${frames.blank} frame(s) had a turn in flight with no activity line painted`,
    );
    assert.ok(frames.flips >= 3, `the glyph moved only ${frames.flips} time(s) while held busy`);
    assert.equal(await page2.locator(".activity-line").count(), 0);
  });
});
