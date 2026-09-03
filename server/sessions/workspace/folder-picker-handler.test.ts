import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../../protocol";
import { createFolderPickerHandler } from "./folder-picker-handler";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("local picker success and cancellation each produce one correlated reply", async () => {
  const seen: WireMsg[] = [];
  const choices = ["/chosen/project", undefined];
  const handler = createFolderPickerHandler({
    viewport: (msg) => seen.push(msg),
    remote: false,
    isClosed: () => false,
    pickDirectory: async () => choices.shift(),
  });
  handler.pick({ type: "pick_folder", id: "fp-one", cwd: "~/start" });
  await settle();
  handler.pick({ type: "pick_folder", id: "fp-two" });
  await settle();
  assert.deepEqual(seen, [
    { type: "folder_picked", id: "fp-one", path: "/chosen/project" },
    { type: "folder_picked", id: "fp-two", canceled: true },
  ]);
});

test("relay viewports cannot open host UI, and hostile request shapes are bounded", async () => {
  const seen: WireMsg[] = [];
  let called = 0;
  const remote = createFolderPickerHandler({
    viewport: (msg) => seen.push(msg),
    remote: true,
    isClosed: () => false,
    pickDirectory: async () => {
      called++;
      return "/must-not-run";
    },
  });
  remote.pick({ type: "pick_folder", id: "fp-remote" });
  assert.equal(called, 0);
  assert.match((seen[0] as Extract<WireMsg, { type: "folder_picked" }>).error!, /only on the computer/);

  const local = createFolderPickerHandler({
    viewport: (msg) => seen.push(msg),
    remote: false,
    isClosed: () => false,
    pickDirectory: async () => "/must-not-run",
  });
  local.pick({ type: "pick_folder", id: "bad id" });
  local.pick({ type: "pick_folder", id: "fp-long", cwd: "x".repeat(4_097) });
  await settle();
  assert.equal(called, 0);
  assert.equal(seen.length, 2, "bad id dropped; long path answered once");
  assert.match((seen[1] as Extract<WireMsg, { type: "folder_picked" }>).error!, /too long/);
});

test("one connection cannot stack dialogs, and close aborts the in-flight picker", async () => {
  const seen: WireMsg[] = [];
  let aborted = false;
  const handler = createFolderPickerHandler({
    viewport: (msg) => seen.push(msg),
    remote: false,
    isClosed: () => false,
    pickDirectory: (_cwd, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  });
  handler.pick({ type: "pick_folder", id: "fp-first" });
  handler.pick({ type: "pick_folder", id: "fp-second" });
  assert.deepEqual(seen, [
    {
      type: "folder_picked",
      id: "fp-second",
      error: "A folder picker is already open. Choose a folder or cancel it first.",
    },
  ]);
  handler.close();
  await settle();
  assert.equal(aborted, true);
  assert.equal(seen.length, 1, "an aborted/closed viewport receives no late reply");
});
