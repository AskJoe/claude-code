/**
 * Global search across the active project's session dir + chat history.
 *
 * Endpoint: GET /api/projects/:id/search?q=<term>
 *
 * Walks the session's file tree skipping node_modules / dist / .git,
 * scans up to 1000 files at most, returns top 50 hits as
 *   { file: string, line: number, text: string }.
 *
 * Also scans the project's persisted message history (last 200) and returns
 * matching snippets as { messageId, role, text }.
 *
 * No ripgrep dependency — pure node fs + line scan keeps the binary trim.
 * For most student projects (a few dozen .html / .css files) this is plenty
 * fast.
 */

import type { Hono } from "hono";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { authMiddleware } from "./auth.ts";
import { getProjectFor, projectDir as resolveProjectDir } from "./projects.ts";
import { listMessages } from "./db.ts";
import { log } from "./log.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".cache",
  ".vscode",
  ".idea",
]);
const TEXT_EXT = new Set([
  ".html",
  ".css",
  ".scss",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".yml",
  ".yaml",
  ".svg",
  ".xml",
  "",
]);
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 256 * 1024; // 256 KB
const MAX_HITS = 50;
const MAX_CHAT_HITS = 30;

type FileHit = {
  file: string;
  line: number;
  text: string;
};

type ChatHit = {
  messageId: number;
  role: string;
  text: string;
  createdAt: string;
};

async function* walkFiles(root: string): AsyncGenerator<string> {
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length && visited < MAX_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      visited += 1;
      yield full;
      if (visited >= MAX_FILES) break;
    }
  }
}

function getExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

async function searchFile(
  abs: string,
  rel: string,
  needle: string,
  hits: FileHit[]
) {
  if (hits.length >= MAX_HITS) return;
  let s;
  try {
    s = await stat(abs);
  } catch {
    return;
  }
  if (s.size > MAX_FILE_BYTES) return;
  let buf: string;
  try {
    buf = await readFile(abs, "utf-8");
  } catch {
    return;
  }
  const lower = needle.toLowerCase();
  const lines = buf.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (hits.length >= MAX_HITS) break;
    const line = lines[i];
    if (line.toLowerCase().includes(lower)) {
      const trimmed = line.length > 240 ? line.slice(0, 240) + "…" : line;
      hits.push({ file: rel, line: i + 1, text: trimmed.trim() });
    }
  }
}

export function mountSearch(app: Hono): void {
  app.get("/api/projects/:id/search", authMiddleware, async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const project = getProjectFor(user.id, id);
    if (!project) return c.json({ error: "not found" }, 404);

    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ files: [], chat: [] });
    if (q.length < 2)
      return c.json({ error: "query must be at least 2 chars" }, 400);

    const root = resolveProjectDir(id);
    const fileHits: FileHit[] = [];
    try {
      for await (const abs of walkFiles(root)) {
        if (fileHits.length >= MAX_HITS) break;
        const rel = relative(root, abs);
        const ext = getExt(rel);
        if (!TEXT_EXT.has(ext)) continue;
        await searchFile(abs, rel, q, fileHits);
      }
    } catch (err: any) {
      log.warn("search walk failed", {
        projectId: id,
        err: err?.message ?? String(err),
      });
    }

    // Chat history: scan last 200 messages, return matching snippets.
    const chatHits: ChatHit[] = [];
    try {
      const lower = q.toLowerCase();
      const msgs = listMessages(id, 200);
      for (const m of msgs) {
        if (chatHits.length >= MAX_CHAT_HITS) break;
        // content_json is a stringified ServerEvent; cheap substring match
        // on the raw JSON catches both `text` fields and tool inputs.
        if (!m.content_json.toLowerCase().includes(lower)) continue;
        // Pull a short readable snippet — try common fields.
        let snippet = "";
        try {
          const parsed = JSON.parse(m.content_json);
          snippet =
            (typeof parsed.text === "string" && parsed.text) ||
            (typeof parsed.message === "string" && parsed.message) ||
            "";
        } catch {}
        if (!snippet) snippet = m.content_json.slice(0, 200);
        // Highlight context: clip around the match if the snippet is long.
        const matchIdx = snippet.toLowerCase().indexOf(lower);
        if (matchIdx > 80) snippet = "…" + snippet.slice(matchIdx - 60);
        if (snippet.length > 240) snippet = snippet.slice(0, 240) + "…";
        chatHits.push({
          messageId: m.id,
          role: m.role,
          text: snippet.trim(),
          createdAt: m.created_at,
        });
      }
    } catch (err: any) {
      log.warn("search chat scan failed", {
        projectId: id,
        err: err?.message ?? String(err),
      });
    }

    return c.json({ files: fileHits, chat: chatHits });
  });
}
