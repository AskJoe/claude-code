/**
 * Agent-chat markdown renderer. Built on `react-markdown` with `remark-gfm`
 * (tables, task lists, strikethrough, autolinks) and `remark-breaks` (newlines
 * become `<br>` so casual chat formatting renders the way users expect).
 *
 * Custom renderers replace the defaults for elements where we want more than
 * the plain HTML output:
 *   - `code` → fenced blocks go through Shiki for syntax highlighting; inline
 *     code stays a simple styled `<code>`.
 *   - `img`  → lazy-loaded, max-width capped, alt falls back to filename.
 *   - `a`    → external links open in a new tab with safe rel attributes.
 *   - `table`→ wrapped so it can scroll horizontally on narrow screens.
 *
 * The full rendered tree is cached by content string in an LRU (Phase 12.2)
 * so re-renders during streaming or scrollback don't re-parse the same
 * message every keystroke.
 */

import { type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { ShikiBlock } from "./shiki.tsx";

const CACHE_LIMIT = 500;
// Map preserves insertion order — re-set on hit promotes to MRU.
const cache = new Map<string, ReactElement>();

const components: Components = {
  code(props) {
    const { className, children, node, ...rest } = props;
    const text = String(children ?? "").replace(/\n$/, "");
    const langMatch = /language-([\w-]+)/.exec(className ?? "");
    const isFenced = !!langMatch || text.includes("\n");

    if (isFenced) {
      const lang = langMatch ? langMatch[1] : "";
      return <ShikiBlock code={text} lang={lang} className="md-codeblock" />;
    }

    return (
      <code className={`md-code${className ? " " + className : ""}`} {...rest}>
        {children}
      </code>
    );
  },

  img(props) {
    const { src, alt } = props;
    const fallback = typeof src === "string" ? src.split("/").pop() ?? "" : "";
    return (
      <img
        src={typeof src === "string" ? src : undefined}
        alt={alt && alt.length > 0 ? alt : fallback}
        loading="lazy"
        className="md-img"
      />
    );
  },

  a(props) {
    const { href, children, ...rest } = props;
    const isAbsolute = typeof href === "string" && /^https?:\/\//i.test(href);
    if (isAbsolute) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
          {children}
        </a>
      );
    }
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },

  table(props) {
    return (
      <div className="md-table-wrap">
        <table {...props} />
      </div>
    );
  },
};

const remarkPlugins = [remarkGfm, remarkBreaks];

/**
 * Render markdown to a React element. Same export signature as the previous
 * mini-renderer so existing call sites (ChatPanel) don't change.
 */
export function renderMarkdown(text: string): ReactElement {
  const cached = cache.get(text);
  if (cached) {
    // MRU promotion — delete + re-set bumps to most recent insertion.
    cache.delete(text);
    cache.set(text, cached);
    return cached;
  }

  const element = (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {text}
    </ReactMarkdown>
  );

  cache.set(text, element);
  if (cache.size > CACHE_LIMIT) {
    // Evict the oldest entry (first key in insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  return element;
}
