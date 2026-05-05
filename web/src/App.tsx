import { useEffect, useMemo, useState } from "react";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { CodeView } from "./components/CodeView.tsx";
import { PreviewPane } from "./components/PreviewPane.tsx";
import { GitHubBadge } from "./components/GitHubBadge.tsx";
import { ProjectList } from "./components/ProjectList.tsx";
import { PublishButton } from "./components/PublishButton.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { AdminPage, type AdminTab } from "./components/AdminPage.tsx";
import { AdminProjectView } from "./components/AdminProjectView.tsx";
import { EditModeToggle } from "./components/EditModeToggle.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";
import { useLabSession, type LabMode } from "./lib/useLabSession.ts";

function loadAgentMode(projectId: number): LabMode {
  try {
    const v = localStorage.getItem(`lab.agentMode.${projectId}`);
    return v === "plan" ? "plan" : "code";
  } catch {
    return "code";
  }
}
import { api, type Me, type ProjectSummary } from "./lib/api.ts";

type Route =
  | { kind: "list" }
  | { kind: "project"; id: number }
  | { kind: "admin"; tab: AdminTab }
  | { kind: "admin-project"; id: number };

function parseHash(): Route {
  const h = location.hash.replace(/^#/, "") || "/";
  const adminProj = /^\/admin\/p\/(\d+)$/.exec(h);
  if (adminProj) return { kind: "admin-project", id: Number(adminProj[1]) };
  const adminTab = /^\/admin(?:\/(users|metrics|settings))?$/.exec(h);
  if (adminTab) {
    const tab = (adminTab[1] as AdminTab | undefined) ?? "users";
    return { kind: "admin", tab };
  }
  const m = /^\/p\/(\d+)$/.exec(h);
  if (m) return { kind: "project", id: Number(m[1]) };
  return { kind: "list" };
}

function navigate(to: string) {
  if (location.hash === `#${to}`) return;
  location.hash = to;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe({ user: null, requireAuth: true, githubOauthConfigured: false }));
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (me === null) return <div className="boot-loader">Loading…</div>;

  if (me.requireAuth && !me.user) {
    return <SignIn onSignedIn={() => api.me().then(setMe)} />;
  }

  if (route.kind === "admin" && me.user?.isAdmin) {
    return (
      <AdminPage
        tab={route.tab}
        onTab={(t) => navigate(`/admin/${t}`)}
        onExit={() => navigate("/")}
        onOpenAdminProject={(pid) => navigate(`/admin/p/${pid}`)}
      />
    );
  }

  if (route.kind === "admin-project" && me.user?.isAdmin) {
    return (
      <AdminProjectView
        projectId={route.id}
        onExit={() => navigate("/admin/users")}
      />
    );
  }

  // Hitting an admin route as a non-admin → fall through to project list.

  if (route.kind === "list" || route.kind === "admin" || route.kind === "admin-project") {
    return (
      <ProjectList
        user={{
          email: me.user?.email ?? "anonymous",
          displayName: me.user?.displayName ?? null,
          isAdmin: me.user?.isAdmin ?? false,
        }}
        onOpen={(id) => navigate(`/p/${id}`)}
        onOpenAdmin={() => navigate("/admin/users")}
        onLogout={async () => {
          await api.logout();
          setMe(await api.me());
        }}
      />
    );
  }

  return (
    <Lab
      projectId={route.id}
      isAdmin={me.user?.isAdmin ?? false}
      onExit={() => navigate("/")}
      onOpenAdmin={() => navigate("/admin/users")}
    />
  );
}

type RightView = "preview" | "code";

function Lab({
  projectId,
  isAdmin,
  onExit,
  onOpenAdmin,
}: {
  projectId: number;
  isAdmin: boolean;
  onExit: () => void;
  onOpenAdmin: () => void;
}) {
  const [agentMode, setAgentMode] = useState<LabMode>(() => loadAgentMode(projectId));

  // Persist the agent-mode choice per project so reopening keeps the
  // same posture (plan vs code).
  useEffect(() => {
    try {
      localStorage.setItem(`lab.agentMode.${projectId}`, agentMode);
    } catch {}
  }, [agentMode, projectId]);

  const lab = useLabSession(projectId, { mode: agentMode });
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [rightView, setRightView] = useState<RightView>("preview");
  const [busyConnectingRepo, setBusyConnectingRepo] = useState(false);
  const [connectRepoError, setConnectRepoError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    api
      .listProjects()
      .then(({ projects }) => {
        setProject(projects.find((p) => p.id === projectId) ?? null);
      })
      .catch(() => setProject(null));
  }, [projectId]);

  // Iframe reload key: bump on every build transition so the preview
  // refreshes both when the build starts (→ shows server's "Building…" page)
  // and when it finishes (→ shows the fresh dist/index.html).
  const reloadKey = useMemo(
    () => `${lab.build.status}-${lab.build.lastBuildAt ?? 0}`,
    [lab.build.status, lab.build.lastBuildAt]
  );

  const refreshProject = async () => {
    const { projects } = await api.listProjects();
    setProject(projects.find((p) => p.id === projectId) ?? null);
  };

  // Broadcast edit-mode state into the preview iframe whenever it toggles.
  useEffect(() => {
    document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "lab:edit-mode", on: editMode },
          "*"
        );
      } catch {}
    });
  }, [editMode]);

  // Listen for messages from the preview iframe:
  //   - lab:edit-mode-toggle  → user pressed Cmd+E inside the iframe; flip our state
  //   - lab:edit-text         → user saved an inline edit; route it to the agent
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "lab:edit-mode-toggle") {
        setEditMode((m) => !m);
        return;
      }
      if (data.type === "lab:edit-text") {
        const oldText = String(data.oldText ?? "").trim();
        const newText = String(data.newText ?? "").trim();
        if (!oldText || !newText || oldText === newText) return;
        const tag = String(data.elementTag ?? "").trim();
        const cls = String(data.elementClass ?? "").trim();
        const ctx = tag
          ? `It's inside a <${tag}${cls ? ` class="${cls}"` : ""}> element.`
          : "";
        const prompt =
          `In the project source under \`src/\`, change the text "${oldText}" to "${newText}". ` +
          `${ctx} Find the matching source file (likely src/pages/, src/components/, or src/layouts/) ` +
          `and update only that occurrence — don't change anything else.`;
        lab.send(prompt);
        return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [lab]);

  // Cmd/Ctrl+E at the lab level toggles edit mode (works even when the
  // iframe doesn't have focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "e" || e.key === "E")) {
        // Only when we're on a project with a preview, not while typing in
        // the chat textarea.
        const tag = (e.target as HTMLElement | null)?.tagName ?? "";
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        e.preventDefault();
        setEditMode((m) => !m);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="layout">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="brand brand-link" onClick={onExit}>
            ← Cloudwise Lab
          </button>
          {project && <span className="topbar-project">{project.displayName}</span>}
          <div className="view-toggle" role="tablist" aria-label="Agent mode">
            <button
              type="button"
              role="tab"
              aria-selected={agentMode === "code"}
              className={`view-toggle-btn ${agentMode === "code" ? "active" : ""}`}
              onClick={() => setAgentMode("code")}
              title="Code mode — agent has full toolkit and can modify files"
            >
              <BoltIcon />
              Code
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={agentMode === "plan"}
              className={`view-toggle-btn ${agentMode === "plan" ? "active" : ""}`}
              onClick={() => setAgentMode("plan")}
              title="Plan mode — agent can read, search, and propose, but won't change files. Switching reconnects the chat."
            >
              <PlanIcon />
              Plan
            </button>
          </div>
          <div className="view-toggle" role="tablist" aria-label="Right pane view">
            <button
              type="button"
              role="tab"
              aria-selected={rightView === "preview"}
              className={`view-toggle-btn ${rightView === "preview" ? "active" : ""}`}
              onClick={() => setRightView("preview")}
              title="Show the rendered site"
            >
              <PreviewIcon />
              Preview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightView === "code"}
              className={`view-toggle-btn ${rightView === "code" ? "active" : ""}`}
              onClick={() => setRightView("code")}
              title="Show the source files"
            >
              <CodeIcon />
              Source
            </button>
          </div>
        </div>
        <div className="topbar-meta">
          {isAdmin && (
            <button
              type="button"
              className="topbar-admin-link"
              onClick={onOpenAdmin}
              title="Admin area"
            >
              ⚙ Admin
            </button>
          )}
          <EditModeToggle on={editMode} onToggle={() => setEditMode((m) => !m)} />
          {project?.github.connected && (
            <button
              type="button"
              className="topbar-admin-link"
              onClick={() => setHistoryOpen(true)}
              title="View commit history"
            >
              ⏱ History
            </button>
          )}
          <PublishButton
            project={project}
            lastFilesChangedAt={lab.lastFilesChangedAt}
            onSiteUrlSet={refreshProject}
          />
          <GitHubBadge
            projectId={projectId}
            projectSlug={project?.slug ?? null}
            projectRepo={
              project?.github.connected
                ? {
                    repoFullName: project.github.repoFullName,
                    defaultBranch: project.github.defaultBranch,
                  }
                : null
            }
            busyConnecting={busyConnectingRepo}
            connectError={connectRepoError}
            onConnectRepoToProject={async () => {
              // Single-click flow: open GitHub's create-repo page in a new tab,
              // then poll our backend until the user has created the repo —
              // backend auto-pushes the moment it exists. Caps at 5 minutes.
              setBusyConnectingRepo(true);
              setConnectRepoError(null);

              const startedAt = Date.now();
              const TIMEOUT_MS = 5 * 60 * 1000;
              const POLL_MS = 3000;

              const tryConnect = async (): Promise<boolean> => {
                const res = await fetch(
                  `/api/projects/${projectId}/github/connect-repo`,
                  { method: "POST", credentials: "same-origin" }
                );
                if (!res.ok) {
                  const body = await res.json().catch(() => null);
                  throw new Error(
                    body?.error ?? `${res.status} ${res.statusText}`
                  );
                }
                const body = (await res.json()) as { ready: boolean };
                return body.ready;
              };

              const loop = async () => {
                try {
                  const ready = await tryConnect();
                  if (ready) {
                    await refreshProject();
                    setBusyConnectingRepo(false);
                    return;
                  }
                  if (Date.now() - startedAt > TIMEOUT_MS) {
                    setConnectRepoError(
                      "Timed out waiting for the repo to appear. If you created it, click 'Create + connect' again to retry."
                    );
                    setBusyConnectingRepo(false);
                    return;
                  }
                  setTimeout(loop, POLL_MS);
                } catch (err: any) {
                  setConnectRepoError(err?.message ?? String(err));
                  setBusyConnectingRepo(false);
                }
              };

              loop();
            }}
          />
        </div>
      </header>

      <main className="panes panes-2">
        <section className="pane pane-chat">
          <ChatPanel
            status={lab.status}
            chat={lab.chat}
            cumulativeCostUsd={lab.cumulativeCostUsd}
            budgetUsd={lab.budgetUsd}
            onSend={lab.send}
            onAbort={lab.abort}
            onReset={lab.reset}
          />
        </section>
        <section className="pane pane-right">
          {rightView === "preview" ? (
            <PreviewPane previewBase={lab.previewBase} reloadKey={reloadKey} />
          ) : (
            <CodeView files={lab.files} previewBase={lab.previewBase} />
          )}
        </section>
      </main>
      <HistoryPanel
        projectId={projectId}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onAfterRevert={refreshProject}
      />
    </div>
  );
}

function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 1L2 9h5l-1 6 7-8H8l1-6z" />
    </svg>
  );
}

function PlanIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="2" width="11" height="12" rx="1.5" />
      <path d="M5 5h6M5 8h6M5 11h4" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 3C4.5 3 1.7 5.2 1 8c.7 2.8 3.5 5 7 5s6.3-2.2 7-5c-.7-2.8-3.5-5-7-5zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 4 2 8 6 12" />
      <polyline points="10 4 14 8 10 12" />
    </svg>
  );
}
