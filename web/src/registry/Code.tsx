import { cloneElement, isValidElement, useMemo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { ComponentProps } from "@registry-spec";
import { CopyButton } from "./CopyButton";

// Code display (not a change — that's Diff). Tokenizing happens client-side on
// the plain code string through the same react-markdown + rehype-highlight
// pipeline as turn-text fences: hast → React elements, so agent content is
// never interpreted as HTML anywhere.

/** Wraps verbatim code in a fence the code can't break out of: the fence is
 *  always longer than any backtick run inside, and the info string is dropped
 *  unless it's a plain language token. Pure, for Tier-1. */
export function codeFence(code: string, lang?: string): string {
  const text = code.replace(/\r\n?/g, "\n");
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const info = lang && /^[A-Za-z0-9_+#.-]+$/.test(lang) ? lang : "";
  return `${fence}${info}\n${text}\n${fence}`;
}

/** Expands 1-based inclusive ranges into the set of emphasized line numbers.
 *  Defensive on agent input: reversed ranges are read as their span, and
 *  everything clamps to [1, lineCount] — a runaway `end` can't allocate
 *  beyond the code's own length. Pure, for Tier-1. */
export function highlightedLines(
  ranges: { start: number; end?: number }[] | undefined,
  lineCount: number,
): Set<number> {
  const out = new Set<number>();
  for (const r of ranges ?? []) {
    const a = r.start;
    const b = r.end ?? r.start;
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.min(lineCount, Math.max(a, b));
    for (let n = lo; n <= hi; n++) out.add(n);
  }
  return out;
}

/** Splits highlighted token nodes into per-line groups, cutting elements whose
 *  text spans a newline (block comments, template strings) into per-line
 *  clones so token styling survives the split. One trailing empty line (the
 *  fence's final newline) is dropped. Pure over React nodes, for Tier-1. */
export function splitNodeLines(nodes: ReactNode): ReactNode[][] {
  const lines: ReactNode[][] = [[]];
  let key = 0;
  const walk = (n: ReactNode) => {
    if (n == null || typeof n === "boolean") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "string" || typeof n === "number") {
      String(n)
        .split("\n")
        .forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (part) lines[lines.length - 1].push(part);
        });
      return;
    }
    if (isValidElement(n)) {
      const el = n as ReactElement<{ children?: ReactNode }>;
      splitNodeLines(el.props.children).forEach((segment, i) => {
        if (i > 0) lines.push([]);
        if (segment.length) {
          lines[lines.length - 1].push(cloneElement(el, { key: `l${key++}` }, ...segment));
        }
      });
      return;
    }
    lines[lines.length - 1].push(n);
  };
  walk(nodes);
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

/** The strip above a code body — name on the left, language beside it when
 *  both are known, copy on the right. Shared by the `code` painting and by
 *  every fenced block the agent types in prose (Md.tsx), so the two ways of
 *  showing code read as one object. */
export function CodeHead({ name, lang, code }: { name: string; lang?: string; code: string }) {
  return (
    <div className="rc-code-head">
      <span className="rc-code-name">{name}</span>
      {lang && <span className="rc-code-lang">{lang}</span>}
      <CopyButton text={code} />
    </div>
  );
}

export function Code({ code, lang, filename, highlight }: ComponentProps<"code">) {
  const fenced = useMemo(() => codeFence(code, lang), [code, lang]);
  const components = useMemo(
    () => ({
      pre: ({ children }: { children?: ReactNode }) => (
        <pre className="rc-code-body">{children}</pre>
      ),
      code: ({ children, className }: { children?: ReactNode; className?: string }) => {
        const lines = splitNodeLines(children);
        const hl = highlightedLines(highlight, lines.length);
        return (
          <code className={className}>
            {lines.map((segment, i) => (
              <span
                key={i}
                className={"rc-code-line" + (hl.has(i + 1) ? " rc-code-line-hl" : "")}
              >
                {segment}
                {"\n"}
              </span>
            ))}
          </code>
        );
      },
    }),
    [highlight],
  );
  return (
    <div className="rc rc-code">
      <CodeHead name={filename ?? lang ?? "code"} lang={filename ? lang : undefined} code={code} />
      <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={components}>
        {fenced}
      </ReactMarkdown>
    </div>
  );
}
