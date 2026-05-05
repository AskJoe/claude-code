/**
 * Singleton Shiki highlighter — created once, reused everywhere code blocks
 * appear (chat markdown, ToolCallBlock, CodeView). The bundle is heavy, so
 * the instance is created lazily on the first `getHighlighter()` call.
 *
 * `highlight(code, lang)` picks the theme based on the active `data-theme`
 * on `document.body` so we follow the user's light/dark choice without an
 * extra wiring step.
 */

import { useEffect, useState } from "react";
import { createHighlighter, type Highlighter } from "shiki";

const THEMES = ["github-light", "github-dark"] as const;

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "astro",
  "css",
  "html",
  "json",
  "markdown",
  "bash",
  "python",
  "yaml",
  "xml",
] as const;

type SupportedLang = (typeof LANGS)[number];

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...THEMES],
      langs: [...LANGS],
    });
  }
  return highlighterPromise;
}

function activeTheme(): "github-light" | "github-dark" {
  if (typeof document === "undefined") return "github-light";
  return document.body.dataset.theme === "dark" ? "github-dark" : "github-light";
}

function isSupported(lang: string): lang is SupportedLang {
  return (LANGS as readonly string[]).includes(lang);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function highlight(code: string, lang: string): Promise<string> {
  const normalized = lang.toLowerCase().trim();
  if (!isSupported(normalized)) {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
  const hl = await getHighlighter();
  return hl.codeToHtml(code, {
    lang: normalized,
    theme: activeTheme(),
  });
}

/**
 * Map a filename or extension to a Shiki-supported language. Returns "" when
 * we can't recognize it — callers fall back to a plain `<pre><code>` block.
 */
export function extToLang(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  if (!m) return "";
  const ext = m[1].toLowerCase();
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "astro":
      return "astro";
    case "css":
    case "pcss":
    case "scss":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "json":
      return "json";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "py":
      return "python";
    case "yml":
    case "yaml":
      return "yaml";
    case "xml":
    case "svg":
      return "xml";
    default:
      return "";
  }
}

type ShikiBlockProps = {
  code: string;
  lang: string;
  className?: string;
};

/**
 * Renders a syntax-highlighted code block. While the highlighter is loading
 * (or the language module is being added), shows a skeleton; falls back to a
 * plain `<pre>` if the language isn't supported.
 */
export function ShikiBlock({ code, lang, className }: ShikiBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(false);
    highlight(code, lang)
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  if (error || html === null) {
    if (error) {
      return (
        <pre className={className ?? "shiki-fallback"}>
          <code>{code}</code>
        </pre>
      );
    }
    return (
      <div className={`shiki-skeleton${className ? " " + className : ""}`} aria-hidden>
        <span className="shiki-skel-line" />
        <span className="shiki-skel-line short" />
        <span className="shiki-skel-line" />
      </div>
    );
  }

  return (
    <div
      className={`shiki-wrap${className ? " " + className : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
