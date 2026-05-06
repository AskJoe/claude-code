/**
 * Cloudwise Lab — Hono server entry point.
 *
 * Routes:
 *   GET  /health
 *   GET  /api/me                            current user (or null)
 *   POST /api/auth/signup
 *   POST /api/auth/signin
 *   POST /api/auth/logout
 *   GET  /api/projects                      list current user's projects
 *   POST /api/projects                      create
 *   POST /api/projects/:id/rename
 *   DELETE /api/projects/:id
 *   GET  /api/github/status                 connection state for current user
 *   GET  /api/github/connect                start OAuth (registered by github-oauth.ts)
 *   GET  /api/github/callback               OAuth return        (ditto)
 *   POST /api/github/disconnect             remove the connection (ditto)
 *   GET  /preview/:projectId/*              static files from a project's dir
 *   WS   /ws?projectId=N                    chat stream scoped to that project
 */

import "./env.ts";

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { join as pjoin, dirname as pdirname } from "node:path";

import { startAgent } from "./agent.ts";
import { getSettings } from "./settings.ts";
import { registerAdminRoutes } from "./admin.ts";
import { openSession, type Session } from "./sessions.ts";
import { PORT } from "./env.ts";
import { createRateLimiter } from "./rate-limit.ts";
import {
  authMiddleware,
  readUser,
  readUserForWs,
  REQUIRE_AUTH,
  registerAuthRoutes,
  type AuthUser,
} from "./auth.ts";
import { registerGitHubAppRoutes, APP_CONFIGURED } from "./github-app.ts";
import { distExists, mountSpa } from "./static.ts";
import { log } from "./log.ts";
import {
  createProjectFor,
  deleteProjectAndDir,
  ensureProjectStarter,
  getProjectFor,
  listProjectsFor,
  projectDir,
  publicProject,
  type PublicProject,
} from "./projects.ts";
import {
  appendMessage,
  archiveAndStartNewChatSession,
  getChatSession,
  getOrCreateActiveChatSession,
  listChatSessions,
  listMessagesForSession,
  updateChatSessionMeta,
  type ChatSessionRow,
  deleteGithubConnection,
  getGithubConnection,
  getProjectById,
  listMessages,
  renameProject,
  setProjectRenderSiteUrl,
  touchProject,
} from "./db.ts";
import { connectExistingRepoForProject, startAutoSync, type AutoSyncer } from "./github-sync.ts";
import { PREVIEW_EDITOR_RUNTIME } from "./preview-editor-runtime.ts";
import {
  buildDeployUrl,
  commitRenderYaml,
  predictedSiteUrl,
} from "./render-publish.ts";
import {
  listCommitsForProject,
  revertProjectToCommit,
} from "./git-history.ts";
import {
  getPublishStatus,
  publishPromote,
} from "./publish-promote.ts";
import { resolveSessionPath } from "./sessions.ts";
import { mountUploads } from "./uploads.ts";
import { mountSearch } from "./search.ts";
import { mountCostSummary } from "./cost-summary.ts";
import { mountExport } from "./export.ts";
import type {
  ClientCommand,
  FileNode,
  ServerEvent,
} from "../shared/events.ts";


const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// ── Static + simple endpoints ────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true }));

// /api/me — open endpoint, returns user or null. The SPA uses this to decide
// whether to show the sign-in screen.
app.get("/api/me", async (c) => {
  const user = await readUser(c);
  return c.json({
    user,
    requireAuth: REQUIRE_AUTH,
    githubOauthConfigured: APP_CONFIGURED,
  });
});

registerAuthRoutes(app);
registerGitHubAppRoutes(app);
registerAdminRoutes(app);

// ── Projects API ─────────────────────────────────────────────────────────────

app.get("/api/projects", authMiddleware, (c) => {
  const user = c.get("user");
  return c.json({ projects: listProjectsFor(user.id).map(publicProject) });
});

app.post("/api/projects", authMiddleware, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const displayName =
    typeof body?.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim().slice(0, 80)
      : "Untitled project";
  const project = await createProjectFor(user.id, displayName);
  return c.json({ project: publicProject(project) });
});

app.post("/api/projects/:id/rename", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const displayName =
    typeof body?.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim().slice(0, 80)
      : null;
  if (!displayName) return c.json({ error: "displayName required" }, 400);
  renameProject(id, displayName);
  return c.json({ ok: true });
});

// List all chat sessions for a project, newest active first then archived.
app.get("/api/projects/:id/chat-sessions", authMiddleware, (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  const sessions = listChatSessions(id).map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.created_at,
    lastMessageAt: s.last_message_at,
    messageCount: s.message_count,
    totalCostUsd: s.total_cost_usd,
    archived: s.archived_at !== null,
  }));
  return c.json({ sessions });
});

// Replay messages for a specific (typically archived) chat session as a
// JSON list. Used by the sidebar's "view archived chat" mode.
app.get(
  "/api/projects/:id/chat-sessions/:sid/messages",
  authMiddleware,
  (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const sid = Number(c.req.param("sid"));
    if (!Number.isFinite(id) || !Number.isFinite(sid))
      return c.json({ error: "bad id" }, 400);
    const project = getProjectFor(user.id, id);
    if (!project) return c.json({ error: "not found" }, 404);
    const session = getChatSession(id, sid);
    if (!session) return c.json({ error: "session not found" }, 404);
    const rows = listMessagesForSession(id, sid, 500);
    // Inflate stored content_json into ServerEvent shapes for the client.
    const messages = rows
      .map((r) => {
        try {
          return JSON.parse(r.content_json);
        } catch {
          return null;
        }
      })
      .filter((m): m is Record<string, unknown> => m !== null);
    return c.json({
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.created_at,
        lastMessageAt: session.last_message_at,
        messageCount: session.message_count,
        totalCostUsd: session.total_cost_usd,
        archived: session.archived_at !== null,
      },
      messages,
    });
  }
);

app.get("/api/projects/:id/publish-status", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  if (!project.github_repo_full_name) {
    return c.json({
      status: {
        aheadBy: 0,
        behindBy: 0,
        hasUnpublished: false,
        mainSha: null,
        workingSha: null,
      },
    });
  }
  const conn = getGithubConnection(user.id);
  if (!conn) {
    return c.json({
      status: {
        aheadBy: 0,
        behindBy: 0,
        hasUnpublished: false,
        mainSha: null,
        workingSha: null,
      },
    });
  }
  try {
    const status = await getPublishStatus({
      project,
      installationId: conn.installation_id,
    });
    return c.json({ status });
  } catch (err: any) {
    log.error("publish-status failed", {
      projectId: id,
      err: err?.message ?? String(err),
    });
    return c.json({ error: err?.message ?? "publish-status failed" }, 500);
  }
});

app.post("/api/projects/:id/publish-promote", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  if (!project.github_repo_full_name) {
    return c.json({ error: "project not connected to GitHub" }, 400);
  }
  const conn = getGithubConnection(user.id);
  if (!conn) return c.json({ error: "GitHub not connected" }, 400);

  try {
    const { promotedSha } = await publishPromote({
      project,
      installationId: conn.installation_id,
      projectDir: projectDir(id),
    });
    return c.json({ ok: true, promotedSha });
  } catch (err: any) {
    log.error("publish-promote failed", {
      projectId: id,
      err: err?.message ?? String(err),
    });
    return c.json({ error: err?.message ?? "publish-promote failed" }, 500);
  }
});

app.get("/api/projects/:id/commits", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  if (!project.github_repo_full_name) return c.json({ commits: [] });
  const conn = getGithubConnection(user.id);
  if (!conn) return c.json({ commits: [] });

  try {
    const commits = await listCommitsForProject({
      project,
      installationId: conn.installation_id,
      perPage: 30,
    });
    return c.json({ commits });
  } catch (err: any) {
    log.error("list commits failed", {
      projectId: id,
      err: err?.message ?? String(err),
    });
    return c.json({ error: err?.message ?? "list commits failed" }, 500);
  }
});

app.post("/api/projects/:id/commits/:sha/revert", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const sha = c.req.param("sha");
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  if (!/^[a-f0-9]{7,40}$/.test(sha)) return c.json({ error: "bad sha" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  if (!project.github_repo_full_name) {
    return c.json({ error: "project not connected to GitHub" }, 400);
  }
  const conn = getGithubConnection(user.id);
  if (!conn) return c.json({ error: "GitHub not connected" }, 400);

  try {
    await revertProjectToCommit({
      project,
      installationId: conn.installation_id,
      sha,
      projectDir: projectDir(id),
    });
    return c.json({ ok: true });
  } catch (err: any) {
    log.error("revert failed", {
      projectId: id,
      sha,
      err: err?.message ?? String(err),
    });
    return c.json({ error: err?.message ?? "revert failed" }, 500);
  }
});

app.post("/api/projects/:id/render/prepare-deploy", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  if (!project.github_repo_full_name) {
    return c.json({ error: "Connect GitHub for this project first" }, 400);
  }
  if (!getGithubConnection(user.id)) {
    return c.json({ error: "GitHub not connected" }, 400);
  }
  try {
    await commitRenderYaml({
      userId: user.id,
      projectId: id,
      projectDir: projectDir(id),
    });
    const fresh = getProjectFor(user.id, id)!;
    return c.json({
      ok: true,
      deployUrl: buildDeployUrl(fresh),
      predictedSiteUrl: predictedSiteUrl(fresh),
    });
  } catch (err: any) {
    log.error("prepare-deploy failed", { projectId: id, err: err?.message ?? String(err) });
    return c.json({ error: err?.message ?? "prepare-deploy failed" }, 500);
  }
});

app.get("/api/projects/:id/render/probe", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);

  // Use the saved render_site_url if confirmed; otherwise probe the predicted
  // URL. Predicted is only valid once the project has a GitHub repo.
  let url: string | null = project.render_site_url;
  if (!url) {
    if (!project.github_repo_full_name) {
      return c.json({ live: false, url: null, reason: "no_repo" });
    }
    url = predictedSiteUrl(project);
  }

  // HEAD with a short timeout. Render's static-site URL returns 200 once
  // deployed and 404 before (or while DNS is propagating).
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    return c.json({
      live: res.status >= 200 && res.status < 400,
      status: res.status,
      url,
    });
  } catch (err: any) {
    return c.json({
      live: false,
      status: 0,
      url,
      error: err?.name === "AbortError" ? "timeout" : (err?.message ?? "fetch failed"),
    });
  } finally {
    clearTimeout(t);
  }
});

app.post("/api/projects/:id/render/confirm-deployed", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);

  const body = await c.req.json().catch(() => ({} as any));
  let siteUrl: string;
  if (typeof body?.siteUrl === "string" && body.siteUrl.trim()) {
    siteUrl = body.siteUrl.trim();
    // Light validation — must look like a URL
    if (!/^https?:\/\//.test(siteUrl)) {
      return c.json({ error: "siteUrl must be a full URL starting with http(s)://" }, 400);
    }
  } else {
    // Default to the predicted URL based on the service name in render.yaml.
    siteUrl = predictedSiteUrl(project);
  }
  setProjectRenderSiteUrl(id, siteUrl);
  log.info("render site confirmed", { projectId: id, siteUrl });
  return c.json({ ok: true, siteUrl });
});

app.post("/api/projects/:id/github/connect-repo", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  if (!getGithubConnection(user.id)) {
    return c.json({ error: "GitHub not connected — link your GitHub account first" }, 400);
  }
  try {
    const result = await connectExistingRepoForProject({
      userId: user.id,
      projectId: id,
      projectDir: projectDir(id),
    });
    if (result.kind === "repo_not_found") {
      // Soft signal — the user hasn't created the repo on GitHub yet. The
      // client polls this endpoint while waiting; 200 + ready:false keeps
      // that polling clean instead of spamming 5xx errors.
      return c.json({
        ok: true,
        ready: false,
        expectedFullName: result.expectedFullName,
      });
    }
    return c.json({
      ok: true,
      ready: true,
      repoFullName: result.repoFullName,
      defaultBranch: result.defaultBranch,
    });
  } catch (err: any) {
    log.error("connect-repo failed", { projectId: id, err: err?.message ?? String(err) });
    return c.json({ error: err?.message ?? "connect-repo failed" }, 500);
  }
});

// File uploads (POST /api/projects/:id/upload)
mountUploads(app);

// Global search across files + chat history (GET /api/projects/:id/search)
mountSearch(app);

// Cost summary (GET /api/projects/:id/cost-summary)
mountCostSummary(app);

// Transcript export (GET /api/projects/:id/sessions/:sid/export)
mountExport(app);

// Legacy endpoint kept for already-loaded clients. Static previews do not
// have a builder process; saving a file updates the served source directly.
app.post("/api/projects/:id/builder/restart", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  return c.json({
    ok: true,
    reason: "static preview serves source files directly; no builder restart needed",
  });
});

// PUT /api/projects/:id/files — write a single text file inside the session
// directory. Used by the inline Monaco editor on ⌘S. Path traversal is
// blocked by reusing `resolveSessionPath`'s safety check via a temporary
// session shim — we don't open a full chokidar session here; the live
// session's watcher will pick the change up via fs events.
app.put("/api/projects/:id/files", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);

  const body = await c.req.json().catch(() => ({} as any));
  const path = typeof body?.path === "string" ? body.path : null;
  const content = typeof body?.content === "string" ? body.content : null;
  if (!path) return c.json({ error: "path required" }, 400);
  if (content === null) return c.json({ error: "content required" }, 400);

  // Reuse the same path-safety check used by the live session so we can't
  // be tricked into writing outside the project dir. We construct a minimal
  // Session-shaped object — only `rootDir` is needed by `resolveSessionPath`.
  const root = projectDir(id);
  const shim = { rootDir: root } as unknown as Session;
  let abs: string;
  try {
    abs = await resolveSessionPath(shim, path);
  } catch (err: any) {
    return c.json({ error: err?.message ?? "bad path" }, 400);
  }

  // Reject obvious binary keys / writing into unsafe locations.
  if (/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(path)) {
    return c.json({ error: "cannot write inside generated/vendor dirs" }, 400);
  }
  // Cap payload — Monaco shouldn't be saving giant files, but be safe.
  if (content.length > 2 * 1024 * 1024) {
    return c.json({ error: "file too large (>2MB)" }, 400);
  }

  try {
    await mkdir(pdirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
    const s = await stat(abs);
    return c.json({ ok: true, mtime: s.mtimeMs });
  } catch (err: any) {
    log.error("file write failed", {
      projectId: id,
      path,
      err: err?.message ?? String(err),
    });
    return c.json({ error: err?.message ?? "write failed" }, 500);
  }
});

app.delete("/api/projects/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const project = getProjectFor(user.id, id);
  if (!project) return c.json({ error: "not found" }, 404);
  await deleteProjectAndDir(id);
  return c.json({ ok: true });
});

// ── GitHub status ────────────────────────────────────────────────────────────

app.get("/api/github/status", authMiddleware, (c) => {
  const user = c.get("user");
  const conn = getGithubConnection(user.id);
  return c.json({
    configured: APP_CONFIGURED,
    connected: !!conn,
    githubLogin: conn?.github_login ?? null,
    connectedAt: conn?.connected_at ?? null,
    installationId: conn?.installation_id ?? null,
  });
});

// Disconnect the user's GitHub account. Drops our copy of their tokens; the
// user can re-authorize anytime via the existing connect-repo flow. We don't
// uninstall the GitHub App on their side — that's a separate user action on
// github.com.
app.post("/api/github/disconnect", authMiddleware, (c) => {
  const user = c.get("user");
  deleteGithubConnection(user.id);
  log.info("github disconnected", { userId: user.id });
  return c.json({ ok: true });
});

// ── Preview ──────────────────────────────────────────────────────────────────

const liveSessions = new Map<number, Session>();
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

app.get("/preview/:projectId/*", authMiddleware, async (c) => {
  const user = c.get("user");
  const projectId = Number(c.req.param("projectId"));
  if (!Number.isFinite(projectId)) return c.text("bad project id", 400);
  const project = getProjectFor(user.id, projectId);
  if (!project) return c.text("not found", 404);
  const session = liveSessions.get(projectId);
  if (!session) return c.text("project not open", 404);

  const wildcard = c.req.path.replace(`/preview/${projectId}/`, "") || "index.html";
  const raw = c.req.query("raw") === "1";

  // Static runtime: serve the student's source files directly from the
  // project root. Routes are file-based: /about -> about.html,
  // /docs/ -> docs/index.html, /style.css -> style.css.
  let abs: string | null = null;
  const candidates = previewCandidates(wildcard);
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = await resolveSessionPath(session, candidate);
    } catch {
      continue;
    }
    try {
      const s = await stat(resolved);
      if (s.isDirectory()) {
        const indexed = pjoin(resolved, "index.html");
        try {
          await stat(indexed);
          abs = indexed;
          break;
        } catch {
          continue;
        }
      } else {
        abs = resolved;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!abs) {
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>file not found</title></head>
       <body style="font-family:system-ui;color:#666;padding:32px;text-align:center;">
         <p style="font-size:14px;">Static preview file not found: <code>${escapeHtml(wildcard)}</code></p>
       </body></html>`,
      404
    );
  }

  const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
  const buf = await readFile(abs);
  // raw=1 forces text/plain so the Code view can fetch HTML/CSS/JS as source
  // rather than rendering it.

  // For HTML responses (the rendered preview), inject the click-to-edit
  // runtime right before </body>. We don't inject for raw views (Code tab)
  // or for non-HTML assets.
  if (!raw && ext === ".html") {
    const html = buf.toString("utf-8");
    // Prefix root-rooted href/src/srcset paths with the project preview
    // namespace so `/styles.css` resolves to `/preview/<id>/styles.css`.
    const rewritten = rewriteRootPaths(html, projectId);
    const injected = injectEditorRuntime(rewritten);
    return new Response(injected, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "SAMEORIGIN",
      },
    });
  }

  // Long-cache uploaded images / PDFs — they're content-addressed (random
  // 8-char prefix) so the URL is stable for a given file. Scope strictly to
  // `/preview/<id>/uploads/...` so iframe HTML / JS / CSS reloads still see
  // fresh content after a build.
  const isUpload = wildcard.startsWith("uploads/");
  const cacheableExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"]);
  const longCache = !raw && isUpload && cacheableExts.has(ext);

  return new Response(buf, {
    headers: {
      "Content-Type": raw
        ? "text/plain; charset=utf-8"
        : (MIME[ext] ?? "text/plain; charset=utf-8"),
      "Cache-Control": longCache
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
});

/**
 * Returns the source-file candidates for a preview URL path.
 */
function previewCandidates(wildcard: string): string[] {
  const clean = wildcard.replace(/^\/+/, "") || "index.html";
  const out = new Set<string>();
  out.add(clean);
  if (clean.endsWith("/")) {
    out.add(pjoin(clean, "index.html"));
  } else if (!clean.includes(".") && clean !== "index.html") {
    out.add(`${clean}.html`);
    out.add(pjoin(clean, "index.html"));
  }
  return [...out];
}

/**
 * The preview iframe is served from `/preview/<id>/`, so root-rooted URLs
 * need to be prefixed with the same path or the browser fetches them from
 * the lab's root.
 *
 * Rewrites `(href|src|srcset)="/..."` to `(href|src|srcset)="/preview/<id>/..."`
 * for any path that:
 *   - starts with a single `/` (so we don't touch `//cdn.example` protocol-
 *     relative URLs), AND
 *   - isn't already prefixed with `/preview/`.
 *
 * This catches CSS/JS/images and any in-site links the user may have added.
 */
function rewriteRootPaths(html: string, projectId: number): string {
  const prefix = `/preview/${projectId}`;
  // (?:["'])  — opening quote captured separately so we keep it intact
  // \/        — root-rooted path
  // (?![\/p]) — negative lookahead: skip `//` (protocol-relative) and any
  //             path that already begins with `/preview/`
  return html.replace(
    /(\b(?:href|src|srcset)\s*=\s*["'])\/(?!\/|preview\/)/g,
    `$1${prefix}/`
  );
}

/**
 * Splices the click-to-edit script into a served HTML page right before
 * </body>. Falls back to appending if there's no </body> (e.g., partial
 * HTML).
 */
function injectEditorRuntime(html: string): string {
  const tag = `<script>${PREVIEW_EDITOR_RUNTIME}</script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${tag}</body>`);
  }
  return html + tag;
}

// ── WebSocket: /ws?projectId=N ───────────────────────────────────────────────

app.use("/ws", async (c, next) => {
  const user = await readUserForWs(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  return next();
});

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const user = c.get("user") as AuthUser | undefined;
    const projectId = Number(c.req.query("projectId"));
    const wsMode: "code" | "plan" =
      c.req.query("mode") === "plan" ? "plan" : "code";
    // Per-session executor + advisor preset, picked client-side from
    // localStorage (`lab.modelPreset`) and forwarded on WS open. Defaults
    // mirror the lab-wide setting when absent or invalid.
    const validExecutors = new Set([
      "haiku-4.5",
      "sonnet-4.6",
      "opus-4.6",
      "opus-4.7",
    ]);
    const executorRaw = c.req.query("executor") ?? "";
    const wsExecutor = validExecutors.has(executorRaw)
      ? (executorRaw as "haiku-4.5" | "sonnet-4.6" | "opus-4.6" | "opus-4.7")
      : undefined;
    const wsAdvisor =
      c.req.query("advisor") === "opus-4.7" ? "opus-4.7" : null;
    let session: Session | null = null;
    let agent: ReturnType<typeof startAgent> | null = null;
    let project: PublicProject | null = null;
    let autoSync: AutoSyncer | null = null;
    let emitRaw: (e: ServerEvent) => void = () => {};
    // Active chat session row for this WS — every persisted message gets
    // tagged with chat_session_id so the sessions sidebar can browse history.
    let chatSession: ChatSessionRow | null = null;
    // Roll-up state for the active chat session, flushed to DB after each
    // persist to keep the sidebar's last_message_at / count / cost fresh.
    let chatMessageCount = 0;
    let chatTotalCost = 0;
    let chatTitleProposed: string | null = null;
    // Snapshot the rate limit at session-open time. Admin changes via the
    // Settings tab take effect on subsequent new sessions.
    const sessionRateLimit = getSettings().rateLimitPerMinute;
    const rateLimiter = createRateLimiter({ perMinute: sessionRateLimit });

    const persist = (e: ServerEvent) => {
      if (!project) return;
      const role = roleFromEvent(e);
      if (!role) return;
      const cost = e.type === "agent:turn_end" ? e.cost : null;
      try {
        appendMessage({
          projectId: project.id,
          chatSessionId: chatSession?.id ?? null,
          role,
          contentJson: JSON.stringify(e),
          costUsd: cost,
        });
        // Roll-up: keep chat_sessions.last_message_at / count / cost fresh so
        // the sidebar's per-session card shows accurate metadata.
        if (chatSession) {
          chatMessageCount += 1;
          if (cost) chatTotalCost += cost;
          // Title backfill — first user message becomes the title (clipped).
          if (!chatTitleProposed && e.type === "chat:user_message") {
            chatTitleProposed = e.text.trim().slice(0, 60);
          }
          updateChatSessionMeta({
            sessionId: chatSession.id,
            messageCount: chatMessageCount,
            totalCostUsd: chatTotalCost,
            proposedTitle: chatTitleProposed,
          });
        }
      } catch (err) {
        log.error("persist message failed", { err: String(err) });
      }
    };
    const emit = (e: ServerEvent) => {
      persist(e);
      emitRaw(e);
    };

    const initSession = async () => {
      if (!user) return;
      if (!Number.isFinite(projectId)) {
        emitRaw({ type: "agent:error", message: "missing projectId" });
        return;
      }
      const row = getProjectFor(user.id, projectId);
      if (!row) {
        emitRaw({ type: "agent:error", message: "project not found" });
        return;
      }
      project = publicProject(row);
      await ensureProjectStarter(project.id);

      // Resolve the active chat session for this project. New projects get
      // one created on the spot. Previous chats live archived in the
      // sidebar.
      chatSession = getOrCreateActiveChatSession(project.id);
      chatMessageCount = chatSession.message_count ?? 0;
      chatTotalCost = chatSession.total_cost_usd ?? 0;
      chatTitleProposed = chatSession.title;

      // Replay last 200 messages from THIS session so the chat resumes
      // where the user left off. (Archived sessions are browsed via the
      // sidebar; the WS only ever drives the active one.)
      const history = listMessagesForSession(project.id, chatSession.id, 200);

      // If this project is connected to GitHub, install the auto-syncer.
      // It pings on every fs change and runs a debounced add/commit/push.
      autoSync = startAutoSync({
        userId: user.id,
        project: row,
        projectDir: projectDir(project.id),
      });

      session = await openSession({
        projectId: project.id,
        rootDir: projectDir(project.id),
        onChange: (files) => emitRaw({ type: "files:changed", files }),
        onFsEvent: () => {
          autoSync?.notifyChange();
        },
      });
      liveSessions.set(project.id, session);
      touchProject(project.id);
      agent = startAgent(session, emit, {
        userId: user.id,
        mode: wsMode,
        executor: wsExecutor,
        advisor: wsAdvisor,
      });

      emitRaw({
        type: "session:ready",
        sessionId: String(project.id),
        previewBase: `/preview/${project.id}/`,
        budgetUsd: agent.budgetUsd(),
        rateLimit: { perMinute: sessionRateLimit },
      });

      // Replay history AFTER session:ready so the client knows where to put it.
      for (const m of history) {
        try {
          const evt = JSON.parse(m.content_json) as ServerEvent;
          if (isObsoleteAdvisorNotice(evt)) continue;
          emitRaw(evt);
        } catch {}
      }

      // Hand the agent a one-shot context preamble built from prior
      // user/assistant turns so the next chat message it sees has the
      // conversation history attached. `listMessages` returns rows in
      // descending id order — flip them back to chronological for
      // readability inside the preamble.
      const preamble = buildHistoryPreamble(history);
      if (preamble) agent.setHistoryPreamble(preamble);
    };

    const teardownSession = async () => {
      if (agent) {
        await agent.dispose();
        agent = null;
      }
      if (session) {
        liveSessions.delete(session.projectId);
        await session.dispose();
        session = null;
      }
      if (autoSync) {
        try {
          await autoSync.flush();
        } catch {
          // already logged inside the syncer
        }
        autoSync.dispose();
        autoSync = null;
      }
    };

    return {
      async onOpen(_evt, ws) {
        emitRaw = (e) => {
          try {
            ws.send(JSON.stringify(e));
          } catch (err) {
            console.error("[ws] send failed:", err);
          }
        };
        await initSession();
      },

      async onMessage(evt, _ws) {
        let cmd: ClientCommand;
        try {
          cmd = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString());
        } catch {
          return;
        }
        switch (cmd.type) {
          case "user:message": {
            if (!agent || !project) return;
            if (agent.isExhausted()) {
              emit({
                type: "warn:budget_exceeded",
                spentUsd: agent.cumulativeCostUsd(),
                limitUsd: agent.budgetUsd(),
              });
              return;
            }
            const wait = rateLimiter.check();
            if (wait > 0) {
              emit({ type: "warn:rate_limited", retryAfterMs: wait });
              return;
            }
            // Persist as a `chat:user_message` ServerEvent so replay can fire
            // it back as-is and render in chat history.
            appendMessage({
              projectId: project.id,
              chatSessionId: chatSession?.id ?? null,
              role: "user",
              contentJson: JSON.stringify({
                type: "chat:user_message",
                text: cmd.text,
              } satisfies ServerEvent),
              costUsd: null,
            });
            // Bump the active chat session's roll-up too — same fields
            // persist() handles for server-side events.
            if (chatSession) {
              chatMessageCount += 1;
              if (!chatTitleProposed) {
                chatTitleProposed = cmd.text.trim().slice(0, 60);
              }
              updateChatSessionMeta({
                sessionId: chatSession.id,
                messageCount: chatMessageCount,
                totalCostUsd: chatTotalCost,
                proposedTitle: chatTitleProposed,
              });
            }
            await agent.send(cmd.text);
            return;
          }
          case "agent:abort": {
            if (agent) await agent.abort();
            return;
          }
          case "session:reset": {
            // Reset = archive the current chat and start a new one. Files
            // belong to the project (shared across all chats) so they
            // stay put. Old conversations remain browsable in the sidebar.
            if (project) {
              const fresh = archiveAndStartNewChatSession(project.id);
              chatSession = fresh;
              chatMessageCount = 0;
              chatTotalCost = 0;
              chatTitleProposed = null;
            }
            await teardownSession();
            await initSession();
            emit({ type: "session:reset_done" });
            return;
          }
          case "session:set_model": {
            // Forward-compat. The Agent SDK bakes `model` into Options at
            // session start (server/agent.ts) and the running query() can't
            // be re-modeled mid-flight. The client persists the preference
            // to localStorage and surfaces a system message asking the user
            // to Reset to apply. A future phase can swap teardown/init
            // here to apply immediately.
            log.info("model preference received", {
              projectId: project?.id,
              model: cmd.model,
            });
            return;
          }
          case "session:set_preset": {
            // Same forward-compat pattern as set_model: the SDK can't swap
            // executor or toggle the advisor tool mid-query(). The client
            // already persisted to localStorage and surfaced the system
            // message; this server-side ack is for logs/observability.
            log.info("preset preference received", {
              projectId: project?.id,
              executor: cmd.executor,
              advisor: cmd.advisor,
            });
            return;
          }
        }
      },

      async onClose() {
        await teardownSession();
      },
    };
  })
);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Walk the persisted message rows (descending order from listMessages)
 * and produce a chronological transcript of the user / assistant turns.
 * Tool-use and tool-result events are skipped — they're noisy and the
 * model can re-derive what it did from the user's prompt + assistant
 * reply summary.
 *
 * Capped at PREAMBLE_MAX_CHARS so a long-running project doesn't blow
 * past the context window on reopen.
 */
const PREAMBLE_MAX_CHARS = 12000;
type HistoryRow = { content_json: string };
function buildHistoryPreamble(rowsDesc: HistoryRow[]): string {
  const chronological = [...rowsDesc].reverse();
  const lines: string[] = [];
  for (const row of chronological) {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(row.content_json) as ServerEvent;
    } catch {
      continue;
    }
    if (evt.type === "chat:user_message") {
      lines.push(`User: ${evt.text}`);
    } else if (evt.type === "agent:text") {
      // Trim very long assistant turns; the gist is what matters.
      const text =
        evt.text.length > 800 ? evt.text.slice(0, 800) + "…" : evt.text;
      lines.push(`Assistant: ${text}`);
    }
    // Skip tool_use / tool_result / turn_end / system / errors.
  }
  if (lines.length === 0) return "";
  let preamble = lines.join("\n\n");
  if (preamble.length > PREAMBLE_MAX_CHARS) {
    // Keep the tail (most recent turns) — that's what the user is most
    // likely referring to in their next message.
    preamble =
      "[earlier conversation truncated]\n\n" +
      preamble.slice(preamble.length - PREAMBLE_MAX_CHARS);
  }
  return preamble;
}

function roleFromEvent(e: ServerEvent): string | null {
  switch (e.type) {
    case "agent:text":
      return "assistant_text";
    case "agent:tool_use":
      return "tool_use";
    case "agent:tool_result":
      return "tool_result";
    case "agent:turn_end":
      return "turn_end";
    case "agent:error":
      return "error";
    case "session:reset_done":
    case "warn:rate_limited":
    case "warn:budget_exceeded":
    case "system:notice":
      return "system";
    default:
      return null;
  }
}

function isObsoleteAdvisorNotice(e: ServerEvent): boolean {
  return (
    e.type === "system:notice" &&
    e.text.includes("Advisor preset is selected but disabled at the server level")
  );
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (await distExists()) {
  // The SPA itself is public — it loads, calls /api/me, and shows the sign-in
  // screen if the user isn't authenticated. Auth gating happens at the
  // /api/* and /ws layers, not the static-file layer.
  mountSpa(app);
  log.info("serving SPA from web/dist/");
} else if (process.env.NODE_ENV === "production") {
  log.warn("NODE_ENV=production but web/dist/ is missing — run `npm run build:web` first");
}

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  log.info("cloudwise-lab server up", {
    port: info.port,
    auth: REQUIRE_AUTH ? "required" : "off",
    githubOauth: APP_CONFIGURED ? "configured" : "off",
    preview: "static",
    advisor: process.env.LAB_ADVISOR_ENABLED === "1" ||
      process.env.LAB_ADVISOR_ENABLED === "true"
      ? "enabled"
      : "off",
    nodeEnv: process.env.NODE_ENV ?? "development",
  });
});

injectWebSocket(server);
