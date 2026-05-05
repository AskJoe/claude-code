/**
 * Quick file picker (⌘P). Fuzzy matches against the current project's file
 * tree, picks one, opens it in CodeView and switches the right pane to Code.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import type { FileNode } from "../../../shared/events.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Live file tree from useLabSession.files. */
  files: FileNode[];
  /** Open a file path in CodeView and switch the right pane to Code. */
  onPick: (path: string) => void;
};

export function QuickFile({ open, onClose, files, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Flatten the tree once per file change. Keep only files (no dirs).
  const allPaths = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === "dir") {
          if (n.children) walk(n.children);
        } else {
          out.push(n.path);
        }
      }
    };
    walk(files);
    return out;
  }, [files]);

  const fuse = useMemo(
    () =>
      new Fuse(allPaths, {
        threshold: 0.4,
        ignoreLocation: true,
        minMatchCharLength: 1,
      }),
    [allPaths]
  );

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return allPaths.slice(0, 50);
    return fuse.search(q).slice(0, 50).map((r) => r.item);
  }, [query, allPaths, fuse]);

  // Reset state on open; auto-focus input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Clamp the active index to the result list length.
  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(0);
  }, [results, activeIndex]);

  // Esc closes; Enter picks; arrows navigate.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const path = results[activeIndex];
        if (path) {
          onPick(path);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onPick, results, activeIndex]);

  if (!open) return null;

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="dialog" aria-modal>
      <div
        className="palette-modal palette-modal-narrow"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Quick file picker — type to filter, ↑↓ to navigate, ↵ to open"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette-list">
          {results.length === 0 && (
            <div className="palette-empty">No files match.</div>
          )}
          {results.map((path, i) => (
            <button
              key={path}
              type="button"
              className={`palette-item${i === activeIndex ? " active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => {
                onPick(path);
                onClose();
              }}
            >
              <span className="palette-item-label">{basename(path)}</span>
              <span className="palette-item-hint">{path}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
