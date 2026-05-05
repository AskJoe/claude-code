import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  previewBase: string | null;
  /** Changes to force the iframe to reload (e.g. on each build transition). */
  reloadKey?: number | string;
};

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
export function PreviewPane({ previewBase, reloadKey = "0" }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [bump, setBump] = useState(0);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [logs, setLogs] = useState<ConsoleLine[]>([]);
  const idRef = useRef(0);

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
  const src = `${previewBase}index.html`;

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
          onClick={() => window.open(previewBase, "_blank", "noopener")}
        >
          🌐
        </button>
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
