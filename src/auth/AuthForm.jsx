import { useState } from "react";
import { useAuth } from "./AuthProvider.jsx";

export function AuthForm() {
  const { configured, signIn, signUp } = useAuth();
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setNotice("");

    if (!configured) {
      setError("Supabase is not configured. Add the Vite Supabase values to .env.");
      return;
    }

    setLoading(true);

    try {
      let authResult =
        mode === "signin"
          ? await signIn(email.trim(), password)
          : await signUp(email.trim(), password);

      if (mode === "signup" && !authResult.error && !authResult.data.session) {
        authResult = await signIn(email.trim(), password);
      }

      setLoading(false);

      if (authResult.error) {
        if (mode === "signup") {
          console.error("Supabase signup error:", authResult.error);
        } else {
          console.error("Supabase login error:", authResult.error);
        }

        setError(
          mode === "signup" &&
            authResult.error.message === "Invalid login credentials"
            ? "Account created, but Supabase still requires email confirmation before login."
            : authResult.error.message
        );
        return;
      }

      if (mode === "signup" && !authResult.data.session) {
        setNotice("Account created. Check your email to confirm your address, then sign in.");
      }
    } catch (unexpectedError) {
      setLoading(false);
      console.error(
        mode === "signup"
          ? "Supabase signup error:"
          : "Supabase login error:",
        unexpectedError
      );
      setError(unexpectedError.message);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-label="Authentication">
        <div className="auth-panel__brand">
          <span className="app__logo" aria-hidden="true">
            H
          </span>
          <div>
            <h1>Heney</h1>
            <p>Sign in to use your assistant.</p>
          </div>
        </div>

        <div className="auth-tabs" role="tablist" aria-label="Auth mode">
          <button
            type="button"
            className={mode === "signin" ? "auth-tabs__tab active" : "auth-tabs__tab"}
            onClick={() => setMode("signin")}
          >
            Login
          </button>
          <button
            type="button"
            className={mode === "signup" ? "auth-tabs__tab active" : "auth-tabs__tab"}
            onClick={() => setMode("signup")}
          >
            Sign up
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              minLength={6}
              required
            />
          </label>

          {error && <div className="app__error">{error}</div>}
          {notice && <div className="auth-notice">{notice}</div>}

          <button className="btn btn--send auth-form__submit" type="submit" disabled={loading}>
            {loading ? "Please wait..." : mode === "signin" ? "Login" : "Create account"}
          </button>
        </form>
      </section>
    </main>
  );
}
