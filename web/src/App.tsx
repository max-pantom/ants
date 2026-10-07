import { useCallback, useEffect, useState } from "react";
import { get, post, type AppState } from "./api";
import { connectLive, onLive } from "./live";
import { navigate, useRoute } from "./router";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { SettingsPage } from "./components/Settings";
import { Gate } from "./components/Gate";

type Session = { mode: "local" | "server"; authed: boolean; needsSetup: boolean };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    // The browser `ants` opened carries a one-time launch token. Trade it for a cookie.
    const t = new URLSearchParams(location.search).get("t");
    if (t) {
      try {
        await post("/api/session/token", { token: t });
      } catch (e: any) {
        setLaunchError(e.message);
      }
      history.replaceState(null, "", location.pathname);
    }
    setSession(await get<Session>("/api/session"));
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (!session) return null;
  if (!session.authed) return <Gate session={session} launchError={launchError} onDone={loadSession} />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  const [state, setState] = useState<AppState | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [online, setOnline] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setState(await get<AppState>("/api/state"));
    } catch {
      // The connection banner says what's wrong; keep showing what we had.
    }
  }, []);

  useEffect(() => {
    connectLive();
    void refresh();
    return onLive((e) => {
      if (e.type === "connection") setOnline(e.online);
      if (e.type === "agents" || e.type === "groups" || e.type === "reconnected" || e.type === "busy") void refresh();
      else if (e.type === "message") {
        setState((s) =>
          s
            ? {
                ...s,
                lastIds: { ...s.lastIds, [e.thread]: Math.max(s.lastIds[e.thread] ?? 0, e.message.id) },
                pending:
                  e.message.role === "approval"
                    ? e.message.meta.approval?.status === "pending"
                      ? [...new Set([...s.pending, e.thread])]
                      : s.pending
                    : s.pending,
              }
            : s,
        );
        if (e.message.role === "approval" && e.message.meta.approval?.status !== "pending") void refresh();
      }
    });
  }, [refresh]);

  // Home goes to the first agent. The empty state is a chat, not a form.
  useEffect(() => {
    if (state && route.name === "home" && state.agents[0]) navigate(`/a/${state.agents[0].id}`, true);
  }, [state, route]);

  useEffect(() => setNavOpen(false), [route]);

  if (!state) return null;

  const thread = route.name === "agent" ? `a:${route.id}` : route.name === "group" ? `g:${route.id}` : null;

  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`}>
      <Sidebar state={state} route={route} onClose={() => setNavOpen(false)} />
      <div className="scrim" onClick={() => setNavOpen(false)} />
      <main className="main">
        {!online && <div className="offline">Lost the connection to the Ants server. Reconnecting… If you stopped it, start it again with <code>node bin/ants.js</code>.</div>}
        {route.name === "settings" ? (
          <SettingsPage state={state} tab={route.tab} id={route.id} onMenu={() => setNavOpen(true)} />
        ) : thread ? (
          <Chat key={thread} thread={thread} state={state} onMenu={() => setNavOpen(true)} />
        ) : (
          <div className="empty-main">
            <p>No agents yet.</p>
          </div>
        )}
      </main>
    </div>
  );
}
