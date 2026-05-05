/**
 * GitHub App integration — replaces the old OAuth-App flow.
 *
 * Why GitHub Apps: tokens are scoped to specific repos (not all of the user's
 * repos), have narrow permissions (Contents: write, not full `repo`), and
 * expire in ~1 hour with auto-refresh. Massively smaller blast radius if the
 * server or DB is ever compromised.
 *
 * Setup (one-time, by Joe):
 *   1. Visit https://github.com/settings/apps/new
 *   2. Fill in:
 *        GitHub App name:           Cloudwise Lab
 *        Homepage URL:              http://localhost:3000   (or prod URL)
 *        Callback URL:              http://localhost:3000/api/github/callback
 *        ✅ Request user authorization (OAuth) during installation
 *        ❌ Webhook (uncheck "Active")
 *      Repository permissions:
 *        Contents: Read and write
 *        Metadata: Read-only (default)
 *      User permissions: (none needed)
 *      Where can this GitHub App be installed: Any account
 *   3. Click "Create GitHub App"
 *   4. On the app's settings page, generate two things and copy the values:
 *        - Client ID            (top of the page)
 *        - Client secret        (click "Generate a new client secret")
 *        - Private key          (click "Generate a private key" — downloads a .pem file)
 *      Also note:
 *        - App ID               (numeric, top of the page)
 *        - Public link slug     (e.g. github.com/apps/cloudwise-lab → slug = "cloudwise-lab")
 *   5. Save the .pem file to cloudwise-lab/secrets/github-app.pem (gitignored)
 *      and set in .env:
 *        LAB_GITHUB_APP_ID=<numeric app id>
 *        LAB_GITHUB_APP_CLIENT_ID=<Iv23...>
 *        LAB_GITHUB_APP_CLIENT_SECRET=<client secret>
 *        LAB_GITHUB_APP_SLUG=<app slug>
 *        LAB_GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app.pem
 *
 * Endpoints:
 *   GET  /api/github/connect   → redirects to a combined OAuth + install URL.
 *                                If the student hasn't installed the App yet,
 *                                GitHub walks them through it as part of the
 *                                same flow.
 *   GET  /api/github/callback  → receives `code` (for OAuth user token) and
 *                                `installation_id` (the App install on their
 *                                account). Stores both, attributed to the
 *                                currently signed-in lab user.
 *   POST /api/github/disconnect→ removes the connection row. (App install
 *                                itself can be uninstalled by the user from
 *                                their GitHub settings.)
 */

import { Hono, type Context } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { authMiddleware, readUser } from "./auth.ts";
import { deleteGithubConnection, upsertGithubConnection, getProjectById } from "./db.ts";
import { encrypt } from "./crypto.ts";
import { log } from "./log.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PUBLIC_URL = process.env.LAB_PUBLIC_URL ?? "http://localhost:3000";
const APP_ID = process.env.LAB_GITHUB_APP_ID;
const APP_CLIENT_ID = process.env.LAB_GITHUB_APP_CLIENT_ID;
const APP_CLIENT_SECRET = process.env.LAB_GITHUB_APP_CLIENT_SECRET;
const APP_SLUG = process.env.LAB_GITHUB_APP_SLUG;
const APP_PRIVATE_KEY_PATH = process.env.LAB_GITHUB_APP_PRIVATE_KEY_PATH;
const IS_PROD = process.env.NODE_ENV === "production";

let cachedPrivateKey: string | null = null;
function loadPrivateKey(): string {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (!APP_PRIVATE_KEY_PATH) {
    throw new Error("LAB_GITHUB_APP_PRIVATE_KEY_PATH not set");
  }
  const abs = resolve(APP_PRIVATE_KEY_PATH);
  cachedPrivateKey = readFileSync(abs, "utf-8");
  return cachedPrivateKey;
}

export const APP_CONFIGURED = !!(
  APP_ID && APP_CLIENT_ID && APP_CLIENT_SECRET && APP_SLUG && APP_PRIVATE_KEY_PATH
);

if (!APP_CONFIGURED) {
  log.warn("GitHub App not configured — Connect GitHub disabled", {
    have_app_id: !!APP_ID,
    have_client_id: !!APP_CLIENT_ID,
    have_client_secret: !!APP_CLIENT_SECRET,
    have_slug: !!APP_SLUG,
    have_private_key_path: !!APP_PRIVATE_KEY_PATH,
  });
}

/**
 * Returns a usable user-to-server access token for the given user.
 *
 * GitHub user-to-server tokens expire in ~8 hours. The OAuth callback
 * stores both the access token and the refresh token (also encrypted).
 * This helper decrypts the stored access token; if it's already expired
 * (or within 5 minutes of expiring) it calls GitHub's refresh endpoint,
 * persists the new pair, and returns the refreshed access token.
 *
 * Throws a clear "reconnect required" error when the refresh token is
 * itself expired or revoked — callers should surface that to the UI so
 * the user can re-link their GitHub account.
 */
export async function getValidUserAccessToken(userId: number): Promise<string> {
  // Lazy-import to avoid a circular dep with db.ts at module init.
  const { getGithubConnection, upsertGithubConnection } = await import("./db.ts");
  const { decrypt, encrypt } = await import("./crypto.ts");

  const conn = getGithubConnection(userId);
  if (!conn) throw new Error("GitHub not connected");

  const expiresAt = conn.user_token_expires_at
    ? Date.parse(conn.user_token_expires_at)
    : null;
  const tokenStillValid =
    expiresAt === null || // no expiry set = no expiration policy on the App
    expiresAt - Date.now() > 5 * 60 * 1000; // 5-minute safety margin

  if (tokenStillValid) {
    return decrypt(conn.user_access_token_enc);
  }

  // Need to refresh. If we don't have a refresh token, we can't —
  // user must reconnect.
  if (!conn.user_refresh_token_enc) {
    throw new Error(
      "GitHub auth expired — please reconnect your GitHub account."
    );
  }

  if (!APP_CLIENT_ID || !APP_CLIENT_SECRET) {
    throw new Error("GitHub App OAuth credentials not configured");
  }

  const refreshToken = decrypt(conn.user_refresh_token_enc);
  const tokenRes = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: APP_CLIENT_ID,
        client_secret: APP_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    }
  );
  if (!tokenRes.ok) {
    log.error("github user token refresh failed", { status: tokenRes.status });
    throw new Error(
      "GitHub auth expired — please reconnect your GitHub account."
    );
  }
  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
  };
  if (!tokenData.access_token) {
    log.error("github user token refresh: no access_token", {
      err: tokenData.error,
    });
    throw new Error(
      "GitHub auth expired — please reconnect your GitHub account."
    );
  }

  const newExpiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  upsertGithubConnection({
    userId: conn.user_id,
    githubId: conn.github_id,
    githubLogin: conn.github_login,
    installationId: conn.installation_id,
    userAccessTokenEnc: encrypt(tokenData.access_token),
    userTokenExpiresAt: newExpiresAt,
    // GitHub rotates the refresh token on every refresh — store the new
    // one or fall back to the old one if (somehow) one wasn't returned.
    userRefreshTokenEnc: tokenData.refresh_token
      ? encrypt(tokenData.refresh_token)
      : conn.user_refresh_token_enc,
  });
  log.info("github user token refreshed", { userId, githubLogin: conn.github_login });
  return tokenData.access_token;
}

export function getAppCredentials() {
  if (!APP_CONFIGURED) {
    throw new Error("GitHub App not configured");
  }
  return {
    appId: Number(APP_ID),
    clientId: APP_CLIENT_ID!,
    clientSecret: APP_CLIENT_SECRET!,
    privateKey: loadPrivateKey(),
  };
}

export function registerGitHubAppRoutes(app: Hono): void {
  if (!APP_CONFIGURED) return;

  app.get("/api/github/connect", authMiddleware, (c) => {
    const state = randomState();
    const cookieOpts = {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: "Lax" as const,
      path: "/",
      maxAge: 10 * 60,
    };
    setCookie(c, "gh_oauth_state", state, cookieOpts);

    // Capture which project the user came from so we can:
    //   (a) auto-create + connect the repo for that project after install
    //   (b) redirect them back to that project page (preserving context)
    const projectIdRaw = c.req.query("projectId");
    if (projectIdRaw && /^\d+$/.test(projectIdRaw)) {
      setCookie(c, "gh_oauth_project", projectIdRaw, cookieOpts);
    } else {
      deleteCookie(c, "gh_oauth_project");
    }

    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", APP_CLIENT_ID!);
    url.searchParams.set("redirect_uri", `${PUBLIC_URL}/api/github/callback`);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.get("/api/github/callback", async (c) => {
    const user = await readUser(c);
    if (!user) {
      return c.text("Sign in to the lab first, then click Connect GitHub.", 401);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const installationIdRaw = c.req.query("installation_id");
    const cookieState = parseCookie(c.req.header("cookie") ?? "", "gh_oauth_state");

    if (!code || !state || state !== cookieState) {
      log.warn("github app callback: state mismatch", { userId: user.id });
      return c.text("OAuth failed: state mismatch", 400);
    }
    if (!installationIdRaw) {
      // The user authorized but didn't install. Send them to the install page.
      const installUrl = `https://github.com/apps/${APP_SLUG}/installations/new?state=${encodeURIComponent(
        state
      )}`;
      return c.redirect(installUrl, 302);
    }
    const installationId = Number(installationIdRaw);
    if (!Number.isFinite(installationId)) {
      return c.text("OAuth failed: bad installation_id", 400);
    }

    // Exchange code for a user-to-server token.
    const tokenRes = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: APP_CLIENT_ID,
          client_secret: APP_CLIENT_SECRET,
          code,
          redirect_uri: `${PUBLIC_URL}/api/github/callback`,
        }),
      }
    );
    if (!tokenRes.ok) {
      log.error("github app token exchange failed", { status: tokenRes.status });
      return c.text("OAuth failed: token exchange", 502);
    }
    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      expires_in?: number; // present only if token expiration is enabled on the App
      refresh_token?: string;
      refresh_token_expires_in?: number;
      token_type?: string;
      scope?: string;
      error?: string;
    };
    if (!tokenData.access_token) {
      log.error("github app oauth: no token", { err: tokenData.error });
      return c.text("OAuth failed: no token", 502);
    }

    // Fetch GitHub profile using the user-to-server token.
    const ghRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "cloudwise-lab",
        Accept: "application/vnd.github+json",
      },
    });
    if (!ghRes.ok) {
      log.error("github user fetch failed", { status: ghRes.status });
      return c.text("OAuth failed: user fetch", 502);
    }
    const ghUser = (await ghRes.json()) as { id: number; login: string };

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    upsertGithubConnection({
      userId: user.id,
      githubId: ghUser.id,
      githubLogin: ghUser.login,
      installationId,
      userAccessTokenEnc: encrypt(tokenData.access_token),
      userTokenExpiresAt: expiresAt,
      userRefreshTokenEnc: tokenData.refresh_token
        ? encrypt(tokenData.refresh_token)
        : null,
    });
    log.info("github app connected", {
      userId: user.id,
      login: ghUser.login,
      installationId,
    });

    deleteCookie(c, "gh_oauth_state");

    // Send the user back to wherever they came from. We don't auto-create the
    // repo here — GitHub Apps can't create repos in user namespaces, so the
    // user manually creates it from the lab's "Create repo on GitHub" link in
    // the popover, then clicks "Connect repo".
    const intentProject = getCookie(c, "gh_oauth_project");
    deleteCookie(c, "gh_oauth_project");
    let landingHash = "/";
    if (intentProject && /^\d+$/.test(intentProject)) {
      const pid = Number(intentProject);
      const project = getProjectById(pid);
      if (project && project.user_id === user.id) {
        landingHash = `/p/${pid}`;
      }
    }
    return c.redirect(`${PUBLIC_URL}/#${landingHash}`, 302);
  });

  app.post("/api/github/disconnect", authMiddleware, (c) => {
    const user = c.get("user");
    deleteGithubConnection(user.id);
    log.info("github disconnected", { userId: user.id });
    return c.json({ ok: true });
  });
}

function randomState(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(/;\s*/)) {
    const [k, ...v] = part.split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
