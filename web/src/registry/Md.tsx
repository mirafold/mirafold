import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children, cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";

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

// Same safety rule as turn text: links open in a new tab, and react-markdown
// never emits raw HTML from its source. Shared with RenderZone's turn text.
export const safeAnchor = {
  a: ({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
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
      components={inline ? { ...safeAnchor, ...unwrapParagraph } : safeAnchor}
    >
      {text}
    </ReactMarkdown>
  );
}
