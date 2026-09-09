import { test } from "node:test";
import assert from "node:assert/strict";
import { badClientId } from "./client-id";

const cases: [string, unknown, boolean][] = [
  ["letters", "aAzZ", false],
  ["digits", "0123456789", false],
  ["underscore and hyphen", "_-", false],
  ["mixed characters", "request_42-Z", false],
  ["one character", "a", false],
  ["64 characters", "aB_9-xyz".repeat(8), false],
  ["empty", "", true],
  ["65 characters", "a".repeat(65), true],
  ["undefined", undefined, true],
  ["null", null, true],
  ["number", 123, true],
  ["boolean", true, true],
  ["array", ["valid"], true],
  ["object", {}, true],
  ["boxed string", new String("valid"), true],
  ["string-coercible object", { toString: () => "valid" }, true],
  ["leading space", " valid", true],
  ["trailing space", "valid ", true],
  ["internal space", "not valid", true],
  ["tab", "valid\t", true],
  ["trailing newline", "valid\n", true],
  ["internal newline", "not\nvalid", true],
  ["carriage return", "valid\r", true],
  ["dot", "request.1", true],
  ["slash", "request/1", true],
  ["backslash", "request\\1", true],
  ["non-ASCII letter", "café", true],
  ["non-ASCII digit", "١", true],
  ["emoji", "request🙂", true],
];

for (const [name, id, invalid] of cases) {
  test(`client ID: ${name}`, () => {
    assert.equal(badClientId(id), invalid);
  });
}
