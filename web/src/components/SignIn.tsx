import { useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";

type Props = {
  onSignedIn: () => void;
};

export function SignIn({ onSignedIn }: Props) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (evt: FormEvent) => {
    evt.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        await api.signin(email, password);
      } else {
        await api.signup(email, password, displayName || undefined);
      }
      onSignedIn();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="brand brand-lg">Cloudwise Lab</div>
        <p className="signin-tagline">
          Build websites by chatting with an AI. Sign in to start a project.
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
              autoFocus={mode === "signin"}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
              disabled={busy}
              placeholder={mode === "signup" ? "At least 8 characters" : ""}
            />
          </label>

          {error && <div className="signin-error">{error}</div>}

          <button type="submit" className="signin-submit" disabled={busy}>
            {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="signin-toggle">
          {mode === "signin" ? (
            <>
              No account?{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setMode("signup");
                  setError(null);
                }}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setMode("signin");
                  setError(null);
                }}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
