/**
 * One WebSocket → one lab session. Holds the chat log, file tree, and a status
 * field, and exposes a send() to queue user messages.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdvisorModel,
  ClientCommand,
  ExecutorModel,
  FileNode,
  ModelKey,
  ServerEvent,
} from "../../../shared/events.ts";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "agent-text";
      id: string;
      text: string;
      /** SDK message uuid — present on streamed messages, used to reconcile chunks with the final assistant text. */
      messageUuid?: string;
      /** True while text deltas are still arriving for this message. Cleared when the final `agent:text` lands. */
      streaming?: boolean;
    }
  | {
      kind: "tool-call";
      id: string;
      tool: string;
      input: unknown;
      result?: { ok: boolean; preview: string };
    }
  | {
      kind: "turn-end";
      id: string;
      cost: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      subtype: string;
      cumulativeCostUsd: number;
    }
  | { kind: "aborted"; id: string }
  | { kind: "system"; id: string; text: string }
  | { kind: "error"; id: string; message: string };

export type LabMode = "code" | "plan";

export type UseLabSessionOptions = {
  /**
   * "code" (default) — agent has full Claude Code toolkit and can
   * modify files freely. "plan" — agent is read-only / propose-only;
   * Write/Edit/destructive Bash are blocked by the SDK's plan
   * permission mode.
   */
  mode?: LabMode;
};

export type LabBuildState = {
  status: "idle" | "building" | "ok" | "error";
  lastBuildAt: number | null;
  lastError: string | null;
};

export type LabBuildLogLine = {
  stream: "stdout" | "stderr";
  chunk: string;
  ts: number;
};

export type LabBuildLog = {
  lines: LabBuildLogLine[];
};

const BUILD_LOG_MAX = 200;

export type LabState = {
  status: "connecting" | "ready" | "thinking" | "closed" | "error" | "exhausted";
  sessionId: string | null;
  previewBase: string | null;
  chat: ChatItem[];
  files: FileNode[];
  /** Epoch ms of the last files:changed event. Drives the "Rebuilding…" indicator on the publish button. */
  lastFilesChangedAt: number | null;
  /** Build pipeline status from the server's auto-builder. */
  build: LabBuildState;
  /** Streaming stdout/stderr from the auto-builder, capped at 200 lines. */
  buildLog: LabBuildLog;
  cumulativeCostUsd: number;
  /** Cost split when an Opus advisor was active during the session.
   * `advisor` is 0 on sessions that never invoked the advisor tool. */
  cumulativeExecutorCostUsd: number;
  cumulativeAdvisorCostUsd: number;
  /** Total advisor sub-inferences fired this session. Drives the
   * per-conversation cap surfacing. */
  advisorCallsThisSession: number;
  budgetUsd: number;
  rateLimit: { perMinute: number };
  send: (text: string) => void;
  abort: () => void;
  reset: () => void;
  /** Persist the user's model preference and notify the server. The current
   * agent (already running) keeps its initial model; the new one applies on
   * the next session — i.e. after a Reset. */
  setModelPreference: (m: ModelKey) => void;
  /** Persist the executor + advisor pair and notify the server. Same
   * "applies on next session" rule as setModelPreference. */
  setModelPreset: (executor: ExecutorModel, advisor: AdvisorModel) => void;
};

let counter = 0;
const newId = () => `${Date.now()}-${++counter}`;

/** User-configurable cap on advisor calls per session. Surfaced from the
 * Settings panel as `lab.advisorCap`. Default 30. */
function readAdvisorCap(): number {
  try {
    const raw = localStorage.getItem("lab.advisorCap");
    const n = raw ? Number(raw) : 30;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
  } catch {
    return 30;
  }
}

export function useLabSession(
  projectId: number | null,
  opts: UseLabSessionOptions = {}
): LabState {
  const mode: LabMode = opts.mode ?? "code";
  const [status, setStatus] = useState<LabState["status"]>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [previewBase, setPreviewBase] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [lastFilesChangedAt, setLastFilesChangedAt] = useState<number | null>(null);
  const [build, setBuild] = useState<LabBuildState>({
    status: "idle",
    lastBuildAt: null,
    lastError: null,
  });
  const [buildLog, setBuildLog] = useState<LabBuildLog>({ lines: [] });
  const [cumulativeCostUsd, setCumulativeCostUsd] = useState(0);
  const [cumulativeExecutorCostUsd, setCumulativeExecutorCostUsd] = useState(0);
  const [cumulativeAdvisorCostUsd, setCumulativeAdvisorCostUsd] = useState(0);
  const [advisorCallsThisSession, setAdvisorCallsThisSession] = useState(0);
  const [budgetUsd, setBudgetUsd] = useState(1.0);
  const [rateLimit, setRateLimit] = useState<{ perMinute: number }>({ perMinute: 20 });
  const wsRef = useRef<WebSocket | null>(null);
  // Tracks whether we've already received the initial `files:changed` event
  // for this session. The first one is just chokidar's startup scan — it
  // shouldn't drive the publish-button "Rebuilding…" indicator. We start
  // counting "real" changes from the second event onward.
  const filesEventCountRef = useRef(0);

  useEffect(() => {
    if (projectId == null) return;
    // Reset state for a fresh project open.
    setStatus("connecting");
    setSessionId(null);
    setPreviewBase(null);
    setChat([]);
    setFiles([]);
    setCumulativeCostUsd(0);
    setCumulativeExecutorCostUsd(0);
    setCumulativeAdvisorCostUsd(0);
    setAdvisorCallsThisSession(0);
    setBuildLog({ lines: [] });
    filesEventCountRef.current = 0;

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ projectId: String(projectId) });
    if (mode === "plan") params.set("mode", "plan");
    // Forward the user's executor + advisor preset so the agent starts with
    // the correct model and (if applicable) the advisor tool wired in.
    try {
      const presetId = localStorage.getItem("lab.modelPreset");
      if (presetId) {
        const presetMap: Record<string, { executor: string; advisor?: string }> = {
          frugal: { executor: "haiku-4.5" },
          "frugal-advisor": { executor: "haiku-4.5", advisor: "opus-4.7" },
          default: { executor: "sonnet-4.6" },
          "default-advisor": { executor: "sonnet-4.6", advisor: "opus-4.7" },
          maximum: { executor: "opus-4.7" },
        };
        const p = presetMap[presetId];
        if (p) {
          params.set("executor", p.executor);
          if (p.advisor) params.set("advisor", p.advisor);
        }
      }
    } catch {}
    const wsUrl = `${proto}://${location.host}/ws?${params.toString()}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener("open", () => setStatus("connecting"));
    ws.addEventListener("error", () => setStatus("error"));
    ws.addEventListener("close", () =>
      setStatus((s) => (s === "error" ? "error" : "closed"))
    );

    ws.addEventListener("message", (evt) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(evt.data);
      } catch {
        return;
      }
      handleServerEvent(event, {
        setStatus,
        setSessionId,
        setPreviewBase,
        setChat,
        setFiles,
        setLastFilesChangedAt,
        setBuild,
        setBuildLog,
        setCumulativeCostUsd,
        setCumulativeExecutorCostUsd,
        setCumulativeAdvisorCostUsd,
        setAdvisorCallsThisSession,
        setBudgetUsd,
        setRateLimit,
        filesEventCountRef,
      });
    });

    return () => {
      ws.close();
    };
  }, [projectId, mode]);

  const sendCommand = useCallback((cmd: ClientCommand) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(cmd));
  }, []);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setChat((c) => [...c, { kind: "user", id: newId(), text: trimmed }]);
      setStatus("thinking");
      sendCommand({ type: "user:message", text: trimmed });
    },
    [sendCommand]
  );

  const abort = useCallback(() => {
    sendCommand({ type: "agent:abort" });
  }, [sendCommand]);

  const reset = useCallback(() => {
    setChat([]);
    setFiles([]);
    setCumulativeCostUsd(0);
    setCumulativeExecutorCostUsd(0);
    setCumulativeAdvisorCostUsd(0);
    setAdvisorCallsThisSession(0);
    sendCommand({ type: "session:reset" });
  }, [sendCommand]);

  const setModelPreference = useCallback(
    (m: ModelKey) => {
      sendCommand({ type: "session:set_model", model: m });
    },
    [sendCommand]
  );

  const setModelPreset = useCallback(
    (executor: ExecutorModel, advisor: AdvisorModel) => {
      sendCommand({ type: "session:set_preset", executor, advisor });
    },
    [sendCommand]
  );

  return {
    status,
    sessionId,
    previewBase,
    chat,
    files,
    lastFilesChangedAt,
    build,
    buildLog,
    cumulativeCostUsd,
    cumulativeExecutorCostUsd,
    cumulativeAdvisorCostUsd,
    advisorCallsThisSession,
    budgetUsd,
    rateLimit,
    send,
    abort,
    reset,
    setModelPreference,
    setModelPreset,
  };
}

type Setters = {
  setStatus: (v: LabState["status"] | ((prev: LabState["status"]) => LabState["status"])) => void;
  setSessionId: (v: string | null) => void;
  setPreviewBase: (v: string | null) => void;
  setChat: (fn: (prev: ChatItem[]) => ChatItem[]) => void;
  setFiles: (v: FileNode[]) => void;
  setLastFilesChangedAt: (v: number | null) => void;
  setBuild: (v: LabBuildState) => void;
  setBuildLog: (fn: (prev: LabBuildLog) => LabBuildLog) => void;
  setCumulativeCostUsd: (v: number | ((prev: number) => number)) => void;
  setCumulativeExecutorCostUsd: (v: number | ((prev: number) => number)) => void;
  setCumulativeAdvisorCostUsd: (v: number | ((prev: number) => number)) => void;
  setAdvisorCallsThisSession: (v: number | ((prev: number) => number)) => void;
  setBudgetUsd: (v: number) => void;
  setRateLimit: (v: { perMinute: number }) => void;
  filesEventCountRef: { current: number };
};

function handleServerEvent(event: ServerEvent, s: Setters) {
  switch (event.type) {
    case "session:ready":
      s.setSessionId(event.sessionId);
      s.setPreviewBase(event.previewBase);
      s.setBudgetUsd(event.budgetUsd);
      s.setRateLimit(event.rateLimit);
      s.setStatus("ready");
      return;

    case "session:reset_done":
      s.setChat((c) => [
        ...c,
        { kind: "system", id: newId(), text: "Session reset. Files cleared, conversation restarted." },
      ]);
      return;

    case "files:changed":
      s.setFiles(event.files);
      // Skip lastFilesChangedAt update on the first event of each session —
      // that's chokidar's startup scan, not a real edit, and it would
      // otherwise trigger a bogus "Rebuilding…" on the publish button on
      // every page reload.
      s.filesEventCountRef.current += 1;
      if (s.filesEventCountRef.current > 1) {
        s.setLastFilesChangedAt(Date.now());
      }
      return;

    case "agent:turn_start":
      s.setStatus("thinking");
      return;

    case "agent:turn_aborted":
      s.setChat((c) => [...c, { kind: "aborted", id: newId() }]);
      s.setStatus("ready");
      return;

    case "agent:text": {
      // Final text for an assistant message. If streaming chunks have already
      // built up an item with this uuid, reconcile by replacing its text and
      // clearing the streaming flag. Otherwise (no chunks ever arrived, or
      // streaming was off), just append a fresh item.
      const uuid = event.messageUuid;
      s.setChat((c) => {
        if (uuid) {
          const idx = c.findIndex(
            (it) => it.kind === "agent-text" && it.messageUuid === uuid
          );
          if (idx >= 0) {
            const next = c.slice();
            next[idx] = {
              ...(c[idx] as Extract<ChatItem, { kind: "agent-text" }>),
              text: event.text,
              streaming: false,
            };
            return next;
          }
        }
        return [
          ...c,
          {
            kind: "agent-text",
            id: uuid ?? newId(),
            text: event.text,
            messageUuid: uuid,
            streaming: false,
          },
        ];
      });
      return;
    }

    case "agent:text_chunk": {
      // Append the delta to an in-progress agent-text item keyed by uuid,
      // creating one on the first chunk.
      const uuid = event.messageUuid;
      s.setChat((c) => {
        const idx = c.findIndex(
          (it) => it.kind === "agent-text" && it.messageUuid === uuid
        );
        if (idx >= 0) {
          const next = c.slice();
          const prev = c[idx] as Extract<ChatItem, { kind: "agent-text" }>;
          next[idx] = { ...prev, text: prev.text + event.delta, streaming: true };
          return next;
        }
        return [
          ...c,
          {
            kind: "agent-text",
            id: uuid,
            text: event.delta,
            messageUuid: uuid,
            streaming: true,
          },
        ];
      });
      return;
    }

    case "agent:tool_use":
      s.setChat((c) => [
        ...c,
        {
          kind: "tool-call",
          id: event.toolUseId,
          tool: event.tool,
          input: event.input,
        },
      ]);
      return;

    case "agent:tool_result":
      s.setChat((c) =>
        c.map((item) =>
          item.kind === "tool-call" && item.id === event.toolUseId
            ? { ...item, result: { ok: event.ok, preview: event.preview } }
            : item
        )
      );
      return;

    case "agent:turn_end":
      s.setChat((c) => [
        ...c,
        {
          kind: "turn-end",
          id: newId(),
          cost: event.cost,
          durationMs: event.durationMs,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          subtype: event.subtype,
          cumulativeCostUsd: event.cumulativeCostUsd,
        },
      ]);
      s.setCumulativeCostUsd(event.cumulativeCostUsd);
      if (typeof event.cumulativeExecutorCostUsd === "number") {
        s.setCumulativeExecutorCostUsd(event.cumulativeExecutorCostUsd);
      }
      if (typeof event.cumulativeAdvisorCostUsd === "number") {
        s.setCumulativeAdvisorCostUsd(event.cumulativeAdvisorCostUsd);
      }
      s.setStatus("ready");
      return;

    case "agent:advisor_used": {
      s.setAdvisorCallsThisSession(event.callCountThisSession);
      // Cumulative advisor cost is also surfaced on turn_end; mirror it here
      // so the meter updates intra-turn if the server fires this event eagerly.
      s.setCumulativeAdvisorCostUsd((prev) => prev + event.advisorCostUsd);
      // Client-side conversation cap. When the user-configurable threshold
      // is reached, drop a system message hinting at the cost. The advisor
      // tool itself stays registered (the SDK doesn't expose dynamic tool
      // removal), but the executor model is unlikely to keep calling once
      // the user is told to switch presets.
      const cap = readAdvisorCap();
      if (event.callCountThisSession === cap) {
        s.setChat((c) => [
          ...c,
          {
            kind: "system",
            id: newId(),
            text: `Advisor used ${cap} times this session — that's your configured cap. To stop using the advisor, switch to a non-advisor preset (Frugal / Default / Maximum) and click Reset.`,
          },
        ]);
      }
      return;
    }

    case "agent:error":
      s.setChat((c) => [
        ...c,
        { kind: "error", id: newId(), message: event.message },
      ]);
      s.setStatus("ready");
      return;

    case "warn:rate_limited":
      s.setChat((c) => [
        ...c,
        {
          kind: "system",
          id: newId(),
          text: `Slow down — too many messages. Try again in ${Math.ceil(event.retryAfterMs / 1000)}s.`,
        },
      ]);
      s.setStatus("ready");
      return;

    case "chat:user_message":
      s.setChat((c) => [...c, { kind: "user", id: newId(), text: event.text }]);
      return;

    case "build:state":
      s.setBuild({
        status: event.status,
        lastBuildAt: event.lastBuildAt,
        lastError: event.lastError,
      });
      // A new build starting clears the prior log so the drawer doesn't pile
      // up output across builds. Buffered replay of an in-progress build is
      // still preserved (the server emits build:log lines after build:state
      // building, in order).
      if (event.status === "building") {
        s.setBuildLog(() => ({ lines: [] }));
      }
      return;

    case "build:log":
      s.setBuildLog((prev) => {
        const next = prev.lines.concat({
          stream: event.stream,
          chunk: event.chunk,
          ts: event.ts,
        });
        if (next.length > BUILD_LOG_MAX) {
          next.splice(0, next.length - BUILD_LOG_MAX);
        }
        return { lines: next };
      });
      return;

    case "warn:budget_exceeded":
      s.setChat((c) => [
        ...c,
        {
          kind: "system",
          id: newId(),
          text: `Session budget reached: $${event.spentUsd.toFixed(2)} of $${event.limitUsd.toFixed(2)}. Click Reset to start a new session.`,
        },
      ]);
      s.setStatus("exhausted");
      return;
  }
}
