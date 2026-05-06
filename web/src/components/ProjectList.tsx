import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, type ProjectSummary } from "../lib/api.ts";

type Props = {
  user: { displayName: string | null; email: string; isAdmin: boolean };
  onOpen: (projectId: number) => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
};

export function ProjectList({ user, onOpen, onOpenAdmin, onLogout }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  // Inline rename: when set, that card's title is replaced with a text input
  // pre-filled with the current name. ⌘↵ saves, Esc cancels.
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const load = async () => {
    try {
      const { projects } = await api.listProjects();
      setProjects(projects);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (evt: FormEvent) => {
    evt.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const { project } = await api.createProject(newName.trim() || "Untitled project");
      setNewName("");
      setCreating(false);
      onOpen(project.id);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.deleteProject(id);
      setConfirmDelete(null);
      await load();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  const startRename = (p: ProjectSummary) => {
    setRenaming(p.id);
    setRenameDraft(p.displayName);
  };

  const cancelRename = () => {
    setRenaming(null);
    setRenameDraft("");
  };

  const commitRename = async () => {
    if (renaming == null) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      cancelRename();
      return;
    }
    setRenameBusy(true);
    try {
      await api.renameProject(renaming, trimmed);
      cancelRename();
      await load();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setRenameBusy(false);
    }
  };

  return (
    <div className="picker">
      <header className="picker-header">
        <div className="picker-header-row">
          <div>
            <div className="brand brand-lg">Cloudwise Lab</div>
            <div className="picker-tagline">
              Pick a project to keep building, or start a new one.
            </div>
          </div>
          <div className="picker-userbox">
            <div className="picker-username">{user.displayName ?? user.email}</div>
            <div className="picker-userbox-actions">
              {user.isAdmin && (
                <button type="button" className="link-button" onClick={onOpenAdmin}>
                  ⚙ Admin
                </button>
              )}
              <button type="button" className="link-button" onClick={onLogout}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      {error && <div className="picker-error">{error}</div>}

      <div className="picker-grid">
        {creating ? (
          <form className="picker-card picker-card-new" onSubmit={create}>
            <label className="picker-card-title">Name your project</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              maxLength={80}
              placeholder="e.g. coffee shop landing"
              disabled={busy}
            />
            <div className="picker-card-actions">
              <button type="submit" disabled={busy} className="picker-primary-btn">
                {busy ? "…" : "Create"}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="picker-card picker-card-open"
            onClick={() => setCreating(true)}
          >
            <div className="picker-card-title">+ New project</div>
            <div className="picker-card-desc">Static HTML/CSS starter, ready to build.</div>
          </button>
        )}

        {projects === null && !error && (
          <div className="picker-loading">Loading…</div>
        )}

        {projects?.map((p) =>
          confirmDelete === p.id ? (
            <div key={p.id} className="picker-card picker-card-confirm">
              <div className="picker-card-title">Delete "{p.displayName}"?</div>
              <div className="picker-card-desc">
                Removes all files and chat history. Cannot be undone.
              </div>
              <div className="picker-card-actions">
                <button
                  type="button"
                  className="picker-danger-btn"
                  onClick={() => remove(p.id)}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setConfirmDelete(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : renaming === p.id ? (
            <div key={p.id} className="picker-card-wrap">
              <div className="picker-card picker-card-rename">
                <RenameInput
                  value={renameDraft}
                  busy={renameBusy}
                  onChange={setRenameDraft}
                  onCommit={commitRename}
                  onCancel={cancelRename}
                />
                <div className="picker-card-desc">
                  ⌘↵ to save · Esc to cancel
                </div>
                <div className="picker-card-meta">
                  <span className="picker-pill">{p.slug}</span>
                  {p.github.connected && (
                    <span className="picker-pill picker-pill-ok">GitHub</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div key={p.id} className="picker-card-wrap">
              <button
                type="button"
                className="picker-card"
                onClick={() => onOpen(p.id)}
              >
                <div className="picker-card-title">{p.displayName}</div>
                <div className="picker-card-desc">
                  Last active {fmtRelative(p.lastActiveAt)}
                </div>
                <div className="picker-card-meta">
                  <span className="picker-pill">{p.slug}</span>
                  {p.github.connected && (
                    <span className="picker-pill picker-pill-ok">GitHub</span>
                  )}
                </div>
              </button>
              <button
                type="button"
                className="picker-rename"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(p);
                }}
                title="Rename project"
                aria-label="Rename project"
              >
                ✏️
              </button>
              <button
                type="button"
                className="picker-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDelete(p.id);
                }}
                title="Delete project"
              >
                ✕
              </button>
            </div>
          )
        )}

        {projects?.length === 0 && !creating && (
          <div className="empty-state picker-empty-rich">
            <h2 className="empty-headline">Start your first site →</h2>
            <p className="empty-body">
              Spin up a fresh static starter and ask the agent to build whatever
              you have in mind.
            </p>
            <button
              type="button"
              className="empty-cta"
              onClick={() => setCreating(true)}
            >
              Create new project
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RenameInput({
  value,
  busy,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(0, el.value.length);
      } catch {}
    }
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      onCommit();
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      className="picker-rename-input"
      value={value}
      maxLength={80}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onCommit}
      disabled={busy}
      placeholder="Project name"
    />
  );
}

function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const ago = Date.now() - then;
  const min = Math.floor(ago / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
