/**
 * Auto-build a project's source whenever it changes.
 *
 * Runs `npm run build` debounced ~8s after the latest filesystem event from
 * chokidar. Coalesces concurrent triggers (an in-flight build absorbs further
 * changes; one queued build is enough). Emits state transitions so the lab
 * UI can:
 *   - show a "Building…" overlay over the preview pane
 *   - reload the iframe on `ok`
 *   - show the build error inline on `error`
 *   - stream build stdout/stderr lines into the BuildLogDrawer
 *
 * This lives next to AutoSyncer and uses the same chokidar event firehose
 * (server/sessions.ts onFsEvent). They're independent: AutoSyncer pushes
 * src/ to GitHub, AutoBuilder regenerates dist/ locally. dist/ is gitignored
 * so the two never step on each other.
 */

import { spawn } from "node:child_process";
import { log } from "./log.ts";

const DEBOUNCE_MS = 8_000;
const BUILD_TIMEOUT_MS = 120_000;
const LOG_BUFFER_MAX = 200;

export type BuildStatus = "idle" | "building" | "ok" | "error";

export type BuildState = {
  status: BuildStatus;
  lastBuildAt: number | null;
  lastError: string | null;
};

export type BuildLogLine = {
  stream: "stdout" | "stderr";
  chunk: string;
  ts: number;
};

export type AutoBuilder = {
  notifyChange: () => void;
  /** Force a build now, bypassing the debounce. Used on session open. */
  triggerNow: () => void;
  status: () => BuildState;
  /** Last N lines of stdout/stderr from recent builds. */
  logBuffer: () => BuildLogLine[];
  dispose: () => void;
};

export function startAutoBuilder(input: {
  projectId: number;
  projectDir: string;
  onStateChange?: (state: BuildState) => void;
  onLog?: (line: BuildLogLine) => void;
}): AutoBuilder {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let disposed = false;

  const state: BuildState = {
    status: "idle",
    lastBuildAt: null,
    lastError: null,
  };

  // Capped ring buffer of recent log lines so reconnecting clients can
  // backfill the drawer without re-running the build.
  const logs: BuildLogLine[] = [];
  const pushLog = (line: BuildLogLine) => {
    logs.push(line);
    if (logs.length > LOG_BUFFER_MAX) {
      logs.splice(0, logs.length - LOG_BUFFER_MAX);
    }
    input.onLog?.(line);
  };

  const setState = (next: Partial<BuildState>) => {
    Object.assign(state, next);
    input.onStateChange?.({ ...state });
  };

  const runBuild = (): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (disposed) return resolve();
      setState({ status: "building", lastError: null });
      pushLog({
        stream: "stdout",
        chunk: `$ npm run build (cwd: ${input.projectDir})\n`,
        ts: Date.now(),
      });

      const child = spawn("npm", ["run", "build"], {
        cwd: input.projectDir,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      let timedOut = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, BUILD_TIMEOUT_MS);

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString("utf-8");
        stdoutBuf += text;
        if (stdoutBuf.length > 8 * 1024 * 1024) {
          stdoutBuf = stdoutBuf.slice(-8 * 1024 * 1024);
        }
        pushLog({ stream: "stdout", chunk: text, ts: Date.now() });
      });

      child.stderr.on("data", (data: Buffer) => {
        const text = data.toString("utf-8");
        stderrBuf += text;
        if (stderrBuf.length > 8 * 1024 * 1024) {
          stderrBuf = stderrBuf.slice(-8 * 1024 * 1024);
        }
        pushLog({ stream: "stderr", chunk: text, ts: Date.now() });
      });

      child.on("error", (err) => {
        clearTimeout(killTimer);
        if (disposed) return resolve();
        const msg = err?.message ?? String(err);
        pushLog({ stream: "stderr", chunk: msg + "\n", ts: Date.now() });
        setState({ status: "error", lastError: msg });
        log.error("auto-build spawn failed", {
          projectId: input.projectId,
          msg: msg.slice(0, 200),
        });
        resolve();
      });

      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (disposed) return resolve();
        if (code === 0) {
          setState({ status: "ok", lastBuildAt: Date.now(), lastError: null });
          log.info("auto-build ok", { projectId: input.projectId });
        } else {
          const combined = (stderrBuf + "\n" + stdoutBuf).trim();
          const trimmed =
            combined.length > 4000 ? combined.slice(-4000) : combined;
          const reason = timedOut
            ? `Build timed out after ${BUILD_TIMEOUT_MS / 1000}s\n${trimmed}`
            : trimmed || `npm run build exited with code ${code}`;
          setState({ status: "error", lastError: reason });
          log.error("auto-build failed", {
            projectId: input.projectId,
            code,
            msg: reason.slice(0, 200),
          });
        }
        resolve();
      });
    });
  };

  const schedule = (delayMs: number) => {
    if (disposed) return;
    if (inFlight) {
      // A build is already running; record that more work has come in. We'll
      // schedule a single follow-up build when this one finishes.
      pending = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      inFlight = runBuild().finally(() => {
        inFlight = null;
        if (pending && !disposed) {
          pending = false;
          schedule(DEBOUNCE_MS);
        }
      });
    }, delayMs);
  };

  return {
    notifyChange: () => schedule(DEBOUNCE_MS),
    triggerNow: () => schedule(0),
    status: () => ({ ...state }),
    logBuffer: () => logs.slice(),
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
