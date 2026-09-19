import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRenderServer } from "./render-tools";
import { clientSchemas, registrySchemas } from "./registry-spec";
import { generativeUIMsg } from "./adapters/render-mcp-cmd";
import { invalidCharts, validCharts } from "./testing/fixtures/chart-cases";
import type { SessionMsg } from "./protocol";

test("chart semantics agree across in-process tools, normalized events and browser schemas", async () => {
  const emitted: SessionMsg[] = [];
  const server = makeRenderServer((msg) => emitted.push(msg), "/tmp");
  const registered = (server.instance as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
  for (const props of validCharts) {
    const additive = { ...props, futureOption: true };
    assert.equal(clientSchemas.chart.safeParse(additive).success, true);
    assert.equal(registrySchemas.chart.safeParse(props).success, true);
    assert.ok(generativeUIMsg("render_chart", additive, "chart", "/tmp"));
    const result = await registered.render_chart.handler({ ...additive, id: "chart" }, {});
    assert.ok(!result.isError);
  }
  const before = emitted.slice();
  for (const props of [...invalidCharts, { ...validCharts[0], series: [{ name: "nonfinite", values: [1, Infinity] }] }]) {
    assert.equal(clientSchemas.chart.safeParse(props).success, false);
    assert.equal(registrySchemas.chart.safeParse(props).success, false);
    assert.equal(generativeUIMsg("render_chart", props, "chart", "/tmp"), null);
    const result = await registered.render_chart.handler({ ...props, id: "chart" }, {});
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /Rendered/);
  }
  assert.deepEqual(emitted, before, "rejected updates leave the existing painting intact");
});
