/**
 * Voxi widget: ElevenLabs conversation (voice or text) + concierge SSE stream + rich cards.
 * All state changes go through the agent/concierge; the widget never talks to Vista directly.
 */
import { type DisconnectionDetails, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type BookingHistory, type CustomerProfile, type Customer, type Lang, type Session, type UiHint, type WidgetEvent, createSession, devTool, getCustomerProfile, getSignedUrl, getState, linkConversation, sendCommand, subscribe, widgetLogin, widgetLogout } from "../lib/api";
import { isRtl, t } from "../lib/i18n";
import { type CardActions, Cards, Feedback, seatRange } from "./Cards";
import { type Loc, LocationBar } from "./LocationBar";
import { AccountPanel } from "./AccountPanel";
import { acceptWidgetEvent, actionContext, appendTranscript, decisionSummary, holdSeconds, recordUserActivity, renderVerifiedSeatMap, type TranscriptBody as ItemBody, type TranscriptItem as Item } from "../lib/widget-state";


const nid = () => crypto.randomUUID();

export function Concierge({ initialLang = "en", initialOpen = true, onExpand, onAuth, onLanguage }: { initialLang?: Lang; initialOpen?: boolean; onExpand?: (b: boolean) => void; onAuth?: (c: Customer | null) => void; onLanguage?: (language: Lang) => void }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [session, setSession] = useState<Session | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const sessionRef = useRef<Session | null>(null);
  const authEpochRef = useRef(0);
  const authBusyRef = useRef(false);
  const restoreRef = useRef<Promise<void> | null>(null);
  const pendingLinkRef = useRef<Promise<void> | null>(null);
  const connectionAttemptRef = useRef(0);
  const startingRef = useRef(false);
  const commitSession = useCallback((next: Session | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);
  // ---------- sign-in (page header "Log in" and the widget's own link open the same sheet) ----------
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [history, setHistory] = useState<BookingHistory[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const refreshProfile = async (current: Session) => {
    if (!current.isLoggedIn) return;
    const epoch = authEpochRef.current;
    const stillCurrent = () => epoch === authEpochRef.current && sessionRef.current?.token === current.token && sessionRef.current.conversationId === current.conversationId;
    setProfileLoading(true);
    try {
      const details = await getCustomerProfile(current);
      if (!stillCurrent()) return;
      setCustomer(details.customer); setProfile(details.profile); setHistory(details.history);
      onAuth?.(details.customer);
    } catch { if (stillCurrent()) setAuthErr(langRef.current === "ar" ? "تعذر تحميل حسابك. حاول مرة أخرى." : "Your account could not load. Try again."); }
    finally { if (stillCurrent()) setProfileLoading(false); }
  };
  useEffect(() => {
    const openIt = () => {
      setOpen(true);
      setAuthOpen(true);
    };
    const logoutIt = () => void doLogout();
    const openOnly = () => setOpen(true);
    window.addEventListener("voxi:login", openIt);
    window.addEventListener("voxi:profile", openIt);
    window.addEventListener("voxi:logout", logoutIt);
    window.addEventListener("voxi:open", openOnly);
    return () => {
      window.removeEventListener("voxi:login", openIt);
      window.removeEventListener("voxi:profile", openIt);
      window.removeEventListener("voxi:logout", logoutIt);
      window.removeEventListener("voxi:open", openOnly);
    };
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const doLogin = async (email: string, password: string) => {
    if (authBusyRef.current) return;
    authBusyRef.current = true;
    const epoch = ++authEpochRef.current;
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await restoreRef.current;
      await pendingLinkRef.current;
      const s = sessionRef.current ?? (await createSession({ language: langRef.current, modality: "text" }));
      if (!sessionRef.current) commitSession(s);
      const r = await widgetLogin(s, email, password);
      if (epoch !== authEpochRef.current) return;
      if (!r.ok || !r.customer) {
        setAuthErr(r.error ?? (lang === "ar" ? "تعذّر تسجيل الدخول" : "Could not sign in"));
        return;
      }
      const next = { ...s, token: r.token ?? s.token, isLoggedIn: true, dynamicVariables: r.dynamicVariables ?? s.dynamicVariables };
      commitSession(next);
      if (customer && customer.id !== r.customer.id) { setItems([]); setOrder(null); }
      setCustomer(r.customer);
      void refreshProfile(next);
      onAuth?.(r.customer);
      setAuthOpen(false);
      push({ kind: "note", text: lang === "ar" ? `تم تسجيل الدخول باسم ${r.customer.firstName}` : `Signed in as ${r.customer.firstName}` });
      if (statusRef.current === "connected")
        conversation.sendContextualUpdate(
          `The guest has just signed in as ${r.customer.firstName} ${r.customer.lastName} (SHARE ${r.customer.tier}, member ${r.customer.memberId ?? ""}). Treat them as logged in from now on: call get_session_context for their details.`,
        );
    } catch {
      setAuthErr(lang === "ar" ? "تعذر تسجيل الدخول. حاول مرة أخرى." : "Could not sign in. Please try again.");
    } finally {
      authBusyRef.current = false;
      setAuthBusy(false);
    }
  };
  const doLogout = async () => {
    if (authBusyRef.current) return;
    authBusyRef.current = true;
    ++authEpochRef.current;
    setAuthBusy(true); setAuthErr(null);
    try {
      await restoreRef.current;
      await pendingLinkRef.current;
      const current = sessionRef.current;
      if (!current) return;
      const result = await widgetLogout(current);
      if (!result.ok) throw new Error("Sign-out failed");
      ++connectionAttemptRef.current;
      startingRef.current = false;
      switchingRef.current = true;
      try { await conversation.endSession(); } catch { /* Backend sign-out already succeeded. */ } finally { switchingRef.current = false; }
      commitSession({ ...current, token: result.token ?? current.token, isLoggedIn: false, dynamicVariables: result.dynamicVariables ?? current.dynamicVariables });
      setCustomer(null); setProfile(null); setHistory([]); setProfileLoading(false); setOrder(null); setItems([]); setAuthOpen(false); setMode("idle");
      pendingAckRef.current.clear(); completedActionsRef.current.clear(); ackQueueRef.current = [];
      onAuth?.(null);
    } catch { setAuthErr(lang === "ar" ? "تعذر تسجيل الخروج. حاول مرة أخرى." : "Could not sign out. Please try again."); }
    finally { authBusyRef.current = false; setAuthBusy(false); }
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
  const activityRef = useRef({ lastUserAt: Date.now(), lastProviderPingAt: Number.NEGATIVE_INFINITY });
  const idleEndedRef = useRef(false);
  const switchingRef = useRef(false);
  const eventSeqRef = useRef(new Map<string, number>());
  const eventIdsRef = useRef(new Set<string>());
  const pendingAckRef = useRef(new Set<string>());
  const completedActionsRef = useRef(new Map<string, { type: string; status: string; result?: Record<string, unknown>; error?: { message: string } }>());
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ackQueueRef = useRef<string[]>([]);
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
  const statusRef = useRef<string>("disconnected"); // live connection status for callbacks that outlive a render
  const push = useCallback((it: ItemBody) => {
    if (it.kind === "cards" && it.ui.type === "login") { setAuthOpen(true); setOpen(true); return; }
    setItems((xs) => appendTranscript(xs, { ...it, id: nid() } as Item));
  }, []);
  const acknowledge = (context: string) => {
    ackQueueRef.current.push(context);
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => {
      const changes = ackQueueRef.current.splice(0);
      if (statusRef.current !== "connected" || !changes.length) return;
      conversation.sendUserMessage('[widget] User interface updates: ' + changes.join('; ') + '. Briefly acknowledge the latest meaningful choice once. Draft selections are not applied offers or completed purchases; successful API results are authoritative. Do not repeat completed actions with tools or ask for known information. Pending actions are not completed.');
    }, 650);
  };
  useEffect(() => () => { if (ackTimerRef.current) clearTimeout(ackTimerRef.current); }, []);

  const changeLanguage = async (next: Lang, tellAgent = false) => {
    langRef.current = next;
    setLang(next);
    const current = sessionRef.current;
    if (current) {
      const result = await sendCommand(current, { type: "language", language: next }).catch(() => null);
      if (result?.ok && sessionRef.current?.token === current.token)
        commitSession({ ...sessionRef.current, language: next, dynamicVariables: { ...sessionRef.current.dynamicVariables, language: next } });
    }
    if (tellAgent && statusRef.current === "connected") conversation.sendUserMessage(next === "ar" ? "من فضلك تابع بالعربية." : "Please continue in English.");
  };
  useEffect(() => { if (initialLang !== langRef.current) void changeLanguage(initialLang, true); }, [initialLang]);
  useEffect(() => { onLanguage?.(lang); }, [lang, onLanguage]);

  // ---------- client tools (called by the agent) ----------
  const clientTools = useMemo(
    () => ({
      render_cards: async (p: { ui: UiHint }) => {
        return "The widget renders validated server tool results automatically. No additional cards are needed.";
      },
      render_seat_map: async (p: { sessionKey: string; userSessionId?: string }) => {
        const s = sessionRef.current;
        if (!s) return JSON.stringify({ ok: false, rendered: false, error: "The widget is not ready." });
        return JSON.stringify(await renderVerifiedSeatMap(
          () => sendCommand(s, { type: "seat.plan", sessionKey: p.sessionKey, userSessionId: p.userSessionId }),
          (ui) => push({ kind: "cards", ui }),
          () => sessionRef.current?.token === s.token,
        ));
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
          const l: Loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, label: langRef.current === "ar" ? "موقعي الحالي" : "My current location", source: "gps" };
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
        await changeLanguage(p.language);
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
      if (switchingRef.current) return;
      setMode("idle");
      const why = d?.reason === "error" ? d.message : d?.reason === "agent" && d.context?.code && d.context.code !== 1000 ? `${d.context.code} ${d.context.reason ?? ""}`.trim() : "";
      if (idleEndedRef.current) { push({ kind: "note", text: lang === "ar" ? "توقفت المحادثة بعد ثلاث دقائق من عدم النشاط. يمكنك المتابعة متى أردت." : "The conversation paused after three minutes of inactivity. Reconnect whenever you’re ready." }); return; }
      if (why) push({ kind: "note", text: `⚠️ ${lang === "ar" ? "انقطع الاتصال" : "Connection closed"}: ${why}` });
      else push({ kind: "note", text: lang === "ar" ? "انتهت المحادثة" : "Conversation ended" });
      if (!switchingRef.current && !idleEndedRef.current) push({ kind: "feedback" });
    },
    onError: (m: unknown, ctx?: unknown) => {
      const detail = typeof m === "string" ? m : (m as { message?: string })?.message ?? (ctx as { reason?: string })?.reason ?? "";
      push({ kind: "note", text: `⚠️ ${detail || (lang === "ar" ? "تعذّر الاتصال بالمساعد الافتراضي — حاول مجدداً" : "Could not connect to the Virtual Assistant — please try again")}` });
    },
    onMessage: (m: { source: string; message: string }) => {
      if (!m.message) return;
      if (m.source === "user" && m.message.startsWith("[widget]")) return; // hidden widget → agent notes
      if (m.source === "user") activityRef.current.lastUserAt = Date.now();
      push({ kind: "msg", role: m.source === "user" ? "user" : "agent", text: m.message });
    },
  });

  statusRef.current = conversation.status;

  // link ElevenLabs conversation id ↔ concierge conversation
  useEffect(() => {
    if (conversation.status !== "connected" || authBusyRef.current || pendingLinkRef.current) return;
    const id = conversation.getId();
    if (!id || !session || session.conversationId === id) return;
    const current = sessionRef.current;
    if (!current) return;
    const pending = linkConversation(current, id).then((linked) => {
      if (sessionRef.current?.token !== current.token || conversation.getId() !== id) return;
      commitSession(linked);
      if (linked.isLoggedIn) void refreshProfile(linked);
      if (statusRef.current === "connected") conversation.sendContextualUpdate("Reconnected to the same account and booking draft. Call get_session_context before suggesting a booking. A seat hold expiry stays unchanged; ask before making a fresh hold.");
    }).catch(() => push({ kind: "note", text: langRef.current === "ar" ? "تعذر استعادة المحادثة. حاول إعادة الاتصال." : "Could not restore the conversation. Please reconnect." }))
      .finally(() => { if (pendingLinkRef.current === pending) pendingLinkRef.current = null; });
    pendingLinkRef.current = pending;
  }, [conversation.status, session?.conversationId, session?.token, authBusy]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Cards that carry the order's hold expiry (Review & Pay, order summary) keep the timer in sync; a receipt ends it. */
  const trackOrderFromUi = (ui?: UiHint) => {
    if (!ui) return;
    if (ui.type === "login") { setAuthOpen(true); return; }
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

  // Restore the signed-in session independently from the voice/text connection.
  useEffect(() => {
    let disposed = false;
    const epoch = authEpochRef.current;
    try {
      const saved = JSON.parse(localStorage.getItem("voxi.session") ?? "null") as { conversationId: string; token: string; at: number; language?: Lang } | null;
      if (saved?.token && Date.now() - saved.at < 6 * 60 * 60000) {
        restoreRef.current = createSession({ language: saved.language === "ar" ? "ar" : saved.language === "en" ? "en" : initialLang, modality: "text", conversationId: saved.conversationId, token: saved.token })
          .then((restored) => { if (!disposed && epoch === authEpochRef.current && !sessionRef.current) { commitSession(restored); setLang(restored.language); langRef.current = restored.language; void refreshProfile(restored); } })
          .catch(() => { if (!disposed && epoch === authEpochRef.current) try { localStorage.removeItem("voxi.session"); } catch {} });
      }
    } catch {}
    return () => { disposed = true; ++authEpochRef.current; ++connectionAttemptRef.current; };
  }, []);
  useEffect(() => { if (authOpen && session?.isLoggedIn) void refreshProfile(session); }, [authOpen]);

  // SSE subscription to concierge events
  useEffect(() => {
    if (!session) return;
    let subscribed = true;
    const isCurrent = () => subscribed && sessionRef.current?.token === session.token && sessionRef.current.conversationId === session.conversationId;
    const onEvent = (e: WidgetEvent) => {
      if (!isCurrent()) return;
      if (!acceptWidgetEvent(eventSeqRef.current, eventIdsRef.current, session.conversationId, e)) return;
      switch (e.type) {
        case "ui.render":
          if (e.ui?.type) push({ kind: "cards", ui: e.ui });
          trackOrderFromUi(e.ui);
          break;
        case "action.completed":
          completedActionsRef.current.set(e.action.actionId, e.action);
          if (completedActionsRef.current.size > 100) completedActionsRef.current.delete(completedActionsRef.current.keys().next().value!);
          if (pendingAckRef.current.delete(e.action.actionId)) acknowledge(actionContext(e.action.type, { ok: e.action.status === "succeeded", action: e.action, error: e.action.error?.message }));
          if (e.ui?.type) push({ kind: "cards", ui: e.ui });
          else if (e.action.status !== "succeeded" && e.action.error?.message) push({ kind: "note", text: `⚠️ ${e.action.error.message}` });
          trackOrderFromUi(e.ui);
          break;
        case "order.updated": {
          const sm = e.summary as Record<string, any>;
          if (sm && (sm.state === "paid" || sm.state === "cancelled")) setOrder(null);
          else setOrder({ userSessionId: e.userSessionId, expiresAtUtc: sm?.expiresAtUtc, totalCents: sm?.totalCents, filmTitle: sm?.filmTitle, seats: sm?.seats });
          if (sm?.expiresAtUtc !== orderRef.current?.expiresAtUtc) warnedRef.current = {};
          // keep an open Review & Pay sheet for this order in sync (offer applied, points redeemed, F&B added)
          if (sm)
            setItems((xs) =>
              xs.map((it) =>
                it.kind === "cards" && it.ui.type === "payment" && it.ui.meta?.userSessionId === e.userSessionId
                  ? { ...it, ui: { ...it.ui, items: [{ ...(it.ui.items?.[0] ?? {}), ...sm }], meta: { ...it.ui.meta, amountCents: sm.totalCents, expiresAtUtc: sm.expiresAtUtc ?? it.ui.meta?.expiresAtUtc, vat: { beforeVatCents: (sm.totalCents ?? 0) - (sm.taxCents ?? 0), vatCents: sm.taxCents ?? 0, rate: 5 } } } }
                  : it,
              ),
            );
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
          langRef.current = e.language;
          setLang(e.language);
          if (sessionRef.current && sessionRef.current.language !== e.language)
            commitSession({ ...sessionRef.current, language: e.language, dynamicVariables: { ...sessionRef.current.dynamicVariables, language: e.language } });
          break;
        default:
          break;
      }
    };
    const unsub = subscribe(session, onEvent, setSseStatus);
    getState(session)
      .then((s) => {
        if (!isCurrent()) return;
        if (s.transfer && ["queued", "connected", "requested"].includes(s.transfer.status)) setHumanMode({ transferId: s.transfer.id, agentName: s.transfer.agentName, status: s.transfer.status });
        if (s.conversation?.metadata?.activeOrder) void sendCommand(session, { type: "order.state" }).then((result) => {
          if (isCurrent() && result.ui) { trackOrderFromUi(result.ui); push({ kind: "cards", ui: result.ui }); }
        });
      })
      .catch(() => undefined);
    return () => { subscribed = false; unsub(); };
  }, [session?.conversationId, session?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // mic level meter
  useEffect(() => {
    if (mode !== "voice") return;
    const iv = setInterval(() => { const volume = conversation.getInputVolume?.() ?? 0; setLevel(Math.min(1, volume * 3)); }, 100);
    return () => clearInterval(iv);
  }, [mode, conversation]);

  // keep the transcript pinned to the newest card: cards and images change height after they mount,
  // so scroll now, again shortly after, and whenever the content resizes while the user is near the bottom
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (!items.length) { el.scrollTop = 0; return; }
    if (!items.some((item) => item.kind !== "note")) return;
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

  // The backend owns the hold expiry. Disconnecting never extends it.
  useEffect(() => {
    const tick = () => {
      const current = orderRef.current;
      const left = holdSeconds(current?.expiresAtUtc);
      setHoldLeft(left);
      if (!current?.expiresAtUtc || left === null) return;
      const expiry = current.expiresAtUtc;
      if (left === 0 && warnedRef.current.expired !== expiry) {
        warnedRef.current.expired = expiry;
        push({ kind: "note", text: lang === "ar" ? "انتهت مهلة المقاعد. احتفظنا باختياراتك؛ يمكنك طلب التحقق من المقاعد مجدداً." : "Your seat hold expired. Your choices are saved—check availability again when you’re ready." });
        const currentSession = sessionRef.current;
        if (currentSession) void sendCommand(currentSession, { type: "order.state", userSessionId: current.userSessionId }).then((result) => {
          if (sessionRef.current?.token === currentSession.token && result.ui) push({ kind: "cards", ui: result.ui });
        }).catch(() => undefined);
        if (statusRef.current === "connected") conversation.sendContextualUpdate("The seat hold expired. Choices are preserved. Ask before recover_order confirmed:true; never automatically hold seats or restart the timer.");
      } else if (left > 0 && left <= 120 && warnedRef.current.two !== expiry) {
        warnedRef.current.two = expiry;
        push({ kind: "note", text: lang === "ar" ? "تبقى أقل من دقيقتين على مهلة المقاعد." : "Less than two minutes remain on your seat hold." });
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [order?.expiresAtUtc, lang]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (statusRef.current === "connected" && !idleEndedRef.current && Date.now() - activityRef.current.lastUserAt >= 180000) {
        idleEndedRef.current = true;
        void conversation.endSession();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [conversation.status]);

  const start = async (m: "voice" | "text") => {
    if (startingRef.current || authBusyRef.current || statusRef.current === "connected") return;
    startingRef.current = true;
    const attempt = ++connectionAttemptRef.current;
    const valid = () => attempt === connectionAttemptRef.current;
    setMode(m);
    activityRef.current.lastUserAt = Date.now();
    idleEndedRef.current = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await restoreRef.current;
      if (!valid()) return;
      const s = sessionRef.current ?? (await createSession({ language: langRef.current, modality: m }));
      if (!valid()) return;
      commitSession(s);
      const { signedUrl, agentId, wsOrigin } = await getSignedUrl(s);
      if (!valid()) return;
      const currentLang = langRef.current;
      const pendingOrder = orderRef.current;
      const dyn = { ...s.dynamicVariables, language: currentLang, channel: "web", ...(pendingOrder ? {
        greetingEn: holdSeconds(pendingOrder.expiresAtUtc) === 0 ? "Welcome back. Your choices are saved—shall I check and hold seats again?" : "Welcome back. Shall we pick up your booking?",
        greetingAr: holdSeconds(pendingOrder.expiresAtUtc) === 0 ? "أهلاً بعودتك. اختياراتك محفوظة، هل أتحقق وأحجز المقاعد مجدداً؟" : "أهلاً بعودتك. هل نكمل حجزك؟",
      } : {}) };
      if (s.isLoggedIn && !customer) void refreshProfile(s);
      if (m === "voice") {
        const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of permission.getTracks()) track.stop();
      }
      if (!valid()) return;
      const overrides = { agent: { language: currentLang }, conversation: { textOnly: m === "text" } } as const;
      const serverLocation = /eu\.residency/.test(wsOrigin ?? "") ? "eu-residency" : /in\.residency/.test(wsOrigin ?? "") ? "in-residency" : "us";
      const origin = { serverLocation, textOnly: m === "text" };
      const started = signedUrl
        ? conversation.startSession({ signedUrl, connectionType: "websocket", dynamicVariables: dyn, overrides, ...origin } as never)
        : conversation.startSession({ agentId, connectionType: "websocket", dynamicVariables: dyn, overrides, ...origin } as never);
      await Promise.race([
        started,
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(currentLang === "ar" ? "تعذر الاتصال الآن. حاول مجدداً." : "The connection took too long. Please try again.")), 20000); }),
      ]);
      if (!valid()) await conversation.endSession();
    } catch (error) {
      if (!valid()) return;
      switchingRef.current = true;
      try { await conversation.endSession(); } catch { /* Clean up a partially opened connection. */ } finally { switchingRef.current = false; }
      if (m === "voice" && /NotAllowed|Permission|denied/i.test(String(error))) {
        push({ kind: "note", text: t(langRef.current, "micDenied") });
        startingRef.current = false;
        return await start("text");
      }
      push({ kind: "note", text: (error as Error).message || (langRef.current === "ar" ? "تعذر الاتصال. حاول مجدداً." : "Could not connect. Please try again.") });
      setMode("idle");
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (valid()) startingRef.current = false;
    }
  };

  /** Start a fresh voice/text transport while preserving the authenticated booking session. */
  const switchMode = async (m: "voice" | "text") => {
    if (switchingRef.current || startingRef.current || authBusyRef.current) return;
    switchingRef.current = true;
    try {
      if (statusRef.current === "connected") await conversation.endSession();
      // The SDK status prop can lag its resolved endSession promise by one render.
      statusRef.current = "disconnected";
      await start(m);
    } finally { switchingRef.current = false; }
  };

  const say = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      activityRef.current.lastUserAt = Date.now();
      if (humanMode && session) {
        push({ kind: "msg", role: "user", text });
        void sendCommand(session, { type: "human.message", transferId: humanMode.transferId, text });
        return;
      }
      if (statusRef.current === "connected") {
        activityRef.current.lastUserAt = Date.now();
        conversation.sendUserMessage(text);
        if (mode === "text") push({ kind: "msg", role: "user", text });
      } else push({ kind: "note", text: lang === "ar" ? "ابدأ المحادثة أولاً" : "Start the conversation first" });
    },
    [conversation, humanMode, session, mode, lang, push],
  );

  const ask = async (text: string) => {
    if (!text.trim()) return;
    if (humanMode && session) { say(text); return; }
    const epoch = authEpochRef.current;
    if (statusRef.current !== "connected") await start("text");
    // A card click is a new explicit request, so restore the transport before sending it.
    for (let i = 0; i < 66 && statusRef.current !== "connected" && epoch === authEpochRef.current; i++) await new Promise((resolve) => setTimeout(resolve, 300));
    if (epoch !== authEpochRef.current) return;
    if (statusRef.current === "connected") say(text);
  };

  const act: CardActions = useMemo(
    () => ({
      say: (text) => { if (statusRef.current === "connected" || humanMode) say(text); else void ask(text); },
      command: async (cmd) => {
        activityRef.current.lastUserAt = Date.now();
        const current = sessionRef.current;
        if (!current) return { ok: false, error: "no session" };
        const result = await sendCommand(current, { ...cmd, ...(["booking.select", "order.recover"].includes(String(cmd.type)) && !cmd.idempotencyKey ? { idempotencyKey: crypto.randomUUID() } : {}) })
          .catch((): Awaited<ReturnType<typeof sendCommand>> => ({ ok: false, error: langRef.current === "ar" ? "انقطع الاتصال. تحقق من حالة الحجز قبل إعادة المحاولة." : "The connection was interrupted. Check the booking status before trying again." }));
        if (sessionRef.current?.token !== current.token) return { ok: false, error: langRef.current === "ar" ? "تغيرت جلسة الحساب. تحقق من الطلب مجدداً." : "Your account session changed. Check the current booking again." };
        if (result.ui) { trackOrderFromUi(result.ui); push({ kind: "cards", ui: result.ui }); }
        const meaningful = ["seat.select", "payment.token", "booking.select", "order.recover"].includes(String(cmd.type));
        if (meaningful && result.action && ["queued", "running"].includes(result.action.status)) {
          const completed = completedActionsRef.current.get(result.action.actionId);
          if (completed) acknowledge(actionContext(completed.type, { ok: completed.status === "succeeded", action: completed, error: completed.error?.message }));
          else pendingAckRef.current.add(result.action.actionId);
        }
        else if (meaningful) acknowledge(actionContext(String(cmd.type), result));
        if (!result.ok && !result.action && result.error) push({ kind: "note", text: result.error });
        return result;
      },
      selection: (selection) => {
        activityRef.current.lastUserAt = Date.now();
        acknowledge(JSON.stringify({ draftSelection: { kind: selection.kind, label: selection.label, cardLast4: selection.cardLast4 }, applied: false }));
      },
      openLink: (url) => window.open(url, "_blank", "noopener"),
      playTrailer: (id) => window.open(`https://www.youtube.com/watch?v=${id}`, "_blank", "noopener"),
    }),
    [say, ask, session],
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
    ? ["اقترح لي فيلماً", "ما الذي يُعرض بين الرابعة والسادسة؟", "ساعدني في حجز سابق", "ما عروض بطاقتي؟"]
    : ["Suggest me a movie", "Anything good between 4 and 6?", "Help with an existing booking", "Does my card have an offer?"];
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

  const handleUserActivity = () => recordUserActivity(activityRef.current, connected ? () => conversation.sendUserActivity() : undefined);

  if (!open)
    return (
      <button className="launcher" dir={dir} onClick={() => setOpen(true)} aria-label={t(lang, "askVoxi")}>
        <span className={`orb ${voiceState}`} />
        <span className="lbl">{t(lang, "askVoxi")}</span>
        {unread ? <span className="unread">{unread}</span> : null}
      </button>
    );

  return (
    <div className={`widget ${expanded ? "expanded" : ""} state-${voiceState}`} dir={dir} onPointerDownCapture={handleUserActivity} onKeyDownCapture={handleUserActivity} onWheelCapture={handleUserActivity} onInputCapture={handleUserActivity}>
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
        <button className="iconbtn auth" onClick={() => setAuthOpen(true)} title={customer ? (lang === "ar" ? "حسابي" : "My account") : lang === "ar" ? "تسجيل الدخول" : "Sign in"}>
          {customer ? customer.firstName : lang === "ar" ? "تسجيل الدخول" : "Log in"}
        </button>
        <div className="langtoggle" role="group" aria-label="language" title={`events: ${sseStatus}`}>
          <button className={lang === "en" ? "on" : ""} onClick={() => void changeLanguage("en", true)}>
            EN
          </button>
          <button className={lang === "ar" ? "on" : ""} onClick={() => void changeLanguage("ar", true)}>
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
      {authOpen ? <AccountPanel lang={lang} customer={customer} profile={profile} history={history} loading={profileLoading} busy={authBusy} error={authErr} onLogin={doLogin} onLogout={doLogout} onClose={() => setAuthOpen(false)} /> : null}

      <div className="widget-body" ref={bodyRef}>
        {mode !== "idle" && !items.length && !connected ? (
          <div className="start">
            <div className="hero-orb listening"><i /><i /><i /></div>
            <p>{t(lang, "connecting")}</p>
          </div>
        ) : null}
        {mode === "idle" && !connected && items.every((i) => i.kind === "note") ? (
          <div className="start">
            <div className="hero-orb"><i /><i /><i /></div>
            <h3>{lang === "ar" ? "مساعد فوكس سينما الافتراضي" : "VOX Cinemas Virtual Assistant"}</h3>
            <p>{lang === "ar" ? "ما نوع الفيلم الذي ودك تشوفه؟" : "What are you in the mood to watch?"}</p>
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
            <div key={it.id}>{it.archived ? <button className="booking-summary" type="button" onClick={() => void ask(`${lang === "ar" ? "أود تعديل" : "I'd like to change"} ${decisionSummary(it.ui, lang)}`)}><span>{decisionSummary(it.ui, lang)}</span><small>{lang === "ar" ? "تعديل" : "Edit"}</small></button> : <Cards ui={it.ui} lang={lang} act={act} />}</div>
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
              commitSession(s);
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
          <span>{holdLeft === 0 ? (lang === "ar" ? "انتهت مهلة المقاعد" : "Seat hold expired") : (lang === "ar" ? "المقاعد محجوزة" : "Seats held")}{order.seats ? ` · ${seatRange(order.seats)}` : ""}</span>
          <b>{`${Math.floor(holdLeft / 60)}:${String(holdLeft % 60).padStart(2, "0")}`}</b>
          {holdLeft === 0 ? <button className="btn small" onClick={() => void act.command({ type: "order.recover", userSessionId: order.userSessionId, confirmed: true })}>{lang === "ar" ? "تحقق واحجز المقاعد مجدداً" : "Check and hold seats again"}</button> : null}
        </div>
      ) : null}

      {!connected && conversation.status !== "connecting" && items.some((item) => item.kind !== "note") ? <div className="reconnect-bar"><button className="btn primary" onClick={() => void start("text")}>{lang === "ar" ? "متابعة المحادثة" : "Reconnect to chat"}</button>{order ? <span>{lang === "ar" ? "اختياراتك محفوظة" : "Your choices are saved"}</span> : null}</div> : null}
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
          <input value={input} placeholder={mode === "idle" && !humanMode ? t(lang, "tapToTalk") : t(lang, "placeholder")} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { say(input); setInput(""); } }} onFocus={handleUserActivity} disabled={mode === "idle" && !humanMode} />
          <button className="sendbtn" disabled={(!connected && !humanMode) || !input.trim()} onClick={() => { say(input); setInput(""); }} aria-label={t(lang, "send")} title={t(lang, "send")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </div>
      <div className="powered">VOX Cinemas · <span>{lang === "ar" ? "المساعد الافتراضي" : "Virtual Assistant"}</span></div>
    </div>
  );
}
