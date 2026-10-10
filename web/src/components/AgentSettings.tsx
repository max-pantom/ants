import { useCallback, useEffect, useMemo, useState } from "react";
import { del, get, patch, post, put, type AgentDetail, type AppState, type Settings } from "../api";
import { onLive } from "../live";
import { linkProps, navigate } from "../router";
import { clock, timeAgo } from "../util";
import { ANTS, Avatar, parseAvatar } from "./Icons";
import { ModelInput } from "./Settings";
import { Confirm } from "./Dialogs";

export function AgentsTab({ state, settings, id }: { state: AppState; settings: Settings; id?: string }) {
  const current = state.agents.find((a) => a.id === id) ?? state.agents[0];
  return (
    <div className="split">
      <div className="split-list">
        {state.agents.map((a) => (
          <a key={a.id} className={`nav-item ${a.id === current?.id ? "active" : ""}`} {...linkProps(`/settings/agents/${a.id}`)}>
            <Avatar agent={a} />
            <span className="nav-text">
              <span className="nav-name">{a.name}</span>
              <span className="nav-sub">{a.resolved ? `${a.resolved.provider} · ${a.resolved.model}` : "no model"}</span>
            </span>
          </a>
        ))}
      </div>
      {current && <AgentEditor key={current.id} id={current.id} settings={settings} />}
    </div>
  );
}

function AgentEditor({ id, settings }: { id: string; settings: Settings }) {
  const [d, setD] = useState<AgentDetail | null>(null);
  const load = useCallback(() => get<AgentDetail>(`/api/agents/${id}/detail`).then(setD), [id]);
  useEffect(() => {
    void load();
    return onLive((e) => {
      if (e.type === "agents" || e.type === "reconnected") void load();
    });
  }, [load]);
  if (!d) return null;
  return (
    <div className="stack editor">
      <Profile d={d} settings={settings} />
      <Tools d={d} reload={load} />
      <Skills d={d} reload={load} />
      <RoutineCard d={d} reload={load} />
      <Memory d={d} reload={load} />
      <Danger d={d} />
    </div>
  );
}

function Profile({ d, settings }: { d: AgentDetail; settings: Settings }) {
  const a = d.agent;
  const [form, setForm] = useState({ name: a.name, role: a.role, description: a.description, provider: a.provider ?? "", model: a.model ?? "", spendCap: a.spendCap });
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: k === "spendCap" ? Number(e.target.value) : e.target.value });
  const effectiveProvider = form.provider || settings.providers.default.provider || "";

  return (
    <section className="card">
      <h2>
        <Avatar agent={a} size={24} /> {a.name}
        {a.kind === "coordinator" && <span className="pill">coordinator</span>}
      </h2>
      <AvatarPicker a={a} />
      <div className="grid2">
        <label>
          Name
          <input value={form.name} onChange={set("name")} maxLength={40} />
        </label>
        <label>
          Role
          <input value={form.role} onChange={set("role")} maxLength={400} />
        </label>
      </div>
      <label>
        <span>
          Description <span className="muted small">(optional, goes into its instructions)</span>
        </span>
        <textarea rows={3} value={form.description} onChange={set("description")} />
      </label>
      <div className="grid2">
        <label>
          Provider
          <select value={form.provider} onChange={set("provider")}>
            <option value="">Host default{settings.providers.default.provider ? ` (${settings.providers.default.provider})` : ""}</option>
            {settings.catalog.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {settings.available[c.id] ? "" : " (not set up)"}
              </option>
            ))}
          </select>
        </label>
        <ModelInput provider={effectiveProvider} value={form.model} onChange={(model) => setForm({ ...form, model })} label={`Model${form.model ? "" : " (host default)"}`} />
      </div>
      {effectiveProvider === "chatgpt" && (
        <label>
          <span>
            ChatGPT plan cap <span className="muted small">(model calls per day for this agent)</span>
          </span>
          <input type="number" min={0} max={10000} value={form.spendCap} onChange={set("spendCap")} style={{ maxWidth: 120 }} />
        </label>
      )}
      <div className="row">
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await patch(`/api/agents/${a.id}`, form);
              setMsg("Saved");
            } catch (e: any) {
              setMsg(e.message);
            }
            setTimeout(() => setMsg(null), 2000);
          }}
        >
          Save
        </button>
        <a className="btn ghost" {...linkProps(`/a/${a.id}`)}>
          Open chat
        </a>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </section>
  );
}

function Tools({ d, reload }: { d: AgentDetail; reload: () => void }) {
  const [allow, setAllow] = useState(new Set(d.agent.tools));
  const byPlugin = useMemo(() => {
    const m = new Map<string, AgentDetail["tools"]>();
    for (const t of d.tools) m.set(t.plugin, [...(m.get(t.plugin) ?? []), t]);
    return [...m.entries()];
  }, [d.tools]);
  const dirty = allow.size !== d.agent.tools.length || d.agent.tools.some((t) => !allow.has(t));
  const toggle = (name: string) => {
    const n = new Set(allow);
    n.has(name) ? n.delete(name) : n.add(name);
    setAllow(n);
  };
  return (
    <section className="card">
      <h2>Tools</h2>
      <p className="muted">
        This agent can call only what's checked. <span className="gate-key">asks</span> means the call waits for your yes in the chat.
        {d.agent.kind === "coordinator" && " The coordinator routes; giving it shell defeats the point."}
      </p>
      <div className="tool-groups">
        {byPlugin.map(([plugin, tools]) => (
          <div key={plugin} className="tool-group">
            <div className="tool-group-head">{plugin}</div>
            {tools.map((t) => (
              <label key={t.name} className="check tool-check" title={t.description}>
                <input type="checkbox" checked={allow.has(t.name)} onChange={() => toggle(t.name)} />
                <code>{t.name}</code>
                {t.gate === true && <span className="gate-key">asks</span>}
                {typeof t.gate === "object" && (
                  <span className="gate-key soft" title={`Asks when the agent marks the call as ${t.gate.when}: sending, buying, deleting, posting`}>
                    asks if flagged
                  </span>
                )}
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={!dirty}
          onClick={async () => {
            await patch(`/api/agents/${d.agent.id}`, { tools: [...allow] });
            reload();
          }}
        >
          Save tools
        </button>
      </div>
    </section>
  );
}

function Skills({ d, reload }: { d: AgentDetail; reload: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>Skills</h2>
      <p className="muted">How to do a task. The agent writes these after something works; you run them in chat with /name.</p>
      {d.skills.length === 0 && <p className="muted small">None yet. After a task goes well, ask: "save that as a skill".</p>}
      {d.skills.map((s) => (
        <div key={s.slug} className="skill">
          <div className="row between">
            <button className="link" onClick={() => setOpen(open === s.slug ? null : s.slug)}>
              <b>/{s.slug}</b> <span className="muted">{s.description}</span>
            </button>
            <button
              className="btn ghost small"
              onClick={async () => {
                await del(`/api/agents/${d.agent.id}/skills/${s.slug}`);
                reload();
              }}
            >
              Delete
            </button>
          </div>
          {open === s.slug && <pre className="skill-body">{s.body}</pre>}
        </div>
      ))}
    </section>
  );
}

const PRESETS = [
  { label: "Every weekday 9:00", cron: "0 9 * * 1-5" },
  { label: "Every day 8:00", cron: "0 8 * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Mondays 10:00", cron: "0 10 * * 1" },
];

function RoutineCard({ d, reload }: { d: AgentDetail; reload: () => void }) {
  const r = d.routine;
  const [cron, setCron] = useState(r?.cron ?? "0 9 * * 1-5");
  const [skill, setSkill] = useState(r?.skill ?? "");
  const [instruction, setInstruction] = useState(r?.instruction ?? "");
  const [enabled, setEnabled] = useState(r?.enabled ?? true);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>Routine</h2>
      <p className="muted">When. One schedule per agent. It runs a skill or a standing instruction and posts into this agent's chat. Gated tools still stop for you.</p>
      <div className="grid2">
        <label>
          Schedule (cron)
          <input value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} />
          <span className="chips">
            {PRESETS.map((p) => (
              <button key={p.cron} type="button" className={`chip ${cron === p.cron ? "on" : ""}`} onClick={() => setCron(p.cron)}>
                {p.label}
              </button>
            ))}
          </span>
        </label>
        <label>
          Skill
          <select value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="">None, use the instruction</option>
            {d.skills.map((s) => (
              <option key={s.slug} value={s.slug}>
                /{s.slug}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        {skill ? "Extra input for the skill (optional)" : "Instruction"}
        <textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Check the inbox folder and summarise anything new." />
      </label>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
      </label>
      {r && (
        <p className="muted small">
          {r.nextRun ? `Next run ${new Date(r.nextRun).toLocaleString()}.` : "Paused."} {r.lastRunAt ? `Last ran ${timeAgo(r.lastRunAt)} (${clock(r.lastRunAt)}).` : ""}
        </p>
      )}
      <div className="row">
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await put(`/api/agents/${d.agent.id}/routine`, { cron, skill: skill || null, instruction, enabled });
              setMsg("Saved");
              reload();
            } catch (e: any) {
              setMsg(e.message);
            }
          }}
        >
          Save routine
        </button>
        {r && (
          <>
            <button
              className="btn"
              onClick={async () => {
                await post(`/api/agents/${d.agent.id}/routine/run`);
                navigate(`/a/${d.agent.id}`);
              }}
            >
              Run now
            </button>
            <button
              className="btn ghost"
              onClick={async () => {
                await del(`/api/agents/${d.agent.id}/routine`);
                reload();
              }}
            >
              Remove
            </button>
          </>
        )}
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </section>
  );
}

function Memory({ d, reload }: { d: AgentDetail; reload: () => void }) {
  return (
    <section className="card">
      <h2>Memory</h2>
      <p className="muted">Short notes the agent wrote for itself. Shown to it at the start of every turn. Not copied with the template.</p>
      {d.memories.length === 0 && <p className="muted small">Nothing yet.</p>}
      <ul className="memories">
        {d.memories.map((m) => (
          <li key={m.id}>
            <span>{m.text}</span>
            <button
              className="btn ghost small"
              onClick={async () => {
                await del(`/api/agents/${d.agent.id}/memories/${m.id}`);
                reload();
              }}
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Danger({ d }: { d: AgentDetail }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="card">
      <h2>Template and removal</h2>
      <p className="muted">Copying takes the role, skills, routine (paused), plugins, and tool allowlist. Never the chat or the memory.</p>
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            const a = await post<{ id: string }>(`/api/agents/${d.agent.id}/copy`, {});
            navigate(`/settings/agents/${a.id}`);
          }}
        >
          Copy as template
        </button>
        <button className="btn danger" onClick={() => setConfirm(true)}>
          Delete {d.agent.name}
        </button>
      </div>
      {confirm && (
        <Confirm
          title={`Delete ${d.agent.name}?`}
          body="Its chat, memory, skills, routine, and screen go with it. Files it wrote in the shared workspace stay."
          action="Delete"
          danger
          onYes={async () => {
            await del(`/api/agents/${d.agent.id}`);
            navigate("/settings/agents");
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </section>
  );
}

/** Pick which ant this agent is, tint its background, or upload a picture. Saves as you click. */
function AvatarPicker({ a }: { a: AgentDetail["agent"] }) {
  const cur = parseAvatar(a.avatar, a.id);
  const [error, setError] = useState<string | null>(null);
  const save = async (avatar: string | null) => {
    setError(null);
    try {
      await patch(`/api/agents/${a.id}`, { avatar });
    } catch (e: any) {
      setError(e.message);
    }
  };
  const pickBg = (bg: string) => cur.type === "ant" && save(`ant:${cur.ant.id}:${bg}`);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const res = await fetch(`/api/agents/${a.id}/avatar`, { method: "PUT", headers: { "content-type": file.type }, body: file });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Upload failed.");
  };
  return (
    <div className="avatar-picker">
      <div className="ant-row" role="radiogroup" aria-label="Agent picture">
        {ANTS.map((ant) => (
          <button
            key={ant.id}
            type="button"
            role="radio"
            aria-checked={cur.type === "ant" && cur.ant.id === ant.id}
            className={`ant-choice ${cur.type === "ant" && cur.ant.id === ant.id ? "on" : ""}`}
            onClick={() => save(`ant:${ant.id}${cur.type === "ant" && cur.bg ? `:${cur.bg}` : ""}`)}
          >
            <Avatar avatar={`ant:${ant.id}${cur.type === "ant" && cur.bg ? `:${cur.bg}` : ""}`} seed={a.id} size={56} walking={cur.type === "ant" && cur.ant.id === ant.id} />
            <span>{ant.label}</span>
          </button>
        ))}
      </div>
      <div className="row">
        <label className="inline">
          Background
          <input type="color" value={cur.type === "ant" && cur.bg ? cur.bg : "#f3e9e4"} disabled={cur.type !== "ant"} onChange={(e) => void pickBg(e.target.value)} />
        </label>
        <label className="btn ghost file-btn">
          Upload picture
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void upload(e.target.files?.[0])} />
        </label>
        {a.avatar && (
          <button type="button" className="btn ghost" onClick={() => void save(null)}>
            Use the default
          </button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
