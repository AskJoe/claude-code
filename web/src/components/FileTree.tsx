import { useEffect, useMemo, useRef, useState } from "react";
import type { FileNode } from "../../../shared/events.ts";

type Props = {
  files: FileNode[];
  selectedPath: string | null;
  onSelect: (node: FileNode) => void;
};

type ContextMenuState = {
  node: FileNode;
  x: number;
  y: number;
};

export function FileTree({ files, selectedPath, onSelect }: Props) {
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  // Set of directory paths the user has explicitly collapsed. Default state
  // is "everything expanded" — easier than tracking what's open. Toggling
  // "Fold all" populates the set with every dir path; "Unfold all" empties.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [context, setContext] = useState<ContextMenuState | null>(null);

  const allDirPaths = useMemo(() => collectDirPaths(files), [files]);
  const visible = useMemo(
    () => filterTree(files, search.trim().toLowerCase(), showHidden),
    [files, search, showHidden]
  );
  const allFolded = collapsed.size > 0 && collapsed.size >= allDirPaths.size;

  const toggleFolded = () => {
    if (allFolded) {
      setCollapsed(new Set());
    } else {
      setCollapsed(new Set(allDirPaths));
    }
  };

  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!context) return;
    const onDown = () => setContext(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContext(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [context]);

  return (
    <div className="filetree">
      <div className="tree-toolbar">
        <input
          type="text"
          className="tree-search"
          placeholder="Filter files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
        <button
          type="button"
          className="tree-toggle"
          onClick={toggleFolded}
          title={allFolded ? "Unfold all folders" : "Fold all folders"}
          aria-label={allFolded ? "Unfold all" : "Fold all"}
        >
          {allFolded ? "📁" : "📂"}
        </button>
        <button
          type="button"
          className={`tree-toggle ${showHidden ? "active" : ""}`}
          onClick={() => setShowHidden((v) => !v)}
          title={
            showHidden ? "Hide files starting with ." : "Show hidden (.*) files"
          }
          aria-label="Toggle hidden files"
        >
          👁
        </button>
      </div>
      <div className="filetree-body">
        {visible.length === 0 ? (
          <div className="filetree-empty empty-state empty-state-dashed">
            <p className="empty-body">
              {search
                ? "no files match"
                : "Files appear here after you ask the agent to create them."}
            </p>
          </div>
        ) : (
          <Branch
            nodes={visible}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
            collapsed={collapsed}
            onToggleDir={toggleDir}
            onContext={(node, ev) => {
              ev.preventDefault();
              setContext({ node, x: ev.clientX, y: ev.clientY });
            }}
            // When a search filter is active, treat all dirs as expanded so
            // matches always show up regardless of the user's fold state.
            forceExpand={!!search.trim()}
          />
        )}
      </div>
      {context && (
        <ContextMenu
          state={context}
          onDismiss={() => setContext(null)}
        />
      )}
    </div>
  );
}

function Branch({
  nodes,
  depth,
  selectedPath,
  onSelect,
  collapsed,
  onToggleDir,
  onContext,
  forceExpand,
}: {
  nodes: FileNode[];
  depth: number;
  selectedPath: string | null;
  onSelect: (node: FileNode) => void;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
  onContext: (node: FileNode, ev: React.MouseEvent) => void;
  forceExpand: boolean;
}) {
  return (
    <ul className="filetree-list">
      {nodes.map((node) => {
        const isSelected = node.path === selectedPath;
        const previewable = node.type === "file" && isPreviewable(node.name);
        const isDir = node.type === "dir";
        const expanded = forceExpand || !collapsed.has(node.path);
        return (
          <li key={node.path}>
            <button
              type="button"
              className={`filetree-item ${node.type} ${isSelected ? "selected" : ""} ${previewable ? "previewable" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                if (isDir) onToggleDir(node.path);
                else onSelect(node);
              }}
              onContextMenu={(ev) => onContext(node, ev)}
              disabled={node.type === "file" && !previewable}
              title={node.path}
            >
              <span className="filetree-icon">
                {isDir ? (expanded ? "📂" : "📁") : "📄"}
              </span>
              <span className="filetree-name">{node.name}</span>
            </button>
            {isDir && expanded && node.children && node.children.length > 0 && (
              <Branch
                nodes={node.children}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
                collapsed={collapsed}
                onToggleDir={onToggleDir}
                onContext={onContext}
                forceExpand={forceExpand}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ContextMenu({
  state,
  onDismiss,
}: {
  state: ContextMenuState;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Stop the global mousedown handler in FileTree from immediately dismissing
  // the menu when the user clicks an item inside it.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const stub = (label: string) => () => {
    onDismiss();
    // Inline notice — these handlers are wired in a later phase. Plain
    // window.alert is intentional here: the lab has no system-message bar
    // for transient notices, and this is a stub.
    // eslint-disable-next-line no-alert
    alert(`${label}: not yet wired`);
  };

  const copyPath = async () => {
    onDismiss();
    try {
      await navigator.clipboard.writeText(state.node.path);
    } catch {
      // Silent — clipboard may be blocked in iframe contexts. The browser
      // already shows an indicator on success/failure.
    }
  };

  return (
    <div
      ref={ref}
      className="tree-context-menu"
      role="menu"
      style={{ top: state.y, left: state.x }}
      onMouseDown={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={stub("Rename")}>
        Rename
      </button>
      <button type="button" role="menuitem" onClick={stub("Delete")}>
        Delete
      </button>
      <button type="button" role="menuitem" onClick={stub("Duplicate")}>
        Duplicate
      </button>
      <button type="button" role="menuitem" onClick={copyPath}>
        Copy path
      </button>
    </div>
  );
}

function collectDirPaths(nodes: FileNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.type === "dir") {
      out.add(n.path);
      if (n.children) collectDirPaths(n.children, out);
    }
  }
  return out;
}

/**
 * Returns a copy of `nodes` filtered by:
 *   - `query` (case-insensitive substring of full path) — empty matches all
 *   - `showHidden` — when false, skip files/dirs starting with "."
 *
 * A directory survives the filter if it (or anything under it) has a
 * matching descendant. That keeps the path context visible when searching.
 */
function filterTree(
  nodes: FileNode[],
  query: string,
  showHidden: boolean
): FileNode[] {
  const out: FileNode[] = [];
  for (const n of nodes) {
    if (!showHidden && n.name.startsWith(".")) continue;
    if (n.type === "dir") {
      const children = n.children
        ? filterTree(n.children, query, showHidden)
        : [];
      const selfMatches = !query || n.path.toLowerCase().includes(query);
      if (selfMatches || children.length > 0) {
        out.push({ ...n, children });
      }
    } else {
      if (!query || n.path.toLowerCase().includes(query)) {
        out.push(n);
      }
    }
  }
  return out;
}

function isPreviewable(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return [
    ".html", ".htm",
    ".astro",
    ".css",
    ".js", ".mjs", ".ts", ".tsx", ".jsx",
    ".json",
    ".txt", ".md",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".astro",
  ].includes(ext);
}
