/**
 * Voxi widget: ElevenLabs conversation (voice or text) + concierge SSE stream + rich cards.
 * All state changes go through the agent/concierge; the widget never talks to Vista directly.
 */
import { useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Lang, type Session, type UiHint, type WidgetEvent, createSession, devTool, getSignedUrl, getState, linkConversation, sendCommand, subscribe } from "../lib/api";
import { isRtl, t } from "../lib/i18n";
import { type CardActions, Cards, Feedback } from "./Cards";
import { type Loc, LocationBar } from "./LocationBar";

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
  const [loc, setLoc] = useState<Loc | null>(() => {
    try {
      const raw = localStorage.getItem("voxi.loc");
      return raw ? (JSON.parse(raw) as Loc) : null;
    } catch {
      return null;
    }
  });
  const locRef = useRef<Loc | null>(loc);
  locRef.current = loc;
  const changeLoc = (l: Loc | null) => {
    setLoc(l);
    try {
      if (l) localStorage.setItem("voxi.loc", JSON.stringify(l));
      else localStorage.removeItem("voxi.loc");
    } catch {}
    const s = sessionRef.current;
    if (s) void sendCommand(s, l ? { type: "location", lat: l.lat, lng: l.lng, accuracyM: l.accuracyM, label: l.label, source: l.source } : { type: "location.clear" });
  };
  const dev = new URLSearchParams(window.location.search).get("dev") === "1";
  const [devName, setDevName] = useState("search_films");
  const [devInput, setDevInput] = useState('{"query":"spider"}');
  const bodyRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const statusRef = useRef<string>("disconnected"); // live connection status for callbacks that outlive a render
  const push = useCallback((it: ItemBody) => setItems((xs) => [...xs, { ...it, id: nid() } as Item]), []);

  // ---------- client tools (called by the agent) ----------
  const clientTools = useMemo(
    () => ({
      render_cards: async (p: { ui: UiHint }) => {
        if (p?.ui?.type) push({ kind: "cards", ui: p.ui });
        return "rendered";
      },
      render_seat_map: async (p: { sessionKey: string; userSessionId?: string }) => {
        // fetch the live seat plan for this order and draw it — no need for the agent to call get_seat_plan first
        const s = sessionRef.current;
        if (!s) return "widget not ready";
        const r = (await sendCommand(s, { type: "seat.plan", sessionKey: p.sessionKey, userSessionId: p.userSessionId })) as { ok: boolean; ui?: any; error?: string };
        if (r.ok && r.ui) {
          push({ kind: "cards", ui: r.ui });
          return "seat map is on screen";
        }
        return `could not show the seat map: ${r.error ?? "unknown"}`;
      },
      render_order_summary: async () => "The order summary is shown after each order step.",
      render_payment_sheet: async () => "The payment sheet appears after prepare_payment.",
      render_qr: async () => "The QR is shown when payment succeeds.",
      render_feedback: async () => {
        push({ kind: "feedback" });
        return "feedback shown";
      },
      request_location: async () => {
        const known = locRef.current;
        if (known) return JSON.stringify({ lat: known.lat, lng: known.lng, label: known.label, source: known.source });
        try {
          const pos = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 }));
          const l: Loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, label: lang === "ar" ? "موقعي الحالي" : "My current location", source: "gps" };
          changeLoc(l);
          return JSON.stringify({ lat: l.lat, lng: l.lng, label: l.label, source: "gps" });
        } catch {
          return JSON.stringify({ error: "location_denied", hint: "ask the guest to tap the location button in the chat or name an area" });
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

  statusRef.current = conversation.status;

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
  // a location chosen before the conversation started is sent as soon as a session exists
  useEffect(() => {
    const l = locRef.current;
    if (session && l) void sendCommand(session, { type: "location", lat: l.lat, lng: l.lng, accuracyM: l.accuracyM, label: l.label, source: l.source });
  }, [session]);

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
      // `textOnly` at the top level selects the SDK's text transport (no microphone / AudioContext at all);
      // the conversation override only tells the agent side. Without it, text mode still waits on a mic permission.
      const origin = { serverLocation, textOnly: m === "text" };
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

  /** Switch between voice and text without losing the concierge session (same conversation, cards, order). */
  const switchMode = async (m: "voice" | "text") => {
    if (connected) await conversation.endSession();
    await start(m);
  };

  const say = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      if (humanMode && session) {
        push({ kind: "msg", role: "user", text });
        void sendCommand(session, { type: "human.message", transferId: humanMode.transferId, text });
        return;
      }
      if (statusRef.current === "connected") {
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
  // ---------- presentation-only state (launcher, unread badge, typing indicator, suggestions) ----------
  const [open, setOpen] = useState(true);
  const [unread, setUnread] = useState(0);
  const lastItem = items[items.length - 1];
  useEffect(() => {
    if (!open && lastItem && lastItem.kind !== "note") setUnread((n) => n + 1);
  }, [lastItem?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);
  const thinking = connected && !humanMode && lastItem?.kind === "msg" && lastItem.role === "user" && !conversation.isSpeaking;
  const suggestions = lang === "ar"
    ? ["ماذا يُعرض الليلة في مول الإمارات؟", "احجز تذكرتين لفيلم عائلي غداً", "ألغِ حجزي WXA7K2M", "ما هي عروض البنوك؟"]
    : ["What's on tonight at Mall of the Emirates?", "Book two tickets for a family movie tomorrow", "Cancel my booking WXA7K2M", "Which bank offers are on?"];
  const ask = async (text: string) => {
    if (!connected) await start("text");
    // the socket connects asynchronously — wait for it (up to 20 s) before sending the suggestion
    for (let i = 0; i < 66 && statusRef.current !== "connected"; i++) await new Promise((r) => setTimeout(r, 300));
    say(text);
  };
  const statusText = connected
    ? conversation.isSpeaking
      ? t(lang, "speaking")
      : mode === "voice"
        ? t(lang, "listening")
        : t(lang, "online")
    : conversation.status === "connecting"
      ? t(lang, "connecting")
      : "";
  const voiceState = !connected ? "off" : conversation.isSpeaking ? "speaking" : mode === "voice" ? "listening" : "idle";

  if (!open)
    return (
      <button className="launcher" dir={dir} onClick={() => setOpen(true)} aria-label={t(lang, "askVoxi")}>
        <span className={`orb ${voiceState}`} />
        <span className="lbl">{t(lang, "askVoxi")}</span>
        {unread ? <span className="unread">{unread}</span> : null}
      </button>
    );

  return (
    <div className={`widget ${expanded ? "expanded" : ""} state-${voiceState}`} dir={dir}>
      <div className="widget-head">
        <div className={`orb ${voiceState}`} aria-hidden="true">
          <i /><i /><i />
        </div>
        <div className="titles">
          <b>{t(lang, "title")}</b>
          <small>
            {statusText ? <span className={`dot ${voiceState}`} /> : null}
            {humanMode ? `${t(lang, "human")}${humanMode.agentName ? ` · ${humanMode.agentName}` : ""}` : statusText || t(lang, "subtitle")}
          </small>
        </div>
        <div className="langtoggle" role="group" aria-label="language" title={`events: ${sseStatus}`}>
          <button className={lang === "en" ? "on" : ""} onClick={() => { setLang("en"); if (connected) conversation.sendUserMessage("Please continue in English."); }}>
            EN
          </button>
          <button className={lang === "ar" ? "on" : ""} onClick={() => { setLang("ar"); if (connected) conversation.sendUserMessage("من فضلك تابع بالعربية."); }}>
            ع
          </button>
        </div>
        <button className="iconbtn" onClick={() => setExpanded((x) => !x)} title="expand" aria-label="expand">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{expanded ? <path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" /> : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}</svg>
        </button>
        {connected ? (
          <button className="iconbtn end" onClick={() => conversation.endSession()} title={t(lang, "end")}>
            {t(lang, "end")}
          </button>
        ) : null}
        <button className="iconbtn" onClick={() => setOpen(false)} title={t(lang, "minimise")} aria-label={t(lang, "minimise")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14" /></svg>
        </button>
      </div>

      <LocationBar lang={lang} loc={loc} onChange={changeLoc} />

      <div className="widget-body" ref={bodyRef}>
        {mode !== "idle" && !items.length && !connected ? (
          <div className="start">
            <div className="hero-orb listening"><i /><i /><i /></div>
            <p>{t(lang, "connecting")}</p>
          </div>
        ) : null}
        {mode === "idle" && !items.length ? (
          <div className="start">
            <div className="hero-orb"><i /><i /><i /></div>
            <h3>{lang === "ar" ? "مرحباً، أنا فوكسي" : "Hi, I'm Voxi"}</h3>
            <p>{lang === "ar" ? "اسألني عن الأفلام والمواعيد والحجوزات والاسترداد والعروض والمأكولات — بالصوت أو الكتابة." : "Movies, showtimes, bookings, refunds, offers and food — by voice or text, in English or Arabic."}</p>
            <div className="startbtns">
              <button className="btn primary big" onClick={() => start("voice")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
                {t(lang, "startVoice")}
              </button>
              <button className="btn ghost big" onClick={() => start("text")}>
                {t(lang, "startText")}
              </button>
            </div>
            <div className="suggest">
              <small>{t(lang, "tryAsking")}</small>
              {suggestions.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {items.map((it, idx) => {
          const prev = items[idx - 1];
          const first = !(prev && prev.kind === "msg" && it.kind === "msg" && prev.role === it.role);
          return it.kind === "msg" ? (
            <div key={it.id} className={`msgrow ${it.role} ${first ? "first" : ""}`}>
              {it.role !== "user" ? <span className={`avatar ${it.role}`}>{it.role === "human" ? (it.who?.[0] ?? "☺") : ""}</span> : null}
              <div className={`msg ${it.role}`}>
                {it.role !== "user" && first ? <span className="who">{it.role === "human" ? (it.who ?? t(lang, "human")) : t(lang, "agent")}</span> : null}
                {it.text}
              </div>
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
          );
        })}
        {thinking && mode === "text" ? (
          <div className="msgrow agent first">
            <span className="avatar agent" />
            <div className="msg agent typing" aria-label={t(lang, "thinking")}><i /><i /><i /></div>
          </div>
        ) : null}
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

      {mode === "voice" && connected ? (
        <div className={`voicestage ${voiceState}`}>
          <div className="wave" aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} style={{ height: `${Math.max(14, Math.round((conversation.isSpeaking ? 40 + 30 * Math.abs(Math.sin((Date.now() / 160 + i) % Math.PI)) : 14 + level * 70 * (1 - Math.abs(i - 4) / 5)) ))}%` }} />
            ))}
          </div>
          <span className="vs-text">{conversation.isSpeaking ? t(lang, "speaking") : t(lang, "listening")}</span>
          <button className="btn ghost small" onClick={() => conversation.setVolume({ volume: 1 })} title="volume">🔊</button>
        </div>
      ) : null}

      <div className="widget-foot">
        {!humanMode ? (
          <button
            className={`iconbtn mic ${mode === "voice" ? "on" : ""}`}
            title={mode === "voice" ? t(lang, "switchToText") : t(lang, "switchToVoice")}
            aria-label={mode === "voice" ? t(lang, "switchToText") : t(lang, "switchToVoice")}
            onClick={() => switchMode(mode === "voice" ? "text" : "voice")}
          >
            {mode === "voice" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            )}
          </button>
        ) : null}
        <div className="composer">
          <input value={input} placeholder={mode === "idle" && !humanMode ? t(lang, "tapToTalk") : t(lang, "placeholder")} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { say(input); setInput(""); } }} onFocus={() => connected && conversation.sendUserActivity()} disabled={mode === "idle" && !humanMode} />
          <button className="sendbtn" disabled={(!connected && !humanMode) || !input.trim()} onClick={() => { say(input); setInput(""); }} aria-label={t(lang, "send")} title={t(lang, "send")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </div>
      <div className="powered">VOX Cinemas · <span>Voxi</span></div>
    </div>
  );
}
