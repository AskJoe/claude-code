import { useEffect, useState, type FormEvent } from "react";
import { api, type LabSettings } from "../lib/api.ts";

export function AdminSettings() {
  const [settings, setSettings] = useState<LabSettings | null>(null);
  const [model, setModel] = useState("");
  const [budget, setBudget] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminGetSettings()
      .then(({ settings }) => {
        setSettings(settings);
        setModel(settings.defaultModel);
        setBudget(String(settings.defaultBudgetUsd));
        setRate(String(settings.rateLimitPerMinute));
      })
      .catch((err) => setError(err?.message ?? String(err)));
  }, []);

  const submit = async (evt: FormEvent) => {
    evt.preventDefault();
    setBusy(true);
    setError(null);
    setSavedAt(null);
    try {
      const budgetN = Number(budget);
      const rateN = parseInt(rate, 10);
      if (!Number.isFinite(budgetN) || budgetN <= 0) {
        throw new Error("Default budget must be > 0");
      }
      if (!Number.isInteger(rateN) || rateN <= 0) {
        throw new Error("Rate limit must be a positive integer");
      }
      const { settings } = await api.adminUpdateSettings({
        defaultModel: model.trim(),
        defaultBudgetUsd: budgetN,
        rateLimitPerMinute: rateN,
      });
      setSettings(settings);
      setSavedAt(Date.now());
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !settings) return <div className="admin-error">⚠ {error}</div>;
  if (!settings) return <div className="admin-empty">Loading…</div>;

  return (
    <form className="admin-settings" onSubmit={submit}>
      <h3>Runtime settings</h3>
      <p className="dim">
        Changes apply to <strong>new</strong> sessions. In-flight sessions keep
        their original cap until they reset.
      </p>

      <label>
        <span>Default model</span>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={busy}
        />
        <small className="dim">
          e.g. <code>claude-sonnet-4-6</code> or <code>claude-opus-4-7</code>
        </small>
      </label>

      <label>
        <span>Default budget per session (USD)</span>
        <input
          type="number"
          step="0.05"
          min="0.05"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          disabled={busy}
        />
        <small className="dim">
          Per-user overrides set on a user row take precedence over this default.
        </small>
      </label>

      <label>
        <span>Rate limit (messages per minute, per session)</span>
        <input
          type="number"
          step="1"
          min="1"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          disabled={busy}
        />
      </label>

      {error && <div className="admin-error">⚠ {error}</div>}
      {savedAt && <div className="admin-ok">Saved.</div>}

      <div>
        <button type="submit" className="admin-primary-btn" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
