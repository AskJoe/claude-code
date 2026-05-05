/**
 * Rich viewer for an agent tool call. Replaces the truncated grey row in
 * ChatPanel. Default state is collapsed — `<icon> <tool name> <one-line
 * summary>` — and clicking the header expands to a per-tool view:
 *
 *   - Read         → file viewer with line numbers + Shiki highlight
 *   - Write/Edit   → unified diff (red/green lines, line numbers)
 *   - Bash         → terminal-styled <pre> with ANSI parsed
 *   - Glob         → bullet list of matched paths (clickable)
 *   - Grep         → matches with file:line prefixes
 *   - WebFetch /
 *     WebSearch    → title / URL / snippet card
 *   - default      → JSON pretty-print of input + result
 *
 * The block always renders headers as a click-to-toggle button so keyboard
 * users get focus + Enter without extra wiring.
 */

import { useMemo, useState } from "react";
import { diffLines } from "diff";
import Convert from "ansi-to-html";
import { ShikiBlock, extToLang } from "../lib/shiki.tsx";

type ToolResult = { ok: boolean; preview: string };

type Props = {
  tool: string;
  input: unknown;
  result?: ToolResult;
  onPathClick?: (path: string) => void;
};

const ansi = new Convert({
  newline: false,
  escapeXML: true,
  fg: "#1a1916",
  bg: "transparent",
});

export function ToolCallBlock({ tool, input, result, onPathClick }: Props) {
  const [open, setOpen] = useState(false);
  const summary = oneLineSummary(tool, input);
  const status = result ? (result.ok ? "ok" : "err") : "running";
  const icon = iconFor(tool);

  return (
    <div className={`toolcall toolcall-${status}`}>
      <button
        type="button"
        className="toolcall-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="toolcall-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="toolcall-icon" aria-hidden>
          {icon}
        </span>
        <span className="toolcall-name">{tool}</span>
        {summary ? <span className="toolcall-summary">{summary}</span> : null}
        <span className={`toolcall-status toolcall-status-${status}`}>
          {result ? (result.ok ? "✓" : "✗") : "…"}
        </span>
      </button>

      {open ? (
        <div className="toolcall-body">
          {renderBody(tool, input, result, onPathClick)}
        </div>
      ) : null}
    </div>
  );
}

/* ── Per-tool bodies ────────────────────────────────────────────────────── */

function renderBody(
  tool: string,
  input: unknown,
  result: ToolResult | undefined,
  onPathClick: ((path: string) => void) | undefined,
) {
  switch (tool) {
    case "Read":
      return <ReadView input={input} result={result} />;
    case "Edit":
      return <EditView input={input} result={result} />;
    case "Write":
      return <WriteView input={input} result={result} />;
    case "Bash":
      return <BashView input={input} result={result} />;
    case "Glob":
      return <GlobView input={input} result={result} onPathClick={onPathClick} />;
    case "Grep":
      return <GrepView input={input} result={result} />;
    case "WebFetch":
    case "WebSearch":
      return <WebView tool={tool} input={input} result={result} />;
    default:
      return <DefaultView input={input} result={result} />;
  }
}

/* Read: file path + content with line numbers + Shiki highlight. */
function ReadView({ input, result }: { input: unknown; result?: ToolResult }) {
  const filePath = stringField(input, "file_path") ?? stringField(input, "path") ?? "";
  const content = result?.preview ?? "";
  const lang = filePath ? extToLang(filePath) : "";

  return (
    <div className="toolcall-read">
      {filePath ? <div className="toolcall-filepath">{filePath}</div> : null}
      {lang ? (
        <ShikiBlock code={content} lang={lang} className="toolcall-codeblock" />
      ) : (
        <pre className="toolcall-pre">
          <code>{content}</code>
        </pre>
      )}
    </div>
  );
}

/* Edit: input has old_string + new_string. Show as a unified diff. */
function EditView({ input, result }: { input: unknown; result?: ToolResult }) {
  const filePath = stringField(input, "file_path") ?? stringField(input, "path") ?? "";
  const oldText = stringField(input, "old_string") ?? "";
  const newText = stringField(input, "new_string") ?? "";
  const errorMsg = result && !result.ok ? result.preview : null;

  return (
    <div className="toolcall-edit">
      {filePath ? <div className="toolcall-filepath">{filePath}</div> : null}
      <DiffBlock oldText={oldText} newText={newText} />
      {errorMsg ? <div className="toolcall-error">{errorMsg}</div> : null}
    </div>
  );
}

/* Write: full new file. Show as a diff against an empty original (everything green). */
function WriteView({ input, result }: { input: unknown; result?: ToolResult }) {
  const filePath = stringField(input, "file_path") ?? stringField(input, "path") ?? "";
  const newText = stringField(input, "content") ?? "";
  const errorMsg = result && !result.ok ? result.preview : null;

  return (
    <div className="toolcall-edit">
      {filePath ? <div className="toolcall-filepath">{filePath}</div> : null}
      <DiffBlock oldText="" newText={newText} />
      {errorMsg ? <div className="toolcall-error">{errorMsg}</div> : null}
    </div>
  );
}

function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo(() => buildDiffRows(oldText, newText), [oldText, newText]);
  return (
    <div className="toolcall-diff" role="table">
      {rows.map((row, idx) => (
        <div key={idx} className={`toolcall-diff-row toolcall-diff-${row.kind}`}>
          <span className="toolcall-diff-ln toolcall-diff-ln-old">
            {row.oldLine ?? ""}
          </span>
          <span className="toolcall-diff-ln toolcall-diff-ln-new">
            {row.newLine ?? ""}
          </span>
          <span className="toolcall-diff-sign">
            {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
          </span>
          <span className="toolcall-diff-text">{row.text}</span>
        </div>
      ))}
    </div>
  );
}

type DiffRow = {
  kind: "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

function buildDiffRows(oldText: string, newText: string): DiffRow[] {
  const parts = diffLines(oldText, newText);
  const rows: DiffRow[] = [];
  let oldLn = 1;
  let newLn = 1;

  for (const part of parts) {
    const lines = part.value.split("\n");
    // diffLines values usually end in "\n"; drop the trailing empty entry.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    for (const line of lines) {
      if (part.added) {
        rows.push({ kind: "add", oldLine: null, newLine: newLn++, text: line });
      } else if (part.removed) {
        rows.push({ kind: "del", oldLine: oldLn++, newLine: null, text: line });
      } else {
        rows.push({ kind: "ctx", oldLine: oldLn++, newLine: newLn++, text: line });
      }
    }
  }
  return rows;
}

/* Bash: command pill + ANSI-rendered stdout. */
function BashView({ input, result }: { input: unknown; result?: ToolResult }) {
  const command = stringField(input, "command") ?? "";
  const output = result?.preview ?? "";
  const html = useMemo(() => ansi.toHtml(output), [output]);

  return (
    <div className="toolcall-bash">
      {command ? (
        <div className="toolcall-bash-cmd">
          <span className="toolcall-bash-prompt">$</span> {command}
        </div>
      ) : null}
      <pre
        className="toolcall-bash-out"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/* Glob: list of paths. */
function GlobView({
  input,
  result,
  onPathClick,
}: {
  input: unknown;
  result?: ToolResult;
  onPathClick?: (path: string) => void;
}) {
  const pattern = stringField(input, "pattern") ?? "";
  const paths = (result?.preview ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="toolcall-glob">
      {pattern ? (
        <div className="toolcall-meta">
          <span className="toolcall-meta-label">pattern</span>
          <code className="toolcall-meta-value">{pattern}</code>
        </div>
      ) : null}
      {paths.length === 0 ? (
        <div className="toolcall-empty">no matches</div>
      ) : (
        <ul className="toolcall-pathlist">
          {paths.map((p, i) => (
            <li key={i}>
              {onPathClick ? (
                <button
                  type="button"
                  className="toolcall-path-btn"
                  onClick={() => onPathClick(p)}
                >
                  {p}
                </button>
              ) : (
                <span className="toolcall-path">{p}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* Grep: matches as `path:line:text`. */
function GrepView({ input, result }: { input: unknown; result?: ToolResult }) {
  const pattern = stringField(input, "pattern") ?? "";
  const lines = (result?.preview ?? "")
    .split("\n")
    .map((s) => s.replace(/\r$/, ""))
    .filter(Boolean);

  return (
    <div className="toolcall-grep">
      {pattern ? (
        <div className="toolcall-meta">
          <span className="toolcall-meta-label">pattern</span>
          <code className="toolcall-meta-value">{pattern}</code>
        </div>
      ) : null}
      {lines.length === 0 ? (
        <div className="toolcall-empty">no matches</div>
      ) : (
        <pre className="toolcall-grep-pre">
          <code>{lines.join("\n")}</code>
        </pre>
      )}
    </div>
  );
}

/* WebFetch / WebSearch: card-style summary. */
function WebView({
  tool,
  input,
  result,
}: {
  tool: string;
  input: unknown;
  result?: ToolResult;
}) {
  const url = stringField(input, "url") ?? "";
  const query = stringField(input, "query") ?? "";
  const prompt = stringField(input, "prompt") ?? "";
  const snippet = result?.preview ?? "";

  return (
    <div className="toolcall-web">
      <div className="toolcall-web-title">{tool}</div>
      {url ? (
        <a
          className="toolcall-web-url"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {url}
        </a>
      ) : null}
      {query ? <div className="toolcall-web-query">{query}</div> : null}
      {prompt ? <div className="toolcall-web-query">{prompt}</div> : null}
      {snippet ? <div className="toolcall-web-snippet">{snippet}</div> : null}
    </div>
  );
}

/* Default: JSON pretty-print of input + result. */
function DefaultView({ input, result }: { input: unknown; result?: ToolResult }) {
  return (
    <div className="toolcall-default">
      <div className="toolcall-meta-label">input</div>
      <pre className="toolcall-pre">
        <code>{safeJson(input)}</code>
      </pre>
      {result ? (
        <>
          <div className="toolcall-meta-label">result</div>
          <pre className="toolcall-pre">
            <code>{result.preview}</code>
          </pre>
        </>
      ) : null}
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function oneLineSummary(tool: string, input: unknown): string {
  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
      return stringField(input, "file_path") ?? stringField(input, "path") ?? "";
    case "Bash": {
      const c = stringField(input, "command") ?? "";
      return c.length > 80 ? c.slice(0, 80) + "…" : c;
    }
    case "Glob":
    case "Grep":
      return stringField(input, "pattern") ?? "";
    case "WebFetch":
      return stringField(input, "url") ?? "";
    case "WebSearch":
      return stringField(input, "query") ?? "";
    default: {
      const generic =
        stringField(input, "file_path") ??
        stringField(input, "path") ??
        stringField(input, "command") ??
        "";
      return generic.length > 80 ? generic.slice(0, 80) + "…" : generic;
    }
  }
}

function iconFor(tool: string): string {
  switch (tool) {
    case "Read":
      return "📖";
    case "Write":
      return "✍";
    case "Edit":
      return "✏";
    case "Bash":
      return "▶";
    case "Glob":
      return "❖";
    case "Grep":
      return "⌕";
    case "WebFetch":
    case "WebSearch":
      return "🌐";
    default:
      return "🔧";
  }
}
