import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "./itest-harness";
import { startRelayStub, type RelayStub } from "./relay-stub";

// R.1's "Done when", literally: a second BROWSER attaches through the local
// relay stub and mirrors a live mock session — replay, streaming, and the
// pairing-code handoff across in-app navigation all through the dial-out
// path. The stub serves ./dist, so the remote page loads the app from the
// relay origin exactly as a phone would in R.2. R.3 rides underneath: the
// page gets the code as a URL FRAGMENT (never sent to the relay), the shell
// scrubs it from the address bar, and the stub's tap proves everything the
// relay forwarded was ciphertext.

const CODE = "e2e-pairing-code-77adf1";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";

let stub: RelayStub;
let d: Daemon;
let browser: Browser;
let local: Page;
let remote: Page;
const tapped: string[] = [];

before(async () => {
  stub = await startRelayStub({ tap: { frame: (_dir, p) => tapped.push(p) } });
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
  // The pairing code arrives once, as a FRAGMENT (it never reaches the relay);
  // the shell scrubs it from the bar and keeps it per-tab, so the fleet row's
  // full navigation — which drops the fragment — still stays paired.
  await remote.goto(`http://127.0.0.1:${stub.port}/#code=${CODE}`);
  await remote.locator(".fleet-row").first().click();
  await remote.waitForURL(/\/s\/[\w-]+/);
  assert.ok(!remote.url().includes(CODE), "pairing code scrubbed from the address bar");
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

  // R.3: everything the relay shuttled for that mirrored session was
  // ciphertext — base64url only, no JSON, no prompt text, no code.
  assert.ok(tapped.length > 50, `expected real traffic through the tap, saw ${tapped.length}`);
  for (const p of tapped) {
    assert.ok(/^[A-Za-z0-9_-]+$/.test(p), `relay saw a non-ciphertext frame: ${p.slice(0, 80)}`);
    assert.ok(!p.includes("hello from the far side"), "relay saw plaintext prompt text");
  }
});
