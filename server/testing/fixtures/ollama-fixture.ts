import http from "node:http";
import type { AddressInfo } from "node:net";

/** A stub Ollama for discovery tests (N.3/N.5): serves `/api/tags` — the
 *  fingerprint the probe keys on — while `up`, 404s everything else. `setUp`
 *  flips it live, simulating the user starting/stopping their local server
 *  between refreshes. */
export type OllamaFixture = {
  origin: string;
  setUp(up: boolean): void;
  close(): void;
};

export function startOllamaFixture(models: string[]): Promise<OllamaFixture> {
  let up = true;
  const server = http.createServer((req, res) => {
    if (!up || req.url !== "/api/tags") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        setUp: (v) => (up = v),
        close: () => server.close(),
      });
    });
  });
}
