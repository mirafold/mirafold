import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Browser, type Page } from "playwright-core";
import { startDaemon, type Daemon } from "../testing/itest-harness";
import { launchChrome } from "../testing/e2e/e2e-harness";
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

let stub: RelayStub;
let d: Daemon;
let browser: Browser;
let local: Page;
let remote: Page;
const tapped: string[] = [];

before(async () => {
  stub = await startRelayStub({ tap: { frame: (_dir, p) => tapped.push(p) } });
  d = await startDaemon({ MIRAFOLD_TOKEN: "", MIRAFOLD_RELAY_URL: stub.url, MIRAFOLD_RELAY_CODE: CODE });
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
  await d?.stop();
  await stub?.stop();
});

test("local page: create a session and run a deterministic mock turn", async () => {
  local = await browser.newPage();
  await local.goto(`http://127.0.0.1:${d.port}/`);
  await local.locator(".agent-picker-agent", { hasText: "Claude Code" }).click();
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
  const tappedBefore = tapped.length;
  await remote.locator("textarea").click();
  await remote.keyboard.type("hello from the far side of the relay");
  await remote.keyboard.press("Enter");

  // The strip echoes into BOTH viewports (broadcast, not local echo)…
  await remote.waitForSelector("text=hello from the far side of the relay", { timeout: 15_000 });
  await local.waitForSelector("text=hello from the far side of the relay", { timeout: 15_000 });

  // Wait for the turn to actually FINISH on both viewports, THEN compare — the
  // mock ends every turn with turn_end, which clears busy and removes the stop
  // button. (Was: poll until both zones were equal AND unchanged across one
  // 500ms sample. Under CPU load a mid-stream pause longer than 500ms faked
  // that stability, so the loop exited early with only a partial turn's frames
  // through the tap — the "saw 40" flake, reproduced 2/20 under saturation
  // 2026-07-19. The streaming mirror itself was never wrong; keying on turn
  // completion is deterministic.)
  const zone = (p: Page) => p.locator(".output-zone").innerText();
  await remote.waitForSelector(".stop-btn", { timeout: 15_000 }); // the turn is running…
  await Promise.all([
    remote.waitForSelector(".stop-btn", { state: "detached", timeout: 30_000 }),
    local.waitForSelector(".stop-btn", { state: "detached", timeout: 30_000 }),
  ]); // …and has ended on both viewports (turn_end → busy clears)
  const [a, b] = await Promise.all([zone(local), zone(remote)]);
  assert.ok(a.includes("hello from the far side of the relay"), "turn is in the transcript");
  assert.equal(b, a, "remote and local transcripts are identical");

  // Everything the relay shuttled for that mirrored session was
  // ciphertext — base64url only, no JSON, no prompt text, no code (R.3).
  // The count guard only proves the tap saw THIS turn (a vacuous loop over
  // zero frames would pass). A total-frame threshold is load-sensitive:
  // DELTA_COALESCE_MS merges more deltas the slower the machine, so a tally
  // drifts with CPU load — the "saw 40" flake above resurfaced as "saw 50"
  // 2026-07-27, sampled 0/6 passing in isolation. What coalescing can NEVER
  // remove: the prompt itself crossing c2d, and the turn_end that detached
  // the stop buttons crossing d2c. Growth of ≥2 during the turn is exact.
  assert.ok(
    tapped.length >= tappedBefore + 2,
    `expected this turn's traffic through the tap: prompt up + turn_end down (saw ${tapped.length - tappedBefore} new frames over ${tappedBefore})`,
  );
  for (const p of tapped) {
    assert.ok(/^[A-Za-z0-9_-]+$/.test(p), `relay saw a non-ciphertext frame: ${p.slice(0, 80)}`);
    assert.ok(!p.includes("hello from the far side"), "relay saw plaintext prompt text");
  }
});

test("a dead daemon's WHY is visible beside the status dot, not tooltip-only", async () => {
  // The laptop's daemon dies (sleep, crash, quit): the relay tears the pair
  // down and closes every viewport 4003. That reason used to live only in
  // the dot's `title` — a hover tooltip no touch device can reveal, on the
  // path built for phones. It must render as visible text (2026-07-28,
  // Kyle's call: a line beside the dot when down-with-reason).
  const gone = d.stop();
  // after() must not stop it again — the harness stop() waits on an exit
  // event a dead child will never re-emit.
  d = undefined as unknown as Daemon;
  await gone;
  const note = remote.locator(".sb-conn-note");
  await note.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await note.innerText(), "Desktop not reachable — is Mirafold running there?");
});
