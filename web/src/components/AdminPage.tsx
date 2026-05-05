import { AdminMetrics } from "./AdminMetrics.tsx";
import { AdminSettings } from "./AdminSettings.tsx";
import { AdminUsers } from "./AdminUsers.tsx";

export type AdminTab = "users" | "metrics" | "settings";

type Props = {
  tab: AdminTab;
  onTab: (t: AdminTab) => void;
  onExit: () => void;
  onOpenAdminProject: (projectId: number) => void;
};

export function AdminPage({ tab, onTab, onExit, onOpenAdminProject }: Props) {
  return (
    <div className="admin">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="brand brand-link" onClick={onExit}>
            ← Cloudwise Lab
          </button>
          <span className="topbar-project">Admin</span>
          <div className="view-toggle" role="tablist" aria-label="Admin tabs">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "users"}
              className={`view-toggle-btn ${tab === "users" ? "active" : ""}`}
              onClick={() => onTab("users")}
            >
              Users
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "metrics"}
              className={`view-toggle-btn ${tab === "metrics" ? "active" : ""}`}
              onClick={() => onTab("metrics")}
            >
              Metrics
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "settings"}
              className={`view-toggle-btn ${tab === "settings" ? "active" : ""}`}
              onClick={() => onTab("settings")}
            >
              Settings
            </button>
          </div>
        </div>
        <div className="topbar-meta" />
      </header>

      <main className="admin-body">
        {tab === "users" && <AdminUsers onOpenProject={onOpenAdminProject} />}
        {tab === "metrics" && <AdminMetrics />}
        {tab === "settings" && <AdminSettings />}
      </main>
    </div>
  );
}
