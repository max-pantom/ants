import { useState } from "react";
import { post } from "../api";
import { Logo } from "./Icons";

/** Before there is a session: the local launch hint, the server's first-boot setup, or the password. */
export function Gate({
  session,
  launchError,
  onDone,
}: {
  session: { mode: "local" | "server"; needsSetup: boolean };
  launchError: string | null;
  onDone: () => void;
}) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (session.needsSetup) await post("/api/setup", { code, password });
      else await post("/api/login", { password });
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <Logo size={36} />
        <h1>Ants</h1>
        {session.mode === "local" ? (
          <>
            <p>{launchError ?? "This tab doesn't have a session yet."}</p>
            <p className="muted">
              Open the link <code>ants</code> printed in your terminal. It carries a one-time token so only the browser on this machine gets in.
            </p>
          </>
        ) : (
          <form onSubmit={submit}>
            {session.needsSetup ? (
              <>
                <p className="muted">First boot. Enter the setup code from the server log, then choose the password for this host.</p>
                <label>
                  Setup code
                  <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoFocus />
                </label>
              </>
            ) : null}
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus={!session.needsSetup}
                autoComplete={session.needsSetup ? "new-password" : "current-password"}
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn primary" disabled={busy}>
              {session.needsSetup ? "Set password" : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
