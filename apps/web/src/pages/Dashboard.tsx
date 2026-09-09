/**
 * Reporting & insights dashboard (feature 10).
 * Interactive: global filters (window, language, modality, channel, outcome, demo data), click-to-filter on every
 * chart, hover tooltips, hour × weekday heatmap, booking funnel, action reliability, conversation drill-down
 * with transcript + action timeline, sortable/searchable tables, auto-refresh and CSV export.
 * Charts are hand-rolled SVG (no chart library) so the page stays portable and light.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type ReportingFilters, reportingConversation, reportingList, reportingSummary } from "../lib/api";

// ---- palette (validated: resolved/transferred/dropped and 4 categorical slots pass CVD + normal-vision checks)
const C = {
  blue: "#0089c4",
  blueLight: "#7fc9ea",
  orange: "#eb6834",
  aqua: "#1baf7a",
  violet: "#4a3aa7",
  amber: "#eda100",
  red: "#e34948",
  gray: "#c7ced3",
};
const OUTCOME_COLOR: Record<string, string> = { resolved: C.blue, transferred: C.amber, dropped: C.red, other: C.gray, active: C.gray, unknown: C.gray };
const OUTCOME_LABEL: Record<string, string> = { resolved: "Resolved by the assistant", transferred: "Transferred", dropped: "Dropped", other: "Other", active: "Active", unknown: "Unknown" };

type Filters = Required<Pick<ReportingFilters, "days" | "language" | "modality" | "channel" | "outcome" | "demo">>;
const DEFAULT: Filters = { days: 30, language: "all", modality: "all", channel: "all", outcome: "all", demo: "include" };

// ---- tooltip
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const show = (e: React.MouseEvent, body: ReactNode) => setTip({ x: e.clientX + 12, y: e.clientY + 12, body });
  const hide = () => setTip(null);
  const el = tip ? <div className="tip" style={{ left: Math.min(tip.x, window.innerWidth - 220), top: tip.y }}>{tip.body}</div> : null;
  return { show, hide, el };
}

const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const fmtMs = (ms: number | null) => (ms == null ? "–" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

// ---- sparkline
function Spark({ values, color = C.blue }: { values: number[]; color?: string }) {
  const w = 120;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Kpi({ label, value, delta, deltaLabel, spark, sparkColor }: { label: string; value: ReactNode; delta?: number | null; deltaLabel?: string; spark?: number[]; sparkColor?: string }) {
  const cls = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {delta != null ? <span className={`delta ${cls}`} title={deltaLabel}>{delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {Math.abs(delta)}{deltaLabel?.includes("pt") ? " pt" : "%"}</span> : <span />}
      {spark ? <Spark values={spark} color={sparkColor} /> : null}
    </div>
  );
}

// ---- stacked daily columns
function DailyChart({ rows, onPick, tip, series }: { rows: any[]; onPick: (outcome: string) => void; tip: ReturnType<typeof useTip>; series: Record<string, boolean> }) {
  const W = 760;
  const H = 220;
  const padL = 34;
  const padB = 26;
  const keys = (["resolved", "transferred", "dropped", "other"] as const).filter((k) => series[k]);
  const max = Math.max(1, ...rows.map((r) => keys.reduce((a, k) => a + r[k], 0)));
  const n = rows.length;
  const bw = (W - padL - 8) / n;
  const ticks = 4;
  const [hover, setHover] = useState<number | null>(null);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Conversations per day by outcome">
      <g className="grid">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const y = H - padB - (i / ticks) * (H - padB - 10);
          return (
            <g key={i}>
              <line x1={padL} x2={W} y1={y} y2={y} />
              <text x={padL - 6} y={y + 4} textAnchor="end">{Math.round((max * i) / ticks)}</text>
            </g>
          );
        })}
      </g>
      {rows.map((r, i) => {
        let y = H - padB;
        const x = padL + i * bw + 1;
        const w = Math.max(2, bw - 2);
        return (
          <g key={r.day} className={`mark ${hover != null && hover !== i ? "dim" : ""}`} onMouseMove={(e) => { setHover(i); tip.show(e, <><b>{fmtDay(r.day)} · {r.total} conversations</b>{keys.map((k) => <span key={k}>{OUTCOME_LABEL[k]}: {r[k]}<br /></span>)}Voice {r.voice} · Text {r.text} · AR {r.ar} · EN {r.en}<br />Avg duration {fmtDur(r.avgDuration)}</>); }} onMouseLeave={() => { setHover(null); tip.hide(); }}>
            {keys.map((k) => {
              const h = (r[k] / max) * (H - padB - 10);
              y -= h;
              const seg = <rect key={k} x={x} y={y + (k === keys[keys.length - 1] ? 0 : 0)} width={w} height={Math.max(0, h - (h > 2 ? 2 : 0))} fill={OUTCOME_COLOR[k]} rx={k === keys[0] ? 0 : 0} onClick={() => onPick(k)} />;
              return seg;
            })}
            {n <= 45 && (i % Math.ceil(n / 10) === 0 || i === n - 1) ? <text x={x + w / 2} y={H - 8} textAnchor="middle">{fmtDay(r.day)}</text> : null}
          </g>
        );
      })}
      <line className="axis" x1={padL} x2={W} y1={H - padB} y2={H - padB} stroke="var(--line-2)" />
    </svg>
  );
}

// ---- donut
function Donut({ data, colors, labels, onPick, tip, total }: { data: Record<string, number>; colors: Record<string, string>; labels?: Record<string, string>; onPick?: (k: string) => void; tip: ReturnType<typeof useTip>; total?: number }) {
  const entries = Object.entries(data).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const sum = entries.reduce((a, [, v]) => a + v, 0) || 1;
  const R = 46;
  const r = 30;
  let a0 = -Math.PI / 2;
  const arcs = entries.map(([k, v]) => {
    const a1 = a0 + (v / sum) * Math.PI * 2 - 0.02;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${50 + rad * Math.cos(ang)},${50 + rad * Math.sin(ang)}`;
    const d = `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r)} A${r},${r} 0 ${large} 0 ${p(a0, r)} Z`;
    a0 = a1 + 0.02;
    return { k, v, d };
  });
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
      <svg viewBox="0 0 100 100" width={140} height={140} role="img" aria-label="Share by outcome">
        {arcs.map((a) => (
          <path key={a.k} className="mark" d={a.d} fill={colors[a.k] ?? C.gray} onClick={() => onPick?.(a.k)} onMouseMove={(e) => tip.show(e, <><b>{labels?.[a.k] ?? a.k}</b>{a.v} · {Math.round((a.v / sum) * 100)}%</>)} onMouseLeave={tip.hide} />
        ))}
        <text x={50} y={47} textAnchor="middle" style={{ fontSize: 14, fontWeight: 700, fill: "var(--charcoal)" }}>{total ?? sum}</text>
        <text x={50} y={60} textAnchor="middle" style={{ fontSize: 7 }}>total</text>
      </svg>
      <div className="legendrow" style={{ flexDirection: "column", gap: 4 }}>
        {entries.map(([k, v]) => (
          <button key={k} type="button" onClick={() => onPick?.(k)}>
            <i style={{ background: colors[k] ?? C.gray }} />
            {labels?.[k] ?? k} <span style={{ color: "var(--muted)" }}>{v} · {Math.round((v / sum) * 100)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- horizontal bars (optionally stacked 2–3 segments)
function Bars({ rows, onPick, total, max: maxIn, segLabels }: { rows: { k: string; label?: string; v: number[]; }[]; onPick?: (k: string) => void; total?: number; max?: number; segLabels?: string[] }) {
  const max = maxIn ?? Math.max(1, ...rows.map((r) => r.v.reduce((a, b) => a + b, 0)));
  if (!rows.length) return <div className="empty">No data in this window.</div>;
  return (
    <div>
      {rows.map((r) => {
        const sum = r.v.reduce((a, b) => a + b, 0);
        return (
          <div className="bar" key={r.k} onClick={() => onPick?.(r.k)} title={segLabels ? r.v.map((x, i) => `${segLabels[i]}: ${x}`).join(" · ") : undefined}>
            <span className="lbl">{r.label ?? r.k}</span>
            <span className="track">{r.v.map((x, i) => (x > 0 ? <i key={i} className={i === 1 ? "s2" : i === 2 ? "s3" : ""} style={{ width: `${(x / (total ?? max)) * 100}%` }} /> : null))}</span>
            <span className="val">{total ? `${Math.round((sum / total) * 100)}%` : sum}</span>
          </div>
        );
      })}
    </div>
  );
}

function Heat({ heat, tip }: { heat: number[][]; tip: ReturnType<typeof useTip> }) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const max = Math.max(1, ...heat.flat());
  const color = (v: number) => (v === 0 ? "var(--bg-2)" : `rgba(0, 137, 196, ${0.15 + 0.85 * (v / max)})`);
  return (
    <div className="heat" role="img" aria-label="Conversations by weekday and hour">
      <span />
      {Array.from({ length: 24 }, (_, h) => <span key={h} className="hl">{h % 3 === 0 ? h : ""}</span>)}
      {heat.map((row, d) => (
        <>
          <span key={`l${d}`} className="rl">{days[d]}</span>
          {row.map((v, h) => (
            <span key={`${d}-${h}`} className="cell" style={{ background: color(v) }} onMouseMove={(e) => tip.show(e, <><b>{days[d]} {String(h).padStart(2, "0")}:00–{String(h + 1).padStart(2, "0")}:00</b>{v} conversations</>)} onMouseLeave={tip.hide} />
          ))}
        </>
      ))}
    </div>
  );
}

function Funnel({ steps }: { steps: { step: string; n: number }[] }) {
  const top = Math.max(1, ...steps.map((s) => s.n));
  return (
    <div className="funnel">
      {steps.map((s, i) => (
        <div className="step" key={s.step}>
          <div className="box"><i style={{ height: `${Math.min(100, Math.max(4, (s.n / top) * 100))}%` }} /></div>
          <b>{s.n}</b>
          <small>{s.step}</small>
          {i > 0 ? <div className="conv">{steps[i - 1]!.n ? Math.round((s.n / steps[i - 1]!.n) * 100) : 0}% of previous</div> : <div className="conv">100%</div>}
        </div>
      ))}
    </div>
  );
}

// ---- conversation drawer
function Drawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { setD(null); reportingConversation(id).then(setD).catch(() => setD({ error: true })); }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const cv = d?.conversation;
  return (
    <div className="drawer" role="dialog" aria-label="Conversation details">
      <div className="dh"><b>{id}</b>{cv ? <span className={`pill ${cv.outcome ?? ""}`}>{cv.outcome ?? cv.status}</span> : null}<button type="button" className="iconbtn" onClick={onClose}>✕</button></div>
      <div className="db">
        {!d ? <div className="empty">Loading…</div> : d.error || !cv ? <div className="empty">Not found.</div> : (
          <>
            <div className="meta">
              <div><b>Started</b>{new Date(cv.startedAt).toLocaleString()}</div>
              <div><b>Duration</b>{cv.durationSeconds ? fmtDur(cv.durationSeconds) : "–"}</div>
              <div><b>Language</b>{cv.language}</div>
              <div><b>Modality</b>{cv.modality}</div>
              <div><b>Channel</b>{cv.channel}</div>
              <div><b>Customer</b>{cv.isLoggedIn ? cv.customerId ?? "member" : "guest"}</div>
              <div><b>Mode</b>{cv.mode}</div>
              <div><b>Source</b>{id.startsWith("demo_") ? "synthetic demo data" : "live"}</div>
            </div>
            {d.transcript?.summary ? <><h4>Summary</h4><p style={{ margin: 0 }}>{d.transcript.summary}</p></> : null}
            {(cv.journeys ?? []).length ? <><h4>Journeys</h4><div className="legendrow">{cv.journeys.map((j: any, i: number) => <span key={i} className={`pill ${j.status}`}>{j.name} · {j.status}</span>)}</div></> : null}
            {(cv.topics ?? []).length ? <><h4>Topics</h4><div className="legendrow">{cv.topics.map((t: string) => <span key={t} className="pill">{t}</span>)}</div></> : null}
            {d.transcript?.turns?.length ? <><h4>Transcript</h4>{d.transcript.turns.map((t: any, i: number) => <div key={i} className={`turn ${t.role}`}><div className="bubble">{t.text}</div></div>)}</> : null}
            {d.actions?.length ? <><h4>Actions</h4><div className="timeline">{d.actions.map((a: any) => <div key={a.id} className="ev"><span className={`pill ${a.status}`}>{a.status}</span> <b>{a.type}</b> · attempts {a.attempts}{a.startedAt && a.finishedAt ? ` · ${fmtMs(new Date(a.finishedAt).getTime() - new Date(a.startedAt).getTime())}` : ""}<br /><code>{a.error?.message ?? a.result?.speech?.slice?.(0, 140) ?? ""}</code></div>)}</div></> : null}
            {d.transfers?.length ? <><h4>Transfer</h4>{d.transfers.map((t: any) => <div key={t.id} className="ev">{t.reason} → {t.adapter} · {t.status}{t.agentName ? ` · ${t.agentName}` : ""}<br /><code>{t.summary}</code></div>)}</> : null}
            {d.complaints?.length ? <><h4>Complaint</h4>{d.complaints.map((c: any) => <div key={c.id} className="ev"><b>{c.id}</b> · {c.category} · <span className={`pill ${c.status}`}>{c.status}</span><br />{c.description}</div>)}</> : null}
            {d.feedback?.length ? <><h4>Feedback</h4>{d.feedback.map((f: any) => <div key={f.id}><span className="stars-inline">{"★".repeat(f.rating)}{"☆".repeat(5 - f.rating)}</span> {f.comment}</div>)}</> : null}
            {d.events?.length ? <><h4>Event log ({d.events.length})</h4><div className="timeline">{d.events.slice(0, 80).map((e: any) => <div key={e.id} className="ev"><b>{e.type}</b> <code>{e.actor} · {new Date(e.createdAt).toLocaleTimeString()}</code><br /><code>{JSON.stringify(e.payload).slice(0, 140)}</code></div>)}</div></> : null}
          </>
        )}
      </div>
    </div>
  );
}

function useSort<T>(rows: T[], initial: string) {
  const [key, setKey] = useState(initial);
  const [dir, setDir] = useState<1 | -1>(-1);
  const sorted = useMemo(() => [...rows].sort((a: any, b: any) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0)), [rows, key, dir]);
  const th = (k: string, label: string) => <th onClick={() => (key === k ? setDir((d) => (d === 1 ? -1 : 1)) : (setKey(k), setDir(-1)))}>{label}{key === k ? (dir === 1 ? " ▲" : " ▼") : ""}</th>;
  return { sorted, th };
}

export function Dashboard() {
  const [f, setF] = useState<Filters>(() => {
    try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem("voxi.dash.filters") ?? "{}") }; } catch { return DEFAULT; }
  });
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState(false);
  const [convs, setConvs] = useState<any[]>([]);
  const [complaints, setComplaints] = useState<any[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [feedback, setFeedback] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [series, setSeries] = useState<Record<string, boolean>>({ resolved: true, transferred: true, dropped: true, other: true });
  const tip = useTip();
  const qRef = useRef(q);
  qRef.current = q;

  const load = useCallback(async () => {
    try {
      const [sum, cv, cm, tr, fb] = await Promise.all([
        reportingSummary(f),
        reportingList("conversations", { ...f, q: qRef.current, limit: 300 }),
        reportingList("complaints"),
        reportingList("transfers"),
        reportingList("feedback"),
      ]);
      setS(sum); setConvs(cv.conversations ?? []); setComplaints(cm.complaints ?? []); setTransfers(tr.transfers ?? []); setFeedback(fb.feedback ?? []);
      setErr(false); setUpdated(new Date());
    } catch { setErr(true); }
  }, [f]);
  useEffect(() => { localStorage.setItem("voxi.dash.filters", JSON.stringify(f)); load(); }, [f, load]);
  useEffect(() => { const t = setTimeout(load, 350); return () => clearTimeout(t); }, [q, load]);
  useEffect(() => { if (!auto) return; const t = setInterval(load, 30000); return () => clearInterval(t); }, [auto, load]);

  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const toggle = (k: keyof Filters, v: string) => set({ [k]: f[k] === v ? "all" : v } as Partial<Filters>);
  const active = (Object.keys(DEFAULT) as (keyof Filters)[]).filter((k) => k !== "days" && f[k] !== DEFAULT[k]);

  const convSort = useSort(convs, "startedAt");
  const exportCsv = () => {
    const head = ["id", "startedAt", "durationSeconds", "language", "modality", "channel", "outcome", "loggedIn", "journeys", "topics"];
    const lines = [head.join(","), ...convs.map((c) => [c.id, c.startedAt, c.durationSeconds ?? "", c.language, c.modality, c.channel, c.outcome ?? c.status, c.isLoggedIn, (c.journeys ?? []).map((j: any) => `${j.name}:${j.status}`).join("|"), (c.topics ?? []).join("|")].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `voxi-conversations-${f.days}d.csv`;
    a.click();
  };

  const header = (
    <header className="topbar">
      <div className="brand"><div className="logo">V</div><span>VOXI INSIGHTS</span></div>
      <nav><Link to="/">Demo</Link><Link to="/dashboard" className="active">Dashboard</Link></nav>
    </header>
  );
  if (err && !s) return <div className="dashpage">{header}<div className="dash"><div className="empty">Reporting API unavailable.</div></div></div>;
  if (!s) return <div className="dashpage">{header}<div className="dash"><div className="empty">Loading…</div></div></div>;

  const j = s.journeys as Record<string, { completed: number; abandoned: number; failed: number }>;
  const daily = s.daily as any[];
  const totalDelta = s.conversations.previousTotal ? Math.round(((s.conversations.total - s.conversations.previousTotal) / s.conversations.previousTotal) * 100) : null;
  const rateDelta = s.containment.previousRate != null ? s.containment.rate - s.containment.previousRate : null;
  const journeyRows = Object.entries(j).map(([k, v]) => ({ k, v: [v.completed, v.abandoned, v.failed] })).sort((a, b) => b.v.reduce((x, y) => x + y, 0) - a.v.reduce((x, y) => x + y, 0));
  const actionsS = s.actions as { type: string; count: number; succeeded: number; failed: number; successRate: number; p50Ms: number | null; p95Ms: number | null }[];
  const latMax = Math.max(1, ...actionsS.map((a) => a.p95Ms ?? 0));

  return (
    <div className="dashpage">
      {header}
      {tip.el}
      <div className="dash">
        <div className="dashhead">
          <div>
            <h1>Reporting &amp; insights</h1>
            <div className="sub">Conversations, containment, journeys, drop-offs, transfers, topics, voice quality and CSAT — {s.conversations.synthetic ? `${s.conversations.synthetic} of ${s.conversations.total} conversations are synthetic demo history` : "live data"}.</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="live"><i style={{ background: auto ? "var(--ok)" : "var(--muted)", animation: auto ? undefined : "none" }} />{auto ? "Live · refreshes every 30 s" : "Paused"}{updated ? ` · ${updated.toLocaleTimeString()}` : ""}</span>
            <button type="button" className="btn ghost" onClick={() => setAuto((a) => !a)}>{auto ? "Pause" : "Resume"}</button>
            <button type="button" className="btn ghost" onClick={load}>Refresh</button>
            <button type="button" className="btn primary" onClick={exportCsv}>Export CSV</button>
          </div>
        </div>

        <div className="filters">
          <label>Window
            <span className="seg">{[1, 7, 30, 90].map((d) => <button key={d} type="button" className={f.days === d ? "on" : ""} onClick={() => set({ days: d })}>{d === 1 ? "24h" : `${d}d`}</button>)}</span>
          </label>
          <label>Language
            <select value={f.language} onChange={(e) => set({ language: e.target.value })}><option value="all">All</option><option value="en">English</option><option value="ar">Arabic</option></select>
          </label>
          <label>Modality
            <select value={f.modality} onChange={(e) => set({ modality: e.target.value })}><option value="all">All</option><option value="voice">Voice</option><option value="text">Text</option></select>
          </label>
          <label>Channel
            <select value={f.channel} onChange={(e) => set({ channel: e.target.value })}><option value="all">All</option>{Object.keys(s.conversations.byChannel).concat(["web", "app", "whatsapp", "phone"]).filter((v, i, a) => a.indexOf(v) === i).map((c) => <option key={c} value={c}>{c}</option>)}</select>
          </label>
          <label>Outcome
            <select value={f.outcome} onChange={(e) => set({ outcome: e.target.value })}><option value="all">All</option><option value="resolved">Resolved</option><option value="transferred">Transferred</option><option value="dropped">Dropped</option><option value="active">Active</option><option value="unknown">Unknown</option></select>
          </label>
          <label>Demo data
            <span className="seg">{(["include", "exclude", "only"] as const).map((d) => <button key={d} type="button" className={f.demo === d ? "on" : ""} onClick={() => set({ demo: d })}>{d}</button>)}</span>
          </label>
          <span className="spacer" />
          {active.length ? <button type="button" className="clear" onClick={() => setF({ ...DEFAULT, days: f.days })}>Clear {active.length} filter{active.length > 1 ? "s" : ""}</button> : <span style={{ fontSize: 12, color: "var(--muted)" }}>Tip: click any bar, slice or legend entry to filter</span>}
        </div>

        <div className="kpis">
          <Kpi label="Conversations" value={s.conversations.total} delta={totalDelta} deltaLabel="vs previous window" spark={daily.map((d) => d.total)} />
          <Kpi label="Contained by the assistant" value={`${s.containment.rate}%`} delta={rateDelta} deltaLabel="pt vs previous window" spark={daily.map((d) => (d.total ? Math.round((d.resolved / d.total) * 100) : 0))} />
          <Kpi label="Transferred to agent" value={s.containment.transferred} spark={daily.map((d) => d.transferred)} sparkColor={C.amber} />
          <Kpi label="Dropped" value={s.containment.dropped} spark={daily.map((d) => d.dropped)} sparkColor={C.red} />
          <Kpi label={`CSAT (${s.feedback.count} ratings)`} value={s.feedback.csat != null ? `${s.feedback.csat}%` : "–"} spark={undefined} />
          <Kpi label="Avg rating" value={s.feedback.avgRating ?? "–"} />
          <Kpi label="Avg duration" value={fmtDur(s.conversations.avgDurationSeconds)} spark={daily.map((d) => d.avgDuration)} sparkColor={C.violet} />
          <Kpi label="Voice share" value={`${s.conversations.total ? Math.round(((s.conversations.byModality.voice ?? 0) / s.conversations.total) * 100) : 0}%`} spark={daily.map((d) => d.voice)} sparkColor={C.aqua} />
        </div>

        <div className="panels">
          <div className="panel c8">
            <h3>Conversations per day <small>by outcome · Dubai time</small></h3>
            <DailyChart rows={daily} onPick={(o) => toggle("outcome", o)} tip={tip} series={series} />
            <div className="legendrow">
              {(["resolved", "transferred", "dropped", "other"] as const).map((k) => (
                <button key={k} type="button" className={series[k] ? "" : "off"} onClick={() => setSeries((x) => ({ ...x, [k]: !x[k] }))}><i style={{ background: OUTCOME_COLOR[k] }} />{OUTCOME_LABEL[k]}</button>
              ))}
            </div>
          </div>
          <div className="panel c4">
            <h3>Outcome share</h3>
            <Donut data={s.conversations.byOutcome} colors={OUTCOME_COLOR} labels={OUTCOME_LABEL} onPick={(k) => toggle("outcome", k)} tip={tip} total={s.conversations.total} />
            <h3 style={{ marginTop: 14 }}>Language · Modality · Channel</h3>
            <Bars rows={[...Object.entries(s.conversations.byLanguage).map(([k, v]) => ({ k: `language:${k}`, label: k === "ar" ? "Arabic" : "English", v: [v as number] })), ...Object.entries(s.conversations.byModality).map(([k, v]) => ({ k: `modality:${k}`, label: k, v: [v as number] })), ...Object.entries(s.conversations.byChannel).map(([k, v]) => ({ k: `channel:${k}`, label: k, v: [v as number] }))]} total={s.conversations.total} onPick={(k) => { const [dim, val] = k.split(":") as [keyof Filters, string]; toggle(dim, val); }} />
          </div>

          <div className="panel c6">
            <h3>Journeys <small>completed · abandoned · failed</small></h3>
            <Bars rows={journeyRows} segLabels={["completed", "abandoned", "failed"]} />
            <div className="legendrow"><span><i style={{ background: C.blue, display: "inline-block", width: 10, height: 10, borderRadius: 3 }} /> completed</span><span><i style={{ background: C.amber, display: "inline-block", width: 10, height: 10, borderRadius: 3 }} /> abandoned</span><span><i style={{ background: C.red, display: "inline-block", width: 10, height: 10, borderRadius: 3 }} /> failed</span></div>
          </div>
          <div className="panel c6">
            <h3>Guided booking funnel <small>from the action ledger</small></h3>
            <Funnel steps={s.funnel} />
            <div className="hint" style={{ marginTop: 10 }}>Drop-off between steps is where guests abandon: seat selection and payment are the usual culprits.</div>
          </div>

          <div className="panel c8">
            <h3>When guests talk to the assistant <small>weekday × hour, Dubai time</small></h3>
            <Heat heat={s.heat} tip={tip} />
          </div>
          <div className="panel c4">
            <h3>Top topics</h3>
            <Bars rows={(s.topics as [string, number][]).slice(0, 10).map(([k, v]) => ({ k, v: [v] }))} />
          </div>

          <div className="panel c6">
            <h3>Action reliability &amp; latency <small>p50 / p95 · success rate</small></h3>
            {actionsS.length ? (
              <table className="grid">
                <thead><tr><th>Action</th><th>Runs</th><th>Success</th><th>p50</th><th>p95</th><th style={{ width: "30%" }}>Latency</th></tr></thead>
                <tbody>
                  {actionsS.map((a) => (
                    <tr key={a.type}>
                      <td>{a.type}</td><td>{a.count}</td>
                      <td><span className={`pill ${a.successRate >= 97 ? "resolved" : a.successRate >= 90 ? "transferred" : "dropped"}`}>{a.successRate}%</span></td>
                      <td>{fmtMs(a.p50Ms)}</td><td>{fmtMs(a.p95Ms)}</td>
                      <td><span className="track" style={{ display: "flex", height: 10, background: "var(--bg-2)", borderRadius: 4, overflow: "hidden" }}><i style={{ display: "block", height: "100%", width: `${((a.p50Ms ?? 0) / latMax) * 100}%`, background: C.blue }} /><i style={{ display: "block", height: "100%", width: `${(((a.p95Ms ?? 0) - (a.p50Ms ?? 0)) / latMax) * 100}%`, background: C.blueLight, marginInlineStart: 2 }} /></span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty">No actions in this window.</div>}
          </div>
          <div className="panel c6">
            <h3>Transfers <small>{s.transfers.total} · avg wait {s.transfers.avgWaitSeconds != null ? `${s.transfers.avgWaitSeconds}s` : "–"}</small></h3>
            <Bars rows={Object.entries(s.transfers.reasons).map(([k, v]) => ({ k, v: [v as number] }))} />
            <h3 style={{ marginTop: 14 }}>Voice success by language</h3>
            <Bars rows={Object.entries(s.voice.byLanguage as Record<string, { total: number; resolved: number; dropped: number }>).map(([k, v]) => ({ k: `language:${k}`, label: `${k === "ar" ? "Arabic" : "English"} ${v.resolved}/${v.total}`, v: [v.total ? Math.round((v.resolved / v.total) * 100) : 0] }))} total={100} onPick={(k) => toggle("language", k.split(":")[1]!)} />
            <h3 style={{ marginTop: 14 }}>Feedback distribution</h3>
            <Bars rows={["5", "4", "3", "2", "1"].map((r) => ({ k: r, label: `${"★".repeat(Number(r))}`, v: [s.feedback.distribution[r] ?? 0] }))} />
          </div>

          <div className="panel">
            <h3>Conversations <small>{convs.length} shown · click a row for the transcript and actions</small></h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search id, topic, journey or customer…" style={{ flex: 1, border: "1px solid var(--line-2)", borderRadius: 8, padding: "7px 10px", fontSize: 13 }} /></div>
            <div className="tablewrap">
              <table className="grid">
                <thead><tr>{convSort.th("startedAt", "Started")}{convSort.th("id", "Id")}{convSort.th("language", "Lang")}{convSort.th("modality", "Mode")}{convSort.th("channel", "Channel")}{convSort.th("durationSeconds", "Duration")}{convSort.th("outcome", "Outcome")}<th>Journeys</th><th>Topics</th></tr></thead>
                <tbody>
                  {convSort.sorted.map((c) => (
                    <tr key={c.id} className={sel === c.id ? "sel" : ""} style={{ cursor: "pointer" }} onClick={() => setSel(c.id)}>
                      <td>{new Date(c.startedAt).toLocaleString()}</td>
                      <td style={{ fontFamily: "monospace" }}>{c.id.slice(0, 18)}{c.id.startsWith("demo_") ? <> <span className="pill demo">demo</span></> : null}</td>
                      <td>{c.language}</td><td>{c.modality}</td><td>{c.channel}</td><td>{c.durationSeconds ? fmtDur(c.durationSeconds) : "–"}</td>
                      <td><span className={`pill ${c.outcome ?? (c.status === "active" ? "active" : "")}`}>{c.outcome ?? (c.status === "active" ? "active" : "unknown")}</span></td>
                      <td>{(c.journeys ?? []).map((x: any, i: number) => <span key={i} className={`pill ${x.status}`} style={{ marginInlineEnd: 4 }}>{x.name}</span>)}</td>
                      <td>{(c.topics ?? []).join(", ")}</td>
                    </tr>
                  ))}
                  {!convs.length ? <tr><td colSpan={9} className="empty">No conversations match.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel c4">
            <h3>Complaints <small>{s.complaints.total} in window</small></h3>
            <Bars rows={Object.entries(s.complaints.byCategory).map(([k, v]) => ({ k, v: [v as number] }))} />
            <div className="tablewrap" style={{ maxHeight: 260, marginTop: 8 }}>
              <table className="grid"><thead><tr><th>Ref</th><th>Category</th><th>Status</th><th>Description</th></tr></thead><tbody>{complaints.slice(0, 30).map((c) => (<tr key={c.id} style={{ cursor: c.conversationId ? "pointer" : undefined }} onClick={() => c.conversationId && setSel(c.conversationId)}><td style={{ whiteSpace: "nowrap" }}>{c.id}</td><td>{c.category}</td><td><span className={`pill ${c.status}`}>{c.status}</span></td><td>{c.description.slice(0, 70)}</td></tr>))}</tbody></table>
            </div>
          </div>
          <div className="panel c4">
            <h3>Recent transfers</h3>
            <div className="tablewrap" style={{ maxHeight: 340 }}>
              <table className="grid"><thead><tr><th>When</th><th>Reason</th><th>Status</th><th>Agent</th></tr></thead><tbody>{transfers.slice(0, 30).map((t) => (<tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setSel(t.conversationId)}><td style={{ whiteSpace: "nowrap" }}>{new Date(t.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} {new Date(t.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td>{t.reason}</td><td><span className={`pill ${t.status === "ended" || t.status === "connected" ? "resolved" : t.status}`}>{t.status}</span></td><td>{t.agentName ?? ""}</td></tr>))}</tbody></table>
            </div>
          </div>
          <div className="panel c4">
            <h3>Latest feedback</h3>
            <div className="tablewrap" style={{ maxHeight: 340 }}>
              <table className="grid"><thead><tr><th>Rating</th><th>Comment</th><th>Lang</th></tr></thead><tbody>{feedback.slice(0, 30).map((x) => (<tr key={x.id} style={{ cursor: "pointer" }} onClick={() => setSel(x.conversationId)}><td className="stars-inline" style={{ whiteSpace: "nowrap" }}>{"★".repeat(x.rating)}{"☆".repeat(5 - x.rating)}</td><td>{x.comment || <span style={{ color: "var(--muted)" }}>—</span>}</td><td>{x.language}</td></tr>))}</tbody></table>
            </div>
          </div>
        </div>
      </div>
      {sel ? <Drawer id={sel} onClose={() => setSel(null)} /> : null}
    </div>
  );
}
