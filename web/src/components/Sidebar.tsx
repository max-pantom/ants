import { useState } from "react";
import type { AppState } from "../api";
import { linkProps, type Route } from "../router";
import { lastSeen } from "../util";
import { Avatar, GroupAvatar, Icon, Logo } from "./Icons";
import { NewAgentDialog, NewGroupDialog } from "./Dialogs";
import { post } from "../api";

export function Sidebar({ state, route, onClose }: { state: AppState; route: Route; onClose: () => void }) {
  const [dialog, setDialog] = useState<"agent" | "group" | null>(null);
  const active = route.name === "agent" || route.name === "group" ? route.id : null;
  const nameOf = (id: string) => state.agents.find((a) => a.id === id)?.name ?? "?";
  const unread = (thread: string) => (state.lastIds[thread] ?? 0) > lastSeen.get(thread);

  return (
    <nav className="sidebar">
      <div className="brand">
        <Logo />
        <span>ants</span>
        <button className="icon-btn only-mobile" onClick={onClose} aria-label="Close menu">
          <Icon name="x" />
        </button>
      </div>

      <div className="nav-section">
        <div className="nav-heading">
          Agents
          <button className="icon-btn" onClick={() => setDialog("agent")} aria-label="New agent" title="New agent">
            <Icon name="plus" />
          </button>
        </div>
        {state.agents.map((a) => {
          const thread = `a:${a.id}`;
          return (
            <a key={a.id} className={`nav-item ${active === a.id ? "active" : ""}`} {...linkProps(`/a/${a.id}`)}>
              <Avatar agent={a} />
              <span className="nav-text">
                <span className="nav-name">
                  {a.name}
                  {a.kind === "coordinator" && <span className="tag">coordinator</span>}
                </span>
                <span className="nav-sub">{a.busy ? "working…" : a.role}</span>
              </span>
              {state.pending.includes(thread) ? (
                <span className="badge ask" title="Waiting for your answer">?</span>
              ) : a.busy ? (
                <span className="pulse" title="Working" />
              ) : unread(thread) && active !== a.id ? (
                <span className="unread" />
              ) : null}
            </a>
          );
        })}
      </div>

      {state.workers?.length > 0 && (
        <div className="nav-section">
          <div className="nav-heading">Working now</div>
          {state.workers.map((w) => {
            const parent = w.parentThread?.startsWith("a:") ? nameOf(w.parentThread.slice(2)) : null;
            const until = w.deadline ? new Date(w.deadline).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
            return (
              <div key={w.id} className="nav-item static" title="A temporary worker. It has no chat of its own and is removed when it finishes.">
                <Avatar agent={w} />
                <span className="nav-text">
                  <span className="nav-name">
                    {w.name}
                    <span className="tag">temporary</span>
                  </span>
                  <span className="nav-sub">{[parent && `for ${parent}`, until && `until ${until}`].filter(Boolean).join(" · ") || "working…"}</span>
                </span>
                <button className="btn ghost tight" title="Make it a permanent agent in your list, with its own chat" onClick={() => void post(`/api/workers/${w.id}/promote`)}>
                  Keep
                </button>
                <span className="pulse" />
              </div>
            );
          })}
        </div>
      )}

      <div className="nav-section">
        <div className="nav-heading">
          Groups
          <button className="icon-btn" onClick={() => setDialog("group")} aria-label="New group" title="New group" disabled={state.agents.length < 2}>
            <Icon name="plus" />
          </button>
        </div>
        {state.groups.length === 0 && <p className="nav-empty">{state.agents.length < 2 ? "Add a second agent to start a group." : "Put two to six agents in one thread."}</p>}
        {state.groups.map((g) => {
          const thread = `g:${g.id}`;
          const busy = g.members.some((m) => state.agents.find((a) => a.id === m)?.busy === thread);
          return (
            <a key={g.id} className={`nav-item ${active === g.id ? "active" : ""}`} {...linkProps(`/g/${g.id}`)}>
              <GroupAvatar names={g.members.map(nameOf)} />
              <span className="nav-text">
                <span className="nav-name">{g.name}</span>
                <span className="nav-sub">{g.members.map(nameOf).join(", ")}</span>
              </span>
              {state.pending.includes(thread) ? (
                <span className="badge ask">?</span>
              ) : busy ? (
                <span className="pulse" />
              ) : unread(thread) && active !== g.id ? (
                <span className="unread" />
              ) : null}
            </a>
          );
        })}
      </div>

      <div className="nav-foot">
        <a className={`nav-item slim ${route.name === "settings" ? "active" : ""}`} {...linkProps("/settings")}>
          <Icon name="settings" />
          <span>Settings</span>
        </a>
      </div>

      {dialog === "agent" && <NewAgentDialog onClose={() => setDialog(null)} />}
      {dialog === "group" && <NewGroupDialog agents={state.agents} onClose={() => setDialog(null)} />}
    </nav>
  );
}
