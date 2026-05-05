import { useEffect, useState } from "react";
import { api, type AdminProject, type AdminUser } from "../lib/api.ts";

type Props = {
  onOpenProject: (projectId: number) => void;
};

export function AdminUsers({ onOpenProject }: Props) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = async () => {
    try {
      const { users } = await api.adminListUsers();
      setUsers(users);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = (users ?? []).filter((u) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      u.email.toLowerCase().includes(s) ||
      (u.displayName ?? "").toLowerCase().includes(s)
    );
  });

  const selected = users?.find((u) => u.id === selectedId) ?? null;

  return (
    <div className="admin-users">
      <div className="admin-users-list">
        <div className="admin-users-toolbar">
          <input
            type="search"
            placeholder="Search by email or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" className="link-button" onClick={load}>
            Refresh
          </button>
        </div>
        {error && <div className="admin-error">⚠ {error}</div>}
        {users === null && !error && <div className="admin-empty">Loading…</div>}
        {users !== null && filtered.length === 0 && (
          <div className="admin-empty">No users match.</div>
        )}
        {filtered.length > 0 && (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Signed up</th>
                <th>Last login</th>
                <th className="num">Projects</th>
                <th className="num">Cost</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr
                  key={u.id}
                  className={selectedId === u.id ? "selected" : ""}
                  onClick={() => setSelectedId(u.id)}
                >
                  <td className="mono">{u.email}</td>
                  <td>{u.displayName ?? "—"}</td>
                  <td className="dim">{fmtDate(u.createdAt)}</td>
                  <td className="dim">{fmtDate(u.lastLoginAt)}</td>
                  <td className="num">{u.projectCount}</td>
                  <td className="num">${u.totalCostUsd.toFixed(2)}</td>
                  <td>
                    {u.isAdmin && <span className="pill ok">admin</span>}
                    {u.disabled && <span className="pill err">disabled</span>}
                    {u.hasGithub && <span className="pill">gh</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <aside className="admin-detail">
        {selected ? (
          <UserDetail
            user={selected}
            onChange={async () => {
              await load();
            }}
            onOpenProject={onOpenProject}
          />
        ) : (
          <div className="admin-empty">Select a user to manage</div>
        )}
      </aside>
    </div>
  );
}

function UserDetail({
  user,
  onChange,
  onOpenProject,
}: {
  user: AdminUser;
  onChange: () => Promise<void>;
  onOpenProject: (projectId: number) => void;
}) {
  const [projects, setProjects] = useState<AdminProject[] | null>(null);
  const [pwResult, setPwResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [budgetText, setBudgetText] = useState(
    user.budgetOverrideUsd != null ? String(user.budgetOverrideUsd) : ""
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBudgetText(
      user.budgetOverrideUsd != null ? String(user.budgetOverrideUsd) : ""
    );
    setPwResult(null);
    setConfirmDel(false);
    setError(null);
    api
      .adminListUserProjects(user.id)
      .then(({ projects }) => setProjects(projects))
      .catch((err) => setError(err?.message ?? String(err)));
  }, [user.id]);

  const wrap = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChange();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="user-detail">
      <h2 className="user-detail-email">{user.email}</h2>
      <div className="user-detail-meta">
        {user.displayName && <span>{user.displayName}</span>}
        <span className="dim">id={user.id}</span>
        {user.isAdmin && <span className="pill ok">admin</span>}
        {user.disabled && <span className="pill err">disabled</span>}
        {user.hasGithub && <span className="pill">github</span>}
      </div>

      {error && <div className="admin-error">⚠ {error}</div>}

      <div className="user-detail-section">
        <h3>Account</h3>
        <div className="user-detail-row">
          <label>Display name</label>
          <input
            type="text"
            defaultValue={user.displayName ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === (user.displayName ?? "")) return;
              wrap(() =>
                api.adminUpdateUser(user.id, { displayName: v || null })
              );
            }}
            disabled={busy}
          />
        </div>

        <div className="user-detail-row">
          <label>Budget override (USD per session)</label>
          <div className="user-detail-budget">
            <input
              type="number"
              step="0.05"
              min="0.05"
              placeholder="(use lab default)"
              value={budgetText}
              onChange={(e) => setBudgetText(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => {
                const trimmed = budgetText.trim();
                if (trimmed === "") {
                  wrap(() =>
                    api.adminUpdateUser(user.id, { budgetOverrideUsd: null })
                  );
                  return;
                }
                const num = Number(trimmed);
                if (!Number.isFinite(num) || num <= 0) {
                  setError("Budget must be a positive number");
                  return;
                }
                wrap(() =>
                  api.adminUpdateUser(user.id, { budgetOverrideUsd: num })
                );
              }}
              disabled={busy}
            >
              Save
            </button>
          </div>
        </div>

        <div className="user-detail-row toggle-row">
          <label>
            <input
              type="checkbox"
              checked={user.isAdmin}
              onChange={(e) =>
                wrap(() =>
                  api.adminUpdateUser(user.id, { isAdmin: e.target.checked })
                )
              }
              disabled={busy}
            />
            Admin
          </label>
          <label>
            <input
              type="checkbox"
              checked={user.disabled}
              onChange={(e) =>
                wrap(() =>
                  api.adminUpdateUser(user.id, { disabled: e.target.checked })
                )
              }
              disabled={busy}
            />
            Disabled (blocks sign-in)
          </label>
        </div>
      </div>

      <div className="user-detail-section">
        <h3>Password</h3>
        {pwResult ? (
          <div className="admin-pw-result">
            <div>New password (copy this — it won't be shown again):</div>
            <code className="admin-pw-value">{pwResult}</code>
            <button
              type="button"
              className="link-button"
              onClick={() => setPwResult(null)}
            >
              Dismiss
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="admin-secondary-btn"
            onClick={() =>
              wrap(async () => {
                const { newPassword } = await api.adminResetPassword(user.id);
                setPwResult(newPassword);
              })
            }
            disabled={busy}
          >
            Reset password
          </button>
        )}
      </div>

      <div className="user-detail-section">
        <h3>Projects ({user.projectCount})</h3>
        {projects === null ? (
          <div className="admin-empty">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="admin-empty">No projects.</div>
        ) : (
          <ul className="user-detail-projects">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onOpenProject(p.id)}
                >
                  {p.displayName}
                </button>
                <span className="dim mono"> {p.slug}</span>
                {p.github.connected && (
                  <span className="pill ok">github</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="user-detail-section danger">
        <h3>Danger zone</h3>
        {!confirmDel ? (
          <button
            type="button"
            className="admin-danger-btn"
            onClick={() => setConfirmDel(true)}
            disabled={busy}
          >
            Delete user
          </button>
        ) : (
          <div className="user-detail-confirm">
            <span>Removes the user, all their projects, files, and chats. Cannot be undone.</span>
            <div className="user-detail-confirm-actions">
              <button
                type="button"
                className="admin-danger-btn"
                onClick={() =>
                  wrap(async () => {
                    await api.adminDeleteUser(user.id);
                    setConfirmDel(false);
                  })
                }
                disabled={busy}
              >
                Confirm delete
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => setConfirmDel(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "2-digit",
    month: "short",
    day: "numeric",
  });
}
