/**
 * Past-conversations sidebar. Lists chat sessions for the current project —
 * the live session at the top, then archived ones. Clicking a session opens
 * a read-only viewer modal with that conversation's messages.
 *
 * Reset (in ChatPanel header) archives the live session and starts a new
 * one, so the sidebar grows over time.
 */

import { useEffect, useState } from "react";
import { api, type ChatSessionSummary } from "../lib/api.ts";
import { renderMarkdown } from "../lib/markdown.tsx";

type Props = {
  projectId: number;
  open: boolean;
  onClose: () => void;
  /** Bumped every time a turn ends in the active chat — drives auto-refresh
   *  so the sidebar's live row reflects the latest count/cost. */
  bumpKey?: number | string;
};

export function SessionsSidebar({ projectId, open, onClose, bumpKey }: Props) {
  const [sessions, setSessions] = useState<ChatSessionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<number | null>(null);

  // Fetch on open and on bumpKey change so the live row updates as the
  // current conversation grows. Cheap call (~1 SQL select).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listChatSessions(projectId)
      .then(({ sessions: list }) => {
        if (!cancelled) setSessions(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "could not load sessions");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, bumpKey]);

  // Esc closes (only if no archived viewer is open).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openSessionId !== null) {
        setOpenSessionId(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, openSessionId]);

  if (!open) return null;

  return (
    <>
      <div className="sessions-sidebar-backdrop" onMouseDown={onClose} />
      <aside className="sessions-sidebar" aria-label="Past conversations">
        <header className="sessions-sidebar-header">
          <h2 className="sessions-sidebar-title">Past chats</h2>
          <button
            type="button"
            className="sessions-sidebar-close"
            onClick={onClose}
            aria-label="Close past chats"
          >
            ✕
          </button>
        </header>
        <div className="sessions-sidebar-body">
          {loading && (
            <div className="sessions-sidebar-empty">Loading…</div>
          )}
          {error && (
            <div className="sessions-sidebar-empty">Error: {error}</div>
          )}
          {sessions && sessions.length === 0 && (
            <div className="sessions-sidebar-empty">
              No chat sessions yet. As you talk to the agent, conversations
              get archived here whenever you click Reset.
            </div>
          )}
          {sessions?.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onOpen={() => {
                if (s.archived) setOpenSessionId(s.id);
              }}
            />
          ))}
        </div>
      </aside>
      {openSessionId !== null && (
        <ArchivedSessionViewer
          projectId={projectId}
          sessionId={openSessionId}
          onClose={() => setOpenSessionId(null)}
        />
      )}
    </>
  );
}

function SessionCard({
  session,
  onOpen,
}: {
  session: ChatSessionSummary;
  onOpen: () => void;
}) {
  const display = session.title || (session.archived ? "Archived chat" : "Current chat");
  const time = relativeTime(session.lastMessageAt ?? session.createdAt);
  return (
    <button
      type="button"
      className={`session-card${session.archived ? "" : " session-card-active"}`}
      onClick={onOpen}
      disabled={!session.archived}
      title={session.archived ? "View this archived conversation" : "Active chat — visible in the main panel"}
    >
      <div className="session-card-row">
        <span className="session-card-title">{display}</span>
        {!session.archived && (
          <span className="session-card-badge">Active</span>
        )}
      </div>
      <div className="session-card-meta">
        <span>{session.messageCount} msgs</span>
        <span className="sep">·</span>
        <span>${session.totalCostUsd.toFixed(2)}</span>
        <span className="sep">·</span>
        <span title={session.lastMessageAt ?? session.createdAt}>{time}</span>
      </div>
    </button>
  );
}

function ArchivedSessionViewer({
  projectId,
  sessionId,
  onClose,
}: {
  projectId: number;
  sessionId: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    session: ChatSessionSummary;
    messages: Array<Record<string, unknown>>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getChatSessionMessages(projectId, sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "load failed");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId]);

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="dialog" aria-modal>
      <div
        className="palette-modal palette-modal-wide archived-viewer"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="archived-viewer-header">
          <span className="archived-viewer-title">
            {data?.session.title || "Archived chat"}
          </span>
          <span className="archived-viewer-meta">
            {data ? `${data.session.messageCount} msgs · $${data.session.totalCostUsd.toFixed(2)}` : ""}
          </span>
          <button
            type="button"
            className="archived-viewer-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="archived-viewer-body">
          {error && <div className="palette-empty">Error: {error}</div>}
          {!error && !data && <div className="palette-empty">Loading…</div>}
          {data?.messages.length === 0 && (
            <div className="palette-empty">This conversation is empty.</div>
          )}
          {data?.messages.map((m, i) => (
            <ArchivedRow key={i} event={m} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ArchivedRow({ event }: { event: Record<string, unknown> }) {
  const type = String(event.type ?? "");
  if (type === "chat:user_message") {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">{String(event.text ?? "")}</div>
      </div>
    );
  }
  if (type === "agent:text") {
    return (
      <div className="row row-agent">
        <div className="bubble bubble-agent md">
          {renderMarkdown(String(event.text ?? ""))}
        </div>
      </div>
    );
  }
  if (type === "agent:turn_end") {
    const cost = typeof event.cost === "number" ? event.cost : 0;
    const dur =
      typeof event.durationMs === "number" ? event.durationMs / 1000 : 0;
    return (
      <div className="row row-turn-end">
        <span className="turn-end">
          {dur.toFixed(1)}s · ${cost.toFixed(4)}
        </span>
      </div>
    );
  }
  if (type === "agent:tool_use") {
    const tool = String(event.tool ?? "tool");
    return (
      <div className="row row-tool">
        <div className="tool-call">
          <span className="tool-name">{tool}</span>
        </div>
      </div>
    );
  }
  if (type === "system" || type === "agent:error") {
    return (
      <div className="row row-system">
        <span className="system-line">
          {String(event.text ?? event.message ?? "")}
        </span>
      </div>
    );
  }
  return null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hr ago`;
  if (sec < 86400 * 30) return `${Math.round(sec / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
