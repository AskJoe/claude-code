/**
 * Versioned schema migrations.
 *
 * Each migration has a numeric `id` and a `sql` string that's run in a single
 * transaction. Applied migrations are recorded in `schema_migrations`; on
 * boot the runner skips ones already applied.
 *
 * No drops, ever. Schema changes always go forward via ALTER / CREATE IF NOT
 * EXISTS / INSERT OR IGNORE. If a migration needs more complex logic, expose
 * a function variant.
 */

import type Database from "better-sqlite3";
import { log } from "./log.ts";

type Migration = {
  id: number;
  name: string;
  sql: string;
};

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial-schema",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        email           TEXT UNIQUE NOT NULL,
        password_hash   TEXT NOT NULL,
        display_name    TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_login_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

      CREATE TABLE IF NOT EXISTS github_connections (
        user_id                INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        github_id              INTEGER UNIQUE NOT NULL,
        github_login           TEXT NOT NULL,
        installation_id        INTEGER NOT NULL,
        user_access_token_enc  TEXT NOT NULL,
        user_token_expires_at  TEXT,
        user_refresh_token_enc TEXT,
        connected_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS projects (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slug                     TEXT NOT NULL,
        display_name             TEXT NOT NULL,
        created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_active_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        github_repo_id           INTEGER,
        github_repo_full_name    TEXT,
        github_default_branch    TEXT
      );
      CREATE INDEX IF NOT EXISTS projects_user_idx ON projects(user_id);

      CREATE TABLE IF NOT EXISTS messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role          TEXT NOT NULL,
        content_json  TEXT NOT NULL,
        cost_usd      REAL,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS messages_project_idx ON messages(project_id, id);
    `,
  },
  {
    id: 2,
    name: "admin-area",
    sql: `
      -- Admin flag + lifecycle bits on the user row.
      ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN budget_override_usd REAL;

      -- Auto-promote the very first user (id = 1) to admin so the operator
      -- gets bootstrapped without any manual setup. No-op if there's no
      -- user with id = 1 yet (fresh installs).
      UPDATE users SET is_admin = 1 WHERE id = 1;

      -- Lab-wide runtime settings, editable from the admin UI.
      CREATE TABLE IF NOT EXISTS lab_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT OR IGNORE INTO lab_settings (key, value) VALUES
        ('default_model',         'claude-sonnet-4-6'),
        ('default_budget_usd',    '1.0'),
        ('rate_limit_per_minute', '20');
    `,
  },
  {
    id: 3,
    name: "render-publish",
    sql: `
      ALTER TABLE projects ADD COLUMN render_site_url TEXT;
      ALTER TABLE projects ADD COLUMN render_yaml_committed_at TEXT;
    `,
  },
  {
    id: 4,
    name: "user-system-prompt",
    sql: `
      ALTER TABLE users ADD COLUMN system_prompt TEXT;
    `,
  },
  {
    // Multi-session per project. A "chat session" is one continuous
    // conversation thread; `archived_at IS NULL` marks the active one. Reset
    // becomes "archive the current session and start a new one" so history
    // is browsable instead of wiped.
    id: 5,
    name: "chat-sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title           TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_message_at TEXT,
        message_count   INTEGER NOT NULL DEFAULT 0,
        total_cost_usd  REAL NOT NULL DEFAULT 0,
        archived_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS chat_sessions_project_idx
        ON chat_sessions(project_id, archived_at, id);

      ALTER TABLE messages ADD COLUMN chat_session_id INTEGER
        REFERENCES chat_sessions(id) ON DELETE CASCADE;

      -- Backfill: every existing project gets a "Legacy" chat session whose
      -- id we assign to all of that project's messages.
      INSERT INTO chat_sessions (project_id, title, archived_at)
        SELECT id, 'Legacy archive', strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM projects;

      UPDATE messages SET chat_session_id = (
        SELECT id FROM chat_sessions
        WHERE chat_sessions.project_id = messages.project_id
          AND chat_sessions.title = 'Legacy archive'
        LIMIT 1
      )
      WHERE chat_session_id IS NULL;
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const appliedRows = db
    .prepare<[], { id: number }>("SELECT id FROM schema_migrations ORDER BY id")
    .all();
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    log.info("applying migration", { id: m.id, name: m.name });
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name) VALUES (?, ?)").run(
        m.id,
        m.name
      );
    });
    try {
      tx();
    } catch (err) {
      log.error("migration failed", {
        id: m.id,
        name: m.name,
        err: (err as Error).message,
      });
      throw err;
    }
  }
}
