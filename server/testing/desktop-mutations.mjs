// Run after build: node server/testing/desktop-mutations.mjs
// Faults affect temporary built entries only; reviewed source stays untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const mutations = [
  {
    name: "stdin-closure", source: "server/desktop-credential.ts",
    before: "closeSync(0);", after: "void 0;",
    file: "server/desktop-children.itest.ts", test: "DA.3: gemini-cli",
    proof: "daemon-after-private-read kept the private descriptor",
  },
  {
    name: "daemon-only-environment", source: "server/adapters/types.ts",
    before: "!DAEMON_ONLY_ENV.has(e[0])", after: "true",
    file: "server/desktop-children.itest.ts", test: "DA.3: gemini-cli",
    proof: "inherited the ambient license",
  },
  {
    name: "log-redaction", source: "server/log.ts",
    before: '      .replace(/mf_[a-z2-7]{20,}/g, "[redacted-key]")', after: "",
    file: "server/desktop-boundary.itest.ts", test: "DA.3: the real diagnostic sink",
    proof: "credential reached these surfaces",
  },
  {
    // Remove the complete omission by publishing the marker on a real
    // remote hello, including connections whose options omit local identity.
    name: "remote-host-omission", source: "server/sessions/connection.ts",
    before: '...(host === "desktop" && !remote ? { host } : {}),',
    after: '...(host === "desktop" || remote ? { host: "desktop" as const } : {}),',
    file: "server/desktop-boundary.itest.ts", test: "DA.3: the private key buys",
    proof: "remote hello carried host",
  },
  {
    name: "billing-reflection", source: "server/relay/entitlement.ts",
    before: 'licenseKey ? text.split(licenseKey).join(mask(licenseKey)) : text;', after: "text;",
    file: "server/desktop-boundary.itest.ts", test: "DA.3: a billing refusal",
    proof: "credential reached these surfaces",
  },
];

for (const mutation of mutations) {
  const entry = path.join(root, "dist-server", `desktop-mutant-${process.pid}-${mutation.name}.mjs`);
  try {
    let changed = false;
    await build({
      absWorkingDir: root, entryPoints: ["server/index.ts"], outfile: entry,
      bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
      plugins: [{ name: mutation.name, setup(build) {
        build.onLoad({ filter: /\.ts$/ }, (args) => {
          if (args.path !== path.join(root, mutation.source)) return;
          const original = fs.readFileSync(args.path, "utf8");
          assert.equal(original.split(mutation.before).length, 2, `${mutation.name}: mutation target must occur once`);
          changed = true;
          return { contents: original.replace(mutation.before, mutation.after), loader: "ts" };
        });
      } }],
    });
    assert.ok(changed, `${mutation.name}: source was not loaded`);
    const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", `--test-name-pattern=${mutation.test}`, mutation.file], {
      cwd: root,
      env: { ...process.env, MIRAFOLD_LOG_FILE: "", MIRAFOLD_TEST_DAEMON_ENTRY: entry },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.notEqual(status, 0, `${mutation.name}: regression survived`);
    assert.ok(output.includes(mutation.proof), `${mutation.name}: failed for an unintended reason:\n${output}`);
    process.stdout.write(`${mutation.name}: caught by the intended regression\n`);
  } finally {
    fs.rmSync(entry, { force: true });
  }
}
