import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page } from "playwright-core";
import { createSession, startDaemon } from "../itest-harness";
import { pagedDirectoryFixture } from "../fixtures/paged-directory";
import { launchChrome } from "./e2e-harness";

let browser: Browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); });

async function withDirectoryPage(emptyFirst: boolean, run: (page: Page) => Promise<void>) {
  const fixture = pagedDirectoryFixture();
  const token = "folder-pagination-test";
  const daemon = await startDaemon({ ...fixture.env, MIRAFOLD_TOKEN: token });
  try {
    const seeded = await createSession(daemon.port, "claude-code", { cwd: fixture.root, token });
    seeded.client.close();
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    try {
      const page = await context.newPage();
      const errors: Error[] = [];
      page.on("pageerror", error => errors.push(error));
      await page.addInitScript(({ emptyFirst }) => {
        const native = window.WebSocket;
        let replaced = false;
        const state = window as unknown as { directoryReplies: { count: number; directories: number; continuation?: string }[] };
        state.directoryReplies = [];
        window.WebSocket = new Proxy(native, {
          construct(Target, args) {
            const socket = Reflect.construct(Target, args) as WebSocket;
            socket.addEventListener("message", event => {
              const message = JSON.parse(String(event.data));
              if (message.type !== "fs_dir" || message.path !== "") return;
              // An ignored raw page can be empty with a valid continuation.
              // Replace just that reply body to isolate the browser's empty
              // state; the following click uses the real server token.
              if (emptyFirst && !replaced) {
                replaced = true;
                event.stopImmediatePropagation();
                socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...message, entries: [] }) }));
                return;
              }
              state.directoryReplies.push({ count: message.entries.length,
                directories: message.entries.filter((e: { kind: string }) => e.kind === "dir").length,
                continuation: message.continuation,
              });
            });
            return socket;
          },
        });
      }, { emptyFirst });
      const base = `http://127.0.0.1:${daemon.port}`;
      await page.goto(`${base}/s/${seeded.sessionId}?token=${token}`);
      await page.locator(".prompt-box textarea").waitFor();
      await page.locator(".ab-folder-tree").click();
      await page.locator(".folder-tree-load-more").waitFor();
      await run(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    await daemon.stop();
    fixture.close();
  }
}

test("Load more reaches a directory after 10,000 files through the real server and opens its child", async () => {
  await withDirectoryPage(false, async page => {
    assert.equal(await page.locator(".folder-tree-file-row").count(), 2_000);
    assert.equal(await page.locator(".folder-tree-load-more").count(), 1);
    await page.locator(".folder-tree-load-more").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/mirafold-pagination-load-more.png" });
    for (const count of [4_000, 6_000, 8_000, 10_000]) {
      await page.locator(".folder-tree-load-more").click();
      await page.waitForFunction(expected => document.querySelectorAll(".folder-tree-file-row").length === expected, count);
      assert.equal(await page.locator(".folder-tree-load-more").count(), 1);
    }
    await page.locator(".folder-tree-load-more").click();
    const directory = page.locator('.folder-tree-dir:has(.folder-tree-name:text-is("late-directory"))');
    await directory.waitFor();
    assert.equal(await page.locator(".folder-tree-file-row").count(), 10_000, "earlier pages stay visible");
    assert.equal(await page.locator(".folder-tree-load-more").count(), 0);
    const replies = await page.evaluate(() => (window as unknown as {
      directoryReplies: { count: number; directories: number; continuation?: string }[];
    }).directoryReplies);
    assert.equal(replies.length, 6);
    assert.ok(replies.slice(0, 5).every(r => r.count === 2_000 && r.directories === 0 && r.continuation));
    assert.deepEqual(replies.at(-1), { count: 1, directories: 1, continuation: undefined });
    await directory.click();
    await page.locator('.folder-tree-file-row:has(.folder-tree-name:text-is("reachable.txt"))').click();
    await page.getByText("Reached the later directory.", { exact: false }).waitFor();
    await page.screenshot({ path: "/tmp/mirafold-pagination-reached.png" });
  });
});

test("an empty page still offers Load more and a refresh replaces accumulated entries", async () => {
  await withDirectoryPage(true, async page => {
    assert.equal(await page.locator(".folder-tree-file-row").count(), 0);
    assert.equal(await page.getByText("(no files)", { exact: true }).count(), 0);
    await page.locator(".folder-tree-load-more").click();
    await page.waitForFunction(() => document.querySelectorAll(".folder-tree-file-row").length === 2_000);
    assert.equal(await page.locator('.folder-tree-name:text-is("file-02000.txt")').count(), 1);
    await page.getByRole("button", { name: "Refresh files", exact: true }).click();
    await page.locator('.folder-tree-name:text-is("file-00000.txt")').waitFor();
    assert.equal(await page.locator(".folder-tree-file-row").count(), 2_000);
    assert.equal(await page.locator('.folder-tree-name:text-is("file-02000.txt")').count(), 0);
    assert.equal(await page.locator(".folder-tree-load-more").count(), 1);
  });
});

test("a rejected continuation keeps loaded rows, explains recovery, and refresh starts a new listing", async () => {
  await withDirectoryPage(false, async page => {
    await page.evaluate(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
        const message = JSON.parse(String(data));
        // Exercise the real server's unavailable-token reply without waiting
        // two minutes; the server lifecycle tests cover actual expiry.
        if (message.type === "fs_listdir" && message.continuation) {
          message.continuation = "expired-listing-token";
          WebSocket.prototype.send = send;
          return send.call(this, JSON.stringify(message));
        }
        return send.call(this, data);
      };
    });
    await page.locator(".folder-tree-load-more").click();
    await page.getByText("This folder listing is no longer available. Refresh files to continue.", { exact: true }).waitFor();
    assert.equal(await page.locator(".folder-tree-file-row").count(), 2_000);
    assert.equal(await page.locator(".folder-tree-load-more").count(), 0);
    await page.getByRole("button", { name: "Refresh files", exact: true }).click();
    await page.locator(".folder-tree-load-more").waitFor();
    assert.equal(await page.getByText("This folder listing is no longer available. Refresh files to continue.", { exact: true }).count(), 0);
    assert.equal(await page.locator(".folder-tree-file-row").count(), 2_000);
  });
});
