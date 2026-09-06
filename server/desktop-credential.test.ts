import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  DESKTOP_CREDENTIAL_FLAG,
  DESKTOP_CREDENTIAL_MAX_BYTES,
  DESKTOP_CREDENTIAL_TIMEOUT_MS,
  readDesktopCredential,
  resolveCredentialConfig,
  type DesktopCredential,
} from "./desktop-credential";
import { createEntitlementTokenSource } from "./relay/entitlement";
import { createSubscriptionActions } from "./relay/subscription";
import { DEFAULT_RELAY_URL, presentsOnEntitlement, resolveRelayPlan } from "./relay/relay-url";

const KEY = `mf_${"a".repeat(26)}`;
const AMBIENT = `mf_${"b".repeat(26)}`;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const desktop: DesktopCredential = { kind: "desktop", key: KEY };

test("credential resolution copies only relay configuration and never mutates its inputs", () => {
  const env = Object.freeze({
    MIRAFOLD_LICENSE_KEY: ` ${AMBIENT} `,
    MIRAFOLD_ENTITLEMENT_TOKEN: " ops.token ",
    MIRAFOLD_ENTITLEMENT_URL: " https://billing.example/api/entitlement ",
    MIRAFOLD_RELAY_URL: " wss://self.example ",
    MIRAFOLD_APP_URL: " https://app.example/ ",
    UNRELATED_SECRET: "must-not-be-copied",
  });
  const { UNRELATED_SECRET: _, ...expected } = env;
  const terminal = resolveCredentialConfig(env, { kind: "terminal" });
  assert.deepEqual(terminal, expected, "even terminal whitespace is preserved for the existing consumers");
  assert.notEqual(terminal, env);
  assert.deepEqual(resolveCredentialConfig(env, Object.freeze(desktop)), {
    ...expected,
    MIRAFOLD_LICENSE_KEY: KEY,
  });
  for (const problem of ["missing-input", "invalid-key", "too-large", "timeout", "input-error"] as const) {
    assert.deepEqual(resolveCredentialConfig(env, { kind: "desktop", problem }), {
      ...expected,
      MIRAFOLD_LICENSE_KEY: undefined,
    }, "a failed private handoff never falls back to the ambient key");
  }
});

test("one resolved configuration selects the pipe key for relay, exchange, and every subscription action", async (t) => {
  const calls: { url: string; key: string }[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), key: JSON.parse(String(init?.body)).licenseKey });
    return String(url).endsWith("/entitlement")
      ? Response.json({ token: "signed.token", exp: Math.floor(Date.now() / 1000) + 3600 })
      : Response.json({ status: "active" });
  });
  t.after(() => fetchMock.mock.restore());
  const config = resolveCredentialConfig({
    MIRAFOLD_LICENSE_KEY: AMBIENT,
    MIRAFOLD_ENTITLEMENT_URL: " https://custom.example/api/entitlement ",
  }, desktop);
  assert.equal(resolveRelayPlan(config).kind, "dial");
  const source = createEntitlementTokenSource(config);
  t.after(() => source.stop());
  assert.equal(source.mode, "license-key");
  assert.equal(await source.get(), "signed.token");
  const actions = createSubscriptionActions(config)!;
  assert.deepEqual(await actions.status(), { view: { status: "active" } });
  await actions.cancel();
  await actions.uncancel();
  assert.deepEqual(calls, ["entitlement", "subscription", "subscription/cancel", "subscription/uncancel"].map(
    (route) => ({ url: `https://custom.example/api/${route}`, key: KEY }),
  ));
});

test("ops override still wins for valid and failed Desktop handoffs, without an exchange or billing actions", async (t) => {
  const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("unexpected exchange"); });
  const warn = mock.method(console, "warn", () => {});
  t.after(() => { fetchMock.mock.restore(); warn.mock.restore(); });
  for (const input of [desktop, { kind: "desktop", problem: "missing-input" }] as const) {
    const config = resolveCredentialConfig({ MIRAFOLD_ENTITLEMENT_TOKEN: " ops.token ", MIRAFOLD_LICENSE_KEY: AMBIENT }, input);
    assert.equal(resolveRelayPlan(config).kind, "dial");
    const source = createEntitlementTokenSource(config);
    assert.equal(source.mode, "token-override");
    assert.equal(await source.get(), "ops.token");
    source.stop();
    assert.equal(createSubscriptionActions(config), undefined);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("failed Desktop input disables hosted admission; explicit self-hosts, opt-outs, and custom URLs retain their meaning", () => {
  const missing: DesktopCredential = { kind: "desktop", problem: "missing-input" };
  for (const url of [undefined, DEFAULT_RELAY_URL]) {
    const config = resolveCredentialConfig({ MIRAFOLD_RELAY_URL: url, MIRAFOLD_LICENSE_KEY: AMBIENT }, missing);
    assert.deepEqual(resolveRelayPlan(config), { kind: "off", reason: "unentitled-default" });
    assert.equal(createSubscriptionActions(config), undefined);
  }
  for (const optOut of ["off", "none", "disabled", "false", "0"]) {
    assert.deepEqual(resolveRelayPlan(resolveCredentialConfig({ MIRAFOLD_RELAY_URL: optOut }, desktop)), {
      kind: "off", reason: "opt-out",
    });
  }
  for (const input of [desktop, missing, { kind: "terminal" }] as const) {
    const env = { MIRAFOLD_RELAY_URL: "ws://127.0.0.1:9876", MIRAFOLD_APP_URL: "https://custom.example/" };
    const config = resolveCredentialConfig(env, input);
    const plan = resolveRelayPlan(config);
    assert.deepEqual(plan, resolveRelayPlan(env));
    assert.equal(presentsOnEntitlement(plan, config), false);
    assert.equal(presentsOnEntitlement(plan, { ...config, MIRAFOLD_ENTITLEMENT_URL: "https://custom.example/exchange" }), true);
  }
});

test("only an exact internal argument claims stdin; ordinary arguments and argv identity survive", async () => {
  const argv = ["node", "entry", `${DESKTOP_CREDENTIAL_FLAG}=true`, "--desktop", "--verbose"];
  const before = [...argv];
  assert.deepEqual(await readDesktopCredential(argv), { kind: "terminal" });
  assert.deepEqual(argv, before);
});

type Observation = {
  kind: string;
  problem?: string;
  keyDigest?: string;
  configDigest?: string;
  envDigest?: string;
  fdClosed: boolean;
  argv: string[];
  exposed: boolean;
};

// The child only reports digests and booleans. The expected key digest is
// safe in its argv; neither the input nor a key literal is in its script.
function reader(t: TestContext, options: {
  key?: string;
  args?: string[];
  ambient?: string;
  mode?: "normal" | "closed-fd" | "read-error" | "early-close";
  stdin?: "pipe" | "ignore";
} = {}) {
  const key = options.key ?? KEY;
  const script = `
    import { createHash } from "node:crypto";
    import { closeSync, fstatSync, readFileSync } from "node:fs";
    import net from "node:net";
    import { syncBuiltinESMExports } from "node:module";
    const hash = (text) => createHash("sha256").update(text).digest("hex");
    const expected = ${JSON.stringify(digest(key))};
    let exposed = false;
    const inspect = (value) => {
      if (typeof value !== "string") return;
      if ((value.match(/mf_[a-z2-7]{20,40}/g) ?? []).some(key => hash(key) === expected)) exposed = true;
    };
    process.env = new Proxy(process.env, { set(target, key, value) { inspect(value); target[key] = value; return true; } });
    process.argv = new Proxy(process.argv, { set(target, key, value) { inspect(value); target[key] = value; return true; } });
    const observe = () => {
      Object.values(process.env).forEach(inspect);
      process.argv.forEach(inspect);
      if (process.platform === "linux") {
        inspect(readFileSync("/proc/self/environ", "utf8"));
        inspect(readFileSync("/proc/self/cmdline", "utf8"));
      }
    };
    observe();
    const OriginalSocket = net.Socket;
    net.Socket = new Proxy(OriginalSocket, { construct(Target, [options]) {
      if (options?.fd !== 0) return new Target(options);
      const originalRead = options.onread.callback;
      let socket;
      options.onread.callback = (count, buffer) => {
        observe();
        const proceed = originalRead(count, buffer);
        observe();
        if (${JSON.stringify(options.mode ?? "normal")} === "read-error") {
          socket.destroy(new Error(buffer.toString("utf8", 0, count)));
        } else if (${JSON.stringify(options.mode ?? "normal")} === "early-close") {
          socket.destroy();
        }
        process.stdout.write("chunk\\n");
        return proceed;
      };
      socket = new Target(options);
      return socket;
    }});
    syncBuiltinESMExports();
    const { readDesktopCredential, resolveCredentialConfig } = await import(${JSON.stringify(new URL("./desktop-credential.ts", import.meta.url).href)});
    if (${JSON.stringify(options.mode)} === "closed-fd") closeSync(0);
    const pending = readDesktopCredential();
    process.stdout.write("reading\\n");
    const result = await pending;
    observe();
    const config = resolveCredentialConfig(process.env, result);
    observe();
    let fdClosed = false;
    try { fstatSync(0); } catch (err) { fdClosed = err.code === "EBADF"; }
    console.log(JSON.stringify({
      kind: result.kind, problem: result.problem,
      keyDigest: result.key ? hash(result.key) : undefined,
      configDigest: config.MIRAFOLD_LICENSE_KEY ? hash(config.MIRAFOLD_LICENSE_KEY) : undefined,
      envDigest: process.env.MIRAFOLD_LICENSE_KEY ? hash(process.env.MIRAFOLD_LICENSE_KEY) : undefined,
      fdClosed, argv: process.argv.slice(2), exposed,
    }));
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, "--", "reader",
    ...(options.args ?? [DESKTOP_CREDENTIAL_FLAG])], {
    cwd: import.meta.dirname,
    env: { PATH: process.env.PATH, MIRAFOLD_LOG_FILE: "", ...(options.ambient ? { MIRAFOLD_LICENSE_KEY: options.ambient } : {}) },
    stdio: [options.stdin ?? "pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const waiters = new Set<() => void>();
  child.stdout!.on("data", (data) => { output += String(data); for (const wake of waiters) wake(); });
  child.stderr!.on("data", (data) => { errors += String(data); });
  child.stdin?.on("error", () => {}); // rejection can close the pipe during a producer write
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const until = (text: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`reader never reported ${text}`)); }, 10_000);
    const check = () => { if (output.includes(text)) { clearTimeout(timer); waiters.delete(check); resolve(); } };
    waiters.add(check);
    check();
  });
  const result = async (): Promise<Observation> => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [code, signal] = await closed;
    clearTimeout(timer);
    assert.equal(code, 0, `reader exit ${signal}: ${errors}`);
    assert.equal(errors, "", "input and error text never reach stderr");
    assert.ok(!output.includes(key), "no key-bearing stdout");
    const observation = JSON.parse(output.trim().split("\n").at(-1)!) as Observation;
    assert.equal(observation.exposed, false, "no pipe key in environment or argv during any read or assignment");
    return observation;
  };
  return { child, until, result };
}

test("spawned reader requires EOF, accepts split UTF-8 keys, closes fd 0, and strips every internal flag", async (t) => {
  const run = reader(t, { args: [DESKTOP_CREDENTIAL_FLAG, "--verbose", DESKTOP_CREDENTIAL_FLAG], ambient: AMBIENT });
  await run.until("reading\n");
  run.child.stdin!.write(KEY.slice(0, 8));
  await run.until("chunk\n");
  run.child.stdin!.end(KEY.slice(8));
  const result = await run.result();
  assert.deepEqual(result, {
    kind: "desktop", keyDigest: digest(KEY), configDigest: digest(KEY), envDigest: digest(AMBIENT),
    fdClosed: true, argv: ["--verbose"], exposed: false,
  });
});

test("spawned reader accepts both license-shape endpoints with no environment key", async (t) => {
  for (const size of [20, 40]) {
    const key = `mf_${"z".repeat(size)}`;
    const run = reader(t, { key });
    run.child.stdin!.end(key);
    const result = await run.result();
    assert.equal(result.keyDigest, digest(key));
    assert.equal(result.envDigest, undefined);
    assert.equal(result.fdClosed, true);
  }
});

test("spawned reader rejects missing, malformed, multi-frame, non-UTF-8, BOM, and oversized input without ambient fallback", async (t) => {
  const invalid: [string | Buffer, string][] = [
    ["", "missing-input"],
    ["mf_short", "invalid-key"],
    [`mf_${"a".repeat(19)}`, "invalid-key"],
    [`mf_${"A".repeat(26)}`, "invalid-key"],
    [`mf_${"1".repeat(26)}`, "invalid-key"],
    [`${KEY}\n`, "invalid-key"],
    [`${KEY}\r\n`, "invalid-key"],
    [` ${KEY}`, "invalid-key"],
    [`${KEY}\0`, "invalid-key"],
    [Buffer.concat([Buffer.from(KEY), Buffer.from([0xff])]), "invalid-key"],
    [`\ufeff${KEY}`, "invalid-key"],
    [`${KEY}${KEY}`, "too-large"],
    [`mf_${"a".repeat(41)}`, "too-large"],
    ["x".repeat(1024 * 1024), "too-large"],
  ];
  for (const [input, problem] of invalid) {
    const run = reader(t, { ambient: AMBIENT });
    run.child.stdin!.end(input);
    const result = await run.result();
    assert.equal(result.problem, problem);
    assert.equal(result.keyDigest, undefined);
    assert.equal(result.configDigest, undefined);
    assert.equal(result.envDigest, digest(AMBIENT));
    assert.equal(result.fdClosed, true);
  }
  assert.equal(DESKTOP_CREDENTIAL_MAX_BYTES, 43);
});

test("the deadline is absolute: missing EOF and a slow producer both fail and close stdin", async (t) => {
  for (const slow of [false, true]) {
    const run = reader(t);
    await run.until("reading\n");
    const start = performance.now();
    if (!slow) run.child.stdin!.write(KEY);
    const drip = slow ? setInterval(() => run.child.stdin!.write("a"), 100) : undefined;
    try {
      const result = await run.result();
      assert.equal(result.problem, "timeout");
      assert.equal(result.keyDigest, undefined);
      assert.equal(result.fdClosed, true);
      assert.ok(performance.now() - start < DESKTOP_CREDENTIAL_TIMEOUT_MS + 3_000, "input never extends the startup deadline");
    } finally {
      clearInterval(drip);
    }
  }
});

test("descriptor errors, premature stream closure, and key-bearing stream errors fail without output", async (t) => {
  for (const mode of ["closed-fd", "read-error", "early-close"] as const) {
    const run = reader(t, { mode });
    await run.until("reading\n");
    if (mode !== "closed-fd") run.child.stdin!.write(KEY);
    const result = await run.result();
    assert.equal(result.problem, "input-error");
    assert.equal(result.keyDigest, undefined);
    assert.equal(result.fdClosed, true);
  }
  const missing = reader(t, { stdin: "ignore" });
  const result = await missing.result();
  assert.equal(result.problem, "input-error");
  assert.equal(result.fdClosed, true);
});

test("ordinary and lookalike-flag launches never consume or close stdin and retain ambient credentials", async (t) => {
  for (const args of [[], [`${DESKTOP_CREDENTIAL_FLAG}=true`, "--verbose"]]) {
    const run = reader(t, { args, ambient: AMBIENT });
    const result = await run.result(); // producer never sends EOF
    assert.equal(result.kind, "terminal");
    assert.equal(result.fdClosed, false);
    assert.equal(result.configDigest, digest(AMBIENT));
    assert.deepEqual(result.argv, args);
  }
});
