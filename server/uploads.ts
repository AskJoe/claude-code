/**
 * File upload endpoint for project sessions.
 *
 * POST /api/projects/:id/upload  (multipart/form-data, field "file")
 *
 * Accepts a small allowlist of MIME types, caps individual files at 10 MB and
 * the per-session uploads dir at 25 MB total. Files are sanitized, prefixed
 * with a random 8-char id, and written under the project's
 * `public/uploads/<safe>` so they're served by the existing /preview route.
 *
 * Response: { path, url, size, mime, originalName } where:
 *   - path: project-relative path (e.g. "public/uploads/abc12345-image.png")
 *   - url:  public preview URL (e.g. "/preview/123/uploads/abc12345-image.png")
 *
 * Implementation: uses the Web standard Request#formData() that Hono surfaces
 * via c.req.parseBody(). No formidable / synthetic IncomingMessage juggling —
 * keeps the bytes inside the V8 heap once instead of streaming through a
 * fragile fs-temp roundtrip that breaks under tsx.
 */

import type { Hono } from "hono";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { customAlphabet } from "nanoid";

import { authMiddleware } from "./auth.ts";
import { getProjectFor, projectDir as resolveProjectDir } from "./projects.ts";
import { log } from "./log.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;      // 10 MB per file
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;     // 25 MB total per session
const MIME_ALLOWLIST = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/csv",
  "text/markdown",
  "text/plain",
  "application/json",
]);

// 8-char id, lowercase alphanumeric. Avoids `-` so the boundary between id
// and original name is unambiguous.
const shortId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);

function sanitizeFilename(input: string): string {
  // Strip path traversal and slashes; collapse whitespace to single dashes.
  const stripped = input
    .replace(/\.\.+/g, "")
    .replace(/[/\\]/g, "")
    .replace(/\s+/g, "-")
    // Pull out anything that isn't a safe basename character
    .replace(/[^A-Za-z0-9._-]/g, "");
  // Cap length so we don't blow past filesystem limits when combined with the prefix.
  const trimmed = stripped.slice(0, 120);
  // If nothing usable remained (e.g. user passed "../"), fall back.
  return trimmed || "upload";
}

async function dirSize(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const e of entries) {
      if (e.isFile()) {
        try {
          const s = await stat(join(dir, e.name));
          total += s.size;
        } catch {}
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export function mountUploads(app: Hono): void {
  app.post("/api/projects/:id/upload", authMiddleware, async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const project = getProjectFor(user.id, id);
    if (!project) return c.json({ error: "not found" }, 404);

    const projectRoot = resolveProjectDir(id);
    const uploadsDir = join(projectRoot, "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    // Pre-check session-wide cap — saves a needless allocation if we're full.
    const existingBytes = await dirSize(uploadsDir);
    if (existingBytes >= MAX_TOTAL_BYTES) {
      return c.json(
        {
          error: `Per-session upload total (${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MB) reached. Delete an upload to free space.`,
        },
        413
      );
    }

    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      return c.json({ error: "expected multipart/form-data" }, 400);
    }

    // Web FormData via Hono. Returns File-like Blob objects from the SPA's
    // FormData send.
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch (err: any) {
      log.warn("upload formData parse failed", {
        projectId: id,
        err: err?.message ?? String(err),
      });
      return c.json({ error: "could not parse upload body" }, 400);
    }

    const entry = form.get("file");
    if (!entry || typeof entry === "string") {
      return c.json({ error: "no file provided (expected field 'file')" }, 400);
    }
    const fileBlob = entry as File;

    const mime = fileBlob.type || "application/octet-stream";
    if (!MIME_ALLOWLIST.has(mime)) {
      return c.json({ error: `MIME type not allowed: ${mime}` }, 415);
    }

    const size = fileBlob.size;
    if (size > MAX_FILE_BYTES) {
      return c.json({ error: `File too large (max 10 MB)` }, 413);
    }
    if (existingBytes + size > MAX_TOTAL_BYTES) {
      return c.json(
        {
          error: `Per-session upload total (${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MB) would be exceeded.`,
        },
        413
      );
    }

    const originalName = (fileBlob as any).name || "upload";
    const safeBase = sanitizeFilename(String(originalName));
    const safeName = `${shortId()}-${safeBase}`;
    const finalAbs = join(uploadsDir, safeName);

    try {
      const buf = Buffer.from(await fileBlob.arrayBuffer());
      await writeFile(finalAbs, buf);
    } catch (err: any) {
      log.error("upload write failed", {
        projectId: id,
        err: err?.message ?? String(err),
      });
      return c.json({ error: "could not write upload" }, 500);
    }

    log.info("upload written", {
      projectId: id,
      safeName,
      size,
      mime,
    });

    return c.json({
      path: `public/uploads/${safeName}`,
      url: `/preview/${id}/uploads/${safeName}`,
      size,
      mime,
      originalName,
    });
  });
}
