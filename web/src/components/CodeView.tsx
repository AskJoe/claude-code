import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { FileTree } from "./FileTree.tsx";
import type { FileNode } from "../../../shared/events.ts";

type Props = {
  files: FileNode[];
  previewBase: string | null;
};

type SaveStatus = "idle" | "saving" | "ok" | "error";

/**
 * Code view — file tree on the left, source of the selected file on the
 * right. The right side is a Monaco editor: read-only by default, switches
 * to editable when the toolbar's ✎ Edit button is on. Cmd/Ctrl+S commits
 * the buffer to disk via PUT /api/projects/:id/files; the auto-builder's
 * chokidar watcher then picks up the change and triggers a rebuild.
 */
export function CodeView({ files, previewBase }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);

  // Theme follows the body's data-theme attribute, set by useTheme().
  const [editorTheme, setEditorTheme] = useState<"vs" | "vs-dark">(() =>
    document.body.dataset.theme === "dark" ? "vs-dark" : "vs"
  );

  // Keep editor theme in sync with the global theme. The ThemeToggle flips
  // body.dataset.theme; observe attribute changes so Monaco follows along.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setEditorTheme(
        document.body.dataset.theme === "dark" ? "vs-dark" : "vs"
      );
    });
    obs.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

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
    setSaveStatus("idle");
    setSaveError(null);
    fetch(`${previewBase}${selected}?raw=1`, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.text();
      })
      .then((text) => {
        setContent(text);
        setDraft(text);
        draftRef.current = text;
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message ?? String(err));
        setLoading(false);
      });
  }, [selected, previewBase]);

  // Project id is the first segment after /preview/. We need it for the PUT.
  const projectId = useMemo(() => {
    if (!previewBase) return null;
    const m = /^\/preview\/(\d+)\//.exec(previewBase);
    return m ? Number(m[1]) : null;
  }, [previewBase]);

  const dirty = editing && draft !== null && content !== null && draft !== content;

  const save = useCallback(async () => {
    if (!editing || !selected || !projectId) return;
    const next = draftRef.current ?? draft;
    if (next === null || next === content) return;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected, content: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
      }
      setContent(next);
      setSaveStatus("ok");
      // Auto-clear the "saved" pulse after a moment so the toolbar doesn't
      // sit there bragging about the last save forever.
      setTimeout(() => {
        setSaveStatus((s) => (s === "ok" ? "idle" : s));
      }, 1500);
    } catch (err: any) {
      setSaveError(err?.message ?? String(err));
      setSaveStatus("error");
    }
  }, [editing, selected, projectId, draft, content]);

  // ⌘S / Ctrl+S inside Monaco — bind via onMount so we don't fight the
  // browser's native save dialog when the editor has focus.
  const onMount = useCallback<OnMount>(
    (editor, monaco) => {
      editor.addCommand(
        // eslint-disable-next-line no-bitwise
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          // The save closure is captured at mount; read the current draft
          // through the ref so we don't end up writing stale text.
          if (draftRef.current === null) return;
          void save();
        }
      );
    },
    [save]
  );

  // Also wire ⌘S at window level so the user can save while focus is on the
  // toolbar, file tree, or anywhere else inside the code view. Only fires
  // when this component is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "s" && e.key !== "S") return;
      if (!editing) return;
      e.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, save]);

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
        <div className="codeview-source-header codeview-toolbar">
          {selected ? (
            <code className="codeview-path">{selected}</code>
          ) : (
            <span className="codeview-empty">Click a file in the tree</span>
          )}
          <div className="codeview-toolbar-spacer" />
          {editing && dirty && (
            <span className="codeview-unsaved" title="Unsaved changes">
              ● unsaved
            </span>
          )}
          {editing && saveStatus === "saving" && (
            <span className="codeview-unsaved saving">saving…</span>
          )}
          {editing && saveStatus === "ok" && !dirty && (
            <span className="codeview-unsaved saved">saved</span>
          )}
          {editing && saveStatus === "error" && (
            <span
              className="codeview-unsaved error"
              title={saveError ?? "save failed"}
            >
              ⚠ save failed
            </span>
          )}
          <button
            type="button"
            className={`codeview-edit-btn ${editing ? "active" : ""}`}
            onClick={() => {
              setEditing((v) => {
                const next = !v;
                if (!next) {
                  // Leaving edit mode discards unsaved changes — reset the
                  // draft to the last fetched content so the next switch back
                  // to edit mode starts clean.
                  setDraft(content);
                  draftRef.current = content;
                  setSaveStatus("idle");
                  setSaveError(null);
                }
                return next;
              });
            }}
            title={
              editing
                ? "Exit edit mode (discards unsaved)"
                : "Edit this file (⌘S to save)"
            }
            disabled={!selected || loading || !!error}
          >
            {editing ? "✕ Done" : "✎ Edit"}
          </button>
        </div>
        <div className="codeview-source-body">
          {loading && <div className="codeview-loading">loading…</div>}
          {error && <div className="codeview-error">⚠ {error}</div>}
          {!loading && !error && content !== null && selected && (
            <MonacoEditor
              height="100%"
              theme={editorTheme}
              path={selected}
              language={detectLanguage(selected)}
              value={editing ? (draft ?? content) : content}
              onChange={(v) => {
                if (!editing) return;
                const next = v ?? "";
                setDraft(next);
                draftRef.current = next;
              }}
              onMount={onMount}
              options={{
                readOnly: !editing,
                minimap: { enabled: false },
                fontSize: 12.5,
                lineNumbersMinChars: 3,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                automaticLayout: true,
                renderWhitespace: "selection",
                tabSize: 2,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Map a file path to a Monaco language id. Monaco infers from `path` too,
 * but Astro is unknown to it so we map that to html (close enough for syntax
 * highlighting; no real Astro grammar shipped with @monaco-editor/react).
 */
function detectLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascript";
    case ".html":
    case ".htm":
    case ".astro":
      return "html";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".py":
      return "python";
    case ".sh":
      return "shell";
    case ".xml":
    case ".svg":
      return "xml";
    default:
      return "plaintext";
  }
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
