import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentProps } from "react";

// Same safety rule as turn text: links open in a new tab, and react-markdown
// never emits raw HTML from its source. Shared with RenderZone's turn text.
export const safeAnchor = {
  a: ({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

const unwrapParagraph = {
  p: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

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
