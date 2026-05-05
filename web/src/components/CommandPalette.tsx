/**
 * Fuzzy-searched command palette (⌘K).
 *
 * Modal centered, ~480px wide. Search input auto-focused, list filtered via
 * fuse.js. Arrow keys navigate, Enter picks, Esc closes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import type { Command } from "../lib/commands.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  onPick: (cmd: Command) => void;
};

export function CommandPalette({ open, onClose, commands, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep a stable Fuse instance keyed off the commands list reference.
  const fuse = useMemo(
    () =>
      new Fuse(commands, {
        keys: ["label", "id"],
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [commands]
  );

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return fuse.search(query).map((r) => r.item);
  }, [query, fuse, commands]);

  // Reset when re-opening; auto-focus search input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // Defer so the input exists.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Keep activeIdx in range as results shrink.
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results.length, activeIdx]);

  // Scroll active item into view when it changes.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (el) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight)
        list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeIdx]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = results[activeIdx];
      if (cmd) {
        onPick(cmd);
      }
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          aria-label="Command search"
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && (
            <div className="palette-empty">No commands match.</div>
          )}
          {results.map((cmd, i) => (
            <button
              key={cmd.id}
              data-idx={i}
              type="button"
              className={`palette-item ${i === activeIdx ? "active" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => onPick(cmd)}
            >
              <span className="palette-group">{cmd.group}</span>
              <span className="palette-label">{cmd.label}</span>
              {cmd.hint && <span className="palette-hint">{cmd.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
