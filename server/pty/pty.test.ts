import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bangShell,
  cleanPtyOutput,
  createPtyCleaner,
  cwdCapturePrefix,
  shellFound,
  spawnBang,
  CWD_FILE_ENV,
} from "./pty";

test("strips CSI color/style sequences", () => {
  assert.equal(cleanPtyOutput("\x1b[31mred\x1b[0m"), "red");
  assert.equal(cleanPtyOutput("\x1b[1;33;40mx\x1b[m"), "x");
});

test("strips OSC sequences (BEL- and ST-terminated)", () => {
  assert.equal(cleanPtyOutput("\x1b]0;window title\x07done"), "done");
  assert.equal(cleanPtyOutput("\x1b]0;window title\x1b\\done"), "done");
});

test("strips single-char ESC sequences", () => {
  assert.equal(cleanPtyOutput("\x1bMabc"), "abc");
});

test("normalizes CRLF and lone CR to LF", () => {
  assert.equal(cleanPtyOutput("a\r\nb\rc"), "a\nb\nc");
});

test("leaves plain text untouched", () => {
  assert.equal(cleanPtyOutput("hello world"), "hello world");
});

// 2026-07-29 bughunt: PTY reads split at arbitrary boundaries, and per-chunk
// cleaning leaked raw ESC bytes plus sequence tails (`1mred`) — and a split
// OSC's title payload as visible text — to viewports, the replay ring, and
// the agent's injected context.

test("a CSI sequence split across chunks strips whole", () => {
  const c = createPtyCleaner();
  assert.equal(c.clean("\x1b[3"), "");
  assert.equal(c.clean("1mred\x1b[0m"), "red");
  assert.equal(c.flush(), "");
});

test("an OSC title split across chunks leaks no payload", () => {
  const c = createPtyCleaner();
  assert.equal(c.clean("\x1b]0;user@host: dir"), "");
  assert.equal(c.clean("\x07done"), "done");
});

test("an OSC whose ST terminator itself splits strips whole", () => {
  const c = createPtyCleaner();
  assert.equal(c.clean("\x1b]0;title\x1b"), "");
  assert.equal(c.clean("\\after"), "after");
});

test("a lone ESC at a chunk boundary joins its sequence", () => {
  const c = createPtyCleaner();
  assert.equal(c.clean("ok\x1b"), "ok");
  assert.equal(c.clean("Mnext"), "next");
});

test("a CRLF split across chunks is one newline", () => {
  const c = createPtyCleaner();
  assert.equal(c.clean("line\r"), "line");
  assert.equal(c.clean("\nnext"), "\nnext");
});

test("flush drops a fragment that never completed", () => {
  const c = createPtyCleaner();
  assert.equal(c.clean("done\x1b[3"), "done");
  assert.equal(c.flush(), "");
});

test("a pathological unterminated OSC is bounded by maxHold, not buffered forever", () => {
  const c = createPtyCleaner(16);
  const out = c.clean("\x1b]" + "x".repeat(64));
  // Past the hold cap the chunk is cleaned as-is (bounded leakage beats
  // unbounded buffering) — the point pinned here is that nothing is held.
  assert.equal(c.flush(), "");
  assert.ok(!out.includes("\x1b"));
});

// 2026-07-29 bughunt: the parameter-byte class was `[0-9;?]`, so colon-form
// SGR (ISO 8613-6, `38:5:196`) and `<=>` private-parameter CSIs survived
// whole — raw ESC included — and DCS payloads dumped as visible text.

test("strips colon-subparameter SGR and private-parameter CSIs", () => {
  assert.equal(cleanPtyOutput("\x1b[38:5:196mred\x1b[0m"), "red");
  assert.equal(cleanPtyOutput("\x1b[38:2::255:0:0mx\x1b[0m"), "x");
  assert.equal(cleanPtyOutput("\x1b[>4;2mx"), "x");
});

test("strips DCS sequences (BEL- and ST-terminated)", () => {
  assert.equal(cleanPtyOutput("\x1bP1$qm\x1b\\done"), "done");
  assert.equal(cleanPtyOutput("\x1bPpayload\x07done"), "done");
});

// `!` must not kill the daemon — the shell is picked per platform
// (win32 never tries /bin/bash) and a missing shell throws a clean Error
// the bang handler can catch, instead of two platform-specific failures (R.4f).

test("bangShell on unix honors SHELL with a /bin/bash fallback", () => {
  const zsh = bangShell("linux", { SHELL: "/bin/zsh" });
  assert.equal(zsh.file, "/bin/zsh");
  assert.deepEqual(zsh.args("echo hi"), ["-c", "echo hi"]);
  assert.equal(bangShell("darwin", {}).file, "/bin/bash");
});

test("bangShell on win32 uses ComSpec/cmd.exe with a verbatim /c string", () => {
  const com = bangShell("win32", { ComSpec: "C:\\Windows\\system32\\cmd.exe" });
  assert.equal(com.file, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(com.args("dir"), '/d /s /c "dir"');
  assert.equal(bangShell("win32", { SHELL: "/bin/bash" }).file, "cmd.exe");
});

// The cwd handoff (bang `cd` persistence): the EXIT-trap prefix is only safe
// for shells whose trap/pwd syntax we know — anything else must get NO
// wrapper, because a broken prefix would error visibly on every `!` command.

test("cwdCapturePrefix wraps the known POSIX shells via the env var", () => {
  for (const file of ["/bin/bash", "/usr/bin/zsh", "/bin/sh", "/bin/dash", "/usr/bin/fish"]) {
    const prefix = cwdCapturePrefix(file, "linux");
    assert.ok(prefix, `${file} should capture`);
    // The file path rides in the env var — never quoted into the command
    // string — and the separator is a newline, so a user command that opens
    // with a `#` comment can't swallow it.
    assert.match(prefix!, new RegExp(`^trap 'pwd -P > "\\$${CWD_FILE_ENV}"' EXIT\\n$`));
  }
});

test("cwdCapturePrefix refuses unknown shells and all of win32", () => {
  assert.equal(cwdCapturePrefix("/usr/bin/nu", "linux"), null);
  assert.equal(cwdCapturePrefix("/opt/weird/xonsh", "linux"), null);
  assert.equal(cwdCapturePrefix("C:\\Windows\\System32\\cmd.exe", "win32"), null);
  // Even a POSIX-named shell on win32 gets no wrapper — ConPTY/cmd territory.
  assert.equal(cwdCapturePrefix("/bin/bash", "win32"), null);
});

test("spawnBang throws (not crashes) when the shell binary is missing", () => {
  const saved = process.env.SHELL;
  process.env.SHELL = "/nonexistent/genui-test-shell";
  try {
    assert.throws(
      () => spawnBang("echo hi", process.cwd(), () => {}, () => {}),
      /shell not found: \/nonexistent\/genui-test-shell/,
    );
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
});

// 2026-07-29 bughunt: the guard only checked ABSOLUTE paths, so a bare
// `SHELL=bsah` typo skipped it and died messily inside the forked child —
// the two-platform failure mode R.4f exists to remove.

test("spawnBang throws the same clean error for a bare missing shell name", () => {
  const saved = process.env.SHELL;
  process.env.SHELL = "genui-test-no-such-shell";
  try {
    assert.throws(
      () => spawnBang("echo hi", process.cwd(), () => {}, () => {}),
      /shell not found: genui-test-no-such-shell/,
    );
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
});

test("shellFound walks PATH for bare names and PATHEXT on win32", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirafold-shellfound-"));
  try {
    fs.writeFileSync(path.join(dir, "myshell"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(dir, "wshell.EXE"), "");
    assert.equal(shellFound("myshell", { PATH: dir }, "linux"), true);
    assert.equal(shellFound("absent", { PATH: dir }, "linux"), false);
    assert.equal(shellFound("wshell", { PATH: dir, PATHEXT: ".COM;.EXE" }, "win32"), true);
    // A path with a separator is resolved directly, never via PATH.
    assert.equal(shellFound(path.join(dir, "myshell"), { PATH: "" }, "linux"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
