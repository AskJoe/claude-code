/**
 * Project lifecycle: per-user persistent "chat instances".
 *
 * Each project has:
 *   - a row in the `projects` table
 *   - a directory at `sessions/<projectId>/` containing the Astro starter
 *     copy + whatever the agent has written
 *   - a chat transcript in the `messages` table
 *   - optionally, a connected GitHub repo
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createProject,
  deleteProject as dbDeleteProject,
  getProjectById,
  listProjects,
  type ProjectRow,
} from "./db.ts";
import { SESSIONS_ROOT, TEMPLATE_DIR } from "./paths.ts";
import { log } from "./log.ts";

/** Filesystem path where this project's working files live. */
export function projectDir(projectId: number): string {
  return join(SESSIONS_ROOT, String(projectId));
}

export async function projectDirExists(projectId: number): Promise<boolean> {
  try {
    const s = await stat(projectDir(projectId));
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Creates a new project for a user, hydrates its dir from the Astro starter,
 * and returns the row.
 */
export async function createProjectFor(
  userId: number,
  displayName: string
): Promise<ProjectRow> {
  const cleanName = displayName.trim() || "Untitled project";
  const slug = slugify(cleanName);
  const project = createProject({
    userId,
    slug,
    displayName: cleanName,
  });

  try {
    await ensureProjectStarter(project.id);
  } catch (err) {
    dbDeleteProject(project.id);
    throw err;
  }

  log.info("project created", { projectId: project.id, userId, slug });
  return project;
}

/**
 * Ensures a project directory contains the Astro starter. This is used both on
 * create and on open so old projects created while the template was missing can
 * self-heal without replacing user files.
 */
export async function ensureProjectStarter(projectId: number): Promise<void> {
  const dir = projectDir(projectId);
  await mkdir(dir, { recursive: true });

  try {
    await stat(join(dir, "package.json"));
    return;
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  try {
    const t = await stat(TEMPLATE_DIR);
    if (t.isDirectory()) {
      await cp(TEMPLATE_DIR, dir, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    } else {
      throw new Error(`template path is not a directory: ${TEMPLATE_DIR}`);
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(
        `Astro starter template missing at ${TEMPLATE_DIR}; run npm run prepare-template during build`
      );
    }
    throw err;
  }

  log.info("project starter hydrated", { projectId });
}

export async function deleteProjectAndDir(projectId: number): Promise<void> {
  await rm(projectDir(projectId), { recursive: true, force: true });
  dbDeleteProject(projectId);
  log.info("project deleted", { projectId });
}

export function listProjectsFor(userId: number): ProjectRow[] {
  return listProjects(userId);
}

export function getProjectFor(userId: number, projectId: number): ProjectRow | null {
  const p = getProjectById(projectId);
  if (!p || p.user_id !== userId) return null;
  return p;
}

/**
 * Public-safe view of a project (no internal user_id leak). Used by /api responses.
 */
export type PublicProject = {
  id: number;
  slug: string;
  displayName: string;
  createdAt: string;
  lastActiveAt: string;
  github: {
    connected: boolean;
    repoFullName: string | null;
    defaultBranch: string | null;
  };
  render: {
    siteUrl: string | null;
    yamlCommitted: boolean;
  };
};

export function publicProject(row: ProjectRow): PublicProject {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    github: {
      connected: !!row.github_repo_full_name,
      repoFullName: row.github_repo_full_name,
      defaultBranch: row.github_default_branch,
    },
    render: {
      siteUrl: row.render_site_url,
      yamlCommitted: !!row.render_yaml_committed_at,
    },
  };
}

// ── Slug generation ──────────────────────────────────────────────────────────

const ADJECTIVES = [
  "swift",
  "bright",
  "calm",
  "bold",
  "cosmic",
  "warm",
  "dusty",
  "lively",
  "quiet",
  "sunny",
];
const NOUNS = [
  "river",
  "harbor",
  "atlas",
  "voyage",
  "studio",
  "compass",
  "lantern",
  "summit",
  "garden",
  "drift",
];

/**
 * Turns a display name into a URL-friendly slug, then appends a 6-char hex
 * suffix to prevent collisions across users — matches Lovable's pattern of
 * `multi-saga-builder-f7fcda93`.
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const usable = base.length >= 3 ? base : randomNounAdj();
  const suffix = randomBytes(4).toString("hex"); // 8 hex chars
  return `${usable}-${suffix}`;
}

function randomNounAdj(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}`;
}
