import { useState } from "react";
import { patch, type AppState, type Group } from "../api";
import { linkProps } from "../router";
import { Avatar, GroupAvatar } from "./Icons";

export function GroupsTab({ state, id }: { state: AppState; id?: string }) {
  const current = state.groups.find((g) => g.id === id) ?? state.groups[0];
  const nameOf = (aid: string) => state.agents.find((a) => a.id === aid)?.name ?? "?";
  if (!state.groups.length) return <p className="lead">No groups yet. Use the + next to Groups in the sidebar.</p>;
  return (
    <div className="split">
      <div className="split-list">
        {state.groups.map((g) => (
          <a key={g.id} className={`nav-item ${g.id === current?.id ? "active" : ""}`} {...linkProps(`/settings/groups/${g.id}`)}>
            <GroupAvatar names={g.members.map(nameOf)} />
            <span className="nav-text">
              <span className="nav-name">{g.name}</span>
              <span className="nav-sub">{g.members.length} agents</span>
            </span>
          </a>
        ))}
      </div>
      {current && <GroupEditor key={current.id} g={current} state={state} />}
    </div>
  );
}

function GroupEditor({ g, state }: { g: Group; state: AppState }) {
  const [name, setName] = useState(g.name);
  const [members, setMembers] = useState(g.members);
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : m.length >= 6 ? m : [...m, id]));
  return (
    <div className="stack editor">
      <section className="card">
        <h2>{g.name}</h2>
        <p className="muted">Members see this thread and can hand tasks to each other here. A group is not a way into anyone's one-to-one chat.</p>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <div className="field-label">Members, in order. The first answers when nobody is @mentioned.</div>
        <div className="pick-list">
          {state.agents.map((a) => (
            <label key={a.id} className={`pick ${members.includes(a.id) ? "on" : ""}`}>
              <input type="checkbox" checked={members.includes(a.id)} onChange={() => toggle(a.id)} />
              <Avatar name={a.name} size={22} kind={a.kind} />
              <span>{a.name}</span>
              {members.includes(a.id) && <span className="muted small">#{members.indexOf(a.id) + 1}</span>}
            </label>
          ))}
        </div>
        <div className="row">
          <button
            className="btn primary"
            disabled={members.length < 2}
            onClick={async () => {
              try {
                await patch(`/api/groups/${g.id}`, { name, members });
                setMsg("Saved");
              } catch (e: any) {
                setMsg(e.message);
              }
            }}
          >
            Save
          </button>
          <a className="btn ghost" {...linkProps(`/g/${g.id}`)}>
            Open thread
          </a>
          {msg && <span className="muted small">{msg}</span>}
        </div>
      </section>
    </div>
  );
}
