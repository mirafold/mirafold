import { test } from "node:test";
import assert from "node:assert/strict";
import { tildify } from "./tildify";

test("tildify replaces the home prefix with ~", () => {
  assert.equal(tildify("/home/kyle/proj", "/home/kyle"), "~/proj");
  assert.equal(tildify("/home/kyle", "/home/kyle"), "~");
  assert.equal(tildify("C:\\Users\\Kyle\\Projects\\mirafold", "C:\\Users\\Kyle"), "~\\Projects\\mirafold");
  assert.equal(
    tildify("c:\\users\\kyle\\Projects", "C:\\Users\\Kyle"),
    "~\\Projects",
    "Windows home matching follows the filesystem's case-insensitive semantics",
  );
  assert.equal(
    tildify("C:/Users/Kyle/Projects", "C:\\Users\\Kyle"),
    "~/Projects",
    "mixed Windows separators compare as the same path while preserving the path's suffix",
  );
});

test("tildify only matches on a path boundary", () => {
  assert.equal(tildify("/home/kyleeee/x", "/home/kyle"), "/home/kyleeee/x");
  assert.equal(tildify("/var/log", "/home/kyle"), "/var/log");
  assert.equal(
    tildify("C:\\Users\\Kyleeee\\x", "C:\\Users\\Kyle"),
    "C:\\Users\\Kyleeee\\x",
  );
  assert.equal(
    tildify("/home/Kyle/project\\notes", "/home/kyle"),
    "/home/Kyle/project\\notes",
    "a legal POSIX backslash does not make the path case-insensitive",
  );
});

test("tildify passes through when either input is missing", () => {
  assert.equal(tildify(undefined, "/home/kyle"), undefined);
  assert.equal(tildify("/home/kyle/x", undefined), "/home/kyle/x");
});
