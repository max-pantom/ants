import { hue } from "../util";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <g fill="#fff">
        <circle cx="10" cy="16" r="3.2" />
        <circle cx="16.5" cy="16" r="3.8" />
        <circle cx="23.5" cy="16" r="3" />
      </g>
      <g stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
        <path d="M14 12.5 11 8.5M19 12.5l3-4M14 19.5l-3 4M19 19.5l3 4" />
      </g>
    </svg>
  );
}

export function Avatar({ name, size = 28, kind }: { name: string; size?: number; kind?: string }) {
  const h = hue(name);
  return (
    <span
      className={`avatar ${kind === "coordinator" ? "coord" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.44, ["--h" as any]: h }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function GroupAvatar({ names, size = 28 }: { names: string[]; size?: number }) {
  return (
    <span className="group-avatar" style={{ width: size, height: size }}>
      {names.slice(0, 3).map((n, i) => (
        <span key={i} className="dot" style={{ ["--h" as any]: hue(n) }} />
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
