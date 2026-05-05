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
 *
 * This lives next to AutoSyncer and uses the same chokidar event firehose
 * (server/sessions.ts onFsEvent). They're independent: AutoSyncer pushes
 * src/ to GitHub, AutoBuilder regenerates dist/ locally. dist/ is gitignored
 * so the two never step on each other.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./log.ts";

const exec = promisify(execFile);

const DEBOUNCE_MS = 8_000;
const BUILD_TIMEOUT_MS = 120_000;

export type BuildStatus = "idle" | "building" | "ok" | "error";

export type BuildState = {
  status: BuildStatus;
  lastBuildAt: number | null;
  lastError: string | null;
};

export type AutoBuilder = {
  notifyChange: () => void;
  /** Force a build now, bypassing the debounce. Used on session open. */
  triggerNow: () => void;
  status: () => BuildState;
  dispose: () => void;
};

export function startAutoBuilder(input: {
  projectId: number;
  projectDir: string;
  onStateChange?: (state: BuildState) => void;
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

  const setState = (next: Partial<BuildState>) => {
    Object.assign(state, next);
    input.onStateChange?.({ ...state });
  };

  const runBuild = async (): Promise<void> => {
    if (disposed) return;
    setState({ status: "building", lastError: null });
    try {
      await exec("npm", ["run", "build"], {
        cwd: input.projectDir,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (disposed) return;
      setState({ status: "ok", lastBuildAt: Date.now(), lastError: null });
      log.info("auto-build ok", { projectId: input.projectId });
    } catch (err: any) {
      if (disposed) return;
      // exec errors carry stderr/stdout. Keep the trailing chunk (where Astro
      // prints the actual error) and trim front noise.
      const raw =
        (err?.stderr?.toString?.() || "") + (err?.stdout?.toString?.() || "");
      const fallback = err?.message ?? String(err);
      const combined = (raw + "\n" + fallback).trim();
      const trimmed = combined.length > 4000 ? combined.slice(-4000) : combined;
      setState({ status: "error", lastError: trimmed });
      log.error("auto-build failed", {
        projectId: input.projectId,
        msg: trimmed.slice(0, 200),
      });
    }
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
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
