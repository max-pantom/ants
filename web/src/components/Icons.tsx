
export const ANTS = [
  { id: "green", label: "Sprout", color: "#4ed28f" },
  { id: "red", label: "Courier", color: "#fe6b5b" },
  { id: "purple", label: "Tinker", color: "#8a67dc" },
  { id: "blue", label: "Scout", color: "#22b5ff" },
] as const;
export type AntId = (typeof ANTS)[number]["id"];

const antById = (id: string) => ANTS.find((a) => a.id === id) ?? ANTS[0];
/** Agents without a choice still get a stable ant of their own. */
const defaultAnt = (seed: string) => ANTS[[...seed].reduce((n, c) => n + c.charCodeAt(0), 0) % ANTS.length];

export type ParsedAvatar = { type: "ant"; ant: (typeof ANTS)[number]; bg: string | null } | { type: "img"; v: string };

export function parseAvatar(avatar: string | null | undefined, seed: string): ParsedAvatar {
  const m = /^ant:(green|red|purple|blue)(?::(#[0-9a-fA-F]{6}))?$/.exec(avatar ?? "");
  if (m) return { type: "ant", ant: antById(m[1]), bg: m[2] ?? null };
  const i = /^img:(\d+)$/.exec(avatar ?? "");
  if (i) return { type: "img", v: i[1] };
  return { type: "ant", ant: defaultAnt(seed), bg: null };
}

export function Logo({ size = 22 }: { size?: number }) {
  return <img className="logo" src="/ants/red-head.png" width={size} height={size} alt="" aria-hidden />;
}

/** The walk cycle: 12 pre-rendered frames of legs swinging, the body bobbing, and pupils drifting left and right. */
function AntWalker({ ant }: { ant: string }) {
  return (
    <span className="ant-walker" aria-hidden>
      <span className="ant-bob">
        <span className="ant-frame">
          <span className="ant-strip" style={{ backgroundImage: `url(/ants/${ant}-walk.png)` }} />
        </span>
        <span className="ant-eyes" style={{ maskImage: `url(/ants/${ant}-eyes.png)`, WebkitMaskImage: `url(/ants/${ant}-eyes.png)` }}>
          <img className="ant-pupils" src={`/ants/${ant}-pupils.png`} alt="" draggable={false} />
        </span>
      </span>
    </span>
  );
}

interface AvatarAgent {
  id: string;
  name: string;
  kind?: string;
  avatar?: string | null;
}

export function Avatar({ agent, name, size = 28, kind, avatar, seed, walking }: { agent?: AvatarAgent; name?: string; size?: number; kind?: string; avatar?: string | null; seed?: string; walking?: boolean }) {
  const nm = agent?.name ?? name ?? "?";
  const id = agent?.id ?? seed ?? nm;
  const a = parseAvatar(agent?.avatar ?? avatar, id);
  const coord = (agent?.kind ?? kind) === "coordinator";
  const box = { width: size, height: size };
  if (a.type === "img")
    return <img className={`avatar photo ${coord ? "coord" : ""}`} style={box} src={`/api/agents/${id}/avatar?v=${a.v}`} alt="" aria-hidden />;
  const walk = !!walking && size > 44;
  const file = size <= 44 ? `${a.ant.id}-head` : a.ant.id;
  return (
    <span
      className={`avatar ${size > 44 ? "full" : ""} ${coord ? "coord" : ""}`}
      style={{ ...box, ["--ant" as any]: a.ant.color, ...(a.bg ? { background: a.bg } : {}) }}
      aria-hidden
    >
      {walk ? <AntWalker ant={a.ant.id} /> : <img src={`/ants/${file}.png`} alt="" draggable={false} />}
    </span>
  );
}

export function GroupAvatar({ names, size = 28 }: { names: string[]; size?: number }) {
  return (
    <span className="group-avatar" style={{ width: size, height: size }}>
      {names.slice(0, 3).map((n, i) => (
        <span key={i} className="dot" style={{ ["--ant" as any]: defaultAnt(n).color }} />
      ))}
    </span>
  );
}

const paths: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  screen: "M3 5h18v12H3z M8 21h8 M12 17v4",
  stop: "M7 7h10v10H7z",
  send: "M5 12h14 M13 6l6 6-6 6",
  menu: "M4 7h16M4 12h16M4 17h16",
  x: "M6 6l12 12M18 6 6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
  play: "M8 5l11 7-11 7z",
  chevron: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  users: "M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 20v-1a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8",
  lock: "M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
};

export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name] ?? ""} />
    </svg>
  );
}
