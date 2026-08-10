import { test } from "node:test";
import assert from "node:assert/strict";

import type { PromptOption } from "@protocol";
import {
  insertPromptOption,
  matchingPromptOptions,
  promptCompletionMatch,
} from "./prompt-completions";

const OPTIONS: PromptOption[] = [
  { trigger: "/", value: "/model", label: "model", kind: "command" },
  { trigger: "/", value: "/status", label: "status", kind: "command" },
  { trigger: "$", value: "$next", label: "next", kind: "skill" },
  { trigger: "$", value: "$audit", label: "audit", kind: "skill" },
];

test("a lone provider trigger matches immediately, before submit", () => {
  assert.deepEqual(promptCompletionMatch("/", 1, OPTIONS), {
    trigger: "/",
    query: "",
    start: 0,
    end: 1,
  });
  assert.deepEqual(promptCompletionMatch("$", 1, OPTIONS), {
    trigger: "$",
    query: "",
    start: 0,
    end: 1,
  });
});

test("slash commands are prompt prefixes; Codex skills may be token completions", () => {
  assert.equal(promptCompletionMatch("explain /mo", 11, OPTIONS), null);
  assert.deepEqual(promptCompletionMatch("please $ne", 10, OPTIONS), {
    trigger: "$",
    query: "ne",
    start: 7,
    end: 10,
  });
  assert.deepEqual(
    matchingPromptOptions(OPTIONS, promptCompletionMatch("/st", 3, OPTIONS)).map((o) => o.value),
    ["/status"],
  );
});

test("completion replaces the whole edited token and leaves the caret ready for arguments", () => {
  const match = promptCompletionMatch("please $nezzz later", 10, OPTIONS)!;
  assert.deepEqual(insertPromptOption("please $nezzz later", match, OPTIONS[2]), {
    text: "please $next later",
    cursor: 13,
  });
});
