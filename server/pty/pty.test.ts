import { test } from "node:test";
import assert from "node:assert/strict";
import { bangShell, cleanPtyOutput, cwdCapturePrefix, spawnBang, CWD_FILE_ENV } from "./pty";

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
