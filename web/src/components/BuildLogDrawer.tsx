import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type {
  LabBuildLog,
  LabBuildState,
} from "../lib/useLabSession.ts";

type Props = {
  build: LabBuildState;
  buildLog: LabBuildLog;
  /** Project id — when present, the toolbar shows a 🔄 Restart button that
   *  hits POST /api/projects/:id/builder/restart and respawns the watcher. */
  projectId?: number;
};

/**
 * Collapsible drawer at the bottom of the right pane that shows recent
 * build stdout/stderr. The collapsed bar is a status pill (spinner /
 * relative time / error). Clicking expands the drawer to a fixed 200px of
 * scrolling log output.
 */
export function BuildLogDrawer({ build, buildLog, projectId }: Props) {
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Re-render the "Built 3s ago" pill on a 1s tick so it stays accurate
  // without nudging the lab tree on every animation frame.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Auto-expand when a build fails so the user sees the error without
  // hunting for the toolbar pill.
  useEffect(() => {
    if (build.status === "error") setOpen(true);
  }, [build.status, build.lastBuildAt]);

  // Keep the log scrolled to the bottom as new chunks arrive (DevTools-style).
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [buildLog, open]);

  const pill = renderPill(build, now);

  const restart = async () => {
    if (projectId == null || restarting) return;
    setRestarting(true);
    setRestartError(null);
    try {
      await api.restartBuilder(projectId);
    } catch (err: any) {
      setRestartError(err?.message ?? "restart failed");
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className={`build-log ${open ? "open" : ""}`}>
      <div className="build-log-toolbar-row">
        <button
          type="button"
          className="build-log-toolbar"
          onClick={() => setOpen((v) => !v)}
          title={open ? "Hide build log" : "Show build log"}
        >
          <span className={`build-log-pill ${build.status}`}>
            {pill.icon} {pill.label}
          </span>
          <span className="build-log-spacer" />
          <span className="build-log-toggle">{open ? "▾" : "▴"}</span>
        </button>
        {projectId != null && (
          <button
            type="button"
            className="build-log-restart"
            onClick={restart}
            disabled={restarting}
            title="Restart the auto-builder watcher and trigger a fresh build"
            aria-label="Restart watcher"
          >
            {restarting ? "…" : "🔄 Restart"}
          </button>
        )}
      </div>
      {restartError && (
        <div className="build-log-restart-error">{restartError}</div>
      )}
      {open && (
        <div className="build-log-body" ref={bodyRef}>
          {buildLog.lines.length === 0 ? (
            <div className="build-log-empty">
              No build output yet. The drawer will fill in next time the
              auto-builder runs.
            </div>
          ) : (
            buildLog.lines.map((line, i) => (
              // index is fine — lines are append-only and never reordered.
              <div key={i} className={`build-log-line ${line.stream}`}>
                {line.chunk.replace(/\n$/, "")}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function renderPill(
  build: LabBuildState,
  now: number
): { icon: string; label: string } {
  switch (build.status) {
    case "building":
      return { icon: "⏳", label: "Building…" };
    case "error":
      return { icon: "✗", label: "Build failed" };
    case "ok": {
      if (build.lastBuildAt === null) return { icon: "✓", label: "Built" };
      const ago = relativeTime(now - build.lastBuildAt);
      return { icon: "✓", label: `Built ${ago}` };
    }
    case "idle":
    default:
      return { icon: "·", label: "Idle" };
  }
}

function relativeTime(diffMs: number): string {
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
