import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { Md, fenceLanguage, mdOverrides, nodeText } from "./Md";

const render = (text: string) => renderToStaticMarkup(createElement(Md, { text }));

test("http(s) links keep their href and open in a new tab", () => {
  const html = render("[the app](http://192.168.1.50:8081)");
  assert.match(html, /<a href="http:\/\/192\.168\.1\.50:8081"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("a bare URL autolinks the same way", () => {
  assert.match(
    render("Open http://192.168.1.50:8081 on your phone."),
    /<a href="http:\/\/192\.168\.1\.50:8081"/,
  );
});

// Expo Go's deep-link schemes carry a mobile app built in a session to the
// phone (2026-07-28) — they must survive the scheme allowlist as real links.
test("exp:// and exps:// links survive as tappable anchors", () => {
  assert.match(
    render("[open in Expo Go](exp://192.168.1.50:8081)"),
    /<a href="exp:\/\/192\.168\.1\.50:8081"/,
  );
  assert.match(render("[secure](exps://x.dev/app)"), /<a href="exps:\/\/x\.dev\/app"/);
});

// A scheme the allowlist strips must render as plain text — the 2026-07-28
// bug was a clickable anchor with an EMPTY href, a link going nowhere.
test("a stripped scheme renders its text, never a dead anchor", () => {
  const html = render("[run this](javascript:alert(1))");
  assert.ok(!html.includes("<a"), `stripped scheme still rendered an anchor: ${html}`);
  assert.ok(!html.includes("javascript:"), "the dangerous URL itself leaked into the DOM");
  assert.match(html, /run this/);
});

test("highlighted fenced code is keyboard-focusable while inline code stays inert", () => {
  const highlighted = renderToStaticMarkup(
    createElement(mdOverrides.code, { className: "hljs language-ts" }, "const value = 1;"),
  );
  const inline = renderToStaticMarkup(createElement(mdOverrides.code, {}, "value"));
  assert.match(highlighted, /tabindex="0"/);
  assert.ok(!inline.includes("tabindex"), `inline code became a tab stop: ${inline}`);
});

test("a Markdown table keeps its semantics inside a keyboard-reachable local scroller", () => {
  const html = render("| Name | Result |\n| --- | --- |\n| stream | immediate |");
  assert.match(html, /<div class="markdown-table-scroll" tabindex="0">/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<td>immediate<\/td>/);
});

// Turn prose renders through the same pipeline as OutputZone's AssistantTurn:
// react-markdown + rehype-highlight + mdOverrides.
const renderTurn = (text: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { rehypePlugins: [rehypeHighlight], components: mdOverrides }, text),
  );

test("a fenced block in prose gets the code painting's header strip: language, copy, shared body class", () => {
  const html = renderTurn("Run this:\n\n```sh\nyarn typecheck && yarn test\n```");
  assert.match(html, /class="markdown-fence rc-code"/);
  assert.match(html, /<div class="rc-code-head"><span class="rc-code-name">sh<\/span>/);
  assert.match(html, /class="rc-copy"[^>]*>copy</);
  assert.match(html, /<pre class="rc-code-body"><code class="hljs language-sh" tabindex="0">/);
  // Not a painting: never the registry's .rc box.
  assert.doesNotMatch(html, /class="rc rc-code"/);
});

test("a bare fence is named \"code\"; inline code is untouched", () => {
  const bare = renderTurn("```\nplain\n```");
  assert.match(bare, /<span class="rc-code-name">code<\/span>/);
  const inline = renderTurn("use `yarn dev` here");
  assert.doesNotMatch(inline, /rc-code-head/);
  assert.match(inline, /<code>yarn dev<\/code>/);
});

test("fenceLanguage reads the fence's language off the highlight class; nodeText keeps indentation", () => {
  assert.equal(fenceLanguage("hljs language-ts"), "ts");
  assert.equal(fenceLanguage("language-c++ hljs"), "c++");
  assert.equal(fenceLanguage("hljs"), undefined);
  assert.equal(fenceLanguage(undefined), undefined);
  assert.equal(
    nodeText(["  if (a) {\n", createElement("span", null, "    b();"), "\n  }\n"]),
    "  if (a) {\n    b();\n  }\n",
  );
});
