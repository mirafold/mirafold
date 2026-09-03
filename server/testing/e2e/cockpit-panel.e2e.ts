import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startDaemon, type Daemon } from "../itest-harness";
import { MOCK_PROMPTS } from "../fixtures/mock-prompts";
import {
  assertAxeClean,
  enterMockSession,
  launchChrome,
  noSideScroll,
  typePrompt,
  waitTurnIdle,
} from "./e2e-harness";

let daemon: Daemon;
let browser: Browser;
let context: BrowserContext;
let first: Page;
let second: Page;
let base: string;
let firstId: string;
let secondId: string;

const sessionId = (page: Page) => new URL(page.url()).pathname.split("/").pop()!;
const row = (page: Page, id: string) => page.locator(`.cockpit-item[data-session-id="${id}"]`);

before(async () => {
  daemon = await startDaemon({ SESSION_IDLE_TIMEOUT_MS: "300000" });
  base = `http://127.0.0.1:${daemon.port}`;
  browser = await launchChrome();
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  first = await context.newPage();
  await first.goto(`${base}/`);
  await enterMockSession(first);
  firstId = sessionId(first);

  second = await context.newPage();
  await second.goto(`${base}/?new=1`);
  await enterMockSession(second);
  secondId = sessionId(second);
  assert.notEqual(firstId, secondId);
});

after(async () => {
  await context?.close();
  await browser?.close();
  await daemon?.stop();
});

test("CP.2/3 cockpit panel previews, acts, follows a session switch, and closes persistently", async () => {
  await first.locator(".ab-cockpit").click();
  const panel = first.locator(".cockpit-panel");
  await panel.waitFor();
  await first.waitForFunction(() => document.querySelectorAll(".cockpit-item").length === 2);

  const width = await panel.evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(width >= 220 && width <= 252, `cockpit width ${width}px is not the intended compact dock`);
  // The transcript keeps real air from an open panel's edge — the frame's
  // own gutter, not the scroller's 4px (cockpit follow-up 4, 2026-08-31).
  const panelBox = (await panel.boundingBox())!;
  const zoneBox = (await first.locator(".output-zone").boundingBox())!;
  const panelGap = zoneBox.x - (panelBox.x + panelBox.width);
  assert.ok(panelGap >= 22 && panelGap <= 36, `transcript sits ${panelGap}px from the open panel — wants ~24`);
  assert.equal(await row(first, firstId).locator(".cockpit-session-id").innerText(), firstId);
  assert.equal(await row(first, secondId).locator(".cockpit-session-id").innerText(), secondId);
  // Rename in place, FleetView parity: ✎ opens the input; Enter commits and
  // the new name arrives back through the server's sessions snapshot;
  // Escape cancels without renaming.
  const target = row(first, secondId);
  const editGap = await target.evaluate((element) => {
    const name = element.querySelector(".cockpit-session-name");
    const edit = element.querySelector(".cockpit-edit");
    if (!(name instanceof HTMLElement) || !(edit instanceof HTMLElement)) {
      throw new Error("cockpit rename controls are missing");
    }
    const text = document.createRange();
    text.selectNodeContents(name);
    return edit.getBoundingClientRect().left - text.getBoundingClientRect().right;
  });
  assert.ok(editGap >= 0 && editGap <= 10, `rename pencil sits ${editGap}px after the session name`);
  await target.locator(".cockpit-edit").click();
  const rename = target.locator(".cockpit-rename");
  await rename.waitFor();
  await rename.fill("renamed from the cockpit");
  await rename.press("Enter");
  await target.locator(".cockpit-session-name", { hasText: "renamed from the cockpit" }).waitFor({ timeout: 10_000 });
  await target.locator(".cockpit-edit").click();
  await rename.press("Escape");
  await rename.waitFor({ state: "detached" });
  assert.equal(await target.locator(".cockpit-session-name").innerText(), "renamed from the cockpit");

  const closedRowText = await row(first, secondId).innerText();
  assert.doesNotMatch(closedRowText, /claude-code|⧉|\btok\b|\bpair\b/i);
  assert.equal(await row(first, firstId).locator(".cockpit-session-name").getAttribute("aria-current"), "page");

  // Open the down-chevron before the turn: the opted-in watcher must update
  // this already-mounted text region while another session streams.
  await row(first, secondId).locator(".cockpit-transcript-toggle").click();
  await typePrompt(second, "unique live cockpit preview");
  await row(first, secondId)
    .locator(".cockpit-transcript-text")
    .filter({ hasText: "unique live cockpit preview" })
    .waitFor({ timeout: 15_000 });
  await waitTurnIdle(second, "preview seed turn", 30_000, daemon.logs);

  // The right-chevron exposes the existing sessionId-addressed prompt act.
  await row(first, secondId).locator(".cockpit-prompt-toggle").click();
  const quickPrompt = row(first, secondId).locator(".cockpit-prompt input");
  await quickPrompt.fill("prompt sent from the in-session cockpit");
  await quickPrompt.press("Enter");
  await second.locator(".turn-user", { hasText: "prompt sent from the in-session cockpit" }).waitFor();
  await waitTurnIdle(second, "cockpit quick prompt", 30_000, daemon.logs);

  // A permission hold is still a live, interruptible turn. This compact
  // panel intentionally omits FleetView's allow/deny line, so Stop must not
  // disappear exactly when the session needs an answer.
  await typePrompt(second, "run something dangerous");
  await second.locator(".permission-bar").waitFor({ timeout: 15_000 });
  const permissionStop = row(first, secondId).locator(".cockpit-stop");
  await permissionStop.waitFor({ timeout: 15_000 });
  await permissionStop.click();
  await permissionStop.click();
  await second.locator(".permission-bar").waitFor({ state: "detached", timeout: 10_000 });
  await waitTurnIdle(second, "cockpit permission stop", 10_000, daemon.logs);

  // A short viewport makes the row stack overflow; the panel itself remains
  // the scroll owner rather than widening or scrolling the page.
  await row(first, secondId).locator(".cockpit-prompt-toggle").click();
  await first.setViewportSize({ width: 1280, height: 420 });
  const scroll = await first.locator(".cockpit-list").evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.equal(scroll.overflowY, "auto");
  assert.ok(scroll.scrollHeight > scroll.clientHeight, "the compact session rows did not overflow into a scroll list");
  await first.setViewportSize({ width: 1280, height: 720 });
  await first.screenshot({ path: join(tmpdir(), "mirafold-cockpit-panel.png") });
  await noSideScroll(first);
  await assertAxeClean(first, "in-session cockpit with transcript and prompt disclosures");
  await row(first, secondId).locator(".cockpit-prompt-toggle").click();

  // Stop is the same two-click interrupt idiom as FleetView; the session
  // remains warm and returns idle.
  await typePrompt(second, MOCK_PROMPTS["slow-subagent"]);
  const stop = row(first, secondId).locator(".cockpit-stop");
  await stop.waitFor({ timeout: 15_000 });
  await stop.click();
  assert.equal(await stop.innerText(), "stop?");
  await stop.click();
  await stop.waitFor({ state: "detached", timeout: 10_000 });
  await waitTurnIdle(second, "cockpit stop", 10_000, daemon.logs);

  // Direct row navigation keeps the panel because its open state belongs to
  // the browser origin, not to one Shell mount.
  await row(first, secondId).locator(".cockpit-session-name").click();
  await first.waitForURL(`${base}/s/${secondId}`);
  await first.locator(".cockpit-panel").waitFor();
  assert.equal(await row(first, secondId).locator(".cockpit-session-name").getAttribute("aria-current"), "page");
  assert.equal(
    await first.evaluate(() => localStorage.getItem("mirafold-cockpit-panel-open")),
    "1",
  );

  // Explicit close is sticky too: navigating to another session does not
  // resurrect the panel.
  await first.locator(".ab-cockpit").click();
  await first.locator(".cockpit-panel").waitFor({ state: "detached" });
  assert.equal(
    await first.evaluate(() => localStorage.getItem("mirafold-cockpit-panel-open")),
    null,
  );
  await first.goto(`${base}/s/${firstId}`);
  await first.locator(".prompt-box textarea").waitFor();
  assert.equal(await first.locator(".cockpit-panel").count(), 0);

  // Reopen, then end the other session through the compact row. Its attached
  // viewport is sent home and the row leaves this panel.
  await first.locator(".ab-cockpit").click();
  await row(first, secondId).waitFor();
  const end = row(first, secondId).locator(".cockpit-end");
  await end.click();
  assert.equal(await end.innerText(), "end?");
  await end.click();
  await row(first, secondId).waitFor({ state: "detached", timeout: 10_000 });
  await second.waitForURL(`${base}/`);
});

test("BUGHUNT: an independently refused cockpit socket explains why it cannot connect", async () => {
  const refused = await context.newPage();
  await refused.addInitScript(() => {
    localStorage.removeItem("mirafold-cockpit-panel-open");
    const NativeWebSocket = window.WebSocket;
    let connections = 0;
    // Keep this browser-init callback self-contained. A named class here is
    // transformed to a reference to esbuild's module-scoped `__name` helper,
    // which Playwright cannot serialize into the page with the callback.
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        connections++;
        if (connections === 1) return Reflect.construct(target, args);

        const socket: {
          readyState: number;
          onopen: ((event: Event) => void) | null;
          onmessage: ((event: MessageEvent) => void) | null;
          onclose: ((event: CloseEvent) => void) | null;
          send: () => void;
          close: () => void;
        } = {
          readyState: WebSocket.CONNECTING,
          onopen: null,
          onmessage: null,
          onclose: null,
          send() {},
          close() {
            socket.readyState = WebSocket.CLOSED;
          },
        };
        setTimeout(() => {
          socket.readyState = WebSocket.OPEN;
          socket.onopen?.(new Event("open"));
          setTimeout(() => {
            socket.readyState = WebSocket.CLOSED;
            socket.onclose?.({ code: 4004 } as CloseEvent);
          }, 0);
        }, 0);
        return socket;
      },
    });
  });

  await refused.goto(`${base}/s/${firstId}`);
  await refused.locator(".prompt-box textarea").waitFor();
  await refused.locator(".ab-cockpit").click();
  await refused
    .locator(".cockpit-error", { hasText: "Relay at capacity — retrying" })
    .waitFor({ timeout: 10_000 });
  assert.equal(
    await refused.locator(".status-bar .sb-dot-on").count(),
    1,
    "the primary session socket remained connected while only the cockpit was refused",
  );
  await refused.close();
});
