/**
 * /api/admin/* — operator-only endpoints. Gated by requireAdmin (returns 403,
 * not 401, so the SPA can distinguish "you're signed in but not allowed" from
 * "you're not signed in at all").
 */

import type { Hono } from "hono";
import {
  countAdmins,
  deleteUser,
  getAdminMetrics,
  getAdminUser,
  getProjectById,
  listAdminUsers,
  listMessages,
  listProjects,
  setUserPasswordHash,
  updateUser,
  type AdminUserRow,
  type ProjectRow,
} from "./db.ts";
import { authMiddleware, type AuthUser } from "./auth.ts";
import { hashPassword } from "./passwords.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { deleteProjectAndDir } from "./projects.ts";
import { log } from "./log.ts";
import { randomBytes } from "node:crypto";

const requireAdmin: import("hono").MiddlewareHandler = async (c, next) => {
  const user = c.get("user") as AuthUser | undefined;
  if (!user) return c.json({ error: "unauthorized" }, 401);
  if (!user.isAdmin) return c.json({ error: "admin only" }, 403);
  return next();
};

function publicAdminUser(row: AdminUserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    isAdmin: row.is_admin === 1,
    disabled: row.disabled === 1,
    budgetOverrideUsd: row.budget_override_usd,
    projectCount: row.project_count,
    totalCostUsd: row.total_cost_usd,
    hasGithub: row.has_github === 1,
  };
}

function publicAdminProject(row: ProjectRow) {
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    github: {
      connected: !!row.github_repo_full_name,
      repoFullName: row.github_repo_full_name,
      defaultBranch: row.github_default_branch,
    },
  };
}

export function registerAdminRoutes(app: Hono): void {
  // Apply auth + admin gate to every /api/admin/* route.
  app.use("/api/admin/*", authMiddleware, requireAdmin);

  // ── Users ────────────────────────────────────────────────────────────────

  app.get("/api/admin/users", (c) => {
    const users = listAdminUsers().map(publicAdminUser);
    return c.json({ users });
  });

  app.get("/api/admin/users/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const row = getAdminUser(id);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ user: publicAdminUser(row) });
  });

  app.patch("/api/admin/users/:id", async (c) => {
    const me = c.get("user") as AuthUser;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const target = getAdminUser(id);
    if (!target) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({} as any));

    // Defensive: don't let an admin demote themselves if they're the only one.
    if (body.isAdmin === false && id === me.id && countAdmins() <= 1) {
      return c.json(
        { error: "cannot demote yourself — you're the only admin" },
        400
      );
    }
    // Defensive: don't let an admin disable themselves.
    if (body.disabled === true && id === me.id) {
      return c.json({ error: "cannot disable yourself" }, 400);
    }

    const patch: Parameters<typeof updateUser>[0] = { id };
    if (typeof body.isAdmin === "boolean") patch.isAdmin = body.isAdmin;
    if (typeof body.disabled === "boolean") patch.disabled = body.disabled;
    if (body.budgetOverrideUsd === null) {
      patch.budgetOverrideUsd = null;
    } else if (typeof body.budgetOverrideUsd === "number") {
      if (!Number.isFinite(body.budgetOverrideUsd) || body.budgetOverrideUsd <= 0) {
        return c.json({ error: "budgetOverrideUsd must be > 0 or null" }, 400);
      }
      patch.budgetOverrideUsd = body.budgetOverrideUsd;
    }
    if (typeof body.displayName === "string") {
      patch.displayName = body.displayName.trim() || null;
    }

    updateUser(patch);
    log.info("admin updated user", { adminId: me.id, targetId: id, patch: body });
    const updated = getAdminUser(id);
    return c.json({ user: updated ? publicAdminUser(updated) : null });
  });

  app.delete("/api/admin/users/:id", async (c) => {
    const me = c.get("user") as AuthUser;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    if (id === me.id) {
      return c.json({ error: "cannot delete yourself" }, 400);
    }
    const target = getAdminUser(id);
    if (!target) return c.json({ error: "not found" }, 404);

    // Remove their project dirs from disk first (DB cascades the rows).
    const theirProjects = listProjects(id);
    for (const p of theirProjects) {
      try {
        await deleteProjectAndDir(p.id);
      } catch (err) {
        log.error("failed to remove project dir during user delete", {
          projectId: p.id,
          err: (err as Error).message,
        });
      }
    }
    deleteUser(id);
    log.info("admin deleted user", { adminId: me.id, targetId: id });
    return c.json({ ok: true });
  });

  app.post("/api/admin/users/:id/reset-password", async (c) => {
    const me = c.get("user") as AuthUser;
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const target = getAdminUser(id);
    if (!target) return c.json({ error: "not found" }, 404);

    // Generate a 16-char readable random password (URL-safe-ish, no ambiguous
    // chars). Returned ONCE so the admin can hand it off to the user.
    const newPassword = randomReadablePassword(16);
    const hash = await hashPassword(newPassword);
    setUserPasswordHash(id, hash);
    log.info("admin reset password", { adminId: me.id, targetId: id });
    return c.json({ ok: true, newPassword });
  });

  // ── Projects ─────────────────────────────────────────────────────────────

  app.get("/api/admin/users/:id/projects", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const target = getAdminUser(id);
    if (!target) return c.json({ error: "not found" }, 404);
    const projects = listProjects(id).map(publicAdminProject);
    return c.json({ projects });
  });

  app.get("/api/admin/projects/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const project = getProjectById(id);
    if (!project) return c.json({ error: "not found" }, 404);
    const owner = getAdminUser(project.user_id);
    return c.json({
      project: publicAdminProject(project),
      owner: owner ? publicAdminUser(owner) : null,
    });
  });

  app.get("/api/admin/projects/:id/messages", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const project = getProjectById(id);
    if (!project) return c.json({ error: "not found" }, 404);
    const limit = Math.min(Number(c.req.query("limit") ?? 1000), 5000);
    const messages = listMessages(id, limit);
    return c.json({ messages });
  });

  // ── Metrics ──────────────────────────────────────────────────────────────

  app.get("/api/admin/metrics", (c) => {
    return c.json({ metrics: getAdminMetrics() });
  });

  // ── Settings ─────────────────────────────────────────────────────────────

  app.get("/api/admin/settings", (c) => {
    return c.json({ settings: getSettings() });
  });

  app.patch("/api/admin/settings", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    try {
      const settings = updateSettings({
        defaultModel:
          typeof body.defaultModel === "string" ? body.defaultModel : undefined,
        defaultBudgetUsd:
          typeof body.defaultBudgetUsd === "number"
            ? body.defaultBudgetUsd
            : undefined,
        rateLimitPerMinute:
          typeof body.rateLimitPerMinute === "number"
            ? body.rateLimitPerMinute
            : undefined,
      });
      return c.json({ settings });
    } catch (err: any) {
      return c.json({ error: err?.message ?? String(err) }, 400);
    }
  });
}

function randomReadablePassword(len: number): string {
  // Lower + upper + digits, no ambiguous chars (0/O, 1/l/I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[buf[i] % alphabet.length];
  }
  return out;
}
