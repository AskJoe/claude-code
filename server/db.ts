/**
 * SQLite-backed storage. Lives at `cloudwise-lab/db/lab.sqlite`.
 *
 * Tables:
 *   - users               email + password identity
 *   - github_connections  separate GitHub OAuth tokens, one per user
 *   - projects            persistent "chat instance" per user
 *   - messages            conversation history per project
 *
 * better-sqlite3 is synchronous and fast — fine for a lab serving ~30
 * concurrent students with no daemon.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrations.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = resolve(__dirname, "..", "db", "lab.sqlite");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// All schema lives in server/migrations.ts and runs forward-only — no drops
// here. Rerunnable by design.
runMigrations(db);

// ── Types ────────────────────────────────────────────────────────────────────

export type UserRow = {
  id: number;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
  last_login_at: string;
  is_admin: number;             // SQLite stores booleans as 0/1
  disabled: number;
  budget_override_usd: number | null;
  /** Optional user-supplied system prompt prefix. Prepended to the agent's
   * baked prompt at session start. Capped at 4000 chars at write time. */
  system_prompt: string | null;
};

export type GithubConnectionRow = {
  user_id: number;
  github_id: number;
  github_login: string;
  installation_id: number;
  user_access_token_enc: string;
  user_token_expires_at: string | null;
  user_refresh_token_enc: string | null;
  connected_at: string;
};

export type ProjectRow = {
  id: number;
  user_id: number;
  slug: string;
  display_name: string;
  created_at: string;
  last_active_at: string;
  github_repo_id: number | null;
  github_repo_full_name: string | null;
  github_default_branch: string | null;
  render_site_url: string | null;
  render_yaml_committed_at: string | null;
};

export type MessageRow = {
  id: number;
  project_id: number;
  role: string;
  content_json: string;
  cost_usd: number | null;
  created_at: string;
};

// ── User statements ──────────────────────────────────────────────────────────

const sUserByEmail = db.prepare<[string], UserRow>(
  "SELECT * FROM users WHERE email = ?"
);
const sUserById = db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?");
const sCreateUser = db.prepare<
  [string, string, string | null],
  UserRow
>(`
  INSERT INTO users (email, password_hash, display_name)
  VALUES (?, ?, ?)
  RETURNING *;
`);
const sUpdateLastLogin = db.prepare<[number], void>(
  "UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
);

export function getUserByEmail(email: string): UserRow | null {
  return sUserByEmail.get(email.toLowerCase().trim()) ?? null;
}

export function getUserById(id: number): UserRow | null {
  return sUserById.get(id) ?? null;
}

export function createUser(input: {
  email: string;
  passwordHash: string;
  displayName: string | null;
}): UserRow {
  const row = sCreateUser.get(
    input.email.toLowerCase().trim(),
    input.passwordHash,
    input.displayName
  );
  if (!row) throw new Error("createUser returned no row");
  return row;
}

export function touchUserLogin(id: number): void {
  sUpdateLastLogin.run(id);
}

// ── GitHub connection statements ─────────────────────────────────────────────

const sGetGithubByUser = db.prepare<[number], GithubConnectionRow>(
  "SELECT * FROM github_connections WHERE user_id = ?"
);
const sUpsertGithubConn = db.prepare<
  [number, number, string, number, string, string | null, string | null],
  GithubConnectionRow
>(`
  INSERT INTO github_connections (
    user_id, github_id, github_login, installation_id,
    user_access_token_enc, user_token_expires_at, user_refresh_token_enc
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    github_id              = excluded.github_id,
    github_login           = excluded.github_login,
    installation_id        = excluded.installation_id,
    user_access_token_enc  = excluded.user_access_token_enc,
    user_token_expires_at  = excluded.user_token_expires_at,
    user_refresh_token_enc = excluded.user_refresh_token_enc,
    connected_at           = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  RETURNING *;
`);
const sDeleteGithubConn = db.prepare<[number], void>(
  "DELETE FROM github_connections WHERE user_id = ?"
);

export function getGithubConnection(userId: number): GithubConnectionRow | null {
  return sGetGithubByUser.get(userId) ?? null;
}

export function upsertGithubConnection(input: {
  userId: number;
  githubId: number;
  githubLogin: string;
  installationId: number;
  userAccessTokenEnc: string;
  userTokenExpiresAt: string | null;
  userRefreshTokenEnc: string | null;
}): GithubConnectionRow {
  const row = sUpsertGithubConn.get(
    input.userId,
    input.githubId,
    input.githubLogin,
    input.installationId,
    input.userAccessTokenEnc,
    input.userTokenExpiresAt,
    input.userRefreshTokenEnc
  );
  if (!row) throw new Error("upsertGithubConnection returned no row");
  return row;
}

export function deleteGithubConnection(userId: number): void {
  sDeleteGithubConn.run(userId);
}

// ── Project statements ───────────────────────────────────────────────────────

const sListProjects = db.prepare<[number], ProjectRow>(
  "SELECT * FROM projects WHERE user_id = ? ORDER BY last_active_at DESC"
);
const sGetProjectById = db.prepare<[number], ProjectRow>(
  "SELECT * FROM projects WHERE id = ?"
);
const sCreateProject = db.prepare<[number, string, string], ProjectRow>(`
  INSERT INTO projects (user_id, slug, display_name)
  VALUES (?, ?, ?)
  RETURNING *;
`);
const sTouchProject = db.prepare<[number], void>(
  "UPDATE projects SET last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
);
const sUpdateProjectGithub = db.prepare<
  [number, string, string, number],
  void
>(`
  UPDATE projects
  SET github_repo_id = ?, github_repo_full_name = ?, github_default_branch = ?
  WHERE id = ?
`);
const sDeleteProject = db.prepare<[number], void>(
  "DELETE FROM projects WHERE id = ?"
);
const sRenameProject = db.prepare<[string, number], void>(
  "UPDATE projects SET display_name = ? WHERE id = ?"
);

export function listProjects(userId: number): ProjectRow[] {
  return sListProjects.all(userId);
}

export function getProjectById(id: number): ProjectRow | null {
  return sGetProjectById.get(id) ?? null;
}

export function createProject(input: {
  userId: number;
  slug: string;
  displayName: string;
}): ProjectRow {
  const row = sCreateProject.get(input.userId, input.slug, input.displayName);
  if (!row) throw new Error("createProject returned no row");
  return row;
}

export function touchProject(id: number): void {
  sTouchProject.run(id);
}

export function setProjectGithub(input: {
  id: number;
  githubRepoId: number;
  githubRepoFullName: string;
  githubDefaultBranch: string;
}): void {
  sUpdateProjectGithub.run(
    input.githubRepoId,
    input.githubRepoFullName,
    input.githubDefaultBranch,
    input.id
  );
}

const sMarkRenderYamlCommitted = db.prepare<[number], void>(
  "UPDATE projects SET render_yaml_committed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
);
const sSetRenderSiteUrl = db.prepare<[string | null, number], void>(
  "UPDATE projects SET render_site_url = ? WHERE id = ?"
);

export function markRenderYamlCommitted(projectId: number): void {
  sMarkRenderYamlCommitted.run(projectId);
}

export function setProjectRenderSiteUrl(projectId: number, url: string | null): void {
  sSetRenderSiteUrl.run(url, projectId);
}

export function deleteProject(id: number): void {
  sDeleteProject.run(id);
}

export function renameProject(id: number, displayName: string): void {
  sRenameProject.run(displayName, id);
}

// ── Message statements ───────────────────────────────────────────────────────

const sAppendMessage = db.prepare<
  [number, string, string, number | null],
  void
>(`
  INSERT INTO messages (project_id, role, content_json, cost_usd)
  VALUES (?, ?, ?, ?);
`);
const sListMessages = db.prepare<[number, number], MessageRow>(
  "SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?"
);
const sDeleteMessages = db.prepare<[number], void>(
  "DELETE FROM messages WHERE project_id = ?"
);

export function appendMessage(input: {
  projectId: number;
  role: string;
  contentJson: string;
  costUsd: number | null;
}): void {
  sAppendMessage.run(
    input.projectId,
    input.role,
    input.contentJson,
    input.costUsd
  );
}

export function listMessages(projectId: number, limit = 500): MessageRow[] {
  return sListMessages.all(projectId, limit).reverse();
}

export function deleteMessages(projectId: number): void {
  sDeleteMessages.run(projectId);
}

// ── Admin queries ────────────────────────────────────────────────────────────

export type AdminUserRow = UserRow & {
  project_count: number;
  total_cost_usd: number;
  has_github: number;
};

const sListAdminUsers = db.prepare<[], AdminUserRow>(`
  SELECT
    u.*,
    (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS project_count,
    COALESCE(
      (SELECT SUM(m.cost_usd) FROM messages m
       JOIN projects p2 ON p2.id = m.project_id
       WHERE p2.user_id = u.id),
      0
    ) AS total_cost_usd,
    EXISTS (SELECT 1 FROM github_connections gc WHERE gc.user_id = u.id) AS has_github
  FROM users u
  ORDER BY u.created_at DESC
`);

export function listAdminUsers(): AdminUserRow[] {
  return sListAdminUsers.all();
}

const sGetAdminUser = db.prepare<[number], AdminUserRow>(`
  SELECT
    u.*,
    (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS project_count,
    COALESCE(
      (SELECT SUM(m.cost_usd) FROM messages m
       JOIN projects p2 ON p2.id = m.project_id
       WHERE p2.user_id = u.id),
      0
    ) AS total_cost_usd,
    EXISTS (SELECT 1 FROM github_connections gc WHERE gc.user_id = u.id) AS has_github
  FROM users u
  WHERE u.id = ?
`);

export function getAdminUser(id: number): AdminUserRow | null {
  return sGetAdminUser.get(id) ?? null;
}

const sUpdateUser = db.prepare<
  [
    number | null,
    number | null,
    number | null,
    string | null,
    number,
  ],
  void
>(`
  UPDATE users
  SET
    is_admin            = COALESCE(?, is_admin),
    disabled            = COALESCE(?, disabled),
    budget_override_usd = CASE WHEN ?2 IS NULL AND ?3 = 1 THEN NULL ELSE COALESCE(?, budget_override_usd) END,
    display_name        = COALESCE(?, display_name)
  WHERE id = ?
`);

export function updateUser(input: {
  id: number;
  isAdmin?: boolean;
  disabled?: boolean;
  budgetOverrideUsd?: number | null; // null = clear override
  displayName?: string | null;
}): void {
  // SQLite doesn't have great conditional update; do it explicitly.
  if (input.isAdmin !== undefined) {
    db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(
      input.isAdmin ? 1 : 0,
      input.id
    );
  }
  if (input.disabled !== undefined) {
    db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(
      input.disabled ? 1 : 0,
      input.id
    );
  }
  if (input.budgetOverrideUsd !== undefined) {
    db.prepare("UPDATE users SET budget_override_usd = ? WHERE id = ?").run(
      input.budgetOverrideUsd,
      input.id
    );
  }
  if (input.displayName !== undefined) {
    db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(
      input.displayName,
      input.id
    );
  }
}

export function setUserPasswordHash(id: number, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    passwordHash,
    id
  );
}

/** User-facing settings update for display name. Separate from admin's
 * `updateUser` so the user surface has a narrow, well-defined codepath. */
export function setUserDisplayName(id: number, displayName: string | null): void {
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(
    displayName,
    id
  );
}

/** Save the user's optional system-prompt prefix. Pass null to clear. */
export function setUserSystemPrompt(id: number, value: string | null): void {
  db.prepare("UPDATE users SET system_prompt = ? WHERE id = ?").run(value, id);
}

const sDeleteUser = db.prepare<[number], void>("DELETE FROM users WHERE id = ?");
export function deleteUser(id: number): void {
  sDeleteUser.run(id);
}

const sCountAdmins = db.prepare<[], { count: number }>(
  "SELECT COUNT(*) AS count FROM users WHERE is_admin = 1"
);
export function countAdmins(): number {
  return sCountAdmins.get()?.count ?? 0;
}

// ── Lab settings ─────────────────────────────────────────────────────────────

const sGetSetting = db.prepare<[string], { value: string }>(
  "SELECT value FROM lab_settings WHERE key = ?"
);
const sSetSetting = db.prepare<[string, string], void>(`
  INSERT INTO lab_settings (key, value, updated_at)
  VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(key) DO UPDATE SET
    value      = excluded.value,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`);
const sAllSettings = db.prepare<[], { key: string; value: string }>(
  "SELECT key, value FROM lab_settings"
);

export function getSetting(key: string): string | null {
  return sGetSetting.get(key)?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  sSetSetting.run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of sAllSettings.all()) out[row.key] = row.value;
  return out;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export type AdminMetrics = {
  totalUsers: number;
  totalProjects: number;
  activeLast7d: number;        // users who logged in in last 7 days
  totalCostUsd: number;
  costLast24hUsd: number;
  signupsByDay: Array<{ day: string; count: number }>;     // last 14 days
  topSpenders: Array<{ userId: number; email: string; turns: number; costUsd: number }>;
};

export function getAdminMetrics(): AdminMetrics {
  const totalUsers =
    db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM users").get()?.c ?? 0;
  const totalProjects =
    db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM projects").get()?.c ?? 0;
  const activeLast7d =
    db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM users WHERE last_login_at >= datetime('now','-7 days')"
      )
      .get()?.c ?? 0;
  const totalCostUsd =
    db
      .prepare<[], { c: number }>(
        "SELECT COALESCE(SUM(cost_usd),0) AS c FROM messages"
      )
      .get()?.c ?? 0;
  const costLast24hUsd =
    db
      .prepare<[], { c: number }>(
        "SELECT COALESCE(SUM(cost_usd),0) AS c FROM messages WHERE created_at >= datetime('now','-1 day')"
      )
      .get()?.c ?? 0;

  const signupsByDay = db
    .prepare<[], { day: string; count: number }>(
      `
      SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
      FROM users
      WHERE created_at >= datetime('now','-13 days')
      GROUP BY day
      ORDER BY day
    `
    )
    .all();

  const topSpenders = db
    .prepare<
      [],
      { userId: number; email: string; turns: number; costUsd: number }
    >(
      `
      SELECT
        u.id      AS userId,
        u.email   AS email,
        (SELECT COUNT(*) FROM messages m
          JOIN projects p ON p.id = m.project_id
          WHERE p.user_id = u.id AND m.role = 'turn_end') AS turns,
        COALESCE(
          (SELECT SUM(m.cost_usd) FROM messages m
            JOIN projects p ON p.id = m.project_id
            WHERE p.user_id = u.id),
          0
        ) AS costUsd
      FROM users u
      ORDER BY costUsd DESC
      LIMIT 10
    `
    )
    .all();

  return {
    totalUsers,
    totalProjects,
    activeLast7d,
    totalCostUsd,
    costLast24hUsd,
    signupsByDay,
    topSpenders,
  };
}
