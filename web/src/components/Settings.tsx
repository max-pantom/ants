import { useCallback, useEffect, useState } from "react";
import { get, post, put, type AppState, type AuditEvent, type PluginInfo, type Settings } from "../api";
import { onLive } from "../live";
import { linkProps } from "../router";
import { Icon } from "./Icons";
import { AgentsTab } from "./AgentSettings";
import { GroupsTab } from "./GroupSettings";

const TABS = [
  { id: "models", label: "Models" },
  { id: "agents", label: "Agents" },
  { id: "groups", label: "Groups" },
  { id: "plugins", label: "Plugins" },
  { id: "privacy", label: "Privacy" },
  { id: "machine", label: "This machine" },
];

export function SettingsPage({ state, tab, id, onMenu }: { state: AppState; tab: string; id?: string; onMenu: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      get<Settings>("/api/settings")
        .then((s) => (setSettings(s), setLoadError(null)))
        .catch((e) => setLoadError(e.status === 401 ? "Your session ended. Open the link `ants` printed in the terminal." : e.message)),
    [],
  );
  useEffect(() => {
    void load();
    return onLive((e) => {
      if (e.type === "providers" || e.type === "agents" || e.type === "reconnected") void load();
    });
  }, [load]);

  return (
    <div className="settings">
      <header className="chat-head">
        <button className="icon-btn only-mobile" onClick={onMenu} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <div className="chat-title">
          <h1>Settings</h1>
        </div>
      </header>
      <div className="tabs">
        {TABS.map((t) => (
          <a key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} {...linkProps(`/settings/${t.id}`)}>
            {t.label}
          </a>
        ))}
      </div>
      <div className="settings-body">
        {!settings ? (
          <div className="stack">
            {loadError ? (
              <div className="notice bad">
                Couldn't load settings: {loadError}
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn" onClick={() => void load()}>
                    Try again
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">Loading…</p>
            )}
          </div>
        ) : tab === "models" ? (
          <ModelsTab s={settings} reload={load} />
        ) : tab === "agents" ? (
          <AgentsTab state={state} settings={settings} id={id} />
        ) : tab === "groups" ? (
          <GroupsTab state={state} id={id} />
        ) : tab === "plugins" ? (
          <PluginsTab />
        ) : tab === "privacy" ? (
          <PrivacyTab s={settings} reload={load} />
        ) : (
          <MachineTab s={settings} />
        )}
      </div>
    </div>
  );
}

// ---------- models ----------

function ModelsTab({ s, reload }: { s: Settings; reload: () => void }) {
  const params = new URLSearchParams(location.search);
  const flash = params.get("chatgpt") === "ok" ? "Signed in with ChatGPT." : params.get("chatgpt_error");

  return (
    <div className="stack">
      {flash && <div className={`notice ${params.get("chatgpt_error") ? "bad" : "good"}`}>{flash}</div>}
      <p className="lead">
        Each agent picks a provider and a model. Local or bring-your-own-key endpoints are the stable path. ChatGPT plan access is an optional official preview.
      </p>
      {s.privacy.mode !== "hybrid" && <div className="notice">Public providers are blocked in {s.privacy.mode} mode. Switch to Hybrid under Privacy before using them.</div>}

      <DefaultModel s={s} reload={reload} />

      <section className="card">
        <h2>API keys</h2>
        <KeyRow provider="openai" label="OpenAI" masked={s.keys.openai} reload={reload} />
        <KeyRow provider="xai" label="xAI" masked={s.keys.xai} reload={reload} />
        <CompatRow s={s} reload={reload} />
      </section>

      <ChatGPTCard s={s} reload={reload} />
      <XaiCard s={s} reload={reload} />
    </div>
  );
}

function DefaultModel({ s, reload }: { s: Settings; reload: () => void }) {
  const [provider, setProvider] = useState(s.providers.default.provider ?? "");
  const [model, setModel] = useState(s.providers.default.model ?? "");
  const [saved, setSaved] = useState(false);
  return (
    <section className="card">
      <h2>Host default</h2>
      <p className="muted">Agents without their own choice use this.</p>
      <div className="grid2">
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">Choose…</option>
            {s.catalog.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {s.available[c.id] ? "" : " (not set up)"}
              </option>
            ))}
          </select>
        </label>
        <ModelInput provider={provider} value={model} onChange={setModel} />
      </div>
      <div className="row">
        <button
          className="btn primary"
          onClick={async () => {
            await put("/api/settings/providers", { default: { provider, model } });
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
            reload();
          }}
        >
          {saved ? "Saved" : "Save default"}
        </button>
      </div>
    </section>
  );
}

/** A free-text model id with a "load models" helper that asks the provider. */
export function ModelInput({ provider, value, onChange, label = "Model" }: { provider: string; value: string; onChange: (v: string) => void; label?: string }) {
  const [models, setModels] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const listId = `models-${provider}`;
  return (
    <label>
      <span className="row between">
        {label}
        {provider && (
          <button
            type="button"
            className="link small"
            onClick={async () => {
              setLoading(true);
              setErr(null);
              try {
                setModels((await get<{ models: string[] }>(`/api/providers/${provider}/models`)).models);
              } catch (e: any) {
                setErr(e.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "Loading…" : models.length ? `${models.length} models` : "Load models"}
          </button>
        )}
      </span>
      <input list={listId} value={value} onChange={(e) => onChange(e.target.value)} placeholder="model id" spellCheck={false} />
      <datalist id={listId}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {err && <span className="error small">{err}</span>}
    </label>
  );
}

function KeyRow({ provider, label, masked, reload, extra }: { provider: string; label: string; masked: string | null; reload: () => void; extra?: React.ReactNode }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (value: string) => {
    setBusy(true);
    try {
      await put(`/api/keys/${provider}`, { key: value });
      setKey("");
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="key-row">
      <div className="key-label">
        <b>{label}</b>
        {masked ? <span className="pill good">{masked}</span> : <span className="pill">not set</span>}
      </div>
      {extra}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) void save(key.trim());
        }}
      >
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={masked ? "Replace key" : "Paste API key"} autoComplete="off" spellCheck={false} />
        <button className="btn" disabled={!key.trim() || busy}>
          Save
        </button>
        {masked && (
          <button type="button" className="btn ghost" onClick={() => void save("")}>
            Remove
          </button>
        )}
      </form>
    </div>
  );
}

function CompatRow({ s, reload }: { s: Settings; reload: () => void }) {
  const [baseUrl, setBaseUrl] = useState(s.providers.compat.baseUrl);
  const [label, setLabel] = useState(s.providers.compat.label);
  const [err, setErr] = useState<string | null>(null);
  const dirty = baseUrl !== s.providers.compat.baseUrl || label !== s.providers.compat.label;
  return (
    <KeyRow
      provider="compat"
      label="OpenAI-compatible"
      masked={s.keys.compat}
      reload={reload}
      extra={
        <div className="compat">
          <p className="muted small">Any server that speaks the OpenAI API. Point it at Ollama or LM Studio for a local model; the key is optional there.</p>
          <div className="row">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" style={{ maxWidth: 140 }} />
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" spellCheck={false} />
            <button
              className="btn"
              disabled={!dirty}
              onClick={async () => {
                try {
                  setErr(null);
                  await put("/api/settings/providers", { compat: { baseUrl, label } });
                  reload();
                } catch (e: any) {
                  setErr(e.message);
                }
              }}
            >
              Save URL
            </button>
          </div>
          {err && <p className="error small">{err}</p>}
        </div>
      }
    />
  );
}

function ChatGPTCard({ s, reload }: { s: Settings; reload: () => void }) {
  const c = s.chatgpt;
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>
        Continue with ChatGPT <span className="pill">official preview · optional</span>
      </h2>
      <p className="muted">
        Uses OpenAI's official OAuth flow for eligible open-source, locally hosted apps. It can use eligible Plus or Pro plan usage, but it does not expose ChatGPT chats or
        account context. It is never the default and never replays browser cookies. OpenAI's own usage limits still apply; Ants also keeps a local per-agent safety cap.
      </p>
      {c.signedIn ? (
        <>
          <div className="kv">
            <span>Account</span>
            <b>{c.email ?? "signed in"}</b>
            <span>Plan usage</span>
            <b>{c.planUsage ? "granted" : "not granted. Sign in again and allow it."}</b>
            <span>This install</span>
            <code className="small">{c.hostId}</code>
          </div>
          {c.importedFromOtherHost && <p className="notice">This credential was signed in on another machine and copied here. That is the supported way to run on a server.</p>}
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                await post("/api/auth/chatgpt/logout");
                reload();
              }}
            >
              Sign out
            </button>
          </div>
        </>
      ) : s.mode === "server" ? (
        <div className="notice">
          On a server, sign in on the machine that has your browser, then copy the credential file over SSH:
          <pre>scp ~/.ants/secrets/chatgpt-auth.json you@server:{s.dataDir}/secrets/</pre>
          Don't copy <code>chatgpt-host.json</code>. Each install keeps its own host id.
        </div>
      ) : (
        <div className="row">
          <button
            className="btn primary"
            onClick={async () => {
              setErr(null);
              try {
                const { url } = await post<{ url: string }>("/api/auth/chatgpt/start");
                location.href = url;
              } catch (e: any) {
                setErr(e.message);
              }
            }}
          >
            Continue with ChatGPT
          </button>
          {err && <span className="error small">{err}</span>}
        </div>
      )}
    </section>
  );
}

function XaiCard({ s, reload }: { s: Settings; reload: () => void }) {
  const x = s.xai;
  const [clientId, setClientId] = useState(s.xaiClientId ?? "");
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="card">
      <h2>
        xAI subscription login <span className="pill">optional · subscription OAuth</span>
      </h2>
      <p className="muted">
        Device login for SuperGrok or X Premium+. Calls still go to the xAI API. Some tiers are refused there (403) even after a good login; when that happens Ants says so
        and uses your xAI key if you've set one. The key is the path that always works.
      </p>
      {x.rejected && (
        <div className="notice bad">
          xAI refused the subscription login for inference: {x.rejected}. {s.keys.xai ? "Your API key is being used instead." : "Add an xAI API key above."}
        </div>
      )}
      {x.signedIn ? (
        <div className="row">
          <span className="pill good">Signed in</span>
          <button
            className="btn"
            onClick={async () => {
              await post("/api/auth/xai/logout");
              reload();
            }}
          >
            Sign out
          </button>
        </div>
      ) : (
        <>
          <label>
            OAuth client id
            <span className="row">
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="public client id for the device flow" spellCheck={false} />
              <button
                className="btn"
                disabled={clientId === (s.xaiClientId ?? "")}
                onClick={async () => {
                  await put("/api/settings/providers", { xaiClientId: clientId });
                  reload();
                }}
              >
                Save
              </button>
            </span>
          </label>
          {x.login.state === "waiting" ? (
            <div className="notice">
              Enter <b className="code">{x.login.userCode}</b> at{" "}
              <a href={x.login.url} target="_blank" rel="noreferrer">
                {x.login.url}
              </a>
              . This page updates when you approve.
            </div>
          ) : (
            <div className="row">
              <button
                className="btn primary"
                disabled={!x.clientIdSet}
                onClick={async () => {
                  setErr(null);
                  try {
                    const r = await post<{ url: string }>("/api/auth/xai/start");
                    window.open(r.url, "_blank", "noreferrer");
                    reload();
                  } catch (e: any) {
                    setErr(e.message);
                  }
                }}
              >
                Start device login
              </button>
              {x.login.state === "error" && <span className="error small">{x.login.error}</span>}
              {err && <span className="error small">{err}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------- plugins ----------

function PluginsTab() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  useEffect(() => {
    void get<{ plugins: PluginInfo[] }>("/api/plugins").then((r) => setPlugins(r.plugins));
  }, []);
  return (
    <div className="stack">
      <p className="lead">
        A plugin is a folder with a <code>plugin.json</code> that declares its tools. Only declared tools load. Loading a plugin gives it to nobody; each agent has an
        allowlist under Agents.
      </p>
      <div className="row">
        <button className="btn" onClick={async () => setPlugins((await post<{ plugins: PluginInfo[] }>("/api/plugins/reload")).plugins)}>
          Reload plugins
        </button>
      </div>
      {plugins.map((p) => (
        <section key={`${p.scope}:${p.name}`} className="card">
          <h2>
            {p.name} <span className="pill">{p.dir ? (p.scope === "builtin" ? "folder · built-in" : p.scope) : "host"}</span>
          </h2>
          <p className="muted">{p.description}</p>
          {p.error && <p className="error small">{p.error}</p>}
          <div className="chips">
            {p.tools.map((t) => (
              <code key={t} className="chip">
                {t}
              </code>
            ))}
          </div>
          {p.dir && <p className="muted small mono">{p.dir}</p>}
        </section>
      ))}
    </div>
  );
}

// ---------- privacy ----------

function PrivacyTab({ s, reload }: { s: Settings; reload: () => void }) {
  const [mode, setMode] = useState(s.privacy.mode);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [confirmation, setConfirmation] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void get<{ events: AuditEvent[] }>("/api/audit?limit=100").then((x) => setEvents(x.events));
  }, [s.privacy.mode]);
  const descriptions = {
    "fully-local": "Only loopback model endpoints and local tools may connect. Public-network requests are blocked.",
    "self-hosted": "For a host you control. Public-network model and tool requests remain blocked; connect to services on that host.",
    hybrid: "Chats and state stay here, but the selected model and approved tools may contact public-network destinations.",
  };
  return (
    <div className="stack">
      <section className="card">
        <h2>Privacy mode</h2>
        <p className="lead">The active policy is enforced by model calls, HTTP tools, and browser navigation.</p>
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="fully-local">Fully local</option>
            <option value="self-hosted">Self-hosted</option>
            <option value="hybrid">Hybrid</option>
          </select>
        </label>
        <p className="muted">{descriptions[mode]}</p>
        <button
          className="btn primary"
          disabled={mode === s.privacy.mode}
          onClick={async () => {
            await put("/api/settings/privacy", { mode });
            setMsg("Privacy mode saved.");
            reload();
          }}
        >
          Save mode
        </button>
        {msg && <span className="muted small"> {msg}</span>}
      </section>

      <section className="card">
        <h2>What never leaves this machine</h2>
        <ul>
          <li>Secret values and the local session key</li>
          <li>The audit log</li>
          <li>Other agents' private chats and memory</li>
          <li>Files and screen contents unless a model/tool request explicitly includes them</li>
        </ul>
        <p className="notice warn">
          Encryption at rest is <b>not implemented yet</b>. The data directory and secret files use owner-only filesystem permissions, but disk encryption remains your
          operating system's responsibility.
        </p>
        <p className="muted">
          No telemetry is sent and no Ants cloud account is required. Read the short <a href="/api/security" target="_blank">security model</a>.
        </p>
      </section>

      <section className="card">
        <h2>Audit log</h2>
        <p className="muted">Model calls, tool calls, and network-policy decisions. Arguments are redacted before storage.</p>
        {events.length === 0 ? (
          <p className="muted small">No activity yet.</p>
        ) : (
          <div className="audit-list">
            {events.map((e) => (
              <div className="audit-row" key={e.id}>
                <span className={`pill ${e.status === "ok" ? "good" : e.status === "blocked" ? "bad" : ""}`}>{e.status}</span>
                <b>{e.action}</b>
                <span className="muted">{e.agentName ?? "host"}</span>
                <code title={e.target}>{e.target || e.kind}</code>
                <span className="muted small">{new Date(e.createdAt).toLocaleString()} · {e.bytesSent} B sent</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Export or wipe</h2>
        <p className="muted">Export includes chats, memory, skills, routines, agents, groups, and audit history. It never includes secrets.</p>
        <div className="row">
          <a className="btn" href="/api/export" download>Export JSON</a>
        </div>
        <hr />
        <p className="muted">Wipe removes chats, memory, approvals, routines, groups, provider credentials, browser state, screenshots, and workspace files. Agent profiles and skills remain.</p>
        <div className="row">
          <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="Type WIPE ANTS" />
          <button
            className="btn danger"
            disabled={confirmation !== "WIPE ANTS"}
            onClick={async () => {
              await post("/api/wipe", { confirmation });
              location.href = "/";
            }}
          >
            Wipe private data
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------- machine ----------

function MachineTab({ s }: { s: Settings }) {
  return (
    <div className="stack">
      <section className="card warn">
        <h2>
          <Icon name="lock" /> One machine, shared on purpose
        </h2>
        <p>
          Agents share this machine's files, the browser's cookie jar and saved logins, and installed tools. That's why a handoff doesn't start with "sign in again".{" "}
          <b>A secret placed on this machine is visible to every agent.</b> Separate agents are not a sandbox.
        </p>
        <p className="muted">
          What is kept apart: each agent's chat, memory, and screen. Keys you paste in Settings live in an owner-only secrets folder that tools cannot read, and are scrubbed
          from transcripts and logs.
        </p>
      </section>
      <section className="card">
        <h2>Where things live</h2>
        <div className="kv">
          <span>Mode</span>
          <b>{s.mode === "local" ? "Local (this machine only)" : "Server (password)"}</b>
          <span>Data</span>
          <code>{s.dataDir}</code>
          <span>Shared workspace</span>
          <code>{s.workspace}</code>
          <span>Secrets</span>
          <code>{s.dataDir}/secrets</code>
        </div>
      </section>
      {s.mode === "server" && (
        <section className="card">
          <h2>Session</h2>
          <button className="btn" onClick={() => post("/api/logout").then(() => location.reload())}>
            Sign out
          </button>
        </section>
      )}
    </div>
  );
}
