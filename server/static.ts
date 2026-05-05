/**
 * Production static-file serving for the built Vite SPA.
 *
 * In dev, the Vite dev server runs on its own port and proxies API/WS calls to
 * us. In production, we serve `web/dist/` directly so the whole stack lives on
 * one port behind one TLS cert.
 *
 * Any request that doesn't match a known API/route falls back to `index.html`,
 * since the React app uses hash-based routing (#/, #/lab/...) and never
 * actually fetches "/lab/..." as a pathname — but this guards against direct
 * deep-links and copy-pasted hash URLs.
 */

import { stat, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono, MiddlewareHandler } from "hono";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST = resolve(__dirname, "..", "web", "dist");

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
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

// Vite emits hashed filenames like /assets/index-BNlYYh7A.js — 6+ chars of
// base64-ish hash (alphanumeric, case-sensitive, with - and _) before the
// final extension.
const IMMUTABLE_RE = /\/assets\/.+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/;

/** Returns true if dist/ exists. False means we're not running a built bundle. */
export async function distExists(): Promise<boolean> {
  try {
    const s = await stat(DIST);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Mounts SPA static handlers on the Hono app. Call AFTER all your API routes
 * are registered.
 *
 * Two routes are registered:
 *   1. GET /assets/*  — public, no auth (CSS/JS bundles, fonts). These are
 *      not sensitive — they're the same code every student sees, and gating
 *      them adds latency for no security benefit.
 *   2. GET /*         — auth-gated (when `htmlAuthMiddleware` is provided).
 *      This is the HTML SPA fallback for /, /index.html, /lab/...
 *
 * Pass authMiddleware as the second arg to gate the SPA shell. Pass undefined
 * (or in dev) to leave it open.
 */
export function mountSpa(app: Hono, htmlAuthMiddleware?: MiddlewareHandler): void {
  // Public asset routes — never gated.
  app.get("/assets/*", async (c) => {
    const resp = await tryServe(new URL(c.req.url).pathname);
    return resp ?? c.text("not found", 404);
  });

  // Other top-level static files Vite emits at dist/ root (favicon, robots).
  app.get("/favicon.ico", async (c) => (await tryServe("/favicon.ico")) ?? c.text("not found", 404));
  app.get("/robots.txt", async (c) => (await tryServe("/robots.txt")) ?? c.text("not found", 404));

  // Auth-gated SPA shell. We register the auth middleware on the same path
  // first so it runs before the handler.
  if (htmlAuthMiddleware) {
    app.use("/*", htmlAuthMiddleware);
  }
  app.get("/*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // Direct match for known files in dist/ (other than /assets/* handled above).
    const fileResp = await tryServe(pathname);
    if (fileResp) return fileResp;

    // SPA fallback: index.html for HTML-accepting clients (and bare /).
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html") || pathname === "/") {
      const indexResp = await tryServe("/index.html");
      if (indexResp) return indexResp;
    }

    return c.text("not found", 404);
  });
}

async function tryServe(pathname: string): Promise<Response | null> {
  // Reject path traversal up front. We later resolve and verify the result is
  // still inside DIST as a belt-and-braces check.
  if (pathname.includes("..")) return null;
  const target = pathname === "/" ? "/index.html" : pathname;
  const abs = resolve(DIST, "." + target);
  if (!abs.startsWith(DIST)) return null;

  let buf: Buffer;
  try {
    const s = await stat(abs);
    if (!s.isFile()) return null;
    buf = await readFile(abs);
  } catch {
    return null;
  }

  const ext = extname(abs).toLowerCase();
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
  };
  // Vite emits hashed asset filenames; safe to long-cache. Everything else
  // should always be revalidated.
  if (IMMUTABLE_RE.test(target)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  } else {
    headers["Cache-Control"] = "no-cache";
  }

  return new Response(buf, { headers });
}

export const DIST_DIR = DIST;
