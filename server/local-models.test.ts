import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { hostKey, probeLocalServers, probeTargets } from "./local-models";

// N.2 — discovery against fixture HTTP servers on ephemeral ports. Nothing
// here ever touches the real well-known ports (a dev machine may have a real
// Ollama up); default-target probing is covered by pinning probeTargets()'s
// pure output instead.

type Routes = Record<string, string | (() => string)>;

/** A fixture runtime: serves the given routes, 404s everything else. */
function withServer(routes: Routes, fn: (origin: string) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const body = routes[req.url ?? ""];
      if (body === undefined) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(typeof body === "function" ? body() : body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      fn(`http://127.0.0.1:${port}`)
        .then(resolve, reject)
        .finally(() => server.close());
    });
  });
}

/** A fixture that accepts connections and never responds — the hung-socket case. */
function withHangingServer(fn: (origin: string) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(() => {
      /* never respond */
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      fn(`http://127.0.0.1:${port}`)
        .then(resolve, reject)
        .finally(() => {
          server.closeAllConnections(); // hung sockets hold the server open otherwise
          server.close();
        });
    });
  });
}

const OLLAMA_TAGS = JSON.stringify({
  models: [{ name: "llama3.2:3b" }, { name: "qwen3:8b" }],
});
const V1_MODELS = JSON.stringify({ data: [{ id: "qwen/qwen3-8b" }] });

test("N.2: an Ollama fixture (native /api/tags) → both dialects, tag-listed models", async () => {
  await withServer({ "/api/tags": OLLAMA_TAGS, "/v1/models": V1_MODELS }, async (origin) => {
    const found = await probeLocalServers([{ origin, runtime: "custom" }]);
    assert.equal(found.length, 1);
    const s = found[0];
    assert.equal(s.runtime, "ollama"); // /api/tags answering IS the fingerprint
    assert.deepEqual(s.dialects, ["anthropic", "openai"]);
    assert.deepEqual(s.models, ["llama3.2:3b", "qwen3:8b"]);
    assert.equal(s.endpoint, origin);
  });
});

test("N.2: an OpenAI-dialect-only fixture (/v1/models, no /api/tags) → openai dialect, port's runtime name", async () => {
  await withServer({ "/v1/models": V1_MODELS }, async (origin) => {
    const found = await probeLocalServers([{ origin, runtime: "lm-studio" }]);
    assert.equal(found.length, 1);
    assert.equal(found[0].runtime, "lm-studio");
    assert.deepEqual(found[0].dialects, ["openai"]);
    assert.deepEqual(found[0].models, ["qwen/qwen3-8b"]);
  });
});

test("N.2: nothing listening → empty result, no throw", async () => {
  // Grab an ephemeral port, then close it so the probe hits a dead port.
  const origin = await new Promise<string>((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
  assert.deepEqual(await probeLocalServers([{ origin, runtime: "vllm" }]), []);
});

test("2026-07-17 audit: an oversized body is refused at the cap, never parsed", async () => {
  // ~2 MB of valid JSON — a hostile local listener, not a catalog. The chunked
  // reader must abandon it at the 1 MB cap instead of buffering + parsing.
  const huge = `{"models":[{"name":"${"x".repeat(2_000_000)}"}]}`;
  await withServer({ "/api/tags": () => huge, "/v1/models": () => huge }, async (origin) => {
    assert.deepEqual(await probeLocalServers([{ origin, runtime: "custom" }]), []);
  });
});

test("N.2: malformed and empty catalogs are skipped silently", async () => {
  await withServer(
    { "/v1/models": "definitely not json", "/api/tags": JSON.stringify({ models: [] }) },
    async (origin) => {
      assert.deepEqual(await probeLocalServers([{ origin, runtime: "custom" }]), []);
    },
  );
});

test("N.2: a hung socket cannot stall the sweep past the probe budget", async () => {
  await withHangingServer(async (origin) => {
    const started = Date.now();
    const found = await probeLocalServers([{ origin, runtime: "custom" }]);
    assert.deepEqual(found, []);
    // Budget is 500ms/probe; generous headroom so slow CI never flakes this.
    assert.ok(Date.now() - started < 3000, "probe must be bounded by its timeout");
  });
});

test("N.2: probeTargets() = the four well-known ports + parsed env extras, invalid dropped", () => {
  const saved = process.env.MIRAFOLD_LOCAL_ENDPOINTS;
  try {
    process.env.MIRAFOLD_LOCAL_ENDPOINTS =
      " http://127.0.0.1:9999/some/path , not a url!! , http://127.0.0.1:11434 ";
    const targets = probeTargets();
    const origins = targets.map((t) => t.origin);
    // The four defaults present…
    for (const port of [11434, 1234, 8000, 8080])
      assert.ok(origins.includes(`http://127.0.0.1:${port}`), String(port));
    // …the valid extra normalized to its origin, tagged custom…
    const extra = targets.find((t) => t.origin === "http://127.0.0.1:9999");
    assert.equal(extra?.runtime, "custom");
    // …the garbage dropped, and the duplicate of a default deduped.
    assert.equal(origins.length, 5);
  } finally {
    if (saved === undefined) delete process.env.MIRAFOLD_LOCAL_ENDPOINTS;
    else process.env.MIRAFOLD_LOCAL_ENDPOINTS = saved;
  }
});

test("N.3: MIRAFOLD_LOCAL_DISCOVERY=off drops the well-known ports but keeps env extras", () => {
  const savedOff = process.env.MIRAFOLD_LOCAL_DISCOVERY;
  const savedExtra = process.env.MIRAFOLD_LOCAL_ENDPOINTS;
  try {
    process.env.MIRAFOLD_LOCAL_DISCOVERY = "off";
    process.env.MIRAFOLD_LOCAL_ENDPOINTS = "http://127.0.0.1:9999";
    assert.deepEqual(probeTargets(), [{ origin: "http://127.0.0.1:9999", runtime: "custom" }]);
    delete process.env.MIRAFOLD_LOCAL_ENDPOINTS;
    assert.deepEqual(probeTargets(), []);
  } finally {
    if (savedOff === undefined) delete process.env.MIRAFOLD_LOCAL_DISCOVERY;
    else process.env.MIRAFOLD_LOCAL_DISCOVERY = savedOff;
    if (savedExtra === undefined) delete process.env.MIRAFOLD_LOCAL_ENDPOINTS;
    else process.env.MIRAFOLD_LOCAL_ENDPOINTS = savedExtra;
  }
});

test("N.3: hostKey normalizes localhost to 127.0.0.1 and defaults ports; malformed → undefined", () => {
  assert.equal(hostKey("http://localhost:11434"), "127.0.0.1:11434");
  assert.equal(hostKey("http://127.0.0.1:11434"), "127.0.0.1:11434");
  assert.equal(hostKey("http://localhost"), "127.0.0.1:80");
  assert.equal(hostKey("https://example.com"), "example.com:443");
  assert.equal(hostKey("not a url"), undefined);
});
