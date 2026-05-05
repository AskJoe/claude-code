import { useEffect, useRef, useState } from "react";
import { api, type AdminMessage, type AdminProject, type AdminUser } from "../lib/api.ts";
import { renderMarkdown } from "../lib/markdown.tsx";

type Props = {
  projectId: number;
  onExit: () => void;
};

/**
 * Admin's read-only view of a student's project: their full chat transcript,
 * project metadata, and a link to view the build preview. No agent, no input,
 * no risk of overwriting their data.
 */
export function AdminProjectView({ projectId, onExit }: Props) {
  const [project, setProject] = useState<AdminProject | null>(null);
  const [owner, setOwner] = useState<AdminUser | null>(null);
  const [messages, setMessages] = useState<AdminMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      api.adminGetProject(projectId),
      api.adminGetMessages(projectId),
    ])
      .then(([{ project, owner }, { messages }]) => {
        setProject(project);
        setOwner(owner);
        setMessages(messages);
      })
      .catch((err) => setError(err?.message ?? String(err)));
  }, [projectId]);

  if (error) return <div className="admin-error">⚠ {error}</div>;
  if (!project || !messages) return <div className="admin-empty">Loading…</div>;

  return (
    <div className="layout">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="brand brand-link" onClick={onExit}>
            ← Admin
          </button>
          <span className="topbar-project">
            {project.displayName}
            {owner && (
              <span className="dim"> · {owner.email}</span>
            )}
          </span>
          <span className="pill admin-readonly-pill">read-only</span>
        </div>
        <div className="topbar-meta">
          {project.github.connected && (
            <a
              className="link-button"
              href={`https://github.com/${project.github.repoFullName}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {project.github.repoFullName} ↗
            </a>
          )}
        </div>
      </header>

      <main className="admin-readonly-body">
        <div className="admin-readonly-meta">
          <div>
            <strong>Slug:</strong> <code>{project.slug}</code>
          </div>
          <div>
            <strong>Created:</strong>{" "}
            {new Date(project.createdAt).toLocaleString()}
          </div>
          <div>
            <strong>Last active:</strong>{" "}
            {new Date(project.lastActiveAt).toLocaleString()}
          </div>
          <div>
            <strong>Messages:</strong> {messages.length}
          </div>
        </div>

        <div className="admin-readonly-chat" ref={scrollerRef}>
          {messages.length === 0 && (
            <div className="admin-empty">No conversation yet.</div>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} m={m} />
          ))}
        </div>
      </main>
    </div>
  );
}

function MessageRow({ m }: { m: AdminMessage }) {
  let parsed: any = null;
  try {
    parsed = JSON.parse(m.content_json);
  } catch {
    return (
      <div className="row row-error">
        <div className="bubble bubble-error">
          ⚠ unparseable message #{m.id}
        </div>
      </div>
    );
  }

  switch (parsed.type) {
    case "chat:user_message":
      return (
        <div className="row row-user">
          <div className="bubble bubble-user">{parsed.text}</div>
        </div>
      );
    case "agent:text":
      return (
        <div className="row row-agent">
          <div className="bubble bubble-agent md">
            {renderMarkdown(parsed.text)}
          </div>
        </div>
      );
    case "agent:tool_use":
      return (
        <div className="row row-tool">
          <div className="tool-call">
            <span className="tool-name">{parsed.tool}</span>
            <span className="tool-input">{summarize(parsed.input)}</span>
          </div>
        </div>
      );
    case "agent:tool_result":
      return (
        <div className="row row-tool">
          <div className="tool-call">
            <span className="tool-name dim">↩</span>
            <span className="tool-input">
              {(parsed.preview ?? "").slice(0, 120)}
            </span>
          </div>
        </div>
      );
    case "agent:turn_end":
      return (
        <div className="row row-turn-end">
          <span className="turn-end">
            ✓ {(parsed.durationMs / 1000).toFixed(1)}s · ${parsed.cost?.toFixed(4)} ·{" "}
            {parsed.inputTokens} in / {parsed.outputTokens} out
          </span>
        </div>
      );
    case "agent:turn_aborted":
      return (
        <div className="row row-turn-end">
          <span className="turn-end aborted">■ stopped</span>
        </div>
      );
    case "agent:error":
      return (
        <div className="row row-error">
          <div className="bubble bubble-error">⚠ {parsed.message}</div>
        </div>
      );
    default:
      return null;
  }
}

function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === "string") return i.file_path;
  if (typeof i.path === "string") return i.path;
  if (typeof i.command === "string") {
    const c = i.command;
    return c.length > 60 ? c.slice(0, 60) + "…" : c;
  }
  return "";
}
