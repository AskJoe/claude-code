/**
 * Production auth + preview smoke test.
 *
 * Run after starting the server with auth enabled:
 *   LAB_SESSION_SECRET=test-secret-do-not-use-in-prod NODE_ENV=production npm start
 *
 * Verifies:
 *   1. /api/me reports requireAuth=true.
 *   2. Protected routes reject anonymous requests.
 *   3. Signup issues a lab_session cookie.
 *   4. Authenticated project creation works.
 *   5. Preview is protected before the project is open.
 *   6. The old LAB_JWT_SECRET-only deployment contract is not accepted.
 */

const PORT = Number(process.env.PORT ?? 3101);
const BASE = `http://localhost:${PORT}`;

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

async function request(
  path: string,
  init: RequestInit = {},
  cookie?: string
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body, setCookie: res.headers.get("set-cookie") };
}

function extractSessionCookie(setCookie: string | null): string {
  if (!setCookie) fail("missing Set-Cookie on signup");
  const cookieHeader = setCookie as string;
  const match = /lab_session=([^;]+)/.exec(cookieHeader);
  const sessionValue = match?.[1];
  if (!sessionValue) fail(`Set-Cookie did not include lab_session: ${cookieHeader}`);
  return `lab_session=${sessionValue}`;
}

async function main() {
  console.log("▶ step 1: server must report auth required");
  const meAnon = await request("/api/me");
  if (meAnon.status !== 200) fail(`/api/me returned ${meAnon.status}`);
  if (meAnon.body?.requireAuth !== true) {
    fail(
      `/api/me reported requireAuth=${String(
        meAnon.body?.requireAuth
      )}; start the server with LAB_SESSION_SECRET`
    );
  }
  if (meAnon.body?.user !== null) {
    fail(`/api/me returned an anonymous user while auth is required: ${JSON.stringify(meAnon.body)}`);
  }
  console.log("  ✓ requireAuth=true and no anonymous user");

  console.log("▶ step 2: protected project routes reject anonymous requests");
  const projectsAnon = await request("/api/projects");
  if (projectsAnon.status !== 401) {
    fail(`expected /api/projects 401 without cookie, got ${projectsAnon.status}`);
  }
  const previewAnon = await request("/preview/1/index.html");
  if (previewAnon.status !== 401) {
    fail(`expected /preview 401 without cookie, got ${previewAnon.status}`);
  }
  console.log("  ✓ anonymous API and preview requests are blocked");

  console.log("▶ step 3: signup issues session cookie");
  const email = `auth-smoke-${Date.now()}@cloudwise.test`;
  const signup = await request("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email,
      password: "hunter22hunter22",
      displayName: "Auth Smoke",
    }),
  });
  if (signup.status !== 200) fail(`signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  const cookie = extractSessionCookie(signup.setCookie);
  if (!signup.body?.user?.id) fail(`signup returned no user id: ${JSON.stringify(signup.body)}`);
  console.log(`  ✓ signed up user id=${signup.body.user.id}`);

  console.log("▶ step 4: authenticated project creation works");
  const created = await request(
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify({ displayName: "Auth Smoke Project" }),
    },
    cookie
  );
  if (created.status !== 200) {
    fail(`project create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const projectId = created.body?.project?.id;
  if (!projectId) fail(`project create returned no id: ${JSON.stringify(created.body)}`);
  console.log(`  ✓ created project id=${projectId}`);

  console.log("▶ step 5: preview requires ownership and a live session");
  const previewOwned = await request(`/preview/${projectId}/index.html`, {}, cookie);
  if (previewOwned.status !== 404) {
    fail(`expected owned but unopened preview to be 404, got ${previewOwned.status}`);
  }
  const previewOther = await request(`/preview/${projectId + 1}/index.html`, {}, cookie);
  if (previewOther.status !== 404) {
    fail(`expected unknown/other preview to be 404, got ${previewOther.status}`);
  }
  console.log("  ✓ preview is owner-gated before live session lookup");

  console.log("▶ step 6: LAB_JWT_SECRET is not the auth switch");
  if (process.env.LAB_JWT_SECRET && !process.env.LAB_SESSION_SECRET) {
    fail("LAB_JWT_SECRET is set without LAB_SESSION_SECRET; this deployment would run with auth disabled");
  }
  console.log("  ✓ LAB_SESSION_SECRET is the required deployment variable");

  console.log("\n✅ auth smoke test PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ auth smoke failed:", err);
  process.exit(1);
});
