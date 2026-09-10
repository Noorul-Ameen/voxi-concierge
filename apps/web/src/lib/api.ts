/** Concierge API client for the widget: session token, commands, SSE events, reporting. */
export type Lang = "en" | "ar";
declare global {
  interface Window {
    /** Set by the embed loader (or a host page) before the widget mounts: `{ apiBase: "https://…/api" }`. */
    VoxiConfig?: { apiBase?: string; lang?: Lang; open?: boolean; theme?: string; vars?: Record<string, string>; hostLoginSelector?: string };
  }
}
export let API_BASE = (typeof window !== "undefined" && window.VoxiConfig?.apiBase) || (import.meta.env.VITE_API_BASE as string | undefined) || "/api";
/** The embed resolves script attributes after imports have evaluated. */
export function configureApiBase(value: string) { API_BASE = value.replace(/\/$/, ""); }

export type UiHint = { type: string; title?: string; items: Record<string, any>[]; actions?: { label: string; value: string; style?: string }[]; meta?: Record<string, any> };
export type WidgetEvent = (
  | { type: "ui.render"; seq: number; ui: UiHint }
  | { type: "action.queued"; seq: number; action: ActionRef }
  | { type: "action.completed"; seq: number; action: ActionRef; ui?: UiHint }
  | { type: "order.updated"; seq: number; userSessionId: string; summary: Record<string, any> }
  | { type: "transfer.status"; seq: number; transferId: string; status: string; agentName?: string }
  | { type: "human.message"; seq: number; transferId: string; text: string; agentName?: string }
  | { type: "language.changed"; seq: number; language: Lang }
  | { type: "heartbeat"; seq: number; at: string }) & { eventId?: string };
export type ActionRef = { actionId: string; type: string; status: string; result?: Record<string, any>; error?: { code: string; message: string } };

export type Session = { conversationId: string; token: string; language: Lang; mode: "bot" | "human"; isLoggedIn: boolean; agentId: string; dynamicVariables: Record<string, string> };

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export const isAuthorizationError = (error: unknown): error is ApiError => error instanceof ApiError && (error.status === 401 || error.status === 403);

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function createSession(input: { language: Lang; modality: "voice" | "text"; conversationId?: string; token?: string }): Promise<Session> {
  const { token, ...body } = input;
  return json(await fetch(`${API_BASE}/widget/session`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ ...body, channel: "web" }) }));
}

export async function linkConversation(session: Session, elevenLabsConversationId: string): Promise<Session> {
  const r = await json<{ ok: boolean; conversationId?: string; token?: string }>(await fetch(`${API_BASE}/widget/link`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ elevenLabsConversationId }) }));
  return r.conversationId && r.token ? { ...session, conversationId: r.conversationId, token: r.token } : session;
}

export type CommandResult = { ok: boolean; data?: Record<string, any>; ui?: UiHint; speech?: string; action?: ActionRef; error?: string };
export async function sendCommand(session: Session, cmd: Record<string, unknown>): Promise<CommandResult> {
  const res = await fetch(`${API_BASE}/widget/command`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify(cmd) });
  return (await res.json()) as CommandResult;
}

export async function getState(session: Session, signal?: AbortSignal) {
  return json<{ conversation: Record<string, any>; transfer?: Record<string, any> }>(await fetch(`${API_BASE}/widget/state`, { headers: { authorization: `Bearer ${session.token}` }, signal }));
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

/** An old expiry result must never clear a newer account, login attempt or conversation. */
export function sessionExpiryHandler(expected: Session, epoch: number, current: () => { session: Session | null; epoch: number; busy: boolean }, expire: () => void): () => void {
  let handled = false;
  return () => {
    const now = current();
    if (handled || now.busy || now.epoch !== epoch || now.session?.token !== expected.token || now.session.conversationId !== expected.conversationId) return;
    handled = true;
    expire();
  };
}

/** Retry transport failures; a confirmed authentication failure terminates this subscription. */
export function subscribe(session: Session, onEvent: (e: WidgetEvent) => void, onStatus?: (s: "open" | "closed") => void, onAuthInvalid?: () => void): () => void {
  let es: EventSource | null = null;
  let last = 0;
  let closed = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probe: AbortController | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (probeTimer) clearTimeout(probeTimer);
    probe?.abort();
    es?.close();
  };
  const reconnect = () => {
    if (!closed) timer = setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
  };
  const connect = () => {
    if (closed) return;
    const source = new EventSource(`${API_BASE}/widget/events?token=${encodeURIComponent(session.token)}&after=${last}`);
    es = source;
    const handler = (ev: MessageEvent) => {
      if (closed || es !== source) return;
      try {
        const data = JSON.parse(ev.data) as WidgetEvent;
        if (typeof data.seq === "number" && data.seq > last) last = data.seq;
        if (data.type !== "heartbeat") onEvent(data);
      } catch {
        /* ignore */
      }
    };
    for (const t of ["ui.render", "action.queued", "action.completed", "order.updated", "transfer.status", "human.message", "language.changed", "heartbeat"]) source.addEventListener(t, handler as EventListener);
    source.onopen = () => {
      if (closed || es !== source) return;
      retry = 1000;
      onStatus?.("open");
    };
    source.onerror = () => {
      if (closed || es !== source || probe) return;
      source.close();
      onStatus?.("closed");
      // EventSource hides HTTP status. Confirm with the same token before clearing any account state.
      const checking = new AbortController();
      probe = checking;
      probeTimer = setTimeout(() => checking.abort(), 5000);
      void getState(session, checking.signal).then(reconnect, (error) => {
        if (closed) return;
        if (isAuthorizationError(error)) {
          stop();
          onAuthInvalid?.();
        } else reconnect();
      }).finally(() => {
        if (probeTimer) clearTimeout(probeTimer);
        if (probe === checking) probe = null;
      });
    };
  };
  connect();
  return stop;
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

export type ViewingTime = { from: string; to: string; around: string; sampleCount: number };
export type CustomerProfile = { movieLanguage: string | null; cinemaId: string | null; cinemaName: string | null; weekday: ViewingTime | null; weekend: ViewingTime | null; seatPreference: "front" | "middle" | "back" | "aisle" | null; historyCount: number; timeZone: string; weekendDays: number[] };
export type BookingHistory = { filmTitle: string; language: string; cinemaId?: string; cinemaName?: string; showtime: string; experience?: string; ticketCount: number; spendCents: number; seatPreference?: string; dayType?: "weekday" | "weekend"; synthetic?: boolean };
export type Customer = { id: string; firstName: string; lastName: string; email?: string; memberId: string | null; tier: string; sharePoints: number; voxCreditCents: number; voxRewardsCents?: number; savedCards?: { brand?: string; masked?: string; last4?: string; label?: string; default?: boolean }[]; profile?: CustomerProfile };
export async function getCustomerProfile(session: Session): Promise<{ customer: Customer; profile: CustomerProfile | null; history: BookingHistory[] }> {
  const result = await json<{ customer: Customer; profile?: CustomerProfile; history?: BookingHistory[] }>(await fetch(`${API_BASE}/widget/profile`, { headers: { authorization: `Bearer ${session.token}` } }));
  return { customer: result.customer, profile: result.profile ?? result.customer.profile ?? null, history: result.history ?? [] };
}
export async function widgetLogin(session: Session, email: string, password: string): Promise<{ ok: boolean; error?: string; token?: string; customer?: Customer; dynamicVariables?: Record<string, string> }> {
  const r = await fetch(`${API_BASE}/widget/login`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ email, password }) });
  return (await r.json()) as { ok: boolean; error?: string; token?: string; customer?: Customer; dynamicVariables?: Record<string, string> };
}
export async function widgetLogout(session: Session): Promise<{ ok: boolean; token?: string; dynamicVariables?: Record<string, string> }> {
  const r = await fetch(`${API_BASE}/widget/logout`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: "{}" });
  return (await r.json()) as { ok: boolean; token?: string; dynamicVariables?: Record<string, string> };
}
