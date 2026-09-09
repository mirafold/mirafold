import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Browser, Page, WebSocketRoute } from "playwright-core";
import type { SessionMeta, WireMsg } from "../../protocol";
import { launchChrome, PHONE_CONTEXT } from "./e2e-harness";
import { derivePair, openHandshake, sealHandshake, randomBytes, frameCiphers, type FrameCipher } from "../../relay/relay-crypto";

let browser: Browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); });

// Serve the real built UI entirely through interception. Only delivery timing
// is controlled here; connection.test.ts proves the daemon's replay boundary.
async function serveBuiltPage(page: Page, origin = "http://mirafold.test") {
  await page.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const asset = pathname.startsWith("/assets/") ? pathname : "/index.html";
    if (!/^\/(?:assets\/[\w.-]+|index\.html)$/.test(asset)) {
      await route.abort();
      return;
    }
    await route.fulfill({
      contentType: asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "text/html",
      body: await readFile(new URL(`../../../dist${asset}`, import.meta.url)),
    });
  });
}

const paint = (page: Page) => page.evaluate(() => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
));

for (const phone of [false, true]) {
  test(`${phone ? "phone session entry" : "cockpit switch"}: delayed history first appears complete and at the bottom`, async () => {
    const context = await browser.newContext(phone ? PHONE_CONTEXT : { viewport: { width: 1280, height: 720 } });
    try {
      const page = await context.newPage();
      await serveBuiltPage(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        const frames: { rows: number; gap: number }[] = [];
        (window as unknown as { entryFrames: typeof frames }).entryFrames = frames;
        new MutationObserver(() => {
          const zone = document.querySelector(".output-zone");
          if (zone && frames.length < 5_000) frames.push({
            rows: zone.querySelectorAll(".turn-user").length,
            gap: zone.scrollHeight - zone.scrollTop - zone.clientHeight,
          });
        }).observe(document, { childList: true, subtree: true, characterData: true });
      });
      let target: WebSocketRoute | undefined;
      const send = (socket: WebSocketRoute, message: WireMsg) => socket.send(JSON.stringify(message));
      const sessions: SessionMeta[] = ["source", "target"].map((name) => ({
        sessionId: name, name, cwd: "/tmp", agent: "claude-code",
        status: "idle", lastActivity: 1, viewports: 1,
      }));
      await page.routeWebSocket("**/ws", (socket) => socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "watch_sessions") send(socket, { type: "sessions", sessions });
        if (message.type === "attach") {
          send(socket, { type: "session_created", sessionId: message.sessionId, cwd: "/tmp", agent: "claude-code", replayPending: true });
          if (message.sessionId === "source") send(socket, { type: "replay_complete" });
          else target = socket;
        }
      }));
      await page.goto("http://mirafold.test/s/source");
      if (!phone) {
        await paint(page);
        assert.equal(await page.locator(".prompt-box textarea").evaluate((el) => document.activeElement === el), true,
          "desktop session entry still starts ready to type");
      }
      if (phone) await page.goto("http://mirafold.test/s/target");
      else {
        await page.locator(".ab-cockpit").click();
        await page.locator('.cockpit-session-name[href="/s/target"]').click();
        await page.waitForURL("**/s/target");
      }
      await page.locator(".sb-agent", { hasText: "claude-code" }).waitFor();
      assert.ok(target, "the destination attached");
      for (let i = 0; i < 12; i++) {
        send(target, { type: "user_prompt", text: `history ${i}`, replay: true, seq: i * 3 + 1 });
        send(target, { type: "text_delta", text: "Historical answer. ".repeat(60), replay: true, seq: i * 3 + 2 });
        send(target, { type: "turn_end", replay: true, seq: i * 3 + 3 });
        await paint(page);
      }
      send(target, { type: "replay_complete" });
      await page.locator(".turn-user", { hasText: "history 11" }).waitFor();
      const frames = await page.evaluate(() =>
        (window as unknown as { entryFrames: { rows: number; gap: number }[] }).entryFrames,
      );
      const visibleHistory = frames.filter((frame) => frame.rows > 0);
      assert.ok(visibleHistory.length > 0, "observed the history commit");
      assert.ok(visibleHistory.every((frame) => frame.rows === 12 && frame.gap <= 24),
        `partial history or a late scroll correction: ${JSON.stringify(visibleHistory.slice(0, 8))}`);
      // Live output still advances immediately after the replay boundary.
      send(target, { type: "user_prompt", text: "live question", seq: 37 });
      send(target, { type: "text_delta", text: "Live answer. ".repeat(80), seq: 38 });
      await page.locator(".turn-user", { hasText: "live question" }).waitFor();
      await paint(page);
      const gap = await page.locator(".output-zone").evaluate((zone) => zone.scrollHeight - zone.scrollTop - zone.clientHeight);
      assert.ok(gap <= 24, `live output lost tail following: ${gap}`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("phone pairing waits for a tap to focus the prompt, including after incoming turns", async () => {
  const context = await browser.newContext(PHONE_CONTEXT);
  try {
    const page = await context.newPage();
    await serveBuiltPage(page, "https://mirafold.test");
    await page.addInitScript(() => {
      document.addEventListener("focusin", (event) => {
        if (event.target instanceof Element && event.target.matches(".prompt-box textarea")) {
          document.documentElement.dataset.promptFocusCount = String(
            Number(document.documentElement.dataset.promptFocusCount ?? "0") + 1,
          );
        }
      });
    });
    // Hold the encrypted handshake to exercise the exact pre-connection
    // screen in the iPhone screenshot, then finish the real pairing protocol.
    const code = "phone-focus-fixture";
    const pair = await derivePair(code);
    let releaseHandshake!: () => void;
    const handshakeGate = new Promise<void>((resolve) => { releaseHandshake = resolve; });
    let sawHandshake!: () => void;
    const handshakeSeen = new Promise<void>((resolve) => { sawHandshake = resolve; });
    let send!: (message: WireMsg) => Promise<void>;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.routeWebSocket("**/ws?pair=*", (socket) => {
      let cipher: FrameCipher | undefined;
      let chain = Promise.resolve();
      socket.onMessage((raw) => {
        chain = chain.then(async () => {
          if (!cipher) {
            const clientNonce = await openHandshake(pair, "c", String(raw));
            sawHandshake();
            await handshakeGate;
            const daemonNonce = randomBytes(32);
            cipher = await frameCiphers(pair, clientNonce, daemonNonce, "d");
            send = async (message) => socket.send(await cipher!.seal(JSON.stringify(message)));
            socket.send(await sealHandshake(pair, "d", daemonNonce));
            return;
          }
          const message = JSON.parse(await cipher.open(String(raw)));
          if (message.type === "attach") {
            await send({ type: "session_created", sessionId: "phone", cwd: "/tmp", agent: "claude-code", replayPending: true });
            await send({ type: "replay_complete" });
          }
        }).catch((error) => { errors.push(String(error)); });
      });
    });
    await page.goto(`https://mirafold.test/#code=${code}&s=phone`);
    await handshakeSeen;
    await paint(page);
    const focusCount = () => page.locator("html").getAttribute("data-prompt-focus-count");
    assert.equal(await focusCount(), null, "startup focused the phone prompt before pairing completed");
    releaseHandshake();
    await page.locator(".sb-agent", { hasText: "claude-code" }).waitFor();
    await send({ type: "user_prompt", text: "sent from another viewport", seq: 1 });
    await send({ type: "text_delta", text: "An incoming answer", seq: 2 });
    await page.locator(".activity-line").waitFor();
    await send({ type: "turn_end", seq: 3 });
    await page.locator(".activity-line").waitFor({ state: "hidden" });
    await paint(page);
    assert.equal(await focusCount(), null, "incoming session state focused the phone prompt without a tap");
    await page.locator(".prompt-box textarea").tap();
    assert.equal(await page.locator(".prompt-box textarea").evaluate((el) => document.activeElement === el), true);
    await page.keyboard.type("a deliberate draft");
    assert.equal(await page.locator(".prompt-box textarea").inputValue(), "a deliberate draft");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
