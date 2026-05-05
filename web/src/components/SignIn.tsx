import { useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";

type Props = {
  onSignedIn: () => void;
};

type Mode = "signin" | "signup" | "magic" | "forgot";

export function SignIn({ onSignedIn }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setInfo(null);
  };

  const submit = async (evt: FormEvent) => {
    evt.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        await api.signin(email, password);
        onSignedIn();
      } else if (mode === "signup") {
        await api.signup(email, password, displayName || undefined);
        onSignedIn();
      } else if (mode === "magic") {
        const res = await api.sendMagicLink(email);
        setInfo(
          res.smtpConfigured
            ? `If an account exists for ${email}, we've sent a sign-in link. Check your inbox — it expires in 15 minutes.`
            : `Email isn't configured on this server. The link was logged to the server console; ask your admin to grab it.`
        );
      } else {
        const res = await api.sendPasswordReset(email);
        setInfo(
          res.smtpConfigured
            ? `If an account exists for ${email}, we've sent a password-reset link. Check your inbox — it expires in 1 hour.`
            : `Email isn't configured on this server. The link was logged to the server console; ask your admin to grab it.`
        );
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const cardTitle =
    mode === "signin"
      ? "Sign in"
      : mode === "signup"
        ? "Create account"
        : mode === "magic"
          ? "Email me a sign-in link"
          : "Reset password";

  const submitLabel =
    mode === "signin"
      ? "Sign in"
      : mode === "signup"
        ? "Create account"
        : mode === "magic"
          ? "Send link"
          : "Send reset link";

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="brand brand-lg">Cloudwise Lab</div>
        <p className="signin-tagline">
          Build websites by chatting with an AI. {cardTitle.toLowerCase()}.
        </p>

        <form className="signin-form" onSubmit={submit}>
          {mode === "signup" && (
            <label>
              <span>Display name</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                disabled={busy}
                placeholder="What should we call you?"
              />
            </label>
          )}
          <label>
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete={mode === "signin" ? "email" : "username"}
              required
              disabled={busy}
              autoFocus
            />
          </label>
          {(mode === "signin" || mode === "signup") && (
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "signin" ? "current-password" : "new-password"
                }
                required
                minLength={mode === "signup" ? 8 : undefined}
                disabled={busy}
                placeholder={mode === "signup" ? "At least 8 characters" : ""}
              />
            </label>
          )}

          {error && <div className="signin-error">{error}</div>}
          {info && <div className="signin-info">{info}</div>}

          <button type="submit" className="signin-submit" disabled={busy}>
            {busy ? "…" : submitLabel}
          </button>
        </form>

        <div className="signin-toggle signin-mode-links">
          {mode !== "magic" && (
            <button
              type="button"
              className="link-button"
              onClick={() => switchMode("magic")}
            >
              Email me a sign-in link instead
            </button>
          )}
          {mode === "signin" && (
            <button
              type="button"
              className="link-button"
              onClick={() => switchMode("forgot")}
            >
              Forgot password?
            </button>
          )}
          {mode !== "signin" && (
            <button
              type="button"
              className="link-button"
              onClick={() => switchMode("signin")}
            >
              Back to sign in
            </button>
          )}
          {mode === "signin" && (
            <button
              type="button"
              className="link-button"
              onClick={() => switchMode("signup")}
            >
              Create account
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
