// The packaged-artifact pass — drive the GLOBALLY INSTALLED mirafold through
// the surfaces a dev checkout never exercises.
//
//   npm pack && npm i -g ./mirafold-*.tgz
//   node scripts/packaged-pass.mjs
//
// Why it exists: on 2026-07-30 two launch blockers were found in one day, both
// only visible from an install — the SPA fallback 404'ing under a dot-path
// global prefix (nvm/asdf/volta), and the Gemini adapter's folder gate. Three
// verification tiers could see neither, structurally: the repo checkout has no
// dot-segment, `yarn dev` serves the front end from Vite so the daemon's own
// routes never run, and the cold-install check only read `--version`.
//
// Deliberately NOT part of `yarn test:e2e`: it drives a global install, which
// CI does not have and which no repo state can guarantee. It is a pre-release
// ritual, run by a human against the artifact about to ship.
//
// It forces the mock engine and turns discovery off, so it costs nothing and
// reaches no model — the same posture the suites take.
import { chromium } from "playwright-core";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = execSync("npm root -g").toString().trim() + "/mirafold";
const PORT = 3467;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

// A realistic workspace: a git repo with files, like any project someone opens.
const ws = mkdtempSync(path.join(os.tmpdir(), "mirafold-packaged-"));
mkdirSync(path.join(ws, "src"), { recursive: true });
writeFileSync(path.join(ws, "README.md"), "# packaged pass\n\nhello\n");
writeFileSync(path.join(ws, "src", "app.ts"), "export const x = 1;\n");
execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=t commit -qm init", { cwd: ws });

const daemon = spawn(process.execPath, [path.join(PKG, "dist-server", "index.js")], {
  cwd: ws,
  // Same scrub the suites use: no test — and no pre-release pass — may reach
  // a metered engine. The empty config dirs matter because a dev box IS
  // logged into claude/codex, which would otherwise pick a real agent (and
  // for claude, a BLOCKED row that never starts a session). Relay off and
  // license cleared so this stays local; MIRAFOLD_RELAY_URL="" now means
  // "the hosted default" since the R.2 bake, hence "off".
  env: {
    ...process.env,
    MIRAFOLD_TOKEN: "",
    PORT: String(PORT),
    MIRAFOLD_RELAY_URL: "off",
    MIRAFOLD_LICENSE_KEY: "",
    MIRAFOLD_ENTITLEMENT_TOKEN: "",
    MIRAFOLD_APP_URL: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    CLAUDE_CONFIG_DIR: path.join(ws, ".no-claude"),
    CODEX_HOME: path.join(ws, ".no-codex"),
    // Off, or onboarding gains a second step (the N backend picker) on any
    // machine that happens to be running Ollama — which is not what this pass
    // is measuring, and would make it pass or fail by accident.
    MIRAFOLD_LOCAL_DISCOVERY: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let boot = "";
daemon.stdout.on("data", (d) => (boot += d));
daemon.stderr.on("data", (d) => (boot += d));

const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

try {
  // 1. The shell loads from the packaged dist/ (not a dev server).
  await page.goto(`${base}/`, { waitUntil: "load" });
  await page.waitForSelector(".onb-agent", { timeout: 20_000 });
  check("onboarding renders from the packaged bundle", true);

  // 2. A session starts and its URL is directly loadable — the dot-path bug.
  await page.locator(".onb-agent").first().click();
  await page.waitForURL(/\/s\/[\w-]+/, { timeout: 20_000 });
  const sessionUrl = page.url();
  await page.waitForSelector("textarea", { timeout: 20_000 });
  check("session created", true, new URL(sessionUrl).pathname);
  const direct = await page.goto(sessionUrl, { waitUntil: "load" });
  check("session URL survives a hard reload", direct.status() === 200, `HTTP ${direct.status()}`);
  await page.waitForSelector("textarea", { timeout: 20_000 });

  // 3. A turn runs and the agent paints registry components.
  await page.locator("textarea").click();
  await page.keyboard.type("plan it step by step");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".turn-render", { timeout: 40_000 });
  const rendered = await page.locator(".turn-render").count();
  check("generative UI paints from the packaged registry", rendered > 0, `${rendered} blocks`);

  // 4. Pin dock — state that outlives the turn.
  const block = page.locator(".turn-render").first();
  await block.hover();
  await block.locator(".pin-btn").click();
  await page.waitForSelector(".pin-dock, .pin-stub", { timeout: 10_000 });
  check("pin dock works", true);

  // 5. The `!` passthrough — a real PTY out of the packaged daemon.
  await page.locator("textarea").click();
  await page.keyboard.type("!echo packaged-pass-marker");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".bang-output", { timeout: 20_000 });
  const bangText = await page.locator(".bang-output").last().innerText();
  check("! passthrough runs a real PTY", bangText.includes("packaged-pass-marker"), bangText.trim().slice(0, 40));

  // 6. Explorer — the daemon's own fs surface against a real repo.
  await page.locator(".ab-files").click();
  await page.waitForSelector(".files-panel .files-row", { timeout: 20_000 });
  await page.locator(".files-file-row").first().click();
  await page.waitForSelector(".files-view .fv-content", { timeout: 20_000 });
  check("Explorer lists and opens a file", true);

  // 7. The render MCP server ships and starts — the generative-UI path for
  //    REAL agents, which the mock never exercises.
  const mcp = spawn(process.execPath, [path.join(PKG, "dist-server", "render-mcp.js")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let mcpOut = "";
  mcp.stdout.on("data", (d) => (mcpOut += d));
  mcp.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pass", version: "0" } },
    }) + "\n",
  );
  await sleep(2500);
  mcp.kill();
  check("render MCP server starts from the package", mcpOut.includes('"result"'), mcpOut.slice(0, 60).replace(/\s+/g, " "));

  check("no uncaught front-end errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} catch (err) {
  check("run completed without throwing", false, String(err).split("\n")[0]);
} finally {
  await browser.close();
  daemon.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("boot log tail:\n" + boot.split("\n").slice(-12).join("\n"));
  process.exit(failed.length ? 1 : 0);
}
