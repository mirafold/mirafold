import { test } from "node:test";
import assert from "node:assert/strict";
import { tildify } from "./tildify";

test("tildify replaces the home prefix with ~", () => {
  assert.equal(tildify("/home/kyle/proj", "/home/kyle"), "~/proj");
  assert.equal(tildify("/home/kyle", "/home/kyle"), "~");
});

test("tildify only matches on a path boundary", () => {
  assert.equal(tildify("/home/kyleeee/x", "/home/kyle"), "/home/kyleeee/x");
  assert.equal(tildify("/var/log", "/home/kyle"), "/var/log");
});

test("tildify passes through when either input is missing", () => {
  assert.equal(tildify(undefined, "/home/kyle"), undefined);
  assert.equal(tildify("/home/kyle/x", undefined), "/home/kyle/x");
});
