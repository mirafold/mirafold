import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldFocusPromptFromTranscriptPointer } from "./transcript-focus";

// A minimal Element stand-in: the predicate only asks `closest()` and
// containment, so the DOM can be faked without a document.
class FakeElement {
  constructor(
    private readonly tags: string[],
    private readonly parent: FakeElement | null = null,
  ) {}
  closest(selector: string): FakeElement | null {
    const wanted = selector.split(",").map((s) => s.trim());
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: FakeElement | null = this;
    while (node) {
      if (node.tags.some((t) => wanted.includes(t))) return node;
      node = node.parent;
    }
    return null;
  }
  contains(other: FakeElement | null): boolean {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
}
const g = globalThis as unknown as { Element: unknown };
const priorElement = g.Element;
g.Element = FakeElement;

const transcript = new FakeElement(["div"]);
const prose = new FakeElement(["p"], transcript);
const button = new FakeElement(["button"], transcript);
const linkText = new FakeElement(["span"], new FakeElement(["a"], transcript));
const click = (target: FakeElement, over: Partial<Parameters<typeof shouldFocusPromptFromTranscriptPointer>[0]> = {}) =>
  shouldFocusPromptFromTranscriptPointer(
    { pointerType: "mouse", button: 0, isPrimary: true, defaultPrevented: false, target: target as unknown as EventTarget, ...over },
    transcript as unknown as HTMLElement,
    false,
  );

test("an ordinary mouse click on inert transcript prose asks for prompt focus", () => {
  assert.equal(click(prose), true);
});

test("clicks on controls, inside links, touches, secondary buttons, handled events, and live selections keep control", () => {
  assert.equal(click(button), false, "a button is a control");
  assert.equal(click(linkText), false, "text inside a link belongs to the link");
  assert.equal(click(prose, { pointerType: "touch" }), false);
  assert.equal(click(prose, { button: 2 }), false);
  assert.equal(click(prose, { isPrimary: false }), false);
  assert.equal(click(prose, { defaultPrevented: true }), false);
  assert.equal(
    shouldFocusPromptFromTranscriptPointer(
      { pointerType: "mouse", button: 0, isPrimary: true, defaultPrevented: false, target: prose as unknown as EventTarget },
      transcript as unknown as HTMLElement,
      true,
    ),
    false,
    "a live text selection is the user's, not a focus request",
  );
});

test.after(() => {
  g.Element = priorElement;
});
