/**
 * Tiny safe markdown renderer for agent chat bubbles. Not a full implementation —
 * just the subset agents actually emit: headings, paragraphs, fenced code, inline
 * code, bold/italic, ordered/unordered lists, autolinks. Everything else passes
 * through as text. No dangerouslySetInnerHTML — every output is a real React node.
 *
 * Why custom: dropping a 50KB markdown lib for 5 tags worth of formatting is the
 * exact kind of overbuild that bloats UIs. ~80 lines beats marked + DOMPurify
 * here.
 */

import { Fragment, type ReactNode } from "react";

export function renderMarkdown(src: string): ReactNode {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang ... ```
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const start = i + 1;
      let end = start;
      while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
      const code = lines.slice(start, end).join("\n");
      blocks.push(
        <pre key={blocks.length} className="md-pre" data-lang={lang || undefined}>
          <code>{code}</code>
        </pre>
      );
      i = end + 1;
      continue;
    }

    // Headings
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level, 4) + 2}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(
        <Tag key={blocks.length} className="md-h">
          {renderInline(heading[2])}
        </Tag>
      );
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*[-*]\s+/, "");
        items.push(<li key={items.length}>{renderInline(text)}</li>);
        i++;
      }
      blocks.push(
        <ul key={blocks.length} className="md-ul">
          {items}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*\d+\.\s+/, "");
        items.push(<li key={items.length}>{renderInline(text)}</li>);
        i++;
      }
      blocks.push(
        <ol key={blocks.length} className="md-ol">
          {items}
        </ol>
      );
      continue;
    }

    // Blank line → paragraph break
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect contiguous non-block lines
    const paragraphLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={blocks.length} className="md-p">
        {renderInline(paragraphLines.join(" "))}
      </p>
    );
  }

  return <>{blocks}</>;
}

/** Inline span renderer: code, bold, italic, links. */
function renderInline(text: string): ReactNode {
  // Token a string into [literal, code, bold, italic, link, autolink] segments.
  // Order: code first (it doesn't process its content), then bold/italic, then links.
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    // `code` (single backticks)
    const code = /`([^`]+)`/.exec(rest);
    // **bold**
    const bold = /\*\*([^*]+)\*\*/.exec(rest);
    // *italic* (avoid matching **)
    const italic = /(?<!\*)\*([^*\n]+)\*(?!\*)/.exec(rest);
    // [text](url)
    const link = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
    // bare http/https URL
    const autolink = /(https?:\/\/[^\s)]+)/.exec(rest);

    const candidates = [code, bold, italic, link, autolink].filter(
      (m): m is RegExpExecArray => !!m
    );

    if (candidates.length === 0) {
      out.push(rest);
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const m = candidates[0];

    if (m.index > 0) out.push(rest.slice(0, m.index));

    if (m === code) {
      out.push(
        <code key={key++} className="md-code">
          {m[1]}
        </code>
      );
    } else if (m === bold) {
      out.push(<strong key={key++}>{renderInline(m[1])}</strong>);
    } else if (m === italic) {
      out.push(<em key={key++}>{renderInline(m[1])}</em>);
    } else if (m === link) {
      out.push(
        <a key={key++} href={m[2]} target="_blank" rel="noreferrer noopener">
          {m[1]}
        </a>
      );
    } else if (m === autolink) {
      out.push(
        <a key={key++} href={m[1]} target="_blank" rel="noreferrer noopener">
          {m[1]}
        </a>
      );
    }

    rest = rest.slice(m.index + m[0].length);
  }

  return out.map((node, idx) => <Fragment key={idx}>{node}</Fragment>);
}
