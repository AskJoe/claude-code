import { useEffect, useRef, useState } from "react";
import { api, type GithubStatus } from "../lib/api.ts";

type Props = {
  /** Project the badge is for; used to scope the OAuth flow. */
  projectId: number;
  /** The project's slug — used to suggest the GitHub repo name. */
  projectSlug: string | null;
  /** Currently-open project's repo info (when connected). */
  projectRepo: {
    repoFullName: string | null;
    defaultBranch: string | null;
  } | null;
  onConnectRepoToProject: () => Promise<void> | void;
  /** True while a connect-repo request is in flight. Drives the loading UI. */
  busyConnecting?: boolean;
  /** Last error from a connect-repo attempt; surfaced in the popover. */
  connectError?: string | null;
};

/**
 * Header pill that shows GitHub connection status. When the user has
 * connected their GitHub account AND the current project is linked to a
 * repo, shows the repo full name. Click to open a popover with details.
 *
 * Modeled after Lovable's GitHub badge pattern.
 */
export function GitHubBadge({
  projectId,
  projectSlug,
  projectRepo,
  onConnectRepoToProject,
  busyConnecting,
  connectError,
}: Props) {
  const expectedRepoName = projectSlug ? `cloudwise-${projectSlug}` : null;
  const createOnGithubUrl =
    expectedRepoName !== null
      ? `https://github.com/new?name=${encodeURIComponent(
          expectedRepoName
        )}&visibility=private&description=${encodeURIComponent(
          "Cloudwise Lab project"
        )}`
      : "https://github.com/new";
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.githubStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // status === null means /api/github/status hasn't returned yet.
  const configured = status?.configured ?? false;
  const accountConnected = !!status?.connected;
  const repoLinked = !!projectRepo?.repoFullName;

  const badgeClass = !configured
    ? "off"
    : repoLinked
      ? "connected"
      : accountConnected
        ? "ready"
        : "off";

  const label = !configured
    ? "GitHub: setup needed"
    : repoLinked
      ? "Connected"
      : accountConnected
        ? "Connect repo"
        : "Connect GitHub";

  return (
    <div className="gh-badge-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`gh-badge ${badgeClass}`}
        onClick={() => setOpen((o) => !o)}
        title={
          repoLinked
            ? `Connected to ${projectRepo!.repoFullName}`
            : "GitHub"
        }
      >
        <GitHubIcon />
        <span className="gh-badge-label">{label}</span>
      </button>

      {open && (
        <div className="gh-popover">
          <div className="gh-popover-header">
            <span>GitHub</span>
            <span
              className={`gh-pill ${repoLinked ? "ok" : accountConnected ? "neutral" : "off"}`}
            >
              {!configured
                ? "Setup needed"
                : repoLinked
                  ? "Connected"
                  : accountConnected
                    ? "Account linked"
                    : "Not connected"}
            </span>
          </div>

          {!configured && (
            <div className="gh-popover-body">
              <p>
                GitHub App not configured on this server yet. To enable
                connecting projects to private repos, the operator needs to:
              </p>
              <ol className="gh-popover-steps">
                <li>
                  Register a <strong>GitHub App</strong> (not OAuth App) at{" "}
                  <a
                    href="https://github.com/settings/apps/new"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    github.com/settings/apps/new
                  </a>
                  <br />
                  <span className="gh-popover-meta">
                    Callback URL: <code>{window.location.origin}/api/github/callback</code>
                  </span>
                  <br />
                  <span className="gh-popover-meta">
                    ✅ "Request user authorization (OAuth) during installation"
                    <br />
                    ❌ Webhook (uncheck "Active")
                    <br />
                    Repository permissions: <strong>Contents: Read &amp; write</strong>, Metadata: Read
                  </span>
                </li>
                <li>
                  Generate a <strong>private key</strong> (downloads .pem) and a{" "}
                  <strong>client secret</strong>. Save the .pem file to{" "}
                  <code>cloudwise-lab/secrets/github-app.pem</code>.
                </li>
                <li>
                  Add to <code>cloudwise-lab/.env</code>:
                  <pre className="gh-popover-code">{`LAB_GITHUB_APP_ID=<numeric App ID>
LAB_GITHUB_APP_CLIENT_ID=<Iv23...>
LAB_GITHUB_APP_CLIENT_SECRET=<client secret>
LAB_GITHUB_APP_SLUG=<URL slug, e.g. cloudwise-lab>
LAB_GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app.pem`}</pre>
                </li>
                <li>Restart the dev server.</li>
              </ol>
            </div>
          )}

          {configured && !accountConnected && (
            <div className="gh-popover-body">
              <p>
                Connect your GitHub. We'll auto-create a private repo for this
                project and keep it in sync as you build.
              </p>
              <a
                className="gh-popover-action"
                href={`/api/github/connect?projectId=${projectId}`}
              >
                Sign in with GitHub
              </a>
              <div className="gh-popover-meta" style={{ marginTop: 10 }}>
                On the GitHub install screen, choose <strong>"All repositories"</strong> for the smoothest experience, or pick specific repos if you prefer tighter scope.
              </div>
            </div>
          )}

          {configured && accountConnected && !repoLinked && (
            <div className="gh-popover-body">
              <p>
                Signed in as <code>{status.githubLogin}</code>.{" "}
                {expectedRepoName ? (
                  <>
                    We'll create a private repo named <code>{expectedRepoName}</code> on
                    your GitHub and start auto-saving changes there.
                  </>
                ) : (
                  <>We'll create a private repo on your GitHub and start auto-saving changes there.</>
                )}
              </p>

              {!busyConnecting ? (
                <button
                  type="button"
                  className="gh-popover-action"
                  onClick={() => {
                    // Open GitHub's create-repo page (name + visibility pre-filled)
                    // in a new tab so the user just clicks "Create repository"
                    // there. The lab polls in the background and auto-pushes the
                    // moment the repo exists.
                    window.open(createOnGithubUrl, "_blank", "noopener,noreferrer");
                    onConnectRepoToProject();
                  }}
                >
                  Create + connect a private repo
                </button>
              ) : (
                <div className="gh-popover-waiting">
                  <span className="gh-popover-spinner" aria-hidden />
                  <div>
                    <strong>Waiting for you to create the repo on GitHub…</strong>
                    <div className="gh-popover-meta" style={{ marginTop: 4 }}>
                      A new tab opened with the name + visibility pre-filled. Click <strong>"Create repository"</strong> there. This panel will auto-push and flip to "Connected" within a few seconds.
                    </div>
                  </div>
                </div>
              )}

              {connectError && (
                <div className="gh-popover-error">⚠ {connectError}</div>
              )}
            </div>
          )}

          {configured && accountConnected && repoLinked && projectRepo && (
            <div className="gh-popover-body">
              <a
                href={`https://github.com/${projectRepo.repoFullName}`}
                target="_blank"
                rel="noreferrer noopener"
                className="gh-popover-link"
              >
                <code>{projectRepo.repoFullName}</code> ↗
              </a>
              <div className="gh-popover-meta">
                Branch: <code>{projectRepo.defaultBranch ?? "main"}</code>
                <span className="gh-popover-dot" />
                Auto-syncing
              </div>
              <div className="gh-popover-foot">
                Signed in as <code>{status.githubLogin}</code>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
