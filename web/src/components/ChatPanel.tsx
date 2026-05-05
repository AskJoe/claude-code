import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { renderMarkdown } from "../lib/markdown.tsx";
import { exportSessionUrl } from "../lib/api.ts";
import type { ChatItem, LabState } from "../lib/useLabSession.ts";
import { ToolCallBlock } from "./ToolCallBlock.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { COMMANDS, type Command, type CommandContext } from "../lib/commands.ts";

type QueuedUpload = {
  id: string;
  file: File;
  uploadedPath?: string;
  uploading: boolean;
  error?: string;
  /** object URL for image preview chip; revoked when chip leaves the queue */
  previewUrl?: string;
};

type Props = {
  status: LabState["status"];
  chat: ChatItem[];
  cumulativeCostUsd: number;
  budgetUsd: number;
  projectId: number;
  sessionId: string | null;
  onSend: (text: string) => void;
  onAbort: () => void;
  onReset: () => void;
  /** Optional handlers wired by App.tsx for the command palette. */
  onSetRightView?: (v: "preview" | "code") => void;
  onSetTheme?: (t: "light" | "dark" | "system") => void;
  onShowShortcuts?: () => void;
  onShowHistory?: () => void;
  onSystemMessage?: (text: string) => void;
  /** Optional initial draft text. When this prop changes (welcome modal click,
   *  sample-prompt button, future command palette), it gets dropped into the
   *  textarea so the user can edit before sending. Does NOT auto-send. */
  prefilledPrompt?: string;
  /** Bumped each time the parent pushes a new prefilled prompt, so identical
   *  text twice in a row still triggers the effect. */
  prefilledNonce?: number;
};

const MAX_LINES = 12;

const SAMPLE_PROMPTS = [
  "Make a one-page coffee shop landing site",
  "Build a personal portfolio with a hero and a contact form",
  "Add a blog with three posts about web design",
  "Make a dark-themed product page for a SaaS app",
];

export function ChatPanel({
  status,
  chat,
  cumulativeCostUsd,
  budgetUsd,
  projectId,
  sessionId,
  onSend,
  onAbort,
  onReset,
  onSetRightView,
  onSetTheme,
  onShowShortcuts,
  onShowHistory,
  onSystemMessage,
  prefilledPrompt,
  prefilledNonce,
}: Props) {
  const [draft, setDraft] = useState(prefilledPrompt ?? "");
  const [uploads, setUploads] = useState<QueuedUpload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Counts nested drag-enter/leave so child elements don't flicker the overlay.
  const dragCounter = useRef(0);

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

  // Whenever the parent passes a new prefilled prompt (welcome modal click,
  // sample-prompt button, future command palette), drop it into the draft and
  // focus the textarea so the user can edit before sending. The nonce is
  // bumped on every push so two pushes of the same text still re-fire.
  useEffect(() => {
    if (prefilledPrompt && prefilledPrompt.trim()) {
      setDraft(prefilledPrompt);
      const id = window.setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          const len = el.value.length;
          try {
            el.setSelectionRange(len, len);
          } catch {}
        }
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [prefilledPrompt, prefilledNonce]);

  // Auto-grow textarea up to MAX_LINES.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const styles = window.getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight) || 20;
    const padTop = parseFloat(styles.paddingTop) || 0;
    const padBottom = parseFloat(styles.paddingBottom) || 0;
    const max = lineHeight * MAX_LINES + padTop + padBottom;
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [draft]);

  // Revoke leftover object URLs on unmount.
  useEffect(() => {
    return () => {
      uploads.forEach((u) => {
        if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputDisabled =
    status === "thinking" ||
    status === "connecting" ||
    status === "closed" ||
    status === "exhausted";

  const submit = useCallback(
    (evt?: FormEvent) => {
      if (evt && "preventDefault" in evt) evt.preventDefault();
      if (status === "thinking" || status === "exhausted") return;
      const ready = uploads.filter((u) => u.uploadedPath);
      let text = draft.trim();
      if (ready.length > 0) {
        const list = ready.map((u) => `- ${u.uploadedPath}`).join("\n");
        const header = `[Attached files in this turn:\n${list}]`;
        text = text ? `${header}\n\n${text}` : header;
      }
      if (!text) return;
      onSend(text);
      setDraft("");
      uploads.forEach((u) => u.previewUrl && URL.revokeObjectURL(u.previewUrl));
      setUploads([]);
    },
    [draft, uploads, onSend, status]
  );

  // ── Uploads ────────────────────────────────────────────────────────────────

  const uploadFile = useCallback(
    async (file: File) => {
      const tmpId = `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const isImage = file.type.startsWith("image/");
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      setUploads((u) => [
        ...u,
        { id: tmpId, file, uploading: true, previewUrl },
      ]);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/api/projects/${projectId}/upload`, {
          method: "POST",
          credentials: "same-origin",
          body: fd,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as { path: string };
        setUploads((u) =>
          u.map((x) =>
            x.id === tmpId
              ? { ...x, uploading: false, uploadedPath: json.path }
              : x
          )
        );
      } catch (err: any) {
        setUploads((u) =>
          u.map((x) =>
            x.id === tmpId
              ? { ...x, uploading: false, error: err?.message ?? "upload failed" }
              : x
          )
        );
      }
    },
    [projectId]
  );

  const handleFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      const arr = Array.from(files);
      arr.forEach((f) => uploadFile(f));
    },
    [uploadFile]
  );

  const removeUpload = (id: string) => {
    setUploads((u) => {
      const target = u.find((x) => x.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return u.filter((x) => x.id !== id);
    });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  };

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  };
  const onDragEnter = (e: DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      dragCounter.current += 1;
      setDragOver(true);
    }
  };
  const onDragLeave = (e: DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragOver(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    }
  };

  // ── Command palette ────────────────────────────────────────────────────────

  const notify = useCallback(
    (text: string) => {
      // eslint-disable-next-line no-console
      console.log("[command]", text);
      onSystemMessage?.(text);
    },
    [onSystemMessage]
  );

  const copyLastAssistant = useCallback(async () => {
    const last = [...chat].reverse().find((it) => it.kind === "agent-text") as
      | (ChatItem & { kind: "agent-text" })
      | undefined;
    if (!last) {
      notify("No assistant message to copy yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(last.text);
      notify("Copied last assistant message.");
    } catch {
      notify("Could not copy — clipboard unavailable.");
    }
  }, [chat, notify]);

  const exportTranscript = useCallback(
    (format: "markdown" | "json") => {
      // Hits /api/projects/:id/sessions/:sid/export. Browser respects the
      // server's Content-Disposition header and downloads the file. The sid
      // is the live sessionId when available, "default" otherwise — the
      // server treats both as "the project's full transcript" until the
      // multi-session sidebar lands.
      const sid = sessionId ?? "default";
      window.location.href = exportSessionUrl(projectId, sid, format);
    },
    [projectId, sessionId]
  );

  const cmdContext: CommandContext = useMemo(
    () => ({
      reset: onReset,
      clearChat: () => {
        notify("Clearing chat — this currently routes to /reset.");
        onReset();
      },
      setRightView: (v) => {
        if (onSetRightView) onSetRightView(v);
        else notify(`Switch view: ${v} — not yet wired`);
      },
      setTheme: (t) => {
        if (onSetTheme) onSetTheme(t);
        else notify(`Theme: ${t} — not yet wired`);
      },
      exportTranscript,
      showShortcuts: () => {
        if (onShowShortcuts) onShowShortcuts();
        else notify("Shortcuts overlay — not yet wired");
      },
      copyLastAssistant,
      showHistory: () => {
        if (onShowHistory) onShowHistory();
        else notify("History panel — not yet wired");
      },
      notify,
    }),
    [
      onReset,
      onSetRightView,
      onSetTheme,
      onShowShortcuts,
      onShowHistory,
      copyLastAssistant,
      exportTranscript,
      notify,
    ]
  );

  const pickCommand = useCallback(
    (cmd: Command) => {
      setPaletteOpen(false);
      cmd.action(cmdContext);
    },
    [cmdContext]
  );

  // ⌘K opens palette; ⌘. aborts when thinking. Both fire even from inputs
  // because they require the modifier key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((p) => !p);
        return;
      }
      if (isMod && e.key === ".") {
        if (status === "thinking") {
          e.preventDefault();
          onAbort();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, onAbort]);

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
              title="Stop the agent's current turn (⌘.)"
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
          <ChatEmpty
            onSample={(text) => {
              setDraft(text);
              const el = textareaRef.current;
              if (el) {
                el.focus();
                try {
                  el.setSelectionRange(text.length, text.length);
                } catch {}
              }
            }}
          />
        )}
        {chat.map((item) => (
          <ChatRow key={item.id} item={item} />
        ))}
      </div>

      <form
        className={`chat-input ${dragOver ? "drag-over" : ""}`}
        onSubmit={submit}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="dropzone-overlay" aria-hidden>
            <div className="dropzone-headline">Drop files to attach</div>
          </div>
        )}

        {uploads.length > 0 && (
          <div className="upload-chips">
            {uploads.map((u) => (
              <UploadChip key={u.id} u={u} onRemove={() => removeUpload(u.id)} />
            ))}
          </div>
        )}

        <div className="chat-input-row">
          <button
            type="button"
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
            aria-label="Attach file"
            disabled={inputDisabled}
          >
            📎
          </button>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            multiple
            onChange={(e) => {
              handleFiles(e.target.files);
              // Reset so picking the same file twice still fires.
              e.target.value = "";
            }}
          />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // `/` at start of empty textarea opens palette.
              if (e.key === "/" && draft === "") {
                e.preventDefault();
                setPaletteOpen(true);
                return;
              }
              // Cmd+Enter sends (in addition to plain Enter).
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={onPaste}
            placeholder={inputPlaceholder(status)}
            rows={3}
            disabled={inputDisabled}
          />
          <button
            type="submit"
            disabled={
              inputDisabled ||
              (!draft.trim() && uploads.filter((u) => u.uploadedPath).length === 0)
            }
          >
            Send
          </button>
        </div>
      </form>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={COMMANDS}
        onPick={pickCommand}
      />
    </div>
  );
}

function UploadChip({
  u,
  onRemove,
}: {
  u: QueuedUpload;
  onRemove: () => void;
}) {
  const sizeLabel = formatBytes(u.file.size);
  const isImage = u.file.type.startsWith("image/");
  const stateClass = u.error
    ? "upload-chip error"
    : u.uploading
      ? "upload-chip uploading"
      : "upload-chip ok";
  return (
    <div className={stateClass} title={u.error ?? u.file.name}>
      {isImage && u.previewUrl ? (
        <img className="upload-thumb" src={u.previewUrl} alt="" />
      ) : (
        <span className="upload-icon" aria-hidden>📎</span>
      )}
      <span className="upload-name">{u.file.name}</span>
      <span className="upload-meta">
        {u.uploading ? "uploading…" : u.error ? "failed" : sizeLabel}
      </span>
      <button
        type="button"
        className="upload-remove"
        onClick={onRemove}
        aria-label="Remove attachment"
      >
        ✕
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
      return "Type a message — Enter or ⌘↵ to send, ⇧↵ for newline, / for commands";
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
          <ToolCallBlock tool={item.tool} input={item.input} result={item.result} />
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

function ChatEmpty({ onSample }: { onSample: (text: string) => void }) {
  return (
    <div className="empty-state chat-empty-rich">
      <h2 className="empty-headline">Ask the agent to build something.</h2>
      <p className="empty-body">
        Pick a starter below or write your own. The agent will create the files
        and rebuild the preview as it goes.
      </p>
      <div className="sample-prompts">
        {SAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            className="sample-prompt"
            onClick={() => onSample(p)}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
