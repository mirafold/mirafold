import { test } from "node:test";
import assert from "node:assert/strict";
import { bangShell, cleanPtyOutput, spawnBang } from "./pty";

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
