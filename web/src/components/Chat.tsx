import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { get, post, del, type Agent, type AppState, type Message, type Skill } from "../api";
import { onLive } from "../live";
import { linkProps, navigate } from "../router";
import { lastSeen } from "../util";
import { Avatar, GroupAvatar, Icon } from "./Icons";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { ScreenPanel } from "./ScreenPanel";
import { Confirm } from "./Dialogs";

export function Chat({ thread, state, onMenu }: { thread: string; state: AppState; onMenu: () => void }) {
  const isGroup = thread.startsWith("g:");
  const id = thread.slice(2);
  const agent = isGroup ? undefined : state.agents.find((a) => a.id === id);
  const group = isGroup ? state.groups.find((g) => g.id === id) : undefined;
  const members: Agent[] = useMemo(
    () => (group ? (group.members.map((m) => state.agents.find((a) => a.id === m)).filter(Boolean) as Agent[]) : agent ? [agent] : []),
    [group, agent, state.agents],
  );

  const [messages, setMessages] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<Skill[]>([]);
  const [screenFor, setScreenFor] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`screen:${thread}`);
    } catch {
      return null;
    }
  });
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<"clear" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await get<{ messages: Message[] }>(`/api/threads/${thread}/messages`);
    setMessages(r.messages);
    setHasMore(r.messages.length >= 150);
  }, [thread]);

  const loadOlder = async () => {
    if (!messages?.length) return;
    const r = await get<{ messages: Message[] }>(`/api/threads/${thread}/messages?before=${messages[0].id}`);
    setMessages((m) => [...r.messages, ...(m ?? [])]);
    setHasMore(r.messages.length >= 150);
  };

  useEffect(() => {
    void load();
    return onLive((e) => {
      if (e.type === "reconnected") void load();
      if (e.type === "thread_cleared" && e.thread === thread) setMessages([]);
      if (e.type === "delta" && e.thread === thread) setDrafts((d) => ({ ...d, [e.agentId]: e.text }));
      if (e.type === "busy" && e.thread === null) setDrafts((d) => (e.agentId in d ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== e.agentId)) : d));
      if (e.type === "message" && e.thread === thread) {
        const m = e.message;
        setMessages((list) => {
          if (!list) return list;
          const i = list.findIndex((x) => x.id === m.id);
          if (i >= 0) return list.map((x) => (x.id === m.id ? m : x));
          return [...list, m];
        });
        if (m.role === "assistant" && m.agentId) setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== m.agentId)));
      }
    });
  }, [thread, load]);

  // Skills for the / menu: the agent's own, or the group's lead's.
  const skillOwner = members[0]?.id;
  useEffect(() => {
    if (!skillOwner) return;
    get(`/api/agents/${skillOwner}/detail`)
      .then((d) => setSkills(d.skills))
      .catch(() => {});
  }, [skillOwner, messages?.length]);

  useEffect(() => {
    if (messages?.length) lastSeen.set(thread, messages[messages.length - 1].id);
  }, [messages, thread]);

  useEffect(() => {
    try {
      if (screenFor) localStorage.setItem(`screen:${thread}`, screenFor);
      else localStorage.removeItem(`screen:${thread}`);
    } catch {}
  }, [screenFor, thread]);

  // A screen card in the transcript opens the live view.
  const openScreen = (agentId: string) => setScreenFor(agentId);

  if (!agent && !group) {
    return (
      <div className="empty-main">
        <p>That chat no longer exists.</p>
        <button className="btn" onClick={() => navigate("/")}>
          Go home
        </button>
      </div>
    );
  }

  const busyHere = members.filter((m) => m.busy === thread);
  const title = agent?.name ?? group!.name;

  async function send(text: string) {
    setError(null);
    try {
      await post(`/api/threads/${thread}/messages`, { text });
    } catch (e: any) {
      setError(e.message);
      throw e;
    }
  }

  async function copyAgent() {
    if (!agent) return;
    const a = await post<Agent>(`/api/agents/${agent.id}/copy`, {});
    navigate(`/a/${a.id}`);
  }

  return (
    <div className={`chat ${screenFor ? "with-screen" : ""}`}>
      <section className="chat-col">
        <header className="chat-head">
          <button className="icon-btn only-mobile" onClick={onMenu} aria-label="Menu">
            <Icon name="menu" />
          </button>
          {agent ? <Avatar agent={agent} size={32} /> : <GroupAvatar names={members.map((m) => m.name)} size={32} />}
          <div className="chat-title">
            <h1>{title}</h1>
            <p>
              {agent
                ? agent.resolved
                  ? `${agent.role}`
                  : "No model yet"
                : members.map((m) => m.name).join(", ")}
            </p>
          </div>
          <div className="chat-actions">
            {agent ? (
              <button className={`btn ghost ${screenFor ? "on" : ""}`} onClick={() => setScreenFor(screenFor ? null : agent.id)} title="Watch this agent's screen">
                <Icon name="screen" />
                <span className="hide-sm">Screen</span>
                {agent.screen && <span className="live-dot" />}
              </button>
            ) : (
              members.map((m) => (
                <button key={m.id} className={`btn ghost tight ${screenFor === m.id ? "on" : ""}`} onClick={() => setScreenFor(screenFor === m.id ? null : m.id)} title={`Watch ${m.name}'s screen`}>
                  <Avatar agent={m} size={18} />
                  {m.screen && <span className="live-dot" />}
                </button>
              ))
            )}
            <div className="menu-wrap">
              <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="More">
                <Icon name="more" size={18} />
              </button>
              {menu && (
                <div className="menu" onMouseLeave={() => setMenu(false)}>
                  {agent && (
                    <>
                      <a className="menu-item" {...linkProps(`/settings/agents/${agent.id}`)}>
                        <Icon name="settings" /> Agent settings
                      </a>
                      <button className="menu-item" onClick={() => (setMenu(false), void copyAgent())}>
                        <Icon name="copy" /> Copy as template
                      </button>
                    </>
                  )}
                  {group && (
                    <a className="menu-item" {...linkProps(`/settings/groups/${group.id}`)}>
                      <Icon name="users" /> Edit group
                    </a>
                  )}
                  <button className="menu-item" onClick={() => (setMenu(false), setConfirm("clear"))}>
                    <Icon name="x" /> Clear chat
                  </button>
                  <button className="menu-item danger" onClick={() => (setMenu(false), setConfirm("delete"))}>
                    <Icon name="trash" /> Delete {agent ? "agent" : "group"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <Transcript
          thread={thread}
          messages={messages}
          agents={state.agents}
          drafts={drafts}
          busy={busyHere}
          hasMore={hasMore}
          onLoadOlder={loadOlder}
          onOpenScreen={openScreen}
          isGroup={isGroup}
        />

        {error && <div className="composer-error">{error}</div>}
        <Composer
          key={thread}
          thread={thread}
          placeholder={agent ? `Message ${agent.name}` : `Message ${group!.name} — @name to pick who answers`}
          skills={skills}
          members={isGroup ? members : []}
          busy={busyHere.length > 0}
          chip={agent ? { text: agent.resolved ? `${agent.resolved.model} · ${agent.resolved.provider}` : "No model yet", href: agent.resolved ? undefined : "/settings/models" } : undefined}
          onSend={send}
          onStop={() => busyHere.forEach((m) => void post(`/api/agents/${m.id}/stop`))}
        />
      </section>

      {screenFor && (
        <ScreenPanel
          key={screenFor}
          agent={state.agents.find((a) => a.id === screenFor)}
          onClose={() => setScreenFor(null)}
        />
      )}

      {confirm === "clear" && (
        <Confirm
          title="Clear this chat?"
          body={`The transcript is deleted. ${agent ? `${agent.name}'s memory and skills stay.` : "Members keep their own chats."}`}
          action="Clear"
          danger
          onYes={() => void post(`/api/threads/${thread}/clear`)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "delete" && (
        <Confirm
          title={`Delete ${title}?`}
          body={agent ? "Its chat, memory, skills, routine, and screen go with it. Files it wrote in the shared workspace stay." : "The group thread is deleted. The agents stay."}
          action="Delete"
          danger
          onYes={async () => {
            await del(agent ? `/api/agents/${agent.id}` : `/api/groups/${group!.id}`);
            navigate("/");
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

export function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  return { ref, onScroll };
}
