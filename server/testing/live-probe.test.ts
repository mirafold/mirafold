import { test } from "node:test";
import assert from "node:assert/strict";
import { ollamaConfiguredContext } from "./live-probe";

test("ollamaConfiguredContext accepts only an explicit positive num_ctx parameter", () => {
  assert.equal(
    ollamaConfiguredContext(
      'temperature                    0.6\nnum_ctx                        32768\ntop_p                          0.95',
    ),
    32_768,
  );
  assert.equal(ollamaConfiguredContext("temperature 0.6\ntop_p 0.95"), undefined);
  assert.equal(ollamaConfiguredContext("num_ctx 0"), undefined);
  assert.equal(ollamaConfiguredContext("num_ctx 32768 trailing"), undefined);
  assert.equal(ollamaConfiguredContext({ num_ctx: 32_768 }), undefined);
});
