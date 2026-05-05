/**
 * Global search (⌘⇧F). Searches files in the project's session dir and the
 * persisted chat history; results split into "In files" and "In chat" groups.
 */

import { useEffect, useRef, useState } from "react";

type FileHit = { file: string; line: number; text: string };
type ChatHit = {
  messageId: number;
  role: string;
  text: string;
  createdAt: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: number;
  /** Click on a file hit jumps the right pane to Code and opens that file. */
  onPickFile: (path: string) => void;
};

export function GlobalSearch({ open, onClose, projectId, onPickFile }: Props) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileHit[]>([]);
  const [chat, setChat] = useState<ChatHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);

  // Reset on open; auto-focus input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFiles([]);
    setChat([]);
    setError(null);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Debounced fetch on query change.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    const q = query.trim();
    if (q.length < 2) {
      setFiles([]);
      setChat([]);
      setLoading(false);
      setError(null);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/search?q=${encodeURIComponent(q)}`,
          { credentials: "same-origin" }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as { files: FileHit[]; chat: ChatHit[] };
        setFiles(json.files);
        setChat(json.chat);
      } catch (err: any) {
        setError(err?.message ?? "search failed");
        setFiles([]);
        setChat([]);
      } finally {
        setLoading(false);
      }
    }, 200) as unknown as number;
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [query, open, projectId]);

  if (!open) return null;

  return (
    <div
      className="palette-backdrop"
      onMouseDown={onClose}
      role="dialog"
      aria-modal
    >
      <div
        className="palette-modal palette-modal-wide"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search across files and chat history (min 2 chars)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette-list global-search-list">
          {error && <div className="palette-empty">Error: {error}</div>}
          {loading && <div className="palette-empty">Searching…</div>}
          {!loading && !error && query.trim().length >= 2 && files.length === 0 && chat.length === 0 && (
            <div className="palette-empty">No matches.</div>
          )}
          {files.length > 0 && (
            <>
              <div className="search-group-label">In files</div>
              {files.map((h) => (
                <button
                  key={`${h.file}:${h.line}`}
                  type="button"
                  className="palette-item search-result"
                  onClick={() => {
                    onPickFile(h.file);
                    onClose();
                  }}
                >
                  <span className="palette-item-label">
                    {h.file}
                    <span className="search-line">:{h.line}</span>
                  </span>
                  <span className="search-snippet">{h.text}</span>
                </button>
              ))}
            </>
          )}
          {chat.length > 0 && (
            <>
              <div className="search-group-label">In chat</div>
              {chat.map((h) => (
                <div key={h.messageId} className="palette-item search-result chat-hit">
                  <span className="palette-item-label">
                    <span className={`role-tag role-${h.role}`}>{h.role}</span>
                    <span className="search-time">
                      {new Date(h.createdAt).toLocaleString()}
                    </span>
                  </span>
                  <span className="search-snippet">{h.text}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
