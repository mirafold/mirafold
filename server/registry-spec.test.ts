import { test } from "node:test";
import assert from "node:assert/strict";
import { clientSchemas, registrySchemas, type ComponentName } from "./registry-spec";
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
    ["diagram", { title: "x" }], // source required
    ["image", { path: "shot.png" }], // alt required
    ["image", { path: "shot.png", alt: "x", src: "https://evil.example/a.png" }], // data: only
    ["image", { path: "shot.png", alt: "x", src: "data:text/html;base64,AAAA" }], // raster MIME only
    ["image", { path: "shot.png", alt: "x", src: "data:image/svg+xml;base64,AAAA" }], // no svg
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
    ["diagram", { source: "flowchart TD\n  A[Client] --> B[Server]" }],
    ["image", { path: "shots/app.png", alt: "the app after the fix" }], // authoring shape
    [
      "image",
      { path: "a.png", alt: "x", caption: "c", src: "data:image/webp;base64,AAAA" },
    ], // wire shape
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

test("chart forward-compat: the tolerant twin strips an unknown prop, the strict source rejects it (R.4h)", () => {
  // The same compat contract the card test above pins, on the REAL chart twins
  // (2026-08-11 test-audit: this used to hand-build a `z.object(shape)` and a
  // `z.enum(["line","bar"])` and assert on THOSE — testing zod, not the product;
  // a mutation to registrySchemas/clientSchemas.chart could not fail it).
  const valid = {
    kind: "bar" as const,
    x: ["a"],
    series: [
      { name: "s", values: [1] },
      { name: "t", values: [2] },
    ],
  };
  // A future optional prop the client doesn't know yet: strict authoring schema
  // rejects it; the tolerant twin the browser actually validates with strips it
  // and keeps the rest, so a newer daemon's chart still renders on an old client.
  const withFuture = { ...valid, futuristicFlag: true };
  assert.equal(registrySchemas.chart.safeParse(withFuture).success, false);
  const tolerant = clientSchemas.chart.safeParse(withFuture);
  assert.ok(tolerant.success);
  assert.ok(!("futuristicFlag" in tolerant.data));
  assert.deepEqual(tolerant.data.series, valid.series);
  // Today's real S.2 flags are accepted (not stripped) by both twins.
  assert.equal(registrySchemas.chart.safeParse({ ...valid, stacked: true, horizontal: true }).success, true);
  // Tolerance is about UNKNOWN KEYS only: an unknown chart KIND is a broken
  // payload, and even the tolerant twin rejects it — the designed degradation
  // is the legible raw-props fallback, not a wrong chart.
  assert.equal(clientSchemas.chart.safeParse({ ...valid, kind: "donut" }).success, false);
  assert.equal(registrySchemas.chart.safeParse({ ...valid, kind: "donut" }).success, false);
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
