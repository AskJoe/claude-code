import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { renderMarkdown } from "../lib/markdown.tsx";
import { exportSessionUrl } from "../lib/api.ts";
import type { ChatItem, LabState } from "../lib/useLabSession.ts";
import type {
  AdvisorModel,
  ExecutorModel,
} from "../../../shared/events.ts";
import {
  PRESETS,
  loadPresetId,
  savePresetId,
  getPreset,
  type Preset,
  type PresetId,
} from "../lib/models.ts";
import { ToolCallBlock } from "./ToolCallBlock.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { COMMANDS, type Command, type CommandContext } from "../lib/commands.ts";

const VIRTUAL_THRESHOLD = 50;

type QueuedUpload = {
  id: string;
  file: File;
  uploadedPath?: string;
  uploading: boolean;
  error?: string;
  /** object URL for image preview chip; revoked when chip leaves the queue */
  previewUrl?: string;
  /** server-side thumb URL once the upload returns. Prefers the WebP variant
   * the server generates for PNG/JPEG; falls back to the original URL.
   * Replaces previewUrl in the chip thumb once available. */
  serverThumbUrl?: string;
};

type Props = {
  status: LabState["status"];
  chat: ChatItem[];
  cumulativeCostUsd: number;
  /** Cost split when an Opus advisor was active. Both default to the total
   *  when omitted (advisor never invoked). */
  cumulativeExecutorCostUsd?: number;
  cumulativeAdvisorCostUsd?: number;
  /** Total advisor sub-inferences fired this session — drives the
   *  per-conversation cap surface. */
  advisorCallsThisSession?: number;
  budgetUsd: number;
  projectId: number;
  sessionId: string | null;
  /** Per-minute send cap from server's `session:ready`. The pill in the
   *  header surfaces only when the user is approaching this limit. */
  rateLimitPerMinute?: number;
  onSend: (text: string) => void;
  onAbort: () => void;
  onReset: () => void;
  /** Pushes the user's chosen executor+advisor pair to the server (no-op
   *  for the running agent; applies on next session). When omitted the
   *  preset pill is hidden. */
  onSetPreset?: (executor: ExecutorModel, advisor: AdvisorModel) => void;
  /** Optional handlers wired by App.tsx for the command palette. */
  onSetRightView?: (v: "preview" | "code") => void;
  onSetTheme?: (t: "light" | "dark" | "system") => void;
  onShowShortcuts?: () => void;
  onShowHistory?: () => void;
  onShowSettings?: () => void;
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
  cumulativeExecutorCostUsd,
  cumulativeAdvisorCostUsd,
  advisorCallsThisSession,
  budgetUsd,
  projectId,
  sessionId,
  rateLimitPerMinute,
  onSend,
  onAbort,
  onReset,
  onSetPreset,
  onSetRightView,
  onSetTheme,
  onShowShortcuts,
  onShowHistory,
  onShowSettings,
  onSystemMessage,
  prefilledPrompt,
  prefilledNonce,
}: Props) {
  const [draft, setDraft] = useState(prefilledPrompt ?? "");
  const [uploads, setUploads] = useState<QueuedUpload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [presetId, setPresetId] = useState<PresetId>(() => loadPresetId());
  const [presetPopoverOpen, setPresetPopoverOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [rateUsage, setRateUsage] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const presetPillRef = useRef<HTMLDivElement>(null);
  // Counts nested drag-enter/leave so child elements don't flicker the overlay.
  const dragCounter = useRef(0);
  // Sliding-window timestamps of recent user sends (last 60s).
  const sendTimestampsRef = useRef<number[]>([]);

  // Reset banner dismissed state when sessionId changes (new session).
  useEffect(() => {
    setBannerDismissed(false);
  }, [sessionId]);

  // Recalculate the rate-usage pill every 2s — prune old timestamps and
  // surface the current count. Cheap; only ticks while ChatPanel is mounted.
  useEffect(() => {
    const id = window.setInterval(() => {
      const cutoff = Date.now() - 60_000;
      sendTimestampsRef.current = sendTimestampsRef.current.filter(
        (t) => t >= cutoff
      );
      setRateUsage(sendTimestampsRef.current.length);
    }, 2_000);
    return () => window.clearInterval(id);
  }, []);

  // Click-outside closes the preset popover.
  useEffect(() => {
    if (!presetPopoverOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = presetPillRef.current;
      if (el && !el.contains(e.target as Node)) setPresetPopoverOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [presetPopoverOpen]);

  // Virtualize once the transcript gets long. Below 50 items the plain map is
  // faster (no measurement overhead) and avoids any visual jitter.
  const useVirtual = chat.length >= VIRTUAL_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: chat.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 80,
    overscan: 8,
  });

  // Track total visible text length so streamed chunks (which don't change
  // chat.length) still trigger an autoscroll.
  const chatBodyLen = chat.reduce((n, item) => {
    if (item.kind === "agent-text" || item.kind === "user") return n + item.text.length;
    return n;
  }, 0);

  useEffect(() => {
    if (useVirtual) {
      if (chat.length > 0) {
        virtualizer.scrollToIndex(chat.length - 1, { align: "end" });
      }
      return;
    }
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, chatBodyLen, useVirtual, virtualizer]);

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
      sendTimestampsRef.current.push(Date.now());
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
        const json = (await res.json()) as {
          path: string;
          url: string;
          variant?: { webpPath: string; webpUrl: string };
        };
        const serverThumbUrl = json.variant?.webpUrl ?? json.url;
        setUploads((u) =>
          u.map((x) =>
            x.id === tmpId
              ? {
                  ...x,
                  uploading: false,
                  uploadedPath: json.path,
                  serverThumbUrl,
                }
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
      showSettings: () => {
        if (onShowSettings) onShowSettings();
        else notify("Settings — not yet wired");
      },
      notify,
    }),
    [
      onReset,
      onSetRightView,
      onSetTheme,
      onShowShortcuts,
      onShowHistory,
      onShowSettings,
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

  // Threshold banner — visible only between 80% and 99% of budget. The hard
  // stop at 100% is already handled by status === "exhausted" elsewhere.
  const budgetPct =
    budgetUsd > 0 ? cumulativeCostUsd / budgetUsd : 0;
  const showBudgetBanner =
    !bannerDismissed &&
    status !== "exhausted" &&
    budgetPct >= 0.8 &&
    budgetPct < 1.0;

  // Rate pill — surface when within 80% of the per-minute send cap, hide
  // otherwise. When at the cap, paint with the amber-bg fill.
  const rateCap = rateLimitPerMinute ?? 0;
  const showRate = rateCap > 0 && rateUsage / rateCap >= 0.8;

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="chat-title">Chat</span>
        <div className="chat-header-right">
          {showRate && (
            <span
              className={`rate-pill ${rateUsage >= rateCap ? "rate-pill-cap" : ""}`}
              title="User messages sent in the last 60 seconds"
            >
              {rateUsage}/{rateCap} msgs/min
            </span>
          )}
          <CostMeter
            spent={cumulativeCostUsd}
            executor={cumulativeExecutorCostUsd}
            advisor={cumulativeAdvisorCostUsd}
            budget={budgetUsd}
            advisorActive={getPreset(presetId).advisor !== null}
          />
          {onSetPreset && (
            <PresetPill
              ref={presetPillRef}
              choice={presetId}
              open={presetPopoverOpen}
              onToggle={() => setPresetPopoverOpen((o) => !o)}
              onPick={(p) => {
                setPresetId(p.id);
                savePresetId(p.id);
                onSetPreset(p.executor, p.advisor);
                setPresetPopoverOpen(false);
                if (onSystemMessage) {
                  onSystemMessage(
                    `Preset set to ${p.label}. Applies on next session — click Reset to apply now.`
                  );
                }
              }}
            />
          )}
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

      {showBudgetBanner && (
        <div className="budget-banner" role="status">
          <span className="budget-banner-icon" aria-hidden>
            ⚠
          </span>
          <span className="budget-banner-text">
            You've used {Math.round(budgetPct * 100)}% of today's budget.
            Consider switching to a Frugal preset, disabling the advisor, or
            pausing.
          </span>
          <button
            type="button"
            className="budget-banner-dismiss"
            onClick={() => setBannerDismissed(true)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

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
        {useVirtual ? (
          <div
            className="chat-virtual-spacer"
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const item = chat[vi.index];
              if (!item) return null;
              return (
                <div
                  key={item.id}
                  data-vindex={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <ChatRow item={item} />
                </div>
              );
            })}
          </div>
        ) : (
          chat.map((item) => <ChatRow key={item.id} item={item} />)
        )}
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
      {isImage && (u.serverThumbUrl || u.previewUrl) ? (
        <img
          className="upload-thumb"
          src={u.serverThumbUrl ?? u.previewUrl}
          alt=""
        />
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

function CostMeter({
  spent,
  executor,
  advisor,
  budget,
  advisorActive,
}: {
  spent: number;
  executor?: number;
  advisor?: number;
  budget: number;
  advisorActive: boolean;
}) {
  const pct = Math.min(100, Math.round((spent / Math.max(budget, 0.01)) * 100));
  const tone = pct >= 90 ? "danger" : pct >= 60 ? "warn" : "ok";
  const exec = typeof executor === "number" ? executor : spent;
  const adv = typeof advisor === "number" ? advisor : 0;
  const tooltipParts = [
    `Session cost: $${spent.toFixed(4)} of $${budget.toFixed(2)} budget.`,
  ];
  if (advisorActive || adv > 0) {
    tooltipParts.push(
      `Executor: $${exec.toFixed(4)}  ·  Advisor (Opus 4.7): $${adv.toFixed(4)}`
    );
  }
  return (
    <div className="cost-meter-wrap" title={tooltipParts.join("\n")}>
      <span className={`cost-meter cost-meter-${tone}`}>
        ${spent.toFixed(2)} / ${budget.toFixed(2)}
      </span>
      <div className="cost-bar" aria-hidden>
        <div
          className={`cost-bar-fill cost-bar-fill-${tone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {(advisorActive || adv > 0) && spent > 0 && (
        <div className="cost-split" aria-hidden>
          <span className="cost-split-exec">
            ex ${exec.toFixed(2)}
          </span>
          <span className="cost-split-sep">·</span>
          <span className="cost-split-adv">
            adv ${adv.toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}

const PresetPill = forwardRef<
  HTMLDivElement,
  {
    choice: PresetId;
    open: boolean;
    onToggle: () => void;
    onPick: (p: Preset) => void;
  }
>(function PresetPill({ choice, open, onToggle, onPick }, ref) {
  const current = getPreset(choice);
  return (
    <div className="model-pill-wrap" ref={ref}>
      <button
        type="button"
        className={`model-pill${current.advisor ? " model-pill-advised" : ""}`}
        onClick={onToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change executor + advisor preset (applies on next session)"
      >
        <span>{current.label}</span>
        {current.advisor && <span className="advisor-tag" aria-hidden>+adv</span>}
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="model-popover model-popover-wide" role="listbox">
          {PRESETS.map((p) => (
            <label
              key={p.id}
              className={`model-option model-option-preset${p.id === choice ? " active" : ""}`}
            >
              <input
                type="radio"
                name="preset-choice"
                checked={p.id === choice}
                onChange={() => onPick(p)}
              />
              <span className="model-option-body">
                <span className="model-option-label">
                  {p.label}
                  {p.recommended && (
                    <span className="recommended-badge">Recommended</span>
                  )}
                </span>
                <span className="model-option-hint">{p.hint}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
});

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
