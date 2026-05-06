/**
 * Auto-sync a project's working directory to a connected GitHub repo, using
 * GitHub App auth (NOT OAuth App).
 *
 * Two token types are used:
 *   1. User-to-server token (from OAuth identify flow). Used to create new
 *      repos in the user's namespace via POST /user/repos. Stored encrypted
 *      in github_connections.user_access_token_enc.
 *   2. Installation token (server-to-server, scoped to the user's install).
 *      Minted on demand from the App's private key + installation_id, lasts
 *      ~1 hour. Used in `git push` URLs as the bearer credential.
 *
 * Installation tokens expire fast — that's the whole point. Even if our DB or
 * server is compromised, the live tokens are at most an hour old, scoped to
 * Contents:write on the repos the user installed the App on, with no admin or
 * delete permissions.
 */

import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getGithubConnection,
  getProjectById,
  setProjectGithub,
  type ProjectRow,
} from "./db.ts";
import { getAppCredentials, getValidUserAccessToken } from "./github-app.ts";
import { log } from "./log.ts";

const exec = promisify(execFile);

/**
 * The working branch where every agent edit lands automatically. Production
 * (= the live Render site) deploys from `main`, which only advances when the
 * user clicks Publish. This separation prevents the Render site from
 * flickering through every in-progress edit.
 */
export const WORKING_BRANCH = "cloudwise-lab";

// ── Token minting ────────────────────────────────────────────────────────────

type InstallationToken = { token: string; expiresAt: number };
const installationTokenCache = new Map<number, InstallationToken>();

/**
 * Returns a fresh installation token for the given installation. Cached for
 * ~50 minutes (tokens last ~1hr; we refresh early for safety).
 */
async function getInstallationToken(installationId: number): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const { appId, privateKey } = getAppCredentials();
  const auth = createAppAuth({ appId, privateKey });
  const result = await auth({ type: "installation", installationId });
  const token = (result as any).token as string;
  // The auth response includes an `expiresAt` ISO string; if missing, default
  // to 50 min from now.
  const expiresAtIso = (result as any).expiresAt as string | undefined;
  const expiresAt = expiresAtIso
    ? new Date(expiresAtIso).getTime() - 60_000
    : Date.now() + 50 * 60_000;
  installationTokenCache.set(installationId, { token, expiresAt });
  return token;
}

// ── Repo connection ──────────────────────────────────────────────────────────

/**
 * Verifies the user has created the expected repo on GitHub, then initializes
 * git locally and pushes the project's current contents.
 *
 * GitHub Apps cannot create repos in a user's personal namespace via
 * user-to-server tokens (the `POST /user/repos` endpoint requires permissions
 * GitHub Apps don't expose). The user creates the repo themselves via
 * github.com/new, then this function connects + pushes.
 */
export type ConnectRepoResult =
  | { kind: "ready"; repoFullName: string; defaultBranch: string }
  | { kind: "repo_not_found"; expectedFullName: string };

export async function connectExistingRepoForProject(input: {
  userId: number;
  projectId: number;
  projectDir: string;
}): Promise<ConnectRepoResult> {
  const project = getProjectById(input.projectId);
  if (!project || project.user_id !== input.userId) {
    throw new Error("project not found");
  }
  if (project.github_repo_full_name) {
    return {
      kind: "ready",
      repoFullName: project.github_repo_full_name,
      defaultBranch: project.github_default_branch ?? "main",
    };
  }

  const conn = getGithubConnection(input.userId);
  if (!conn) throw new Error("GitHub not connected");

  // 1. Verify the user created the expected repo. We use the user-to-server
  //    token for this — the GitHub App's Metadata: read permission grants
  //    GET /repos/:owner/:repo on the user's own repos. `getValidUserAccessToken`
  //    auto-refreshes the stored OAuth token if it's expired (which it does
  //    in ~8 hours — without this the call below 401s with "Bad credentials").
  const userToken = await getValidUserAccessToken(input.userId);
  const repoName = `cloudwise-${project.slug}`;
  const expectedFullName = `${conn.github_login}/${repoName}`;
  const userOcto = new Octokit({ auth: userToken });
  let repo: { id: number; full_name: string; default_branch: string };
  try {
    const { data } = await userOcto.request(
      "GET /repos/{owner}/{repo}",
      { owner: conn.github_login, repo: repoName }
    );
    repo = {
      id: data.id,
      full_name: data.full_name,
      default_branch: data.default_branch,
    };
  } catch (err: any) {
    if (err.status === 404) {
      // The user hasn't created the repo on GitHub yet. Return a soft signal
      // so the client can poll without surfacing a scary error.
      return { kind: "repo_not_found", expectedFullName };
    }
    throw err;
  }

  const repoFullName = repo.full_name;
  const defaultBranch = repo.default_branch ?? "main";
  log.info("github repo connected", { projectId: project.id, repoFullName });

  // 2. Initialize git locally and push the current contents using an
  //    installation token (short-lived, scoped to the install). If the user
  //    installed the App on "Selected repositories" and didn't include this
  //    new one, the push 4xx's and we surface a helpful error.
  const installToken = await getInstallationToken(conn.installation_id);
  const remoteUrl = `https://x-access-token:${installToken}@github.com/${repoFullName}.git`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  await git(input.projectDir, ["init", "--quiet", "--initial-branch", defaultBranch], env);
  // Use --replace-all in case `origin` already exists (e.g. a retry).
  try {
    await git(input.projectDir, ["remote", "remove", "origin"], env);
  } catch {}
  await git(input.projectDir, ["remote", "add", "origin", remoteUrl], env);
  await ensureGitignore(input.projectDir);
  await git(
    input.projectDir,
    [
      "-c",
      "user.email=lab@cloudwise.academy",
      "-c",
      "user.name=Cloudwise Lab",
      "add",
      "-A",
    ],
    env
  );
  await git(
    input.projectDir,
    [
      "-c",
      "user.email=lab@cloudwise.academy",
      "-c",
      "user.name=Cloudwise Lab",
      "commit",
      "--allow-empty",
      "-m",
      "Initial commit from Cloudwise Lab",
    ],
    env
  );
  try {
    await git(input.projectDir, ["push", "-u", "origin", defaultBranch], env);
  } catch (err: any) {
    log.error("initial push failed", {
      projectId: project.id,
      repo: repoFullName,
    });
    if (/403|denied|permission/i.test(err.stderr ?? err.message ?? "")) {
      throw new Error(
        `Push denied — your Cloudwise Lab GitHub App probably isn't installed on this new repo. Open https://github.com/settings/installations, click "Configure" on Cloudwise Lab, and either pick "All repositories" or add ${repoFullName} to the selection. Then click Connect again.`
      );
    }
    throw err;
  }

  // Create the working branch from the same initial commit and push it.
  // From here on, all agent edits land on cloudwise-lab; main only advances
  // on Publish.
  await git(input.projectDir, ["checkout", "-b", WORKING_BRANCH], env);
  try {
    await git(input.projectDir, ["push", "-u", "origin", WORKING_BRANCH], env);
  } catch (err) {
    log.error("initial working-branch push failed", {
      projectId: project.id,
      repo: repoFullName,
      branch: WORKING_BRANCH,
      err: (err as Error).message,
    });
    throw err;
  }

  setProjectGithub({
    id: project.id,
    githubRepoId: repo.id,
    githubRepoFullName: repoFullName,
    githubDefaultBranch: defaultBranch,
  });

  return { kind: "ready", repoFullName, defaultBranch };
}

// ── Auto-syncer ──────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 3_000;

export type AutoSyncer = {
  notifyChange: () => void;
  flush: () => Promise<void>;
  dispose: () => void;
};

export function startAutoSync(input: {
  userId: number;
  project: ProjectRow;
  projectDir: string;
  onError?: (err: Error) => void;
}): AutoSyncer | null {
  if (!input.project.github_repo_full_name) return null;
  const conn = getGithubConnection(input.userId);
  if (!conn) return null;

  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let pendingWhileInFlight = false;
  let disposed = false;
  let branchEnsured = false; // tracks whether we've created/checked-out cloudwise-lab yet

  // Ensures the local repo has the working branch checked out and the remote
  // has it. Idempotent: safe to call on every runSync (it's a no-op once
  // we're already on the working branch). This is what migrates existing
  // projects from "everything on main" to the two-branch model.
  const ensureWorkingBranch = async (): Promise<void> => {
    const token = await getInstallationToken(conn.installation_id);
    const remoteUrl = `https://x-access-token:${token}@github.com/${input.project.github_repo_full_name}.git`;
    await git(input.projectDir, ["remote", "set-url", "origin", remoteUrl], env);

    // Are we already on the working branch?
    let current = "";
    try {
      const r = await git(
        input.projectDir,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        env
      );
      current = r.stdout.trim();
    } catch {}
    if (current === WORKING_BRANCH) return;

    // Does the local working branch exist?
    let localExists = false;
    try {
      await git(
        input.projectDir,
        ["show-ref", "--verify", "--quiet", `refs/heads/${WORKING_BRANCH}`],
        env
      );
      localExists = true;
    } catch {}

    if (localExists) {
      await git(input.projectDir, ["checkout", WORKING_BRANCH], env);
    } else {
      // Create from current HEAD (preserves whatever's already committed).
      await git(input.projectDir, ["checkout", "-b", WORKING_BRANCH], env);
    }

    // Make sure the remote has it too. -u sets upstream tracking so the
    // subsequent plain `git push` always knows where to go.
    try {
      await git(input.projectDir, ["push", "-u", "origin", WORKING_BRANCH], env);
    } catch (err: any) {
      // If remote already has the branch, retry as a regular push (without -u).
      if (/already exists|fast-forward|rejected/i.test(err.stderr ?? err.message ?? "")) {
        await git(
          input.projectDir,
          ["branch", `--set-upstream-to=origin/${WORKING_BRANCH}`, WORKING_BRANCH],
          env
        );
      } else {
        throw err;
      }
    }
    log.info("working branch ensured", {
      projectId: input.project.id,
      branch: WORKING_BRANCH,
    });
  };

  const runSync = async (): Promise<void> => {
    if (disposed) return;
    try {
      if (!branchEnsured) {
        await ensureWorkingBranch();
        branchEnsured = true;
      }

      await git(
        input.projectDir,
        [
          "-c",
          "user.email=lab@cloudwise.academy",
          "-c",
          "user.name=Cloudwise Lab",
          "add",
          "-A",
        ],
        env
      );
      const status = await git(input.projectDir, ["status", "--porcelain"], env);
      if (!status.stdout.trim()) return;
      await git(
        input.projectDir,
        [
          "-c",
          "user.email=lab@cloudwise.academy",
          "-c",
          "user.name=Cloudwise Lab",
          "commit",
          "-m",
          `Update via Cloudwise Lab (${new Date()
            .toISOString()
            .slice(0, 19)
            .replace("T", " ")})`,
        ],
        env
      );
      // Mint a fresh installation token for this push.
      const token = await getInstallationToken(conn.installation_id);
      const remoteUrl = `https://x-access-token:${token}@github.com/${input.project.github_repo_full_name}.git`;
      await git(input.projectDir, ["remote", "set-url", "origin", remoteUrl], env);
      await git(input.projectDir, ["push", "origin", WORKING_BRANCH], env);
      log.info("auto-sync pushed", {
        projectId: input.project.id,
        repo: input.project.github_repo_full_name,
        branch: WORKING_BRANCH,
      });
    } catch (err) {
      log.error("auto-sync failed", {
        projectId: input.project.id,
        err: (err as Error).message,
      });
      input.onError?.(err as Error);
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (inFlight) {
      pendingWhileInFlight = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      inFlight = runSync().finally(() => {
        inFlight = null;
        if (pendingWhileInFlight && !disposed) {
          pendingWhileInFlight = false;
          schedule();
        }
      });
    }, DEBOUNCE_MS);
  };

  return {
    notifyChange: schedule,
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
      await runSync();
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// ── git plumbing ─────────────────────────────────────────────────────────────

async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
}

async function ensureGitignore(dir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const gi = path.join(dir, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gi, "utf-8");
  } catch {}
  const needed = ["node_modules", "dist", ".DS_Store"];
  const lines = new Set(existing.split("\n").map((l) => l.trim()).filter(Boolean));
  let dirty = false;
  for (const want of needed) {
    if (!lines.has(want)) {
      lines.add(want);
      dirty = true;
    }
  }
  if (dirty) {
    await fs.writeFile(gi, [...lines].join("\n") + "\n");
  }
}
