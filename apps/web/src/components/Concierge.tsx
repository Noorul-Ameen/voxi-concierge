/**
 * Voxi widget: ElevenLabs conversation (voice or text) + concierge SSE stream + rich cards.
 * All state changes go through the agent/concierge; the widget never talks to Vista directly.
 */
import { type DisconnectionDetails, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Customer, type Lang, type Session, type UiHint, type WidgetEvent, createSession, devTool, getSignedUrl, getState, linkConversation, sendCommand, subscribe, widgetLogin, widgetLogout } from "../lib/api";
import { isRtl, t } from "../lib/i18n";
import { type CardActions, Cards, Feedback, seatRange } from "./Cards";
import { type Loc, LocationBar } from "./LocationBar";

type ItemBody =
  | { kind: "msg"; role: "user" | "agent" | "human"; text: string; who?: string }
  | { kind: "cards"; ui: UiHint }
  | { kind: "note"; text: string }
  | { kind: "feedback" };
type Item = ItemBody & { id: string };

let idc = 0;
const nid = () => `i${++idc}`;

export function Concierge({ initialLang = "en", initialOpen = true, onExpand, onAuth }: { initialLang?: Lang; initialOpen?: boolean; onExpand?: (b: boolean) => void; onAuth?: (c: Customer | null) => void }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [session, setSession] = useState<Session | null>(null);
  // ---------- sign-in (page header "Log in" and the widget's own link open the same sheet) ----------
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  useEffect(() => {
    const openIt = () => {
      setOpen(true);
      setAuthOpen(true);
    };
    const logoutIt = () => void doLogout();
    const openOnly = () => setOpen(true);
    window.addEventListener("voxi:login", openIt);
    window.addEventListener("voxi:logout", logoutIt);
    window.addEventListener("voxi:open", openOnly);
    return () => {
      window.removeEventListener("voxi:login", openIt);
      window.removeEventListener("voxi:logout", logoutIt);
      window.removeEventListener("voxi:open", openOnly);
    };
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const doLogin = async (identifier: string, pin: string) => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      const s = session ?? (await createSession({ language: lang, modality: "text" }));
      const r = await widgetLogin(s, identifier, pin);
      if (!r.ok || !r.customer) {
        setAuthErr(r.error ?? (lang === "ar" ? "تعذّر تسجيل الدخول" : "Could not sign in"));
        return;
      }
      const next = { ...s, token: r.token ?? s.token, isLoggedIn: true, dynamicVariables: r.dynamicVariables ?? s.dynamicVariables };
      setSession(next);
      setCustomer(r.customer);
      onAuth?.(r.customer);
      setAuthOpen(false);
      push({ kind: "note", text: lang === "ar" ? `تم تسجيل الدخول باسم ${r.customer.firstName}` : `Signed in as ${r.customer.firstName}` });
      if (statusRef.current === "connected")
        conversation.sendContextualUpdate(
          `The guest has just signed in as ${r.customer.firstName} ${r.customer.lastName} (SHARE ${r.customer.tier}, member ${r.customer.memberId ?? ""}). Treat them as logged in from now on: call get_session_context for their details.`,
        );
    } finally {
      setAuthBusy(false);
    }
  };
  const doLogout = async () => {
    if (session) {
      const r = await widgetLogout(session).catch(() => ({ ok: false }) as { ok: boolean; token?: string; dynamicVariables?: Record<string, string> });
      if (r.ok) setSession({ ...session, token: r.token ?? session.token, isLoggedIn: false, dynamicVariables: r.dynamicVariables ?? session.dynamicVariables });
      if (statusRef.current === "connected") conversation.sendContextualUpdate("The guest has signed out. Treat them as a guest from now on.");
    }
    setCustomer(null);
    onAuth?.(null);
  };
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState<"idle" | "voice" | "text">("idle");
  // ---- booking v2: the live order (seat hold timer), mute, inactivity ----
  type LiveOrder = { userSessionId: string; expiresAtUtc?: string; totalCents?: number; filmTitle?: string; seats?: string; paid?: boolean };
  const [order, setOrder] = useState<LiveOrder | null>(null);
  const orderRef = useRef<LiveOrder | null>(null);
  orderRef.current = order;
  const [muted, setMuted] = useState(false);
  const [holdLeft, setHoldLeft] = useState<number | null>(null); // seconds
  const warnedRef = useRef<{ two?: string; short?: string; expired?: string }>({});
  const lastUserAtRef = useRef<number>(Date.now());
  const nudgedRef = useRef<number>(0);
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
    micMuted: muted,
    onConnect: () => push({ kind: "note", text: lang === "ar" ? "متصل" : "Connected" }),
    onDisconnect: (d?: DisconnectionDetails) => {
      setMode("idle");
      const why = d?.reason === "error" ? d.message : d?.reason === "agent" && d.context?.code && d.context.code !== 1000 ? `${d.context.code} ${d.context.reason ?? ""}`.trim() : "";
      if (why) push({ kind: "note", text: `⚠️ ${lang === "ar" ? "انقطع الاتصال" : "Connection closed"}: ${why}` });
      else push({ kind: "note", text: lang === "ar" ? "انتهت المحادثة" : "Conversation ended" });
      push({ kind: "feedback" });
    },
    onError: (m: unknown, ctx?: unknown) => {
      const detail = typeof m === "string" ? m : (m as { message?: string })?.message ?? (ctx as { reason?: string })?.reason ?? "";
      push({ kind: "note", text: `⚠️ ${detail || (lang === "ar" ? "تعذّر الاتصال بفوكسي — حاول مجدداً" : "Could not connect to Voxi — please try again")}` });
    },
    onMessage: (m: { source: string; message: string }) => {
      if (!m.message) return;
      if (m.source === "user") lastUserAtRef.current = Date.now();
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

  /** Cards that carry the order's hold expiry (Review & Pay, order summary) keep the timer in sync; a receipt ends it. */
  const trackOrderFromUi = (ui?: UiHint) => {
    if (!ui) return;
    if (ui.type === "qr") {
      setOrder(null);
      return;
    }
    const m = ui.meta ?? {};
    if ((ui.type === "payment" || ui.type === "order") && m.userSessionId && m.expiresAtUtc)
      setOrder((o) => ({ ...(o ?? {}), userSessionId: String(m.userSessionId), expiresAtUtc: String(m.expiresAtUtc), totalCents: Number(m.amountCents ?? o?.totalCents ?? 0) }));
  };

  // Same-device resume: remember the conversation so a reload/return within 30 minutes picks the booking back up.
  useEffect(() => {
    if (!session) return;
    try {
      localStorage.setItem("voxi.session", JSON.stringify({ conversationId: session.conversationId, token: session.token, language: session.language, at: Date.now() }));
    } catch {}
  }, [session]);

  // SSE subscription to concierge events
  useEffect(() => {
    if (!session) return;
    const onEvent = (e: WidgetEvent) => {
      switch (e.type) {
        case "ui.render":
          if (e.ui?.type) push({ kind: "cards", ui: e.ui });
          trackOrderFromUi(e.ui);
          break;
        case "action.completed":
          if (e.ui?.type) push({ kind: "cards", ui: e.ui });
          else if (e.action.status !== "succeeded" && e.action.error?.message) push({ kind: "note", text: `⚠️ ${e.action.error.message}` });
          trackOrderFromUi(e.ui);
          break;
        case "order.updated": {
          const sm = e.summary as Record<string, any>;
          if (sm && (sm.state === "paid" || sm.state === "cancelled" || sm.state === "expired")) setOrder(null);
          else setOrder({ userSessionId: e.userSessionId, expiresAtUtc: sm?.expiresAtUtc, totalCents: sm?.totalCents, filmTitle: sm?.filmTitle, seats: sm?.seats });
          warnedRef.current = {};
          break;
        }
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

  // keep the transcript pinned to the newest card: cards and images change height after they mount,
  // so scroll now, again shortly after, and whenever the content resizes while the user is near the bottom
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const toBottom = () => el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior });
    toBottom();
    const t1 = setTimeout(toBottom, 150);
    const t2 = setTimeout(toBottom, 700);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [items]);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
      if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior });
    });
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  useEffect(() => onExpand?.(expanded), [expanded, onExpand]);
  // a location chosen before the conversation started is sent as soon as a session exists
  useEffect(() => {
    const l = locRef.current;
    if (session && l) void sendCommand(session, { type: "location", lat: l.lat, lng: l.lng, accuracyM: l.accuracyM, label: l.label, source: l.source });
  }, [session]);

  // Seat-hold countdown: warn at 2:00 and 0:45, then recover the order automatically when it runs out.
  useEffect(() => {
    if (!order?.expiresAtUtc) {
      setHoldLeft(null);
      return;
    }
    const tick = async () => {
      const o = orderRef.current;
      if (!o?.expiresAtUtc) return;
      const left = Math.max(0, Math.round((new Date(o.expiresAtUtc).getTime() - Date.now()) / 1000));
      setHoldLeft(left);
      const w = warnedRef.current;
      const ctxNote = (text: string) => {
        if (statusRef.current === "connected") conversation.sendContextualUpdate(text);
      };
      if (left <= 120 && left > 45 && w.two !== o.expiresAtUtc) {
        w.two = o.expiresAtUtc;
        push({ kind: "note", text: lang === "ar" ? "⏳ مقاعدك محجوزة لدقيقتين إضافيتين — أكمل التذاكر أولاً، ويمكن إضافة الطعام بعدها." : "⏳ Your seats are held for 2 more minutes — complete the tickets first, food can come after." });
        ctxNote("Seat hold expires in 2 minutes. Tell the guest once, briefly, and prioritise completing the ticket payment; food can be added after.");
      } else if (left <= 45 && left > 0 && w.short !== o.expiresAtUtc) {
        w.short = o.expiresAtUtc;
        push({ kind: "note", text: lang === "ar" ? "⏳ 45 ثانية متبقية على حجز المقاعد." : "⏳ 45 seconds left on your seat hold." });
        ctxNote("Seat hold expires in 45 seconds — urge the guest to tap Pay now, in one short line.");
      } else if (left === 0 && w.expired !== o.expiresAtUtc) {
        w.expired = o.expiresAtUtc;
        const s = sessionRef.current;
        if (!s || o.paid) return;
        push({ kind: "note", text: lang === "ar" ? "انتهى حجز المقاعد — أستعيد المقاعد نفسها أو الأقرب إليها…" : "Seat hold expired — getting the same or the closest seats back…" });
        const r = (await sendCommand(s, { type: "order.recover", userSessionId: o.userSessionId })) as { ok: boolean; speech?: string; error?: string };
        if (r.ok) ctxNote(`The seat hold expired and the widget already rebuilt the order: ${r.speech ?? ""} Relay this in one line and continue with payment — do not restart the booking.`);
        else {
          push({ kind: "note", text: `⚠️ ${r.error ?? (lang === "ar" ? "تعذّر استعادة المقاعد" : "Could not recover the seats")}` });
          ctxNote(`The seat hold expired and recovery failed (${r.error ?? "unknown"}). Call recover_order, or offer to rebook.`);
        }
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 1000);
    return () => clearInterval(iv);
  }, [order?.expiresAtUtc, order?.userSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Inactivity: 60 s of silence during a live booking → one gentle nudge (widget note + context for the agent).
  useEffect(() => {
    if (!order || statusRef.current !== "connected") return;
    const iv = setInterval(() => {
      const idle = Date.now() - lastUserAtRef.current;
      if (idle > 60000 && Date.now() - nudgedRef.current > 90000 && statusRef.current === "connected") {
        nudgedRef.current = Date.now();
        const left = holdLeft != null ? Math.ceil(holdLeft / 60) : null;
        push({ kind: "note", text: lang === "ar" ? `ما زلت هنا؟${left ? ` مقاعدك محجوزة لـ ${left} دقائق أخرى.` : ""}` : `Still there?${left ? ` Your seats are held for ${left} more minute${left === 1 ? "" : "s"}.` : ""}` });
        conversation.sendContextualUpdate(`The guest has been silent for a minute with a booking in progress${left ? ` (seats held for ${left} more minutes)` : ""}. Nudge once, briefly and warmly; do not repeat the summary.`);
      }
    }, 5000);
    return () => clearInterval(iv);
  }, [order, holdLeft, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (m: "voice" | "text") => {
    setMode(m);
    lastUserAtRef.current = Date.now();
    // resume the previous conversation on this device (same booking, same seats) when it is recent
    let resumeId: string | undefined;
    if (!session) {
      try {
        const saved = JSON.parse(localStorage.getItem("voxi.session") ?? "null") as { conversationId: string; at: number } | null;
        if (saved && Date.now() - saved.at < 30 * 60000) resumeId = saved.conversationId;
      } catch {}
    }
    const s = session ?? (await createSession({ language: lang, modality: m, conversationId: resumeId }));
    setSession(s);
    const { signedUrl, agentId, wsOrigin } = await getSignedUrl(s);
    const dyn = { ...s.dynamicVariables, language: lang, channel: "web" };
    if (resumeId) void sendCommand(s, { type: "order.state" }).catch(() => undefined);
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
      const started = signedUrl
        ? conversation.startSession({ signedUrl, connectionType: "websocket", dynamicVariables: dyn, overrides, ...origin } as never)
        : conversation.startSession({ agentId, connectionType: "websocket", dynamicVariables: dyn, overrides, ...origin } as never);
      // Watchdog: the SDK can sit in "connecting" forever when the socket is blocked (CSP, proxy, offline).
      await Promise.race([
        started,
        new Promise((_, rej) => setTimeout(() => rej(new Error(lang === "ar" ? "انتهت مهلة الاتصال — تحقق من الشبكة أو إعدادات الصفحة المضيفة" : "Connection timed out — check the network or the host page's security policy (websocket to elevenlabs.io must be allowed)")), 20000)),
      ]);
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
        lastUserAtRef.current = Date.now();
        conversation.sendUserMessage(text);
        if (mode === "text") push({ kind: "msg", role: "user", text });
      } else push({ kind: "note", text: lang === "ar" ? "ابدأ المحادثة أولاً" : "Start the conversation first" });
    },
    [conversation, humanMode, session, mode, lang, push],
  );

  const act: CardActions = useMemo(
    () => ({
      say,
      command: async (cmd) => {
        lastUserAtRef.current = Date.now();
        return session ? sendCommand(session, cmd) : { ok: false, error: "no session" };
      },
      openLink: (url) => window.open(url, "_blank", "noopener"),
      playTrailer: (id) => window.open(`https://www.youtube.com/watch?v=${id}`, "_blank", "noopener"),
    }),
    [say, session],
  );

  const connected = conversation.status === "connected";
  const dir = isRtl(lang) ? "rtl" : "ltr";
  // ---------- presentation-only state (launcher, unread badge, typing indicator, suggestions) ----------
  const [open, setOpen] = useState(initialOpen);
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
        <button className="iconbtn auth" onClick={() => (customer ? void doLogout() : setAuthOpen(true))} title={customer ? (lang === "ar" ? "تسجيل الخروج" : "Log out") : lang === "ar" ? "تسجيل الدخول" : "Log in"}>
          {customer ? `${customer.firstName} · ${lang === "ar" ? "خروج" : "Log out"}` : lang === "ar" ? "تسجيل الدخول" : "Log in"}
        </button>
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
      {authOpen ? (
        <form
          className="authsheet"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void doLogin(String(f.get("identifier") ?? ""), String(f.get("pin") ?? ""));
          }}
        >
          <b>{lang === "ar" ? "تسجيل الدخول إلى حساب شير" : "Sign in to your SHARE account"}</b>
          <input name="identifier" autoFocus placeholder={lang === "ar" ? "البريد الإلكتروني أو رقم الجوال أو رقم العضوية" : "Email, mobile number or member id"} autoComplete="username" />
          <input name="pin" type="password" inputMode="numeric" placeholder="PIN" autoComplete="current-password" />
          {authErr ? <div className="err">{authErr}</div> : null}
          <div className="row">
            <button className="btn cta" type="submit" disabled={authBusy}>
              {authBusy ? t(lang, "processing") : lang === "ar" ? "دخول" : "Sign in"}
            </button>
            <button className="btn ghost" type="button" onClick={() => setAuthOpen(false)}>
              {lang === "ar" ? "إلغاء" : "Cancel"}
            </button>
          </div>
          <small>{lang === "ar" ? "أو ابدأ كضيف — يمكن لفوكسي تسجيل دخولك أثناء المحادثة أيضاً." : "Or continue as a guest — Voxi can also sign you in during the conversation."}</small>
        </form>
      ) : null}

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
          <span className="vs-text">{muted ? (lang === "ar" ? "مكتوم" : "Muted") : conversation.isSpeaking ? t(lang, "speaking") : t(lang, "listening")}</span>
          <button
            className={`btn ghost small mute ${muted ? "on" : ""}`}
            onClick={() => {
              const next = !muted;
              setMuted(next);
              conversation.setVolume({ volume: next ? 0 : 1 });
            }}
            title={muted ? (lang === "ar" ? "إلغاء الكتم" : "Unmute") : lang === "ar" ? "كتم الصوت" : "Mute"}
            aria-pressed={muted}
          >
            {muted ? "🔇" : "🔊"} {muted ? (lang === "ar" ? "إلغاء الكتم" : "Unmute") : lang === "ar" ? "كتم" : "Mute"}
          </button>
        </div>
      ) : null}
      {holdLeft != null && order && !order.paid ? (
        <div className={`holdbar ${holdLeft <= 45 ? "urgent" : holdLeft <= 120 ? "warn" : ""}`} role="status">
          <span>{lang === "ar" ? "المقاعد محجوزة" : "Seats held"}{order.seats ? ` · ${seatRange(order.seats)}` : ""}</span>
          <b>{`${Math.floor(holdLeft / 60)}:${String(holdLeft % 60).padStart(2, "0")}`}</b>
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
