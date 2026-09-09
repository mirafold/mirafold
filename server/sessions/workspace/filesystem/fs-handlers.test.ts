import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../../../protocol";
import { createFsHandlers } from "./fs-handlers";

test("malformed filesystem IDs are dropped before session lookup or a reply", () => {
  const replies: WireMsg[] = [];
  let lookups = 0;
  const handlers = createFsHandlers({
    viewport: (message) => replies.push(message),
    getEntry: () => { lookups++; return null; },
    isClosed: () => false,
  });

  for (const id of [undefined, null, 123, "", "bad id", "x".repeat(65)]) {
    handlers.list({ type: "fs_list", id } as never);
    handlers.listdir({ type: "fs_listdir", id, path: "" } as never);
    handlers.read({ type: "fs_read", id, path: "file.txt" } as never);
    handlers.diff({ type: "fs_diff", id, path: "file.txt" } as never);
    handlers.changes({ type: "fs_changes", id } as never);
  }
  assert.equal(lookups, 0, "invalid IDs cannot reach workspace work");
  assert.deepEqual(replies, [], "invalid IDs are silently dropped");

  handlers.list({ type: "fs_list", id: "valid-id" });
  assert.equal(lookups, 1);
  assert.deepEqual(replies, [{
    type: "fs_tree", id: "valid-id", root: "", entries: [], git: false, error: "no session attached",
  }]);
});
