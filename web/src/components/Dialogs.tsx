import { useEffect, useRef, useState } from "react";
import { post, type Agent } from "../api";
import { navigate } from "../router";
import { Avatar } from "./Icons";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="modal-body">
        <h2>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

/** Creating an agent is a name and a role. Everything else has a default. */
export function NewAgentDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [coordinator, setCoordinator] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const a = await post<Agent>("/api/agents", { name, role, kind: coordinator ? "coordinator" : "agent" });
      onClose();
      navigate(`/a/${a.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <Modal title="New agent" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bea" autoFocus maxLength={40} />
        </label>
        <label>
          Role
          <textarea
            value={role}
            onChange={(e) => setRole(e.target.value)}
            rows={3}
            placeholder={coordinator ? "Routes work to the right agent." : "Researcher. Finds sources and writes short briefs."}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={coordinator} onChange={(e) => setCoordinator(e.target.checked)} />
          <span>
            Coordinator <span className="muted">— routes, hands off, and spawns workers. No shell.</span>
          </span>
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || !role.trim()}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function NewGroupDialog({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : m.length >= 6 ? m : [...m, id]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const g = await post<{ id: string }>("/api/groups", { name: name || "Group", members });
      onClose();
      navigate(`/g/${g.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <Modal title="New group" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch desk" autoFocus maxLength={60} />
        </label>
        <div className="field-label">Members (two to six). The first one answers when nobody is @mentioned.</div>
        <div className="pick-list">
          {agents.map((a) => (
            <label key={a.id} className={`pick ${members.includes(a.id) ? "on" : ""}`}>
              <input type="checkbox" checked={members.includes(a.id)} onChange={() => toggle(a.id)} />
              <Avatar name={a.name} size={22} kind={a.kind} />
              <span>{a.name}</span>
              {members.includes(a.id) && <span className="muted small">#{members.indexOf(a.id) + 1}</span>}
            </label>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={members.length < 2}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Confirm({ title, body, action, danger, onYes, onClose }: { title: string; body: string; action: string; danger?: boolean; onYes: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{body}</p>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className={`btn ${danger ? "danger" : "primary"}`}
          onClick={() => {
            onYes();
            onClose();
          }}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}
