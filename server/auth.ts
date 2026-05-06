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
import { createHash, randomBytes } from "node:crypto";
import {
  createUser,
  findAuthTokenByHash,
  getUserByEmail,
  getUserById,
  insertAuthToken,
  invalidateUserTokens,
  markAuthTokenUsed,
  markUserEmailVerified,
  setUserDisplayName,
  setUserPasswordHash,
  setUserSystemPrompt,
  touchUserLogin,
  type UserRow,
} from "./db.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import {
  isSmtpConfigured,
  magicEmail,
  resetEmail,
  sendAuthEmail,
  verifyEmail,
} from "./email.ts";
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
  emailVerified: boolean;
};

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

/** Whether the lab should ask users to verify their email.
 *
 * Default: derived from SMTP config — if we can't actually deliver mail, we
 * silently mark everyone as verified so the banner doesn't pester users
 * about an action they can't take. Override with LAB_REQUIRE_EMAIL_VERIFY=1
 * or =0 if you want to force the behavior. */
function isVerifyRequired(): boolean {
  const env = process.env.LAB_REQUIRE_EMAIL_VERIFY;
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return isSmtpConfigured();
}

function userFromRow(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    // Pretend verified when verification isn't required — keeps the
    // bottom-right banner from nagging users in dev / no-SMTP setups.
    emailVerified: row.email_verified === 1 || !isVerifyRequired(),
  };
}

async function setSessionCookie(c: Context, userId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    { uid: userId, iat: now, exp: now + COOKIE_MAX_AGE_SEC },
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
      emailVerified: true,
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
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp == null || exp <= Math.floor(Date.now() / 1000)) return null;
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

// ── Token utilities (Phase 7) ────────────────────────────────────────────────

/** Time-to-live for issued auth tokens, in milliseconds. */
const TTL = {
  verify: 1 * 60 * 60 * 1000, // 1 hour
  reset: 1 * 60 * 60 * 1000, // 1 hour
  magic: 15 * 60 * 1000, // 15 min — short, since they sign you straight in
};

/** Generate a fresh raw token + its sha256 hash. The raw goes in the email
 * link; the hash goes in the DB. */
function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Build a `${proto}://${host}` prefix from the incoming request. Honors
 * X-Forwarded-Proto/Host so links work behind Render's proxy. */
function publicOrigin(c: Context): string {
  const forwardedProto = c.req.header("x-forwarded-proto");
  const forwardedHost = c.req.header("x-forwarded-host");
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto.split(",")[0].trim()}://${forwardedHost.split(",")[0].trim()}`;
  }
  // Fallback: use the request URL.
  try {
    const u = new URL(c.req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return process.env.LAB_PUBLIC_URL ?? "http://localhost:3000";
  }
}

async function issueAndEmail(args: {
  c: Context;
  user: UserRow;
  kind: "verify" | "reset" | "magic";
}): Promise<{ token: string; expiresAt: Date }> {
  // Invalidate prior unused tokens of this kind so the most recent email
  // is the only working link.
  invalidateUserTokens(args.user.id, args.kind);
  const { raw, hash } = newToken();
  const expiresAt = new Date(Date.now() + TTL[args.kind]);
  insertAuthToken({
    userId: args.user.id,
    kind: args.kind,
    tokenHash: hash,
    expiresAt,
  });
  const origin = publicOrigin(args.c);
  if (args.kind === "verify") {
    const link = `${origin}/auth/verify?token=${encodeURIComponent(raw)}`;
    await sendAuthEmail(verifyEmail({ to: args.user.email, link }));
  } else if (args.kind === "reset") {
    const link = `${origin}/#/auth/reset/${encodeURIComponent(raw)}`;
    await sendAuthEmail(resetEmail({ to: args.user.email, link }));
  } else {
    const link = `${origin}/auth/magic?token=${encodeURIComponent(raw)}`;
    await sendAuthEmail(magicEmail({ to: args.user.email, link }));
  }
  return { token: raw, expiresAt };
}

/** Look up a raw token; reject if missing, expired, used, or wrong kind. */
function consumeToken(
  raw: string,
  expectedKind: "verify" | "reset" | "magic"
): { ok: true; userId: number } | { ok: false; error: string } {
  const hash = hashToken(raw);
  const row = findAuthTokenByHash(hash);
  if (!row || row.kind !== expectedKind) {
    return { ok: false, error: "invalid token" };
  }
  if (row.used_at) return { ok: false, error: "token already used" };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "token expired" };
  }
  markAuthTokenUsed(row.id);
  return { ok: true, userId: row.user_id };
}

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
    // Auto-issue + send verify email — only when verification is actually
    // required. Skipping in no-SMTP setups keeps the dev console clean and
    // avoids issuing tokens that have nowhere useful to land.
    if (isVerifyRequired()) {
      try {
        await issueAndEmail({ c, user: row, kind: "verify" });
      } catch (err: any) {
        log.warn("verify email send failed at signup", {
          userId: row.id,
          err: err?.message ?? String(err),
        });
      }
    }
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

  // ── Email verification ────────────────────────────────────────────────────

  // Re-send the verify email for the signed-in user. Always returns ok=true
  // so the caller can show a generic "check your inbox" toast even when the
  // user's already verified (no-op).
  app.post("/api/auth/verify-email/send", authMiddleware, async (c) => {
    const me = c.get("user") as AuthUser;
    if (me.emailVerified) return c.json({ ok: true, alreadyVerified: true });
    const row = getUserById(me.id);
    if (!row) return c.json({ error: "user not found" }, 500);
    try {
      await issueAndEmail({ c, user: row, kind: "verify" });
    } catch (err: any) {
      log.error("verify resend failed", {
        userId: me.id,
        err: err?.message ?? String(err),
      });
      return c.json({ error: "could not send email" }, 500);
    }
    return c.json({ ok: true });
  });

  // Verify link target. Issued via email; we redirect to the SPA root once
  // the token is consumed. Status messages surface via query params so the
  // SPA can show an inline toast.
  app.get("/auth/verify", (c) => {
    const token = c.req.query("token") ?? "";
    const result = consumeToken(token, "verify");
    if (!result.ok) {
      return c.redirect(`/?verify_error=${encodeURIComponent(result.error)}`);
    }
    markUserEmailVerified(result.userId);
    log.info("user email verified", { userId: result.userId });
    return c.redirect(`/?verified=1`);
  });

  // ── Password reset ────────────────────────────────────────────────────────

  // Always returns ok=true so the client can't enumerate which emails exist
  // ("did this fail because the email isn't on file?" leaks user existence).
  app.post("/api/auth/password-reset/send", async (c) => {
    if (!REQUIRE_AUTH) return c.json({ error: "auth disabled in dev" }, 400);
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) {
      return c.json({ ok: true, smtpConfigured: isSmtpConfigured() });
    }
    const row = getUserByEmail(email);
    if (row && row.disabled !== 1) {
      try {
        await issueAndEmail({ c, user: row, kind: "reset" });
      } catch (err: any) {
        log.error("reset send failed", {
          userId: row.id,
          err: err?.message ?? String(err),
        });
      }
    }
    return c.json({ ok: true, smtpConfigured: isSmtpConfigured() });
  });

  // Validate a reset token without consuming it. Used by the SPA's reset
  // page to check the token is still good before showing the form.
  app.get("/api/auth/password-reset/check", (c) => {
    const token = c.req.query("token") ?? "";
    const hash = hashToken(token);
    const row = findAuthTokenByHash(hash);
    if (!row || row.kind !== "reset") return c.json({ valid: false });
    if (row.used_at) return c.json({ valid: false, reason: "used" });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.json({ valid: false, reason: "expired" });
    }
    return c.json({ valid: true });
  });

  // Confirm and apply a new password. The token is consumed even on a bad
  // password so attackers can't repeatedly try the SAME token with different
  // passwords (we only let them try one — get the password right or get a
  // new email).
  app.post("/api/auth/password-reset/confirm", async (c) => {
    if (!REQUIRE_AUTH) return c.json({ error: "auth disabled in dev" }, 400);
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length < 8) {
      return c.json({ error: "password must be at least 8 chars" }, 400);
    }
    const result = consumeToken(token, "reset");
    if (!result.ok) return c.json({ error: result.error }, 400);
    const passwordHash = await hashPassword(password);
    setUserPasswordHash(result.userId, passwordHash);
    // Reset implies email is real — auto-verify if not already.
    markUserEmailVerified(result.userId);
    // Sign the user in.
    await setSessionCookie(c, result.userId);
    log.info("password reset", { userId: result.userId });
    const row = getUserById(result.userId);
    return c.json({ ok: true, user: row ? userFromRow(row) : null });
  });

  // ── Magic-link sign-in ────────────────────────────────────────────────────

  // Same enumeration-resistant pattern: always ok=true.
  app.post("/api/auth/magic-link/send", async (c) => {
    if (!REQUIRE_AUTH) return c.json({ error: "auth disabled in dev" }, 400);
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) {
      return c.json({ ok: true, smtpConfigured: isSmtpConfigured() });
    }
    const row = getUserByEmail(email);
    if (row && row.disabled !== 1) {
      try {
        await issueAndEmail({ c, user: row, kind: "magic" });
      } catch (err: any) {
        log.error("magic send failed", {
          userId: row.id,
          err: err?.message ?? String(err),
        });
      }
    }
    return c.json({ ok: true, smtpConfigured: isSmtpConfigured() });
  });

  // Server-side redirect target. Consumes the token, sets the session
  // cookie, and 302's to the SPA root. Magic-link users implicitly verify
  // their email — if you can read the inbox, you own the address.
  app.get("/auth/magic", async (c) => {
    const token = c.req.query("token") ?? "";
    const result = consumeToken(token, "magic");
    if (!result.ok) {
      return c.redirect(`/?magic_error=${encodeURIComponent(result.error)}`);
    }
    markUserEmailVerified(result.userId);
    touchUserLogin(result.userId);
    await setSessionCookie(c, result.userId);
    log.info("magic-link signin", { userId: result.userId });
    return c.redirect(`/?magic=1`);
  });
}
