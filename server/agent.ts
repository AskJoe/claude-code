/**
 * Wraps the Claude Agent SDK in something the WebSocket layer can drive.
 *
 * One agent instance per session. Multi-turn: user messages get pushed onto an
 * AsyncIterable that's fed into query() once at session start, so the model
 * sees the full conversation history without us having to manage it.
 *
 * Budget cap: the SDK enforces maxBudgetUsd by ending the loop with a special
 * result subtype. We emit warn:budget_exceeded and refuse further input until
 * the session is reset.
 */

import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { getSettings } from "./settings.ts";
import { getUserById } from "./db.ts";
import type { Session } from "./sessions.ts";
import type { ExecutorModel, ServerEvent } from "../shared/events.ts";

const AGENT_IDLE_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.LAB_AGENT_IDLE_TIMEOUT_MS ?? 120_000)
);

// Map our preset's executor key to the SDK / Anthropic model id.
function resolveExecutorModelId(e: ExecutorModel): string {
  switch (e) {
    case "haiku-4.5":
      return "claude-haiku-4-5-20251001";
    case "sonnet-4.6":
      return "claude-sonnet-4-6";
    case "opus-4.6":
      return "claude-opus-4-6";
    case "opus-4.7":
      return "claude-opus-4-7";
  }
}

const SYSTEM_PROMPT = `You are the agent powering Cloudwise Lab — a web playground where Cloudwise Academy students chat with a Claude-Code-style assistant.

# Working directory and paths

Your current working directory IS the student's project. **Never use absolute paths in any tool call** (no \`/Users/...\`, no \`/repo/...\`). The host filesystem path contains spaces, so absolute paths in Bash will silently break (the shell splits on the space and grep/find error out). Always use relative paths from cwd.

  ✓ \`grep -r "Mountain Brew" src\`
  ✓ \`find . -name "*.html"\`
  ✗ \`grep -r "Mountain Brew" /Users/joemacpro/...\`   ← WILL FAIL

# Project structure

The cwd contains a static website starter. **Cloudwise Lab is for building websites with plain HTML, CSS, and browser JavaScript.**

You'll edit:
- \`index.html\` — the default page
- \`*.html\` — additional pages such as \`about.html\` or \`contact.html\`
- \`styles.css\` — shared site styles
- \`script.js\` — browser JavaScript for interactions
- \`uploads/\` — images and uploaded files, referenced as \`./uploads/filename.ext\`

The default page is \`index.html\` — modify it freely.

# Source vs. preview (IMPORTANT)

The student's preview iframe is managed by Cloudwise Lab. It serves the project files directly; there is no compile step and no dev server to start. Do **not** run package-manager commands, create a framework project, or add a build tool unless the user explicitly asks for a framework/compiler.

When you save \`index.html\`, \`styles.css\`, \`script.js\`, or another static asset, the browser preview refreshes from those source files.

**When a student asks you to change something they "see" on the page**, search the static source files first. If you cannot find their reference, ask one concise clarifying question or inspect the current page structure before guessing.

# Search habits

When looking for something, broaden before giving up:
- Try case-insensitive: \`grep -ri "phrase" .\`
- Search the likely source files first: \`index.html\`, \`*.html\`, \`styles.css\`, \`script.js\`
- List what's there: \`ls\`, \`find . -maxdepth 3 -type f\`
- Don't conclude "not found" after one failed search

# Style

Be concise, friendly, and pedagogical. After making changes, briefly explain what you did. The preview refreshes automatically — you don't need to tell the student to run anything.

# Tools available

You have the full Claude Code toolkit: \`Read\`, \`Write\`, \`Edit\`, \`Bash\`, \`Glob\`, \`Grep\`, \`WebSearch\`, \`WebFetch\`, \`TodoWrite\`, \`Task\`, \`NotebookEdit\`, plus background-process tools.

Use them well:
- **TodoWrite** for any task that has more than 2–3 steps. Show your plan; mark items complete as you go.
- **Glob / Grep** for searching the project — faster and cleaner than \`Bash find\` / \`Bash grep\`.
- **WebFetch** to read a URL the student references (a brand site to clone, a doc page, a competitor's landing). Prefer this over guessing.
- **WebSearch** sparingly — it costs real money per query. Use it when the answer is genuinely time-sensitive (current pricing, recent API changes, today's news). For general knowledge, your training is fine.
- **Task** to spawn a sub-agent for a heavy parallelizable chunk (research two pages at once, write three components in parallel). It multiplies the per-session budget — use only when the speedup is worth it.`;

export type AgentEventSink = (event: ServerEvent) => void;

export type Agent = {
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  isBusy: () => boolean;
  isExhausted: () => boolean;
  cumulativeCostUsd: () => number;
  budgetUsd: () => number;
  dispose: () => Promise<void>;
  /**
   * Stash a chunk of prior-conversation text. The next user `send()`
   * call will be prefixed with it (once), so the agent gets the
   * historical context on its first real turn after a reconnect.
   * Cleared after one use.
   */
  setHistoryPreamble: (preamble: string) => void;
};

export type StartAgentOptions = {
  /** When set, used as the budget cap (overrides lab-wide default + per-user override). */
  userId?: number;
  /**
   * "code" (default) — agent has full Claude Code toolkit and auto-accepts
   * all tool calls so it can freely Read/Write/Edit/Bash without prompts.
   *
   * "plan" — read-only thinking mode. The SDK's `plan` permission gates
   * any tool that mutates state (Write, Edit, Bash that modifies, etc.)
   * so the agent answers questions, explores the project, and proposes
   * changes without actually executing them. Good for "research the site
   * and tell me what you'd do" before flipping back to Code mode to
   * actually do it.
   */
  mode?: "code" | "plan";
  /** Executor model. Defaults to lab-wide `default_model` setting. */
  executor?: ExecutorModel;
};

export function startAgent(
  session: Session,
  emit: AgentEventSink,
  startOpts: StartAgentOptions = {}
): Agent {
  const inbox = createMessageQueue();
  let busy = false;
  let exhausted = false;
  let cumulativeCost = 0;
  let abortRequested = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let turnSeq = 0;
  let lastSdkActivityAt = 0;
  let lastSdkActivityType = "none";
  // One-shot prior-conversation context, set by the WS handler on
  // session open from `listMessages(...)`. Consumed on the next
  // `send()` so the model gets a single fat first message containing
  // both the prior history and the new prompt.
  let pendingHistoryPreamble: string | null = null;

  // Budget priority: per-user override > lab-wide default.
  // Model: per-session preset (executor) > lab-wide default.
  const labSettings = getSettings();
  let budget = labSettings.defaultBudgetUsd;
  // Compose the system prompt: user's prefix → baked.
  let composedSystemPrompt = SYSTEM_PROMPT;
  if (startOpts.userId) {
    const userRow = getUserById(startOpts.userId);
    if (userRow?.budget_override_usd != null) {
      budget = userRow.budget_override_usd;
    }
    const userPrefix = (userRow?.system_prompt ?? "").trim();
    if (userPrefix) {
      composedSystemPrompt = `${userPrefix}\n\n---\n\n${SYSTEM_PROMPT}`;
    }
  }

  // Executor model resolution. If the caller didn't supply one, fall back to
  // the lab-wide default (typically claude-sonnet-4-6 from settings).
  const executorChoice: ExecutorModel = startOpts.executor ?? "sonnet-4.6";
  const executorModelId = resolveExecutorModelId(executorChoice);

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const armIdleTimer = (seq: number) => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      if (!busy || seq !== turnSeq) return;
      busy = false;
      abortRequested = false;
      const seconds = Math.round(AGENT_IDLE_TIMEOUT_MS / 1000);
      const idleMs = lastSdkActivityAt > 0 ? Date.now() - lastSdkActivityAt : null;
      console.warn("[agent] sdk-activity timeout", {
        projectId: session.projectId,
        seconds,
        turnSeq: seq,
        lastSdkActivityType,
        idleMs,
      });
      emit({
        type: "agent:error",
        message:
          `Agent runtime timed out after ${seconds}s without activity. ` +
          `This usually means the agent/tool runtime stalled. Click Reset to start a fresh agent session.`,
      });
      try {
        void (stream as any).interrupt?.();
      } catch (err) {
        console.error("[agent] timeout interrupt failed:", err);
      }
    }, AGENT_IDLE_TIMEOUT_MS);
  };

  const permissionMode: Options["permissionMode"] =
    startOpts.mode === "plan" ? "plan" : "bypassPermissions";

  const options: Options = {
    cwd: session.rootDir,
    // Per-session executor pick. Falls back to lab-wide default if unmapped.
    model: executorModelId || labSettings.defaultModel,
    // Inherit Claude Code's full default charter (planning, no-preamble output,
    // tool-use conventions, code-style heuristics) and APPEND our lab-specific
    // guidance on top. Replacing the preset entirely was the single largest
    // quality gap vs. the real CLI.
    systemPrompt: { type: "preset", preset: "claude_code", append: composedSystemPrompt },
    // No `allowedTools` — fall back to the SDK's full Claude Code default
    // (Read/Write/Edit/Bash + Glob/Grep + WebSearch/WebFetch + TodoWrite +
    // Task + NotebookEdit + background-process tools).
    permissionMode,
    maxTurns: 30,
    maxBudgetUsd: budget,
    // Stream text chunks as they arrive so the chat shows live token-by-token
    // output instead of a long "thinking…" pause followed by a wall of text.
    includePartialMessages: true,
    // This is an interactive student lab. Extended hidden reasoning can leave
    // the UI looking stuck for minutes, so keep turns responsive by default.
    thinking: { type: "disabled" },
    effort: "low",
  };

  const stream = query({ prompt: inbox.iterable, options });

  // Pump SDK messages onto the WebSocket as they arrive.
  (async () => {
    try {
      for await (const msg of stream) {
        lastSdkActivityAt = Date.now();
        lastSdkActivityType =
          msg.type === "stream_event"
            ? String(msg.event?.type ?? "stream_event")
            : String(msg.type);
        if (busy) armIdleTimer(turnSeq);
        if (msg.type === "result") {
          const turnCost = msg.total_cost_usd ?? 0;
          cumulativeCost += turnCost;

          emit({
            type: "agent:turn_end",
            cost: turnCost,
            durationMs: msg.duration_ms ?? 0,
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
            subtype: msg.subtype ?? "unknown",
            cumulativeCostUsd: cumulativeCost,
          });
          busy = false;
          clearIdleTimer();
          if (msg.subtype === "error_max_budget_usd") {
            exhausted = true;
            emit({
              type: "warn:budget_exceeded",
              spentUsd: cumulativeCost,
              limitUsd: budget,
            });
          }
          if (abortRequested) {
            emit({ type: "agent:turn_aborted" });
            abortRequested = false;
          }
          clearIdleTimer();
        } else {
          routeSdkMessage(msg, emit);
        }
      }
    } catch (err: any) {
      clearIdleTimer();
      busy = false;
      emit({ type: "agent:error", message: err?.message ?? String(err) });
    } finally {
      clearIdleTimer();
      if (busy) {
        busy = false;
        emit({
          type: "agent:error",
          message:
            "Agent runtime closed before the current turn completed. Click Reset to start a fresh agent session.",
        });
      }
    }
  })();

  return {
    isBusy: () => busy,
    isExhausted: () => exhausted,
    cumulativeCostUsd: () => cumulativeCost,
    budgetUsd: () => budget,

    async send(text) {
      if (exhausted) return;
      busy = true;
      turnSeq += 1;
      lastSdkActivityAt = Date.now();
      lastSdkActivityType = "user_message_queued";
      emit({ type: "agent:turn_start" });
      armIdleTimer(turnSeq);
      let payload = text;
      if (pendingHistoryPreamble) {
        payload =
          `[Prior conversation in this project, for your context — do not respond to it directly, just use it to understand what we've been working on]\n\n` +
          pendingHistoryPreamble +
          `\n\n[Current message from the user]\n` +
          text;
        pendingHistoryPreamble = null;
      }
      inbox.push({
        type: "user",
        session_id: String(session.projectId),
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: payload }] },
      });
    },

    setHistoryPreamble(preamble) {
      pendingHistoryPreamble = preamble && preamble.trim() ? preamble : null;
    },

    async abort() {
      if (!busy) return;
      abortRequested = true;
      clearIdleTimer();
      try {
        await (stream as any).interrupt?.();
      } catch (err) {
        console.error("[agent] interrupt failed:", err);
      }
    },

    async dispose() {
      clearIdleTimer();
      inbox.close();
      try {
        await (stream as any).interrupt?.();
      } catch {}
    },
  };
}

function routeSdkMessage(msg: any, emit: AgentEventSink): boolean {
  // Streaming partial-message events. With `includePartialMessages: true` the
  // SDK forwards Anthropic's raw content_block_delta stream events. We forward
  // text deltas to the client as `agent:text_chunk` so the chat can render
  // token-by-token. The full `agent:text` (below) still arrives at the end of
  // the message and reconciles the final text.
  if (msg.type === "stream_event") {
    const ev = msg.event;
    if (
      ev?.type === "content_block_delta" &&
      ev?.delta?.type === "text_delta" &&
      typeof ev.delta.text === "string" &&
      ev.delta.text.length > 0
    ) {
      emit({
        type: "agent:text_chunk",
        messageUuid: String(msg.uuid ?? ""),
        delta: ev.delta.text,
      });
      return true;
    }
    return false;
  }

  if (msg.type === "assistant") {
    const messageUuid: string | undefined = msg.uuid;
    const blocks = msg.message?.content ?? [];
    let emitted = false;
    for (const block of blocks) {
      if (block.type === "text") {
        emit({ type: "agent:text", text: block.text, messageUuid });
        emitted = true;
      } else if (block.type === "tool_use") {
        emit({
          type: "agent:tool_use",
          toolUseId: block.id,
          tool: block.name,
          input: block.input,
        });
        emitted = true;
      }
    }
    return emitted;
  }

  if (msg.type === "user") {
    const blocks = msg.message?.content ?? [];
    let emitted = false;
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const content =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => c.text ?? JSON.stringify(c)).join("")
              : JSON.stringify(block.content);
        emit({
          type: "agent:tool_result",
          toolUseId: block.tool_use_id,
          ok: !block.is_error,
          preview: content.length > 600 ? content.slice(0, 600) + "…" : content,
        });
        emitted = true;
      }
    }
    return emitted;
  }

  // result is handled inline in the pump loop so we can update cumulative cost.
  return false;
}

/**
 * A bounded async-iterable queue. The SDK awaits messages from it; we push from
 * the WebSocket handler. `close()` ends the iteration so the SDK loop can exit.
 */
function createMessageQueue<T = any>() {
  const buffer: T[] = [];
  const waiters: Array<(v: IteratorResult<T>) => void> = [];
  let closed = false;

  const push = (v: T) => {
    if (closed) return;
    const w = waiters.shift();
    if (w) w({ value: v, done: false });
    else buffer.push(v);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    while (waiters.length) waiters.shift()!({ value: undefined as any, done: true });
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined as any, done: true });
          return new Promise<IteratorResult<T>>((res) => waiters.push(res));
        },
        async return() {
          close();
          return { value: undefined as any, done: true };
        },
      };
    },
  };

  return { push, close, iterable };
}
