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
      /** Per-turn cost split when an Opus advisor was active.
       * Null on turns where no advisor sub-inference fired. */
      executorCostUsd?: number;
      advisorCostUsd?: number;
      /** Cumulative-to-this-turn split, surfaced for the cost meter tooltip. */
      cumulativeExecutorCostUsd?: number;
      cumulativeAdvisorCostUsd?: number;
    }
  | { type: "agent:error"; message: string }
  | {
      // Server-emitted neutral notice that should land in chat as a system
      // line (not an error bubble). Used for things like "advisor preset is
      // selected but the runtime flag is off" or recoverable agent
      // diagnostics that we don't want to mask but also don't want to scream.
      type: "system:notice";
      text: string;
    }
  | {
      // Emitted whenever the executor consults the advisor in this turn.
      // Drives the per-conversation cap and the chat hint surface.
      type: "agent:advisor_used";
      advisorTokens: number;
      advisorCostUsd: number;
      callCountThisSession: number;
    }
  | { type: "files:changed"; files: FileNode[] }
  | { type: "warn:rate_limited"; retryAfterMs: number }
  | { type: "warn:budget_exceeded"; spentUsd: number; limitUsd: number }
  // Sent during conversation replay so historical user messages render in
  // chat. Live user messages are added client-side on send; the server does
  // NOT echo them in the live flow (would cause duplicates).
  | { type: "chat:user_message"; text: string }
  // Legacy build pipeline status. Static preview no longer emits this, but
  // keeping the event shape avoids breaking older client/server bundles during
  // rolling deploys.
  | {
      type: "build:state";
      status: "idle" | "building" | "ok" | "error";
      lastBuildAt: number | null;
      lastError: string | null;
    }
  // Legacy build stdout/stderr chunk. Static preview no longer emits this.
  | {
      type: "build:log";
      stream: "stdout" | "stderr";
      chunk: string;
      ts: number;
    };

/** Client → server */
// Legacy ModelKey kept for backwards-compat with older client builds. New code
// should use ExecutorModel + AdvisorModel below.
export type ModelKey = "sonnet-4.6" | "opus-4.7" | "haiku";

/** Executor models accepted by Anthropic's advisor tool today. */
export type ExecutorModel =
  | "haiku-4.5"
  | "sonnet-4.6"
  | "opus-4.6"
  | "opus-4.7";

/** Advisor models. Today only Opus 4.7; null means advisor disabled. */
export type AdvisorModel = "opus-4.7" | null;

export type ClientCommand =
  | { type: "user:message"; text: string }
  | { type: "agent:abort" }
  | { type: "session:reset" }
  | { type: "session:set_model"; model: ModelKey }
  | {
      type: "session:set_preset";
      executor: ExecutorModel;
      advisor: AdvisorModel;
    };

export const WS_PATH = "/ws";
