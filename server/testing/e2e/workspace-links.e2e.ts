import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, Locator } from "playwright-core";
import type { WireMsg } from "../../protocol";
import { createSession } from "../itest-harness";
import { launchChrome, withFreshMockPage } from "./e2e-harness";

let browser: Browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); });

test("workspace HTML links open Files from prose, painting Markdown, and pinned paintings", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mirafold-link project-"));
  const filename = "review page.html";
  const content = "<!doctype html><h1>Workspace link fixture</h1>";
  await writeFile(path.join(root, filename), content);
  try {
    const token = "workspace-links-browser-fixture";
    await withFreshMockPage(browser, { token }, async (page, base, errors) => {
      const { client, sessionId } = await createSession(Number(new URL(base).port), "claude-code", { cwd: root, token });
      client.close();
      const href = encodeURI(path.join(root, filename));
      const link = (label: string) => `[${label}](${href})`;
      const frames: WireMsg[] = [
        { type: "text_delta", text: link("prose file") },
        { type: "render", id: "file-card", component: "card", props: { title: "Review", body: link("card file") } },
        { type: "render", id: "file-list", component: "list", props: { items: [{ text: link("list file"), detail: link("detail file") }] } },
        { type: "turn_end" },
      ];
      const reads: string[] = [];
      let onFileReply: ((reply: Extract<WireMsg, { type: "fs_file" }>) => void) | undefined;
      // Only the agent's reply is injected. Auth, session cwd, file reads,
      // the Files panel, and pinning use the real daemon and built app.
      await page.routeWebSocket("**/ws", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === "fs_read") reads.push(message.path);
          server.send(raw);
        });
        server.onMessage((raw) => {
          socket.send(raw);
          const message = JSON.parse(String(raw));
          if (message.type === "fs_file") onFileReply?.(message);
          if (message.type === "replay_complete") {
            for (const frame of frames) socket.send(JSON.stringify(frame));
          }
        });
      });
      await page.goto(`${base}/s/${sessionId}`);
      const sessionUrl = page.url();
      const pages = page.context().pages().length;
      const openFile = async (target: Locator) => {
        await target.waitFor();
        assert.equal(await target.evaluate((el) => el.tagName), "BUTTON", "a local file still renders as a browser navigation");
        assert.equal(await target.getAttribute("href"), null);
        // These are separate user clicks, spaced beyond the daemon's
        // 250 ms read limit; this test exercises routing, not throttling.
        await delay(300);
        const before = reads.length;
        const reply = new Promise<Extract<WireMsg, { type: "fs_file" }>>((resolve) => { onFileReply = resolve; });
        await target.click();
        const file = await reply;
        assert.equal(file.error, undefined, `${await target.innerText()}: ${JSON.stringify(file)}`);
        await page.locator(".folder-tree-view .fv-content").waitFor();
        assert.equal(await page.locator(".folder-tree-view .fv-content").innerText(), content);
        assert.equal(reads.length, before + 1, "each click must request the file, including a repeated open");
        assert.equal(reads.at(-1), filename);
        assert.equal(page.url(), sessionUrl);
        assert.equal(page.context().pages().length, pages, "a local path opened a new browser tab");
      };
      for (const label of ["prose file", "card file", "list file", "detail file"]) {
        await openFile(page.locator(".output-zone").getByText(label, { exact: true }));
      }
      await page.locator(".turn-render").filter({ has: page.locator(".rc-card") }).locator(".pin-btn").click();
      await openFile(page.locator(".pin-dock").getByText("card file", { exact: true }));
      assert.deepEqual(errors, []);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
