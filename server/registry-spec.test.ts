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
