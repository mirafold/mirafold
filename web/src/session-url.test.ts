import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionIdFromPath, sessionPath } from "./session-url";

test("a session path names its id; anything else is mission control", () => {
  assert.equal(sessionIdFromPath("/s/abc-123"), "abc-123");
  assert.equal(sessionIdFromPath("/s/abc-123/extra"), "abc-123");
  assert.equal(sessionIdFromPath("/"), null);
  assert.equal(sessionIdFromPath("/s/"), null);
  assert.equal(sessionIdFromPath("/sessions/abc"), null);
});

test("sessionPath round-trips through sessionIdFromPath", () => {
  assert.equal(sessionIdFromPath(sessionPath("x_y-9")), "x_y-9");
});
