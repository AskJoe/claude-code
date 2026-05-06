import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Sandbox, type CommandHandle } from "e2b";
import { log } from "./log.ts";
import { PREVIEW_EDITOR_RUNTIME } from "./preview-editor-runtime.ts";

const SANDBOX_PROJECT_DIR = "/home/user/project";
const ASTRO_PORT = 4321;
const SANDBOX_TIMEOUT_MS = Number(process.env.E2B_SANDBOX_TIMEOUT_MS ?? 60 * 60 * 1000);
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 2 * 60 * 1000;
const SYNC_DEBOUNCE_MS = 250;
const WRITE_BATCH_SIZE = 25;
const LOG_BUFFER_MAX = 200;

const SKIP_DIRS = new Set(["node_modules", "dist", ".astro", ".git", ".vscode"]);
const SKIP_FILES = new Set([".DS_Store"]);

export type E2BState = {
  status: "idle" | "building" | "ok" | "error";
  lastBuildAt: number | null;
  lastError: string | null;
};

export type E2BPreviewRuntime = {
  status: () => E2BState;
  logBuffer: () => Array<{ stream: "stdout" | "stderr"; chunk: string; ts: number }>;
  proxy: (wildcard: string, sourceUrl: URL) => Promise<Response>;
  notifyFsEvent: (
    kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir",
    absPath: string
  ) => void;
  restart: () => Promise<void>;
  dispose: () => Promise<void>;
};

type RuntimeInput = {
  projectId: number;
  projectDir: string;
  userId: number;
  onStateChange?: (state: E2BState) => void;
  onLog?: (line: { stream: "stdout" | "stderr"; chunk: string; ts: number }) => void;
};

type SandboxInstance = Awaited<ReturnType<typeof Sandbox.create>>;
type WriteEntry = { path: string; data: ArrayBuffer };

export function startE2BPreviewRuntime(input: RuntimeInput): E2BPreviewRuntime {
  const runtime = new E2BRuntime(input);
  void runtime.start();
  return runtime;
}

class E2BRuntime implements E2BPreviewRuntime {
  private sandbox: SandboxInstance | null = null;
  private devServer: CommandHandle | null = null;
  private disposed = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private pendingFullSync = false;
  private pendingPaths = new Map<
    string,
    "add" | "change" | "unlink" | "addDir" | "unlinkDir"
  >();
  private state: E2BState = {
    status: "idle",
    lastBuildAt: null,
    lastError: null,
  };
  private readonly logs: Array<{ stream: "stdout" | "stderr"; chunk: string; ts: number }> = [];

  constructor(private readonly input: RuntimeInput) {}

  status(): E2BState {
    return { ...this.state };
  }

  logBuffer() {
    return this.logs.slice();
  }

  async start(): Promise<void> {
    this.setState({ status: "building", lastError: null });
    this.pushLog("stdout", "Starting E2B sandbox for exact Astro preview...\n");
    log.info("e2b preview runtime starting", {
      projectId: this.input.projectId,
      sdkSandboxCreate: typeof Sandbox.create,
    });

    try {
      this.sandbox = await Sandbox.create({
        timeoutMs: SANDBOX_TIMEOUT_MS,
        metadata: {
          app: "cloudwise-lab",
          projectId: String(this.input.projectId),
          userId: String(this.input.userId),
        },
        network: {
          allowPublicTraffic: false,
        },
      });
      log.info("e2b sandbox created", {
        projectId: this.input.projectId,
        sandboxId: this.sandbox.sandboxId,
      });
      await this.fullSync();
      log.info("e2b project files synced", { projectId: this.input.projectId });
      await this.installDependencies();
      log.info("e2b dependencies installed", { projectId: this.input.projectId });
      await this.startDevServer();
      this.setState({ status: "ok", lastBuildAt: Date.now(), lastError: null });
      log.info("e2b preview runtime ready", {
        projectId: this.input.projectId,
        sandboxId: this.sandbox.sandboxId,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.setState({ status: "error", lastError: msg });
      log.error("e2b preview runtime failed", {
        projectId: this.input.projectId,
        name: err?.name,
        msg: msg.slice(0, 200),
        stack: typeof err?.stack === "string" ? err.stack.slice(0, 800) : undefined,
      });
    }
  }

  notifyFsEvent(
    kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir",
    absPath: string
  ): void {
    if (this.disposed) return;
    const rel = toProjectRel(this.input.projectDir, absPath);
    if (!rel || shouldSkipRel(rel)) return;
    this.pendingPaths.set(rel, kind);
    this.scheduleSync();
  }

  async restart(): Promise<void> {
    if (!this.sandbox) {
      this.pushLog("stderr", "E2B sandbox was not ready; creating a fresh sandbox...\n");
      await this.start();
      return;
    }
    this.setState({ status: "building", lastError: null });
    await this.stopDevServer();
    await this.fullSync();
    await this.installDependencies();
    await this.startDevServer();
    this.setState({ status: "ok", lastBuildAt: Date.now(), lastError: null });
  }

  async proxy(wildcard: string, sourceUrl: URL): Promise<Response> {
    if (!this.sandbox) {
      return htmlResponse(buildingPage("Cloudwise Lab is starting the E2B preview..."), 202);
    }
    if (this.state.status === "building") {
      return htmlResponse(buildingPage("Cloudwise Lab is syncing your project to E2B..."), 202);
    }
    if (this.state.status === "error") {
      return htmlResponse(buildErrorPage(this.state.lastError ?? "Unknown E2B preview error"), 502);
    }

    const target = new URL(`https://${this.sandbox.getHost(ASTRO_PORT)}`);
    target.pathname = toSandboxPreviewPath(wildcard);
    sourceUrl.searchParams.forEach((value, key) => {
      if (key !== "raw") target.searchParams.append(key, value);
    });

    const headers: Record<string, string> = {};
    if (this.sandbox.trafficAccessToken) {
      headers["e2b-traffic-access-token"] = this.sandbox.trafficAccessToken;
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, { headers });
    } catch (err: any) {
      return htmlResponse(
        buildErrorPage(`Could not reach E2B preview server: ${err?.message ?? String(err)}`),
        502
      );
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const html = await upstream.text();
      return new Response(
        injectEditorRuntime(rewriteRootPaths(html, this.input.projectId)),
        {
          status: upstream.status,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Frame-Options": "SAMEORIGIN",
          },
        }
      );
    }

    const passthroughHeaders = new Headers(upstream.headers);
    passthroughHeaders.set("Cache-Control", "no-store");
    passthroughHeaders.set("X-Frame-Options", "SAMEORIGIN");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughHeaders,
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    await this.stopDevServer();
    if (this.sandbox) {
      try {
        await this.sandbox.kill();
      } catch (err: any) {
        log.warn("e2b sandbox kill failed", {
          projectId: this.input.projectId,
          err: err?.message ?? String(err),
        });
      }
      this.sandbox = null;
    }
  }

  private setState(next: Partial<E2BState>) {
    Object.assign(this.state, next);
    this.input.onStateChange?.({ ...this.state });
  }

  private pushLog(stream: "stdout" | "stderr", chunk: string) {
    const line = { stream, chunk, ts: Date.now() };
    this.logs.push(line);
    if (this.logs.length > LOG_BUFFER_MAX) {
      this.logs.splice(0, this.logs.length - LOG_BUFFER_MAX);
    }
    this.input.onLog?.(line);
  }

  private scheduleSync() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncPending().catch((err) => {
        const msg = err?.message ?? String(err);
        this.setState({ status: "error", lastError: msg });
        log.error("e2b incremental sync failed", {
          projectId: this.input.projectId,
          msg: msg.slice(0, 200),
        });
      });
    }, SYNC_DEBOUNCE_MS);
  }

  private async syncPending() {
    if (!this.sandbox || this.disposed) return;
    this.setState({ status: "building", lastError: null });
    if (this.pendingFullSync) {
      this.pendingFullSync = false;
      this.pendingPaths.clear();
      await this.fullSync();
    } else {
      const pending = [...this.pendingPaths.entries()];
      this.pendingPaths.clear();
      for (const [rel, kind] of pending) {
        await this.syncOne(rel, kind);
      }
    }
    this.setState({ status: "ok", lastBuildAt: Date.now(), lastError: null });
  }

  private async fullSync() {
    if (!this.sandbox) throw new Error("E2B sandbox is not ready");
    this.pushLog("stdout", "Syncing project files to E2B...\n");
    await this.sandbox.commands.run(
      `mkdir -p ${shellQuote(SANDBOX_PROJECT_DIR)} && find ${shellQuote(
        SANDBOX_PROJECT_DIR
      )} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
      { timeoutMs: 30_000 }
    );

    const files = await collectProjectFiles(this.input.projectDir);
    for (let i = 0; i < files.length; i += WRITE_BATCH_SIZE) {
      await this.sandbox.files.writeFiles(files.slice(i, i + WRITE_BATCH_SIZE));
    }
  }

  private async syncOne(
    rel: string,
    kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir"
  ) {
    if (!this.sandbox) throw new Error("E2B sandbox is not ready");
    const sandboxPath = toSandboxPath(rel);
    if (kind === "unlink" || kind === "unlinkDir") {
      await this.sandbox.files.remove(sandboxPath).catch(() => {});
      return;
    }
    if (kind === "addDir") {
      await this.sandbox.files.makeDir(sandboxPath);
      return;
    }

    const abs = join(this.input.projectDir, rel);
    const s = await stat(abs).catch(() => null);
    if (!s) {
      await this.sandbox.files.remove(sandboxPath).catch(() => {});
      return;
    }
    if (s.isDirectory()) {
      await this.sandbox.files.makeDir(sandboxPath);
      return;
    }
    if (!s.isFile()) return;
    const data = await readArrayBuffer(abs);
    await this.sandbox.files.write(sandboxPath, data);
  }

  private async installDependencies() {
    if (!this.sandbox) throw new Error("E2B sandbox is not ready");
    this.pushLog("stdout", "$ npm install (cwd: E2B /home/user/project)\n");
    const result = await this.sandbox.commands.run("npm install", {
      cwd: SANDBOX_PROJECT_DIR,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onStdout: (chunk) => this.pushLog("stdout", chunk),
      onStderr: (chunk) => this.pushLog("stderr", chunk),
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "npm install failed in E2B");
    }
  }

  private async startDevServer() {
    if (!this.sandbox) throw new Error("E2B sandbox is not ready");
    this.pushLog(
      "stdout",
      "$ npm run dev -- --host 0.0.0.0 --port 4321 --allowed-hosts .e2b.app (E2B)\n"
    );
    this.devServer = await this.sandbox.commands.run(
      `npm run dev -- --host 0.0.0.0 --port ${ASTRO_PORT} --allowed-hosts .e2b.app`,
      {
        cwd: SANDBOX_PROJECT_DIR,
        background: true,
        timeoutMs: START_TIMEOUT_MS,
        onStdout: (chunk) => this.pushLog("stdout", chunk),
        onStderr: (chunk) => this.pushLog("stderr", chunk),
      }
    );
    await waitForPreview(this.sandbox);
  }

  private async stopDevServer() {
    if (this.devServer) {
      try {
        await this.devServer.kill();
      } catch {}
      this.devServer = null;
    }
  }
}

async function waitForPreview(sandbox: SandboxInstance) {
  const host = sandbox.getHost(ASTRO_PORT);
  const headers: Record<string, string> = {};
  if (sandbox.trafficAccessToken) {
    headers["e2b-traffic-access-token"] = sandbox.trafficAccessToken;
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://${host}/`, { headers });
      if (res.status < 500) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`E2B Astro dev server did not become ready: ${lastErr}`);
}

async function collectProjectFiles(root: string): Promise<WriteEntry[]> {
  const out: WriteEntry[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_FILES.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (shouldSkipRel(rel)) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push({ path: toSandboxPath(rel), data: await readArrayBuffer(abs) });
      }
    }
  }
  await walk(root);
  return out;
}

async function readArrayBuffer(path: string): Promise<ArrayBuffer> {
  const buf = await readFile(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function toProjectRel(root: string, absPath: string): string | null {
  const rel = relative(root, absPath).split(sep).join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || rel.startsWith("/")) return null;
  return rel;
}

function shouldSkipRel(rel: string): boolean {
  const parts = rel.split("/");
  return parts.some((part) => SKIP_DIRS.has(part)) || parts.some((part) => SKIP_FILES.has(part));
}

function toSandboxPath(rel: string): string {
  return `${SANDBOX_PROJECT_DIR}/${rel.replace(/^\/+/, "")}`;
}

function toSandboxPreviewPath(wildcard: string): string {
  const clean = wildcard.replace(/^\/+/, "");
  if (!clean || clean === "index.html") return "/";
  return `/${clean}`;
}

function rewriteRootPaths(html: string, projectId: number): string {
  const prefix = `/preview/${projectId}`;
  return html.replace(
    /(\b(?:href|src|srcset|action)\s*=\s*["'])\/(?!\/|preview\/)/g,
    `$1${prefix}/`
  );
}

function injectEditorRuntime(html: string): string {
  const tag = `<script>${PREVIEW_EDITOR_RUNTIME}</script>`;
  if (html.includes("</body>")) return html.replace("</body>", `${tag}</body>`);
  return html + tag;
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

function buildingPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Starting preview</title>
    <meta http-equiv="refresh" content="3">
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #e6edf3; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
      .card { text-align: center; max-width: 420px; }
      .spinner { width: 28px; height: 28px; border: 3px solid #2a3340; border-top-color: #f5a524; border-radius: 50%; margin: 0 auto 16px; animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      p { color: #8b949e; font-size: 14px; line-height: 1.5; }
      strong { color: #f5a524; }
    </style></head>
    <body><div class="card"><div class="spinner"></div><p><strong>E2B preview</strong><br>${escapeHtml(message)}</p></div></body></html>`;
}

function buildErrorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>E2B preview error</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; margin: 0; }
      h1 { color: #f85149; font-size: 16px; margin: 0 0 12px 0; font-family: ui-monospace, SF Mono, Menlo, monospace; }
      pre { background: #161b22; border: 1px solid #2a3340; padding: 16px; border-radius: 6px; font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 12px; line-height: 1.5; overflow: auto; white-space: pre-wrap; word-break: break-word; color: #e6edf3; max-height: calc(100vh - 100px); }
    </style></head>
    <body><h1>E2B preview failed</h1><pre>${escapeHtml(message)}</pre></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
