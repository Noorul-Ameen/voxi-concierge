/** Concierge API client for the widget: session token, commands, SSE events, reporting. */
export type Lang = "en" | "ar";
declare global {
  interface Window {
    /** Set by the embed loader (or a host page) before the widget mounts: `{ apiBase: "https://…/api" }`. */
    VoxiConfig?: { apiBase?: string; lang?: Lang; open?: boolean; theme?: string; vars?: Record<string, string> };
  }
}
export const API_BASE = (typeof window !== "undefined" && window.VoxiConfig?.apiBase) || (import.meta.env.VITE_API_BASE as string | undefined) || "/api";

export type UiHint = { type: string; title?: string; items: Record<string, any>[]; actions?: { label: string; value: string; style?: string }[]; meta?: Record<string, any> };
export type WidgetEvent =
  | { type: "ui.render"; seq: number; ui: UiHint }
  | { type: "action.queued"; seq: number; action: ActionRef }
  | { type: "action.completed"; seq: number; action: ActionRef; ui?: UiHint }
  | { type: "order.updated"; seq: number; userSessionId: string; summary: Record<string, any> }
  | { type: "transfer.status"; seq: number; transferId: string; status: string; agentName?: string }
  | { type: "human.message"; seq: number; transferId: string; text: string; agentName?: string }
  | { type: "language.changed"; seq: number; language: Lang }
  | { type: "heartbeat"; seq: number; at: string };
export type ActionRef = { actionId: string; type: string; status: string; result?: Record<string, any>; error?: { code: string; message: string } };

export type Session = { conversationId: string; token: string; language: Lang; mode: "bot" | "human"; isLoggedIn: boolean; agentId: string; dynamicVariables: Record<string, string> };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function createSession(input: { language: Lang; modality: "voice" | "text"; conversationId?: string }): Promise<Session> {
  return json(await fetch(`${API_BASE}/widget/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, channel: "web" }) }));
}

export async function linkConversation(session: Session, elevenLabsConversationId: string): Promise<Session> {
  const r = await json<{ ok: boolean; conversationId?: string; token?: string }>(await fetch(`${API_BASE}/widget/link`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ elevenLabsConversationId }) }));
  return r.conversationId && r.token ? { ...session, conversationId: r.conversationId, token: r.token } : session;
}

export async function sendCommand(session: Session, cmd: Record<string, unknown>): Promise<{ ok: boolean; action?: ActionRef; error?: string }> {
  const res = await fetch(`${API_BASE}/widget/command`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify(cmd) });
  return (await res.json()) as { ok: boolean; action?: ActionRef; error?: string };
}

export async function getState(session: Session) {
  return json<{ conversation: Record<string, any>; transfer?: Record<string, any> }>(await fetch(`${API_BASE}/widget/state`, { headers: { authorization: `Bearer ${session.token}` } }));
}

export async function getSignedUrl(session: Session): Promise<{ signedUrl?: string; agentId: string; wsOrigin?: string }> {
  const res = await fetch(`${API_BASE}/widget/signed-url`, { headers: { authorization: `Bearer ${session.token}` } });
  if (!res.ok) {
    try {
      const j = (await res.json()) as { wsOrigin?: string };
      return { agentId: session.agentId, wsOrigin: j.wsOrigin };
    } catch {
      return { agentId: session.agentId };
    }
  }
  return (await res.json()) as { signedUrl?: string; agentId: string; wsOrigin?: string };
}

/** Subscribe to widget events (SSE). Returns an unsubscribe function. Reconnects with backoff. */
export function subscribe(session: Session, onEvent: (e: WidgetEvent) => void, onStatus?: (s: "open" | "closed") => void): () => void {
  let es: EventSource | null = null;
  let last = 0;
  let closed = false;
  let retry = 1000;
  const connect = () => {
    if (closed) return;
    es = new EventSource(`${API_BASE}/widget/events?token=${encodeURIComponent(session.token)}&after=${last}`);
    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as WidgetEvent;
        if (typeof data.seq === "number" && data.seq > last) last = data.seq;
        if (data.type !== "heartbeat") onEvent(data);
      } catch {
        /* ignore */
      }
    };
    for (const t of ["ui.render", "action.queued", "action.completed", "order.updated", "transfer.status", "human.message", "language.changed", "heartbeat"]) es.addEventListener(t, handler as EventListener);
    es.onopen = () => {
      retry = 1000;
      onStatus?.("open");
    };
    es.onerror = () => {
      es?.close();
      onStatus?.("closed");
      if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
  };
}

export type ReportingFilters = { days?: number; language?: string; modality?: string; channel?: string; outcome?: string; demo?: "include" | "exclude" | "only"; q?: string; limit?: number };
const qs = (f: ReportingFilters) =>
  Object.entries(f)
    .filter(([, v]) => v !== undefined && v !== "" && v !== "all")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
export async function reportingSummary(f: ReportingFilters = {}) {
  return json<Record<string, any>>(await fetch(`${API_BASE}/reporting/summary?${qs(f)}`));
}
export async function reportingList(kind: "conversations" | "complaints" | "feedback" | "transfers" | "actions", f: ReportingFilters = {}) {
  return json<Record<string, any>>(await fetch(`${API_BASE}/reporting/${kind}?${qs(f)}`));
}
export async function reportingConversation(id: string) {
  return json<Record<string, any>>(await fetch(`${API_BASE}/reporting/conversations/${encodeURIComponent(id)}`));
}

/** Dev bridge (DEV_TOOL_BRIDGE=true on the API): call a tool directly, bypassing the voice agent. */
export async function devTool(session: Session, name: string, input: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/widget/dev-tool`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ name, input }) });
  return (await res.json()) as { ok: boolean; speech?: string; error?: { message: string }; data?: any };
}

export type Customer = { id: string; firstName: string; lastName: string; memberId: string | null; tier: string; sharePoints: number; voxCreditCents: number };
export async function widgetLogin(session: Session, identifier: string, pin: string): Promise<{ ok: boolean; error?: string; token?: string; customer?: Customer; dynamicVariables?: Record<string, string> }> {
  const r = await fetch(`${API_BASE}/widget/login`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ identifier, pin }) });
  return (await r.json()) as { ok: boolean; error?: string; token?: string; customer?: Customer; dynamicVariables?: Record<string, string> };
}
export async function widgetLogout(session: Session): Promise<{ ok: boolean; token?: string; dynamicVariables?: Record<string, string> }> {
  const r = await fetch(`${API_BASE}/widget/logout`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: "{}" });
  return (await r.json()) as { ok: boolean; token?: string; dynamicVariables?: Record<string, string> };
}
