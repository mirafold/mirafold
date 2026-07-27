import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { clientSchemas, registrySchemas, registryShapes, type ComponentName } from "./registry-spec";
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

test("client twin: tomorrow's optional prop strips instead of failing (R.4h)", () => {
  // The compat contract itself: yesterday's TOLERANT schema accepts a payload
  // carrying a prop that doesn't exist yet, drops the unknown key, and keeps
  // the rest — while the strict source schema still rejects it at authoring.
  const tomorrow = { title: "t", body: "b", accent: "teal" };
  assert.equal(registrySchemas.card.safeParse(tomorrow).success, false);
  const parsed = clientSchemas.card.safeParse(tomorrow);
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data, { title: "t", body: "b" }); // stripped, kept, rendered
  // Malformed props still fail the tolerant twin — tolerance is about unknown
  // keys only, never about accepting a broken payload.
  assert.equal(clientSchemas.card.safeParse({ title: "t" }).success, false);
});

test("every schema rejects wrong-shaped payloads, not just card", () => {
  const bad: [ComponentName, object][] = [
    ["list", { items: [] }], // min(1)
    ["table", { columns: [], rows: [] }], // min(1) columns
    ["table", { columns: ["a"], rows: [[true]] }], // cells are string|number
    ["chart", { kind: "donut", x: ["a"], series: [{ name: "s", values: [1] }] }], // enum
    ["chart", { kind: "line", x: ["a"], series: [] }], // min(1) series
    ["chart", { kind: "bar", x: ["a"], series: [{ name: "s", values: [1] }], stacked: "yes" }], // bool
    ["todo-list", { todos: [{ content: "x", status: "bogus" }] }], // status enum
    ["card", { title: "t", body: "b", kind: "loud" }], // kind enum
    ["key-value", { pairs: [] }], // min(1)
    ["progress", { label: "x", percent: 101 }], // 0–100
    ["progress", { label: "x", percent: -1 }], // 0–100
    ["timeline", { items: [] }], // min(1)
    ["file-tree", { paths: [] }], // min(1)
    ["question", { question: "q?", options: [{ label: "only one" }] }], // min(2)
    [
      "question",
      { question: "q?", options: Array(7).fill({ label: "x" }) },
    ], // max(6)
    ["diff", { files: [] }], // min(1)
    ["diff", { files: [{ path: "a.ts", before: "x" }] }], // after required
    ["stat", { label: "Coverage" }], // value required
    ["stat", { value: "98%" }], // label required
    [
      "stat",
      { label: "p95", value: "212 ms", delta: { value: "+3", direction: "sideways", good: true } },
    ], // direction enum
    ["stat", { label: "p95", value: "212 ms", delta: { value: "+3", direction: "up" } }], // good required
    ["code", { lang: "ts" }], // code required
    ["code", { code: "x", highlight: [{ start: 0 }] }], // 1-based
    ["code", { code: "x", highlight: [{ start: 1.5 }] }], // int lines
    ["code", { code: "x", highlight: [{ end: 3 }] }], // start required
    ["status-list", { items: [] }], // min(1)
    ["status-list", { items: [{ label: "unit", status: "ok" }] }], // status enum
    ["console", { command: "yarn test" }], // output required
    ["console", { output: "ok", exitCode: 1.5 }], // int exit code
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
    ["chart", { kind: "pie", x: ["a", "b"], series: [{ name: "s", values: [3, 1] }] }], // S.1
    [
      "chart",
      {
        kind: "bar",
        x: ["a"],
        series: [
          { name: "s", values: [1] },
          { name: "t", values: [2] },
        ],
        stacked: true,
        horizontal: true,
      },
    ], // S.2 — the flags compose
    ["todo-list", { todos: [{ content: "x", status: "pending" }] }],
    ["card", { title: "t", body: "b", kind: "success" }],
    ["key-value", { pairs: [{ key: "k", value: "v" }] }],
    ["progress", { label: "x", percent: 40 }],
    ["timeline", { items: [{ label: "x", time: "09:00" }] }],
    ["file-tree", { paths: [{ path: "src/a.ts", note: "new" }] }],
    [
      "question",
      {
        question: "Canary or fleet?",
        options: [
          { label: "Canary", text: "Do a canary rollout.", detail: "slower, safer" },
          { label: "Fleet" },
        ],
      },
    ],
    [
      "question",
      { question: "q?", options: Array(6).fill({ label: "x" }) },
    ], // max(6) boundary

    [
      "diff",
      {
        title: "Fix",
        files: [
          { path: "a.ts", before: "old line", after: "new line" },
          { path: "b.ts", before: "", after: "added file", note: "new file" },
        ],
      },
    ],
    ["stat", { label: "p95", value: "212 ms" }], // delta/footer optional
    [
      "stat",
      {
        label: "Coverage",
        value: "98%",
        delta: { value: "+2.1%", direction: "up", good: true },
        footer: "vs last run",
      },
    ],
    ["code", { code: "const a = 1;" }], // everything else optional
    [
      "code",
      {
        code: "const a = 1;\nconst b = 2;",
        lang: "ts",
        filename: "src/a.ts",
        highlight: [{ start: 1 }, { start: 2, end: 2 }],
      },
    ],
    [
      "status-list",
      {
        title: "CI",
        items: [
          { label: "unit", status: "pass", detail: "394 tests" },
          { label: "e2e", status: "pending" },
        ],
      },
    ],
    ["console", { output: "plain tail" }], // header/exit optional
    ["console", { command: "yarn test", output: "[31mFAIL[0m", exitCode: 1 }],
  ];
  for (const [component, props] of good) {
    assert.equal(
      registrySchemas[component].safeParse(props).success,
      true,
      `${component} should accept ${JSON.stringify(props)}`,
    );
  }
});

test("old-client simulation: yesterday's chart schema strips S.2 flags to a plain bar (R.4h)", () => {
  // Rebuild "yesterday's" tolerant chart twin — today's shape minus the S.2
  // props — and feed it today's payload. The flags must strip silently
  // (grouped/vertical bar), never reject into the fallback.
  const { stacked, horizontal, ...yesterdayShape } = registryShapes.chart;
  void stacked;
  void horizontal;
  const yesterday = z.object(yesterdayShape);
  const today = {
    kind: "bar",
    x: ["a"],
    series: [
      { name: "s", values: [1] },
      { name: "t", values: [2] },
    ],
    stacked: true,
    horizontal: true,
  };
  const parsed = yesterday.safeParse(today);
  assert.ok(parsed.success);
  assert.ok(!("stacked" in parsed.data) && !("horizontal" in parsed.data));
  // kind "pie" on that same old client fails the enum parse whole — the
  // designed degradation is the legible raw-props fallback, not a wrong chart.
  assert.equal(
    yesterday.safeParse({ kind: "pie", x: ["a"], series: [{ name: "s", values: [1] }] })
      .success,
    true, // NB: yesterdayShape still has TODAY'S kind enum — pie passes here…
  );
  const { kind, ...rest } = yesterdayShape;
  void kind;
  const yesterdayEnum = z.object({ ...rest, kind: z.enum(["line", "bar"]) });
  assert.equal(
    yesterdayEnum.safeParse({ kind: "pie", x: ["a"], series: [{ name: "s", values: [1] }] })
      .success,
    false, // …the true old enum rejects it into the fallback.
  );
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
