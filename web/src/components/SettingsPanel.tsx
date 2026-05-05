/**
 * Global Settings panel — modal opened by ⌘, (or via the topbar gear button
 * or the command palette). Six tabs: General / Agent / System prompt /
 * Keybindings / Notifications / Data.
 *
 * Most tabs persist to `localStorage` under `lab.*` keys. Profile name and
 * system prompt go to the user row in DB via `api.updateProfile` and
 * `api.updateSystemPrompt`.
 */

import { useEffect, useRef, useState } from "react";
import { useTheme, type ThemeChoice } from "../lib/useTheme.ts";
import { SHORTCUTS, SHORTCUT_GROUPS } from "../lib/shortcuts.ts";
import { api, type Me } from "../lib/api.ts";

type Tab =
  | "general"
  | "agent"
  | "system-prompt"
  | "keybindings"
  | "notifications"
  | "data";

type Props = {
  open: boolean;
  onClose: () => void;
  me: Me;
  onMeUpdated: (me: Me) => void;
};

export function SettingsPanel({ open, onClose, me, onMeUpdated }: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const theme = useTheme();

  // Esc and ⌘W close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="settings-backdrop"
      onMouseDown={onClose}
      role="dialog"
      aria-modal
    >
      <div
        className="settings-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-tabs" aria-label="Settings sections">
          <TabBtn id="general" active={tab} onClick={setTab}>
            General
          </TabBtn>
          <TabBtn id="agent" active={tab} onClick={setTab}>
            Agent
          </TabBtn>
          <TabBtn id="system-prompt" active={tab} onClick={setTab}>
            System prompt
          </TabBtn>
          <TabBtn id="keybindings" active={tab} onClick={setTab}>
            Keybindings
          </TabBtn>
          <TabBtn id="notifications" active={tab} onClick={setTab}>
            Notifications
          </TabBtn>
          <TabBtn id="data" active={tab} onClick={setTab}>
            Data
          </TabBtn>
        </nav>
        <div className="settings-content">
          {tab === "general" && (
            <GeneralTab me={me} onMeUpdated={onMeUpdated} theme={theme} />
          )}
          {tab === "agent" && <AgentTab />}
          {tab === "system-prompt" && <SystemPromptTab />}
          {tab === "keybindings" && <KeybindingsTab />}
          {tab === "notifications" && <NotificationsTab />}
          {tab === "data" && <DataTab />}
        </div>
        <button
          type="button"
          className="settings-close"
          onClick={onClose}
          aria-label="Close settings"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function TabBtn({
  id,
  active,
  onClick,
  children,
}: {
  id: Tab;
  active: Tab;
  onClick: (id: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`settings-tab${active === id ? " active" : ""}`}
      onClick={() => onClick(id)}
    >
      {children}
    </button>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────

function GeneralTab({
  me,
  onMeUpdated,
  theme,
}: {
  me: Me;
  onMeUpdated: (me: Me) => void;
  theme: ReturnType<typeof useTheme>;
}) {
  const [name, setName] = useState<string>(me.user?.displayName ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const saveName = async () => {
    if ((me.user?.displayName ?? "") === name.trim()) return;
    try {
      await api.updateProfile({ displayName: name });
      const fresh = await api.me();
      onMeUpdated(fresh);
      setSavedAt(Date.now());
    } catch {}
  };

  const showSaved = savedAt !== null && Date.now() - savedAt < 2000;

  return (
    <>
      <h2 className="settings-section-title">General</h2>
      <div className="settings-row">
        <label htmlFor="settings-displayname">Display name</label>
        <div>
          <input
            id="settings-displayname"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            placeholder={me.user?.email ?? ""}
          />
          {showSaved && <span className="settings-saved-pill">Saved</span>}
        </div>
      </div>

      <div className="settings-row">
        <label>Theme</label>
        <div className="settings-radio-group">
          {(["light", "dark", "system"] as ThemeChoice[]).map((t) => (
            <label key={t} className="settings-radio">
              <input
                type="radio"
                name="theme"
                checked={theme.choice === t}
                onChange={() => theme.setChoice(t)}
              />
              <span>{t === "system" ? `System (${theme.resolved})` : t}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <label>Language</label>
        <div>
          <select disabled value="en">
            <option value="en">English (en)</option>
          </select>
          <div className="settings-help">More languages coming.</div>
        </div>
      </div>
    </>
  );
}

function useLocalRadio<T extends string>(key: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const r = localStorage.getItem(key);
      return (r ?? def) as T;
    } catch {
      return def;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {}
  };
  return [v, set];
}

function useLocalBool(key: string, def: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => {
    try {
      const r = localStorage.getItem(key);
      if (r === null) return def;
      return r === "true";
    } catch {
      return def;
    }
  });
  const set = (next: boolean) => {
    setV(next);
    try {
      localStorage.setItem(key, next ? "true" : "false");
    } catch {}
  };
  return [v, set];
}

function AgentTab() {
  const [model, setModel] = useLocalRadio<"sonnet-4.6" | "opus-4.7" | "haiku">(
    "lab.modelPreference",
    "sonnet-4.6"
  );
  const [showReasoning, setShowReasoning] = useLocalBool(
    "lab.showReasoning",
    false
  );
  const [outputStyle, setOutputStyle] = useLocalRadio<
    "plain" | "colors" | "emojis"
  >("lab.outputStyle", "plain");
  const [permissionMode, setPermissionMode] = useLocalRadio<
    "auto" | "bash-only" | "all"
  >("lab.permissionMode", "auto");

  return (
    <>
      <h2 className="settings-section-title">Agent</h2>

      <div className="settings-row">
        <label>Model</label>
        <div>
          <div className="settings-radio-group">
            {(
              [
                ["sonnet-4.6", "Sonnet 4.6"],
                ["opus-4.7", "Opus 4.7"],
                ["haiku", "Haiku"],
              ] as Array<["sonnet-4.6" | "opus-4.7" | "haiku", string]>
            ).map(([id, label]) => (
              <label key={id} className="settings-radio">
                <input
                  type="radio"
                  name="model"
                  checked={model === id}
                  onChange={() => setModel(id)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="settings-help">
            Per-browser preference. The backend default applies to brand-new
            sessions until the change is picked up.
          </div>
        </div>
      </div>

      <div className="settings-row">
        <label>Reasoning</label>
        <div>
          <label className="settings-radio">
            <input
              type="checkbox"
              checked={showReasoning}
              onChange={(e) => setShowReasoning(e.target.checked)}
            />
            <span>Show reasoning blocks when present</span>
          </label>
          <div className="settings-help">
            Off by default. Detection coming in a future release.
          </div>
        </div>
      </div>

      <div className="settings-row">
        <label>Output style</label>
        <div className="settings-radio-group">
          {(
            [
              ["plain", "Plain"],
              ["colors", "Colors"],
              ["emojis", "Emojis"],
            ] as Array<["plain" | "colors" | "emojis", string]>
          ).map(([id, label]) => (
            <label key={id} className="settings-radio">
              <input
                type="radio"
                name="output-style"
                checked={outputStyle === id}
                onChange={() => setOutputStyle(id)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <label>Permission mode</label>
        <div>
          <div className="settings-radio-group">
            {(
              [
                ["auto", "Auto (no prompts)"],
                ["bash-only", "Prompt on Bash"],
                ["all", "Prompt on Bash, Write, Edit"],
              ] as Array<["auto" | "bash-only" | "all", string]>
            ).map(([id, label]) => (
              <label key={id} className="settings-radio">
                <input
                  type="radio"
                  name="permission-mode"
                  checked={permissionMode === id}
                  onChange={() => setPermissionMode(id)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="settings-help">
            Approval prompts coming in a future release.
          </div>
        </div>
      </div>
    </>
  );
}

function SystemPromptTab() {
  const [value, setValue] = useState<string>("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const initialRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    api
      .getSystemPrompt()
      .then((res) => {
        if (cancelled) return;
        const v = res.systemPrompt ?? "";
        setValue(v);
        initialRef.current = v;
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = value !== initialRef.current;
  const showSaved = savedAt !== null && Date.now() - savedAt < 2000;

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSystemPrompt({
        systemPrompt: value.trim() || null,
      });
      initialRef.current = value;
      setSavedAt(Date.now());
    } catch {
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2 className="settings-section-title">System prompt</h2>
      <div className="settings-row">
        <label htmlFor="settings-system-prompt">Your prefix</label>
        <div>
          <textarea
            id="settings-system-prompt"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Optional. Prepended to the agent's session prompt — use it to give the agent your style preferences, project conventions, etc."
            disabled={loading}
            maxLength={4000}
          />
          <div className="settings-help">
            {value.length} / 4000 characters. Applies on new sessions.
          </div>
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="settings-button"
              onClick={save}
              disabled={!dirty || saving || loading}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {showSaved && (
              <span className="settings-saved-pill">Saved</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function KeybindingsTab() {
  return (
    <>
      <h2 className="settings-section-title">Keybindings</h2>
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group} className="settings-section">
          <h3
            style={{
              fontFamily: "var(--serif)",
              fontSize: 14,
              margin: "0 0 8px",
              color: "var(--text-strong)",
            }}
          >
            {group}
          </h3>
          <dl className="settings-shortcuts">
            {SHORTCUTS.filter((s) => s.group === group).map((s) => (
              <div className="settings-shortcut-row" key={s.id}>
                <dt>{s.description}</dt>
                <dd>
                  <kbd>{s.keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <div className="settings-help">Customizable bindings coming soon.</div>
    </>
  );
}

function NotificationsTab() {
  const [sound, setSound] = useLocalBool("lab.notify.sound", false);
  const [browser, setBrowser] = useLocalBool("lab.notify.browser", false);

  const toggleBrowser = async (next: boolean) => {
    if (next && typeof Notification !== "undefined") {
      if (Notification.permission === "default") {
        const result = await Notification.requestPermission();
        if (result !== "granted") {
          setBrowser(false);
          return;
        }
      } else if (Notification.permission === "denied") {
        setBrowser(false);
        return;
      }
    }
    setBrowser(next);
  };

  return (
    <>
      <h2 className="settings-section-title">Notifications</h2>
      <div className="settings-row">
        <label>Sound</label>
        <div>
          <label className="settings-radio">
            <input
              type="checkbox"
              checked={sound}
              onChange={(e) => setSound(e.target.checked)}
            />
            <span>Play a sound when the agent finishes</span>
          </label>
        </div>
      </div>
      <div className="settings-row">
        <label>Browser</label>
        <div>
          <label className="settings-radio">
            <input
              type="checkbox"
              checked={browser}
              onChange={(e) => toggleBrowser(e.target.checked)}
            />
            <span>Show a browser notification when the agent finishes</span>
          </label>
          <div className="settings-help">
            Requires browser permission. We'll ask the first time you enable it.
          </div>
        </div>
      </div>
    </>
  );
}

function DataTab() {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);

  const downloadSettings = () => {
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith("lab.")) continue;
        const v = localStorage.getItem(k);
        if (v != null) out[k] = v;
      }
    } catch {}
    const blob = new Blob([JSON.stringify(out, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cloudwise-lab-settings-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importSettings = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setImportNote("Invalid file — expected a JSON object.");
          return;
        }
        let count = 0;
        for (const [k, v] of Object.entries(parsed)) {
          if (!k.startsWith("lab.") || typeof v !== "string") continue;
          try {
            localStorage.setItem(k, v);
            count += 1;
          } catch {}
        }
        setImportNote(
          `Imported ${count} setting${count === 1 ? "" : "s"}. Reload to apply theme/agent changes.`
        );
      } catch {
        setImportNote("Could not parse file.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <>
      <h2 className="settings-section-title">Data</h2>

      <div className="settings-row">
        <label>Export</label>
        <div>
          <button
            type="button"
            className="settings-button secondary"
            onClick={downloadSettings}
          >
            Download settings JSON
          </button>
          <div className="settings-help">
            Includes only settings stored in your browser, not your chat history.
          </div>
        </div>
      </div>

      <div className="settings-row">
        <label>Import</label>
        <div>
          <input
            type="file"
            accept="application/json"
            onChange={importSettings}
          />
          {importNote && (
            <div className="settings-help" style={{ marginTop: 6 }}>
              {importNote}
            </div>
          )}
        </div>
      </div>

      <div className="settings-row">
        <label>Account</label>
        <div>
          {!confirmingDelete ? (
            <button
              type="button"
              className="settings-button secondary"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete account
            </button>
          ) : (
            <div
              style={{
                background: "var(--red-bg)",
                border: "1px solid var(--red)",
                borderRadius: "var(--radius)",
                padding: 12,
                color: "var(--text)",
                fontSize: 13,
              }}
            >
              Self-serve account deletion isn't available. Contact your admin
              to remove your account.
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="settings-button secondary"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
