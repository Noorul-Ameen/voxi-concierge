/**
 * Voxi widget: ElevenLabs conversation (voice or text) + concierge SSE stream + rich cards.
 * All state changes go through the agent/concierge; the widget never talks to Vista directly.
 */
import { useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Lang, type Session, type UiHint, type WidgetEvent, createSession, devTool, getSignedUrl, getState, linkConversation, sendCommand, subscribe } from "../lib/api";
import { isRtl, t } from "../lib/i18n";
import { type CardActions, Cards, Feedback } from "./Cards";

type ItemBody =
  | { kind: "msg"; role: "user" | "agent" | "human"; text: string; who?: string }
  | { kind: "cards"; ui: UiHint }
  | { kind: "note"; text: string }
  | { kind: "feedback" };
type Item = ItemBody & { id: string };

let idc = 0;
const nid = () => `i${++idc}`;

export function Concierge({ initialLang = "en", onExpand }: { initialLang?: Lang; onExpand?: (b: boolean) => void }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState<"idle" | "voice" | "text">("idle");
  const [humanMode, setHumanMode] = useState<{ transferId: string; agentName?: string; status: string } | null>(null);
  const [input, setInput] = useState("");
  const [level, setLevel] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [sseStatus, setSseStatus] = useState<"open" | "closed">("closed");
  const dev = new URLSearchParams(window.location.search).get("dev") === "1";
  const [devName, setDevName] = useState("search_films");
  const [devInput, setDevInput] = useState('{"query":"spider"}');
  const bodyRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const push = useCallback((it: ItemBody) => setItems((xs) => [...xs, { ...it, id: nid() } as Item]), []);

  // ---------- client tools (called by the agent) ----------
  const clientTools = useMemo(
    () => ({
      render_cards: async (p: { ui: UiHint }) => {
        if (p?.ui?.type) push({ kind: "cards", ui: p.ui });
        return "rendered";
      },
      render_seat_map: async () => "The seat map will appear when get_seat_plan runs.",
      render_order_summary: async () => "The order summary is shown after each order step.",
      render_payment_sheet: async () => "The payment sheet appears after prepare_payment.",
      render_qr: async () => "The QR is shown when payment succeeds.",
      render_feedback: async () => {
        push({ kind: "feedback" });
        return "feedback shown";
      },
      request_location: async () => {
        try {
          const pos = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 }));
          const s = sessionRef.current;
          if (s) await sendCommand(s, { type: "location", lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy });
          return JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        } catch {
          return JSON.stringify({ error: "location_denied" });
        }
      },
      play_trailer: async (p: { youtubeId: string; title?: string }) => {
        window.open(`https://www.youtube.com/watch?v=${p.youtubeId}`, "_blank", "noopener");
        return "opened";
      },
      open_link: async (p: { url: string }) => {
        window.open(p.url, "_blank", "noopener");
        return "opened";
      },
      set_language: async (p: { language: Lang }) => {
        setLang(p.language);
        return "ok";
      },
      set_mode: async (p: { mode: "bot" | "human"; transferId?: string }) => {
        if (p.mode === "human" && p.transferId) setHumanMode({ transferId: p.transferId, status: "requested" });
        if (p.mode === "bot") setHumanMode(null);
        return "ok";
      },
      confirm_dialog: async (p: { title: string; body: string; confirmLabel?: string; cancelLabel?: string }) => {
        const ok = window.confirm(`${p.title}\n\n${p.body}`);
        return ok ? "confirmed" : "cancelled";
      },
    }),
    [push],
  );

  const conversation = useConversation({
    clientTools,
    onConnect: () => push({ kind: "note", text: lang === "ar" ? "متصل" : "Connected" }),
    onDisconnect: () => {
      setMode("idle");
      push({ kind: "note", text: lang === "ar" ? "انتهت المحادثة" : "Conversation ended" });
      push({ kind: "feedback" });
    },
    onError: (m: string) => push({ kind: "note", text: `⚠️ ${m}` }),
    onMessage: (m: { source: string; message: string }) => {
      if (!m.message) return;
      push({ kind: "msg", role: m.source === "user" ? "user" : "agent", text: m.message });
    },
  });

  // link ElevenLabs conversation id ↔ concierge conversation
  useEffect(() => {
    const id = conversation.getId();
    if (!id || !session || session.conversationId === id) return;
    linkConversation(session, id).then(setSession).catch(() => undefined);
  }, [conversation.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE subscription to concierge events
  useEffect(() => {
    if (!session) return;
    const onEvent = (e: WidgetEvent) => {
      switch (e.type) {
        case "ui.render":
          if (e.ui?.type) push({ kind: "cards", ui: e.ui });
          break;
        case "action.completed":
          if (e.ui?.type) push({ kind: "cards", ui: e.ui });
          else if (e.action.status !== "succeeded" && e.action.error?.message) push({ kind: "note", text: `⚠️ ${e.action.error.message}` });
          break;
        case "transfer.status":
          setHumanMode({ transferId: e.transferId, agentName: e.agentName, status: e.status });
          if (e.status === "ended") push({ kind: "note", text: t(lang, "transferEnded") });
          break;
        case "human.message":
          setHumanMode((h) => ({ transferId: e.transferId, agentName: e.agentName ?? h?.agentName, status: "connected" }));
          push({ kind: "msg", role: "human", text: e.text, who: e.agentName });
          break;
        case "language.changed":
          setLang(e.language);
          break;
        default:
          break;
      }
    };
    const unsub = subscribe(session, onEvent, setSseStatus);
    getState(session)
      .then((s) => {
        if (s.transfer && ["queued", "connected", "requested"].includes(s.transfer.status)) setHumanMode({ transferId: s.transfer.id, agentName: s.transfer.agentName, status: s.transfer.status });
      })
      .catch(() => undefined);
    return unsub;
  }, [session?.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // mic level meter
  useEffect(() => {
    if (mode !== "voice") return;
    const iv = setInterval(() => setLevel(Math.min(1, (conversation.getInputVolume?.() ?? 0) * 3)), 100);
    return () => clearInterval(iv);
  }, [mode, conversation]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [items]);
  useEffect(() => onExpand?.(expanded), [expanded, onExpand]);

  const start = async (m: "voice" | "text") => {
    setMode(m);
    const s = session ?? (await createSession({ language: lang, modality: m }));
    setSession(s);
    const { signedUrl, agentId, wsOrigin } = await getSignedUrl(s);
    const dyn = { ...s.dynamicVariables, language: lang, channel: "web" };
    try {
      if (m === "voice") {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const overrides = { agent: { language: lang }, conversation: { textOnly: m === "text" } } as const;
      // EU/IN data-residency workspaces live on a different host; the API tells the widget which one.
      const serverLocation = /eu\.residency/.test(wsOrigin ?? "")
        ? "eu-residency"
        : /in\.residency/.test(wsOrigin ?? "")
          ? "in-residency"
          : "us";
      const origin = { serverLocation };
      if (signedUrl)
        await conversation.startSession({ signedUrl, connectionType: "websocket", dynamicVariables: dyn, overrides, ...origin } as never);
      else await conversation.startSession({ agentId, connectionType: "websocket", dynamicVariables: dyn, overrides, ...origin } as never);
    } catch (e) {
      if (m === "voice" && String(e).match(/NotAllowed|Permission|denied/i)) {
        push({ kind: "note", text: t(lang, "micDenied") });
        return start("text");
      }
      push({ kind: "note", text: `⚠️ ${(e as Error).message}` });
      setMode("idle");
    }
  };

  const say = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      if (humanMode && session) {
        push({ kind: "msg", role: "user", text });
        void sendCommand(session, { type: "human.message", transferId: humanMode.transferId, text });
        return;
      }
      if (conversation.status === "connected") {
        conversation.sendUserMessage(text);
        if (mode === "text") push({ kind: "msg", role: "user", text });
      } else push({ kind: "note", text: lang === "ar" ? "ابدأ المحادثة أولاً" : "Start the conversation first" });
    },
    [conversation, humanMode, session, mode, lang, push],
  );

  const act: CardActions = useMemo(
    () => ({
      say,
      command: async (cmd) => (session ? sendCommand(session, cmd) : { ok: false, error: "no session" }),
      openLink: (url) => window.open(url, "_blank", "noopener"),
      playTrailer: (id) => window.open(`https://www.youtube.com/watch?v=${id}`, "_blank", "noopener"),
    }),
    [say, session],
  );

  const connected = conversation.status === "connected";
  const dir = isRtl(lang) ? "rtl" : "ltr";
  return (
    <div className={`widget ${expanded ? "expanded" : ""}`} dir={dir}>
      <div className="widget-head">
        <div className={`orb ${conversation.isSpeaking ? "speaking" : ""}`} />
        <div className="titles">
          <b>{t(lang, "title")}</b>
          <small>{humanMode ? `${t(lang, "human")}${humanMode.agentName ? ` · ${humanMode.agentName}` : ""}` : t(lang, "subtitle")}</small>
        </div>
        <span className="status" title={`events: ${sseStatus}`}>
          {connected ? (conversation.isSpeaking ? t(lang, "speaking") : mode === "voice" ? t(lang, "listening") : "●") : conversation.status === "connecting" ? t(lang, "connecting") : ""}
        </span>
        <div className="langtoggle" role="group" aria-label="language">
          <button className={lang === "en" ? "on" : ""} onClick={() => { setLang("en"); if (connected) conversation.sendUserMessage("Please continue in English."); }}>
            EN
          </button>
          <button className={lang === "ar" ? "on" : ""} onClick={() => { setLang("ar"); if (connected) conversation.sendUserMessage("من فضلك تابع بالعربية."); }}>
            ع
          </button>
        </div>
        <button className="iconbtn" onClick={() => setExpanded((x) => !x)} title="expand">
          {expanded ? "⤡" : "⤢"}
        </button>
        {connected ? (
          <button className="iconbtn" onClick={() => conversation.endSession()}>
            {t(lang, "end")}
          </button>
        ) : null}
      </div>

      <div className="widget-body" ref={bodyRef}>
        {mode === "idle" && !items.length ? (
          <div className="start">
            <div className="orb" style={{ width: 64, height: 64, borderRadius: "50%", background: "conic-gradient(from 180deg, #e4002b, #ff6b81, #e4002b)" }} />
            <p>{lang === "ar" ? "اسألني عن الأفلام والمواعيد والحجوزات والاسترداد والعروض والمأكولات — بالصوت أو الكتابة." : "Ask me about movies, showtimes, bookings, refunds, offers and food — by voice or text."}</p>
            <button className="btn primary" onClick={() => start("voice")}>
              🎙 {t(lang, "startVoice")}
            </button>
            <button className="btn ghost" onClick={() => start("text")}>
              💬 {t(lang, "startText")}
            </button>
          </div>
        ) : null}
        {items.map((it) =>
          it.kind === "msg" ? (
            <div key={it.id} className={`msg ${it.role}`}>
              {it.role !== "user" ? <span className="who">{it.role === "human" ? (it.who ?? t(lang, "human")) : t(lang, "agent")}</span> : null}
              {it.text}
            </div>
          ) : it.kind === "cards" ? (
            <Cards key={it.id} ui={it.ui} lang={lang} act={act} />
          ) : it.kind === "feedback" ? (
            <div key={it.id} className="cards">
              <Feedback lang={lang} act={act} />
            </div>
          ) : (
            <div key={it.id} className="sysnote">
              {it.text}
            </div>
          ),
        )}
        {humanMode && humanMode.status !== "ended" ? <div className="transfer">{humanMode.status === "connected" ? `${t(lang, "connectedTo")} ${humanMode.agentName ?? t(lang, "human")}` : t(lang, "transferring")}</div> : null}
      </div>

      {dev ? (
        <div className="widget-foot" style={{ background: "#fff8e1", flexWrap: "wrap" }} data-testid="devpanel">
          <input style={{ flex: "0 0 160px" }} value={devName} onChange={(e) => setDevName(e.target.value)} placeholder="tool name" />
          <input style={{ flex: 1 }} value={devInput} onChange={(e) => setDevInput(e.target.value)} placeholder='{"query":"…"}' />
          <button
            className="btn"
            onClick={async () => {
              const s = session ?? (await createSession({ language: lang, modality: "text" }));
              setSession(s);
              if (mode === "idle") setMode("text");
              push({ kind: "msg", role: "user", text: `[dev] ${devName} ${devInput}` });
              const r = await devTool(s, devName, JSON.parse(devInput || "{}"));
              push({ kind: "msg", role: "agent", text: r.speech ?? r.error?.message ?? JSON.stringify(r).slice(0, 300) });
            }}
          >
            Run
          </button>
        </div>
      ) : null}
      <div className="widget-foot">
        {mode === "voice" && connected ? (
          <div className="voicebar" style={{ flex: 1 }}>
            <button className="btn ghost" onClick={() => conversation.setVolume({ volume: 1 })} title="volume">
              🔊
            </button>
            <div className="level">
              <i style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
          </div>
        ) : null}
        <input value={input} placeholder={t(lang, "placeholder")} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { say(input); setInput(""); } }} onFocus={() => connected && conversation.sendUserActivity()} disabled={mode === "idle" && !humanMode} />
        <button className="btn primary" disabled={(!connected && !humanMode) || !input.trim()} onClick={() => { say(input); setInput(""); }}>
          {t(lang, "send")}
        </button>
      </div>
    </div>
  );
}
