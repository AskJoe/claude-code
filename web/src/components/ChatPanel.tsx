import { useEffect, useRef, useState, type FormEvent } from "react";
import { renderMarkdown } from "../lib/markdown.tsx";
import type { ChatItem, LabState } from "../lib/useLabSession.ts";

type Props = {
  status: LabState["status"];
  chat: ChatItem[];
  cumulativeCostUsd: number;
  budgetUsd: number;
  onSend: (text: string) => void;
  onAbort: () => void;
  onReset: () => void;
};

export function ChatPanel({
  status,
  chat,
  cumulativeCostUsd,
  budgetUsd,
  onSend,
  onAbort,
  onReset,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Track total visible text length so streamed chunks (which don't change
  // chat.length) still trigger an autoscroll.
  const chatBodyLen = chat.reduce((n, item) => {
    if (item.kind === "agent-text" || item.kind === "user") return n + item.text.length;
    return n;
  }, 0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, chatBodyLen]);

  const submit = (evt: FormEvent) => {
    evt.preventDefault();
    if (status === "thinking" || status === "exhausted") return;
    onSend(draft);
    setDraft("");
  };

  const inputDisabled =
    status === "thinking" ||
    status === "connecting" ||
    status === "closed" ||
    status === "exhausted";

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="chat-title">Chat</span>
        <div className="chat-header-right">
          <CostMeter spent={cumulativeCostUsd} budget={budgetUsd} />
          {status === "thinking" ? (
            <button
              type="button"
              className="header-btn header-btn-stop"
              onClick={onAbort}
              title="Stop the agent's current turn"
            >
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              className="header-btn"
              onClick={onReset}
              disabled={status === "connecting" || status === "closed"}
              title="Clear the session — files removed, conversation reset"
            >
              ↻ Reset
            </button>
          )}
          <StatusPill status={status} />
        </div>
      </div>

      <div className="chat-scroll" ref={scrollerRef}>
        {chat.length === 0 && (
          <div className="chat-empty">
            Ask the agent to build something. Try:{" "}
            <em>"Make a one-page coffee shop landing site"</em>
          </div>
        )}
        {chat.map((item) => (
          <ChatRow key={item.id} item={item} />
        ))}
      </div>

      <form className="chat-input" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(e);
            }
          }}
          placeholder={inputPlaceholder(status)}
          rows={3}
          disabled={inputDisabled}
        />
        <button type="submit" disabled={inputDisabled || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function inputPlaceholder(status: LabState["status"]): string {
  switch (status) {
    case "connecting":
      return "connecting…";
    case "closed":
      return "session closed — refresh to reconnect";
    case "exhausted":
      return "budget reached — click Reset for a new session";
    default:
      return "Type a message — Enter to send, Shift+Enter for newline";
  }
}

function ChatRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="row row-user">
          <div className="bubble bubble-user">{item.text}</div>
        </div>
      );

    case "agent-text":
      return (
        <div className="row row-agent">
          <div
            className={`bubble bubble-agent md${item.streaming ? " bubble-streaming" : ""}`}
          >
            {renderMarkdown(item.text)}
            {item.streaming ? <span className="stream-cursor" aria-hidden /> : null}
          </div>
        </div>
      );

    case "tool-call":
      return (
        <div className="row row-tool">
          <div className="tool-call">
            <span className="tool-name">{item.tool}</span>
            <span className="tool-input">{summarizeInput(item.input)}</span>
            {item.result ? (
              <span className={`tool-result ${item.result.ok ? "ok" : "err"}`}>
                {item.result.ok ? "✓" : "✗"}{" "}
                {item.result.preview.split("\n")[0]?.slice(0, 80) ?? ""}
              </span>
            ) : (
              <span className="tool-result running">…running</span>
            )}
          </div>
        </div>
      );

    case "turn-end":
      return (
        <div className="row row-turn-end">
          <span className="turn-end">
            {item.subtype === "success" ? "✓" : "⚠"} {(item.durationMs / 1000).toFixed(1)}s · ${item.cost.toFixed(4)} ·
            {" "}
            {item.inputTokens} in / {item.outputTokens} out · session total ${item.cumulativeCostUsd.toFixed(2)}
          </span>
        </div>
      );

    case "aborted":
      return (
        <div className="row row-turn-end">
          <span className="turn-end aborted">■ stopped</span>
        </div>
      );

    case "system":
      return (
        <div className="row row-system">
          <span className="system-line">{item.text}</span>
        </div>
      );

    case "error":
      return (
        <div className="row row-error">
          <div className="bubble bubble-error">⚠ {item.message}</div>
        </div>
      );
  }
}

function summarizeInput(input: unknown): string {
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

function CostMeter({ spent, budget }: { spent: number; budget: number }) {
  const pct = Math.min(100, Math.round((spent / Math.max(budget, 0.01)) * 100));
  const className =
    pct >= 90 ? "cost-meter danger" : pct >= 60 ? "cost-meter warn" : "cost-meter";
  return (
    <span className={className} title={`session cost: $${spent.toFixed(4)} of $${budget.toFixed(2)} budget`}>
      ${spent.toFixed(2)} / ${budget.toFixed(2)}
    </span>
  );
}

function StatusPill({ status }: { status: LabState["status"] }) {
  const labels: Record<LabState["status"], string> = {
    connecting: "connecting",
    ready: "ready",
    thinking: "thinking…",
    closed: "closed",
    error: "error",
    exhausted: "budget reached",
  };
  return <span className={`status status-${status}`}>{labels[status]}</span>;
}
