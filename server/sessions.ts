/**
 * Per-project working directory + chokidar file watcher.
 *
 * Each WebSocket connection opens an existing project (created via
 * projects.ts). The project's dir at `sessions/<projectId>/` persists across
 * connections — closing the socket only stops the watcher, it does NOT delete
 * the dir. Persistence is what makes "Recent projects" work.
 *
 * Hydration with the static starter happens once, when the project is first
 * created (see projects.ts). Subsequent opens reuse what's on disk.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { FileNode } from "../shared/events.ts";

const HIDDEN_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".vscode",
  ".DS_Store",
]);
const isHidden = (name: string) =>
  HIDDEN_NAMES.has(name) || (name.startsWith(".") && name !== ".env");

export type Session = {
  projectId: number;
  rootDir: string;
  watcher: FSWatcher;
  /** Stop the watcher. Does NOT delete the project dir. */
  dispose: () => Promise<void>;
};

export type CreateSessionOptions = {
  projectId: number;
  rootDir: string;
  /** Called whenever the on-disk file tree changes. Always passes the full tree. */
  onChange: (files: FileNode[]) => void;
  /** Called for raw file events (path-level). Used by GitHub auto-sync. */
  onFsEvent?: (kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir", path: string) => void;
};

export async function openSession(opts: CreateSessionOptions): Promise<Session> {
  await mkdir(opts.rootDir, { recursive: true });

  const watcher = chokidar.watch(opts.rootDir, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
    ignored: (p: string) =>
      /\/(node_modules|dist|\.git|\.vscode)(\/|$)/.test(p) ||
      p.endsWith("/.DS_Store"),
  });

  let pending: NodeJS.Timeout | null = null;
  const debouncedRescan = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      try {
        const tree = await readDirTree(opts.rootDir, opts.rootDir);
        opts.onChange(tree);
      } catch (err) {
        console.error("[sessions] file tree scan failed:", err);
      }
    }, 60);
  };

  // chokidar fires `add`/`addDir` for every existing file during the initial
  // scan. We always want to refresh the file tree on those (so the UI fills
  // in), but we DON'T want to fire onFsEvent for them — that would
  // unnecessarily kick off AutoSyncer/AutoBuilder pushes/builds for files
  // that were already on disk (and would also cause the publish button's
  // "recent changes" indicator to fire on every page reload).
  let scannerReady = false;
  watcher.on("ready", () => {
    scannerReady = true;
  });

  for (const evt of ["add", "change", "unlink", "addDir", "unlinkDir"] as const) {
    watcher.on(evt, (path) => {
      debouncedRescan();
      if (scannerReady) {
        opts.onFsEvent?.(evt, path);
      }
    });
  }

  return {
    projectId: opts.projectId,
    rootDir: opts.rootDir,
    watcher,
    async dispose() {
      await watcher.close();
    },
  };
}

/** Recursively reads a directory; returns FileNode[] with POSIX-style paths. */
export async function readDirTree(dir: string, root: string): Promise<FileNode[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const out: FileNode[] = [];
  for (const e of entries) {
    if (isHidden(e.name)) continue;
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (e.isDirectory()) {
      out.push({
        name: e.name,
        path: rel,
        type: "dir",
        children: await readDirTree(abs, root),
      });
    } else if (e.isFile()) {
      out.push({ name: e.name, path: rel, type: "file" });
    }
  }
  return out;
}

/** Resolves a project-relative path safely; throws if it escapes the project root. */
export async function resolveSessionPath(session: Session, relPath: string): Promise<string> {
  const abs = resolve(session.rootDir, relPath);
  const root = await stat(session.rootDir);
  if (!root.isDirectory()) throw new Error("session root is not a directory");
  if (!abs.startsWith(session.rootDir + sep) && abs !== session.rootDir) {
    throw new Error(`path escapes session: ${relPath}`);
  }
  return abs;
}
