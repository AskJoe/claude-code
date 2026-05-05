/**
 * Tiny fetch wrapper for the lab's REST endpoints. All requests include
 * cookies; responses are auto-parsed; errors throw with the server-provided
 * message when present.
 */

export type Me = {
  user: {
    id: number;
    email: string;
    displayName: string | null;
    isAdmin: boolean;
  } | null;
  requireAuth: boolean;
  githubOauthConfigured: boolean;
};

export type AdminUser = {
  id: number;
  email: string;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string;
  isAdmin: boolean;
  disabled: boolean;
  budgetOverrideUsd: number | null;
  projectCount: number;
  totalCostUsd: number;
  hasGithub: boolean;
};

export type AdminProject = {
  id: number;
  userId: number;
  slug: string;
  displayName: string;
  createdAt: string;
  lastActiveAt: string;
  github: {
    connected: boolean;
    repoFullName: string | null;
    defaultBranch: string | null;
  };
};

export type AdminMessage = {
  id: number;
  project_id: number;
  role: string;
  content_json: string;
  cost_usd: number | null;
  created_at: string;
};

export type AdminMetrics = {
  totalUsers: number;
  totalProjects: number;
  activeLast7d: number;
  totalCostUsd: number;
  costLast24hUsd: number;
  signupsByDay: Array<{ day: string; count: number }>;
  topSpenders: Array<{ userId: number; email: string; turns: number; costUsd: number }>;
};

export type LabSettings = {
  defaultModel: string;
  defaultBudgetUsd: number;
  rateLimitPerMinute: number;
};

export type CommitSummary = {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string | null;
  committedAt: string;
  htmlUrl: string;
  isPublished: boolean;
};

export type PublishStatus = {
  aheadBy: number;
  behindBy: number;
  hasUnpublished: boolean;
  mainSha: string | null;
  workingSha: string | null;
};

export type ProjectSummary = {
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

export type GithubStatus = {
  configured: boolean;
  connected: boolean;
  githubLogin: string | null;
  connectedAt?: string | null;
  installationId?: number | null;
};

export type ChatSessionSummary = {
  id: number;
  title: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  totalCostUsd: number;
  archived: boolean;
};

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    ...init,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  me: () => request<Me>("/api/me"),

  signup: (email: string, password: string, displayName?: string) =>
    request<{ user: Me["user"] }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName }),
    }),

  signin: (email: string, password: string) =>
    request<{ user: Me["user"] }>("/api/auth/signin", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () =>
    request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  // GitHub connection (Phase 13.4)
  githubStatus: () => request<GithubStatus>("/api/github/status"),

  githubDisconnect: () =>
    request<{ ok: true }>("/api/github/disconnect", { method: "POST" }),

  // Chat sessions sidebar (Phase 4.1)
  listChatSessions: (projectId: number) =>
    request<{ sessions: ChatSessionSummary[] }>(
      `/api/projects/${projectId}/chat-sessions`
    ),

  getChatSessionMessages: (projectId: number, sessionId: number) =>
    request<{
      session: ChatSessionSummary;
      messages: Array<Record<string, unknown>>;
    }>(`/api/projects/${projectId}/chat-sessions/${sessionId}/messages`),

  // Settings panel — profile + system prompt.
  updateProfile: ({ displayName }: { displayName: string }) =>
    request<{ user: Me["user"] }>("/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }),

  getSystemPrompt: () =>
    request<{ systemPrompt: string | null }>("/api/me/system-prompt"),

  updateSystemPrompt: ({ systemPrompt }: { systemPrompt: string | null }) =>
    request<{ ok: true; systemPrompt: string | null }>(
      "/api/me/system-prompt",
      {
        method: "PATCH",
        body: JSON.stringify({ systemPrompt }),
      }
    ),

  listProjects: () => request<{ projects: ProjectSummary[] }>("/api/projects"),

  createProject: (displayName: string) =>
    request<{ project: ProjectSummary }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    }),

  renameProject: (id: number, displayName: string) =>
    request<{ ok: true }>(`/api/projects/${id}/rename`, {
      method: "POST",
      body: JSON.stringify({ displayName }),
    }),

  deleteProject: (id: number) =>
    request<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),

  githubStatus: () => request<GithubStatus>("/api/github/status"),

  githubDisconnect: () =>
    request<{ ok: true }>("/api/github/disconnect", { method: "POST" }),

  renderPrepareDeploy: (projectId: number) =>
    request<{ ok: true; deployUrl: string; predictedSiteUrl: string }>(
      `/api/projects/${projectId}/render/prepare-deploy`,
      { method: "POST" }
    ),

  renderConfirmDeployed: (projectId: number, siteUrl?: string) =>
    request<{ ok: true; siteUrl: string }>(
      `/api/projects/${projectId}/render/confirm-deployed`,
      {
        method: "POST",
        body: JSON.stringify(siteUrl ? { siteUrl } : {}),
      }
    ),

  renderProbe: (projectId: number) =>
    request<{ live: boolean; status: number; url: string | null }>(
      `/api/projects/${projectId}/render/probe`
    ),

  listCommits: (projectId: number) =>
    request<{ commits: CommitSummary[] }>(`/api/projects/${projectId}/commits`),

  revertCommit: (projectId: number, sha: string) =>
    request<{ ok: true }>(
      `/api/projects/${projectId}/commits/${sha}/revert`,
      { method: "POST" }
    ),

  publishStatus: (projectId: number) =>
    request<{ status: PublishStatus }>(
      `/api/projects/${projectId}/publish-status`
    ),

  publishPromote: (projectId: number) =>
    request<{ ok: true; promotedSha: string }>(
      `/api/projects/${projectId}/publish-promote`,
      { method: "POST" }
    ),

  // ── Admin ──────────────────────────────────────────────────────────────

  adminListUsers: () =>
    request<{ users: AdminUser[] }>("/api/admin/users"),

  adminGetUser: (id: number) =>
    request<{ user: AdminUser }>(`/api/admin/users/${id}`),

  adminUpdateUser: (
    id: number,
    patch: {
      isAdmin?: boolean;
      disabled?: boolean;
      budgetOverrideUsd?: number | null;
      displayName?: string | null;
    }
  ) =>
    request<{ user: AdminUser }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  adminDeleteUser: (id: number) =>
    request<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),

  adminResetPassword: (id: number) =>
    request<{ ok: true; newPassword: string }>(
      `/api/admin/users/${id}/reset-password`,
      { method: "POST" }
    ),

  adminListUserProjects: (userId: number) =>
    request<{ projects: AdminProject[] }>(`/api/admin/users/${userId}/projects`),

  adminGetProject: (id: number) =>
    request<{ project: AdminProject; owner: AdminUser | null }>(
      `/api/admin/projects/${id}`
    ),

  adminGetMessages: (projectId: number, limit = 1000) =>
    request<{ messages: AdminMessage[] }>(
      `/api/admin/projects/${projectId}/messages?limit=${limit}`
    ),

  adminMetrics: () =>
    request<{ metrics: AdminMetrics }>("/api/admin/metrics"),

  adminGetSettings: () =>
    request<{ settings: LabSettings }>("/api/admin/settings"),

  adminUpdateSettings: (patch: Partial<LabSettings>) =>
    request<{ settings: LabSettings }>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  restartBuilder: (projectId: number) =>
    request<{ ok: boolean; reason?: string }>(
      `/api/projects/${projectId}/builder/restart`,
      { method: "POST" }
    ),
};

/**
 * URL helper for transcript export. The command palette (and any direct
 * download buttons) use this with `window.location.href = exportSessionUrl(...)`
 * so the browser respects the server's Content-Disposition: attachment header.
 */
export function exportSessionUrl(
  projectId: number,
  sessionId: string,
  format: "markdown" | "html" | "json"
): string {
  return `/api/projects/${projectId}/sessions/${sessionId}/export?format=${format}`;
}
