/**
 * Phase 4 end-to-end smoke test.
 *
 * 1. Signup as a fresh user.
 * 2. Create a project.
 * 3. Open WS for that project; verify session:ready.
 * 4. Send a build prompt; wait for turn_end.
 * 5. Close the WS.
 * 6. Reopen the WS for the same project; verify history replay (the prior
 *    user message + agent text + tool_use events come back as ServerEvents).
 *
 * Requires the dev server running on PORT 3101 with LAB_SESSION_SECRET set.
 */

import WebSocket from "ws";

const PORT = Number(process.env.PORT ?? 3101);
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

async function api<T>(
  path: string,
  init: RequestInit = {},
  cookie?: string
): Promise<{ body: T; setCookie: string | null }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return { body: body as T, setCookie: res.headers.get("set-cookie") };
}

function extractCookie(setCookie: string | null): string {
  if (!setCookie) throw new Error("no Set-Cookie");
  const m = /lab_session=([^;]+)/.exec(setCookie);
  if (!m) throw new Error(`no lab_session cookie in: ${setCookie}`);
  return `lab_session=${m[1]}`;
}

async function openWs(projectId: number, cookie: string): Promise<{
  ws: WebSocket;
  events: any[];
  waitFor: (pred: (e: any) => boolean, timeoutMs?: number) => Promise<any>;
}> {
  const ws = new WebSocket(`${WS_URL}?projectId=${projectId}`, {
    headers: { Cookie: cookie },
  });
  const events: any[] = [];
  const waiters: Array<(e: any) => boolean> = [];
  ws.on("message", (raw) => {
    let evt: any;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    events.push(evt);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i](evt)) waiters.splice(i, 1);
    }
  });
  await new Promise<void>((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  const waitFor = (pred: (e: any) => boolean, timeoutMs = 60_000) =>
    new Promise<any>((res, rej) => {
      for (const e of events) if (pred(e)) return res(e);
      const t = setTimeout(() => rej(new Error("timeout")), timeoutMs);
      waiters.push((evt) => {
        if (pred(evt)) {
          clearTimeout(t);
          res(evt);
          return true;
        }
        return false;
      });
    });
  return { ws, events, waitFor };
}

async function main() {
  // Use a unique email per run so reruns don't collide.
  const email = `smoke-${Date.now()}@cloudwise.test`;

  console.log("▶ step 1: signup");
  const signup = await api<{ user: any }>(
    "/api/auth/signup",
    {
      method: "POST",
      body: JSON.stringify({ email, password: "hunter22hunter22", displayName: "Smoke" }),
    }
  );
  if (!signup.body.user) fail("signup returned no user");
  const cookie = extractCookie(signup.setCookie);
  console.log(`  ✓ user id=${signup.body.user.id}`);

  console.log("▶ step 2: create project");
  const created = await api<{ project: { id: number; slug: string } }>(
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({ displayName: "Coffee Shop" }),
    },
    cookie
  );
  const projectId = created.body.project.id;
  console.log(`  ✓ project id=${projectId} slug=${created.body.project.slug}`);

  console.log("▶ step 3: open WS, send build prompt");
  const conn1 = await openWs(projectId, cookie);
  const ready1 = await conn1.waitFor((e) => e.type === "session:ready", 10_000);
  console.log(`  ✓ session:ready (sessionId=${ready1.sessionId})`);

  conn1.ws.send(
    JSON.stringify({
      type: "user:message",
      text:
        'Edit index.html and styles.css to be a coffee shop landing page for "Mountain Brew" — single-screen hero with a tagline. Do not add a framework or run a build command.',
    })
  );

  const turn1 = await conn1.waitFor((e) => e.type === "agent:turn_end", 120_000);
  console.log(
    `  ✓ first turn ended: $${turn1.cost.toFixed(4)}, ${turn1.durationMs}ms`
  );

  conn1.ws.close();
  await new Promise((r) => setTimeout(r, 500));

  console.log("▶ step 4: reopen WS — expect history replay");
  const conn2 = await openWs(projectId, cookie);
  await conn2.waitFor((e) => e.type === "session:ready", 10_000);

  // After session:ready, the server replays past events. Wait briefly so they
  // all arrive, then count.
  await new Promise((r) => setTimeout(r, 500));
  const userReplays = conn2.events.filter((e) => e.type === "chat:user_message");
  const turnEnds = conn2.events.filter((e) => e.type === "agent:turn_end");
  const toolUses = conn2.events.filter((e) => e.type === "agent:tool_use");

  if (userReplays.length === 0) fail("no chat:user_message replayed");
  if (turnEnds.length === 0) fail("no agent:turn_end replayed");
  if (toolUses.length === 0) fail("no agent:tool_use replayed");
  console.log(
    `  ✓ replay: ${userReplays.length} user msg(s), ${toolUses.length} tool_use, ${turnEnds.length} turn_end`
  );

  conn2.ws.close();
  console.log("\n✅ Phase 4 smoke test PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ smoke failed:", err);
  process.exit(1);
});
