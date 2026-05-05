/**
 * Phase 3 SSO smoke test. Run AFTER spawning the server with:
 *   LAB_REQUIRE_AUTH=1 LAB_JWT_SECRET=test-secret-do-not-use-in-prod NODE_ENV=production npm run start
 *
 * Verifies:
 *   1. Hitting /api/lessons without auth → 401
 *   2. Hitting / without auth → 401 HTML
 *   3. Minting a JWT and presenting it via ?token=... → /api/lessons returns 200
 *   4. The cookie persists for subsequent requests
 *   5. WS upgrade without cookie → 401
 *   6. WS upgrade with cookie → connects, session:ready arrives
 */

import { sign } from "hono/jwt";
import WebSocket from "ws";

const PORT = Number(process.env.PORT ?? 3101);
const SECRET = process.env.LAB_JWT_SECRET ?? "test-secret-do-not-use-in-prod";
const BASE = `http://localhost:${PORT}`;

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

async function main() {
  console.log("▶ step 1: GET /api/lessons without auth → expect 401");
  const r1 = await fetch(`${BASE}/api/lessons`);
  if (r1.status !== 401) fail(`expected 401, got ${r1.status}`);
  console.log("  ✓ 401");

  console.log("▶ step 2: GET / (HTML) without auth → expect 401");
  const r2 = await fetch(`${BASE}/`, { headers: { accept: "text/html" } });
  if (r2.status !== 401) fail(`expected 401, got ${r2.status}`);
  console.log("  ✓ 401");

  console.log("▶ step 3: mint a JWT and present via ?token=...");
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    { sub: "test-student-1", name: "Test Student", iat: now, exp: now + 3600 },
    SECRET
  );

  const r3 = await fetch(`${BASE}/api/lessons?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
  // The token-strip redirect should fire on / paths but /api/* is consumed
  // directly. Either is acceptable; the cookie should be set.
  const setCookie = r3.headers.get("set-cookie");
  if (!setCookie || !setCookie.includes("lab_session=")) {
    fail(`no lab_session cookie set: ${setCookie}`);
  }
  console.log(`  ✓ Set-Cookie header present (status ${r3.status})`);

  // Extract cookie for subsequent requests
  const cookieMatch = /lab_session=([^;]+)/.exec(setCookie ?? "");
  if (!cookieMatch) fail("could not parse cookie value");
  const cookie = `lab_session=${cookieMatch[1]}`;

  console.log("▶ step 4: subsequent request with cookie → 200");
  const r4 = await fetch(`${BASE}/api/lessons`, { headers: { cookie } });
  if (r4.status !== 200) fail(`expected 200 with cookie, got ${r4.status}`);
  const body = (await r4.json()) as { lessons: unknown[] };
  if (!Array.isArray(body.lessons)) fail("manifest shape wrong");
  console.log(`  ✓ 200, ${body.lessons.length} lessons`);

  console.log("▶ step 5: GET /api/me → returns user");
  const r5 = await fetch(`${BASE}/api/me`, { headers: { cookie } });
  const me = (await r5.json()) as { user: { sub?: string } };
  if (me.user?.sub !== "test-student-1") fail(`wrong user: ${JSON.stringify(me)}`);
  console.log(`  ✓ user.sub=${me.user.sub}`);

  console.log("▶ step 6: WS upgrade without cookie → 401");
  await new Promise<void>((res) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.on("error", () => res());
    ws.on("unexpected-response", (_req, response) => {
      if (response.statusCode === 401) {
        console.log("  ✓ 401 unexpected-response");
        res();
      } else {
        fail(`expected 401, got ${response.statusCode}`);
      }
    });
    ws.on("open", () => fail("WS opened without auth"));
  });

  console.log("▶ step 7: WS upgrade with cookie → connects");
  await new Promise<void>((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, {
      headers: { cookie },
    });
    const t = setTimeout(() => {
      rej(new Error("ws connect timeout"));
      ws.close();
    }, 8000);
    ws.on("message", (raw) => {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "session:ready") {
        clearTimeout(t);
        console.log(`  ✓ session:ready id=${evt.sessionId}`);
        ws.close();
        res();
      }
    });
    ws.on("error", (err) => {
      clearTimeout(t);
      rej(err);
    });
  });

  console.log("\n✅ Phase 3 SSO smoke test PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ smoke failed:", err);
  process.exit(1);
});
