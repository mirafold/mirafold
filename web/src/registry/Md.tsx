import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { CodeHead } from "./Code";

// remark-gfm's task-list checkbox (`- [x] thing`) renders as a bare
// `<input disabled>` with no accessible name — a screen reader announces
// "checkbox, checked" with no link to which item. The label text is a
// SIBLING of the input inside the `<li>`, not a child of it, so the fix has
// to live at the `li` level: pull the checkbox out, read the rest of the
// item as its name.
function childrenText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => {
      if (typeof c === "string") return c;
      if (isValidElement(c)) return childrenText((c.props as { children?: ReactNode }).children);
      return "";
    })
    .join("")
    .trim();
}

/** The verbatim text of a rendered node tree (highlight.js token spans
 *  included), untrimmed — a fence's first line may be indented on purpose.
 *  Exported for Tier-1. */
export function nodeText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => {
      if (typeof c === "string") return c;
      if (typeof c === "number") return String(c);
      if (isValidElement(c)) return nodeText((c.props as { children?: ReactNode }).children);
      return "";
    })
    .join("");
}

/** The language a fence named (` ```ts `), read off the class react-markdown
 *  gives its <code>; undefined for a bare fence. Exported for Tier-1. */
export function fenceLanguage(className: string | undefined): string | undefined {
  return className?.match(/(?:^|\s)language-([\w+#.-]+)/)?.[1];
}

/** A fenced code block the agent typed in prose, dressed exactly like the
 *  `code` painting: the same header strip (language, copy) over the same
 *  body — so "code the agent offers you" is one object whichever way it
 *  arrived (Kyle, 2026-08-25). Deliberately NOT `.rc`: a fence is prose,
 *  not a painting, and must not count as one. */
function FencedCode({ node: _node, children, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  const code = Children.toArray(children).find(isValidElement) as
    | ReactElement<{ className?: string; children?: ReactNode }>
    | undefined;
  const lang = fenceLanguage(code?.props.className);
  // The body ends in the fence's own newline; the clipboard shouldn't.
  const text = nodeText(code?.props.children).replace(/\n$/, "");
  return (
    <div className="markdown-fence rc-code">
      <CodeHead name={lang ?? "code"} code={text} />
      <pre {...props} className="rc-code-body">
        {children}
      </pre>
    </div>
  );
}

// react-markdown blanks the href of any scheme off its allowlist
// (javascript:, data:, …). Two adjustments: exp/exps — Expo Go's
// deep-link schemes, how a mobile app built in
// a session reaches the phone — are re-allowed (a plain external-app
// navigation, no script surface); everything else stays stripped, and a
// stripped link renders as its text, never a clickable anchor going nowhere.
export const mdUrlTransform = (url: string): string =>
  /^exps?:/i.test(url) ? url : defaultUrlTransform(url);

/** Keep wide tables semantic while making their local overflow reachable. */
function ScrollableMarkdownTable({
  node: _node,
  children,
  ...props
}: ComponentProps<"table"> & { node?: unknown }) {
  return (
    <div className="markdown-table-scroll" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  );
}

// The markdown renderer overrides shared with OutputZone's turn text: anchors
// get the safety rule (links open in a new tab, and react-markdown never emits
// raw HTML from its source), and task-list items get an accessible checkbox label.
export const mdOverrides = {
  a: ({ node: _node, href, children, ...props }: ComponentProps<"a"> & { node?: unknown }) =>
    href ? (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  code: ({ node: _node, className, children, ...props }: ComponentProps<"code"> & { node?: unknown }) => (
    <code
      {...props}
      className={className}
      // Highlight.js makes fenced code its own horizontal scroller. Keep the
      // real scroll container keyboard-reachable; inline code remains inert.
      tabIndex={className?.split(/\s+/).includes("hljs") ? 0 : undefined}
    >
      {children}
    </code>
  ),
  pre: FencedCode,
  table: ScrollableMarkdownTable,
  li: ({ node: _node, children, ...props }: ComponentProps<"li"> & { node?: unknown }) => {
    const kids = Children.toArray(children);
    const checkbox = kids[0];
    if (isValidElement(checkbox) && (checkbox.props as { type?: string }).type === "checkbox") {
      const rest = kids.slice(1);
      const labelled = cloneElement(checkbox as ReactElement<{ "aria-label"?: string }>, {
        "aria-label": childrenText(rest) || "task item",
      });
      return (
        <li {...props}>
          {labelled}
          {rest}
        </li>
      );
    }
    return <li {...props}>{children}</li>;
  },
};

const unwrapParagraph = {
  p: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

/** The muted secondary line several components attach under an entry. */
export function MdDetail({ text }: { text: string }) {
  return (
    <div className="rc-detail">
      <Md text={text} inline />
    </div>
  );
}

/**
 * Markdown for component prop text. `inline` unwraps the paragraph so the
 * text flows inside list items, table cells, and other tight slots.
 */
export function Md({ text, inline = false }: { text: string; inline?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={mdUrlTransform}
      components={inline ? { ...mdOverrides, ...unwrapParagraph } : mdOverrides}
    >
      {text}
    </ReactMarkdown>
  );
}
