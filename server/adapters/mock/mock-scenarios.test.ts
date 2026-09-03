import { test } from "node:test";
import assert from "node:assert/strict";
import { MockSession } from "./mock";

// The mock's scenarios are matched in order, so a phrase can be swallowed by
// an earlier, broader pattern ("delegate slowly" by "delegate"). Every
// canonical prompt must route to its OWN scenario — this is the guard a
// browser test relies on when it sends MockSession.prompts[id].
test("every canonical mock prompt routes to exactly its own scenario", () => {
  for (const [id, prompt] of Object.entries(MockSession.prompts)) {
    assert.equal(MockSession.scenarioFor(prompt), id, `prompt ${JSON.stringify(prompt)}`);
  }
});

test("a prompt matching no scenario draws from the template deck", () => {
  for (const prose of ["tell me about this project", "summarize the repo", "give me a quick overview"]) {
    assert.equal(MockSession.scenarioFor(prose), undefined, prose);
  }
});
