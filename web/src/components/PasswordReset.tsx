/**
 * Password reset landing page. Reached via the email link
 *   <host>/#/auth/reset/<token>
 *
 * Validates the token first (so we can show "expired" before the user types
 * a password), then submits the new password to the confirm endpoint.
 */

import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";

type Props = {
  token: string;
  onResetComplete: () => void;
};

type CheckState =
  | { kind: "loading" }
  | { kind: "valid" }
  | { kind: "invalid"; reason?: string };

export function PasswordReset({ token, onResetComplete }: Props) {
  const [check, setCheck] = useState<CheckState>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .checkResetToken(token)
      .then((res) => {
        if (cancelled) return;
        if (res.valid) setCheck({ kind: "valid" });
        else setCheck({ kind: "invalid", reason: res.reason });
      })
      .catch(() => {
        if (!cancelled) setCheck({ kind: "invalid" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (evt: FormEvent) => {
    evt.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await api.confirmPasswordReset(token, password);
      onResetComplete();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  if (check.kind === "loading") {
    return (
      <div className="signin">
        <div className="signin-card">
          <div className="brand brand-lg">Cloudwise Lab</div>
          <p className="signin-tagline">Checking reset link…</p>
        </div>
      </div>
    );
  }

  if (check.kind === "invalid") {
    return (
      <div className="signin">
        <div className="signin-card">
          <div className="brand brand-lg">Cloudwise Lab</div>
          <p className="signin-tagline">
            {check.reason === "expired"
              ? "This reset link has expired."
              : check.reason === "used"
                ? "This reset link has already been used."
                : "This reset link is no longer valid."}
          </p>
          <p className="signin-tagline">
            Request a new link from the sign-in page.
          </p>
          <a href="#/" className="signin-submit signin-submit-link">
            Back to sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="brand brand-lg">Cloudwise Lab</div>
        <p className="signin-tagline">Choose a new password.</p>
        <form className="signin-form" onSubmit={submit}>
          <label>
            <span>New password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              disabled={busy}
              placeholder="At least 8 characters"
              autoFocus
            />
          </label>
          <label>
            <span>Confirm password</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              disabled={busy}
            />
          </label>
          {error && <div className="signin-error">{error}</div>}
          <button type="submit" className="signin-submit" disabled={busy}>
            {busy ? "Saving…" : "Reset password & sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
