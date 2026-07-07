import { test } from "node:test";
import assert from "node:assert/strict";
import { registrySchemas, type ComponentName } from "./registry-spec";
import { MOCK_RENDERS } from "./adapters/mock";

test("every MOCK_RENDERS payload satisfies its component schema", () => {
  for (const make of MOCK_RENDERS) {
    const { component, props } = make();
    const schema = registrySchemas[component as ComponentName];
    assert.ok(schema, `no schema for component "${component}"`);
    const r = schema.safeParse(props);
    assert.ok(
      r.success,
      `${component} props invalid: ${r.success ? "" : JSON.stringify(r.error.issues)}`,
    );
  }
});

test("card schema requires body and rejects unknown keys (strict)", () => {
  assert.equal(registrySchemas.card.safeParse({ title: "t", body: "b" }).success, true);
  assert.equal(registrySchemas.card.safeParse({ title: "t" }).success, false);
  assert.equal(registrySchemas.card.safeParse({ title: "t", body: "b", nope: 1 }).success, false);
});

test("every schema rejects wrong-shaped payloads, not just card", () => {
  const bad: [ComponentName, object][] = [
    ["list", { items: [] }], // min(1)
    ["table", { columns: [], rows: [] }], // min(1) columns
    ["table", { columns: ["a"], rows: [[true]] }], // cells are string|number
    ["chart", { kind: "pie", x: ["a"], series: [{ name: "s", values: [1] }] }], // enum
    ["chart", { kind: "line", x: ["a"], series: [] }], // min(1) series
    ["todo-list", { todos: [{ content: "x", status: "bogus" }] }], // status enum
  ];
  for (const [component, props] of bad) {
    assert.equal(
      registrySchemas[component].safeParse(props).success,
      false,
      `${component} should reject ${JSON.stringify(props)}`,
    );
  }
  const good: [ComponentName, object][] = [
    ["list", { items: [{ text: "x" }] }],
    ["table", { columns: ["a"], rows: [["x", 1]] }],
    ["chart", { kind: "line", x: ["a"], series: [{ name: "s", values: [1] }] }],
    ["todo-list", { todos: [{ content: "x", status: "pending" }] }],
  ];
  for (const [component, props] of good) {
    assert.equal(
      registrySchemas[component].safeParse(props).success,
      true,
      `${component} should accept ${JSON.stringify(props)}`,
    );
  }
});

test("card actions: the agent may author prompt|tool only, max 3 buttons", () => {
  const card = (actions: unknown) =>
    registrySchemas.card.safeParse({ title: "t", body: "b", actions }).success;
  const prompt = { label: "go", action: { kind: "prompt", text: "drill in" } };
  assert.equal(card([prompt]), true);
  assert.equal(card([{ label: "go", action: { kind: "tool", name: "workspace_ls" } }]), true);
  // "state" actions are shell-internal — never agent-authorable.
  assert.equal(card([{ label: "go", action: { kind: "state" } }]), false);
  assert.equal(card(Array(4).fill(prompt)), false);
});

test("link-group rejects non-http(s) hrefs", () => {
  assert.equal(
    registrySchemas["link-group"].safeParse({ links: [{ label: "x", href: "javascript:alert(1)" }] })
      .success,
    false,
  );
  assert.equal(
    registrySchemas["link-group"].safeParse({ links: [{ label: "x", href: "https://example.com" }] })
      .success,
    true,
  );
});
