/**
 * Phase 0 spike — prove the Claude Agent SDK can:
 *   1. Run an agent loop scoped to ./scratch as cwd
 *   2. Have it write files into that scratch dir
 *   3. Stream tool_use + text events to stdout in real time
 *   4. Report final cost + duration
 *
 * Run:   ANTHROPIC_API_KEY=... npm run spike
 */

// override:true is required because some shells (e.g. Claude for Desktop) export
// ANTHROPIC_API_KEY="" into the environment, which would otherwise block dotenv
// from loading the real key from .env.
import { config as loadDotenv } from "dotenv";
loadDotenv({ override: true });

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("missing ANTHROPIC_API_KEY (check cloudwise-lab/.env)");
  process.exit(1);
}

// The bundled claude CLI checks ~/.claude/.credentials.json + the macOS keychain
// before falling back to ANTHROPIC_API_KEY. If the host has stale oauth from a
// previous `claude login`, the CLI uses it and 401s. We point CLAUDE_CONFIG_DIR
// at a fresh empty temp dir per run so the CLI has nowhere to find oauth and is
// forced down the API-key path. Also clear any oauth env var that might leak.
const ISOLATED_CONFIG = await mkdtemp(join(tmpdir(), "cloudwise-lab-"));
process.env.CLAUDE_CONFIG_DIR = ISOLATED_CONFIG;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const SCRATCH = resolve("./scratch");
const MODEL = process.env.LAB_MODEL ?? "claude-sonnet-4-6";

const PROMPT = `You are running inside a real Node process; your filesystem tools write to the real filesystem.

Step 1: run \`pwd\` with the Bash tool. Print exactly what it returns.
Step 2: using the **absolute path** that pwd returned, write two files into that directory:
  - <pwd>/index.html — a one-page hero for a fictional coffee shop "Mountain Brew" (shop name, one-line tagline, "Visit Us" button). Single screen, no JS, no external assets.
  - <pwd>/style.css — clean modern mobile-friendly styles, warm coffee-themed colors.
Step 3: run \`ls\` and confirm both files exist.
Step 4: in one short sentence, tell the student what you built.

Do NOT use relative paths. Always pass the absolute path you got from pwd to Write.`;

const SYSTEM_PROMPT = `You are the agent powering Cloudwise Lab — a web-based coding playground for course students. Use your tools directly. Be friendly and concise. Do not ask permission before writing files; just build.`;

type ToolUseBlock = { type: "tool_use"; name: string; input: Record<string, unknown> };
type TextBlock = { type: "text"; text: string };
type ContentBlock = ToolUseBlock | TextBlock | { type: string; [k: string]: unknown };

async function main() {
  console.log(`scratch dir: ${SCRATCH}`);
  console.log(`model:       ${MODEL}\n`);

  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });

  const stream = query({
    prompt: PROMPT,
    options: {
      cwd: SCRATCH,
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: ["Read", "Write", "Edit", "Bash"],
      permissionMode: "acceptEdits",
      maxTurns: 12,
    },
  });

  for await (const msg of stream) {
    handleMessage(msg);
  }

  await listScratchContents();
}

function handleMessage(msg: any) {
  if (msg.type === "assistant") {
    const blocks: ContentBlock[] = msg.message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "text") {
        process.stdout.write(`\n💬 ${(block as TextBlock).text}\n`);
      } else if (block.type === "tool_use") {
        const t = block as ToolUseBlock;
        const summary = formatToolInput(t);
        process.stdout.write(`\n🔧 ${t.name}(${summary})\n`);
      }
    }
  } else if (msg.type === "user") {
    // Tool results come back as user messages with tool_result content blocks.
    const blocks: ContentBlock[] = msg.message?.content ?? [];
    for (const block of blocks) {
      if ((block as any).type === "tool_result") {
        const r = block as any;
        const content =
          typeof r.content === "string"
            ? r.content
            : Array.isArray(r.content)
              ? r.content.map((c: any) => c.text ?? JSON.stringify(c)).join("")
              : JSON.stringify(r.content);
        const trimmed = content.length > 300 ? content.slice(0, 300) + "…" : content;
        const tag = r.is_error ? "⚠️ " : "↩️ ";
        process.stdout.write(`\n${tag}${trimmed.replace(/\n/g, "\n   ")}\n`);
      }
    }
  } else if (msg.type === "result") {
    const cost = msg.total_cost_usd?.toFixed(4) ?? "?";
    const ms = msg.duration_ms ?? 0;
    const inTok = msg.usage?.input_tokens ?? 0;
    const outTok = msg.usage?.output_tokens ?? 0;
    console.log(
      `\n✅ ${msg.subtype} — ${ms}ms, $${cost}, ${inTok} in / ${outTok} out, ${msg.num_turns ?? "?"} turns`
    );
  } else if (msg.type === "system") {
    // Init / config events. Quiet by default; uncomment to debug.
    // console.log(`[system] ${msg.subtype ?? ""}`);
  }
}

function formatToolInput(block: ToolUseBlock): string {
  const i = block.input ?? {};
  const path = (i.file_path ?? i.path) as string | undefined;
  if (path) {
    const rel = relative(SCRATCH, resolve(SCRATCH, path));
    return rel || path;
  }
  if (typeof (i as any).command === "string") return (i as any).command;
  return "...";
}

async function listScratchContents() {
  const entries = await readdir(SCRATCH, { withFileTypes: true });
  console.log(`\n📂 scratch dir contents (${entries.length} entries):`);
  for (const e of entries) {
    console.log(`   ${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
  }
  if (entries.length === 0) {
    console.log("   (empty — agent did not write anything)");
  }
}

main().catch((err) => {
  console.error("\n❌ spike failed:", err);
  process.exit(1);
});
