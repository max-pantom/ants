import { useEffect, useRef, useState } from "react";
import { post, type Agent } from "../api";
import { Avatar, Icon } from "./Icons";

interface Action {
  id: number;
  kind: string;
  x?: number;
  y?: number;
  text?: string;
}

/** A live view of the agent's own browser page. Closing this view never stops the work. */
export function ScreenPanel({ agent, onClose }: { agent?: Agent; onClose: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [caption, setCaption] = useState<string | null>(null);
  const n = useRef(0);

  useEffect(() => {
    if (!agent) return;
    const es = new EventSource(`/api/agents/${agent.id}/screen`);
    es.addEventListener("state", (e) => {
      const isOn = (e as MessageEvent).data === "on";
      setOn(isOn);
      if (!isOn) setFrame(null);
    });
    es.addEventListener("frame", (e) => setFrame((e as MessageEvent).data));
    es.addEventListener("action", (e) => {
      const a = JSON.parse((e as MessageEvent).data);
      const id = ++n.current;
      if (a.x !== undefined) {
        setActions((list) => [...list.slice(-4), { id, ...a }]);
        setTimeout(() => setActions((list) => list.filter((x) => x.id !== id)), 1400);
      }
      const label =
        a.kind === "type" ? `Typing “${String(a.text ?? "").slice(0, 60)}”` : a.kind === "navigate" ? `Opening ${a.text}` : a.kind === "key" ? `Pressing ${a.text}` : a.kind === "scroll" ? `Scrolling ${a.text}` : "Clicking";
      setCaption(label);
      setTimeout(() => setCaption((c) => (c === label ? null : c)), 2200);
    });
    return () => es.close();
  }, [agent?.id]);

  if (!agent) return null;

  return (
    <aside className="screen-panel">
      <header className="screen-head">
        <Avatar name={agent.name} size={22} kind={agent.kind} />
        <div className="screen-title">
          <b>{agent.name}'s screen</b>
          <span className={`screen-status ${on ? "live" : ""}`}>{on ? (agent.busy ? "Live · working" : "Live") : on === false ? "Off" : "Connecting…"}</span>
        </div>
        {on && (
          <button className="icon-btn" title="Close the browser page" onClick={() => void post(`/api/agents/${agent.id}/screen/close`)}>
            <Icon name="trash" />
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="Hide screen" title="Hide (the work keeps going)">
          <Icon name="x" />
        </button>
      </header>
      <div className="screen-frame">
        {frame ? (
          <>
            <img src={`data:image/jpeg;base64,${frame}`} alt={`${agent.name}'s screen`} />
            {actions.map((a) => (
              <span key={a.id} className="ripple" style={{ left: `${a.x! * 100}%`, top: `${a.y! * 100}%` }} />
            ))}
            {caption && <div className="screen-caption">{caption}</div>}
          </>
        ) : (
          <div className="screen-off">
            <Icon name="screen" size={28} />
            <p>{on === false ? `The screen is off. It opens when ${agent.name} uses the browser.` : "Waiting for the first frame…"}</p>
          </div>
        )}
      </div>
      <p className="screen-note">
        Hiding this view doesn't stop {agent.name}. Cookies and logins on this machine are shared with every agent; the screen is not.
      </p>
    </aside>
  );
}
