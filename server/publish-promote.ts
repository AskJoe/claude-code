/**
 * Promote work from the cloudwise-lab branch to main.
 *
 * This is what "Publish" does on every click after the initial Render
 * setup: fast-forward main to whatever cloudwise-lab currently points at,
 * push main, and let Render's GitHub webhook fire one rebuild for the public
 * site.
 *
 * `getPublishStatus` answers "are there changes ready to publish?" via the
 * GitHub compare API — used by the publish button to enable/disable itself.
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

export type PublishStatus = {
  /** Commits on cloudwise-lab not yet on main. > 0 means publishable. */
  aheadBy: number;
  /** Commits on main not on cloudwise-lab. > 0 means main has diverged. */
  behindBy: number;
  /** True when ready to publish. */
  hasUnpublished: boolean;
  /** sha of main's current HEAD (the published commit). null if main doesn't exist yet. */
  mainSha: string | null;
  /** sha of cloudwise-lab's current HEAD. */
  workingSha: string | null;
};

async function getInstallationToken(installationId: number): Promise<string> {
  const { appId, privateKey } = getAppCredentials();
  const auth = createAppAuth({ appId, privateKey });
  const r = await auth({ type: "installation", installationId });
  return (r as any).token as string;
}

export async function getPublishStatus(input: {
  project: ProjectRow;
  installationId: number;
}): Promise<PublishStatus> {
  const repoFullName = input.project.github_repo_full_name;
  if (!repoFullName) {
    return {
      aheadBy: 0,
      behindBy: 0,
      hasUnpublished: false,
      mainSha: null,
      workingSha: null,
    };
  }
  const [owner, repo] = repoFullName.split("/");
  const main = input.project.github_default_branch ?? "main";
  const token = await getInstallationToken(input.installationId);
  const octo = new Octokit({ auth: token });

  try {
    const { data } = await octo.request(
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      {
        owner,
        repo,
        basehead: `${main}...${WORKING_BRANCH}`,
      }
    );
    return {
      aheadBy: data.ahead_by,
      behindBy: data.behind_by,
      hasUnpublished: data.ahead_by > 0,
      mainSha: data.base_commit?.sha ?? null,
      workingSha: data.merge_base_commit?.sha
        ? data.commits?.[data.commits.length - 1]?.sha ?? data.merge_base_commit.sha
        : null,
    };
  } catch (err: any) {
    if (err.status === 404) {
      // One of the branches might not exist yet (e.g., before first connect
      // is fully done). Treat as in-sync — there's nothing to publish.
      return {
        aheadBy: 0,
        behindBy: 0,
        hasUnpublished: false,
        mainSha: null,
        workingSha: null,
      };
    }
    throw err;
  }
}

export async function publishPromote(input: {
  project: ProjectRow;
  installationId: number;
  projectDir: string;
}): Promise<{ promotedSha: string }> {
  const repoFullName = input.project.github_repo_full_name;
  if (!repoFullName) throw new Error("project has no GitHub repo");

  const main = input.project.github_default_branch ?? "main";
  const token = await getInstallationToken(input.installationId);
  const remoteUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  // Refresh both branches from origin.
  await git(input.projectDir, ["remote", "set-url", "origin", remoteUrl], env);
  try {
    await git(input.projectDir, ["fetch", "origin", main, WORKING_BRANCH], env);
  } catch (err) {
    log.warn("fetch before promote failed (continuing)", {
      err: (err as Error).message,
    });
  }

  // Resolve the working branch's tip — that's what we want main to point at.
  const workingTip = (
    await git(input.projectDir, ["rev-parse", `origin/${WORKING_BRANCH}`], env)
  ).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(workingTip)) {
    throw new Error("could not resolve working branch tip");
  }

  // Use GitHub's git refs API to fast-forward the remote main directly. This
  // is cleaner than a local checkout dance: no working-tree manipulation, no
  // conflict with the chokidar watcher, no risk of leaving the local repo
  // in a weird state.
  const { Octokit } = await import("@octokit/rest");
  const octo = new Octokit({ auth: token });
  const [owner, repo] = repoFullName.split("/");

  try {
    await octo.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${main}`,
      sha: workingTip,
      // force=false → only fast-forwards. If main has diverged, this 422s.
      force: false,
    });
  } catch (err: any) {
    if (err.status === 422) {
      throw new Error(
        `Cannot publish: ${main} has changes that aren't on the working branch. ` +
          `Resolve on github.com or open History and revert.`
      );
    }
    throw err;
  }

  log.info("promoted to main", {
    projectId: input.project.id,
    main,
    sha: workingTip.slice(0, 7),
  });
  return { promotedSha: workingTip };
}

async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
}
