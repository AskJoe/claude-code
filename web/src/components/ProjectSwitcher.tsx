/**
 * Topbar project switcher. Click the active project name to open a popover
 * listing the user's projects; click one to navigate without leaving the lab.
 */

import { useEffect, useRef, useState } from "react";
import { api, type ProjectSummary } from "../lib/api.ts";

type Props = {
  /** Currently-open project. Used as the popover anchor. */
  activeProject: ProjectSummary;
  /** Navigate to another project. Caller updates the route hash. */
  onPick: (id: number) => void;
  /** Open the full project list (escape hatch when the user wants to manage). */
  onOpenList: () => void;
};

export function ProjectSwitcher({ activeProject, onPick, onOpenList }: Props) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fetch the project list lazily on first open. Re-fetch on every open so
  // the user sees a fresh list if they renamed elsewhere.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .listProjects()
      .then(({ projects: ps }) => {
        setProjects(ps);
      })
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
  }, [open]);

  // Click-outside closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="proj-switcher" ref={wrapRef}>
      <button
        type="button"
        className="proj-switcher-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch project"
      >
        <span className="topbar-project">{activeProject.displayName}</span>
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="proj-switcher-popover" role="listbox">
          {loading && (
            <div className="proj-switcher-loading">Loading…</div>
          )}
          {projects?.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`proj-switcher-item${p.id === activeProject.id ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                if (p.id !== activeProject.id) onPick(p.id);
              }}
            >
              <span className="proj-switcher-name">{p.displayName}</span>
              <span className="proj-switcher-slug">{p.slug}</span>
            </button>
          ))}
          {projects && projects.length === 0 && (
            <div className="proj-switcher-empty">No other projects.</div>
          )}
          <div className="proj-switcher-divider" />
          <button
            type="button"
            className="proj-switcher-item proj-switcher-list-link"
            onClick={() => {
              setOpen(false);
              onOpenList();
            }}
          >
            All projects →
          </button>
        </div>
      )}
    </div>
  );
}
