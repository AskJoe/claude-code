# Cloudwise Lab

Embedded Claude-Code-style chat experience for Cloudwise Academy course students. Joe pays the tokens; students never install anything or sign up.

## Where this fits

Standalone Node + React app at `lab.cloudwise.academy` that students reach via SSO from a Cloudwise Academy course page. Each lesson boots a fresh per-student scratch directory on Joe's server. The Claude Agent SDK runs server-side with file tools scoped to that directory. Browser shows chat + live file tree + preview iframe.

## What this is

A single-page chat experience that *feels* like Claude Code, running on Joe's server with Joe's tokens. Students get a chat panel, a live file tree, and a preview iframe. The agent can Read/Write/Edit files and run Bash, all inside a per-student sandbox dir. Closing the tab disposes the agent and removes the sandbox.

No accounts to set up, no install, no hard thinking — Joe wraps a course around it, students follow along.

## Phase 1 — running the lab

In one terminal, boot both servers:

```bash
cd cloudwise-lab
npm run dev
```

This launches:
- the Hono backend on `http://localhost:3101` (HTTP + WebSocket + preview static handler)
- the Vite dev server on `http://localhost:3000` (proxies `/ws`, `/preview`, `/health` → backend)

Open `http://localhost:3000` in a browser. You'll see three panes: chat (left), file tree (middle), preview (right). Type a prompt — `Build a coffee shop landing page` — and watch the agent stream tool calls into chat, files appear in the tree in real time, and `index.html` auto-render in the preview iframe.

Smoke test (server must already be running):

```bash
npm run smoke
```

Why two servers in dev? Vite gives us hot-module reload and a clean dev loop for the frontend; Hono runs the agent loop with native WebSocket support. In production we collapse to a single Hono server that serves the built React bundle from `web/dist/`.

## Running in production

### Local production check

```bash
npm run build:web              # compiles React SPA into web/dist/
NODE_ENV=production npm start  # Hono serves API + WS + SPA on one port (3101)
```

Visit `http://localhost:3101/` — single-port single-process deployment.

### Production auth

Auth is **off** by default in development. Production refuses to start unless
this is set:

```bash
LAB_SESSION_SECRET=$(openssl rand -hex 32)
```

Flow:
1. Students sign up, sign in, or use a magic link.
2. Lab sets a signed `lab_session` cookie with a server-enforced `exp`.
3. All protected HTTP routes, WebSocket sessions, and preview file requests gate on that cookie.

Run the auth smoke to verify:

```bash
LAB_SESSION_SECRET=test-secret-do-not-use-in-prod NODE_ENV=production npm start
# in another terminal:
LAB_SESSION_SECRET=test-secret-do-not-use-in-prod npm run auth-smoke
```

### Deploy to Render

A `render.yaml` blueprint is included. Push to GitHub, hit "New → Blueprint" in Render, then in the dashboard set:

- `ANTHROPIC_API_KEY` — your real Anthropic key

The blueprint generates `LAB_SESSION_SECRET` automatically if the Render service
doesn't already have one. If you manage the service manually instead of through
the blueprint, set `LAB_SESSION_SECRET` yourself.

The blueprint mounts a persistent disk at `/var/data` and sets `LAB_DATA_DIR=/var/data`, so SQLite, project files, and chat history survive deploys/restarts. Add a custom domain (`lab.cloudwise.academy` → ALIAS the Render URL). Cost: $7/mo starter plan plus persistent disk storage, fits ~30 concurrent students.

### Architecture (Phase 1)

```
Browser ── WebSocket ──► Hono /ws ──► Agent SDK ──► claude CLI ──► Anthropic API
   ▲                       │
   │                       ▼
   └── HTTP /preview/:projectId/* ── sessions/{projectId}/{file}
                            ▲
                            │ chokidar watcher
                            ▼
                        files:changed event
```

Each project has a DB row and a persistent `sessions/{projectId}/` working directory. Closing the socket disposes the agent and watcher, but the project files stay on disk. Agent writes go through Read/Write/Edit/Bash with `cwd` pinned to the project dir; the chokidar watcher pushes file tree updates back to the browser; clicking a file in the tree loads it into the preview iframe via `/preview/{projectId}/{path}` after the same auth/ownership checks as the project API.

## Phase 0 — running the spike

```bash
cd cloudwise-lab
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY
npm install
npm run spike
```

You should see streaming `🔧 Write(index.html)` / `🔧 Write(style.css)` / `💬 ...` events, then a final `✅ success` line with cost + token counts, and the two files listed under `scratch/`.

Open `cloudwise-lab/scratch/index.html` in a browser to see the actual rendered page.

### Gotchas discovered in Phase 0 (load-bearing for Phase 1)

1. **Always use `dotenv.config({ override: true })`** — Claude for Desktop (and likely other shells) exports `ANTHROPIC_API_KEY=""` empty. Without `override`, dotenv refuses to overwrite the empty value and the SDK 401s.
2. **Set `CLAUDE_CONFIG_DIR` to a fresh temp dir per session** — the bundled CLI prefers `~/.claude/.credentials.json` and the macOS keychain over `ANTHROPIC_API_KEY`. Stale Claude Code subscription oauth wins and 401s. Pointing `CLAUDE_CONFIG_DIR` at an empty temp dir forces the API-key path.
3. **SDK 0.1.x has a duplicate-tool_use bug.** Pin `@anthropic-ai/claude-agent-sdk@^0.2.126` or newer.
4. **Orient the agent to its real cwd in the system prompt.** Without explicit "your tools operate in the current directory; use relative paths or absolute paths starting from `pwd`," the model hallucinates absolute paths like `/repo/...` from training. A short bash `pwd` step at the top of the prompt is cheap insurance.
