import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFolderPicker,
  folderPickerAvailable,
  folderPickerCommands,
  folderPickerEnvironment,
  folderPickerStartDir,
  locateExecutable,
  runFolderPickerCommand,
  type FolderPickerProcessResult,
} from "./folder-picker";

function hangingHelperScript(pidFile: string, beforeHang = ""): string {
  return (
    `const fs=require("node:fs");` +
    `process.on("SIGTERM",()=>{});` +
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
    beforeHang +
    `setInterval(()=>{},1000)`
  );
}

function assertHelperExited(pidFile: string): void {
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("N2 native recipes: macOS, Windows, and both Linux desktop dialogs", () => {
  const mac = folderPickerCommands("/Users/kyle/project", "darwin", {});
  assert.equal(mac.length, 1);
  assert.equal(mac[0].file, "/usr/bin/osascript");
  assert.match(mac[0].args.join(" "), /choose folder/);
  assert.equal(mac[0].env?.MIRAFOLD_FOLDER_PICKER_START, "/Users/kyle/project");

  const win = folderPickerCommands("C:\\work\\project", "win32", { SystemRoot: "C:\\Windows" });
  assert.equal(win.length, 1);
  assert.equal(
    win[0].file,
    path.win32.join(
      "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  );
  assert.deepEqual(win[0].args.slice(0, 3), ["-NoLogo", "-NoProfile", "-STA"]);
  assert.match(win[0].args.at(-1)!, /FolderBrowserDialog/);
  assert.match(win[0].args.at(-1)!, /\{\n  \[Console\]/);

  const linux = folderPickerCommands("/home/kyle/project", "linux", {});
  assert.deepEqual(
    linux.map((c) => c.file),
    ["zenity", "kdialog"],
  );
  assert.ok(linux[0].args.includes("--directory"));
  assert.ok(linux[1].args.includes("--getexistingdirectory"));

  assert.deepEqual(
    folderPickerCommands("C:\\work\\project", "win32", {}),
    [],
    "Windows never falls back to a PATH-resolved powershell.exe",
  );
});

test("native helpers receive desktop state but no daemon credentials or loader hooks", () => {
  const env = folderPickerEnvironment(
    {
      PATH: "/project/node_modules/.bin:/attacker/bin",
      DISPLAY: ":1",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "must-not-cross",
      MIRAFOLD_ENTITLEMENT_TOKEN: "must-not-cross",
      CUSTOM_PROVIDER_SECRET: "must-not-cross",
      LD_PRELOAD: "/tmp/must-not-load.so",
    },
    {
      MIRAFOLD_FOLDER_PICKER_START: "/home/kyle/project",
      ANOTHER_PRIVATE_VALUE: "must-not-cross",
    },
    "linux",
  );
  assert.equal(env.DISPLAY, ":1");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.MIRAFOLD_FOLDER_PICKER_START, "/home/kyle/project");
  assert.equal(
    env.PATH,
    "/usr/bin:/bin:/run/current-system/sw/bin:/usr/local/bin:/snap/bin",
  );
  for (const secret of [
    "OPENAI_API_KEY",
    "MIRAFOLD_ENTITLEMENT_TOKEN",
    "CUSTOM_PROVIDER_SECRET",
    "LD_PRELOAD",
    "ANOTHER_PRIVATE_VALUE",
  ]) {
    assert.equal(secret in env, false, `${secret} crossed into the picker`);
  }
});

test("folderPickerAvailable requires a real platform helper", () => {
  const env = { PATH: "/mock/bin", DISPLAY: ":1" };
  assert.equal(folderPickerAvailable("linux", env, () => undefined), false);
  assert.equal(
    folderPickerAvailable("linux", { PATH: "/mock/bin" }, () => "/mock/bin/zenity"),
    false,
    "a helper without a graphical Linux session is not usable",
  );
  assert.equal(
    folderPickerAvailable("linux", env, (file) =>
      file === "kdialog" ? "/mock/bin/kdialog" : undefined,
    ),
    true,
  );
});

test("native helper lookup ignores ambient PATH and relative project commands", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-picker-path-"));
  const fake = path.join(fixture, "zenity");
  writeFileSync(fake, "");
  if (process.platform !== "win32") chmodSync(fake, 0o755);
  const relativeNode = path.relative(process.cwd(), process.execPath);
  try {
    assert.notEqual(
      locateExecutable("zenity", "linux", { PATH: fixture }),
      realpathSync.native(fake),
      "a PATH-prepended fake Zenity must never become host chrome",
    );
    assert.equal(locateExecutable(relativeNode, process.platform, process.env), undefined);
    assert.equal(
      locateExecutable(process.execPath, process.platform, process.env),
      realpathSync.native(process.execPath),
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("folderPickerStartDir expands home and lets a half-typed path fall back", () => {
  const fallback = path.resolve("/daemon/start");
  const expanded = path.resolve("/home/kyle/project");
  const exists = (candidate: string) => candidate === expanded;
  assert.equal(folderPickerStartDir("~/project", fallback, "/home/kyle", exists), expanded);
  assert.equal(folderPickerStartDir("~/missing", fallback, "/home/kyle", exists), fallback);
  assert.equal(folderPickerStartDir("", fallback, "/home/kyle", exists), fallback);
});

test("Linux falls through a broken Zenity to KDialog and validates the chosen directory", async () => {
  const chosen = path.resolve("/picked/project");
  const calls: string[] = [];
  const picker = createFolderPicker({
    platform: "linux",
    env: { PATH: "/mock/bin" },
    locate: (file) => `/mock/bin/${file}`,
    directoryExists: (candidate) => candidate === chosen || candidate === path.resolve("/start"),
    fallbackDir: () => path.resolve("/start"),
    run: async (command): Promise<FolderPickerProcessResult> => {
      calls.push(path.basename(command.file));
      return calls.length === 1
        ? { code: 1, stdout: "", stderr: "Gtk-WARNING: Failed to open display" }
        : { code: 0, stdout: `${chosen}\n`, stderr: "" };
    },
  });
  assert.equal(await picker(), chosen);
  assert.deepEqual(calls, ["zenity", "kdialog"]);
});

test("Cancel is quiet and does not fall through to a second Linux dialog", async () => {
  let calls = 0;
  const picker = createFolderPicker({
    platform: "linux",
    locate: (file) => `/mock/${file}`,
    directoryExists: () => true,
    run: async () => {
      calls++;
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal(await picker(), undefined);
  assert.equal(calls, 1);
});

test("A picker cannot stack, and a non-directory result is refused", async () => {
  const chosen = path.resolve("/picked/project");
  let release!: (result: FolderPickerProcessResult) => void;
  const picker = createFolderPicker({
    platform: "linux",
    locate: (file) => `/mock/${file}`,
    directoryExists: (candidate) => candidate !== chosen,
    run: () =>
      new Promise<FolderPickerProcessResult>((resolve) => {
        release = resolve;
      }),
  });
  const first = picker();
  await Promise.resolve();
  await assert.rejects(picker(), /already open/);
  release({ code: 0, stdout: `${chosen}\n`, stderr: "" });
  await assert.rejects(first, /not a directory/);
});

test("native picker runs from a neutral cwd", async () => {
  const result = await runFolderPickerCommand({
    file: process.execPath,
    args: ["-e", "process.stdout.write(process.cwd())"],
    canceled: () => false,
  });
  assert.equal(result.stdout, os.homedir());
});

test("picker output overflow force-stops a helper that ignores SIGTERM before rejecting", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-picker-overflow-"));
  const pidFile = path.join(fixture, "pid");
  try {
    await assert.rejects(
      runFolderPickerCommand({
        file: process.execPath,
        args: [
          "-e",
          hangingHelperScript(pidFile, `process.stdout.write("x".repeat(20000));`),
        ],
        canceled: () => false,
      }),
      /too much output/,
    );
    assertHelperExited(pidFile);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("picker abort waits for forced helper exit before rejecting", async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "mirafold-picker-abort-"));
  const pidFile = path.join(fixture, "pid");
  const controller = new AbortController();
  try {
    const pending = runFolderPickerCommand(
      {
        file: process.execPath,
        args: ["-e", hangingHelperScript(pidFile)],
        canceled: () => false,
      },
      controller.signal,
    );
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(pidFile), "helper did not start");
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assertHelperExited(pidFile);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
