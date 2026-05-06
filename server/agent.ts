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
import type {
  AdvisorModel,
  ExecutorModel,
  ServerEvent,
} from "../shared/events.ts";

// Advisor strategy — see https://claude.com/blog/the-advisor-strategy
// Beta header centralized here; bump when the API moves out of beta.
const ADVISOR_BETA_HEADER = "advisor-tool-2026-03-01";

// The Claude Agent SDK 0.2.x's bundled CLI binary doesn't have first-class
// advisor support — `--advisor-model` isn't an exposed flag and passing
// {"advisorModel": ...} via --settings lets the model emit advisor
// `server_tool_use` blocks the binary can't fulfill, causing exit errors of
// the form "[ede_diagnostic] result_type=user last_content_type=n/a
// stop_reason=tool_use". Until we verify the SDK ships with a working
// runtime, the advisor wiring is gated behind LAB_ADVISOR_ENABLED. Set it
// only after testing on a small project.
const ADVISOR_RUNTIME_ENABLED =
  process.env.LAB_ADVISOR_ENABLED === "1" ||
  process.env.LAB_ADVISOR_ENABLED === "true";

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

function resolveAdvisorModelId(a: AdvisorModel): string | null {
  if (a === "opus-4.7") return "claude-opus-4-7";
  return null;
}

// Per-million input/output USD rates. Used to estimate the executor/advisor
// split when the SDK doesn't surface usage.iterations[].
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-opus-4-7": { input: 15, output: 75 },
};

function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING_PER_MTOK[modelId];
  if (!p) return 0;
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output
  );
}

const ADVISOR_TIMING_BLOCK = `You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck — errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.`;

const ADVISOR_TREATMENT_BLOCK = `Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong — it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`;

const ADVISOR_CONCISENESS_BLOCK = `The advisor should respond in under 100 words and use enumerated steps, not explanations.`;

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
  /** Optional advisor (Opus 4.7) — null means no advisor.
   * When set, the SDK is told to register the advisor tool via the
   * `advisor-tool-2026-03-01` beta header + `advisorModel` setting. The
   * recommended timing/treatment/conciseness blocks are prepended to the
   * system prompt to guide when the executor invokes the tool. */
  advisor?: AdvisorModel;
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
  let cumulativeExecutorCost = 0;
  let cumulativeAdvisorCost = 0;
  let advisorCallCount = 0;
  let abortRequested = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let turnSeq = 0;
  // One-shot prior-conversation context, set by the WS handler on
  // session open from `listMessages(...)`. Consumed on the next
  // `send()` so the model gets a single fat first message containing
  // both the prior history and the new prompt.
  let pendingHistoryPreamble: string | null = null;

  // Budget priority: per-user override > lab-wide default.
  // Model: per-session preset (executor) > lab-wide default.
  const labSettings = getSettings();
  let budget = labSettings.defaultBudgetUsd;
  // Compose the system prompt: optional advisor blocks → user's prefix → baked.
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
  const advisorModelId = resolveAdvisorModelId(startOpts.advisor ?? null);
  // Two layers: the user picked a +advisor preset AND the env flag opts in.
  // If the user picked it but the runtime is gated, keep that warning in
  // server logs instead of spamming the student's chat.
  const advisorRequested = advisorModelId !== null;
  const advisorActive = advisorRequested && ADVISOR_RUNTIME_ENABLED;

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
      emit({
        type: "agent:error",
        message:
          `Agent runtime timed out after ${seconds}s without activity. ` +
          `This usually means the advisor/tool runtime stalled. Click Reset to start a fresh agent session.`,
      });
      try {
        void (stream as any).interrupt?.();
      } catch (err) {
        console.error("[agent] timeout interrupt failed:", err);
      }
    }, AGENT_IDLE_TIMEOUT_MS);
  };

  // Prepend the recommended advisor blocks when advisor is enabled. Order:
  // conciseness → timing → treatment → user prefix (already in composedSystemPrompt) → baked.
  if (advisorActive) {
    composedSystemPrompt =
      `${ADVISOR_CONCISENESS_BLOCK}\n\n` +
      `${ADVISOR_TIMING_BLOCK}\n\n` +
      `${ADVISOR_TREATMENT_BLOCK}\n\n---\n\n` +
      composedSystemPrompt;
  }

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
    // Adaptive extended thinking: on supported models (Opus 4.7), Claude
    // decides per-turn whether deeper reasoning is worth the tokens.
    thinking: { type: "adaptive" },
  };

  // When advisor is on, pass the beta header + advisorModel via the SDK's
  // CLI passthrough (extraArgs). The agent SDK 0.2.126 doesn't expose these
  // on Options directly, but the underlying CLI binary accepts:
  //   --betas advisor-tool-2026-03-01
  //   --settings <json with advisorModel>
  // Once the SDK adds first-class support, swap to that.
  if (advisorActive && advisorModelId) {
    const inlineSettings = JSON.stringify({ advisorModel: advisorModelId });
    options.extraArgs = {
      ...(options.extraArgs ?? {}),
      betas: ADVISOR_BETA_HEADER,
      settings: inlineSettings,
    };
  }

  const stream = query({ prompt: inbox.iterable, options });

  if (advisorRequested && !advisorActive) {
    console.warn(
      "[agent] advisor preset ignored because LAB_ADVISOR_ENABLED is unset"
    );
  }

  // Pump SDK messages onto the WebSocket as they arrive.
  (async () => {
    try {
      for await (const msg of stream) {
        if (busy) armIdleTimer(turnSeq);
        if (msg.type === "result") {
          const turnCost = msg.total_cost_usd ?? 0;
          cumulativeCost += turnCost;

          // When advisor is active, split the turn's cost into executor and
          // advisor portions. Prefer iterations[] if the SDK surfaces it;
          // otherwise estimate from token rates. The split is cosmetic — the
          // top-level cumulativeCost remains authoritative for budget enforcement.
          let turnExecutorCost = turnCost;
          let turnAdvisorCost = 0;
          let turnAdvisorTokens = 0;
          let turnAdvisorCalls = 0;
          if (advisorActive && advisorModelId) {
            // The Anthropic API reports `usage.iterations[]` with one entry
            // per inference (executor messages + advisor sub-inferences).
            // The Agent SDK passes the API response usage through; it MAY
            // include iterations on advisor-tool runs.
            const iters: Array<{
              type?: string;
              model?: string;
              input_tokens?: number;
              output_tokens?: number;
            }> | undefined = (msg.usage as any)?.iterations;
            if (Array.isArray(iters) && iters.length > 0) {
              for (const it of iters) {
                if (it.type === "advisor_message") {
                  turnAdvisorCalls += 1;
                  const inT = it.input_tokens ?? 0;
                  const outT = it.output_tokens ?? 0;
                  turnAdvisorTokens += inT + outT;
                  turnAdvisorCost += estimateCost(advisorModelId, inT, outT);
                }
              }
              turnExecutorCost = Math.max(0, turnCost - turnAdvisorCost);
            } else {
              // Fallback: no iterations exposed. Estimate executor cost from
              // the top-level token counts and treat the remainder as advisor.
              const executorEstimate = estimateCost(
                executorModelId,
                msg.usage?.input_tokens ?? 0,
                msg.usage?.output_tokens ?? 0
              );
              turnExecutorCost = Math.min(turnCost, executorEstimate);
              turnAdvisorCost = Math.max(0, turnCost - turnExecutorCost);
            }
          }
          cumulativeExecutorCost += turnExecutorCost;
          cumulativeAdvisorCost += turnAdvisorCost;
          if (turnAdvisorCalls > 0) {
            advisorCallCount += turnAdvisorCalls;
            emit({
              type: "agent:advisor_used",
              advisorTokens: turnAdvisorTokens,
              advisorCostUsd: turnAdvisorCost,
              callCountThisSession: advisorCallCount,
            });
          }

          emit({
            type: "agent:turn_end",
            cost: turnCost,
            durationMs: msg.duration_ms ?? 0,
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
            subtype: msg.subtype ?? "unknown",
            cumulativeCostUsd: cumulativeCost,
            executorCostUsd: advisorActive ? turnExecutorCost : undefined,
            advisorCostUsd: advisorActive ? turnAdvisorCost : undefined,
            cumulativeExecutorCostUsd: advisorActive
              ? cumulativeExecutorCost
              : undefined,
            cumulativeAdvisorCostUsd: advisorActive
              ? cumulativeAdvisorCost
              : undefined,
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

function routeSdkMessage(msg: any, emit: AgentEventSink) {
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
    }
    return;
  }

  if (msg.type === "assistant") {
    const messageUuid: string | undefined = msg.uuid;
    const blocks = msg.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "text") {
        emit({ type: "agent:text", text: block.text, messageUuid });
      } else if (block.type === "tool_use") {
        emit({
          type: "agent:tool_use",
          toolUseId: block.id,
          tool: block.name,
          input: block.input,
        });
      }
    }
    return;
  }

  if (msg.type === "user") {
    const blocks = msg.message?.content ?? [];
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
      }
    }
    return;
  }

  // result is handled inline in the pump loop so we can update cumulative cost.
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
