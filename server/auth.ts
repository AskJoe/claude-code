/**
 * Email + password auth.
 *
 * Identity comes from a `lab_session` cookie (signed JWT) carrying our internal
 * user id. The cookie is set by /api/auth/signup and /api/auth/signin, cleared
 * by /api/auth/logout, and verified on every protected route + the WebSocket
 * upgrade.
 *
 * Required env: LAB_SESSION_SECRET (`openssl rand -hex 32`).
 *
 * If LAB_SESSION_SECRET isn't set, auth runs in dev mode: every request gets
 * a synthetic anonymous user. Don't ship to prod without setting it.
 */

import { sign, verify } from "hono/jwt";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  createUser,
  getUserByEmail,
  getUserById,
  setUserDisplayName,
  setUserSystemPrompt,
  touchUserLogin,
  type UserRow,
} from "./db.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { log } from "./log.ts";

const COOKIE = "lab_session";
const COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days
const SESSION_SECRET = process.env.LAB_SESSION_SECRET ?? "";
const IS_PROD = process.env.NODE_ENV === "production";

export const REQUIRE_AUTH = !!SESSION_SECRET;

if (!REQUIRE_AUTH) {
  log.warn("LAB_SESSION_SECRET not set — auth is OFF (dev mode)", {
    hint: "openssl rand -hex 32",
  });
}

export type AuthUser = {
  id: number;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
};

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

function userFromRow(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
  };
}

async function setSessionCookie(c: Context, userId: number): Promise<void> {
  const token = await sign(
    { uid: userId, iat: Math.floor(Date.now() / 1000) },
    SESSION_SECRET,
    "HS256"
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SEC,
  });
}

/** Reads the user from the cookie. Null if absent, invalid, or disabled. */
export async function readUser(c: Context): Promise<AuthUser | null> {
  if (!REQUIRE_AUTH) {
    return {
      id: 0,
      email: "anonymous@local",
      displayName: "Anonymous",
      isAdmin: false,
    };
  }
  const cookie = getCookie(c, COOKIE);
  if (!cookie) return null;
  let payload: any;
  try {
    payload = await verify(cookie, SESSION_SECRET, "HS256");
  } catch {
    return null;
  }
  const uid = typeof payload.uid === "number" ? payload.uid : null;
  if (uid == null) return null;
  const row = getUserById(uid);
  if (!row) return null;
  if (row.disabled === 1) return null; // disabled accounts can't act
  return userFromRow(row);
}

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const user = await readUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  return next();
};

export async function readUserForWs(c: Context): Promise<AuthUser | null> {
  return readUser(c);
}

// ── Routes ───────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerAuthRoutes(app: Hono): void {
  app.post("/api/auth/signup", async (c) => {
    if (!REQUIRE_AUTH) return c.json({ error: "auth disabled in dev" }, 400);
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const displayName =
      typeof body?.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim()
        : null;
    if (!EMAIL_RE.test(email)) return c.json({ error: "invalid email" }, 400);
    if (password.length < 8) return c.json({ error: "password must be at least 8 chars" }, 400);
    if (getUserByEmail(email)) return c.json({ error: "email already in use" }, 409);

    const passwordHash = await hashPassword(password);
    const row = createUser({ email, passwordHash, displayName });
    await setSessionCookie(c, row.id);
    log.info("user signup", { userId: row.id, email });
    return c.json({ user: userFromRow(row) });
  });

  app.post("/api/auth/signin", async (c) => {
    if (!REQUIRE_AUTH) return c.json({ error: "auth disabled in dev" }, 400);
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) return c.json({ error: "email and password required" }, 400);
    const row = getUserByEmail(email);
    if (!row) return c.json({ error: "invalid email or password" }, 401);
    if (row.disabled === 1) {
      return c.json({ error: "this account has been disabled" }, 403);
    }
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) return c.json({ error: "invalid email or password" }, 401);
    touchUserLogin(row.id);
    await setSessionCookie(c, row.id);
    log.info("user signin", { userId: row.id, email });
    return c.json({ user: userFromRow(row) });
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, COOKIE);
    return c.json({ ok: true });
  });

  // PATCH the signed-in user's display name. Returns the updated user shape so
  // the SPA can swap state without an extra `/api/me` round-trip.
  app.patch("/api/me/profile", authMiddleware, async (c) => {
    const me = c.get("user") as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.displayName === "string") {
      const trimmed = body.displayName.trim().slice(0, 80);
      setUserDisplayName(me.id, trimmed || null);
    }
    const row = getUserById(me.id);
    if (!row) return c.json({ error: "user not found" }, 500);
    return c.json({ user: userFromRow(row) });
  });

  // GET the user's saved system-prompt prefix so the Settings panel can
  // populate the textarea on open.
  app.get("/api/me/system-prompt", authMiddleware, (c) => {
    const me = c.get("user") as AuthUser;
    const row = getUserById(me.id);
    if (!row) return c.json({ error: "user not found" }, 500);
    return c.json({ systemPrompt: row.system_prompt ?? null });
  });

  // PATCH the system prompt. Cap at 4000 chars at write time. Empty string
  // clears the prefix (stored as NULL).
  app.patch("/api/me/system-prompt", authMiddleware, async (c) => {
    const me = c.get("user") as AuthUser;
    const body = await c.req.json().catch(() => ({}));
    let value: string | null = null;
    if (typeof body.systemPrompt === "string") {
      value = body.systemPrompt.trim().slice(0, 4000) || null;
    }
    setUserSystemPrompt(me.id, value);
    return c.json({ ok: true, systemPrompt: value });
  });
}
