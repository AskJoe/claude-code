/**
 * Transcript export.
 *
 * GET /api/projects/:id/sessions/:sid/export?format=markdown|html|json
 *
 * Reads the messages table (one row per server event, stored by the WS
 * handler in server/index.ts) and renders the human turns as a downloadable
 * file. The `:sid` parameter mirrors what the future sessions sidebar will
 * carry — today the lab has one session per project, so we accept the
 * project id (or the literal string "default") and treat the response as
 * the project's full transcript.
 *
 * Auth: same authMiddleware as other project endpoints. Only the project's
 * owner (or an admin) can export.
 */

import type { Hono } from "hono";
import { authMiddleware, type AuthUser } from "./auth.ts";
import { getProjectById, listMessages, type MessageRow } from "./db.ts";
import { getProjectFor } from "./projects.ts";
import type { ServerEvent } from "../shared/events.ts";
import { log } from "./log.ts";

type Turn =
  | { kind: "user"; text: string; ts: string }
  | { kind: "assistant"; text: string; ts: string }
  | { kind: "tool_use"; tool: string; input: unknown; ts: string }
  | { kind: "tool_result"; ok: boolean; preview: string; ts: string }
  | { kind: "system"; text: string; ts: string };

export function mountExport(app: Hono): void {
  app.get(
    "/api/projects/:id/sessions/:sid/export",
    authMiddleware,
    async (c) => {
      const user = c.get("user") as AuthUser;
      const id = Number(c.req.param("id"));
      if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);

      // Owner or admin only.
      let project = getProjectFor(user.id, id);
      if (!project && user.isAdmin) {
        project = getProjectById(id) ?? null;
      }
      if (!project) return c.json({ error: "not found" }, 404);

      const sid = c.req.param("sid");
      // Right now the lab has one session per project. Accept the project id
      // as a string, "default", or a numeric session id that matches the
      // project. Anything else → 404.
      if (sid !== "default" && sid !== String(id)) {
        return c.json({ error: "session not found" }, 404);
      }

      const formatRaw = (c.req.query("format") ?? "markdown").toLowerCase();
      const format =
        formatRaw === "html" || formatRaw === "json" ? formatRaw : "markdown";

      const rows = listMessages(project.id, 5000);
      const turns = rowsToTurns(rows);

      const exportedAt = new Date().toISOString();
      const fname = `cloudwise-lab-${project.id}-${sid}.${extFor(format)}`;

      let body: string;
      let mime: string;
      try {
        if (format === "json") {
          body = JSON.stringify(
            {
              messages: turns,
              meta: {
                sessionId: sid,
                projectId: project.id,
                projectName: project.display_name,
                exportedAt,
              },
            },
            null,
            2
          );
          mime = "application/json; charset=utf-8";
        } else if (format === "html") {
          body = renderHtml({
            projectName: project.display_name,
            sessionId: sid,
            exportedAt,
            turns,
          });
          mime = "text/html; charset=utf-8";
        } else {
          body = renderMarkdown({
            projectName: project.display_name,
            sessionId: sid,
            exportedAt,
            turns,
          });
          mime = "text/markdown; charset=utf-8";
        }
      } catch (err: any) {
        log.error("export render failed", {
          projectId: id,
          format,
          err: err?.message ?? String(err),
        });
        return c.json({ error: "export render failed" }, 500);
      }

      return new Response(body, {
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `attachment; filename="${fname}"`,
          "Cache-Control": "no-store",
        },
      });
    }
  );
}

function extFor(format: "markdown" | "html" | "json"): string {
  if (format === "html") return "html";
  if (format === "json") return "json";
  return "md";
}

function rowsToTurns(rows: MessageRow[]): Turn[] {
  const out: Turn[] = [];
  for (const row of rows) {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(row.content_json) as ServerEvent;
    } catch {
      continue;
    }
    const ts = row.created_at;
    switch (evt.type) {
      case "chat:user_message":
        out.push({ kind: "user", text: evt.text, ts });
        break;
      case "agent:text":
        out.push({ kind: "assistant", text: evt.text, ts });
        break;
      case "agent:tool_use":
        out.push({
          kind: "tool_use",
          tool: evt.tool,
          input: evt.input,
          ts,
        });
        break;
      case "agent:tool_result":
        out.push({
          kind: "tool_result",
          ok: evt.ok,
          preview: evt.preview,
          ts,
        });
        break;
      case "agent:error":
        out.push({ kind: "system", text: `Error: ${evt.message}`, ts });
        break;
      // Skip turn_end / chunk / streaming / build state events — too noisy
      // for an exported transcript.
      default:
        break;
    }
  }
  return out;
}

// ── Markdown ────────────────────────────────────────────────────────────────

function renderMarkdown(input: {
  projectName: string;
  sessionId: string;
  exportedAt: string;
  turns: Turn[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${input.projectName}`);
  lines.push("");
  lines.push(
    `_Cloudwise Lab transcript · session ${input.sessionId} · exported ${input.exportedAt}_`
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const turn of input.turns) {
    if (turn.kind === "user") {
      lines.push(`**user**:`);
      lines.push("");
      lines.push(turn.text);
      lines.push("");
    } else if (turn.kind === "assistant") {
      lines.push(`**assistant**:`);
      lines.push("");
      lines.push(turn.text);
      lines.push("");
    } else if (turn.kind === "tool_use") {
      lines.push(`**tool**: \`${turn.tool}\``);
      lines.push("");
      lines.push("```json");
      lines.push(safeJson(turn.input));
      lines.push("```");
      lines.push("");
    } else if (turn.kind === "tool_result") {
      const tag = turn.ok ? "result" : "result (error)";
      lines.push(`**${tag}**:`);
      lines.push("");
      lines.push("```");
      lines.push(turn.preview);
      lines.push("```");
      lines.push("");
    } else if (turn.kind === "system") {
      lines.push(`> ${turn.text}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ── HTML ────────────────────────────────────────────────────────────────────

function renderHtml(input: {
  projectName: string;
  sessionId: string;
  exportedAt: string;
  turns: Turn[];
}): string {
  const turnsHtml = input.turns
    .map((turn) => {
      if (turn.kind === "user") {
        return `<section class="turn turn-user">
  <h3>user</h3>
  <div class="body">${escapeHtml(turn.text).replace(/\n/g, "<br>")}</div>
</section>`;
      }
      if (turn.kind === "assistant") {
        return `<section class="turn turn-assistant">
  <h3>assistant</h3>
  <div class="body">${escapeHtml(turn.text).replace(/\n/g, "<br>")}</div>
</section>`;
      }
      if (turn.kind === "tool_use") {
        return `<section class="turn turn-tool">
  <h3>tool · ${escapeHtml(turn.tool)}</h3>
  <pre>${escapeHtml(safeJson(turn.input))}</pre>
</section>`;
      }
      if (turn.kind === "tool_result") {
        const cls = turn.ok ? "tool-ok" : "tool-err";
        return `<section class="turn turn-tool ${cls}">
  <h3>result</h3>
  <pre>${escapeHtml(turn.preview)}</pre>
</section>`;
      }
      return `<section class="turn turn-system">
  <p>${escapeHtml(turn.text)}</p>
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.projectName)} — Cloudwise Lab transcript</title>
<style>
  :root {
    --bg: #faf9f7;
    --bg-2: #f4f2ed;
    --bg-panel: #ffffff;
    --border: #ebe8e1;
    --text: #1a1916;
    --text-2: #74716b;
    --text-3: #989590;
    --accent: #c96442;
    --ok: #1f7a3a;
    --err: #9c2a25;
    --serif: 'Source Serif Pro', 'Iowan Old Style', Georgia, serif;
    --sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
  }
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 48px 24px 96px;
  }
  header.page-head {
    border-bottom: 1px solid var(--border);
    padding-bottom: 24px;
    margin-bottom: 32px;
  }
  h1 {
    font-family: var(--serif);
    font-weight: 600;
    font-size: 32px;
    margin: 0 0 8px;
    color: #0d0c0a;
  }
  .meta {
    color: var(--text-3);
    font-size: 13px;
    font-family: var(--mono);
  }
  .turn {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 20px;
    margin: 0 0 16px;
  }
  .turn h3 {
    font-family: var(--serif);
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 10px;
    color: var(--accent);
    text-transform: lowercase;
    letter-spacing: 0.3px;
  }
  .turn .body { white-space: pre-wrap; word-wrap: break-word; }
  .turn-user {
    border-left: 3px solid var(--accent);
  }
  .turn-assistant { background: var(--bg-2); }
  .turn-tool {
    background: var(--bg-2);
    border-left: 3px solid var(--text-3);
  }
  .turn-tool h3 { color: var(--text-2); }
  .turn-tool.tool-err { border-left-color: var(--err); }
  .turn-tool.tool-err h3 { color: var(--err); }
  .turn-system {
    color: var(--text-2);
    font-style: italic;
    background: transparent;
    border: none;
    padding: 4px 0;
  }
  pre {
    font-family: var(--mono);
    font-size: 12px;
    background: #0d0c0a08;
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 0;
  }
</style>
</head>
<body>
<main>
  <header class="page-head">
    <h1>${escapeHtml(input.projectName)}</h1>
    <div class="meta">Cloudwise Lab transcript · session ${escapeHtml(
      input.sessionId
    )} · exported ${escapeHtml(input.exportedAt)}</div>
  </header>
  ${turnsHtml}
</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
