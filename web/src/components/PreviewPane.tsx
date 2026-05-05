import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileNode } from "../../../shared/events.ts";

type Props = {
  previewBase: string | null;
  /** Changes to force the iframe to reload (e.g. on each build transition). */
  reloadKey?: number | string;
  /** Live file tree from useLabSession — used to derive Astro routes for
   *  the page picker dropdown. */
  files?: FileNode[];
};

type PageOption = {
  /** Path appended after previewBase. "" = index, "/about" = about page. */
  routePath: string;
  /** Human label for the dropdown row. */
  label: string;
  /** Source file path under the project. Just for tooltips / debugging. */
  source: string;
};

/** Walk the file tree and pick out src/pages/**\/*.{astro,md,mdx} as routes.
 *  Dynamic routes (filenames starting with `[`) are skipped — they need
 *  params at render time and don't preview clean. */
function derivePages(files: FileNode[]): PageOption[] {
  const out: PageOption[] = [];
  const PAGE_EXTS = new Set([".astro", ".md", ".mdx", ".html"]);

  function walk(nodes: FileNode[]) {
    for (const n of nodes) {
      if (n.type === "dir") {
        if (n.children) walk(n.children);
        continue;
      }
      const path = n.path;
      if (!path.startsWith("src/pages/")) continue;
      const rel = path.slice("src/pages/".length);
      if (rel.includes("[")) continue; // dynamic routes — skip
      const dotIdx = rel.lastIndexOf(".");
      if (dotIdx < 0) continue;
      const ext = rel.slice(dotIdx).toLowerCase();
      if (!PAGE_EXTS.has(ext)) continue;
      const stem = rel.slice(0, dotIdx); // "about", "blog/post", "index"
      // Index files map to their parent path. blog/index → blog, top-level
      // index → "" (the home page).
      let routePath: string;
      let label: string;
      if (stem === "index") {
        routePath = "";
        label = "Home";
      } else if (stem.endsWith("/index")) {
        routePath = "/" + stem.slice(0, -"/index".length);
        label = routePath;
      } else {
        routePath = "/" + stem;
        label = routePath;
      }
      out.push({ routePath, label, source: path });
    }
  }
  walk(files);

  // Sort: home first, then alphabetical by route.
  out.sort((a, b) => {
    if (a.routePath === "" && b.routePath !== "") return -1;
    if (b.routePath === "" && a.routePath !== "") return 1;
    return a.routePath < b.routePath ? -1 : a.routePath > b.routePath ? 1 : 0;
  });

  // Dedupe by routePath — Astro lets you have both .astro and .md for the
  // same route, but only one builds. First one wins.
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.routePath)) return false;
    seen.add(p.routePath);
    return true;
  });
}

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

type ConsoleLine = {
  id: number;
  level: ConsoleLevel;
  args: string[];
  ts: number;
};

const CONSOLE_MAX = 400;

/**
 * The right-pane preview — always loads `index.html`, which the server
 * resolves to `dist/index.html` after the agent runs `npm run build`. If
 * there's no build yet, the server returns a friendly "not built yet" 404
 * page.
 *
 * Adds a small toolbar (reload / open in new tab / console) and a
 * collapsible console drawer that captures messages forwarded from the
 * iframe via the `lab:console` postMessage protocol injected by
 * `preview-editor-runtime.ts`.
 */
export function PreviewPane({
  previewBase,
  reloadKey = "0",
  files,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [bump, setBump] = useState(0);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [logs, setLogs] = useState<ConsoleLine[]>([]);
  const idRef = useRef(0);

  // Derive available routes from the file tree. Memoize so we don't
  // recompute on every render — only when the file list changes.
  const pages = useMemo(() => derivePages(files ?? []), [files]);

  // Currently-active route. Defaults to "" (Home / index). Sticks to user's
  // pick across builds; if the picked page disappears (file deleted), fall
  // back to home.
  const [currentRoute, setCurrentRoute] = useState<string>("");
  useEffect(() => {
    if (pages.length === 0) return;
    const stillExists = pages.some((p) => p.routePath === currentRoute);
    if (!stillExists) setCurrentRoute("");
  }, [pages, currentRoute]);

  // Listen for `lab:console` messages from the preview iframe. Other
  // message types (lab:edit-mode-toggle, lab:edit-text) are handled by the
  // Lab component and must not be touched here.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "lab:console") return;
      const level = (data.level as ConsoleLevel) ?? "log";
      const argsIn = Array.isArray(data.args) ? data.args : [];
      const args = argsIn.map((v: unknown) => String(v));
      setLogs((prev) => {
        const next = prev.concat({
          id: ++idRef.current,
          level,
          args,
          ts: typeof data.ts === "number" ? data.ts : Date.now(),
        });
        if (next.length > CONSOLE_MAX) {
          next.splice(0, next.length - CONSOLE_MAX);
        }
        return next;
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Clear the log when the iframe reloads so the drawer shows fresh output
  // for the new page rather than piling indefinitely across builds.
  useEffect(() => {
    setLogs([]);
  }, [reloadKey, bump, previewBase]);

  const reload = useCallback(() => {
    // Bumping our own counter forces the iframe `key` to change, which is
    // the React-friendly way to remount it (and thus reload its document).
    setBump((b) => b + 1);
  }, []);

  if (!previewBase) {
    return <div className="preview-empty">connecting…</div>;
  }
  // index when home, otherwise navigate to /<route> — server resolves
  // /preview/<id>/<route> to dist/<route>/index.html (Astro's default
  // folder-mode build) or dist/<route>.html (file-mode).
  const src =
    currentRoute === ""
      ? `${previewBase}index.html`
      : `${previewBase}${currentRoute.replace(/^\//, "")}`;
  const externalUrl =
    currentRoute === "" ? previewBase : `${previewBase}${currentRoute.replace(/^\//, "")}`;

  return (
    <div className="preview">
      <div className="preview-toolbar">
        <button
          type="button"
          className="preview-toolbar-btn"
          title="Reload preview"
          aria-label="Reload preview"
          onClick={reload}
        >
          ↻
        </button>
        <button
          type="button"
          className="preview-toolbar-btn"
          title="Open preview in a new tab"
          aria-label="Open preview in a new tab"
          onClick={() => window.open(externalUrl, "_blank", "noopener")}
        >
          🌐
        </button>
        {pages.length > 1 && (
          <PagePicker
            pages={pages}
            current={currentRoute}
            onPick={setCurrentRoute}
          />
        )}
        <div className="preview-toolbar-spacer" />
        <button
          type="button"
          className={`preview-toolbar-btn ${consoleOpen ? "active" : ""}`}
          title={consoleOpen ? "Hide console drawer" : "Show console drawer"}
          aria-label="Toggle console drawer"
          onClick={() => setConsoleOpen((v) => !v)}
        >
          🐞
          {logs.some((l) => l.level === "error") && (
            <span className="preview-toolbar-badge">!</span>
          )}
        </button>
      </div>
      <iframe
        ref={iframeRef}
        key={`${src}-${reloadKey}-${bump}`}
        className="preview-frame"
        src={src}
        sandbox="allow-scripts allow-forms allow-same-origin"
        title="lab preview"
      />
      {consoleOpen && (
        <ConsoleDrawer
          logs={logs}
          onClear={() => setLogs([])}
          onClose={() => setConsoleOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Dropdown listing every Astro page found in src/pages/. Hidden when the
 * project has zero or one pages (no point picking when there's nothing to
 * pick from).
 */
function PagePicker({
  pages,
  current,
  onPick,
}: {
  pages: PageOption[];
  current: string;
  onPick: (route: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const currentLabel =
    pages.find((p) => p.routePath === current)?.label ?? "Home";

  return (
    <div className="page-picker" ref={wrapRef}>
      <button
        type="button"
        className="page-picker-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch to another page in this site"
      >
        <span className="page-picker-label">{currentLabel}</span>
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="page-picker-popover" role="listbox">
          {pages.map((p) => (
            <button
              key={p.routePath}
              type="button"
              className={`page-picker-item${p.routePath === current ? " active" : ""}`}
              onClick={() => {
                onPick(p.routePath);
                setOpen(false);
              }}
              title={p.source}
            >
              <span className="page-picker-item-label">{p.label}</span>
              <span className="page-picker-item-source">{p.source}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConsoleDrawer({
  logs,
  onClear,
  onClose,
}: {
  logs: ConsoleLine[];
  onClear: () => void;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll to bottom when new lines arrive, matching DevTools console.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="preview-console">
      <div className="preview-console-header">
        <span className="preview-console-title">Console</span>
        <span className="preview-console-count">{logs.length}</span>
        <div className="preview-console-spacer" />
        <button
          type="button"
          className="preview-console-btn"
          onClick={onClear}
          title="Clear console"
        >
          Clear
        </button>
        <button
          type="button"
          className="preview-console-btn"
          onClick={onClose}
          title="Hide console"
        >
          ✕
        </button>
      </div>
      <div className="preview-console-body" ref={bodyRef}>
        {logs.length === 0 ? (
          <div className="preview-console-empty">
            No console output yet. Page logs will stream here.
          </div>
        ) : (
          logs.map((l) => (
            <div key={l.id} className={`console-line ${l.level}`}>
              <span className="console-line-level">{l.level}</span>
              <span className="console-line-args">{l.args.join(" ")}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
