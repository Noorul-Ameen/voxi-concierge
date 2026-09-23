/** Concierge v3 building blocks: reason badges, film-art card header and the "Or just say…" voice hint. */
import { type ReactNode, useState } from "react";
import type { Lang } from "../lib/api";

/** rec = the one recommended option (solid blue); fast/save = green; usual = blue tint; few = amber; pop = neutral. Never magenta. */
export type BadgeKind = "rec" | "fast" | "save" | "usual" | "few" | "pop";
export type IconName = "star" | "bolt" | "heart" | "tag" | "flame" | "eye" | "pin" | "link" | "check" | "mic" | "card" | "clock";

const PATHS: Record<IconName, ReactNode> = {
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />,
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  tag: <><path d="M3.5 12.5V4h8.5l8.5 8.5-8.5 8.5z" /><circle cx="8" cy="8.5" r="1.3" /></>,
  flame: <path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3.5 3-5.3 3.4-9.4 2.4 1.5 3.3 3.6 3.2 5.5 1-.7 1.7-1.8 1.9-3 1.8 1.8 3.5 4.2 3.5 6.9C18 18.6 15.6 21 12 21z" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  pin: <><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  check: <path d="M4.5 12.5l4.5 4.5L19.5 7" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="M3 10h18" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
};

export function Icon({ name, size = 12 }: { name: IconName; size?: number }) {
  return (
    <svg className="vicon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

const DEFAULT_ICON: Record<BadgeKind, IconName> = { rec: "star", fast: "bolt", save: "tag", usual: "heart", few: "flame", pop: "eye" };

export function Badge({ kind, icon, children }: { kind: BadgeKind; icon?: IconName | null; children: ReactNode }) {
  const name = icon === null ? null : (icon ?? DEFAULT_ICON[kind]);
  return (
    <span className={`vbadge ${kind}`}>
      {name ? <Icon name={name} size={11} /> : null}
      {children}
    </span>
  );
}

/** At most two badges per option, and "rec" first. */
export function Badges({ items }: { items: { kind: BadgeKind; label: string; icon?: IconName }[] }) {
  const list = [...items].sort((a, b) => Number(b.kind === "rec") - Number(a.kind === "rec")).slice(0, 2);
  if (!list.length) return null;
  return (
    <span className="vbadges">
      {list.map((b) => (
        <Badge key={b.label} kind={b.kind} icon={b.icon}>
          {b.label}
        </Badge>
      ))}
    </span>
  );
}

/** Dark cinematic header used on film, refund, swap and review cards (same look in light and dark mode). */
export function FilmHeader({ title, meta, posterUrl: src, tag, children }: { title: ReactNode; meta?: ReactNode; posterUrl?: string; tag?: ReactNode; children?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const posterUrl = failed ? undefined : src;
  return (
    <div className="filmhead">
      <div className="filmhead-art" style={posterUrl ? { backgroundImage: `url(${posterUrl})` } : undefined} aria-hidden="true" />
      <div className="filmhead-body">
        {posterUrl ? <img className="filmhead-poster" src={posterUrl} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="filmhead-poster empty" aria-hidden="true">VOX</div>}
        <div className="filmhead-text">
          <b className="filmhead-title">{title}</b>
          {meta ? <span className="filmhead-meta">{meta}</span> : null}
          {tag ? <span className="filmhead-tag">{tag}</span> : null}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Voice-first nudge under a card's actions: customers can always just say the next step. */
export function SayHint({ lang, text }: { lang: Lang; text: string }) {
  return (
    <p className="sayhint">
      <Icon name="mic" size={11} />
      {lang === "ar" ? "أو قل فقط " : "Or just say "}“{text}”
    </p>
  );
}

/** The assistant's mark: nested VOX arches (replaces the old orb). `state` animates it while listening/speaking. */
export function ArchMark({ size = 30, state }: { size?: number; state?: string }) {
  return (
    <span className={`archmark ${state ?? ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size * 0.56} height={size * 0.56} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M4 20V11a8 8 0 0 1 16 0v9" />
        <path d="M8 20v-8.5a4 4 0 0 1 8 0V20" />
        <path d="M12 20v-7" />
      </svg>
    </span>
  );
}
