import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientMsg } from "@protocol";
import { createFolderPickerRequests } from "./folder-picker-requests";

test("folder-picker requests correlate success, cancel, and errors", async () => {
  const sent: ClientMsg[] = [];
  let n = 0;
  const requests = createFolderPickerRequests(
    (msg) => {
      sent.push(msg);
    },
    () => `fp-${++n}`,
  );
  const success = requests.request("~/project");
  const cancel = requests.request();
  const failure = requests.request("/bad");
  assert.deepEqual(sent, [
    { type: "pick_folder", id: "fp-1", cwd: "~/project" },
    { type: "pick_folder", id: "fp-2" },
    { type: "pick_folder", id: "fp-3", cwd: "/bad" },
  ]);
  assert.equal(requests.handle({ type: "folder_picked", id: "fp-1", path: "/chosen" }), true);
  assert.equal(requests.handle({ type: "folder_picked", id: "fp-2", canceled: true }), true);
  assert.equal(requests.handle({ type: "folder_picked", id: "fp-3", error: "could not open" }), true);
  assert.equal(await success, "/chosen");
  assert.equal(await cancel, undefined);
  await assert.rejects(failure, /could not open/);
  assert.equal(requests.handle({ type: "pong" }), false);
});

test("a disconnected click rejects immediately instead of becoming a replayed dialog", async () => {
  const requests = createFolderPickerRequests(
    () => false,
    () => "fp-offline",
  );
  await assert.rejects(requests.request(), /connection is not ready/);
});

test("disconnect rejects every picker still waiting", async () => {
  const requests = createFolderPickerRequests(
    () => undefined,
    () => "fp-waiting",
  );
  const waiting = requests.request();
  requests.disconnect();
  await assert.rejects(waiting, /connection closed/);
});
