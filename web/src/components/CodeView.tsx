import { useEffect, useState } from "react";
import { FileTree } from "./FileTree.tsx";
import type { FileNode } from "../../../shared/events.ts";

type Props = {
  files: FileNode[];
  previewBase: string | null;
};

/**
 * Code view — file tree on the left, source of the selected file on the right.
 * No syntax highlighting yet; if students ask for it we add highlight.js.
 */
export function CodeView({ files, previewBase }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default-select something useful as soon as the tree fills in.
  useEffect(() => {
    if (selected) return;
    const candidates = ["src/pages/index.astro", "src/pages/index.tsx", "index.html"];
    for (const want of candidates) {
      if (findByPath(files, want)) {
        setSelected(want);
        return;
      }
    }
    // Otherwise the first file we find.
    const first = findFirst(files, (n) => n.type === "file");
    if (first) setSelected(first.path);
  }, [files, selected]);

  // Fetch source whenever selection changes.
  useEffect(() => {
    if (!selected || !previewBase) return;
    setLoading(true);
    setError(null);
    fetch(`${previewBase}${selected}?raw=1`, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.text();
      })
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message ?? String(err));
        setLoading(false);
      });
  }, [selected, previewBase]);

  return (
    <div className="codeview">
      <div className="codeview-tree">
        <FileTree
          files={files}
          selectedPath={selected}
          onSelect={(n) => n.type === "file" && setSelected(n.path)}
        />
      </div>
      <div className="codeview-source">
        <div className="codeview-source-header">
          {selected ? (
            <code className="codeview-path">{selected}</code>
          ) : (
            <span className="codeview-empty">Click a file in the tree</span>
          )}
        </div>
        <div className="codeview-source-body">
          {loading && <div className="codeview-loading">loading…</div>}
          {error && <div className="codeview-error">⚠ {error}</div>}
          {!loading && !error && content !== null && <SourceCode text={content} />}
        </div>
      </div>
    </div>
  );
}

function SourceCode({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="codeview-pre">
      <ol className="codeview-lines">
        {lines.map((line, i) => (
          <li key={i}>
            <span className="codeview-line">{line || " "}</span>
          </li>
        ))}
      </ol>
    </pre>
  );
}

function findByPath(nodes: FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.type === "dir" && n.children) {
      const hit = findByPath(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

function findFirst(
  nodes: FileNode[],
  pred: (n: FileNode) => boolean
): FileNode | null {
  for (const n of nodes) {
    if (pred(n)) return n;
    if (n.type === "dir" && n.children) {
      const hit = findFirst(n.children, pred);
      if (hit) return hit;
    }
  }
  return null;
}
