import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { startRelayStub, type RelayStub } from "./relay-stub";

// R.1's "Done when", literally: a second BROWSER attaches through the local
// relay stub and mirrors a live mock session — replay, streaming, and the
// pairing-code handoff across in-app navigation all through the dial-out
// path. The stub serves ./dist, so the remote page loads the app from the
// relay origin exactly as a phone would in R.2.

const CODE = "e2e-pairing-code-77adf1";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

let stub: RelayStub;
let d: Daemon;
let browser: Browser;
let local: Page;
let remote: Page;

before(async () => {
  stub = await startRelayStub();
  d = await startDaemon({ GENUI_TOKEN: "", GENUI_RELAY_URL: stub.url, GENUI_RELAY_CODE: CODE });
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  await browser?.close();
  await d?.stop();
  await stub?.stop();
});

test("local page: create a session and run a deterministic mock turn", async () => {
  local = await browser.newPage();
  await local.goto(`http://127.0.0.1:${d.port}/`);
  await local.locator(".onb-agent", { hasText: "Claude Code" }).click();
  await local.waitForURL(/\/s\/[\w-]+/);
  await local.locator("textarea").click();
  await local.keyboard.type("plan it step by step");
  await local.keyboard.press("Enter");
  await local.waitForSelector("text=Plan complete — all four steps done.", { timeout: 30_000 });
});

test("a second browser attaches THROUGH the stub and replays the transcript", async () => {
  remote = await browser.newPage();
  // The pairing code arrives once on the URL; the fleet row link is a full
  // navigation that drops the query — sessionStorage must carry it across.
  await remote.goto(`http://127.0.0.1:${stub.port}/?code=${CODE}`);
  await remote.locator(".fleet-row").first().click();
  await remote.waitForURL(/\/s\/[\w-]+/);
  await remote.waitForSelector("text=Plan complete — all four steps done.", {
    timeout: 15_000,
  });
});

test("typing in the remote browser drives the session; both transcripts mirror", async () => {
  await remote.locator("textarea").click();
  await remote.keyboard.type("hello from the far side of the relay");
  await remote.keyboard.press("Enter");

  // The strip echoes into BOTH viewports (broadcast, not local echo)…
  await remote.waitForSelector("text=hello from the far side of the relay", { timeout: 15_000 });
  await local.waitForSelector("text=hello from the far side of the relay", { timeout: 15_000 });

  // …and once the turn settles, the two output zones are character-identical:
  // both render nothing but the same broadcast WireMsg stream.
  const zone = (p: Page) => p.locator(".render-zone").innerText();
  const deadline = Date.now() + 30_000;
  let prev = "";
  let a = "";
  let b = "";
  // Settled = both zones equal AND unchanged since the last sample (the mock
  // streams for a few seconds; equality mid-stream would be a lucky race).
  do {
    await new Promise((r) => setTimeout(r, 500));
    prev = a;
    [a, b] = await Promise.all([zone(local), zone(remote)]);
  } while (
    Date.now() < deadline &&
    !(a === b && a === prev && a.includes("hello from the far side of the relay"))
  );
  assert.ok(a.includes("hello from the far side of the relay"), "turn is in the transcript");
  assert.equal(b, a, "remote and local transcripts are identical");
});
