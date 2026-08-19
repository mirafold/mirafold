import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { type Browser, type Locator, type Page } from "playwright-core";
import { fixtureGit as git, startDaemon, TestClient, type Daemon } from "./itest-harness";
import { assertAxeClean, launchChrome, noSideScroll } from "./e2e-harness";
import type { ClientMsg } from "../protocol";
import { startOllamaFixture } from "./ollama-fixture";
import { startRelayStub } from "../relay/relay-stub";
import { THEMES } from "../../web/src/themes/manifest";

// Tier-3 E2E, opt-in (`yarn test:e2e` — needs google-chrome and a fresh
// `yarn build`, which the script runs first: the daemon serves ./dist, and a
// stale build fails silently). Real browser, real typing, the daemon from the
// Tier-2 harness (credentials forced empty → MockSession) (L.2c).

const TOKEN = "e2e-token-9c2f";

let d: Daemon;
let browser: Browser;
let page: Page; // carries the auth cookie across tests, like a real tab
let base: string;

// The in-page wire recorder (E2.2/E2.4): log every outgoing fs_* frame by
// patching the WebSocket prototype — ws.ts resolves send() through the
// prototype on every call, so the app's EXISTING socket is caught too. Each
// install resets the log; the patch itself lands once per window (a fresh
// navigation gets a fresh window, so re-installing after goto is correct).
const installFsRecorder = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as { __fsSent: { type: string; path?: string }[]; __fsPatched?: boolean };
    w.__fsSent = [];
    if (!w.__fsPatched) {
      w.__fsPatched = true;
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
        try {
          const m = JSON.parse(String(data));
          if (String(m.type).startsWith("fs_")) {
            (window as unknown as { __fsSent: unknown[] }).__fsSent.push({ type: m.type, path: m.path });
          }
        } catch {
          /* binary or non-JSON frame — not ours */
        }
        return orig.call(this, data);
      };
    }
  });
const fsSent = (p: Page) =>
  p.evaluate(() => (window as unknown as { __fsSent: { type: string; path?: string }[] }).__fsSent);

type FolderPickerStubWindow = Window & {
  __pickerSocket?: WebSocket;
  __pickerAgents?: Record<string, unknown>;
  __pickerChoice?: string;
};

// The operating-system service has injected-process coverage in Tier 1. This
// stub keeps the browser proof on the real SocketClient -> Onboarding path
// while replacing only the native dialog's correlated reply.
const installFolderPickerWireStub = (p: Page) =>
  p.addInitScript(() => {
    const w = window as FolderPickerStubWindow;
    const NativeWebSocket = window.WebSocket;
    const nativeSend = NativeWebSocket.prototype.send;

    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const socket = Reflect.construct(Target, args) as WebSocket;
        w.__pickerSocket = socket;
        socket.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (message.type === "agents") w.__pickerAgents = message;
          } catch {
            // Non-JSON frames are unrelated to this local plain-wire test.
          }
        });
        return socket;
      },
    }) as typeof WebSocket;

    NativeWebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
      try {
        const message = JSON.parse(String(data)) as { type?: string; id?: string };
        if (message.type === "pick_folder" && message.id && w.__pickerChoice) {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "folder_picked",
                  id: message.id,
                  path: w.__pickerChoice,
                }),
              }),
            ),
          );
          return;
        }
      } catch {
        // Preserve every ordinary frame unchanged.
      }
      nativeSend.call(this, data);
    };
  });

async function advertiseStubbedFolderPicker(p: Page, choice: string): Promise<void> {
  await p.waitForFunction(
    () => Boolean((window as FolderPickerStubWindow).__pickerAgents),
  );
  await p.evaluate((selected) => {
    const w = window as FolderPickerStubWindow;
    w.__pickerChoice = selected;
    w.__pickerSocket!.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ ...w.__pickerAgents, folderPicker: true }),
      }),
    );
  }, choice);
}

before(async () => {
  // MIRAFOLD_DEBUG makes the registry log every WireMsg it broadcasts, per
  // session (registry.ts). That is the SERVER's half of the flake-watch
  // wedge: the client trace shows a turn that never closed, and only this
  // says whether the daemon emitted a turn_end that was lost on the way, or
  // never emitted one at all.
  d = await startDaemon({ MIRAFOLD_TOKEN: TOKEN, MIRAFOLD_DEBUG: "1" });
  base = `http://127.0.0.1:${d.port}`;
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
  await d?.stop();
});

async function withFreshMockSession(
  token: string,
  run: (isolatedPage: Page) => Promise<void>,
  agent = "Claude Code",
  // Runs before the first navigation — the slot for addInitScript stubs that
  // must exist before the app boots (the NF Notification recorder).
  prepare?: (isolatedPage: Page) => Promise<void>,
): Promise<void> {
  const daemon = await startDaemon({ MIRAFOLD_TOKEN: token });
  let isolatedPage: Page | undefined;
  try {
    isolatedPage = await browser.newPage();
    if (prepare) await prepare(isolatedPage);
    await isolatedPage.goto(`http://127.0.0.1:${daemon.port}/?token=${token}`);
    await isolatedPage.locator(".onb-agent", { hasText: agent }).click();
    await isolatedPage.waitForURL(/\/s\/[\w-]+/);
    await run(isolatedPage);
  } finally {
    try {
      await isolatedPage?.close();
    } finally {
      await daemon.stop();
    }
  }
}

async function submitPrompt(p: Page, text: string): Promise<Locator> {
  const prompt = p.locator(".prompt-box textarea");
  await prompt.fill(text);
  await prompt.press("Enter");
  return prompt;
}

async function settleLiveDocument(p: Page): Promise<Locator> {
  const prompt = await submitPrompt(p, "live document demo");
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
    const zone = document.querySelector(".render-zone") as HTMLElement | null;
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
    const fileContent = document.querySelector(".files-view .fv-content") as HTMLElement | null;
    const filePanel = document.querySelector(".files-panel") as HTMLElement | null;
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

test("no token → 403, nothing served", async () => {
  const lockedOut = await browser.newPage();
  const res = await lockedOut.goto(`${base}/`);
  assert.equal(res?.status(), 403);
  await lockedOut.close();
});

test("?token= mints the cookie, cleans the URL, boots the shell", async () => {
  page = await browser.newPage();
  // Arm the open-turn trace for every document this page loads (flake watch,
  // 2026-07-30): the counter behind the activity indicator wedged above zero
  // and only the frame sequence can say which frame did it. Off in every
  // other context — web/src/turn-trace.ts records nothing unless this exists.
  await page.addInitScript(() => {
    (window as unknown as { __MIRAFOLD_TURN_TRACE__: string[] }).__MIRAFOLD_TURN_TRACE__ = [];
  });
  await page.goto(`${base}/?token=${TOKEN}`);
  assert.equal(page.url(), `${base}/`); // token traded for the cookie, gone from the bar
  const cookies = await page.context().cookies(base);
  assert.ok(cookies.some((c) => c.name === "mirafold_token" && c.value === TOKEN));
  assert.equal(await page.locator(".fleet-title").textContent(), "Mirafold");
});

test("provider completions open before submit, transcript click focuses, and settled activity compacts", async () => {
  const token = "e2e-native-prompt-9c2f";
  await withFreshMockSession(
    token,
    async (page2) => {
      const prompt = page2.locator(".prompt-box textarea");
      const transcript = page2.locator(".render-zone");

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
      assert.equal(await page2.locator(".prompt-options [role=option]").count(), 1);
      assert.equal(await page2.locator(".prompt-option-value", { hasText: "/model" }).count(), 1);
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

      // Successful provider activity becomes one terminal-sized record only
      // when the turn settles. A failure remains visible at top level, and
      // narration between commands (Codex's cadence) rides inside the fold
      // instead of shattering it into singletons.
      await prompt.fill("show transcript compact tool activity");
      await prompt.press("Enter");
      await page2.locator(".stop-btn").waitFor();
      await page2.locator(".stop-btn").waitFor({ state: "detached" });
      assert.equal(await page2.locator(".tool-activity-group").count(), 1);
      // The fold's count speaks of ACTIONS only — absorbed narration
      // (thinking rows riding inside the fold) must never inflate it.
      assert.match(
        await page2.locator(".tool-activity-label").innerText(),
        /worked · 2 actions/,
        "the fold label must count tool calls only, not absorbed narration",
      );
      assert.equal(await page2.locator(".tool-group").count(), 1);
      assert.match(await page2.locator(".tool-group").textContent() ?? "", /No matching test file/);
      assert.equal(
        await page2.locator(".thinking-block", { hasText: "Weighing which check" }).count(),
        0,
        "interleaved narration leaked outside the settled fold",
      );
      await page2.locator(".tool-activity-head").click();
      assert.equal(
        await page2.evaluate(() => document.activeElement?.classList.contains("tool-activity-head")),
        true,
        "a transcript control click was redirected to the prompt",
      );
      assert.equal(await page2.locator(".tool-activity-calls .tool-block").count(), 2);
      assert.equal(
        await page2.locator(".tool-activity-calls .thinking-block", { hasText: "Weighing which check" }).count(),
        1,
        "the fold's expansion must replay the interleaved narration in place",
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
    "Codex",
  );
});

test("the agent picker flexes to the window — no internal scrollbar through the squeeze ramp", async () => {
  // The card's vertical chrome compresses with the window (--onb-squeeze in
  // styles.css) so its overflow-y:auto scrollbar is a last resort, not a
  // routine sight. The guarantee is calibrated to the credentialed picker
  // (short per-row detail lines — the state a set-up user sees); the fresh
  // credential-less picker carries paragraph-length hints, and hiding those
  // behind a scrollbar is correct, not a regression. So: a daemon whose rows
  // are mostly ready (same recipe as the R.4k test below), swept through the
  // squeeze ramp's lower band, where pre-fix EVERY height here scrolled.
  const token = "e2e-squeeze-9c2f";
  // All four rows ready (one-line details, no paragraph hints) — display
  // only, nothing is clicked, so no engine ever spawns. OpenCode's readiness
  // is an existence probe (binary + auth.json), so a stand-in binary and an
  // empty stored-credential file are enough to get the short row.
  const opencodeData = mkdtempSync(path.join(os.tmpdir(), "mirafold-squeeze-ocd-"));
  mkdirSync(path.join(opencodeData, "opencode"));
  writeFileSync(path.join(opencodeData, "opencode", "auth.json"), "{}");
  const d2 = await startDaemon({
    MIRAFOLD_TOKEN: token,
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    OPENAI_API_KEY: "e2e-not-a-real-key",
    GEMINI_API_KEY: "e2e-not-a-real-key",
    OPENCODE_BIN: "/bin/true", // display-only: never spawned
    XDG_DATA_HOME: opencodeData,
  });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
    await page2.waitForSelector(".onb-card");
    await page2.setViewportSize({ width: 1100, height: 1400 });
    await page2.waitForTimeout(60);
    const fullGlyph = await page2.evaluate(
      () => document.querySelector(".onb-glyph")!.getBoundingClientRect().height,
    );
    for (const h of [760, 745, 730]) {
      await page2.setViewportSize({ width: 1100, height: h });
      await page2.waitForTimeout(60);
      const m = await page2.evaluate(() => {
        const c = document.querySelector(".onb-card")!;
        return {
          overflow: c.scrollHeight - c.clientHeight,
          glyph: document.querySelector(".onb-glyph")!.getBoundingClientRect().height,
        };
      });
      assert.ok(m.overflow <= 2, `picker scrolls ${m.overflow}px internally at ${h}px window height`);
      // The fit must come from the squeeze compressing chrome, not from a
      // floor that quietly grew the full-size card.
      assert.ok(m.glyph < fullGlyph - 4, `glyph did not compress at ${h}px (${fullGlyph}px → ${m.glyph}px)`);
    }
  } finally {
    await page2.close();
    await d2.stop();
  }
});

test(
  "N2: a picked long cwd keeps its leaf visible, remains editable, and creates there",
  async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-folder-picker-e2e-"));
    const picked = path.join(
      fixture,
      "a deliberately long parent directory",
      "picked leaf project",
    );
    const missing = path.join(fixture, "does not exist");
    mkdirSync(picked, { recursive: true });
    const token = "e2e-folder-picker-9c2f";
    const d2 = await startDaemon({ MIRAFOLD_TOKEN: token });
    const page2 = await browser.newPage();
    try {
      await installFolderPickerWireStub(page2);
      await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
      await page2.setViewportSize({ width: 390, height: 844 });
      await noSideScroll(page2);
      await assertAxeClean(page2, "onboarding working directory");

      await advertiseStubbedFolderPicker(page2, picked);

      const cwdInput = page2.locator("#onb-cwd");
      await page2.locator(".onb-cwd-browse").click();
      await page2.waitForFunction(
        (expected) =>
          (document.querySelector("#onb-cwd") as HTMLInputElement | null)?.value === expected,
        picked,
      );
      const chosenView = await cwdInput.evaluate((element) => {
        const input = element as HTMLInputElement;
        return {
          value: input.value,
          left: input.scrollLeft,
          max: input.scrollWidth - input.clientWidth,
          focused: document.activeElement === input,
        };
      });
      assert.equal(chosenView.value, picked, "leaf reveal must not shorten the actual cwd");
      assert.ok(chosenView.max > 40, `fixture did not overflow the input (${chosenView.max}px)`);
      assert.equal(chosenView.focused, false, "browse button should retain focus after the pick");
      assert.ok(
        chosenView.left >= chosenView.max - 1,
        `picked cwd showed its root (scrollLeft ${chosenView.left}px of ${chosenView.max}px)`,
      );

      // Focusing restores ordinary caret control: editing at the root must
      // not be dragged back to the leaf by the controlled-state update.
      await cwdInput.focus();
      await page2.keyboard.press("Home");
      await page2.keyboard.type("x");
      const editingView = await cwdInput.evaluate((element) => {
        const input = element as HTMLInputElement;
        return { value: input.value, left: input.scrollLeft, caret: input.selectionStart };
      });
      assert.equal(editingView.value, `x${picked}`);
      assert.equal(editingView.caret, 1);
      assert.ok(
        editingView.left <= 1,
        `active root edit was forced ${editingView.left}px to the leaf`,
      );

      await cwdInput.evaluate((element) => (element as HTMLInputElement).blur());
      const blurredView = await cwdInput.evaluate((element) => {
        const input = element as HTMLInputElement;
        return { left: input.scrollLeft, max: input.scrollWidth - input.clientWidth };
      });
      assert.ok(
        blurredView.left >= blurredView.max - 1,
        `blurred cwd did not return to its leaf (${blurredView.left}px of ${blurredView.max}px)`,
      );

      // A rejected cwd belongs to the value that was submitted. Replacing the
      // value must remove that stale error before the user retries creation.
      await cwdInput.fill(missing);
      await page2.locator(".onb-agent", { hasText: "Claude Code" }).click();
      await page2.waitForSelector(".onb-error");
      assert.match(await page2.locator(".onb-error").innerText(), /no such directory/i);

      await cwdInput.fill(picked);
      assert.equal(await cwdInput.inputValue(), picked);
      await page2.locator(".onb-error").waitFor({ state: "detached" });

      await page2.setViewportSize({ width: 1100, height: 800 });
      await page2.locator(".onb-agent", { hasText: "Claude Code" }).click();
      await page2.waitForURL(/\/s\/[\w-]+/);
      await page2.waitForSelector(".sb-cwd");
      assert.equal(await page2.locator(".sb-cwd").getAttribute("title"), picked);
    } finally {
      await page2.close();
      await d2.stop();
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);

test("onboarding → a full mock turn renders in the DOM", async () => {
  // An empty registry opens straight into "choose your agent".
  // Every credential-less row carries its one-line fix on the picker
  // itself (the harness forces all three agents credential-less) (R.4b).
  await page.waitForSelector(".onb-agent-hint");
  // One hint per offerable agent (the harness forces every agent
  // credential-less) — four since the OpenCode adapter (PLAN OC.4b).
  assert.equal(await page.locator(".onb-agent-hint").count(), 4);
  const opencodeRowText = await page
    .locator(".onb-agent", { hasText: "OpenCode" })
    .innerText();
  assert.match(opencodeRowText, /opencode auth login/);
  assert.match(opencodeRowText, /OPENCODE_MODEL/);
  const claudeRow = page.locator(".onb-agent", { hasText: "Claude Code" });
  assert.match(await claudeRow.innerText(), /ANTHROPIC_API_KEY|`claude`/);
  // Disclosed-uncertainty rule (K.3 amendment, 2026-07-15): the Codex row
  // offers `codex login` WITH the uncertainty caveat, plus the API-key path.
  const codexRowText = await page
    .locator(".onb-agent", { hasText: "Codex" })
    .innerText();
  assert.match(codexRowText, /codex login/);
  assert.match(codexRowText, /not clearly permitted/);
  assert.match(codexRowText, /OPENAI_API_KEY/);
  // The local/open-model path is named on the picker screen itself (R.4k).
  assert.match(await page.locator(".onb-local-note").innerText(), /local\/open model/i);

  await claudeRow.click();
  await page.waitForURL(/\/s\/[\w-]+/);

  // The shell-drawn demo banner is up before anything else paints — a
  // mock session is unmistakably labeled, with the concrete fix named (R.4b).
  await page.waitForSelector(".demo-banner");
  const banner = await page.locator(".demo-banner").innerText();
  assert.match(banner, /demo/i);
  assert.match(banner, /no real agent/);
  assert.match(banner, /ANTHROPIC_API_KEY|`claude`/);

  // Status bar: agent then model, and the model is there from the FIRST
  // paint (session_created carries it) — no turn has run yet (2026-07-17).
  await page.waitForSelector(".sb-model");
  assert.equal(await page.locator(".sb-agent").innerText(), "claude-code");
  assert.equal(await page.locator(".sb-model").innerText(), "mock-sonnet");

  // Real typing into the real prompt box; the checklist hook is deterministic.
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");

  // The typed prompt echoes back as the command strip (server broadcast).
  await page.waitForSelector("text=plan it step by step", { timeout: 15_000 });
  // The live checklist paints…
  await page.waitForSelector("text=Read the current implementation", { timeout: 15_000 });
  // …and the turn runs to its streamed conclusion.
  await page.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
});

test("LD.1: a response document streams around a stable painting and soft shell interruption", async () => {
  await withFreshMockSession("live-document-structure-7fd1", async (p) => {
    await p.locator("textarea").click();
    await p.keyboard.type("live document demo");
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
  await withFreshMockSession("live-document-visual-2a91", async (p) => {
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

    await prompt.fill("one sentence document");
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

test("LD.3: response documents reflow across Explorer, file view, pin dock, and narrow desktop", async () => {
  await withFreshMockSession("live-document-responsive-18c4", async (p) => {
    await p.setViewportSize({ width: 1440, height: 1000 });
    const prompt = await settleLiveDocument(p);

    const measure = () => readResponsiveDocumentLayout(p);

    const center = await measure();
    assert.ok(center, "center-only response metrics are missing");

    await p.locator(".ab-files").click();
    await p.waitForSelector(".files-panel .files-row");
    const explorer = await measure();
    assert.ok(explorer, "Explorer response metrics are missing");

    const checkpointTurn = p.locator(".turn-render", {
      has: p.locator(".rc-card", { hasText: "Live document checkpoint" }),
    });
    await checkpointTurn.hover();
    await checkpointTurn.locator(".pin-btn").click();
    await p.waitForSelector(".pin-dock .rc-card");
    const both = await measure();
    assert.ok(both, "Explorer plus pin-dock response metrics are missing");

    await p.locator(".files-file-row", { hasText: "package.json" }).first().click();
    await p.waitForSelector(".files-view .fv-content");
    const fileAndDock = await measure();
    assert.ok(fileAndDock, "file-view plus pin-dock response metrics are missing");

    await p.setViewportSize({ width: 980, height: 760 });
    await p.waitForFunction(() => window.innerWidth === 980);
    const narrow = await measure();
    assert.ok(narrow, "narrow three-pane response metrics are missing");

    for (const [name, metrics] of [
      ["center", center],
      ["Explorer", explorer],
      ["Explorer + dock", both],
      ["file view + dock", fileAndDock],
      ["narrow three-pane", narrow],
    ] as const) {
      assert.ok(metrics.pageOverflow <= 1, `${name} overflowed the page by ${metrics.pageOverflow}px`);
      assert.equal(metrics.documentContained, true, `${name} document escaped the center column`);
      assert.equal(metrics.markdownTableContained, true, `${name} Markdown table escaped its document`);
      assert.equal(metrics.richTableContained, true, `${name} registry table escaped its document`);
      assert.equal(metrics.fileContentContained, true, `${name} file content escaped Explorer`);
    }
    assert.equal(center.codeOwnsOverflow, true, "wide code did not retain local overflow");
    assert.ok(center.documentWidth > explorer.documentWidth);
    assert.ok(explorer.documentWidth > both.documentWidth);
    assert.ok(Math.abs(fileAndDock.documentWidth - both.documentWidth) <= 1);
    assert.ok(both.documentWidth > narrow.documentWidth);
    assert.ok(narrow.documentWidth >= 280, `narrow document collapsed to ${narrow.documentWidth}px`);
    assert.ok(narrow.proseWidth < center.proseWidth);
    assert.ok(narrow.proseHeight > center.proseHeight, "narrow prose did not reflow vertically");

    // Exercise the remaining intrinsically wide content while all three
    // desktop columns are present at 980px. The artifact deliberately has a
    // 720px internal canvas: its own iframe must scroll, never the workbench.
    await p.locator(".render-zone").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await submitPrompt(p, "responsive document stress");
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
    const manualScroll = await p.locator(".render-zone").evaluate((element) => {
      element.scrollTop = 120;
      return element.scrollTop;
    });
    assert.ok(manualScroll > 0, "fixture is not tall enough to exercise manual scroll");
    await p.locator(".ab-files").click();
    await p.waitForSelector(".files-panel", { state: "detached" });
    const dockOnly = await measure();
    assert.ok(dockOnly, "dock-only response metrics are missing");
    assert.ok(dockOnly.documentWidth > narrow.documentWidth);
    assert.ok(
      Math.abs(dockOnly.scrollTop - manualScroll) <= 2,
      `closing Explorer moved manual scroll from ${manualScroll}px to ${dockOnly.scrollTop}px`,
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
  await withFreshMockSession("live-document-closure-63bc", async (p) => {
    await p.setViewportSize({ width: 1440, height: 800 });
    await p.emulateMedia({ reducedMotion: "reduce" });
    const prompt = await submitPrompt(p, "document closure stress");

    const response = p.locator(".response-document", {
      hasText: "This heading-free technical note",
    });
    await response.locator("text=Closure stress complete.").waitFor({ timeout: 30_000 });
    await p.locator(".activity-line").waitFor({ state: "detached", timeout: 15_000 });

    const shape = await response.evaluate((element) => {
      const zone = document.querySelector(".render-zone") as HTMLElement | null;
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

    const log = p.locator('.render-zone[role="log"]');
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
  await withFreshMockSession("sa1-cards-7fd1", async (p) => {
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

test("A.1: announcer regions exist, spoke the turn, and the transcript is silent", async () => {
  // The two shell-owned announcer regions (Announcer.tsx): polite for turn
  // progress, assertive reserved for errors/permissions. `.sr-only` hides
  // them with clip-path, NOT display:none — the latter would drop them from
  // the accessibility tree and silence every announcement.
  const polite = page.locator('[role="status"][aria-live="polite"]');
  const alert = page.locator('[role="alert"][aria-live="assertive"]');
  assert.equal(await polite.count(), 1);
  assert.equal(await alert.count(), 1);
  // The finished mock turn was announced once, whole: its banked prose lands
  // in the polite region at turn_end (may trail the transcript paint the
  // previous test waited on, hence the poll).
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="status"]')
        ?.textContent?.includes("Plan complete — all four steps done."),
    undefined,
    { timeout: 15_000 },
  );
  // The transcript is navigable but silent: role="log" with aria-live
  // explicitly OFF — log's implicit "polite" would re-read every token.
  const log = page.locator('[role="log"]');
  assert.equal(await log.count(), 1);
  assert.equal(await log.getAttribute("aria-live"), "off");
});

test("A.1: tool_use and permission_request announce (assertive interrupts polite)", async () => {
  const alert = page.locator('[role="alert"][aria-live="assertive"]');
  await page.locator("textarea").click();
  await page.keyboard.type("run something dangerous");
  await page.keyboard.press("Enter");
  // The mock pauses the turn on a permission_request (Bash, a fake
  // rm -rf) — assertive, so it must land in the alert region, not status.
  await page.waitForFunction(
    () => document.querySelector('[role="alert"]')?.textContent?.includes("Permission needed"),
    undefined,
    { timeout: 15_000 },
  );
  const alertText = await alert.innerText();
  assert.match(alertText, /Permission needed: Bash\./);
  assert.match(alertText, /rm -rf \/var\/cache\/app/);
  // The permission bar itself is on-screen with the same detail.
  assert.equal(await page.locator(".perm-tool").innerText(), "Bash");
  await page.locator(".perm-allow").click();
  // Allowed → the mock "runs" the command: a tool_use announces at the
  // polite region ("Running Bash."), then the turn concludes.
  await page.waitForFunction(
    () => document.querySelector('[role="status"]')?.textContent?.includes("Running Bash."),
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('[role="status"]')
        ?.textContent?.includes("Cache cleared and the service restarted cleanly"),
    undefined,
    { timeout: 15_000 },
  );
  // The permission bar clears once answered.
  assert.equal(await page.locator(".perm-bar").count(), 0);
});

test("the permission strip expands to the full command on click, and collapses away", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("run something dangerous");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".perm-bar", { timeout: 15_000 });
  // The strip's body — everything except allow/deny — is one click target…
  await page.locator(".perm-body").click();
  // …opening the card with the WHOLE command, not the one-line preview.
  await page.waitForSelector(".perm-modal-card");
  assert.match(
    await page.locator(".perm-modal-detail").innerText(),
    /rm -rf \/var\/cache\/app && systemctl restart app/,
  );
  // A click away dismisses WITHOUT answering: the ask (and the turn paused
  // behind it) must both survive.
  await page.mouse.click(8, 8);
  await eventually(
    () => !document.querySelector(".perm-modal-card"),
    "clicking the backdrop did not close the card",
  );
  assert.equal(await page.locator(".perm-bar").count(), 1, "backdrop click answered the ask");
  // Esc is exclusive to the card: it closes it, never reaching the busy
  // interrupt — the ModalCard contract the settings card pinned first.
  await page.locator(".perm-body").click();
  await page.waitForSelector(".perm-modal-card");
  await page.waitForTimeout(80);
  await page.keyboard.press("Escape");
  await eventually(() => !document.querySelector(".perm-modal-card"), "Esc did not close the card");
  assert.equal(await page.locator(".perm-bar").count(), 1, "Esc through the card killed the ask");
  assert.equal(await page.locator(".stop-btn").count(), 1, "Esc through the card halted the turn");
  // Focus lands back on the strip that opened the card (A.3).
  const focusedBody = await page.evaluate(
    () => document.activeElement?.classList.contains("perm-body") ?? false,
  );
  assert.ok(focusedBody, "focus did not return to the strip on close");
  // Deny to clean up; the turn runs out.
  await page.locator(".perm-deny").click();
  await page.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
    timeout: 15_000,
  });
});

test("question component: clicking an option sends it as the user's next turn", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("question: canary or fleet?");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".rc-question", { timeout: 15_000 });
  const opts = page.locator(".rc-question-opt");
  assert.equal(await opts.count(), 2);
  await opts.first().click();
  // The option's full text (not its label) echoes back as a real user turn…
  await page.waitForSelector("text=Do a canary rollout first.", { timeout: 15_000 });
  // …the clicked copy locks: the choice is marked, both buttons disabled.
  assert.equal(await page.locator(".rc-question-chosen").count(), 1);
  assert.equal(await opts.first().isDisabled(), true);
  assert.equal(await opts.nth(1).isDisabled(), true);
  // …and the follow-up template turn runs to completion (usage lands at its
  // end — first usage of the session, so this is a real end-of-turn signal).
  await page.waitForSelector(".sb-usage", { timeout: 30_000 });
});

test("shell picker: arrow keys + Enter select a row, terminal-style", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("picker demo");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".picker-block", { timeout: 15_000 });
  const rows = page.locator(".picker-row");
  // Six rows — past the question component's option cap, one shell picker.
  assert.equal(await rows.count(), 6);
  // The highlight starts on the current row (index 1, per the mock)…
  assert.ok((await rows.nth(1).getAttribute("class"))!.includes("picker-highlight"));
  // …and arrow keys drive it from the idle prompt box, no click first.
  await page.keyboard.press("ArrowDown");
  assert.ok((await rows.nth(2).getAttribute("class"))!.includes("picker-highlight"));
  await page.keyboard.press("Enter");
  // The picked row's full text echoes back as a real user turn…
  await page.waitForSelector("text=Switch to mock-9-luna.", { timeout: 15_000 });
  // …and the copy locks: the choice is marked, every row disabled.
  assert.equal(await page.locator(".picker-chosen").count(), 1);
  assert.equal(await rows.first().isDisabled(), true);
});

test("stat component (S.3): the KPI tile updates in place and pins to the dock", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("kpi demo");
  await page.keyboard.press("Enter");
  // Scoped by the deterministic hook's label — a random template turn
  // elsewhere in this session may paint its own (differently-labeled) tile.
  const tile = page.locator(".rc-stat", { hasText: "Coverage" });
  await tile.waitFor({ timeout: 15_000 });
  // Update-in-place: the re-send on the same wire id moves THIS tile's
  // number — still one tile, never a stack.
  await page.waitForSelector(".rc-stat-value:text('96.8%')", { timeout: 15_000 });
  assert.equal(await tile.count(), 1);
  // The delta carries its arrow (direction never rides on color alone).
  assert.match((await tile.locator(".rc-stat-delta").innerText()).trim(), /^↑ \+3\.7%$/);
  // The natural pin-dock resident: pin it, it moves to the dock, a stub
  // holds its transcript place; unpin restores (leaves the page clean too).
  await page.locator(".turn-render", { has: tile }).locator(".pin-btn").click();
  await page.waitForSelector(".pin-dock .rc-stat");
  assert.ok(await page.locator(".pin-stub").count());
  await page.locator(".pin-dock .pin-btn").click();
  await page.waitForSelector(".pin-dock", { state: "detached" });
});

test("code component: header, client-tokenized lines, emphasized range, copy affordance", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("snippet demo");
  await page.keyboard.press("Enter");
  const block = page.locator(".rc-code", { hasText: "loadConfig" });
  await block.waitFor({ timeout: 15_000 });
  assert.equal(await block.locator(".rc-code-name").innerText(), "src/config/load.ts");
  assert.equal(await block.locator(".rc-code-lang").innerText(), "ts");
  // Six source lines, lines 4–5 emphasized per the highlight ranges.
  assert.equal(await block.locator(".rc-code-line").count(), 6);
  assert.equal(await block.locator(".rc-code-line-hl").count(), 2);
  assert.match(await block.locator(".rc-code-line-hl").first().innerText(), /readFile\(path/);
  // Tokenized client-side from plain text — hljs token spans exist, and no
  // markdown fence characters leaked into the rendered body.
  assert.ok((await block.locator(".hljs-keyword").count()) > 0, "no syntax tokens");
  assert.ok(!(await block.locator(".rc-code-body").innerText()).includes("```"));
  assert.equal(await block.locator(".rc-copy").innerText(), "copy");
});

test("status-list component: one verdict pill per row, glyph + word, all five states", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("health checks demo");
  await page.keyboard.press("Enter");
  const block = page.locator(".rc-statuslist", { hasText: "Health checks" });
  await block.waitFor({ timeout: 15_000 });
  assert.equal(await block.locator(".rc-status-row").count(), 5);
  // Every status in the vocabulary renders its own pill class, and the pill
  // text carries the status WORD — state never rides on color alone.
  for (const status of ["pass", "fail", "warn", "pending", "skip"]) {
    const pill = block.locator(`.rc-status-${status}`);
    assert.equal(await pill.count(), 1, `missing pill for ${status}`);
    assert.ok((await pill.innerText()).includes(status));
  }
  assert.match(await block.locator(".rc-status-row", { hasText: "relay probe" }).innerText(), /4007/);
});

test("diagram component: mermaid renders as SVG inside the sandbox; broken source shows itself", async () => {
  // This test used to borrow the suite's long-lived session. Its failure was
  // misattributed to Mermaid's lazy chunk, but the outer .rc-diagram never
  // arrived: an earlier test could finish its DOM assertions just before its
  // turn_end and leave this prompt contending with the one-follow-up gate.
  // Own a session so this test reaches the renderer or fails for a renderer
  // reason; the actual lazy chunk, iframe, CSP, postMessage, and parse error
  // paths below remain production-real.
  await withFreshMockSession("e2e-diagram-9c2f", async (page2) => {
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

test("image component: a resolved shot renders as a real <img>; a refused one says why", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("screenshot demo");
  await page.keyboard.press("Enter");
  const fig = page.locator(".rc-image", { hasText: "welcome screen, dark theme" });
  await fig.waitFor({ timeout: 15_000 });
  const img = fig.locator("img.rc-image-img");
  assert.equal(await img.getAttribute("alt"), "the welcome screen after the fix");
  assert.match((await img.getAttribute("src"))!, /^data:image\/png;base64,/);
  // The pixels actually decoded — a broken data URI reports naturalWidth 0.
  assert.equal(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth), 1);
  // The refused shot explains itself instead of a broken-image glyph.
  const missing = page.locator(".rc-image-missing", { hasText: "shots/huge.png" });
  await missing.waitFor({ timeout: 15_000 });
  assert.match(await missing.innerText(), /image unavailable — too large/);
  assert.equal(await missing.locator("img").count(), 0);
});

test("console component: command header, ANSI colors as spans, junk escapes stripped, exit badge", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("console demo");
  await page.keyboard.press("Enter");
  const block = page.locator(".rc-console", { hasText: "yarn test" });
  await block.waitFor({ timeout: 15_000 });
  assert.match(await block.locator(".rc-console-exit").innerText(), /exit 1/);
  assert.ok((await block.locator(".rc-console-exit-err").count()) === 1, "failing exit not badged");
  // Colors became class spans, not leaked escape bytes…
  assert.ok((await block.locator(".ansi-red").count()) >= 1, "no red span");
  assert.ok((await block.locator(".ansi-green").count()) >= 1, "no green span");
  const body = await block.locator(".rc-console-body").innerText();
  assert.ok(!body.includes("\x1b"), "escape bytes leaked into the rendered body");
  assert.ok(!body.includes("window title junk"), "OSC sequence not stripped");
  assert.ok(body.includes("1 failing, 411 passing"));
});

test("chart stretch (S.1/S.2): pie folds to 'other', stacked and horizontal bars, malformed pie degrades", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("chart demo");
  await page.keyboard.press("Enter");

  // S.1 — the 8-category pie renders 6 slices: top 5 + "other", never a 7th hue.
  const pie = page.locator(".rc-chart", { hasText: "Language mix" });
  await pie.waitFor({ timeout: 15_000 });
  assert.equal(await pie.locator(".rc-chart-slice").count(), 6);
  const pieText = await pie.innerText();
  assert.ok(pieText.includes("other"), "folded slice missing");
  assert.ok(pieText.includes("total"), "donut-hole total missing");

  // S.2 — stacked: every positive segment drawn (3 series × 4 columns).
  const stacked = page.locator(".rc-chart", { hasText: "Tokens by model" });
  await stacked.waitFor({ timeout: 15_000 });
  assert.equal(await stacked.locator(".rc-chart-seg").count(), 12);
  assert.equal(await stacked.locator(".rc-chart-key").count(), 3, "stacked keeps its legend");

  // S.2 — horizontal: the category labels render WHOLE (the vertical axis
  // would clip these at 12 chars).
  const hbar = page.locator(".rc-chart", { hasText: "Slowest e2e tests" });
  await hbar.waitFor({ timeout: 15_000 });
  assert.equal(await hbar.locator(".rc-chart-hbar").count(), 5);
  assert.ok((await hbar.innerText()).includes("explorer drill-in (phone)"), "label truncated");

  // S.1's rule enforced: the two-series pie lands in the legible raw-props
  // fallback (error boundary → fallback), and the rest of the zone survived.
  const fallback = page.locator(".rc-fallback", { hasText: "broken pie" });
  await fallback.waitFor({ timeout: 15_000 });
  assert.match(await fallback.innerText(), /couldn't render/);
  assert.equal(await pie.locator(".rc-chart-slice").count(), 6, "good pie died with the bad one");
});

test("prompt cwd collapses to the caret, expands back, and the choice survives reload (4.8)", async () => {
  await page.waitForSelector(".prompt-cwd");
  // Clicking the path hides it; the caret is all that's left of the prompt.
  await page.locator(".prompt-cwd").click();
  assert.equal(await page.locator(".prompt-cwd").count(), 0);
  // The caret brings it back…
  await page.locator(".prompt-caret").click();
  assert.equal(await page.locator(".prompt-cwd").count(), 1);
  // …and toggles it off again; collapsed persists across a reload.
  await page.locator(".prompt-caret").click();
  assert.equal(await page.locator(".prompt-cwd").count(), 0);
  await page.reload();
  await page.waitForSelector(".prompt-caret");
  assert.equal(await page.locator(".prompt-cwd").count(), 0);
  // Restore the default (shown) for the tests that follow.
  await page.locator(".prompt-caret").click();
  assert.equal(await page.locator(".prompt-cwd").count(), 1);
});

test("R.4i: a subscription-only Claude shows a BLOCKED row with the API-key fix, not a demo", async () => {
  // A daemon whose only Claude credential is a subscription login (a
  // .credentials.json, no API key) — Anthropic's terms don't allow that in a
  // third-party app, so the picker must say so and name the fix, distinct from
  // the plain "no credentials · demo" state the other two agents show here.
  const claudeDir = mkdtempSync(path.join(os.tmpdir(), "genui-sub-e2e-"));
  writeFileSync(path.join(claudeDir, ".credentials.json"), "{}");
  const token = "e2e-blocked-9c2f";
  const d2 = await startDaemon({ MIRAFOLD_TOKEN: token, CLAUDE_CONFIG_DIR: claudeDir });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
    const claudeRow = page2.locator(".onb-agent", { hasText: "Claude Code" });
    await claudeRow.waitFor();
    // Warn-toned "subscription not supported", not the neutral demo status.
    assert.equal(await claudeRow.locator(".onb-blocked").count(), 1);
    assert.match(
      await claudeRow.locator(".onb-agent-status").innerText(),
      /subscription not supported/,
    );
    // The honest hint: WHY (terms) plus the concrete fix (an API key).
    const rowText = await claudeRow.innerText();
    assert.match(rowText, /third-party apps/);
    assert.match(rowText, /ANTHROPIC_API_KEY/);
    // Codex/Gemini are credential-less here → their ordinary demo hints, no block.
    assert.equal(
      await page2.locator(".onb-agent", { hasText: "Codex" }).locator(".onb-blocked").count(),
      0,
    );
  } finally {
    await page2.close();
    await d2.stop();
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("UX.8: a live picker names its backing without exposing a configured host", async () => {
  // Point Claude Code at a local endpoint (ANTHROPIC_BASE_URL) → kind `local`,
  // live, and the picker must identify an endpoint without disclosing its
  // configured hostname. The URL need not resolve —
  // we only read onboarding, never drive a turn.
  const token = "e2e-local-9c2f";
  const d2 = await startDaemon({
    MIRAFOLD_TOKEN: token,
    ANTHROPIC_BASE_URL: "http://localhost:11434",
    // Gemini is the one-click case: an API key is its ONLY backing, so the
    // second step never opens and the row itself must name the credential
    // (2026-07-20). Display only — no create is clicked, so no engine spawns.
    GEMINI_API_KEY: "e2e-not-a-real-key",
  });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
    const claudeRow = page2.locator(".onb-agent", { hasText: "Claude Code" });
    await claudeRow.waitFor();
    assert.match(await claudeRow.locator(".onb-agent-status").innerText(), /ready/);
    const detail = await claudeRow.locator(".onb-agent-detail").innerText();
    assert.equal(detail, "local endpoint");
    assert.doesNotMatch(detail, /localhost|11434/);
    const geminiRow = page2.locator(".onb-agent", { hasText: "Gemini CLI" });
    assert.match(await geminiRow.locator(".onb-agent-status").innerText(), /ready/);
    assert.match(await geminiRow.locator(".onb-agent-detail").innerText(), /Gemini API key/);
  } finally {
    await page2.close();
    await d2.stop();
  }
});

test("N.4: a genuine choice opens the second step; a local server appears LIVE; blocked stays visible-but-gray", async () => {
  // A machine with real choices: codex has BOTH an API key and a ChatGPT
  // login; claude has an API key, a local endpoint, AND a prohibited
  // subscription login. A fixture "ollama" starts DOWN and comes up while
  // the picker is open — the live-appear promise. Display-only: no create is
  // ever clicked here (live credentials would spawn a real engine).
  const fixture = await startOllamaFixture(["llama3.2:3b"]);
  fixture.setUp(false);
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "genui-n4-codex-"));
  writeFileSync(path.join(codexDir, "auth.json"), "{}");
  const claudeDir = mkdtempSync(path.join(os.tmpdir(), "genui-n4-claude-"));
  writeFileSync(path.join(claudeDir, ".credentials.json"), "{}");
  const token = "e2e-n4-9c2f";
  const d2 = await startDaemon({
    MIRAFOLD_TOKEN: token,
    OPENAI_API_KEY: "dummy",
    CODEX_MODEL: "gpt-5.6-sol", // never spawned here — only read for the row's model line
    CODEX_HOME: codexDir,
    ANTHROPIC_API_KEY: "dummy",
    ANTHROPIC_BASE_URL: "http://localhost:9999", // an env endpoint the probe won't find
    CLAUDE_CONFIG_DIR: claudeDir,
    MIRAFOLD_LOCAL_ENDPOINTS: fixture.origin,
    REFRESH_MIN_INTERVAL_MS: "50",
  });
  const page2 = await browser.newPage();
  try {
    await page2.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);

    // Codex: two usable credentials → the second step, not an instant create.
    await page2.locator(".onb-agent", { hasText: "Codex" }).click();
    await page2.waitForSelector(".onb-backends");
    assert.equal(await page2.locator(".onb-backend").count(), 2);
    const subRow = page2.locator(".onb-backend", { hasText: "ChatGPT subscription" });
    // The disclosed-uncertainty caveat rides the OPTION (K.3: uncertainty,
    // never permission), and the row is a live choice, not blocked.
    assert.match(await subRow.innerText(), /not clearly permitted/);
    assert.match(await subRow.innerText(), /your account, your call/);
    assert.equal(await page2.locator(".onb-backend-blocked").count(), 0);
    // Every row names the model it runs — the line that makes rows comparable
    // (2026-07-20). The api-key row's is the env override.
    assert.equal(
      await page2.locator(".onb-backend", { hasText: "OpenAI API key" })
        .locator(".onb-backend-model")
        .innerText(),
      "gpt-5.6-sol",
    );
    // No server discovered yet → the live hint, and no catalog anywhere.
    assert.match(await page2.locator(".onb-live-hint").innerText(), /shows up here/);
    assert.equal(await page2.locator(".onb-model").count(), 0);

    // Start the fixture "ollama" NOW, picker open — it must appear without a
    // reload (the refresh_agents poll re-probes every ~3s).
    fixture.setUp(true);
    const ollamaRow = page2.locator(".onb-backend", { hasText: "ollama" });
    await ollamaRow.waitFor({ timeout: 15_000 });
    // It's ONE row like every other, promising a catalog rather than splaying
    // it inline — and the hint that told you to go configure one is gone.
    assert.equal(await page2.locator(".onb-backend").count(), 3);
    assert.match(await ollamaRow.innerText(), /1 model — choose/);
    assert.equal(await page2.locator(".onb-model").count(), 0);
    assert.equal(await page2.locator(".onb-live-hint").count(), 0);
    // "runs on your machine" is a per-row tag, and ONLY the discovered
    // loopback server carries it — never the paid remote credential rows.
    assert.equal(await page2.locator(".onb-backend-tag").count(), 1);
    assert.equal(await ollamaRow.locator(".onb-backend-tag").innerText(), "local");

    // The third step: the catalog, one click deeper.
    await ollamaRow.click();
    await page2.waitForSelector(".onb-server-name");
    assert.match(await page2.locator(".onb-server-name").innerText(), /ollama/);
    assert.equal(await page2.locator(".onb-model").innerText(), "llama3.2:3b");

    // Esc walks back one step at a time: catalog → backends → agents.
    await page2.keyboard.press("Escape");
    await page2.waitForSelector(".onb-backend");
    await page2.locator(".onb-back").click();
    await page2.waitForSelector(".onb-list");

    // Claude: two usable (env endpoint + API key) + ollama speaks anthropic
    // too, and the prohibited subscription is VISIBLE but gray with the why.
    await page2.locator(".onb-agent", { hasText: "Claude Code" }).click();
    await page2.waitForSelector(".onb-backends");
    assert.equal(await page2.locator(".onb-backend", { hasText: "ollama" }).count(), 1); // dialect-filtered in
    const blocked = page2.locator(".onb-backend-blocked");
    assert.equal(await blocked.count(), 1);
    assert.ok(await blocked.isDisabled(), "a prohibited subscription must not be clickable");
    assert.match(await blocked.innerText(), /Claude subscription/);
    assert.match(await blocked.innerText(), /third-party apps/);
    // The env endpoint the probe never found keeps its own row without
    // disclosing its configured hostname or port.
    const configuredLocal = page2.locator(".onb-backend", { hasText: "local endpoint" });
    const configuredLocalText = await configuredLocal.innerText();
    assert.match(configuredLocalText, /local endpoint/);
    assert.doesNotMatch(configuredLocalText, /localhost|9999/);
    assert.equal(await configuredLocal.locator(".onb-backend-tag").innerText(), "local");

    // Gemini: no credentials, no dialect → no second step; the click-through
    // demo create still works one-click (and proves the panel isn't sticky).
    await page2.locator(".onb-back").click();
    await page2.locator(".onb-agent", { hasText: "Gemini" }).click();
    await page2.waitForURL(/\/s\/[\w-]+/, { timeout: 15_000 });
  } finally {
    await page2.close();
    await d2.stop();
    fixture.close();
    rmSync(codexDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("a demo turn shows tokens but never a fabricated dollar cost (R.4b)", async () => {
  // The checklist hook emits no usage — run a template turn, which does.
  await page.locator("textarea").click();
  await page.keyboard.type("hello there");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".sb-usage", { timeout: 30_000 });
  const bar = await page.locator(".status-bar").innerText();
  assert.ok(!bar.includes("$"), `status bar shows a dollar cost in a demo session: ${bar}`);
  // The daemon version is visible in the status bar (R.4g).
  assert.match(bar, /v\d+\.\d+\.\d+/);
});

test("theme is a segmented sun|moon switch; home is the far-left control", async () => {
  const lightOpt = page.locator(".sb-theme-opt", { hasText: "☀" });
  const darkOpt = page.locator(".sb-theme-opt", { hasText: "☾" });
  // Both modes visible at once; dark (the default identity) is lit.
  assert.equal(await lightOpt.count(), 1);
  assert.equal(await darkOpt.count(), 1);
  assert.match((await darkOpt.getAttribute("class")) ?? "", /is-active/);
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  // Clicking the sun side switches to light; re-clicking it is a no-op.
  await lightOpt.click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.match((await lightOpt.getAttribute("class")) ?? "", /is-active/);
  await lightOpt.click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await darkOpt.click(); // restore the default for later tests
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  // Home (⌂ → mission control) is the status bar's outermost far-left
  // control; the connection-dot toggle sits between it and the agent text.
  assert.match(
    (await page.locator(".status-bar > *:first-child").getAttribute("class")) ?? "",
    /sb-home/,
  );
});

// Shared theme-test helpers (S.3–S.5): the active theme id, and the reset
// that leaves later tests on default slots + dark mode.
const dataTheme = () => page.locator("html").getAttribute("data-theme");
const resetThemeState = async () => {
  await page.evaluate(() => {
    localStorage.removeItem("mirafold-theme-dark");
    localStorage.removeItem("mirafold-theme-light");
    localStorage.setItem("mirafold-theme", "dark");
  });
  await page.reload();
  await page.waitForSelector(".sb-theme");
};

test("two-slot model: each pill side paints its slot's theme; choices survive reload (S.3)", async () => {
  const darkOpt = page.locator(".sb-theme-opt", { hasText: "☾" });
  const lightOpt = page.locator(".sb-theme-opt", { hasText: "☀" });
  try {
    // Seed the dark slot with the only other manifest id ("light" — the
    // picker enforces appearance fit at write time; resolution is by id).
    await page.evaluate(() => localStorage.setItem("mirafold-theme-dark", "light"));
    await page.reload();
    await page.waitForSelector(".sb-theme");
    // Mode survived the reload as dark — the pill shows the MODE, unchanged
    // in rendering — while the paint followed the dark slot's theme.
    assert.match((await darkOpt.getAttribute("class")) ?? "", /is-active/);
    assert.equal(await lightOpt.count(), 1); // pill rendering: both sides, as ever
    assert.equal(await dataTheme(), "light");
    // Still true on a second reload: both keys persist.
    await page.reload();
    await page.waitForSelector(".sb-theme");
    assert.equal(await dataTheme(), "light");
    // Flipping the pill switches slots: light side = the light slot's
    // default, dark side = the seeded slot theme.
    await lightOpt.click();
    assert.equal(await dataTheme(), "light");
    await darkOpt.click();
    assert.equal(await dataTheme(), "light"); // dark MODE, slot-resolved theme
    // A stale/unknown slot id falls back to the side's built-in default.
    await page.evaluate(() => localStorage.setItem("mirafold-theme-dark", "no-such-theme"));
    await page.reload();
    await page.waitForSelector(".sb-theme");
    assert.equal(await dataTheme(), "dark");
  } finally {
    await resetThemeState();
  }
  assert.equal(await dataTheme(), "dark");
});

// A picker row by its exact display name (anchored), optionally scoped to a
// group — "Standard" appears in BOTH groups (one concept, both pill sides),
// so Standard picks must say which side they mean.
const themeRow = (name: string, group?: "Light themes" | "Dark themes") => {
  const scope = group
    ? page
        .locator(".theme-group")
        .filter({ has: page.locator(".theme-group-label", { hasText: group }) })
    : page;
  return scope
    .locator(".theme-row")
    .filter({ has: page.locator(".theme-row-name", { hasText: new RegExp(`^${name}$`) }) });
};

test("settings card: gear opens it, picking applies live and writes the slot (S.4)", async () => {
  // The gear sits in the bar; home keeps its outermost far-left slot
  // (pill's world is undisturbed — its own test above still pins its
  // rendering).
  assert.equal(await page.locator(".sb-settings").count(), 1);
  assert.match(
    (await page.locator(".status-bar > *:first-child").getAttribute("class")) ?? "",
    /sb-home/,
  );
  await page.locator(".sb-settings").click();
  await page.waitForSelector(".settings-card");
  // Both groups render from the manifest — every manifest theme has a row.
  assert.equal(await page.locator(".theme-group").count(), 2);
  assert.equal(await page.locator(".theme-row").count(), THEMES.length);
  // Swatch chips carry real colors parsed from the theme files (raw-CSS
  // import path) — a broken glob would leave them transparent.
  const chipBg = await page
    .locator(".theme-row .theme-chip")
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(chipBg, "rgba(0, 0, 0, 0)");
  // Current slots are checked: the dark row (we're in default dark mode).
  assert.match(
    (await themeRow("Mirafold").getAttribute("class")) ?? "",
    /is-slotted/,
  );
  // Picking the light-labeled row applies immediately — picking is seeing:
  // mode flips to its appearance side, data-theme paints, slot is written,
  // the card stays open (live preview), and the pill's light side is lit.
  await themeRow("Standard", "Light themes").click();
  assert.equal(await dataTheme(), "light");
  assert.equal(await page.locator(".settings-card").count(), 1);
  assert.match(
    (await page.locator(".sb-theme-opt", { hasText: "☀" }).getAttribute("class")) ?? "",
    /is-active/,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("mirafold-theme-light")),
    "light",
  );
  // Picking the dark-labeled row: paints immediately, dark slot now means
  // that theme, and the light slot is untouched.
  await themeRow("Mirafold").click();
  assert.equal(await dataTheme(), "dark");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("mirafold-theme-dark")),
    "dark",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("mirafold-theme-light")),
    "light",
  );
  // Esc closes; scrim click closes too.
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".settings-card").count(), 0);
  await page.locator(".sb-settings").click();
  await page.waitForSelector(".settings-card");
  await page.locator(".settings-backdrop").click({ position: { x: 8, y: 8 } });
  assert.equal(await page.locator(".settings-card").count(), 0);
  assert.equal(await dataTheme(), "dark"); // ends where the suite expects
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
      await page2.keyboard.type("run something dangerous");
      await page2.keyboard.press("Enter");
      await page2.waitForSelector(".perm-bar");
      await page2.waitForFunction(
        () => (window as unknown as { __TOASTS__?: unknown[] }).__TOASTS__?.length === 1,
        undefined,
        { timeout: 15_000 },
      );
      const [first] = await toasts(page2);
      assert.match(first.title, /^⚠ permission — /);
      assert.match(first.body ?? "", /Claude Code wants Bash: rm -rf/);
      assert.ok(first.tag?.startsWith("mirafold-"), `tag was ${first.tag}`);

      // Answering retires the permission toast (the state moved on); the
      // finishing turn then toasts once more under the same tag.
      await page2.locator(".perm-allow").click();
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
    "Claude Code",
    async (p) => {
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
  );
});

test("FD: a dropped file uploads, stages on disk, and its quoted path lands in the prompt", async () => {
  const token = "e2e-filedrop-4a19";
  await withFreshMockSession(token, async (page2) => {
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

test("Esc on an open card is exclusive — it dismisses without interrupting the turn", async () => {
  // The double-fire (2026-07-28 review): ModalCard's Escape used to share the
  // bubble phase with Shell's busy interrupt, so closing a card mid-turn also
  // silently halted the turn. The card now owns the key (capture +
  // stopPropagation, PickerBlock's idiom); the interrupt stays the fallback.
  await page.locator("textarea").click();
  await page.keyboard.type("tell me about the weather");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".stop-btn"); // the turn is in flight
  await page.locator(".sb-settings").click();
  await page.waitForSelector(".settings-card");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".settings-card").count(), 0); // card dismissed…
  assert.equal(await page.locator(".stop-btn").count(), 1); // …turn still running
  // With no card open, Escape falls through to the interrupt as before.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".stop-btn", { state: "detached", timeout: 15_000 });
});

test("a borrowed theme is selectable, actually painted, and persistent (S.5)", async () => {
  const bodyBg = () =>
    page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
  const defaultDarkBg = await bodyBg();
  try {
    await page.locator(".sb-settings").click();
    await page.waitForSelector(".settings-card");
    await themeRow("Solarized Dark").click();
    assert.equal(await dataTheme(), "solarized-dark");
    // The theme's CSS is really LOADED and painting — not just stamped and
    // silently falling back to bare :root (the S.5 QA walk caught exactly
    // that: theme files must ride main.tsx's glob into the bundle). Theme
    // flips animate (body rides the 0.22s background transition), so wait
    // for the paint to settle rather than racing it.
    await page.waitForFunction(
      () => getComputedStyle(document.body).backgroundColor === "rgb(0, 43, 54)", // solarized base00
      { timeout: 3000 },
    );
    assert.notEqual(await bodyBg(), defaultDarkBg);
    // The pick landed in the dark slot; the light slot is untouched.
    assert.equal(
      await page.evaluate(() => localStorage.getItem("mirafold-theme-dark")),
      "solarized-dark",
    );
    // Survives a reload end-to-end.
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForSelector(".sb-theme");
    assert.equal(await dataTheme(), "solarized-dark");
    assert.equal(await bodyBg(), "rgb(0, 43, 54)"); // fresh load: no animation
  } finally {
    await resetThemeState();
  }
  assert.equal(await dataTheme(), "dark");
});

test("sandboxed artifact: scripts run inside the iframe under the shell CSP", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("show me an artifact");
  await page.keyboard.press("Enter");

  // Anchored to the artifact's own frame class — the transcript can hold
  // other sandboxed iframes by now (diagram components).
  const iframe = await page.waitForSelector("iframe.artifact-frame", { timeout: 30_000 });
  const frame = await iframe.contentFrame();
  assert.ok(frame, "artifact iframe has an accessible content frame");

  // The counter button proves the srcDoc document parsed AND its script
  // executes under sandbox="allow-scripts" + the strict artifact CSP.
  await frame!.waitForSelector("#b", { timeout: 15_000 });
  assert.equal(await frame!.textContent("#n"), "0");
  await frame!.click("#b");
  assert.equal(await frame!.textContent("#n"), "1");
});

test("an artifact pins to the dock via its chrome control, and unpins back", async () => {
  // The pin rides the shell-drawn chrome bar (outside the iframe). One
  // artifact is in the transcript from the previous test.
  await page.locator(".artifact-pin").click();
  await page.waitForSelector(".pin-dock");
  // The dock holds the live iframe; a stub holds its place in the flow.
  assert.equal(await page.locator(".pin-dock iframe").count(), 1);
  assert.match(await page.locator(".pin-stub").innerText(), /pinned/);
  // Unpin from the dock chrome → dock closes, the artifact returns inline.
  // (Anchored to the artifact's frame class: the transcript can hold other
  // sandboxed iframes by now — diagram components.)
  await page.locator(".pin-dock .artifact-pin").click();
  await page.waitForSelector(".pin-dock", { state: "detached" });
  assert.equal(await page.locator(".pin-stub").count(), 0);
  assert.equal(await page.locator(".render-zone iframe.artifact-frame").count(), 1);
});

test("hostile artifact is contained: escapes fail, sandbox is exactly allow-scripts (R.4e)", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("show me a hostile artifact");
  await page.keyboard.press("Enter");

  // The transcript accumulates across tests, so target the NEWEST iframe (an
  // earlier test's bridge-demo artifact is still in the scrollback).
  const lastFrame = page.locator("iframe").last();
  await lastFrame.waitFor({ timeout: 30_000 });
  // The sandbox attribute is EXACTLY allow-scripts — one added token
  // (allow-same-origin) would hand the artifact the shell's origin.
  assert.equal(await lastFrame.getAttribute("sandbox"), "allow-scripts");

  // The artifact's own CSP blocks Playwright's script injection into the frame
  // (evaluate/waitForFunction/textContent all inject) — a real containment
  // property. So read the frame's serialized HTML, which needs no injection,
  // and poll until every escape attempt has recorded its outcome. Re-query the
  // frame each pass: a bridge action triggers a new turn whose re-render can
  // detach an earlier frame handle.
  const div = (html: string, id: string) =>
    html.match(new RegExp(`<div id="${id}">([^<]*)</div>`))?.[1] ?? "";
  let frameHtml = "";
  for (let i = 0; i < 60; i++) {
    const fr = await (await page.locator("iframe").last().elementHandle())?.contentFrame();
    frameHtml = fr ? await fr.content() : "";
    if (div(frameHtml, "sent") === "attacks-sent") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(div(frameHtml, "sent"), "attacks-sent", "hostile script never finished");

  // Opaque origin: the shell's DOM and app-origin cookie are unreachable.
  assert.equal(div(frameHtml, "dom"), "parent-dom-blocked");
  assert.equal(div(frameHtml, "cookie"), "cookie-blocked");
  // Injected CSP: fetch tripped a policy violation, it did not succeed.
  assert.match(div(frameHtml, "csp"), /^csp-violation/);

  // The bridge: an unstamped/forged prompt never lands, a state op never
  // lands, and the 400ms rate limit drops the second of a burst — so of
  // everything the artifact tried to send, only "burst-alpha" reaches the
  // transcript as a command strip.
  await page.waitForSelector("text=burst-alpha", { timeout: 15_000 });
  const body = await page.locator(".shell").innerText();
  assert.ok(!body.includes("burst-beta"), "rate limit failed: second burst action landed");
  assert.ok(
    !body.includes("forged-unstamped-prompt"),
    "nonce check failed: a forged bridge message landed",
  );
});

test("navigating artifact is blanked into the navigation-blocked fallback (R.4e)", async () => {
  await page.locator("textarea").click();
  await page.keyboard.type("show me a navigating artifact");
  await page.keyboard.press("Enter");
  // The liveness kill (no nonce-stamped artifactReady) unmounts the frame
  // and shows the fallback with the source.
  await page.waitForSelector("text=navigation blocked", { timeout: 30_000 });
  await page.waitForSelector("text=tried to navigate away", { timeout: 5_000 });
});

test("2026-07-29 reload replays history silently — no re-announced turns in the live regions", async () => {
  // The attach replay repaints every completed turn; before the `replay`
  // stamp, each historical turn re-fired its screen-reader announcements,
  // ending with an old response spoken as though it just arrived.
  // Hermetic: a FRESH session with exactly one completed turn — the minimal
  // scenario the bug needed (even one historical turn re-announced), free of
  // the long shared-session history the suite accumulates by this point.
  const sharedSession = page.url();
  await page.goto(`${base}/?new=1`);
  await page.waitForSelector(".onb-agent");
  await page.locator(".onb-agent", { hasText: "Claude Code" }).click();
  await page.waitForURL(/\/s\/[\w-]+/);
  const freshSession = page.url();
  await page.locator("textarea").click();
  await page.keyboard.type("hello there");
  await page.keyboard.press("Enter");
  // Wait the turn fully out: indicator up, then gone (turn_end reached).
  await page.waitForSelector(".activity-line", { timeout: 30_000 });
  await page.waitForSelector(".activity-line", { state: "detached", timeout: 30_000 });
  // The turn_end response announcement has landed in the polite region.
  await page.waitForFunction(
    () => document.querySelector('[role="status"]')?.textContent?.trim(),
    undefined,
    { timeout: 30_000 },
  );
  await page.reload();
  // The transcript repaints from replay…
  await page.waitForSelector(".turn-assistant", { timeout: 30_000 });
  await page.waitForTimeout(500); // any wrongly re-fired announcement would land here
  // …but both live regions stay empty: history is painted, never spoken.
  const polite = ((await page.locator('[role="status"]').textContent()) ?? "").trim();
  const assertive = ((await page.locator('[role="alert"]').textContent()) ?? "").trim();
  assert.equal(polite, "", `polite live region re-announced history: "${polite}"`);
  assert.equal(assertive, "", `assertive live region re-announced history: "${assertive}"`);
  // Hand the shared session back to the tests that follow.
  assert.ok(freshSession.includes("/s/"));
  await page.goto(sharedSession);
  await page.waitForSelector("textarea", { timeout: 30_000 });
});

// Flake instrumentation (2026-07-30). Waiting for the activity indicator to
// clear is a PRECONDITION at two sites, and when it timed out — once in seven
// full Tier-3 runs — the message said only "still visible after 63 polls".
// That cannot distinguish the two candidate causes, which differ in kind: a
// turn that never ended (test/mock timing) versus an indicator that stuck
// after turn_end (a real 4.14 UI bug). So capture the page's own account of
// itself when it fires. Diagnostic only — it changes no assertion.
const waitTurnIdle = async (p: Page, where: string) => {
  try {
    await p.waitForSelector(".activity-line", { state: "detached", timeout: 30_000 });
  } catch {
    const snap = await p.evaluate(() => ({
      path: location.pathname,
      activity: document.querySelector(".activity-line")?.textContent?.trim() ?? null,
      politeRegion: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      promptDisabled: (document.querySelector("textarea") as HTMLTextAreaElement | null)?.disabled ?? null,
      tail: [...document.querySelectorAll(".turn-user, .turn-assistant, .turn-tool, .bang-block")]
        .slice(-5)
        .map((n) => (n.className + " :: " + (n.textContent ?? "")).replace(/\s+/g, " ").slice(0, 110)),
      // The counter's own history: `type[*=replayed] from->to`. The wedge is
      // whichever frame raised the count with nothing to lower it.
      // The WHOLE ring, run-length compressed ("text_delta* 2->2 ×17"), so
      // the imbalance is visible from page load rather than from an
      // arbitrary tail window.
      turnTrace: (() => {
        const raw = (window as unknown as { __MIRAFOLD_TURN_TRACE__?: string[] }).__MIRAFOLD_TURN_TRACE__ ?? [];
        const out: string[] = [];
        for (const e of raw) {
          const last = out[out.length - 1];
          if (last && last.startsWith(e)) {
            const n = Number(last.slice(e.length).replace(" ×", "")) || 1;
            out[out.length - 1] = `${e} ×${n + 1}`;
          } else out.push(e);
        }
        return out;
      })(),
    }));
    // The daemon's own account of the same session, for comparison: if these
    // counts balance while the client's do not, the loss is in transport or
    // the ring; if they match the client, the adapter never closed the turn.
    const sid = snap.path.replace("/s/", "");
    const frames = d
      .logs()
      .split("\n")
      .filter((l) => l.includes(`session ${sid}`));
    const seen = (t: string) => frames.filter((l) => l.includes(`debug: ${t} {`)).length;
    const server = {
      sessionId: sid,
      user_prompt: seen("user_prompt"),
      turn_end: seen("turn_end"),
      error: seen("error"),
      lastFrames: frames.slice(-14).map((l) => l.replace(/^.*?debug: /, "").slice(0, 70)),
      // Every prompt the daemon admitted, in order — the client's trace names
      // the turn that never closed, and this says whether the daemon agreed.
      prompts: frames
        .filter((l) => l.includes("debug: user_prompt {"))
        .map((l) => (l.match(/"text":"(.{0,26})/)?.[1] ?? "?")),
    };
    throw new Error(
      `${where}: the activity indicator never cleared\nCLIENT ${JSON.stringify(snap, null, 1)}\nSERVER ${JSON.stringify(server, null, 1)}`,
    );
  }
};

test("2026-07-30 a turn that dies by error leaves the shell idle, not wedged on 'working…'", async () => {
  // The wedge this pins was a 1-in-4 Tier-3 flake until its trace was read:
  // the daemon calls `error` terminal (registry.ts → status idle, burst gate
  // cleared) while the shell only decremented on `turn_end`. One errored turn
  // and the indicator read "working…" for the life of the session — and a
  // reload did NOT heal it, because replay rebuilds the imbalance from
  // history. Both halves are asserted: live, and after a reload.
  //
  // Its OWN session, deliberately: the shared one carries a separate,
  // still-unexplained unterminated turn from the artifact chain (PLAN's
  // flake-watch item), and asserting against that history would test
  // something other than what this test claims.
  const shared = page.url(); // hand it back at the end
  await page.goto(`${base}/?new=1`);
  await page.waitForSelector(".onb-agent");
  await page.locator(".onb-agent", { hasText: "Claude Code" }).click();
  await page.waitForURL(/\/s\/[\w-]+/);
  const errSession = page.url();

  await page.locator("textarea").click();
  await page.keyboard.type("fail the turn");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=the engine died mid-turn", { timeout: 30_000 });
  await page.waitForSelector(".activity-line", { state: "detached", timeout: 10_000 });

  // The next turn still works — a phantom open turn would also poison the
  // daemon's mid-turn burst gate for everything after it.
  await page.locator("textarea").click();
  await page.keyboard.type("hello there");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".activity-line", { timeout: 30_000 });
  await page.waitForSelector(".activity-line", { state: "detached", timeout: 30_000 });

  // …and the imbalance must not come back out of replay on the next attach.
  await page.goto(errSession);
  await page.waitForSelector(".turn-assistant", { timeout: 30_000 });
  await page.waitForTimeout(700);
  assert.equal(
    await page.locator(".activity-line").count(),
    0,
    "replaying an errored turn re-wedged the indicator",
  );

  // Hand the shared session back to the tests that follow.
  await page.goto(shared);
  await page.waitForSelector("textarea", { timeout: 30_000 });
});

test("2026-07-29 update-in-place artifacts survive the liveness tripwire", async () => {
  // The mock re-sends ONE artifact id with three htmls, each update landing
  // inside the liveness grace window — a stale deadline from an earlier
  // html's load used to kill the healthy update as "navigation".
  await waitTurnIdle(page, "update-in-place artifacts precondition");
  await page.locator("textarea").click();
  await page.keyboard.type("show me an updating artifact");
  await page.keyboard.press("Enter");
  await page.waitForSelector('.artifact-label:has-text("updating demo")', { timeout: 30_000 });
  // Let every update land and every armed deadline expire, then judge.
  await page.waitForTimeout(1_500);
  const failed = await page.locator(".artifact-failed .artifact-label", { hasText: "updating demo" }).count();
  assert.equal(failed, 0, "the updated artifact was killed by a stale liveness deadline");
  const frames = await page
    .locator(".artifact:not(.artifact-failed)")
    .filter({ hasText: "updating demo" })
    .count();
  assert.ok(frames >= 1, "the updated artifact is still mounted");
});

test("fleet: the cwd is the row's hover tooltip; clicking outside the new-session card dismisses it", async () => {
  await page.goto(`${base}/`);
  await page.waitForSelector(".fleet-row");
  // The cwd left the row proper (clutter) — it survives as the row's
  // native-delay hover tooltip.
  assert.match(
    (await page.locator(".fleet-row").first().getAttribute("title")) ?? "",
    /\//,
  );
  // Row order matches the status bar: agent, then model (2026-07-17).
  const rowText = await page.locator(".fleet-row").first().innerText();
  assert.ok(
    rowText.indexOf("claude-code") < rowText.indexOf("mock-sonnet"),
    `agent should precede model in: ${rowText}`,
  );
  // "+ new session" opens the picker; a backdrop click (outside the card)
  // changes your mind — possible only because a fleet exists behind it.
  await page.locator(".fleet-new").click();
  await page.waitForSelector(".onb-card");
  await page.locator(".onb-overlay").click({ position: { x: 5, y: 5 } });
  assert.equal(await page.locator(".onb-overlay").count(), 0);
  // A click INSIDE the card must not dismiss it…
  await page.locator(".fleet-new").click();
  await page.waitForSelector(".onb-card");
  await page.locator(".onb-title").click();
  assert.equal(await page.locator(".onb-overlay").count(), 1);
  // …and Esc closes it, same idiom as the settings card.
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".onb-overlay").count(), 0);
});

test("A.3b: the session name is the row's one link; buttons ride above the stretched overlay", async () => {
  await page.goto(`${base}/`);
  await page.waitForSelector(".fleet-row");
  const row = page.locator(".fleet-row").first();
  // The row is a container, not an anchor — buttons inside a link are
  // invalid HTML, and a screen reader read every column of the row (id,
  // status, the word "end") as one enormous link label.
  assert.equal(await row.evaluate((el) => el.tagName), "DIV");
  // Exactly one link per row — the session name.
  assert.equal(await row.locator("a").count(), 1);
  assert.ok(((await row.locator(".fleet-link").innerText()) ?? "").length > 0);
  // The real controls sit ABOVE the click-anywhere overlay (z-index — if the
  // layering breaks, the overlay intercepts these clicks and they navigate):
  // "end" arms in place (end → end?)…
  await row.locator(".fleet-end").click();
  assert.equal(await row.locator(".fleet-end").innerText(), "end?");
  assert.equal(page.url(), `${base}/`);
  // …and ✎ opens the rename input in place; Escape cancels it.
  await row.locator(".fleet-edit").click();
  assert.equal(page.url(), `${base}/`);
  await page.waitForSelector(".fleet-rename");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".fleet-rename").count(), 0);
  // (Click-anywhere-on-the-row still opening the session is proven by the
  // next two tests, which click the row body, and by the phone tap.)
});

test("! cd .. — silent success says so, the escape is announced, and the agent answers unprompted (terminal parity)", async () => {
  // Back into a session created earlier in this file.
  await page.locator(".fleet-row").first().click();
  await page.waitForURL(/\/s\/[\w-]+/);
  await page.waitForSelector("textarea");

  await page.locator("textarea").click();
  await page.keyboard.type("! cd ..");
  await page.keyboard.press("Enter");

  // The strip echoes the command; a no-output success is SAID, not blank…
  await page.waitForSelector(".bang-block");
  assert.match(await page.locator(".bang-block").last().innerText(), /cd \.\./);
  await page.waitForSelector(".bang-no-output");
  assert.equal(
    await page.locator(".bang-no-output").last().innerText(),
    "(completed with no output)",
  );
  // …the cwd-guard reset is announced, like the terminal harness…
  await page
    .locator(".notice-line", { hasText: "Shell cwd was reset to" })
    .last()
    .waitFor({ timeout: 15_000 });
  // …and the agent answers the transcript with NO typed prompt: a response
  // document lands AFTER the bang block (sibling order = transcript order, so
  // replayed turns from earlier tests can't satisfy this).
  await page.waitForSelector(".bang-block ~ .response-document .turn-assistant", {
    timeout: 30_000,
  });
});

test("entering a session puts the caret in the prompt box — no click first", async () => {
  await page.goto(`${base}/`);
  await page.waitForSelector(".fleet-row");
  await page.locator(".fleet-row").first().click();
  await page.waitForURL(/\/s\/[\w-]+/);
  await page.waitForSelector("textarea");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
  // The real proof: typing with nothing clicked lands in the box.
  await page.keyboard.type("straight in");
  assert.equal(await page.locator("textarea").inputValue(), "straight in");
  await page.locator("textarea").fill("");
  // Same on a reload of the session URL.
  await page.reload();
  await page.waitForSelector("textarea");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
});

test("status bar: new sits beside home, end is the far-right control, ?new opens the picker", async () => {
  const cls = async (sel: string) => (await page.locator(sel).getAttribute("class")) ?? "";
  assert.match(await cls(".status-bar > *:first-child"), /sb-home/);
  assert.match(await cls(".status-bar > *:nth-child(2)"), /sb-new/);
  assert.match(await cls(".status-bar > *:last-child"), /sb-end/);
  // It opens a NEW tab on the startup screen — the whole point of the button.
  assert.equal(await page.locator(".sb-new").getAttribute("target"), "_blank");
  const href = (await page.locator(".sb-new").getAttribute("href")) ?? "";
  assert.match(href, /^\/\?new/);
  // …and that URL lands on the agent picker even though a fleet exists.
  const fresh = await browser.newPage();
  await fresh.context().addCookies([{ name: "mirafold_token", value: TOKEN, url: base }]);
  await fresh.goto(`${base}${href}`);
  await fresh.waitForSelector(".onb-card");
  await fresh.close();
});

test("streaming holds a scrolled-up reader in place, and re-follows once back at the bottom", async () => {
  // Own the transcript and make it scrollable at a fixed viewport. The old
  // version borrowed 40 prior tests' worth of content, then jumped to the
  // bottom programmatically and sampled once; neither is a user's re-arm
  // path, and the delayed scroll event raced the next streamed paint.
  await withFreshMockSession("e2e-follow-tail-9c2f", async (page2) => {
    await page2.setViewportSize({ width: 900, height: 520 });
    await page2.waitForSelector("textarea");

    const zone = page2.locator(".render-zone");
    const geom = () =>
      zone.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, view: el.clientHeight }));
    const sendPlan = async () => {
      const before = await page2.locator(".turn-user", { hasText: "plan it step by step" }).count();
      await page2.locator("textarea").fill("plan it step by step");
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
        const el = document.querySelector(".render-zone");
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
        const el = document.querySelector(".render-zone");
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
    await page2.locator("textarea").fill("run something dangerous");
    await page2.keyboard.press("Enter");
    await page2.waitForSelector(".perm-bar", { timeout: 15_000 });

    await zone.hover();
    const latchedAtWheel = await geom();
    await page2.mouse.wheel(0, -1_000);
    await page2.waitForFunction(
      ({ top }) => {
        const el = document.querySelector(".render-zone");
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
        const el = document.querySelector(".render-zone");
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
        const el = document.querySelector(".render-zone");
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
      const el = document.querySelector(".render-zone");
      return Boolean(el && el.scrollHeight - el.scrollTop - el.clientHeight <= 60);
    });
  });
});

test("an overflowing prose transcript supports keyboard scrolling and End re-arms following", async () => {
  await withFreshMockSession("e2e-transcript-keyboard-9c2f", async (page2) => {
    await page2.setViewportSize({ width: 900, height: 520 });
    await page2.waitForSelector("textarea");
    const zone = page2.locator(".render-zone");
    const geom = () =>
      zone.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, view: el.clientHeight }));

    // Make deterministic overflow out of inert prose only. With no link or
    // button inside the log, the scroller itself is the keyboard access path
    // axe's scrollable-region-focusable rule requires.
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
    assert.equal(
      await zone.locator("a, button, input, select, textarea, [tabindex]").count(),
      0,
      "fixture unexpectedly gained a focusable transcript descendant",
    );
    await assertAxeClean(page2, "overflowing prose-only transcript");

    // Hold a turn open so output after End can prove follow-tail was re-armed,
    // not just that the browser performed one isolated scroll.
    await page2.locator("textarea").fill("run something dangerous");
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
        const el = document.querySelector(".render-zone");
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
        const el = document.querySelector(".render-zone");
        return Boolean(el && el.scrollHeight - el.scrollTop - el.clientHeight <= 60);
      },
      undefined,
      { timeout: 5_000 },
    );
    const rearmed = await geom();

    await page2.locator(".perm-allow").click();
    await page2.waitForFunction(
      (h) => {
        const el = document.querySelector(".render-zone");
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

// The frame sampler's in-page globals (armed before the prompt, read after).
type BusyWatch = {
  __busyFrames: number;
  __blankFrames: number;
  __glyphFlips: number;
  __lastGlyph: string;
  __watch: number;
};

/** These tests measure a turn from its START, so they must not open while a
 *  previous test's turn is still in flight — an already-ending turn yields a
 *  handful of samples and reads as "the glyph barely moved" (a real 2-in-5
 *  flake on 2026-07-29, diagnosed off a 332 ms run: the shared `page` carries
 *  session state across tests). Anchor on idle first. */
const awaitIdle = () =>
  page.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
    timeout: 30_000,
  });

test("a busy turn never looks idle: the indicator is up, moving, and on screen whenever the stop button is", async () => {
  // Own the state under test. The old shared-page/checklist version waited
  // for a transient line, then made another Playwright round-trip to read it;
  // a loaded runner could deliver the scripted turn_end between those calls,
  // correctly remove the line, and make textContent() wait 30 seconds for an
  // element that was supposed to stay gone. A permission request is the
  // mock's deterministic latch: the turn cannot end until this test answers.
  await withFreshMockSession("e2e-busy-indicator-9c2f", async (page2) => {
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

    await page2.locator("textarea").fill("run something dangerous");
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
      document.querySelector(".render-zone")!.scrollTop = 0;
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

// In-page globals for the queued-follow-up sampler below.
type QueueWatch = { __framesSeen: boolean[]; __qWatch: number };

test("a queued follow-up keeps the indicator up across the turn boundary", async () => {
  // Registry queues ONE prompt sent mid-turn. The first turn ending must
  // not blank the indicator while the engine rolls straight into the queued
  // turn — that gap is real work with nothing on screen (2026-07-29).
  //
  // The scenario only EXISTS if the follow-up is accepted while turn 1 is
  // still in flight: if it arrives after turn 1 ended (a fast mock turn, a
  // loaded machine) the session is simply idle for a moment and a blank
  // indicator is CORRECT. So each attempt verifies acceptance-while-busy
  // and, failing that, discards the attempt and starts over from idle —
  // re-sending into the dead window is what made earlier versions of this
  // test report a 2.2s "blank" that was the product behaving properly.
  let seen: boolean[] | null = null;
  for (let attempt = 0; attempt < 3 && seen === null; attempt++) {
    await awaitIdle();
    const echoBefore = await page.evaluate(
      (needle) =>
        [...document.querySelectorAll(".turn-user")].filter((e) =>
          e.textContent?.includes(needle),
        ).length,
      "chart demo",
    );
    await page.evaluate(() => {
      const w = window as unknown as QueueWatch;
      w.__framesSeen = [];
      w.__qWatch = window.setInterval(() => {
        w.__framesSeen.push(Boolean(document.querySelector(".activity-line")));
      }, 16);
    });
    await page.locator("textarea").click();
    await page.keyboard.type("plan it step by step");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".activity-line", { timeout: 15_000 });
    await page.keyboard.type("chart demo");
    await page.keyboard.press("Enter");
    // Accepted (echoed) AND still mid-turn (stop button up) — the premise.
    const queued = await page
      .waitForFunction(
        ({ needle, before }) =>
          [...document.querySelectorAll(".turn-user")].filter((e) =>
            e.textContent?.includes(needle),
          ).length > before && Boolean(document.querySelector(".stop-btn")),
        { needle: "chart demo", before: echoBefore },
        { timeout: 4_000 },
      )
      .then(() => true)
      .catch(() => false);
    await page.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
      timeout: 60_000,
    });
    await page.waitForTimeout(200);
    const frames = await page.evaluate(() => {
      const w = window as unknown as QueueWatch;
      window.clearInterval(w.__qWatch);
      return w.__framesSeen;
    });
    if (queued) seen = frames;
  }
  assert.ok(seen, "the follow-up was never accepted mid-turn — scenario never ran");
  const first = seen.indexOf(true);
  const last = seen.lastIndexOf(true);
  assert.ok(first >= 0, "the sampler never saw the indicator at all");
  assert.ok(last < seen.length - 1, "the indicator never cleared after both turns ended");
  const gaps = seen.slice(first, last + 1).filter((present) => !present).length;
  assert.equal(gaps, 0, `the indicator blanked for ${gaps} frame(s) between the queued turns`);
});

test("audit: an over-long engine label can't widen the page (the indicator ellipsizes)", async () => {
  await awaitIdle();
  // 2026-07-29 audit. The label is engine-supplied — realistically from a
  // third-party MCP server's tool name — and the indicator is prompt-area
  // chrome, so before the fix a huge one grew the PAGE's scroll width
  // (measured 1,100 px → 1.6 M) rather than a scroll box. Two bounds now:
  // the server caps at 120 chars (registry.test.ts pins that), and this
  // pins the layout's own guarantee against a label that slipped the cap.
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".activity-line", { timeout: 15_000 });
  const geom = await page.evaluate(() => {
    document.querySelector(".activity-label")!.textContent = "A".repeat(200_000);
    return {
      scrollW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      promptVisible:
        document.querySelector(".prompt-box")!.getBoundingClientRect().bottom <=
        window.innerHeight,
    };
  });
  assert.ok(
    geom.scrollW <= geom.winW + 1,
    `a long label widened the page: ${geom.scrollW}px vs ${geom.winW}px viewport`,
  );
  assert.ok(geom.promptVisible, "the prompt box was pushed off screen");
  await page.waitForFunction(() => !document.querySelector(".stop-btn"), undefined, {
    timeout: 30_000,
  });
});

/** Asserts a DOM condition that lands a tick or two AFTER the click that
 *  causes it. A one-shot count()/isVisible() right after a click is a coin
 *  flip once the machine is busy — E.3/E.5 lost that flip on 2026-07-25.
 *  Keeps the descriptive message a bare waitForFunction timeout would lose.
 *  Pass the check INLINE (never via a const): tsx's keepNames wraps a named
 *  function expression in a helper that doesn't exist inside the page. */
const eventually = async (check: () => boolean, message: string, timeout = 10_000) => {
  await page.waitForFunction(check, undefined, { timeout }).catch(() => assert.fail(message));
};

test("E.3: the files panel lists the working tree, opens a file beside the transcript, drills back", async () => {
  // The e2e daemon runs in the Mirafold repo itself — a real git repo — so
  // the tree is live git data. package.json is always tracked and top-level.
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-panel");
  const pkg = page.locator(".files-file-row", { hasText: "package.json" }).first();
  await pkg.waitFor({ timeout: 15_000 });

  // The tree leads with the checked-out ROOT as its top node — the folder's
  // NAME (no path header above the tree); collapsing it folds the whole tree.
  // Asserted against the checkout's actual basename, not a literal: a public
  // clone lands as `mirafold/` (or anything else), and the suite must pass
  // from any of them.
  const root = page.locator(".files-root-row");
  const repoDir = path.basename(path.resolve(import.meta.dirname, "..", ".."));
  const panelHead = page.locator(".files-panel-head");
  assert.equal(await panelHead.locator(".files-panel-title").innerText(), "FILES");
  assert.equal(
    await panelHead.locator(".files-refresh[aria-label='Refresh files']").count(),
    1,
    "the Explorer title bar owns its refresh action",
  );
  assert.ok((await root.innerText()).includes(repoDir), `root row names the checkout folder (${repoDir})`);
  assert.equal(await page.locator(".files-title").count(), 0, "the old path header is gone");
  assert.equal(
    await root.locator(".files-caret + .files-node-icon-folder-open + .files-name").count(),
    1,
    "the expanded root orders its chevron, open-folder glyph, then name",
  );
  assert.equal(
    await pkg.locator(".files-caret + .files-node-icon-config[aria-hidden=true] + .files-name").count(),
    1,
    "package.json carries its decorative configuration glyph before its name",
  );
  await root.click();
  await eventually(
    () => document.querySelectorAll(".files-file-row").length === 0,
    "collapsed root still lists files",
  );
  assert.equal(
    await root.locator(".files-node-icon-folder").count(),
    1,
    "the collapsed root carries the closed-folder glyph",
  );
  await root.click();
  await pkg.waitFor({ timeout: 15_000 });

  // The transcript and the prompt box both stay usable beside the open panel
  // (the squeeze risk — the panel and transcript are separate flex columns).
  assert.ok(await page.locator(".render-zone").isVisible());
  assert.ok(await page.locator(".prompt-box textarea, textarea").first().isVisible());

  // Open the file → its content shows in the panel's file view.
  await pkg.click();
  await page.waitForSelector(".files-view .fv-content");
  assert.match(await page.locator(".files-view .fv-content").innerText(), /"name"/);

  // Back returns to the tree; the toggle closes the panel entirely.
  await page.locator(".files-back").click();
  await page.waitForSelector(".files-tree");
  await page.locator(".ab-files").click();
  await eventually(() => !document.querySelector(".files-panel"), "the toggle left the panel open");
});

test("E.6: ⤢ lifts the file view into a dimmed lightbox; Esc and the backdrop restore it in place", async () => {
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-panel");
  // yarn.lock, not package.json: the scroll assertions below need a file
  // tall enough to overflow the view in BOTH frames, with lines long enough
  // that unwrapped they would side-scroll a 340px panel.
  const lock = page.locator(".files-file-row", { hasText: "yarn.lock" }).first();
  await lock.waitFor({ timeout: 15_000 });
  await lock.click();
  await page.waitForSelector(".files-view .fv-content");

  // The view is the ONE scroller — the transcript's 360px tool-output cap
  // is lifted here — and lines WRAP at the frame's width, never side-scroll
  // (both deliberate, 2026-07-28).
  await page.locator(".files-view").evaluate((el) => (el.scrollTop = 40));
  assert.equal(
    await page.locator(".files-view").evaluate((el) => el.scrollTop),
    40,
    "the docked view is not scrollable — the tool-output height cap is back",
  );
  assert.ok(
    await page.locator(".fv-content").evaluate((el) => el.scrollWidth <= el.clientWidth),
    "long lines side-scroll instead of wrapping",
  );
  await page.locator(".files-enlarge").click();
  await page.waitForSelector(".files-file.is-maximized");
  assert.ok(await page.locator(".files-dim").isVisible(), "no backdrop behind the lifted box");
  // The enlarged bar is a title bar: the name centers on the BAR, immune to
  // its uneven flanks (yarn.lock is clean, so this pins the no-tabs case).
  assert.ok(
    await page.evaluate(() => {
      const bar = document
        .querySelector(".files-file.is-maximized .files-file-path")!
        .getBoundingClientRect();
      const name = document
        .querySelector(".files-file.is-maximized .files-file-name")!
        .getBoundingClientRect();
      return Math.abs((name.left + name.right) / 2 - (bar.left + bar.right) / 2) < 2;
    }),
    "the enlarged title is not centered on the bar",
  );
  // Same node, same scroller in both frames — scroll survives the enlarge.
  assert.equal(
    await page.locator(".files-view").evaluate((el) => el.scrollTop),
    40,
    "scroll position reset across the enlarge",
  );

  // Esc restores the frame WITHOUT closing the file view or the panel — the
  // exclusive handler must also keep the key from Shell's busy interrupt.
  await page.keyboard.press("Escape");
  await eventually(() => !document.querySelector(".files-file.is-maximized"), "Esc left it enlarged");
  assert.ok(await page.locator(".files-view .fv-content").isVisible(), "Esc closed the file view");
  assert.equal(await page.locator(".files-dim").count(), 0, "backdrop outlived the restore");

  // The backdrop click is the other way back (the lightbox contract).
  await page.locator(".files-enlarge").click();
  await page.waitForSelector(".files-dim");
  await page.locator(".files-dim").click({ position: { x: 5, y: 5 } });
  await eventually(
    () => !document.querySelector(".files-file.is-maximized"),
    "backdrop click left it enlarged",
  );

  await page.locator(".files-back").click(); // tidy up for later tests
  await page.locator(".ab-files").click();
  await eventually(() => !document.querySelector(".files-panel"), "the toggle left the panel open");
});

test("E.5: expanded dirs survive a close/reopen, and a turn's auto-refresh keeps tree state", async () => {
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-panel");

  // Expand a known top-level directory (the repo has server/). Exact-match
  // the name span: since E2.2 the lazy lister is git-blind until the git
  // layer lands, so ignored siblings like dist-server/ are listed too — a
  // substring match would hit dist-server first.
  const serverDir = page.locator('.files-dir:has(.files-name:text-is("server"))').first();
  await serverDir.waitFor({ timeout: 15_000 });
  await serverDir.click();
  // A child appears — protocol.ts is a tracked file directly under server/.
  await page.waitForSelector(".files-file-row:has-text('protocol.ts')");

  // Close and reopen within the same session — the expansion is remembered
  // (E.5: reset is keyed on session switch, not on open).
  await page.locator(".ab-files").click();
  await eventually(() => !document.querySelector(".files-panel"), "the toggle left the panel open");
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-tree");
  await eventually(
    () =>
      [...document.querySelectorAll(".files-file-row")].some((el) =>
        el.textContent?.includes("protocol.ts"),
      ),
    "expanded dir was collapsed on reopen",
  );

  // A turn auto-refreshes the tree (E.5) without collapsing what's open or
  // closing the panel: run a full mock turn, then the expansion still holds.
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
  await page.waitForTimeout(400); // let the turn_end refresh land…
  // …then let it FINISH: the refetch swaps the rows, so a slow one under load
  // must not read as a collapse.
  await eventually(() => !!document.querySelector(".files-panel"), "auto-refresh closed the panel");
  await eventually(
    () =>
      [...document.querySelectorAll(".files-file-row")].some((el) =>
        el.textContent?.includes("protocol.ts"),
      ),
    "auto-refresh collapsed the expanded dir",
  );

  await page.locator(".ab-files").click(); // tidy up for later tests
});

test("E2.2: the tree is LAZY — open fetches root + first level only; expand fetches exactly that dir; cache re-expands with no request; turn-end refetches only expanded dirs", async () => {
  await installFsRecorder(page);
  const sent = () => fsSent(page);
  const mark = async () => (await sent()).length;

  // Open: the root and (prefetched) first level arrive — every listing
  // request is depth ≤ 1, and the whole-tree fs_list is never sent.
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-file-row:has-text('package.json')");
  await page.waitForTimeout(300); // let the prefetch fan-out finish
  const onOpen = await sent();
  assert.ok(onOpen.every((m) => m.type !== "fs_list"), "the whole-tree request is retired from the client");
  const listdirs = onOpen.filter((m) => m.type === "fs_listdir");
  assert.ok(listdirs.some((m) => m.path === ""), "the root is fetched");
  assert.ok(
    listdirs.every((m) => !String(m.path).includes("/")),
    `open fetches only root + first level, got: ${listdirs.map((m) => m.path).join(", ")}`,
  );

  // Expanding a PREFETCHED first-level dir renders from cache — no request.
  // (web/ was fetched by the open prefetch above.)
  let m0 = await mark();
  const webDir = page.locator('.files-dir:has(.files-name:text-is("web"))').first();
  await webDir.click();
  await page.waitForSelector('.files-dir:has(.files-name:text-is("src"))');
  assert.equal((await sent()).length, m0, "a prefetched dir expands with no request");

  // Expanding a DEEP dir fetches exactly that dir and nothing else.
  m0 = await mark();
  await page.locator('.files-dir:has(.files-name:text-is("src"))').first().click();
  await page.waitForSelector(".files-file-row:has-text('main.tsx')");
  const deep = (await sent()).slice(m0);
  assert.deepEqual(
    deep.map((m) => `${m.type}:${m.path}`),
    ["fs_listdir:web/src"],
    "expand fetched exactly the expanded dir",
  );

  // Collapse and re-expand: served from cache, zero requests.
  m0 = await mark();
  await webDir.click(); // collapse web (web/src stays expanded underneath)
  await eventually(
    () => ![...document.querySelectorAll(".files-file-row")].some((el) => el.textContent?.includes("main.tsx")),
    "collapse left the subtree visible",
  );
  await webDir.click(); // re-expand
  await page.waitForSelector(".files-file-row:has-text('main.tsx')");
  assert.equal((await sent()).length, m0, "collapse/re-expand made requests despite the cache");

  // A turn's auto-refresh (E.5, lazy since E2.2) refetches ONLY the root and
  // the expanded dirs — never a whole-tree request, no first-level prefetch.
  m0 = await mark();
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");
  // Wait on the refetch TRAFFIC itself, not on transcript text — the E.5
  // test above ran this same prompt, so its completion line already matches
  // a text selector instantly, racing the real turn_end. The refetch batch
  // is sent synchronously in one handler, so one new frame means all of them.
  await page
    .waitForFunction(
      (n) => (window as unknown as { __fsSent: unknown[] }).__fsSent.length > n,
      m0,
      { timeout: 30_000 },
    )
    .catch(() => assert.fail("turn-end sent no refresh at all"));
  const onTurn = (await sent()).slice(m0);
  const expected = new Set(["", "server", "web", "web/src"]); // server/ expanded by the E.5 test above
  assert.ok(
    onTurn.every((m) => m.type === "fs_listdir" && expected.has(String(m.path))),
    `turn-end refetched beyond root + expanded dirs: ${onTurn.map((m) => `${m.type}:${m.path}`).join(", ")}`,
  );

  await page.locator(".ab-files").click(); // tidy up for later tests
});

test("E2.4: the Projects-root proof — lazy expands into two repos with per-repo statuses, ignore rules, and a nested-repo diff; never a whole-tree request; phone drills the same fixture", async () => {
  // The headline E2 use case, end to end: a session rooted at a folder that
  // is NOT a repo, holding two repos with different ignore rules (one dirty)
  // and a plain dir.
  const mr = mkdtempSync(path.join(os.tmpdir(), "e2e-mr-"));
  const repoA = path.join(mr, "repoA");
  const repoB = path.join(mr, "repoB");
  mkdirSync(repoA);
  mkdirSync(repoB);
  mkdirSync(path.join(mr, "plain"));
  writeFileSync(path.join(mr, "plain", "note.txt"), "just a note\n");
  git(repoA, "init", "-q");
  writeFileSync(path.join(repoA, ".gitignore"), "dist/\n");
  writeFileSync(path.join(repoA, "kept.txt"), "kept content\n");
  writeFileSync(path.join(repoA, "changed.txt"), "the before line\n");
  git(repoA, "add", "-A");
  git(repoA, "commit", "-qm", "init");
  writeFileSync(path.join(repoA, "changed.txt"), "the after line\n");
  mkdirSync(path.join(repoA, "dist"));
  writeFileSync(path.join(repoA, "dist", "bundle.js"), "never listed\n");
  git(repoB, "init", "-q");
  writeFileSync(path.join(repoB, ".gitignore"), "secret.log\n");
  writeFileSync(path.join(repoB, "app.ts"), "export const b = 1;\n");
  git(repoB, "add", "-A");
  git(repoB, "commit", "-qm", "init");
  writeFileSync(path.join(repoB, "secret.log"), "s\n");
  writeFileSync(path.join(repoB, "notes.md"), "untracked here\n");

  // Seed the session AT the fixture over the wire (the UI has no cwd
  // picker), then join it from the browser like any viewport would.
  const seed = new TestClient(d.port, { token: TOKEN });
  await seed.opened();
  await seed.type("agents");
  seed.send({ type: "create", agent: "claude-code", cwd: mr } as ClientMsg);
  const created = (await seed.type("session_created")) as { sessionId: string } & Record<string, unknown>;
  const backUrl = page.url(); // later tests continue the original session
  try {
    await page.goto(`${base}/s/${created.sessionId}`);

    // The recorder goes in BEFORE the panel opens — the claim under proof is
    // that NO frame in the whole flow is a whole-tree fs_list, so every
    // frame must be caught. (Fresh window after goto: re-install.)
    await installFsRecorder(page);

    await page.locator(".ab-files").click();
    // The root: three dirs, no statuses anywhere — the root is no repo.
    await page.waitForSelector('.files-dir:has(.files-name:text-is("repoA"))');
    assert.equal(await page.locator(".files-status").count(), 0, "statuses at a non-repo root");

    // Into the dirty repo: its own gitignore hides dist/, its statuses ride
    // the rows — the modified file badged M, the clean file unbadged.
    await page.locator('.files-dir:has(.files-name:text-is("repoA"))').click();
    await page.waitForSelector(".files-file-row:has-text('changed.txt')");
    assert.equal(
      await page.locator('.files-dir:has(.files-name:text-is("dist"))').count(),
      0,
      "repoA's ignored dist/ must not be listed",
    );
    assert.equal(
      await page.locator(".files-file-row:has-text('changed.txt') .files-status").innerText(),
      "M",
    );
    assert.equal(
      await page.locator(".files-file-row:has-text('kept.txt') .files-status").count(),
      0,
      "a clean tracked file carries no badge",
    );

    // Open the modified file: a status click leads with the DIFF, and the
    // diff resolves through repoA — the nested repo — not the session root.
    await page.locator(".files-file-row:has-text('changed.txt')").click();
    await page.waitForSelector(".files-view .tool-diff");
    const diffText = await page.locator(".files-view .tool-diff").innerText();
    assert.match(diffText, /the before line/);
    assert.match(diffText, /the after line/);
    await page.locator(".files-back").click();
    await page.waitForSelector(".files-tree");

    // Into the second repo: ITS rules now — secret.log hidden here (and only
    // here), its untracked file badged U. Open a file in this repo too: the
    // clean one arrives as plain content.
    await page.locator('.files-dir:has(.files-name:text-is("repoB"))').click();
    await page.waitForSelector(".files-file-row:has-text('app.ts')");
    assert.equal(
      await page.locator(".files-file-row:has-text('secret.log')").count(),
      0,
      "repoB's ignored secret.log must not be listed",
    );
    assert.equal(
      await page.locator(".files-file-row:has-text('notes.md') .files-status").innerText(),
      "U",
    );
    await page.locator(".files-file-row:has-text('app.ts')").click();
    await page.waitForSelector(".files-view .fv-content");
    assert.match(await page.locator(".files-view .fv-content").innerText(), /export const b/);
    await page.locator(".files-back").click();
    await page.waitForSelector(".files-tree");
    await page.locator(".ab-files").click(); // close the panel

    // The pinned claim: the entire flow — open, prefetch, expands, refreshes
    // — rode the lazy pair. Not one whole-tree request anywhere.
    const frames = await fsSent(page);
    assert.ok(frames.length > 0, "the recorder saw no fs traffic at all");
    assert.ok(
      frames.every((m) => m.type !== "fs_list"),
      "a whole-tree fs_list rode the lazy flow",
    );

    // Phone drill-in over the SAME fixture: full-screen panel, expand the
    // dirty repo, the badge is there, a file opens, Esc walks back out.
    const phoneCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    try {
      const phone = await phoneCtx.newPage();
      await phone.goto(`${base}/?token=${TOKEN}`);
      await phone.goto(`${base}/s/${created.sessionId}`);
      await phone.locator(".sb-workspace").focus();
      await phone.keyboard.press("Enter");
      await phone.waitForSelector(".files-panel[role=dialog]");
      await phone.locator('.files-dir:has(.files-name:text-is("repoA"))').tap();
      await phone.waitForSelector(".files-file-row:has-text('changed.txt')");
      assert.equal(
        await phone.locator(".files-file-row:has-text('changed.txt') .files-status").innerText(),
        "M",
        "the per-repo badge rides the phone drill-in too",
      );
      await phone.locator(".files-file-row:has-text('kept.txt')").tap();
      await phone.waitForSelector(".files-view .fv-content");
      assert.match(await phone.locator(".files-view .fv-content").innerText(), /kept content/);
      await phone.keyboard.press("Escape");
      await phone.waitForSelector(".files-tree");
      await phone.keyboard.press("Escape");
      assert.equal(await phone.locator(".files-panel").count(), 0, "Esc from the tree closes the panel");
    } finally {
      await phoneCtx.close();
    }
  } finally {
    seed.close();
    await page.goto(backUrl); // hand the original session back to later tests
    await page.waitForSelector("textarea");
    rmSync(mr, { recursive: true, force: true });
  }
});

test("W.2: the live tree — a write behind the UI's back appears with zero clicks; a collapsed dir's new file causes no fetch; the refresh button still works", async () => {
  // A workspace the UI never touches directly: the test writes to disk and
  // the tree must notice on its own (the doorbell → fs_changed → refetch).
  const ws = mkdtempSync(path.join(os.tmpdir(), "e2e-live-"));
  writeFileSync(path.join(ws, "top.txt"), "top\n");
  mkdirSync(path.join(ws, "colly", "sub"), { recursive: true });
  writeFileSync(path.join(ws, "colly", "sub", "inner.txt"), "inner\n");

  const seed = new TestClient(d.port, { token: TOKEN });
  await seed.opened();
  await seed.type("agents");
  seed.send({ type: "create", agent: "claude-code", cwd: ws } as ClientMsg);
  const created = (await seed.type("session_created")) as { sessionId: string } & Record<string, unknown>;
  const backUrl = page.url();
  try {
    await page.goto(`${base}/s/${created.sessionId}`);
    await installFsRecorder(page);
    await page.locator(".ab-files").click();
    await page.waitForSelector(".files-file-row:has-text('top.txt')");

    // The headline: a file written with NO interaction — no clicks, no agent
    // turn — appears by itself (server debounce 400ms + one refetch ≪ this
    // timeout; the claim is "you never need the button").
    writeFileSync(path.join(ws, "fresh.txt"), "surprise\n");
    await page.waitForSelector(".files-file-row:has-text('fresh.txt')", { timeout: 3_000 });

    // A new file inside a collapsed, never-fetched dir: the bell rings, the
    // refetch unit is root + EXPANDED dirs — so colly/sub is rightly never
    // fetched and the file rightly not shown (it'd appear on expand).
    writeFileSync(path.join(ws, "colly", "sub", "hidden.txt"), "quiet\n");
    await page.waitForTimeout(2_200); // server debounce + client coalescing gap, settled
    const frames = await fsSent(page);
    assert.ok(
      frames.every((m) => !(m.type === "fs_listdir" && m.path === "colly/sub")),
      "a bell must not fetch a collapsed, unfetched dir",
    );
    assert.equal(
      await page.locator(".files-file-row:has-text('hidden.txt')").count(),
      0,
      "nothing expanded shows the hidden file — correct",
    );

    // The refresh action remains beside the bell: a click still refetches
    // (fresh root request on the wire) and the tree stays whole.
    const rootFetches = () =>
      page.evaluate(
        () =>
          (window as unknown as { __fsSent: { type: string; path?: string }[] }).__fsSent.filter(
            (m) => m.type === "fs_listdir" && m.path === "",
          ).length,
      );
    const beforeClick = await rootFetches();
    await page.locator(".files-refresh").click();
    await page.waitForFunction(
      (n) =>
        (window as unknown as { __fsSent: { type: string; path?: string }[] }).__fsSent.filter(
          (m) => m.type === "fs_listdir" && m.path === "",
        ).length > n,
      beforeClick,
      { timeout: 5_000 },
    );
    await page.waitForSelector(".files-file-row:has-text('fresh.txt')");

    // The lazy invariant survives the live tree: not one whole-tree request.
    assert.ok(
      (await fsSent(page)).every((m) => m.type !== "fs_list"),
      "a whole-tree fs_list rode the live-tree flow",
    );
    await page.locator(".ab-files").click(); // close the panel for later tests
  } finally {
    seed.close();
    await page.goto(backUrl);
    await page.waitForSelector("textarea");
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a notice in the engine's own words is badged; the shell's own words aren't", async () => {
  // Own the session whose output is under test. The shared page has just
  // navigated through two Explorer fixtures; under runner load its attach /
  // replay can still be settling when this prompt is typed, so a timeout can
  // happen before the notice path runs and say nothing about attribution.
  await withFreshMockSession("e2e-notice-attribution-9c2f", async (page2) => {
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

// C.2 — the automated Phase-A regression guard; assertAxeClean (scope, tags,
// and the accepted-exception policy) lives in e2e-harness.ts.
test("C.2: axe-core finds no serious/critical WCAG violations across the app", async () => {
  // Own daemon + relay stub so every surface (including connect-device, which
  // renders only with a relay) is reachable and the state is controlled.
  const relay = await startRelayStub({});
  const token = "e2e-axe-9c2f";
  const dax = await startDaemon({
    MIRAFOLD_TOKEN: token,
    MIRAFOLD_RELAY_URL: relay.url,
    MIRAFOLD_RELAY_CODE: "e2e-axe-pairing-code-1a2b",
  });
  const p = await browser.newPage();
  try {
    const baseAx = `http://127.0.0.1:${dax.port}`;
    await p.goto(`${baseAx}/?token=${token}`);

    // 1) Onboarding ("choose your agent") — empty registry opens here.
    await p.waitForSelector(".onb-agent");
    await assertAxeClean(p, "onboarding");

    // 2) A live session with a rendered transcript + checklist.
    await p.locator(".onb-agent", { hasText: "Claude Code" }).click();
    await p.waitForURL(/\/s\/[\w-]+/);
    await p.waitForSelector(".demo-banner");
    await p.locator("textarea").click();
    await p.keyboard.type("plan it step by step");
    await p.keyboard.press("Enter");
    await p.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
    await assertAxeClean(p, "session transcript");

    // 2b) Explorer files panel open, tree listed (E.3).
    await p.locator(".ab-files").click();
    await p.waitForSelector(".files-panel .files-row");
    await assertAxeClean(p, "files panel");
    await p.locator(".ab-files").click(); // close before the next surface

    // 2c) The ⤢ enlarged file view (E.6) — a near-full-screen surface over a
    // dimmed workspace, i.e. its own focus/labelling problem, swept for the
    // first time 2026-07-30 (the accessibility statement named it as unswept).
    await p.locator(".ab-files").click();
    await p.waitForSelector(".files-panel .files-row");
    // Pick a named safe fixture. Alphabetical-first is `.env.example` in this
    // checkout, and dotenv files are intentionally opaque to this test run.
    await p.locator(".files-file-row", { hasText: "README.md" }).click();
    await p.waitForSelector(".files-view .fv-content").catch(async () =>
      assert.fail(
        `enlarged-view fixture did not open; selected=${JSON.stringify(await p.locator(".files-file-name").allInnerTexts())} ` +
          `view=${JSON.stringify(await p.locator(".files-view").allInnerTexts())}`,
      ),
    );
    await p.locator(".files-enlarge").click();
    await p.waitForSelector(".files-file.is-maximized");
    await assertAxeClean(p, "enlarged file view");
    await p.locator(".files-enlarge").click();
    await p.waitForSelector(".files-file.is-maximized", { state: "detached" });
    await p.locator(".ab-files").click(); // close the panel

    // 2d) The pin dock — a live region of pinned components that outlives the
    // turn that made them, and the one surface whose content the AGENT wrote.
    const pinnable = p.locator(".turn-render").first();
    await pinnable.hover();
    await pinnable.locator(".pin-btn").click();
    await p.waitForSelector(".pin-dock, .pin-stub");
    await assertAxeClean(p, "pin dock");

    // 2e) The `!` passthrough's stdin bar (4.9) — shell-owned, appears only
    // for the issuing viewport, and masks itself on a password prompt. `sleep`
    // holds it open long enough to sweep; Escape kills the command after.
    await p.locator("textarea").click();
    await p.keyboard.type("!sleep 20");
    await p.keyboard.press("Enter");
    await p.waitForSelector(".bang-bar-input");
    await assertAxeClean(p, "bang input bar");
    await p.locator(".bang-bar-input").click();
    await p.keyboard.press("Escape"); // kill the command
    await p.waitForSelector(".bang-bar-input", { state: "detached" });

    // 3) Settings / theme card (a dialog).
    await p.locator(".sb-settings").click();
    await p.waitForSelector("[role=dialog]");
    await assertAxeClean(p, "settings dialog");
    await p.keyboard.press("Escape");

    // 4) Connect-device (a dialog; needs the relay above).
    await p.locator(".sb-pair").click();
    await p.waitForSelector(".pair-card");
    await assertAxeClean(p, "connect-device dialog");
    await p.keyboard.press("Escape");

    // 5) Mission control (fleet) — now has one session in the list.
    await p.goto(`${baseAx}/`);
    await p.waitForSelector(".fleet-title");
    await p.waitForSelector(".fleet-link");
    await assertAxeClean(p, "fleet view");
  } finally {
    await p.close();
    await dax.stop();
    await relay.stop();
  }
});

test("CS: manage subscription — status, cancel behind its confirm, scheduled state, undo", async () => {
  // A licensed daemon against a stateful billing-backend stub: /api/subscription
  // reads, /cancel schedules at period end, /uncancel clears. The daemon only
  // ever POSTs the license key; end-of-period timing is the SITE's business
  // (pinned in the site repo's own suite). Midday-UTC instants keep the
  // rendered dates timezone-stable.
  const relay = await startRelayStub({});
  const KEY = "mf_e2ecancelabcdefghijklmnop";
  let cancelAt: string | null = null;
  const seenKeys: string[] = [];
  const billing = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      let body: { licenseKey?: unknown } = {};
      try {
        body = JSON.parse(raw) as { licenseKey?: unknown };
      } catch {
        /* the entitlement warm-up may probe with anything — fall through */
      }
      if (typeof body.licenseKey === "string") seenKeys.push(body.licenseKey);
      const url = req.url ?? "";
      if (!url.startsWith("/api/subscription")) {
        res.writeHead(404).end(); // the boot-time entitlement exchange — not under test
        return;
      }
      if (body.licenseKey !== KEY) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ reason: "unknown license key" }));
        return;
      }
      if (url === "/api/subscription/cancel") cancelAt = "2026-09-01T12:00:00Z";
      if (url === "/api/subscription/uncancel") cancelAt = null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "active", periodEnd: "2026-09-01T12:00:00Z", cancelAt }));
    });
  });
  await new Promise<void>((resolve) => billing.listen(0, "127.0.0.1", resolve));
  const billingPort = (billing.address() as { port: number }).port;

  const token = "e2e-cs-9c2f";
  const d2 = await startDaemon({
    MIRAFOLD_TOKEN: token,
    MIRAFOLD_RELAY_URL: relay.url,
    MIRAFOLD_RELAY_CODE: "e2e-cs-pairing-code-1a2b",
    MIRAFOLD_LICENSE_KEY: KEY,
    MIRAFOLD_ENTITLEMENT_URL: `http://127.0.0.1:${billingPort}/api/entitlement`,
    SUBSCRIPTION_MIN_GAP_MS: "0", // test clicks outrun the human-pace floor
  });
  const p = await browser.newPage();
  try {
    await p.goto(`http://127.0.0.1:${d2.port}/?token=${token}`);
    // An empty registry opens the onboarding overlay, which sits over the
    // fleet's pair button — enter a session and use the status bar's instead
    // (both hosts render the same card).
    await p.locator(".onb-agent", { hasText: "Claude Code" }).click();
    await p.waitForURL(/\/s\/[\w-]+/);

    // The resting UI shows only the pair button; nothing cancel-shaped.
    await p.locator(".sb-pair").click();
    await p.waitForSelector(".pair-card");
    const manage = p.locator(".pair-manage", { hasText: "manage subscription" });
    assert.equal(await manage.count(), 1, "licensed daemon must offer the neutral manage link");

    // Manage → the live status line, no cancel action fired yet.
    await manage.click();
    await p.waitForSelector(".sub-line:has-text('active — renews Sep 1, 2026')");
    await assertAxeClean(p, "manage subscription");

    // The confirm step quotes the real consequence — and backing out works.
    await p.locator(".sub-btn", { hasText: "cancel subscription…" }).click();
    await p.waitForSelector(".sub-line:has-text(\"You won't be charged again\")");
    assert.match(await p.locator(".sub-line").innerText(), /Sep 1, 2026/);
    await p.locator(".sub-btn", { hasText: "keep subscription" }).click();
    await p.waitForSelector(".sub-line:has-text('active — renews Sep 1, 2026')");

    // Cancel for real: the scheduled state, with undo as the one action.
    await p.locator(".sub-btn", { hasText: "cancel subscription…" }).click();
    await p.locator(".sub-btn-danger", { hasText: "cancel subscription" }).click();
    await p.waitForSelector(".sub-line:has-text('cancellation scheduled — access ends Sep 1, 2026')");
    await p.locator(".sub-btn", { hasText: "undo cancellation" }).click();
    await p.waitForSelector(".sub-line:has-text('active — renews Sep 1, 2026')");

    // The daemon presented the key on every request…
    assert.ok(seenKeys.length >= 3);
    assert.ok(seenKeys.every((k) => k === KEY));
    // …and the key itself never reached the page (secrets stay server-side).
    assert.ok(!(await p.content()).includes(KEY), "license key leaked into the DOM");
  } finally {
    await p.close();
    await d2.stop();
    await relay.stop();
    await new Promise((resolve) => billing.close(resolve));
  }
});

test("an uncaught front-end error lands in the daemon's log (client_error path)", async () => {
  // The shared page still holds a live socket (fleet or session — both run
  // one). A deferred throw escapes the evaluate call itself and surfaces as
  // window "error", which ws.ts forwards over the wire.
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("e2e-client-error-probe");
    }, 0);
  });
  for (let i = 0; i < 50 && !d.logs().includes("e2e-client-error-probe"); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(d.logs(), /error: client error: Error: e2e-client-error-probe/);
});
