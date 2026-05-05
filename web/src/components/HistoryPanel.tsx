import { useEffect, useRef, useState } from "react";
import { api, type CommitSummary } from "../lib/api.ts";

type Props = {
  projectId: number;
  open: boolean;
  onClose: () => void;
  /** Called after a successful revert so the parent can refresh project state. */
  onAfterRevert: () => void;
};

/**
 * Slide-in panel listing recent commits from the project's GitHub repo with a
 * per-commit "Revert to here" button. Reverts go through the server, which
 * uses `git checkout <sha> -- .` + commit + push to non-destructively roll
 * back the working tree.
 */
export function HistoryPanel({ projectId, open, onClose, onAfterRevert }: Props) {
  const [commits, setCommits] = useState<CommitSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSha, setConfirmSha] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // sha being reverted
  const panelRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setError(null);
    try {
      const { commits } = await api.listCommits(projectId);
      setCommits(commits);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  useEffect(() => {
    if (open) load();
    else {
      setConfirmSha(null);
      setBusy(null);
    }
  }, [open, projectId]);

  // Close on outside click + Esc
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const revert = async (sha: string) => {
    setBusy(sha);
    setError(null);
    try {
      await api.revertCommit(projectId, sha);
      setConfirmSha(null);
      onAfterRevert();
      // Reload the commit list so the new "Revert to..." commit appears at top
      await load();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div className="history-panel" ref={panelRef}>
      <div className="history-header">
        <span className="history-title">Project history</span>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <div className="admin-error">⚠ {error}</div>}

      {commits === null && !error && (
        <div className="history-empty">Loading commits…</div>
      )}

      {commits !== null && commits.length === 0 && (
        <div className="history-empty">
          No commits yet. Connect this project to GitHub and make a change to see history.
        </div>
      )}

      {commits && commits.length > 0 && (
        <ol className="history-list">
          {commits.map((c, i) => (
            <li key={c.sha} className="history-item">
              <div className="history-item-row">
                <span className="history-time">{fmtRelative(c.committedAt)}</span>
                <code className="history-sha">{c.shortSha}</code>
                {i === 0 && <span className="history-badge">current</span>}
                {c.isPublished && (
                  <span className="history-badge history-badge-pub">published</span>
                )}
              </div>
              <div className="history-msg">{firstLine(c.message)}</div>
              <div className="history-actions">
                <a
                  className="link-button"
                  href={c.htmlUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  View on GitHub →
                </a>
                {i > 0 && confirmSha !== c.sha && busy !== c.sha && (
                  <button
                    type="button"
                    className="link-button history-revert"
                    onClick={() => setConfirmSha(c.sha)}
                  >
                    Revert to here
                  </button>
                )}
                {confirmSha === c.sha && busy !== c.sha && (
                  <span className="history-confirm">
                    Revert all changes after this commit?
                    <button
                      type="button"
                      className="history-confirm-yes"
                      onClick={() => revert(c.sha)}
                    >
                      Yes, revert
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setConfirmSha(null)}
                    >
                      Cancel
                    </button>
                  </span>
                )}
                {busy === c.sha && (
                  <span className="history-busy">Reverting…</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

function fmtRelative(iso: string): string {
  if (!iso) return "?";
  const then = new Date(iso).getTime();
  const ago = Date.now() - then;
  const min = Math.floor(ago / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
