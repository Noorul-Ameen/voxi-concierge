import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { reportingConversation, reportingList, reportingSummary } from "../lib/api";

function Bars({ data, total }: { data: Record<string, number> | [string, number][]; total?: number }) {
  const rows = Array.isArray(data) ? data : Object.entries(data);
  const max = Math.max(1, ...rows.map(([, v]) => v));
  return (
    <div>
      {rows.map(([k, v]) => (
        <div className="bar" key={k}>
          <span className="muted">{k}</span>
          <i style={{ width: `${(v / (total ?? max)) * 100}%` }} />
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

export function Dashboard() {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<any>(null);
  const [convs, setConvs] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [complaints, setComplaints] = useState<any[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);
  useEffect(() => {
    reportingSummary(days).then(setS).catch(() => setS({ error: true }));
    reportingList("conversations").then((r) => setConvs(r.conversations ?? [])).catch(() => undefined);
    reportingList("complaints").then((r) => setComplaints(r.complaints ?? [])).catch(() => undefined);
    reportingList("transfers").then((r) => setTransfers(r.transfers ?? [])).catch(() => undefined);
  }, [days]);
  if (!s) return <div className="dash">Loading…</div>;
  if (s.error) return <div className="dash">Reporting API unavailable.</div>;
  const j = s.journeys as Record<string, { completed: number; abandoned: number; failed: number }>;
  return (
    <div className="backdrop">
      <header className="topbar">
        <div className="brand">
          <div className="logo">V</div>
          <span>VOXI INSIGHTS</span>
        </div>
        <nav>
          <Link to="/">Demo</Link>
          <Link to="/dashboard" className="active">
            Dashboard
          </Link>
        </nav>
      </header>
      <div className="dash">
        <h1>Reporting & insights</h1>
        <div className="sub">
          Last{" "}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ background: "#222", color: "#fff", border: "1px solid #444", borderRadius: 6 }}>
            {[1, 7, 30, 90].map((d) => (
              <option key={d} value={d}>
                {d} day{d > 1 ? "s" : ""}
              </option>
            ))}
          </select>{" "}
          · conversations, journeys, drop-offs, transfers, topics, feedback
        </div>
        <div className="kpis">
          <div className="kpi"><b>{s.conversations.total}</b><small>Conversations</small></div>
          <div className="kpi"><b>{s.containment.rate}%</b><small>Contained (resolved by Voxi)</small></div>
          <div className="kpi"><b>{s.containment.transferred}</b><small>Transferred to agent</small></div>
          <div className="kpi"><b>{s.containment.dropped}</b><small>Dropped</small></div>
          <div className="kpi"><b>{s.feedback.avgRating ?? "–"}</b><small>Avg rating ({s.feedback.count})</small></div>
          <div className="kpi"><b>{Math.round(s.conversations.avgDurationSeconds / 60)}m</b><small>Avg duration</small></div>
        </div>
        <div className="panels">
          <div className="panel"><h3>Journeys (completed)</h3><Bars data={Object.fromEntries(Object.entries(j).map(([k, v]) => [k, v.completed]))} /></div>
          <div className="panel"><h3>Journeys abandoned / failed</h3><Bars data={Object.fromEntries(Object.entries(j).map(([k, v]) => [k, v.abandoned + v.failed]))} /></div>
          <div className="panel"><h3>Top topics</h3><Bars data={s.topics} /></div>
          <div className="panel"><h3>Transfer reasons</h3><Bars data={s.transfers.reasons} /></div>
          <div className="panel"><h3>Language</h3><Bars data={s.conversations.byLanguage} total={s.conversations.total} /><h3 style={{ marginTop: 12 }}>Modality</h3><Bars data={s.conversations.byModality} total={s.conversations.total} /></div>
          <div className="panel"><h3>Voice success by language</h3><Bars data={Object.fromEntries(Object.entries(s.voice.byLanguage as Record<string, { total: number; resolved: number }>).map(([k, v]) => [`${k} (${v.resolved}/${v.total})`, v.total ? Math.round((v.resolved / v.total) * 100) : 0]))} total={100} /></div>
          <div className="panel"><h3>Actions</h3><Bars data={Object.fromEntries((s.actions as { type: string; status: string; count: number }[]).map((a) => [`${a.type} · ${a.status}`, a.count]))} /></div>
          <div className="panel"><h3>Feedback distribution</h3><Bars data={s.feedback.distribution} /></div>
        </div>
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>Recent conversations</h3>
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead><tr><th>Started</th><th>Id</th><th>Lang</th><th>Mode</th><th>Channel</th><th>Outcome</th><th>Journeys</th><th>Topics</th></tr></thead>
              <tbody>
                {convs.slice(0, 40).map((c) => (
                  <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => reportingConversation(c.id).then(setDetail)}>
                    <td>{new Date(c.startedAt).toLocaleString()}</td>
                    <td style={{ fontFamily: "monospace" }}>{c.id.slice(0, 18)}</td>
                    <td>{c.language}</td>
                    <td>{c.modality}</td>
                    <td>{c.channel}</td>
                    <td><span className={`pill ${c.outcome ?? ""}`}>{c.outcome ?? (c.status === "active" ? "active" : "unknown")}</span></td>
                    <td>{(c.journeys ?? []).map((x: any) => `${x.name}:${x.status[0]}`).join(" ")}</td>
                    <td>{(c.topics ?? []).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {detail ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <h3>Conversation {detail.conversation?.id}</h3>
            {detail.transcript?.summary ? <p>{detail.transcript.summary}</p> : null}
            <table className="grid">
              <thead><tr><th>#</th><th>Type</th><th>Actor</th><th>Payload</th></tr></thead>
              <tbody>
                {(detail.events ?? []).map((e: any) => (
                  <tr key={e.id}><td>{e.seq}</td><td>{e.type}</td><td>{e.actor}</td><td style={{ fontFamily: "monospace", fontSize: 11 }}>{JSON.stringify(e.payload).slice(0, 160)}</td></tr>
                ))}
              </tbody>
            </table>
            <h3 style={{ marginTop: 12 }}>Actions</h3>
            <table className="grid">
              <thead><tr><th>Type</th><th>Status</th><th>Attempts</th><th>Result / error</th></tr></thead>
              <tbody>
                {(detail.actions ?? []).map((a: any) => (
                  <tr key={a.id}><td>{a.type}</td><td><span className={`pill ${a.status}`}>{a.status}</span></td><td>{a.attempts}</td><td style={{ fontSize: 11 }}>{a.error?.message ?? a.result?.speech?.slice(0, 160)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="panels" style={{ marginTop: 14 }}>
          <div className="panel">
            <h3>Complaints</h3>
            <table className="grid"><thead><tr><th>Ref</th><th>Category</th><th>Status</th><th>Description</th></tr></thead><tbody>{complaints.slice(0, 20).map((c) => (<tr key={c.id}><td>{c.id}</td><td>{c.category}</td><td>{c.status}</td><td>{c.description.slice(0, 80)}</td></tr>))}</tbody></table>
          </div>
          <div className="panel">
            <h3>Transfers</h3>
            <table className="grid"><thead><tr><th>When</th><th>Reason</th><th>Adapter</th><th>Status</th><th>Agent</th></tr></thead><tbody>{transfers.slice(0, 20).map((c) => (<tr key={c.id}><td>{new Date(c.createdAt).toLocaleTimeString()}</td><td>{c.reason}</td><td>{c.adapter}</td><td>{c.status}</td><td>{c.agentName ?? ""}</td></tr>))}</tbody></table>
          </div>
        </div>
      </div>
    </div>
  );
}
