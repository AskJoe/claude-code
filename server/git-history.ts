/**
 * Git history operations for the History panel: list recent commits via the
 * GitHub API, and revert the working tree to a prior commit (creating a new
 * commit that documents the rewind, non-destructive).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { getAppCredentials } from "./github-app.ts";
import { WORKING_BRANCH } from "./github-sync.ts";
import type { ProjectRow } from "./db.ts";
import { log } from "./log.ts";

const exec = promisify(execFile);

export type CommitSummary = {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string | null;
  committedAt: string;
  htmlUrl: string;
  /** True when this commit is the current main HEAD (= currently published). */
  isPublished: boolean;
};

async function getInstallationToken(installationId: number): Promise<string> {
  const { appId, privateKey } = getAppCredentials();
  const auth = createAppAuth({ appId, privateKey });
  const r = await auth({ type: "installation", installationId });
  return (r as any).token as string;
}

export async function listCommitsForProject(input: {
  project: ProjectRow;
  installationId: number;
  perPage?: number;
}): Promise<CommitSummary[]> {
  const repoFullName = input.project.github_repo_full_name;
  if (!repoFullName) return [];
  const [owner, repo] = repoFullName.split("/");
  const token = await getInstallationToken(input.installationId);
  const octo = new Octokit({ auth: token });
  const main = input.project.github_default_branch ?? "main";

  // List commits from the WORKING branch (where the actual edits land).
  // We then decorate each with whether it's at-or-before main's tip so the
  // UI can show a "Published" pill.
  let mainSha: string | null = null;
  try {
    const { data } = await octo.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch: main,
    });
    mainSha = data.commit?.sha ?? null;
  } catch {
    // main might not exist yet — leave null
  }

  let workingCommits: any[] = [];
  try {
    const { data } = await octo.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      sha: WORKING_BRANCH,
      per_page: input.perPage ?? 30,
    });
    workingCommits = data;
  } catch (err: any) {
    if (err.status === 404) {
      // working branch doesn't exist yet — fall back to main
      const { data } = await octo.request("GET /repos/{owner}/{repo}/commits", {
        owner,
        repo,
        sha: main,
        per_page: input.perPage ?? 30,
      });
      workingCommits = data;
    } else {
      throw err;
    }
  }

  return workingCommits.map((c: any) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    message: c.commit.message ?? "",
    authorName: c.commit.author?.name ?? "unknown",
    authorEmail: c.commit.author?.email ?? null,
    committedAt: c.commit.author?.date ?? c.commit.committer?.date ?? "",
    htmlUrl: c.html_url,
    isPublished: !!mainSha && c.sha === mainSha,
  }));
}

/**
 * Reverts the project's working tree to match the given commit's tree, then
 * commits + pushes that as a new commit on the branch tip. Non-destructive —
 * old commits stay in history.
 *
 * Implementation: `git checkout <sha> -- .` puts the target tree in the
 * working dir; `git add -A && git commit` records it as a new commit. The
 * branch advances; nothing is rewritten.
 */
export async function revertProjectToCommit(input: {
  project: ProjectRow;
  installationId: number;
  sha: string;
  projectDir: string;
}): Promise<void> {
  const repoFullName = input.project.github_repo_full_name;
  if (!repoFullName) throw new Error("project has no GitHub repo");
  if (!/^[a-f0-9]{7,40}$/.test(input.sha)) {
    throw new Error("invalid commit sha");
  }

  // Reverts target the WORKING branch — main only advances on Publish.
  const branch = WORKING_BRANCH;
  const token = await getInstallationToken(input.installationId);
  const remoteUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  // Make sure we're on the working branch and we have the target sha locally
  // before checking out from it.
  await git(input.projectDir, ["remote", "set-url", "origin", remoteUrl], env);
  try {
    await git(input.projectDir, ["fetch", "origin", branch], env);
  } catch (err) {
    log.warn("fetch before revert failed (continuing)", {
      err: (err as Error).message,
    });
  }
  let current = "";
  try {
    const r = await git(input.projectDir, ["rev-parse", "--abbrev-ref", "HEAD"], env);
    current = r.stdout.trim();
  } catch {}
  if (current !== branch) {
    try {
      await git(input.projectDir, ["checkout", branch], env);
    } catch {
      await git(input.projectDir, ["checkout", "-b", branch, `origin/${branch}`], env);
    }
  }

  // Restore tree from sha
  await git(input.projectDir, ["checkout", input.sha, "--", "."], env);
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
  // Skip the commit if there were no actual changes (e.g., reverting to the
  // tip itself).
  const status = await git(input.projectDir, ["status", "--porcelain"], env);
  if (!status.stdout.trim()) {
    log.info("revert is a no-op (already at target tree)", {
      projectId: input.project.id,
      sha: input.sha,
    });
    return;
  }

  await git(
    input.projectDir,
    [
      "-c",
      "user.email=lab@cloudwise.academy",
      "-c",
      "user.name=Cloudwise Lab",
      "commit",
      "-m",
      `Revert to ${input.sha.slice(0, 7)} via Cloudwise Lab`,
    ],
    env
  );
  await git(input.projectDir, ["push", "origin", branch], env);
  log.info("project reverted", {
    projectId: input.project.id,
    sha: input.sha.slice(0, 7),
  });
}

async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
}
