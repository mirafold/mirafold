import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Md, mdOverrides } from "./Md";

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
