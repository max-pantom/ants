import { useMemo, useState } from "react";
import { post, type Agent, type Message, type ToolCall } from "../api";
import { linkProps } from "../router";
import { argSummary, clock, markdown, prettyArgs } from "../util";
import { Avatar, Icon } from "./Icons";
import { useAutoScroll } from "./Chat";

interface Props {
  thread: string;
  messages: Message[] | null;
  agents: Agent[];
  drafts: Record<string, string>;
  busy: Agent[];
  hasMore: boolean;
  onLoadOlder: () => void;
  onOpenScreen: (agentId: string) => void;
  isGroup: boolean;
}

export function Transcript({ thread, messages, agents, drafts, busy, hasMore, onLoadOlder, onOpenScreen, isGroup }: Props) {
  const results = useMemo(() => {
    const m = new Map<string, Message>();
    for (const x of messages ?? []) if (x.role === "tool" && x.meta.toolCallId) m.set(x.meta.toolCallId, x);
    return m;
  }, [messages]);

  const draftText = Object.values(drafts).join("");
  const { ref, onScroll } = useAutoScroll(`${messages?.length}:${draftText.length}:${busy.length}`);
  const agentById = (id: string | null) => agents.find((a) => a.id === id);
  const visible = (messages ?? []).filter((m) => m.role !== "tool");

  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      <div className="transcript-inner">
        {hasMore && (
          <button className="btn ghost older" onClick={onLoadOlder}>
            Earlier messages
          </button>
        )}
        {messages && visible.length === 0 && busy.length === 0 && (
          <div className="transcript-empty">
            {!isGroup && agentById(thread.slice(2)) && <Avatar agent={agentById(thread.slice(2))!} size={112} walking />}
            <p className="greeting">What's on your mind?</p>
            <p>{isGroup ? "Say something to the group. Use @name to pick who answers." : "Message it like a colleague. Setup is a message, not a form."}</p>
          </div>
        )}
        {visible.map((m, i) => {
          const prev = visible[i - 1];
          const speaker = speakerKey(m);
          const continued = prev && speakerKey(prev) === speaker && m.createdAt - prev.createdAt < 5 * 60_000 && m.role !== "event";
          return (
            <Row
              key={m.id}
              m={m}
              continued={!!continued}
              agent={agentById(m.agentId)}
              results={results}
              onOpenScreen={onOpenScreen}
              agentBusy={busy.some((b) => b.id === m.agentId)}
            />
          );
        })}
        {busy.map((a) =>
          drafts[a.id] ? (
            <div key={a.id} className="msg agent">
              <Avatar agent={a} />
              <div className="msg-body">
                <div className="msg-head">
                  <span className="who">{a.name}</span>
                </div>
                <div className="md" dangerouslySetInnerHTML={{ __html: markdown(drafts[a.id]) }} />
              </div>
            </div>
          ) : (
            <div key={a.id} className="msg agent typing">
              <Avatar agent={a} />
              <div className="dots" aria-label={`${a.name} is working`}>
                <span />
                <span />
                <span />
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function speakerKey(m: Message) {
  if (m.role === "assistant" || m.role === "approval") return `agent:${m.agentId}`;
  if (m.role === "user") return m.meta.from ? `from:${m.meta.from.id}` : "me";
  return `event:${m.id}`;
}

function Row({
  m,
  continued,
  agent,
  results,
  onOpenScreen,
  agentBusy,
}: {
  m: Message;
  continued: boolean;
  agent?: Agent;
  results: Map<string, Message>;
  onOpenScreen: (id: string) => void;
  agentBusy: boolean;
}) {
  if (m.role === "event") {
    return (
      <div className={`event ${m.meta.error ? "error" : ""}`}>
        <span>{m.content}</span>
        {m.meta.screen && m.agentId && (
          <button className="link" onClick={() => onOpenScreen(m.agentId!)}>
            <Icon name="eye" size={14} /> Watch
          </button>
        )}
        {m.meta.link && (
          <a className="link" {...linkProps(m.meta.link)}>
            Open settings
          </a>
        )}
      </div>
    );
  }

  if (m.role === "approval") return <ApprovalCard m={m} agent={agent} />;

  if (m.role === "user" && !m.meta.from) {
    return (
      <div className={`msg me ${continued ? "cont" : ""}`}>
        <div className="bubble">
          {(m.meta.routine || m.meta.skill) && (
            <div className="bubble-tags">
              {m.meta.routine && <span className="tag">routine</span>}
              {m.meta.skill && <span className="tag">/{m.meta.skill}</span>}
            </div>
          )}
          <div className="plain">{m.content}</div>
        </div>
      </div>
    );
  }

  // An assistant reply, or a message another agent wrote into this thread.
  const name = m.meta.from?.name ?? agent?.name ?? "Agent";
  const calls = m.meta.toolCalls ?? [];
  return (
    <div className={`msg agent ${continued ? "cont" : ""} ${m.meta.from ? "relayed" : ""}`}>
      {continued ? <span className="avatar-gap" /> : <Avatar name={name} seed={agent?.id} kind={agent?.kind} avatar={agent?.avatar} />}
      <div className="msg-body">
        {!continued && (
          <div className="msg-head">
            <span className="who">{name}</span>
            {m.meta.from && <span className="muted small">wrote here</span>}
            <span className="time">{clock(m.createdAt)}</span>
          </div>
        )}
        {m.content && <div className="md" dangerouslySetInnerHTML={{ __html: markdown(m.content) }} />}
        {calls.length > 0 && (
          <div className="tools">
            {calls.map((c) => (
              <ToolChip key={c.id} call={c} result={results.get(c.id)} running={agentBusy} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolChip({ call, result, running }: { call: ToolCall; result?: Message; running: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = result && /^Error:|declined/.test(result.content);
  const state = result ? (failed ? "fail" : "ok") : running ? "run" : "wait";
  const summary = argSummary(call.args);
  return (
    <div className={`tool ${state} ${open ? "open" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-state" />
        <span className="tool-name">{call.name}</span>
        {summary && <span className="tool-arg">{summary}</span>}
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="tool-detail">
          <pre>{prettyArgs(call.args)}</pre>
          {result && <pre className="result">{result.content}</pre>}
        </div>
      )}
      {result?.meta.image && (
        <a href={result.meta.image} target="_blank" rel="noreferrer" className="shot">
          <img src={result.meta.image} alt="Screenshot" loading="lazy" />
        </a>
      )}
    </div>
  );
}

function ApprovalCard({ m, agent }: { m: Message; agent?: Agent }) {
  const a = m.meta.approval!;
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approved" | "denied") => {
    setBusy(true);
    try {
      await post(`/api/approvals/${m.meta.approvalId}`, { decision });
    } finally {
      setBusy(false);
    }
  };
  let detail: React.ReactNode;
  if (a.kind === "spend") {
    let info: any = {};
    try {
      info = JSON.parse(a.args);
    } catch {}
    detail = (
      <p className="muted small">
        Uses your ChatGPT plan allowance under OpenAI's current limits. Ants asks once per session and also applies your local safety cap of {info.cap_per_day} calls a day (
        {info.used_today} used today).
      </p>
    );
  } else {
    detail = <pre className="approval-args">{prettyArgs(a.args)}</pre>;
  }
  return (
    <div className={`approval ${a.status}`}>
      <div className="approval-head">
        <Avatar name={a.agentName} seed={agent?.id} size={22} kind={agent?.kind} avatar={agent?.avatar} />
        <span>
          <b>{a.agentName}</b> {a.kind === "spend" ? "wants to use your ChatGPT plan allowance" : <>wants to run <code>{a.tool}</code></>}
        </span>
      </div>
      {detail}
      {a.status === "pending" ? (
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => decide("approved")}>
            <Icon name="check" /> Approve
          </button>
          <button className="btn" disabled={busy} onClick={() => decide("denied")}>
            Deny
          </button>
          <span className="muted small">or reply yes / no</span>
        </div>
      ) : (
        <div className={`approval-status ${a.status}`}>{a.status === "approved" ? "Approved" : "Declined"}</div>
      )}
    </div>
  );
}
