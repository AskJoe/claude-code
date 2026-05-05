/**
 * Wire protocol between Cloudwise Lab server (Hono) and web (Vite/React) over WebSocket.
 * Both sides import from this file so the types stay locked in sync.
 */

export type FileNode = {
  name: string;
  path: string;          // POSIX-style, relative to session root
  type: "file" | "dir";
  children?: FileNode[]; // present iff type === "dir"
};

/** Server → client */
export type ServerEvent =
  | {
      type: "session:ready";
      sessionId: string;
      previewBase: string;
      budgetUsd: number;
      rateLimit: { perMinute: number };
    }
  | { type: "session:reset_done" }
  | { type: "agent:turn_start" }
  | { type: "agent:turn_aborted" }
  | { type: "agent:text"; text: string; messageUuid?: string }
  // Streaming text delta from the agent. Multiple of these arrive per
  // assistant message; they share a `messageUuid`. The final `agent:text`
  // for that uuid reconciles the complete text at end-of-message.
  | { type: "agent:text_chunk"; messageUuid: string; delta: string }
  | { type: "agent:tool_use"; toolUseId: string; tool: string; input: unknown }
  | { type: "agent:tool_result"; toolUseId: string; ok: boolean; preview: string }
  | {
      type: "agent:turn_end";
      cost: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      subtype: string;
      cumulativeCostUsd: number;
    }
  | { type: "agent:error"; message: string }
  | { type: "files:changed"; files: FileNode[] }
  | { type: "warn:rate_limited"; retryAfterMs: number }
  | { type: "warn:budget_exceeded"; spentUsd: number; limitUsd: number }
  // Sent during conversation replay so historical user messages render in
  // chat. Live user messages are added client-side on send; the server does
  // NOT echo them in the live flow (would cause duplicates).
  | { type: "chat:user_message"; text: string }
  // Build pipeline status. Emitted by the auto-builder on each transition
  // between idle / building / ok / error. The lab uses this to keep the
  // preview iframe in sync with current source — the iframe reloads on `ok`,
  // shows a "Building…" overlay during `building`, and surfaces the error
  // pre-formatted on `error`.
  | {
      type: "build:state";
      status: "idle" | "building" | "ok" | "error";
      lastBuildAt: number | null;
      lastError: string | null;
    }
  // Streaming chunk of build stdout/stderr from `npm run build`. Emitted by
  // the auto-builder so the BuildLogDrawer can show live build output. The
  // server keeps the last 200 lines per session in memory; on reconnect /
  // session open the buffered tail can be replayed.
  | {
      type: "build:log";
      stream: "stdout" | "stderr";
      chunk: string;
      ts: number;
    };

/** Client → server */
export type ClientCommand =
  | { type: "user:message"; text: string }
  | { type: "agent:abort" }
  | { type: "session:reset" };

export const WS_PATH = "/ws";
