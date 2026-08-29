// Tier-3 (see app.e2e.ts for the tier rules): the live response document —
// how prose, paintings and subagent decks stream, reflow, and stay restrained.
// Every test owns a fresh daemon and page.

import { test, before, after } from "node:test";
import { MOCK_PROMPTS } from "./mock-prompts";
import assert from "node:assert/strict";
import { THEMES } from "../../web/src/themes/manifest";
import { type Browser, type Locator, type Page } from "playwright-core";
import { launchChrome, withFreshMockSession, typePrompt, assertAxeClean, noSideScroll } from "./e2e-harness";

let browser: Browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

async function settleLiveDocument(p: Page): Promise<Locator> {
  const prompt = await typePrompt(p, MOCK_PROMPTS["live-document"]);
  await p
    .locator(".turn-assistant", { hasText: "response finished as one live composition" })
    .waitFor({ timeout: 30_000 });
  await p.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });
  return prompt;
}

function readLiveDocumentPresentation(p: Page) {
  return p.evaluate(() => {
    const userTurn = document.querySelector(".turn-user") as HTMLElement | null;
    const response = document.querySelector(".response-document") as HTMLElement | null;
    const prose = response?.querySelector(".turn-assistant") as HTMLElement | null;
    const card = response?.querySelector(".rc-card") as HTMLElement | null;
    const wideTable = document.querySelector(".response-document .rc-table") as HTMLElement | null;
    const h1 = document.querySelector(".response-document h1") as HTMLElement | null;
    const h2 = document.querySelector(".response-document h2") as HTMLElement | null;
    const h3 = document.querySelector(".response-document h3") as HTMLElement | null;
    const quote = document.querySelector(".response-document blockquote") as HTMLElement | null;
    const code = document.querySelector(
      ".response-document .markdown pre code.hljs",
    ) as HTMLElement | null;
    const markdownTable = document.querySelector(
      ".response-document .markdown-table-scroll",
    ) as HTMLElement | null;
    if (
      !userTurn ||
      !response ||
      !prose ||
      !card ||
      !wideTable ||
      !h1 ||
      !h2 ||
      !h3 ||
      !quote ||
      !code ||
      !markdownTable
    ) {
      return null;
    }
    const userTurnRect = userTurn.getBoundingClientRect();
    const responseRect = response.getBoundingClientRect();
    const proseRect = prose.getBoundingClientRect();
    const h1Style = getComputedStyle(h1);
    const h2Style = getComputedStyle(h2);
    const h3Style = getComputedStyle(h3);
    const userStyle = getComputedStyle(userTurn);
    const userOutlineStyle = getComputedStyle(userTurn, "::before");
    const quoteStyle = getComputedStyle(quote);
    return {
      documentWidth: responseRect.width,
      leftAxisDelta: responseRect.left - userTurnRect.left,
      userLabels: userTurn.querySelectorAll(".turn-user-label").length,
      userBackground: userStyle.backgroundColor,
      userAccentRule: Number.parseFloat(userStyle.borderLeftWidth),
      userRightBorder: Number.parseFloat(userStyle.borderRightWidth),
      userOutline: userOutlineStyle.backgroundImage,
      proseWidth: proseRect.width,
      cardWidth: card.getBoundingClientRect().width,
      wideTableWidth: wideTable.getBoundingClientRect().width,
      h1Size: Number.parseFloat(h1Style.fontSize),
      h2Size: Number.parseFloat(h2Style.fontSize),
      h3Size: Number.parseFloat(h3Style.fontSize),
      h1Divider: Number.parseFloat(h1Style.borderBottomWidth),
      h2Marker: Number.parseFloat(h2Style.borderLeftWidth),
      quoteRule: Number.parseFloat(quoteStyle.borderLeftWidth),
      quoteBackground: quoteStyle.backgroundColor,
      proseBackground: getComputedStyle(prose).backgroundColor,
      codeOwnsOverflow: code.scrollWidth > code.clientWidth,
      markdownTableTabIndex: markdownTable.tabIndex,
      pageOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

function readResponsiveDocumentLayout(p: Page) {
  return p.evaluate(() => {
    const zone = document.querySelector(".output-zone") as HTMLElement | null;
    const response = document.querySelector(".response-document") as HTMLElement | null;
    const prose = response?.querySelector(".turn-assistant") as HTMLElement | null;
    const code = document.querySelector(
      ".response-document .markdown pre code.hljs",
    ) as HTMLElement | null;
    const markdownTable = document.querySelector(
      ".response-document .markdown-table-scroll",
    ) as HTMLElement | null;
    const richTable = document.querySelector(
      ".response-document .rc-table",
    ) as HTMLElement | null;
    if (!zone || !response || !prose || !code || !markdownTable || !richTable) {
      return null;
    }
    const zoneRect = zone.getBoundingClientRect();
    const responseRect = response.getBoundingClientRect();
    const proseRect = prose.getBoundingClientRect();
    const markdownTableRect = markdownTable.getBoundingClientRect();
    const richTableRect = richTable.getBoundingClientRect();
    const zoneStyle = getComputedStyle(zone);
    const contentLeft = zoneRect.left + Number.parseFloat(zoneStyle.paddingLeft);
    const contentRight = zoneRect.right - Number.parseFloat(zoneStyle.paddingRight);
    const fileContent = document.querySelector(".folder-tree-view .fv-content") as HTMLElement | null;
    const filePanel = document.querySelector(".folder-tree-panel") as HTMLElement | null;
    const fileContentRect = fileContent?.getBoundingClientRect();
    const filePanelRect = filePanel?.getBoundingClientRect();
    return {
      documentWidth: responseRect.width,
      proseWidth: proseRect.width,
      proseHeight: proseRect.height,
      pageOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      documentContained:
        responseRect.left >= contentLeft - 1 && responseRect.right <= contentRight + 1,
      markdownTableContained:
        markdownTableRect.left >= responseRect.left - 1 &&
        markdownTableRect.right <= responseRect.right + 1,
      richTableContained:
        richTableRect.left >= responseRect.left - 1 &&
        richTableRect.right <= responseRect.right + 1,
      codeOwnsOverflow: code.scrollWidth > code.clientWidth,
      fileContentContained:
        !fileContentRect ||
        !filePanelRect ||
        (fileContentRect.left >= filePanelRect.left - 1 &&
          fileContentRect.right <= filePanelRect.right + 1),
      scrollTop: zone.scrollTop,
      bottomDistance: zone.scrollHeight - zone.clientHeight - zone.scrollTop,
    };
  });
}

test("LD.1: a response document streams around a stable painting and soft shell interruption", async () => {
  await withFreshMockSession(browser, "live-document-structure-7fd1", async (p) => {
    await p.locator("textarea").click();
    await p.keyboard.type(MOCK_PROMPTS["live-document"]);
    await p.keyboard.press("Enter");

    await p.waitForSelector(".activity-line", { timeout: 15_000 });
    const firstDocument = p.locator(".response-document").first();
    await firstDocument
      .locator(".turn-assistant", { hasText: "first section is already visible" })
      .waitFor({ timeout: 15_000 });
    assert.equal(
      await p.locator(".activity-line").count(),
      1,
      "the first document content waited until turn_end",
    );

    const checkpoint = firstDocument.locator(".rc-card", {
      hasText: "Live document checkpoint",
    });
    await checkpoint.waitFor({ timeout: 15_000 });
    assert.equal(
      await p.locator(".activity-line").count(),
      1,
      "the registry component waited until turn_end",
    );
    assert.equal(
      await p.locator(".turn-assistant", { hasText: "Later prose begins beneath" }).count(),
      0,
      "the registry component did not paint before subsequent prose",
    );
    await checkpoint.evaluate((element) => {
      (element as HTMLElement & { __liveDocumentIdentity?: string }).__liveDocumentIdentity =
        "mounted-before-later-prose";
    });

    const notice = p.locator(".notice-line", {
      hasText: "shell remains distinct",
    });
    await notice.waitFor({ timeout: 15_000 });
    await p
      .locator(".turn-assistant", { hasText: "Later prose begins beneath" })
      .waitFor({ timeout: 15_000 });

    const documents = p.locator(".response-document");
    await p.waitForFunction(
      () => document.querySelectorAll(".response-document").length >= 2,
    );
    const documentMeta = await documents.evaluateAll((elements) =>
      elements.slice(0, 2).map((element) => ({
        responseKey: element.getAttribute("data-response-key"),
        continuation: element.hasAttribute("data-response-continuation"),
      })),
    );
    assert.equal(documentMeta[0]?.responseKey, documentMeta[1]?.responseKey);
    assert.equal(documentMeta[0]?.continuation, false);
    assert.equal(documentMeta[1]?.continuation, true);

    assert.equal(
      await p.evaluate(() => {
        const first = document.querySelectorAll(".response-document")[0];
        const shell = document.querySelector(".notice-line");
        const second = document.querySelectorAll(".response-document")[1];
        if (!first || !shell || !second) return false;
        return Boolean(
          first.compareDocumentPosition(shell) & Node.DOCUMENT_POSITION_FOLLOWING,
        ) && Boolean(
          shell.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
      true,
      "the soft shell row moved out of transcript order",
    );
    assert.equal(
      await checkpoint.evaluate(
        (element) =>
          (element as HTMLElement & { __liveDocumentIdentity?: string })
            .__liveDocumentIdentity,
      ),
      "mounted-before-later-prose",
      "later prose remounted the earlier registry component",
    );

    const secondDocument = documents.nth(1);
    await secondDocument
      .locator(".rc-table", { hasText: "Composition checks" })
      .waitFor({ timeout: 15_000 });
    await secondDocument
      .locator(".turn-assistant", { hasText: "response finished as one live composition" })
      .waitFor({ timeout: 15_000 });
    const secondKinds = await secondDocument.locator(":scope > *").evaluateAll((elements) =>
      elements.map((element) =>
        element.classList.contains("turn-assistant")
          ? "text"
          : element.classList.contains("turn-render")
            ? "render"
            : "other",
      ),
    );
    assert.deepEqual(secondKinds, ["text", "render", "text"]);
    await p.waitForSelector(".activity-line", { state: "detached", timeout: 15_000 });
  });
});

test("LD.2: document measure, hierarchy, rich lane, local overflow, and short-answer restraint", async () => {
  await withFreshMockSession(browser, "live-document-visual-2a91", async (p) => {
    await p.setViewportSize({ width: 1440, height: 1000 });
    const prompt = await settleLiveDocument(p);

    const metrics = await readLiveDocumentPresentation(p);

    assert.ok(metrics, "the canonical document fixture did not fully render");
    assert.ok(metrics.documentWidth > 900 && metrics.documentWidth <= 1160.5);
    assert.ok(
      Math.abs(metrics.leftAxisDelta) <= 1,
      `the response moved off the transcript's left axis by ${metrics.leftAxisDelta}px`,
    );
    assert.equal(metrics.userLabels, 0);
    assert.notEqual(metrics.userBackground, "rgba(0, 0, 0, 0)");
    assert.ok(metrics.userAccentRule >= 3);
    assert.equal(metrics.userRightBorder, 0);
    assert.match(metrics.userOutline, /linear-gradient/);
    assert.ok(metrics.proseWidth < metrics.documentWidth);
    assert.ok(metrics.cardWidth < metrics.documentWidth);
    assert.ok(Math.abs(metrics.wideTableWidth - metrics.documentWidth) <= 1);
    assert.ok(metrics.h1Size > metrics.h2Size && metrics.h2Size > metrics.h3Size);
    assert.ok(metrics.h1Divider >= 1);
    assert.ok(metrics.h2Marker >= 2);
    assert.ok(metrics.quoteRule >= 2);
    assert.notEqual(metrics.quoteBackground, "rgba(0, 0, 0, 0)");
    assert.equal(metrics.proseBackground, "rgba(0, 0, 0, 0)");
    assert.equal(metrics.codeOwnsOverflow, true);
    assert.equal(metrics.markdownTableTabIndex, 0);
    assert.ok(metrics.pageOverflow <= 1);
    await assertAxeClean(p, "live document composition");

    await prompt.fill(MOCK_PROMPTS["short-document"]);
    await prompt.press("Enter");
    const shortDocument = p.locator(".response-document").last();
    await shortDocument
      .locator(".turn-assistant", { hasText: "workspace is ready for the next decision" })
      .waitFor({ timeout: 15_000 });
    await p.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });
    const shortShape = await shortDocument.evaluate((element) => {
      const prose = element.querySelector(".turn-assistant") as HTMLElement | null;
      const style = prose ? getComputedStyle(prose) : null;
      return {
        children: element.children.length,
        paintings: element.querySelectorAll(".rc, .artifact").length,
        background: style?.backgroundColor,
        borderWidth: style?.borderWidth,
      };
    });
    assert.deepEqual(shortShape, {
      children: 1,
      paintings: 0,
      background: "rgba(0, 0, 0, 0)",
      borderWidth: "0px",
    });
  });
});

test("LD.3: response documents reflow across folder tree, file view, pin dock, and narrow desktop", async () => {
  await withFreshMockSession(browser, "live-document-responsive-18c4", async (p) => {
    await p.setViewportSize({ width: 1440, height: 1000 });
    await settleLiveDocument(p);

    const measure = () => readResponsiveDocumentLayout(p);

    const center = await measure();
    assert.ok(center, "center-only response metrics are missing");

    await p.locator(".ab-folder-tree").click();
    await p.waitForSelector(".folder-tree-panel .folder-tree-row");
    const folderTree = await measure();
    assert.ok(folderTree, "Folder tree response metrics are missing");

    const checkpointTurn = p.locator(".turn-render", {
      has: p.locator(".rc-card", { hasText: "Live document checkpoint" }),
    });
    await checkpointTurn.hover();
    await checkpointTurn.locator(".pin-btn").click();
    await p.waitForSelector(".pin-dock .rc-card");
    const both = await measure();
    assert.ok(both, "Folder tree plus pin-dock response metrics are missing");

    await p.locator(".folder-tree-file-row", { hasText: "package.json" }).first().click();
    await p.waitForSelector(".folder-tree-view .fv-content");
    const fileAndDock = await measure();
    assert.ok(fileAndDock, "file-view plus pin-dock response metrics are missing");

    await p.setViewportSize({ width: 980, height: 760 });
    await p.waitForFunction(() => window.innerWidth === 980);
    const narrow = await measure();
    assert.ok(narrow, "narrow three-pane response metrics are missing");

    for (const [name, metrics] of [
      ["center", center],
      ["Folder tree", folderTree],
      ["Folder tree + dock", both],
      ["file view + dock", fileAndDock],
      ["narrow three-pane", narrow],
    ] as const) {
      assert.ok(metrics.pageOverflow <= 1, `${name} overflowed the page by ${metrics.pageOverflow}px`);
      assert.equal(metrics.documentContained, true, `${name} document escaped the center column`);
      assert.equal(metrics.markdownTableContained, true, `${name} Markdown table escaped its document`);
      assert.equal(metrics.richTableContained, true, `${name} registry table escaped its document`);
      assert.equal(metrics.fileContentContained, true, `${name} file content escaped folder tree`);
    }
    assert.equal(center.codeOwnsOverflow, true, "wide code did not retain local overflow");
    assert.ok(center.documentWidth > folderTree.documentWidth);
    assert.ok(folderTree.documentWidth > both.documentWidth);
    assert.ok(Math.abs(fileAndDock.documentWidth - both.documentWidth) <= 1);
    assert.ok(both.documentWidth > narrow.documentWidth);
    assert.ok(narrow.documentWidth >= 280, `narrow document collapsed to ${narrow.documentWidth}px`);
    assert.ok(narrow.proseWidth < center.proseWidth);
    assert.ok(narrow.proseHeight > center.proseHeight, "narrow prose did not reflow vertically");

    // Exercise the remaining intrinsically wide content while all three
    // desktop columns are present at 980px. The artifact deliberately has a
    // 720px internal canvas: its own iframe must scroll, never the workbench.
    await p.locator(".output-zone").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await typePrompt(p, MOCK_PROMPTS["responsive-document"]);
    const stressDocument = p.locator(".response-document", { hasText: "Width stress" });
    await stressDocument.locator(".rc-diff").waitFor({ timeout: 15_000 });
    await stressDocument.locator(".rc-chart").waitFor({ timeout: 15_000 });
    const finalStressProse = stressDocument.locator(".turn-assistant", {
      hasText: "without widening the workbench",
    });
    await stressDocument.locator(".artifact").waitFor({ timeout: 15_000 });
    assert.equal(
      await p.locator(".activity-line").count(),
      1,
      "the artifact waited until turn_end",
    );
    assert.equal(
      await finalStressProse.count(),
      0,
      "the artifact did not paint before subsequent prose",
    );
    const artifactHandle = await stressDocument
      .locator("iframe.artifact-frame")
      .elementHandle({ timeout: 15_000 });
    assert.ok(artifactHandle, "responsive artifact frame did not render");
    const artifactFrame = await artifactHandle.contentFrame();
    assert.ok(artifactFrame, "responsive artifact frame was unavailable");
    await artifactFrame.waitForSelector(".wide", { timeout: 15_000 });
    await finalStressProse.waitFor({ timeout: 15_000 });
    await p.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });

    const stressShape = await stressDocument.evaluate((element) => {
      const documentRect = element.getBoundingClientRect();
      const chartPlot = element.querySelector(".rc-chart-plot") as HTMLElement | null;
      const chartCanvas = chartPlot?.querySelector("svg") as SVGElement | null;
      const paintings = [
        element.querySelector(".rc-diff"),
        element.querySelector(".rc-chart"),
        element.querySelector(".artifact"),
        element.querySelector("iframe.artifact-frame"),
      ];
      return {
        allContained: paintings.every((painting) => {
          if (!(painting instanceof HTMLElement)) return false;
          const rect = painting.getBoundingClientRect();
          return rect.left >= documentRect.left - 1 && rect.right <= documentRect.right + 1;
        }),
        pageOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        chartOwnsOverflow:
          chartPlot ? chartPlot.scrollWidth > chartPlot.clientWidth : false,
        chartTabIndex: chartPlot?.tabIndex ?? -1,
        chartCanvasWidth: chartCanvas?.getBoundingClientRect().width ?? 0,
      };
    });
    assert.equal(stressShape.allContained, true, "wide painting escaped the narrow document");
    assert.ok(stressShape.pageOverflow <= 1);
    assert.equal(stressShape.chartOwnsOverflow, true, "narrow chart did not own its overflow");
    assert.equal(stressShape.chartTabIndex, 0, "narrow chart overflow is not keyboard reachable");
    assert.ok(stressShape.chartCanvasWidth >= 599, "chart canvas shrank below readable measure");
    assert.equal(
      await artifactFrame.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
      true,
      "wide artifact content did not keep its overflow inside the sandbox",
    );
    const tail = await measure();
    assert.ok(tail, "tail metrics are missing after responsive stress");
    assert.ok(tail.bottomDistance <= 2, `streaming stopped ${tail.bottomDistance}px above the tail`);

    // A user who has scrolled back must not be snapped to the tail merely
    // because workspace chrome closes and the document reflows wider.
    const manualScroll = await p.locator(".output-zone").evaluate((element) => {
      element.scrollTop = 120;
      return element.scrollTop;
    });
    assert.ok(manualScroll > 0, "fixture is not tall enough to exercise manual scroll");
    await p.locator(".ab-folder-tree").click();
    await p.waitForSelector(".folder-tree-panel", { state: "detached" });
    const dockOnly = await measure();
    assert.ok(dockOnly, "dock-only response metrics are missing");
    assert.ok(dockOnly.documentWidth > narrow.documentWidth);
    assert.ok(
      Math.abs(dockOnly.scrollTop - manualScroll) <= 2,
      `closing folder tree moved manual scroll from ${manualScroll}px to ${dockOnly.scrollTop}px`,
    );

    await p.locator(".pin-dock .dock-btn").click();
    await p.waitForSelector(".pin-tab");
    const collapsedDock = await measure();
    assert.ok(collapsedDock, "collapsed-dock response metrics are missing");
    assert.ok(collapsedDock.documentWidth > dockOnly.documentWidth);
    assert.ok(collapsedDock.pageOverflow <= 1);

    await p.locator(".pin-stub", { hasText: "card" }).click();
    await p.waitForSelector(".pin-tab", { state: "detached" });
    const restored = await measure();
    assert.ok(restored, "restored response metrics are missing");
    assert.ok(restored.documentWidth > collapsedDock.documentWidth);
    assert.ok(restored.pageOverflow <= 1);
  });
});

test("LD.4: long text, focus, announcements, reduced motion, and every theme remain restrained", async () => {
  await withFreshMockSession(browser, "live-document-closure-63bc", async (p) => {
    await p.setViewportSize({ width: 1440, height: 800 });
    await p.emulateMedia({ reducedMotion: "reduce" });
    const prompt = await typePrompt(p, MOCK_PROMPTS["document-closure"]);

    const response = p.locator(".response-document", {
      hasText: "This heading-free technical note",
    });
    await response.locator("text=Closure stress complete.").waitFor({ timeout: 30_000 });
    await p.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });

    const shape = await response.evaluate((element) => {
      const zone = document.querySelector(".output-zone") as HTMLElement | null;
      const prose = element.querySelector(".turn-assistant") as HTMLElement | null;
      const code = element.querySelector("pre code.hljs") as HTMLElement | null;
      const style = prose ? getComputedStyle(prose) : null;
      return {
        children: element.children.length,
        headings: element.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
        paintings: element.querySelectorAll(".rc, .artifact").length,
        height: element.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        proseOwnsWidth: prose ? prose.scrollWidth <= prose.clientWidth + 1 : false,
        codeOwnsOverflow: code ? code.scrollWidth > code.clientWidth : false,
        codeTabIndex: code?.tabIndex ?? -1,
        pageOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bottomDistance: zone ? zone.scrollHeight - zone.clientHeight - zone.scrollTop : -1,
        responseRole: element.getAttribute("role"),
        responseLive: element.getAttribute("aria-live"),
        proseAnimation: style?.animationName,
        proseTransition: style?.transitionDuration,
      };
    });
    assert.equal(shape.children, 1);
    assert.equal(shape.headings, 0);
    assert.equal(shape.paintings, 0);
    assert.ok(shape.height > shape.viewportHeight * 2, "the long-answer fixture is not genuinely tall");
    assert.equal(shape.proseOwnsWidth, true);
    assert.equal(shape.codeOwnsOverflow, true);
    assert.equal(shape.codeTabIndex, 0);
    assert.ok(shape.pageOverflow <= 1);
    assert.ok(shape.bottomDistance <= 2);
    assert.equal(shape.responseRole, null);
    assert.equal(shape.responseLive, null);
    assert.equal(shape.proseAnimation, "none");
    assert.equal(shape.proseTransition, "0s");
    assert.equal(await response.locator('a[href^="https://example.invalid/diagnostics/"]').count(), 1);
    assert.equal(
      await response.locator("code", { hasText: "deeply-nested-workspace" }).count(),
      1,
    );

    const log = p.locator('.output-zone[role="log"]');
    assert.equal(await log.getAttribute("aria-live"), "off");
    await p.waitForFunction(
      () =>
        document
          .querySelector('[role="status"]')
          ?.textContent?.includes("Response truncated for reading"),
      undefined,
      { timeout: 15_000 },
    );

    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const selection = await response.locator(".turn-assistant").evaluate((element) => {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      if (!text || !text.textContent) return { text: "", promptFocused: false };
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, Math.min(24, text.textContent.length));
      const current = window.getSelection()!;
      current.removeAllRanges();
      current.addRange(range);
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerType: "mouse",
          button: 0,
          isPrimary: true,
        }),
      );
      return {
        text: current.toString(),
        promptFocused: document.activeElement?.matches(".prompt-box textarea") ?? false,
      };
    });
    assert.ok(selection.text.length > 0);
    assert.equal(selection.promptFocused, false, "selection was collapsed into prompt focus");

    await response.evaluate((element) => {
      window.getSelection()?.removeAllRanges();
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerType: "mouse",
          button: 0,
          isPrimary: true,
        }),
      );
    });
    assert.equal(
      await prompt.evaluate((element) => document.activeElement === element),
      true,
      "a plain transcript click no longer focuses the prompt",
    );

    await response.evaluate((element) => {
      (element as HTMLElement & { __ld4Identity?: string }).__ld4Identity = "before-themes";
    });
    const baseGeometry = await response.evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      width: element.getBoundingClientRect().width,
    }));
    await p.locator(".sb-settings").click();
    await p.locator(".settings-card").waitFor();
    for (const theme of THEMES) {
      const groupLabel = theme.appearance === "light" ? "Light themes" : "Dark themes";
      const group = p.locator(`.theme-group[aria-label="${groupLabel}"]`);
      const names = await group.locator(".theme-row-name").allInnerTexts();
      const index = names.indexOf(theme.displayName);
      assert.ok(index >= 0, `theme row ${theme.id} is missing`);
      await group.locator(".theme-row").nth(index).click();
      await p.waitForFunction(
        (id) => document.documentElement.getAttribute("data-theme") === id,
        theme.id,
      );
      const themed = await response.evaluate((element) => ({
        identity: (element as HTMLElement & { __ld4Identity?: string }).__ld4Identity,
        left: element.getBoundingClientRect().left,
        width: element.getBoundingClientRect().width,
        pageOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        proseColor: getComputedStyle(element.querySelector(".turn-assistant")!).color,
      }));
      assert.equal(themed.identity, "before-themes", `${theme.id} remounted the document`);
      assert.ok(Math.abs(themed.left - baseGeometry.left) <= 1, `${theme.id} moved the document`);
      assert.ok(Math.abs(themed.width - baseGeometry.width) <= 1, `${theme.id} changed document width`);
      assert.ok(themed.pageOverflow <= 1, `${theme.id} introduced page overflow`);
      assert.notEqual(themed.bodyBackground, "rgba(0, 0, 0, 0)");
      assert.notEqual(themed.proseColor, "rgba(0, 0, 0, 0)");
    }
    await p.keyboard.press("Escape");
    await p.locator(".settings-card").waitFor({ state: "detached" });
    await assertAxeClean(p, "LD.4 closure stress");
  });
});

test("SA.1: a parallel fan-out renders three live subagent decks, out of order, expandable", async () => {
  await withFreshMockSession(browser, "sa1-cards-7fd1", async (p) => {
    await p.locator("textarea").click();
    await p.keyboard.type("delegate the research");
    await p.keyboard.press("Enter");

    // Three cards appear as their spawns land (350/430/510ms in the mock).
    await p.waitForFunction(
      () => document.querySelectorAll(".subagent-deck").length === 3,
      undefined,
      { timeout: 15_000 },
    );

    // While running: a live card ticks — elapsed seconds in the meta line and
    // a current action in the live slot. Grab the slow "trace the token path"
    // card, which runs the longest.
    const tokenCard = p.locator(".subagent-deck", { hasText: "trace the token path" });
    await p.waitForFunction(
      () => {
        const cards = [...document.querySelectorAll(".subagent-deck-running")];
        return cards.some((c) => /·\s*\d+s/.test(c.querySelector(".subagent-deck-meta")?.textContent ?? ""));
      },
      undefined,
      { timeout: 10_000 },
    );

    // OUT OF ORDER: "map session handling" (spawned second, fastest pace)
    // finishes while "trace the token path" is still running.
    await p.waitForFunction(
      () => {
        // No const-assigned arrows in here: esbuild's keepNames would inject
        // a __name helper the browser page doesn't have.
        const cards = [...document.querySelectorAll(".subagent-deck")];
        const settled = cards.find((c) => c.textContent?.includes("map session handling"));
        const slow = cards.find((c) => c.textContent?.includes("trace the token path"));
        return (
          settled?.classList.contains("subagent-deck-done") === true &&
          slow?.classList.contains("subagent-deck-running") === true
        );
      },
      undefined,
      { timeout: 15_000 },
    );

    // Child tool churn must not steer the ROOT activity line — each deck
    // shows its own current action (bughunt 2026-08-14 r2). The label may
    // legitimately read the spawn state or the generic fallback (a FINISHED
    // spawn clears its own name), but never a child's tool. Sampled across
    // the still-running slow agent's ~640ms tool cadence so a pre-fix
    // child-name label cannot slip between reads.
    for (let sample = 0; sample < 8; sample++) {
      const activityText = await p.locator(".activity-label").innerText();
      assert.match(activityText, /^(Task|working)…$/);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    // The turn concludes; all three cards settle, elapsed stops being shown
    // (client-side timing is only honest while live), result lines ride.
    await p.waitForSelector("text=All three subagents reported back", { timeout: 30_000 });
    assert.equal(await p.locator(".subagent-deck-done").count(), 3);
    assert.equal(await p.locator(".subagent-deck-running").count(), 0);
    const doneMeta = await tokenCard.locator(".subagent-deck-meta").innerText();
    assert.doesNotMatch(doneMeta, /·\s*\d+s/);
    assert.match(doneMeta, /4 tools/);
    assert.match(doneMeta, /never leaves the daemon/);

    // Expand → the nested calls are all there, AND the subagent's own words
    // (SA.2: narration + reasoning, interleaved, inert plain text — the
    // narration precedes the first tool row, true stream order).
    await tokenCard.locator(".subagent-deck-head").click();
    assert.equal(await tokenCard.locator(".subagent-calls .tool-block").count(), 4);
    const prose = tokenCard.locator(".subagent-prose");
    assert.match(await prose.first().innerText(), /Following the cookie from auth\.ts/);
    assert.match(
      await tokenCard.locator(".subagent-prose-thinking").innerText(),
      /confirming the browser side/,
    );
    const expandedTexts = await tokenCard
      .locator(".subagent-calls > *")
      .evaluateAll((nodes) => nodes.map((n) => n.className));
    assert.ok(
      expandedTexts[0].includes("subagent-prose"),
      "narration precedes the first tool row in stream order",
    );
    // The prose is NOT rendered as markdown — no <p>/<em> children, raw text.
    assert.equal(await prose.first().locator("p, em, strong, a, code").count(), 0);
    await tokenCard.locator(".subagent-deck-head").click();
    assert.equal(await tokenCard.locator(".subagent-calls").count(), 0);

    await assertAxeClean(p, "subagent decks");
    await noSideScroll(p);

    // Phone width: the same cards stack — no pane, no side scroll, drill-in
    // untouched (the transcript is the same DOM at every width).
    await p.setViewportSize({ width: 390, height: 844 });
    assert.equal(await p.locator(".subagent-deck").count(), 3);
    await noSideScroll(p);
  });
});
