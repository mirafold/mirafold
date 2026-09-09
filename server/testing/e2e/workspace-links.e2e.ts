import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, Locator } from "playwright-core";
import type { ClientMsg, WireMsg } from "../../protocol";
import { createSession } from "../itest-harness";
import { assertAxeClean, launchChrome, withFreshMockPage } from "./e2e-harness";

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
        { type: "render", id: "file-question", component: "question", props: {
          question: "Choose a report",
          options: [
            { label: "Use this report", text: "Use the reviewed report", detail: `Read ${link("question file")} before choosing. [Website](https://example.test/review).` },
            { label: "Wait", detail: "Keep reviewing" },
          ],
        } },
        { type: "turn_end" },
      ];
      const reads: string[] = [];
      const actions: Extract<ClientMsg, { type: "action" }>[] = [];
      let actionReceived: (() => void) | undefined;
      let onFileReply: ((reply: Extract<WireMsg, { type: "fs_file" }>) => void) | undefined;
      // Only the agent's reply is injected. Auth, session cwd, file reads,
      // the Files panel, and pinning use the real daemon and built app.
      await page.routeWebSocket("**/ws", (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === "fs_read") reads.push(message.path);
          // The injected painting has no server-side render ID. Observe its
          // actions here; app.e2e verifies a real question's prompt round trip.
          if (message.type === "action") { actions.push(message); actionReceived?.(); return; }
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
      const openFile = async (target: Locator, key?: "Enter" | "Space") => {
        await target.waitFor();
        assert.equal(await target.evaluate((el) => el.tagName), "BUTTON", "a local file still renders as a browser navigation");
        assert.equal(await target.getAttribute("href"), null);
        // These are separate user clicks, spaced beyond the daemon's
        // 250 ms read limit; this test exercises routing, not throttling.
        await delay(300);
        const before = reads.length;
        const priorActions = [...actions];
        const reply = new Promise<Extract<WireMsg, { type: "fs_file" }>>((resolve) => { onFileReply = resolve; });
        if (key) { await target.focus(); await target.press(key); }
        else await target.click();
        const file = await reply;
        assert.equal(file.error, undefined, `${await target.innerText()}: ${JSON.stringify(file)}`);
        await page.locator(".folder-tree-view .fv-content").waitFor();
        assert.equal(await page.locator(".folder-tree-view .fv-content").innerText(), content);
        assert.equal(reads.length, before + 1, "each click must request the file, including a repeated open");
        assert.equal(reads.at(-1), filename);
        assert.equal(page.url(), sessionUrl);
        assert.equal(page.context().pages().length, pages, "a local path opened a new browser tab");
        assert.deepEqual(actions, priorActions, "opening a file also submitted a painting action");
      };
      for (const label of ["prose file", "card file", "list file", "detail file", "question file"]) {
        await openFile(page.locator(".output-zone").getByText(label, { exact: true }));
      }
      await page.locator(".turn-render").filter({ has: page.locator(".rc-card") }).locator(".pin-btn").click();
      await openFile(page.locator(".pin-dock").getByText("card file", { exact: true }));
      const question = page.locator(".rc-question");
      const fileLink = question.getByRole("button", { name: "question file", exact: true });
      await openFile(fileLink, "Enter");
      await openFile(fileLink, "Space");
      assert.equal(await question.locator(".rc-question-chosen").count(), 0);
      assert.equal(await question.getByRole("button", { name: "Use this report", exact: true }).isEnabled(), true);
      await assertAxeClean(page, "workspace links inside question options");

      await page.context().route("https://example.test/**", (route) => route.fulfill({ body: "Review website" }));
      const [popup] = await Promise.all([
        page.waitForEvent("popup"),
        question.getByRole("link", { name: "Website", exact: true }).click(),
      ]);
      await popup.waitForURL("https://example.test/review");
      await popup.close();
      assert.equal(actions.length, 0, "opening an ordinary web link submitted the answer");

      // The label remains a pointer target, and a different option still
      // works by keyboard after a question is pinned (a fresh local copy).
      let answered = new Promise<void>((resolve) => { actionReceived = resolve; });
      const label = question.getByText("Use this report", { exact: true });
      await label.scrollIntoViewIfNeeded();
      const box = await label.boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await answered;
      assert.deepEqual(actions.map((message) => message.action), [{ kind: "prompt", text: "Use the reviewed report" }]);
      assert.equal(await question.locator(".rc-question-opt:disabled").count(), 2);
      await openFile(fileLink);
      await assertAxeClean(page, "workspace links remain usable after answering");
      await page.locator(".turn-render").filter({ has: question }).locator(".pin-btn").click();
      const pinnedQuestion = page.locator(".pin-dock .rc-question");
      await openFile(pinnedQuestion.getByRole("button", { name: "question file", exact: true }));
      answered = new Promise<void>((resolve) => { actionReceived = resolve; });
      await pinnedQuestion.getByRole("button", { name: "Wait", exact: true }).press("Enter");
      await answered;
      await page.waitForFunction(() => document.querySelectorAll(".pin-dock .rc-question-opt:disabled").length === 2);
      assert.deepEqual(actions.map((message) => message.action), [
        { kind: "prompt", text: "Use the reviewed report" },
        { kind: "prompt", text: "Wait" },
      ]);
      await assertAxeClean(page, "links in unchosen options of a pinned question");
      assert.deepEqual(errors, []);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
