import { useEffect, useRef, useState } from "react";
import type { Agent, Skill } from "../api";
import { Avatar, Icon } from "./Icons";

interface Suggestion {
  key: string;
  insert: string;
  label: React.ReactNode;
  hint?: string;
}

export function Composer({
  thread,
  placeholder,
  skills,
  members,
  busy,
  chip,
  onSend,
  onStop,
}: {
  thread: string;
  placeholder: string;
  skills: Skill[];
  members: Agent[];
  busy: boolean;
  /** Small label under the input, e.g. the model this agent will use. */
  chip?: { text: string; href?: string };
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}) {
  const draftKey = `draft:${thread}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [sel, setSel] = useState(0);
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      if (text) localStorage.setItem(draftKey, text);
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [text, draftKey]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) ta.current?.focus();
  }, [thread]);

  // "/" at the start lists skills. "@" at a word start lists group members.
  const suggestions: Suggestion[] = (() => {
    const slash = /^\/([\w-]*)$/.exec(text);
    if (slash) {
      return skills
        .filter((s) => s.slug.startsWith(slash[1].toLowerCase()))
        .map((s) => ({ key: s.slug, insert: `/${s.slug} `, label: <b>/{s.slug}</b>, hint: s.description }));
    }
    const at = /(^|\s)@(\w*)$/.exec(text);
    if (at && members.length) {
      return members
        .filter((m) => m.name.toLowerCase().startsWith(at[2].toLowerCase()))
        .map((m) => ({
          key: m.id,
          insert: text.slice(0, text.length - at[2].length - 1) + `@${m.name} `,
          label: (
            <>
              <Avatar agent={m} size={18} /> <b>{m.name}</b>
            </>
          ),
          hint: m.role,
        }));
    }
    return [];
  })();

  useEffect(() => setSel(0), [suggestions.length]);

  function apply(s: Suggestion) {
    setText(s.insert.startsWith("/") ? s.insert : s.insert);
    ta.current?.focus();
  }

  async function submit() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await onSend(t);
      setText("");
    } catch {
      // The error shows above the composer; keep the text.
    } finally {
      setSending(false);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (suggestions.length) {
      if (e.key === "ArrowDown") return e.preventDefault(), setSel((s) => (s + 1) % suggestions.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setSel((s) => (s - 1 + suggestions.length) % suggestions.length);
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) return e.preventDefault(), apply(suggestions[sel]);
      if (e.key === "Escape") return setText(text + " ");
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="composer-wrap">
      {suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((s, i) => (
            <button key={s.key} className={`suggest-item ${i === sel ? "on" : ""}`} onMouseDown={(e) => (e.preventDefault(), apply(s))}>
              <span className="suggest-label">{s.label}</span>
              {s.hint && <span className="suggest-hint">{s.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea ref={ta} rows={1} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <div className="composer-bar">
          {chip && (chip.href ? <a className="chip-btn" href={chip.href} title="Change the model">{chip.text}</a> : <span className="chip-btn">{chip.text}</span>)}
          <span className="spacer" />
          {busy && !text.trim() ? (
            <button className="send stop" onClick={onStop} aria-label="Stop" title="Stop">
              <Icon name="stop" />
            </button>
          ) : (
            <button className="send" onClick={() => void submit()} disabled={!text.trim() || sending} aria-label="Send">
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        {skills.length > 0 ? <span>/ for skills</span> : null}
        {members.length > 0 ? <span>@ to pick who answers</span> : null}
        <span>Shift+Enter for a new line</span>
      </div>
    </div>
  );
}
